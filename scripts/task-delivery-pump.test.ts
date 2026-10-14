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
