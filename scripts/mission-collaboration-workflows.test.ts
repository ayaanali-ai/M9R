/**
 * Mission collaboration workflows — Phase 4C integration tests
 *
 * Blocker, completion_notice, and approval-authorization behavior through
 * the full `applyMissionCommand` path — proving the generalized atomic
 * orchestration seam (blocker/unblock, completion_notice -> submit) and the
 * new human_required authorization gate on AcceptAssignment/RejectAssignment.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { applyMissionCommand, type ApplyCommandInput } from "../src/lib/mission/mission-command-handler.ts";
import { resolveCommandContext, type MissionCommand } from "../src/lib/mission/mission-commands.ts";
import type { MissionProjection } from "../src/lib/mission/mission-projection.ts";

const MISSION_ID = "m-1";
let idCounter = 0;
function mintEventId(): string {
  idCounter += 1;
  return `evt-${idCounter}`;
}
function ctx(actor: { kind: "human" | "agent" | "system"; id: string } = { kind: "system", id: "orchestrator" }) {
  return resolveCommandContext({ actor: actor as never, timestamp: "2026-08-10T00:00:00.000Z" });
}
function run(current: MissionProjection | null, command: MissionCommand, expectedVersion: number, opts: Partial<ApplyCommandInput> = {}) {
  return applyMissionCommand({ current, command, context: ctx(), expectedVersion, priorOutcome: null, mintEventId, ...opts });
}
function runAs(actor: { kind: "human" | "agent" | "system"; id: string }, current: MissionProjection | null, command: MissionCommand, expectedVersion: number) {
  return applyMissionCommand({ current, command, context: ctx(actor), expectedVersion, priorOutcome: null, mintEventId });
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

function bootstrap(approvalPolicy: "auto" | "human_required" = "auto"): MissionProjection {
  let r = run(null, { type: "CreateMission", missionId: MISSION_ID, workspaceId: "ws-1", repository: "acme/app", goal: "goal", mode: "solo" }, 0);
  assert.ok(r.ok);
  if (!r.ok) throw new Error("unreachable");
  let projection = r.projection;

  r = run(projection, addParticipant("p-1"), projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) throw new Error("unreachable");
  projection = r.projection;
  r = run(projection, { type: "ActivateParticipant", missionId: MISSION_ID, participantId: "p-1" }, projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) throw new Error("unreachable");
  projection = r.projection;

  r = run(
    projection,
    { type: "CreateAssignment", missionId: MISSION_ID, assignmentId: "a-1", title: "t", objective: "o", scope: { allowedPaths: ["."], prohibitedPaths: [] }, dependencies: [], requiredEvidence: [], approvalPolicy, budget: { maxDurationMs: null, maxEstimatedTokens: null } },
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

// ---------------------------------------------------------------------------
// Blocker workflow
// ---------------------------------------------------------------------------

test("a blocker message atomically moves the assignment to blocked, and a correlated unblock resumes it", () => {
  const projection = bootstrap();
  const blocked = run(
    projection,
    { type: "PostMessage", missionId: MISSION_ID, messageId: "block-1", senderParticipantId: "p-1", recipientParticipantIds: [], assignmentId: "a-1", messageType: "blocker", body: "stuck", evidenceRefs: [], replyToMessageId: null, structuredPayload: { reason: "dependency_incomplete" } },
    projection.aggregateVersion,
  );
  assert.ok(blocked.ok);
  if (!blocked.ok) return;
  assert.equal(blocked.projection.assignments["a-1"].status, "blocked");

  const unblocked = run(
    blocked.projection,
    { type: "PostMessage", missionId: MISSION_ID, messageId: "unblock-1", senderParticipantId: "p-1", recipientParticipantIds: [], assignmentId: "a-1", messageType: "blocker", body: "unstuck", evidenceRefs: [], replyToMessageId: "block-1", structuredPayload: { resolved: true } },
    blocked.aggregateVersion,
  );
  assert.ok(unblocked.ok);
  if (!unblocked.ok) return;
  assert.equal(unblocked.projection.assignments["a-1"].status, "running");
});

test("a blocker message missing a reason is rejected before any assignment mutation", () => {
  // Phase 4D Part 3: a missing 'reason' is now caught by the real runtime
  // protocol schema (mission-protocol-schema.ts) BEFORE
  // mission-collaboration-protocol.ts's domain-semantic
  // `validateBlockerPayload` ever runs — the same input is still rejected,
  // just one layer earlier and more precisely (a missing required field is
  // a SHAPE problem, not a domain-semantic one). `blocker_missing_reason`
  // remains reachable for a blocker whose 'reason' is present but not one
  // of the recognized values reaching the domain layer — this case is a
  // missing field entirely, which the schema layer owns.
  const projection = bootstrap();
  const result = run(
    projection,
    { type: "PostMessage", missionId: MISSION_ID, messageId: "block-1", senderParticipantId: "p-1", recipientParticipantIds: [], assignmentId: "a-1", messageType: "blocker", body: "stuck", evidenceRefs: [], replyToMessageId: null },
    projection.aggregateVersion,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "protocol_schema_violation");
    if (result.error.code === "protocol_schema_violation") assert.equal(result.error.error.field, "reason");
  }
});

// ---------------------------------------------------------------------------
// Completion notice workflow
// ---------------------------------------------------------------------------

test("a completion_notice atomically submits the assignment when running and evidence/dependencies are satisfied", () => {
  const projection = bootstrap();
  const result = run(
    projection,
    { type: "PostMessage", missionId: MISSION_ID, messageId: "done-1", senderParticipantId: "p-1", recipientParticipantIds: [], assignmentId: "a-1", messageType: "completion_notice", body: "done", evidenceRefs: [], replyToMessageId: null },
    projection.aggregateVersion,
  );
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.projection.assignments["a-1"].status, "submitted");
});

test("a duplicate completion_notice (assignment already submitted) is idempotent — recorded, no error, no re-submission attempt", () => {
  const projection = bootstrap();
  const first = run(
    projection,
    { type: "PostMessage", missionId: MISSION_ID, messageId: "done-1", senderParticipantId: "p-1", recipientParticipantIds: [], assignmentId: "a-1", messageType: "completion_notice", body: "done", evidenceRefs: [], replyToMessageId: null },
    projection.aggregateVersion,
  );
  assert.ok(first.ok);
  if (!first.ok) return;

  const second = run(
    first.projection,
    { type: "PostMessage", missionId: MISSION_ID, messageId: "done-2", senderParticipantId: "p-1", recipientParticipantIds: [], assignmentId: "a-1", messageType: "completion_notice", body: "done again", evidenceRefs: [], replyToMessageId: null },
    first.aggregateVersion,
  );
  assert.ok(second.ok, "a duplicate completion notice must not be treated as an error");
  if (!second.ok) return;
  assert.equal(second.projection.assignments["a-1"].status, "submitted", "still submitted — not resubmitted or advanced further");
  assert.equal(second.projection.messages.length, 2, "both notices are durably recorded");
});

test("a completion_notice missing required evidence is rejected, and the assignment stays running", () => {
  const projection = bootstrap();
  const withEvidenceRequirement = run(
    projection,
    { type: "CreateAssignment", missionId: MISSION_ID, assignmentId: "a-2", title: "t2", objective: "o2", scope: { allowedPaths: ["."], prohibitedPaths: [] }, dependencies: [], requiredEvidence: ["evidence://tests"], approvalPolicy: "auto", budget: { maxDurationMs: null, maxEstimatedTokens: null } },
    projection.aggregateVersion,
  );
  assert.ok(withEvidenceRequirement.ok);
  if (!withEvidenceRequirement.ok) return;
  let p = withEvidenceRequirement.projection;
  let r = run(p, { type: "AssignAssignment", missionId: MISSION_ID, assignmentId: "a-2", assigneeParticipantId: "p-1", dispatchKey: "secondary" }, p.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  p = r.projection;
  r = run(p, { type: "StartAssignment", missionId: MISSION_ID, assignmentId: "a-2" }, p.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  p = r.projection;

  const result = run(
    p,
    { type: "PostMessage", missionId: MISSION_ID, messageId: "done-1", senderParticipantId: "p-1", recipientParticipantIds: [], assignmentId: "a-2", messageType: "completion_notice", body: "done", evidenceRefs: [], replyToMessageId: null },
    p.aggregateVersion,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "message_policy_violation");
    if (result.error.code === "message_policy_violation") assert.equal(result.error.violation.code, "completion_notice_missing_required_evidence");
  }
  assert.equal(p.assignments["a-2"].status, "running");
});

// ---------------------------------------------------------------------------
// Approval authorization gate
// ---------------------------------------------------------------------------

test("AcceptAssignment on a human_required assignment is refused when the actor is not human", () => {
  const projection = bootstrap("human_required");
  const submitted = run(projection, { type: "SubmitAssignment", missionId: MISSION_ID, assignmentId: "a-1", evidenceRefs: [] }, projection.aggregateVersion);
  assert.ok(submitted.ok);
  if (!submitted.ok) return;
  const verified = run(submitted.projection, { type: "VerifyAssignment", missionId: MISSION_ID, assignmentId: "a-1", verified: true }, submitted.aggregateVersion);
  assert.ok(verified.ok);
  if (!verified.ok) return;

  const result = runAs({ kind: "agent", id: "p-1" }, verified.projection, { type: "AcceptAssignment", missionId: MISSION_ID, assignmentId: "a-1" }, verified.aggregateVersion);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "unauthorized_approval");
});

test("AcceptAssignment on a human_required assignment succeeds when the actor is human", () => {
  const projection = bootstrap("human_required");
  const submitted = run(projection, { type: "SubmitAssignment", missionId: MISSION_ID, assignmentId: "a-1", evidenceRefs: [] }, projection.aggregateVersion);
  assert.ok(submitted.ok);
  if (!submitted.ok) return;
  const verified = run(submitted.projection, { type: "VerifyAssignment", missionId: MISSION_ID, assignmentId: "a-1", verified: true }, submitted.aggregateVersion);
  assert.ok(verified.ok);
  if (!verified.ok) return;

  const result = runAs({ kind: "human", id: "human-1" }, verified.projection, { type: "AcceptAssignment", missionId: MISSION_ID, assignmentId: "a-1" }, verified.aggregateVersion);
  assert.equal(result.ok, true);
});

test("an 'auto' approvalPolicy assignment requires no human gate — an agent can accept it", () => {
  const projection = bootstrap("auto");
  const submitted = run(projection, { type: "SubmitAssignment", missionId: MISSION_ID, assignmentId: "a-1", evidenceRefs: [] }, projection.aggregateVersion);
  assert.ok(submitted.ok);
  if (!submitted.ok) return;
  const verified = run(submitted.projection, { type: "VerifyAssignment", missionId: MISSION_ID, assignmentId: "a-1", verified: true }, submitted.aggregateVersion);
  assert.ok(verified.ok);
  if (!verified.ok) return;

  const result = runAs({ kind: "agent", id: "p-1" }, verified.projection, { type: "AcceptAssignment", missionId: MISSION_ID, assignmentId: "a-1" }, verified.aggregateVersion);
  assert.equal(result.ok, true);
});

test("a duplicate AcceptAssignment (already accepted) is refused as an invalid transition — 'accepted' is terminal", () => {
  const projection = bootstrap();
  const submitted = run(projection, { type: "SubmitAssignment", missionId: MISSION_ID, assignmentId: "a-1", evidenceRefs: [] }, projection.aggregateVersion);
  assert.ok(submitted.ok);
  if (!submitted.ok) return;
  const verified = run(submitted.projection, { type: "VerifyAssignment", missionId: MISSION_ID, assignmentId: "a-1", verified: true }, submitted.aggregateVersion);
  assert.ok(verified.ok);
  if (!verified.ok) return;
  const accepted = run(verified.projection, { type: "AcceptAssignment", missionId: MISSION_ID, assignmentId: "a-1" }, verified.aggregateVersion);
  assert.ok(accepted.ok);
  if (!accepted.ok) return;

  const conflicting = run(accepted.projection, { type: "RejectAssignment", missionId: MISSION_ID, assignmentId: "a-1", reason: { code: "x", summary: "s", relatedEntityIds: [], recoverable: false, suggestedActions: [] } }, accepted.aggregateVersion);
  assert.equal(conflicting.ok, false, "a conflicting decision after acceptance must be refused — accepted is terminal");
  if (!conflicting.ok) assert.equal(conflicting.error.code, "invalid_assignment_transition");
});
