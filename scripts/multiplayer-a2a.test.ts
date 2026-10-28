import assert from "node:assert/strict";
import test from "node:test";
import { createMultiplayerA2ARouter } from "../src/lib/native/multiplayer-a2a";
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
