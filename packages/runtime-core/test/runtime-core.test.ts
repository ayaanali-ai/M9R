import test from "node:test";
import assert from "node:assert/strict";
import {
  BRIDGE_PROTOCOL_VERSION,
  DEFAULT_BRIDGE_HOST,
  isTerminalProvider,
} from "../src/local-terminal-protocol.ts";
import {
  parseProviderAdapterConfig,
  providerAdapterId,
  providerLabel,
  providerMention,
} from "../src/provider-adapter-config.ts";
import {
  GOAL_CONTRACT_VERSION,
  canTransitionGoalStatus,
  goalStatusTransitions,
  parseGoalContract,
} from "../src/goal-contract.ts";
import {
  CONTEXT_PACKET_VERSION,
  isContextPacketExpired,
  parseContextPacket,
} from "../src/context-packet.ts";
import {
  COMPLETION_RECEIPT_VERSION,
  parseCompletionReceipt,
} from "../src/completion-receipt.ts";

test("runtime-core exposes stable local terminal protocol constants", () => {
  assert.equal(BRIDGE_PROTOCOL_VERSION, "oathlock-terminal-v1");
  assert.equal(DEFAULT_BRIDGE_HOST, "127.0.0.1");
  assert.equal(isTerminalProvider("claude-code"), true);
  assert.equal(isTerminalProvider("bad provider"), false);
});

test("runtime-core normalizes provider identities without hosted dependencies", () => {
  assert.equal(providerAdapterId("claude-code"), "claude-agent-acp");
  assert.equal(providerMention("Claude"), "claude-code");
  assert.equal(providerLabel("opencode-acp"), "OpenCode");
});

test("runtime-core validates bounded local adapter configuration", () => {
  const parsed = parseProviderAdapterConfig({ command: "codex", args: ["--acp"] }, "codex");
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.deepEqual(parsed.value.args, ["--acp"]);

  const rejected = parseProviderAdapterConfig({ command: "codex; whoami", shell: true }, "codex");
  assert.equal(rejected.ok, false);
});

test("runtime-core parses a provider-neutral Goal contract without hosted dependencies", () => {
  const parsed = parseGoalContract({
    version: GOAL_CONTRACT_VERSION,
    goal: {
      clientRequestId: "request-123",
      principalId: "principal:founder",
      principalKind: "personal_agent",
      title: "Resolve the billing regression",
      objective: "Find the cause, implement the fix, and prove the regression is covered.",
      successConditions: ["The billing regression test passes", "The relevant checks exit 0"],
      constraints: ["Do not change payment provider credentials"],
      allowedCapabilities: ["repository.read", "repository.write", "test.run"],
      providerPreferences: ["claude-code", "codex"],
      autonomyPolicy: "bounded_execute",
      budget: { maxDurationMs: 3_600_000, maxEstimatedTokens: 100_000 },
      deadline: "2030-01-02T03:04:05-05:00",
      parentGoalId: null,
      contextRefs: ["mission:billing-regression", "evidence:prior-failure"],
    },
  });

  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.version, GOAL_CONTRACT_VERSION);
    assert.equal(parsed.value.goal.deadline, "2030-01-02T08:04:05.000Z");
    assert.deepEqual(parsed.value.goal.providerPreferences, ["claude-code", "codex"]);
  }
});

test("runtime-core rejects malformed Goal contracts and keeps diagnostics deterministic", () => {
  const rejected = parseGoalContract({
    version: "m9r.goal.v0",
    goal: {
      clientRequestId: "not valid",
      principalId: "principal:founder",
      principalKind: "robot",
      title: "",
      objective: "x",
      successConditions: "done",
      constraints: [],
      allowedCapabilities: [],
      providerPreferences: [],
      autonomyPolicy: "auto_continue",
      budget: { maxDurationMs: 0, maxEstimatedTokens: null },
      contextRefs: [],
    },
  });

  assert.equal(rejected.ok, false);
  if (!rejected.ok) {
    assert.deepEqual(
      rejected.errors.map((issue) => issue.path),
      [
        "version",
        "goal.clientRequestId",
        "goal.principalKind",
        "goal.title",
        "goal.successConditions",
        "goal.budget.maxDurationMs",
      ],
    );
  }
});

