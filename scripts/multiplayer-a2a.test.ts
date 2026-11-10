import assert from "node:assert/strict";
import test from "node:test";
import { createMultiplayerA2ARouter, MAX_A2A_CONVERSATION_MESSAGES } from "../src/lib/native/multiplayer-a2a";
import type { A2AMessage, MultiplayerRoster } from "../src/lib/native/multiplayer-contract";

const roster: MultiplayerRoster = {
  runId: "run-a2a",
  agents: [
    { agentId: "agent-1", branchId: "branch-1", provider: "codex" },
    { agentId: "agent-2", branchId: "branch-2", provider: "claude" },
    { agentId: "agent-3", branchId: "branch-3", provider: "opencode" },
  ],
};

function message(overrides: Partial<A2AMessage> = {}): A2AMessage {
  return {
    schemaVersion: 1,
    messageId: "message-1",
    runId: roster.runId,
    branchId: "branch-1",
    agentId: "agent-1",
    recipient: { kind: "agent", agentId: "agent-2" },
    kind: "help-request",
    priority: "normal",
    idempotencyKey: "run-a2a:message-1",
    createdAt: 100,
    summary: "Verify the browser target",
    replyDepth: 0,
    ...overrides,
  };
}

test("routes one structured message to direct and group recipients without polling", () => {
  const router = createMultiplayerA2ARouter(roster, { now: () => 200 });
  const events: string[] = [];
  router.subscribe((event) => events.push(event.kind + (event.kind === "message-delivered" ? `:${event.recipientAgentId}` : "")));
  const direct = router.send(message());
  assert.equal(direct.ok, true);
  assert.deepEqual(router.historyFor("agent-2").map((item) => item.messageId), ["message-1"]);
  const group = router.send(message({ messageId: "message-2", idempotencyKey: "run-a2a:message-2", recipient: { kind: "group", agentIds: ["agent-2", "agent-3"] }, summary: "Please compare the two targets" }));
  assert.equal(group.ok, true);
  assert.deepEqual(router.historyFor("agent-3").map((item) => item.messageId), ["message-2"]);
  assert.deepEqual(events, ["message-accepted", "message-delivered:agent-2", "message-accepted", "message-delivered:agent-2", "message-delivered:agent-3"]);
});

test("deduplicates retries by message ID and sender-scoped idempotency key", () => {
  const router = createMultiplayerA2ARouter(roster, { now: () => 200 });
  const first = router.send(message());
  const retry = router.send(message());
  assert.equal(first.ok, true);
  assert.equal(retry.ok, true);
  if (retry.ok) assert.equal(retry.duplicate, true);
  assert.equal(router.history().length, 1);
  assert.equal(router.send(message({ messageId: "different", idempotencyKey: message().idempotencyKey })).ok, false);
});

test("rejects expired, cross-run, unknown-recipient, and dangling-reply messages", () => {
  const router = createMultiplayerA2ARouter(roster, { now: () => 500 });
  const expired = router.send(message({ expiresAt: 500 }));
  assert.equal(expired.ok, false);
  if (!expired.ok) assert.equal(expired.expired, true);
  assert.equal(router.send(message({ messageId: "cross-run", idempotencyKey: "cross-run", runId: "other-run" })).ok, false);
  assert.equal(router.send(message({ messageId: "unknown-recipient", idempotencyKey: "unknown-recipient", recipient: { kind: "agent", agentId: "agent-99" } })).ok, false);
  assert.equal(router.send(message({ messageId: "dangling-reply", idempotencyKey: "dangling-reply", replyToMessageId: "missing" })).ok, false);
});

