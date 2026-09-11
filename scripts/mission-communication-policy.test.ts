/**
 * Mission communication policy — Phase 4A pure-domain tests
 *
 * Covers every rejection the Agent Message Protocol's policy gate must
 * enforce: inactive/unknown sender, unauthorized/unknown recipient,
 * disallowed broadcast, invalid assignment reference, delegation depth,
 * delegation outside assignment scope, and self-referential delegation.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_COMMUNICATION_POLICY, validateMessage } from "../src/lib/mission/mission-communication-policy.ts";
import { MISSION_BROADCAST_CHANNEL, type MissionAssignment, type MissionParticipant } from "../src/lib/mission/mission-domain.ts";

function participant(overrides: Partial<MissionParticipant> = {}): MissionParticipant {
  return {
    id: "p-1",
    kind: "agent",
    role: "implementer",
    agentKind: null,
    displayName: "Agent 1",
    status: "active",
    provider: "codex",
    adapterId: "codex",
    capabilities: [],
    assignmentScope: { allowedPaths: ["."], prohibitedPaths: [] },
    workspacePermissions: { allowedPaths: ["."], prohibitedPaths: [] },
    communicationPermissions: { canBroadcast: false, canDelegate: true, maxDelegationDepth: 2 },
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

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
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function baseInput(overrides: Partial<Parameters<typeof validateMessage>[0]> = {}) {
  return {
    senderParticipantId: "p-1",
    recipientParticipantIds: ["p-2"],
    assignmentId: null,
    type: "information" as const,
    derivedDelegationDepth: 0,
    participants: { "p-1": participant({ id: "p-1" }), "p-2": participant({ id: "p-2" }) },
    assignments: {},
    policy: DEFAULT_COMMUNICATION_POLICY,
    ...overrides,
  };
}

test("a message from an active, known sender to a known, active recipient is accepted", () => {
  const result = validateMessage(baseInput());
  assert.equal(result.ok, true);
});

test("a message from an unknown sender is rejected", () => {
  const result = validateMessage(baseInput({ senderParticipantId: "ghost" }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.violation.code, "unknown_sender");
});

test("a message from an inactive (removed) sender is rejected", () => {
  const result = validateMessage(
    baseInput({ senderParticipantId: "p-1", participants: { "p-1": participant({ id: "p-1", status: "removed" }), "p-2": participant({ id: "p-2" }) } }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.violation.code, "sender_not_active");
});

test("a message to an unknown recipient is rejected — this is also how cross-Mission addressing is refused: a foreign Mission's participant id is simply absent from this Mission's own map", () => {
  const result = validateMessage(baseInput({ recipientParticipantIds: ["participant-from-a-different-mission"] }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.violation.code, "unknown_recipient");
});

test("a message to a removed recipient is rejected", () => {
  const result = validateMessage(
    baseInput({ recipientParticipantIds: ["p-2"], participants: { "p-1": participant({ id: "p-1" }), "p-2": participant({ id: "p-2", status: "removed" }) } }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.violation.code, "recipient_not_active");
});

test("broadcast is refused when the policy disallows it, even if the sender's own permission allows it", () => {
  const result = validateMessage(
    baseInput({
      recipientParticipantIds: MISSION_BROADCAST_CHANNEL,
      participants: { "p-1": participant({ id: "p-1", communicationPermissions: { canBroadcast: true, canDelegate: true, maxDelegationDepth: 2 } }) },
      policy: { ...DEFAULT_COMMUNICATION_POLICY, allowBroadcast: false },
    }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.violation.code, "broadcast_not_allowed");
});

test("broadcast is refused when the sender's own permission disallows it, even if policy allows it", () => {
  const result = validateMessage(
    baseInput({
      recipientParticipantIds: MISSION_BROADCAST_CHANNEL,
      participants: { "p-1": participant({ id: "p-1", communicationPermissions: { canBroadcast: false, canDelegate: true, maxDelegationDepth: 2 } }) },
      policy: { ...DEFAULT_COMMUNICATION_POLICY, allowBroadcast: true },
    }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.violation.code, "broadcast_not_allowed");
});

test("broadcast succeeds when both the policy and the sender's permission allow it", () => {
  const result = validateMessage(
    baseInput({
      recipientParticipantIds: MISSION_BROADCAST_CHANNEL,
      participants: { "p-1": participant({ id: "p-1", communicationPermissions: { canBroadcast: true, canDelegate: true, maxDelegationDepth: 2 } }) },
      policy: { ...DEFAULT_COMMUNICATION_POLICY, allowBroadcast: true },
    }),
  );
  assert.equal(result.ok, true);
});

test("a message referencing an assignment that doesn't exist is rejected", () => {
  const result = validateMessage(baseInput({ assignmentId: "ghost-assignment" }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.violation.code, "invalid_assignment_reference");
});

test("a message referencing a real assignment is accepted", () => {
  const result = validateMessage(baseInput({ assignmentId: "a-1", assignments: { "a-1": assignment() } }));
  assert.equal(result.ok, true);
});

test("delegation beyond the configured depth is rejected", () => {
  const result = validateMessage(
    baseInput({
      type: "delegation_request",
      derivedDelegationDepth: 1,
      policy: { ...DEFAULT_COMMUNICATION_POLICY, maxDelegationDepth: 1 },
    }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.violation.code, "delegation_depth_exceeded");
});

test("delegation depth is also bounded by the sender's OWN maxDelegationDepth, not just the Mission policy's", () => {
  const result = validateMessage(
    baseInput({
      type: "delegation_request",
      derivedDelegationDepth: 1,
      participants: {
        "p-1": participant({ id: "p-1", communicationPermissions: { canBroadcast: false, canDelegate: true, maxDelegationDepth: 1 } }),
        "p-2": participant({ id: "p-2" }),
      },
      policy: { ...DEFAULT_COMMUNICATION_POLICY, maxDelegationDepth: 5 },
    }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.violation.code, "delegation_depth_exceeded");
});

test("a participant without delegation permission cannot send a delegation_request at all", () => {
  const result = validateMessage(
    baseInput({
      type: "delegation_request",
      participants: {
        "p-1": participant({ id: "p-1", communicationPermissions: { canBroadcast: false, canDelegate: false, maxDelegationDepth: 2 } }),
        "p-2": participant({ id: "p-2" }),
      },
    }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.violation.code, "delegation_not_permitted");
});

test("a self-referential delegation (sender addressed as its own recipient) is rejected as a loop", () => {
  const result = validateMessage(baseInput({ type: "delegation_request", recipientParticipantIds: ["p-1", "p-2"] }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.violation.code, "self_referential_delegation");
});

test("delegation on an assignment the sender does not actually hold is rejected as outside scope", () => {
  const result = validateMessage(
    baseInput({
      type: "delegation_request",
      assignmentId: "a-1",
      assignments: { "a-1": assignment({ assigneeParticipantId: "someone-else" }) },
    }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.violation.code, "delegation_outside_scope");
});

test("delegation on the sender's own assignment is accepted", () => {
  const result = validateMessage(
    baseInput({
      type: "delegation_request",
      assignmentId: "a-1",
      assignments: { "a-1": assignment({ assigneeParticipantId: "p-1" }) },
    }),
  );
  assert.equal(result.ok, true);
});
