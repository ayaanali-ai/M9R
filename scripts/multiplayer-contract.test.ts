import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_ACTIVE_AGENTS,
  parseA2AMessage,
  parseCancellationRequest,
  validateAgentCount,
  validateMultiplayerRoster,
} from "../src/lib/native/multiplayer-contract";

function roster(count: number) {
  return {
    runId: "run-phase-1",
    agents: Array.from({ length: count }, (_, index) => ({
      agentId: `agent-${index + 1}`,
      branchId: `branch-${index + 1}`,
      provider: index % 2 === 0 ? "codex" : "claude",
      handle: `agent-${index + 1}`,
    })),
  };
}

test("the Phase 1 roster accepts the product's 1/2/4/8/16 matrix", () => {
  for (const count of [1, 2, 4, 8, 16]) {
    assert.deepEqual(validateAgentCount(count), { ok: true, count });
    assert.equal(validateMultiplayerRoster(roster(count)).ok, true);
  }
  assert.equal(validateAgentCount(MAX_ACTIVE_AGENTS + 1).ok, false);
  assert.equal(validateMultiplayerRoster(roster(MAX_ACTIVE_AGENTS + 1)).ok, false);
});

test("a roster rejects duplicate agent or branch identities", () => {
  const duplicateAgent = roster(2);
  duplicateAgent.agents[1]!.agentId = duplicateAgent.agents[0]!.agentId;
  assert.equal(validateMultiplayerRoster(duplicateAgent).ok, false);

  const duplicateBranch = roster(2);
  duplicateBranch.agents[1]!.branchId = duplicateBranch.agents[0]!.branchId;
  assert.equal(validateMultiplayerRoster(duplicateBranch).ok, false);
});

test("A2A messages are bounded, correlated, and cannot target their sender", () => {
  const message = {
    schemaVersion: 1,
    messageId: "message-1",
    runId: "run-1",
    branchId: "branch-1",
    agentId: "agent-1",
    recipient: { kind: "group", agentIds: ["agent-2", "agent-3"] },
    kind: "help-request",
    priority: "normal",
    idempotencyKey: "run-1:message-1",
    createdAt: 100,
    expiresAt: 200,
    summary: "Verify the browser target",
    details: { surface: "browser" },
    replyDepth: 0,
  } as const;
  assert.equal(parseA2AMessage(message).recipient.kind, "group");
  assert.throws(() => parseA2AMessage({ ...message, recipient: { kind: "agent", agentId: "agent-1" } }));
});

test("cancellation scopes stay hierarchical and explicit", () => {
  const request = parseCancellationRequest({
    schemaVersion: 1,
    cancellationId: "cancel-1",
    scope: { scope: "branch", runId: "run-1", branchId: "branch-1" },
    reason: "Owner stopped this branch",
    requestedAt: 100,
  });
  assert.equal(request.scope.scope, "branch");
  assert.throws(() => parseCancellationRequest({
    ...request,
    scope: { scope: "operation", runId: "run-1", branchId: "branch-1", agentId: "agent-1" },
  }));
});