test("restored durable routing metadata keeps reply references valid after router restart", () => {
  const router = createMultiplayerA2ARouter(roster, {
    now: () => 200,
    knownMessageIds: ["persisted-parent"],
    knownMessageReferences: [{
      messageId: "persisted-parent",
      agentId: "agent-1",
      recipientAgentIds: ["agent-2"],
      conversationId: "persisted-conversation",
      replyDepth: 0,
    }],
  });
  const reply = router.send(message({
    agentId: "agent-2",
    branchId: "branch-2",
    recipient: { kind: "agent", agentId: "agent-1" },
    messageId: "reply-after-restart",
    idempotencyKey: "reply-after-restart",
    conversationId: "persisted-conversation",
    replyToMessageId: "persisted-parent",
    replyDepth: 1,
    summary: "I have a new verified result.",
  }));
  assert.equal(reply.ok, true);
});

test("conversation roots cannot be restarted to reset the reply and message bounds", () => {
  const router = createMultiplayerA2ARouter(roster, { now: () => 200 });
  const root = router.send(message({ conversationId: "thread-1" }));
  assert.equal(root.ok, true);
  const repeatedRoot = router.send(message({ messageId: "root-2", idempotencyKey: "root-2", conversationId: "thread-1" }));
  assert.equal(repeatedRoot.ok, false);
  for (let index = 1; index < MAX_A2A_CONVERSATION_MESSAGES; index += 1) {
    const reply = router.send(message({
      agentId: "agent-2",
      branchId: "branch-2",
      recipient: { kind: "agent", agentId: "agent-1" },
      messageId: `parallel-reply-${index}`,
      idempotencyKey: `parallel-reply-${index}`,
      conversationId: "thread-1",
      replyToMessageId: "message-1",
      replyDepth: 1,
    }));
    assert.equal(reply.ok, true);
  }
  const overLimit = router.send(message({
    agentId: "agent-2",
    branchId: "branch-2",
    recipient: { kind: "agent", agentId: "agent-1" },
    messageId: "parallel-reply-over-limit",
    idempotencyKey: "parallel-reply-over-limit",
    conversationId: "thread-1",
    replyToMessageId: "message-1",
    replyDepth: 1,
  }));
  assert.equal(overLimit.ok, false);
});

test("task-linked replies stay in one conversation and follow the referenced message depth", () => {
  const router = createMultiplayerA2ARouter(roster, { now: () => 200 });
  const first = router.send(message({ taskId: "task-a", conversationId: "conversation-a" }));
  assert.equal(first.ok, true);
  const reply = router.send(message({
    agentId: "agent-2",
    branchId: "branch-2",
    recipient: { kind: "agent", agentId: "agent-1" },
    messageId: "message-2",
    idempotencyKey: "reply-1",
    taskId: "task-a",
    conversationId: "conversation-a",
    replyToMessageId: "message-1",
    replyDepth: 1,
    summary: "Verified result.",
  }));
  assert.equal(reply.ok, true);
  assert.equal(router.send(message({
    messageId: "wrong-conversation",
    idempotencyKey: "wrong-conversation",
    taskId: "task-a",
    conversationId: "conversation-b",
  })).ok, false);
});

test("task-room progress sidecars expose the latest witness without parsing prose", () => {
  const router = createMultiplayerA2ARouter(roster, { now: () => 300 });
  const first = router.send(message({
    taskId: "task-1",
    conversationId: "conversation-1",
    messageId: "progress-1",
    idempotencyKey: "progress-1",
    progressFingerprint: "state-a",
    progressKind: "observation",
    summary: "Observed the assigned tab",
  }));
  assert.equal(first.ok, true);
  const second = router.send(message({
    taskId: "task-1",
    conversationId: "conversation-1",
    replyToMessageId: "progress-1",
    replyDepth: 1,
    messageId: "progress-2",
    idempotencyKey: "progress-2",
    progressFingerprint: "state-b",
    progressKind: "postcondition-verified",
    summary: "Verified the result",
  }));
  assert.equal(second.ok, true);
  assert.deepEqual(router.progressFor("task-1"), [{
    taskId: "task-1",
    agentId: "agent-1",
    messageId: "progress-2",
    progressFingerprint: "state-b",
    progressKind: "postcondition-verified",
    at: 100,
  }]);
});
