/**
 * Runtime protocol schemas + sender/reference enforcement — Phase 4D Part 3
 * §2/§3/§5 tests.
 *
 * Covers the pure schema validator directly (unknown message type, wrong
 * primitive type, missing required field, invalid enum, unknown
 * authority-bearing field, malformed id) AND its integration through
 * applyMissionCommand (sender identity binding, completion_notice sender
 * ownership).
 */

import test from "node:test";
import assert from "node:assert/strict";

import { validateStructuredPayloadSchema } from "../src/lib/mission/mission-protocol-schema.ts";
import { applyMissionCommand, type ApplyCommandInput } from "../src/lib/mission/mission-command-handler.ts";
import { resolveCommandContext, type MissionCommand } from "../src/lib/mission/mission-commands.ts";
import type { MissionProjection } from "../src/lib/mission/mission-projection.ts";

// ---------------------------------------------------------------------------
// Pure schema validator
// ---------------------------------------------------------------------------

test("rejects an unknown message type outright", () => {
  const result = validateStructuredPayloadSchema("not_a_real_type" as never, {});
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "unknown_message_type");
});

test("rejects a non-object payload", () => {
  const result = validateStructuredPayloadSchema("blocker", "just a string");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "payload_not_an_object");
});

test("rejects an unknown, potentially authority-bearing field", () => {
  const result = validateStructuredPayloadSchema("approval_request", { subject: "permission", preApproved: true });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "unknown_field");
    assert.equal(result.error.field, "preApproved");
  }
});

