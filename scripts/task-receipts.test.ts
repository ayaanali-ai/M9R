import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalStore } from "../src/lib/native/local-store.ts";

function withStore<T>(run: (store: ReturnType<typeof createLocalStore>) => T): T {
  const root = mkdtempSync(join(tmpdir(), "m9r-task-receipts-"));
  try {
    return run(createLocalStore(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function ownerTask(store: ReturnType<typeof createLocalStore>, key: string) {
  return store.addTask({
    from: "you",
    to: "claude",
    goal: "record the delivery receipt",
    origin: "human_typed",
    idempotencyKey: key,
  }).task;
}

test("a task records one provider-neutral receipt path from acceptance to completion", () => withStore((store) => {
  const task = ownerTask(store, "receipt-forward");

  assert.equal(task.receipt?.state, "accepted");
  assert.deepEqual(task.receipt?.history.map((event) => event.state), ["accepted"]);

  // Deferred means accepted work is waiting for the resident adapter; it is
  // not a second delivery or a false provider receipt.
  store.setDelivery(task.id, { state: "deferred" });
  assert.equal(store.getTask(task.id)?.receipt?.state, "accepted");

  store.setDelivery(task.id, { state: "sending", attempts: 1, threadId: "claude-session" });
  assert.equal(store.getTask(task.id)?.receipt?.state, "dispatched");

  store.setDelivery(task.id, { state: "queued", attempts: 1, threadId: "claude-session" });
  assert.equal(store.getTask(task.id)?.receipt?.state, "provider_received");

  store.setResult(task.id, "done");
  const finished = store.getTask(task.id)!;
  assert.equal(finished.receipt?.state, "completed");
  assert.deepEqual(finished.receipt?.history.map((event) => event.state), [
    "accepted",
    "dispatched",
    "provider_received",
    "started",
    "completed",
  ]);
  assert.ok(finished.receipt?.history.slice(3, -1).every((event) => event.basis === "inferred"));
}));

test("prompt delivery records provider receipt before a result infers the started phase", () => withStore((store) => {
  const task = ownerTask(store, "receipt-prompt");
  const claimed = store.claimInboxTasks("claude", "claude-session", [task.id]);
  assert.equal(claimed.length, 1);
  assert.equal(store.getTask(task.id)?.receipt?.state, "provider_received");
  assert.equal(store.getTask(task.id)?.receipt?.history.at(-1)?.basis, "observed");

  store.setResult(task.id, "prompt completed");
  assert.equal(store.getTask(task.id)?.receipt?.state, "completed");
  assert.deepEqual(store.getTask(task.id)?.receipt?.history.map((event) => event.state), [
    "accepted",
    "provider_received",
    "started",
    "completed",
  ]);
}));

test("failed delivery can become explicitly retryable, while uncertain delivery stays non-replayable", () => withStore((store) => {
  const failed = ownerTask(store, "receipt-retryable");
  store.setDelivery(failed.id, { state: "failed", attempts: 1, error: "provider rejected the transport" });
  assert.equal(store.getTask(failed.id)?.receipt?.state, "failed");
  store.setDelivery(failed.id, { state: "deferred", attempts: 1 });
  assert.equal(store.getTask(failed.id)?.receipt?.state, "retryable");

  const uncertain = ownerTask(store, "receipt-uncertain");
  store.setDelivery(uncertain.id, { state: "uncertain", attempts: 1, threadId: "claude-session", error: "no receipt" });
  assert.equal(store.getTask(uncertain.id)?.receipt?.state, "uncertain");
  assert.equal(store.getTask(uncertain.id)?.receipt?.history.at(-1)?.state, "uncertain");
}));

test("cancellation is durable and fences later delivery and late results", () => withStore((store) => {
  const task = ownerTask(store, "receipt-canceled");
  store.setDelivery(task.id, { state: "deferred" });

  const canceled = store.cancelTask(task.id, "owner stopped this task");
  assert.equal(canceled?.receipt?.state, "canceled");
  assert.equal(canceled?.receipt?.history.at(-1)?.state, "canceled");

  store.setDelivery(task.id, { state: "sending", attempts: 1, threadId: "late-session" });
  assert.equal(store.getTask(task.id)?.receipt?.state, "canceled");
  assert.equal(store.getTask(task.id)?.delivery?.state, "deferred");

  store.setResult(task.id, "late result must be ignored");
  const final = store.getTask(task.id)!;
  assert.equal(final.receipt?.state, "canceled");
  assert.equal(final.resultSummary, undefined);
}));
