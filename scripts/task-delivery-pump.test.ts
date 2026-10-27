import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalStore } from "../src/lib/native/local-store.ts";
import { createTaskDeliveryPump } from "../src/lib/native/task-delivery-pump.ts";

test("deferred work resumes through an arbitrary adapter only after the preceding task finishes", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-delivery-pump-"));
  try {
    const store = createLocalStore(root);
    const add = (key: string) => store.addTask({ from: "owner", to: "local-model", goal: "same task", origin: "human_typed", idempotencyKey: key }).task;
    const first = add("first"), next = add("next");
    store.setDelivery(first.id, { state: "queued", threadId: "local-session" });
    store.setDelivery(next.id, { state: "deferred", threadId: "local-session" });
    const sent: string[] = [];
    const pump = createTaskDeliveryPump(store, new Map([["local-model", async (id: string) => {
      sent.push(id); store.setDelivery(id, { state: "queued", threadId: "local-session" });
    }]]));
    await pump.tick();
    assert.deepEqual(sent, []);
    store.setResult(first.id, "complete");
    await Promise.all([pump.tick(), pump.tick()]);
    await pump.tick();
    assert.deepEqual(sent, [next.id]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a deferred task without a pinned session is offered to the adapter that owns session selection", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-delivery-pump-fresh-"));
  try {
    const store = createLocalStore(root);
    const task = store.addTask({
      from: "owner", to: "resident-provider", goal: "deliver this once", origin: "human_typed",
      idempotencyKey: "fresh-resident-task",
    }).task;
    store.setDelivery(task.id, { state: "deferred" });
    const sent: string[] = [];
    const pump = createTaskDeliveryPump(store, new Map([[
      "resident-provider",
      async (taskId: string) => {
        sent.push(taskId);
        store.setDelivery(taskId, { state: "queued", threadId: "provider-session" });
      },
    ]]));
    await pump.tick();
    assert.deepEqual(sent, [task.id]);
    assert.equal(store.getTask(task.id)?.delivery?.state, "queued");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("approving native Claude work releases it to the resident delivery pump", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-delivery-pump-approved-"));
  try {
    const store = createLocalStore(root);
    const task = store.addTask({
      from: "codex", to: "claude", goal: "deliver only after approval", origin: "agent_initiated",
      idempotencyKey: "approved-claude-delivery",
    }).task;
    assert.equal(task.approval, "pending");
    assert.equal(task.delivery, undefined, "pending work must not be eligible for provider delivery");

    store.setApproval(task.id, "approved");

    assert.equal(store.getTask(task.id)?.delivery?.state, "deferred", "approval must enqueue the authorized task for the resident provider adapter");
    const sent: string[] = [];
    const pump = createTaskDeliveryPump(store, new Map([[
      "claude",
      async (taskId: string) => { sent.push(taskId); },
    ]]));
    await pump.tick();
    assert.deepEqual(sent, [task.id], "the provider task should not wait for a future prompt hook or manual inbox read");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("approval does not enqueue room, stale, denied, or previously delivered work", () => {
  let clock = new Date();
  const root = mkdtempSync(join(tmpdir(), "m9r-delivery-pump-approval-boundary-"));
  try {
    const store = createLocalStore(root, { now: () => new Date(clock) });
    const roomTask = store.addTask({
      from: "web-codex", to: "web-claude", goal: "room handoff stays on the room relay", origin: "agent_initiated",
      idempotencyKey: "approved-room-handoff",
    }).task;
    store.setApproval(roomTask.id, "approved");
    assert.equal(store.getTask(roomTask.id)?.delivery, undefined);

    const stale = store.addTask({
      from: "codex", to: "claude", goal: "do not replay old approved work", origin: "agent_initiated",
      idempotencyKey: "stale-approved-handoff",
    }).task;
    clock = new Date(Date.now() + 31 * 60_000);
    store.setApproval(stale.id, "approved");
    assert.equal(store.getTask(stale.id)?.delivery, undefined);

    const denied = store.addTask({
      from: "codex", to: "claude", goal: "denied work must not enter the pump", origin: "agent_initiated",
      idempotencyKey: "denied-handoff",
    }).task;
    store.setApproval(denied.id, "denied");
    assert.equal(store.getTask(denied.id)?.delivery, undefined);

    const alreadyDelivered = store.addTask({
      from: "codex", to: "claude", goal: "preserve delivery history", origin: "agent_initiated",
      idempotencyKey: "previously-delivered-handoff",
    }).task;
    store.setDelivery(alreadyDelivered.id, { state: "queued", threadId: "existing-session" });
    store.setApproval(alreadyDelivered.id, "approved");
    assert.equal(store.getTask(alreadyDelivered.id)?.delivery?.state, "queued");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("deferred recovery does not replay uncertain input or bypass approval", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-delivery-pump-"));
  try {
    const store = createLocalStore(root);
    const uncertain = store.addTask({ from: "owner", to: "arbitrary", goal: "do it", origin: "human_typed", idempotencyKey: "uncertain" }).task;
    const approval = store.addTask({ from: "agent", to: "arbitrary", goal: "do it", origin: "agent_initiated", idempotencyKey: "approval" }).task;
    store.setDelivery(uncertain.id, { state: "uncertain", threadId: "session" });
    store.setDelivery(approval.id, { state: "deferred", threadId: "session" });
    const sent: string[] = [];
    const pump = createTaskDeliveryPump(store, new Map([["arbitrary", async (id: string) => { sent.push(id); }]]));
    await pump.tick();
    assert.deepEqual(sent, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the provider-neutral pump does not retry stale deferred work", async () => {
  let clock = new Date(Date.now() - 31 * 60_000);
  const root = mkdtempSync(join(tmpdir(), "m9r-delivery-pump-stale-"));
  try {
    const store = createLocalStore(root, { now: () => new Date(clock) });
    const task = store.addTask({ from: "owner", to: "arbitrary", goal: "old deferred work", origin: "human_typed", idempotencyKey: "stale-deferred" }).task;
    store.setDelivery(task.id, { state: "deferred", threadId: "session" });
    clock = new Date();
    const sent: string[] = [];
    const pump = createTaskDeliveryPump(store, new Map([["arbitrary", async (id: string) => { sent.push(id); }]]));

    await pump.tick();
    assert.deepEqual(sent, [], "stale deferred work must not reach any provider adapter");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("adapter delivery failures are reported once per task/reason instead of disappearing", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-delivery-pump-diagnostics-"));
  try {
    const store = createLocalStore(root);
    const task = store.addTask({ from: "owner", to: "local-model", goal: "deliver with diagnostics", origin: "human_typed", idempotencyKey: "diagnostic" }).task;
    store.setDelivery(task.id, { state: "deferred" });
    const issues: Array<{ taskId: string; provider: string; reason: string }> = [];
    const pump = createTaskDeliveryPump(
      store,
      new Map([["local-model", async () => ({ state: "unavailable", reason: "no exact live session" })]]),
      (issue) => issues.push(issue),
    );

    await pump.tick();
    await pump.tick();

    assert.deepEqual(issues, [{ taskId: task.id, provider: "local-model", reason: "no exact live session" }]);
    assert.equal(store.getTask(task.id)?.delivery?.state, "deferred");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("drain waits for the registered adapter's in-flight send", async () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-delivery-pump-"));
  try {
    const store = createLocalStore(root);
    const task = store.addTask({ from: "owner", to: "local-model", goal: "work", origin: "human_typed", idempotencyKey: "drain" }).task;
    store.setDelivery(task.id, { state: "deferred", threadId: "session" });
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const pump = createTaskDeliveryPump(store, new Map([["local-model", () => pending]]));
    const sending = pump.tick();
    let drained = false;
    const drain = pump.drain().then(() => { drained = true; });
    await Promise.resolve();
    assert.equal(drained, false);
    release();
    await sending;
    await drain;
    assert.equal(drained, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