test("rejects an invalid enum value (reviewPolicy)", () => {
  const result = validateStructuredPayloadSchema("review_request", { reviewerParticipantIds: ["p-1"], reviewPolicy: "rubber_stamp" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "invalid_enum_value");
});

test("rejects an invalid blocker reason enum value", () => {
  const result = validateStructuredPayloadSchema("blocker", { reason: "i_felt_like_it" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "invalid_enum_value");
});

test("rejects an invalid approval subject enum value", () => {
  const result = validateStructuredPayloadSchema("approval_request", { subject: "just_trust_me" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "invalid_enum_value");
});

test("rejects an invalid evidence_notice kind enum value", () => {
  const result = validateStructuredPayloadSchema("evidence_notice", { evidenceKind: "vibes" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "invalid_enum_value");
});

test("rejects a missing required field (delegation_response without 'accepted')", () => {
  const result = validateStructuredPayloadSchema("delegation_response", {});
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "missing_required_field");
    assert.equal(result.error.field, "accepted");
  }
});

test("rejects a wrong primitive type (accepted as a string, not boolean)", () => {
  const result = validateStructuredPayloadSchema("delegation_response", { accepted: "yes" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "missing_required_field");
});

test("rejects a malformed (empty-string) id inside an array", () => {
  const result = validateStructuredPayloadSchema("review_request", { reviewerParticipantIds: ["p-1", ""] });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "malformed_id");
});

test("rejects a malformed array (non-string elements)", () => {
  const result = validateStructuredPayloadSchema("review_request", { reviewerParticipantIds: ["p-1", 42] });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "missing_required_field");
});

test("accepts a well-formed payload for every schema-bearing message type", () => {
  assert.equal(validateStructuredPayloadSchema("delegation_response", { accepted: true }).ok, true);
  assert.equal(validateStructuredPayloadSchema("review_request", { reviewerParticipantIds: ["p-1"], reviewPolicy: "single_reviewer" }).ok, true);
  assert.equal(validateStructuredPayloadSchema("blocker", { reason: "dependency_incomplete" }).ok, true);
  assert.equal(validateStructuredPayloadSchema("blocker", { resolved: true }).ok, true);
  assert.equal(validateStructuredPayloadSchema("evidence_notice", { evidenceKind: "test_result" }).ok, true);
  assert.equal(validateStructuredPayloadSchema("approval_request", { subject: "permission" }).ok, true);
  assert.equal(validateStructuredPayloadSchema("completion_notice", { dispatchKey: null }).ok, true);
  assert.equal(validateStructuredPayloadSchema("question", {}).ok, true);
  assert.equal(validateStructuredPayloadSchema("information", undefined).ok, true);
});

// ---------------------------------------------------------------------------
// Integration: sender identity binding + completion_notice ownership
// ---------------------------------------------------------------------------

const MISSION_ID = "m-1";
let idCounter = 0;
function mintEventId(): string {
  idCounter += 1;
  return `evt-${idCounter}`;
}
function ctx(actor: { kind: "human" | "agent" | "system"; id: string } = { kind: "system", id: "orchestrator" }) {
  return resolveCommandContext({ actor: actor as never, timestamp: "2026-08-30T00:00:00.000Z" });
}
function run(current: MissionProjection | null, command: MissionCommand, expectedVersion: number, actor: { kind: "human" | "agent" | "system"; id: string } = { kind: "system", id: "orchestrator" }, opts: Partial<ApplyCommandInput> = {}) {
  return applyMissionCommand({ current, command, context: ctx(actor), expectedVersion, priorOutcome: null, mintEventId, ...opts });
}
function addParticipant(participantId: string): MissionCommand {
  return {
    type: "AddParticipant",
    missionId: MISSION_ID,
    participantId,
    kind: "agent",
    role: "implementer",
    displayName: participantId,
    agentKind: null,
    provider: "codex",
    adapterId: "codex",
    capabilities: [],
    assignmentScope: { allowedPaths: ["."], prohibitedPaths: [] },
    workspacePermissions: { allowedPaths: ["."], prohibitedPaths: [] },
    communicationPermissions: { canBroadcast: false, canDelegate: true, maxDelegationDepth: 3 },
  };
}
function bootstrapWithAssignment(): MissionProjection {
  let r = run(null, { type: "CreateMission", missionId: MISSION_ID, workspaceId: "ws-1", repository: "acme/app", goal: "goal", mode: "solo" }, 0);
  assert.ok(r.ok);
  if (!r.ok) throw new Error("unreachable");
  let projection = r.projection;
  for (const id of ["p-1", "p-2"]) {
    r = run(projection, addParticipant(id), projection.aggregateVersion);
    assert.ok(r.ok);
    if (!r.ok) throw new Error("unreachable");
    projection = r.projection;
    r = run(projection, { type: "ActivateParticipant", missionId: MISSION_ID, participantId: id }, projection.aggregateVersion);
    assert.ok(r.ok);
    if (!r.ok) throw new Error("unreachable");
    projection = r.projection;
  }
  r = run(
    projection,
    { type: "CreateAssignment", missionId: MISSION_ID, assignmentId: "a-1", title: "t", objective: "o", scope: { allowedPaths: ["."], prohibitedPaths: [] }, dependencies: [], requiredEvidence: [], approvalPolicy: "auto", budget: { maxDurationMs: null, maxEstimatedTokens: null } },
    projection.aggregateVersion,
  );
  assert.ok(r.ok);
  if (!r.ok) throw new Error("unreachable");
  projection = r.projection;
  r = run(projection, { type: "AssignAssignment", missionId: MISSION_ID, assignmentId: "a-1", assigneeParticipantId: "p-1", dispatchKey: "primary" }, projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) throw new Error("unreachable");
  projection = r.projection;
  r = run(projection, { type: "StartAssignment", missionId: MISSION_ID, assignmentId: "a-1" }, projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) throw new Error("unreachable");
  return r.projection;
}

test("an agent actor cannot post a message claiming a DIFFERENT participant's senderParticipantId (impersonation)", () => {
  const projection = bootstrapWithAssignment();
  const result = run(
    projection,
    { type: "PostMessage", missionId: MISSION_ID, messageId: "m-1", senderParticipantId: "p-2", recipientParticipantIds: ["p-1"], assignmentId: null, messageType: "information", body: "hi", evidenceRefs: [], replyToMessageId: null },
    projection.aggregateVersion,
    { kind: "agent", id: "p-1" }, // acting as p-1 but CLAIMING to be p-2
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "sender_identity_mismatch");
});

test("an agent actor posting as itself is unaffected by the identity check", () => {
  const projection = bootstrapWithAssignment();
  const result = run(
    projection,
    { type: "PostMessage", missionId: MISSION_ID, messageId: "m-1", senderParticipantId: "p-1", recipientParticipantIds: ["p-2"], assignmentId: null, messageType: "information", body: "hi", evidenceRefs: [], replyToMessageId: null },
    projection.aggregateVersion,
    { kind: "agent", id: "p-1" },
  );
  assert.equal(result.ok, true);
});

test("a system actor may post ON BEHALF OF a named sender without tripping the identity check", () => {
  const projection = bootstrapWithAssignment();
  const result = run(
    projection,
    { type: "PostMessage", missionId: MISSION_ID, messageId: "m-1", senderParticipantId: "p-1", recipientParticipantIds: ["p-2"], assignmentId: null, messageType: "information", body: "relayed", evidenceRefs: [], replyToMessageId: null },
    projection.aggregateVersion,
    { kind: "system", id: "orchestrator" },
  );
  assert.equal(result.ok, true);
});

test("a completion_notice from a participant who is NOT the assignment's assignee is refused", () => {
  const projection = bootstrapWithAssignment();
  const result = run(
    projection,
    { type: "PostMessage", missionId: MISSION_ID, messageId: "cn-1", senderParticipantId: "p-2", recipientParticipantIds: [], assignmentId: "a-1", messageType: "completion_notice", body: "done", evidenceRefs: [], replyToMessageId: null },
    projection.aggregateVersion,
    { kind: "agent", id: "p-2" },
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "message_policy_violation");
    if (result.error.code === "message_policy_violation") assert.equal(result.error.violation.code, "completion_notice_sender_not_assignee");
  }
});

test("a completion_notice from the actual assignee succeeds", () => {
  const projection = bootstrapWithAssignment();
  const result = run(
    projection,
    { type: "PostMessage", missionId: MISSION_ID, messageId: "cn-1", senderParticipantId: "p-1", recipientParticipantIds: [], assignmentId: "a-1", messageType: "completion_notice", body: "done", evidenceRefs: [], replyToMessageId: null },
    projection.aggregateVersion,
    { kind: "agent", id: "p-1" },
  );
  assert.equal(result.ok, true);
});

test("a protocol schema violation is returned as a typed error before any event is emitted", () => {
  const projection = bootstrapWithAssignment();
  const before = projection.messages.length;
  const result = run(
    projection,
    { type: "PostMessage", missionId: MISSION_ID, messageId: "m-1", senderParticipantId: "p-1", recipientParticipantIds: ["p-2"], assignmentId: null, messageType: "approval_request", body: "please approve", evidenceRefs: [], replyToMessageId: null, structuredPayload: { subject: "nonsense_subject" } },
    projection.aggregateVersion,
    { kind: "agent", id: "p-1" },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "protocol_schema_violation");
  assert.equal(projection.messages.length, before);
});
