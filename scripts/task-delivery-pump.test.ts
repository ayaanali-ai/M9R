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
