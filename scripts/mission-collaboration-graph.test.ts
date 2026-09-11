/**
 * Mission collaboration graph — Phase 4B pure-domain tests
 *
 * Covers chain-derived delegation depth (including the malformed-chain
 * fail-closed case and a cyclic chain), participant/assignment cycle
 * detection, and scope-narrowing validation.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { deriveDelegationDepth, hasAssignmentCycle, validateScopeNarrowing, wouldCreateParticipantCycle } from "../src/lib/mission/mission-collaboration-graph.ts";
import type { MissionAssignment, MissionMessage } from "../src/lib/mission/mission-domain.ts";

function message(overrides: Partial<MissionMessage> = {}): MissionMessage {
  return {
    id: "m-1",
    missionId: "mission-1",
    senderParticipantId: "p-1",
    recipientParticipantIds: ["p-2"],
    assignmentId: null,
    type: "delegation_request",
    body: "",
    evidenceRefs: [],
    correlationId: "corr-1",
    causationId: null,
    replyToMessageId: null,
    createdAt: "2026-08-05T00:00:00.000Z",
    structuredPayload: {},
    ...overrides,
  };
}

test("a root delegation_request (no reply/causation) has depth 0", () => {
  const root = message({ id: "req-1" });
  const result = deriveDelegationDepth(root, [root]);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.depth, 0);
});

test("a delegation_request replying to another delegation_request has depth 1", () => {
  const root = message({ id: "req-1", type: "delegation_request" });
  const child = message({ id: "req-2", type: "delegation_request", replyToMessageId: "req-1" });
  const result = deriveDelegationDepth(child, [root, child]);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.depth, 1);
});

test("a chain of three delegation_requests has depth 2 at the tip", () => {
  const req1 = message({ id: "req-1", type: "delegation_request" });
  const req2 = message({ id: "req-2", type: "delegation_request", replyToMessageId: "req-1" });
  const req3 = message({ id: "req-3", type: "delegation_request", replyToMessageId: "req-2" });
  const result = deriveDelegationDepth(req3, [req1, req2, req3]);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.depth, 2);
});

test("non-delegation messages in the chain don't add depth — only delegation_requests count", () => {
  const req1 = message({ id: "req-1", type: "delegation_request" });
  const info = message({ id: "info-1", type: "information", replyToMessageId: "req-1" });
  const req2 = message({ id: "req-2", type: "delegation_request", replyToMessageId: "info-1" });
  const result = deriveDelegationDepth(req2, [req1, info, req2]);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.depth, 1);
});

test("a chain referencing an unknown message id fails closed rather than assuming depth 0", () => {
  const orphan = message({ id: "req-2", replyToMessageId: "ghost" });
  const result = deriveDelegationDepth(orphan, [orphan]);
  assert.equal(result.ok, false);
});

test("a cyclic chain fails closed rather than looping forever", () => {
  const a = message({ id: "a", replyToMessageId: "b" });
  const b = message({ id: "b", replyToMessageId: "a" });
  const result = deriveDelegationDepth(a, [a, b]);
  assert.equal(result.ok, false);
});

test("causationId is consulted when replyToMessageId is absent", () => {
  const root = message({ id: "req-1", type: "delegation_request" });
  const child = message({ id: "req-2", type: "delegation_request", replyToMessageId: null, causationId: "req-1" });
  const result = deriveDelegationDepth(child, [root, child]);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.depth, 1);
});

function assignment(overrides: Partial<MissionAssignment> = {}): MissionAssignment {
  return {
    id: "a-1",
    missionId: "m-1",
    assigneeParticipantId: "p-1",
    title: "t",
    objective: "o",
    scope: { allowedPaths: ["."], prohibitedPaths: [] },
    dependencies: [],
    requiredEvidence: [],
    approvalPolicy: "auto",
    budget: { maxDurationMs: null, maxEstimatedTokens: null },
    status: "running",
    reviewerParticipantIds: [],
    dispatchKey: null,
    parentAssignmentId: null,
    originatingMessageId: null,
    delegatorParticipantId: null,
    delegationDepth: 0,
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z",
    ...overrides,
  };
}

test("wouldCreateParticipantCycle detects delegating back to the original delegator", () => {
  const assignments = {
    "a-1": assignment({ id: "a-1", delegatorParticipantId: "p-1", assigneeParticipantId: "p-2" }),
  };
  assert.equal(wouldCreateParticipantCycle("p-1", "a-1", assignments), true, "p-1 is upstream in this lineage — delegating back to them is a cycle");
  assert.equal(wouldCreateParticipantCycle("p-3", "a-1", assignments), false, "p-3 has no relation to this lineage");
});

test("wouldCreateParticipantCycle walks multiple hops of the parent chain", () => {
  const assignments = {
    "a-1": assignment({ id: "a-1", delegatorParticipantId: "p-1", assigneeParticipantId: "p-2" }),
    "a-2": assignment({ id: "a-2", parentAssignmentId: "a-1", delegatorParticipantId: "p-2", assigneeParticipantId: "p-3" }),
  };
  assert.equal(wouldCreateParticipantCycle("p-1", "a-2", assignments), true, "p-1 is two hops upstream");
});

test("hasAssignmentCycle detects a cyclic parentAssignmentId chain", () => {
  const assignments = {
    "a-1": assignment({ id: "a-1", parentAssignmentId: "a-2" }),
    "a-2": assignment({ id: "a-2", parentAssignmentId: "a-1" }),
  };
  assert.equal(hasAssignmentCycle("a-1", assignments), true);
});

test("hasAssignmentCycle reports false for a genuinely acyclic chain", () => {
  const assignments = {
    "a-1": assignment({ id: "a-1", parentAssignmentId: null }),
    "a-2": assignment({ id: "a-2", parentAssignmentId: "a-1" }),
  };
  assert.equal(hasAssignmentCycle("a-2", assignments), false);
});

test("validateScopeNarrowing accepts a child scope identical to the parent's", () => {
  const parent = { allowedPaths: ["src/"], prohibitedPaths: ["src/secrets/"] };
  const result = validateScopeNarrowing(parent, parent);
  assert.equal(result.ok, true);
});

test("validateScopeNarrowing accepts a child scope that only narrows (a subdirectory, an added prohibition)", () => {
  const parent = { allowedPaths: ["src/"], prohibitedPaths: [] };
  const child = { allowedPaths: ["src/lib/"], prohibitedPaths: ["src/lib/secrets/"] };
  const result = validateScopeNarrowing(parent, child);
  assert.equal(result.ok, true);
});

test("validateScopeNarrowing rejects a child allowed path outside the parent's own allowed paths", () => {
  const parent = { allowedPaths: ["src/lib/"], prohibitedPaths: [] };
  const child = { allowedPaths: ["src/lib/", "scripts/"], prohibitedPaths: [] };
  const result = validateScopeNarrowing(parent, child);
  assert.equal(result.ok, false);
  assert.deepEqual(result.excessAllowedPaths, ["scripts/"]);
});

test("validateScopeNarrowing rejects a child that drops a prohibition the parent required", () => {
  const parent = { allowedPaths: ["src/"], prohibitedPaths: ["src/secrets/"] };
  const child = { allowedPaths: ["src/"], prohibitedPaths: [] };
  const result = validateScopeNarrowing(parent, child);
  assert.equal(result.ok, false);
  assert.deepEqual(result.droppedProhibitedPaths, ["src/secrets/"]);
});