test("runtime-core exposes explicit Goal lifecycle transitions", () => {
  assert.equal(canTransitionGoalStatus("proposed", "authorized"), true);
  assert.equal(canTransitionGoalStatus("executing", "completed"), true);
  assert.equal(canTransitionGoalStatus("completed", "executing"), false);
  assert.deepEqual(goalStatusTransitions("review"), [
    "completed",
    "planning",
    "blocked",
    "failed",
    "cancelled",
  ]);
});

test("runtime-core validates scoped Context Packets without embedding raw memory", () => {
  const parsed = parseContextPacket({
    version: CONTEXT_PACKET_VERSION,
    packet: {
      id: "packet-1",
      sourcePrincipalId: "principal:founder",
      sourceAgentId: "agent:claude",
      intendedRecipientPrincipalId: "principal:reviewer",
      purpose: "Explain the billing regression evidence",
      contentRef: "evidence://billing/regression/1",
      sensitivity: "workspace",
      allowedTransformations: ["summarize", "quote_test_names"],
      redactionStatus: "not_required",
      digest: "a".repeat(64),
      expiresAt: "2030-01-02T03:04:05-05:00",
      createdAt: "2030-01-01T03:04:05-05:00",
    },
  });

  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.packet.contentRef, "evidence://billing/regression/1");
    assert.equal(parsed.value.packet.expiresAt, "2030-01-02T08:04:05.000Z");
    assert.equal(isContextPacketExpired(parsed.value, Date.parse("2030-01-01T00:00:00Z")), false);
  }

  const restricted = parseContextPacket({
    version: CONTEXT_PACKET_VERSION,
    packet: {
      id: "packet-2",
      sourcePrincipalId: "principal:founder",
      sourceAgentId: "agent:claude",
      intendedRecipientPrincipalId: null,
      purpose: "Restricted context",
      contentRef: "memory://private/1",
      sensitivity: "restricted",
      allowedTransformations: [],
      redactionStatus: "not_required",
      digest: "b".repeat(64),
      expiresAt: null,
      createdAt: "2030-01-01T00:00:00Z",
    },
  });
  assert.equal(restricted.ok, false);
  if (!restricted.ok) assert.equal(restricted.errors.some((issue) => issue.code === "policy"), true);
});

test("runtime-core only accepts achieved receipts with satisfied conditions and evidence", () => {
  const receipt = {
    version: COMPLETION_RECEIPT_VERSION,
    receipt: {
      receiptId: "receipt-1",
      goalId: "goal-1",
      missionId: "mission-1",
      status: "achieved",
      conditions: [{ condition: "Tests pass", satisfied: true, evidenceIds: ["test-run-1"] }],
      evidence: [{ id: "test-run-1", kind: "test", summary: "npm test exited 0", digest: "c".repeat(64) }],
      agentIds: ["agent:codex"],
      providerIds: ["codex"],
      approvals: ["approval-1"],
      unresolvedRisks: [],
      decisionsRequired: [],
      contextPacketIds: ["packet-1"],
      startedAt: "2030-01-01T00:00:00Z",
      completedAt: "2030-01-01T00:10:00Z",
      generatedAt: "2030-01-01T00:10:01Z",
    },
  };
  assert.equal(parseCompletionReceipt(receipt).ok, true);

  const invalid = parseCompletionReceipt({
    ...receipt,
    receipt: { ...receipt.receipt, conditions: [{ condition: "Tests pass", satisfied: false, evidenceIds: [] }], evidence: [] },
  });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.errors.some((issue) => issue.code === "policy"), true);

  const unlinked = parseCompletionReceipt({
    ...receipt,
    receipt: {
      ...receipt.receipt,
      conditions: [{ condition: "Tests pass", satisfied: true, evidenceIds: ["missing-evidence"] }],
    },
  });
  assert.equal(unlinked.ok, false);
  if (!unlinked.ok) assert.equal(unlinked.errors.some((issue) => issue.path.includes("evidenceIds")), true);
});
