import assert from "node:assert/strict";
import test from "node:test";
import { WorkspacePromptQueue } from "@/lib/bridge/workspace-prompt-queue";

function item(messageId: string, queuedAt = 1) {
  return {
    conversationId: "conversation-1",
    topic: "general",
    message: { id: messageId, body: `@codex work on ${messageId}` },
    queuedAt,
  };
}

test("workspace prompt queue keeps FIFO batches and isolates sessions", () => {
  const queue = new WorkspacePromptQueue({ maxDepthPerSession: 3 });

  assert.equal(queue.enqueue("session-a", item("a-1")).accepted, true);
  assert.equal(queue.enqueue("session-a", item("a-2", 2)).accepted, true);
  assert.equal(queue.enqueue("session-b", item("b-1")).accepted, true);

  assert.deepEqual(queue.dequeueBatch("session-a", 1).map((entry) => entry.message.id), ["a-1"]);
  assert.deepEqual(queue.dequeueBatch("session-b", 50).map((entry) => entry.message.id), ["b-1"]);
  assert.deepEqual(queue.dequeueBatch("session-a", 50).map((entry) => entry.message.id), ["a-2"]);
});

test("workspace prompt queue deduplicates a message for the same session", () => {
  const queue = new WorkspacePromptQueue();

  assert.equal(queue.enqueue("session-a", item("same")).accepted, true);
  const duplicate = queue.enqueue("session-a", item("same", 2));

  assert.deepEqual(duplicate, { accepted: false, reason: "duplicate" });
  assert.equal(queue.snapshot().queued, 1);
});

test("workspace prompt queue dead-letters overflow with bounded visibility", () => {
  const queue = new WorkspacePromptQueue({ maxDepthPerSession: 2, maxDeadLetters: 2 });

  assert.equal(queue.enqueue("session-a", item("a-1")).accepted, true);
  assert.equal(queue.enqueue("session-a", item("a-2")).accepted, true);
  const rejected = queue.enqueue("session-a", item("a-3"));

  assert.equal(rejected.accepted, false);
  if (rejected.accepted) throw new Error("expected queue overflow");
  assert.equal(rejected.reason, "queue_overflow");
  assert.equal(rejected.deadLetter?.id, "queue-overflow:session-a:a-3");
  assert.equal(queue.snapshot().queued, 2);
  assert.equal(queue.snapshot().deadLettered, 1);
  assert.deepEqual(queue.deadLetters()[0], {
    id: "queue-overflow:session-a:a-3",
    sessionId: "session-a",
    ...item("a-3"),
    reason: "queue_overflow",
    detail: "The per-session workspace prompt queue reached its configured limit.",
  });
});

test("workspace prompt queue caps dead-letter history instead of growing forever", () => {
  const queue = new WorkspacePromptQueue({ maxDepthPerSession: 1, maxDeadLetters: 1 });

  queue.enqueue("session-a", item("a-1"));
  queue.enqueue("session-a", item("a-2"));
  queue.enqueue("session-a", item("a-3"));

  assert.equal(queue.deadLetters().length, 1);
  assert.equal(queue.deadLetters()[0]?.message.id, "a-3");
});
