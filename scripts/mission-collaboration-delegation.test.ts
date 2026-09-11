/**
 * Mission collaboration — Phase 4B delegation, finding, and clarification
 * integration tests, through the full `applyMissionCommand` path.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { applyMissionCommand, type ApplyCommandInput } from "../src/lib/mission/mission-command-handler.ts";
import { resolveCommandContext, type MissionCommand } from "../src/lib/mission/mission-commands.ts";
import type { MissionProjection } from "../src/lib/mission/mission-projection.ts";

const MISSION_ID = "m-1";
const ACTOR = { kind: "system" as const, id: "orchestrator" as const };
let idCounter = 0;
function mintEventId(): string {
  idCounter += 1;
  return `evt-${idCounter}`;
}
function ctx() {
  return resolveCommandContext({ actor: ACTOR, timestamp: "2026-08-05T00:00:00.000Z" });
}
function run(current: MissionProjection | null, command: MissionCommand, expectedVersion: number, opts: Partial<ApplyCommandInput> = {}) {
  return applyMissionCommand({ current, command, context: ctx(), expectedVersion, priorOutcome: null, mintEventId, ...opts });
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

/** Mission with p-1 and p-2 both active, and assignment "a-1" claimed by p-1 and running. */
function bootstrap(): MissionProjection {
  let p = run(null, { type: "CreateMission", missionId: MISSION_ID, workspaceId: "ws-1", repository: "acme/app", goal: "goal", mode: "solo" }, 0);
  assert.ok(p.ok);
  let projection = (p as { ok: true; projection: MissionProjection }).projection;
  let v = (p as { ok: true; aggregateVersion: number }).aggregateVersion;

  for (const id of ["p-1", "p-2"]) {
    p = run(projection, addParticipant(id), v);
    assert.ok(p.ok);
    if (!p.ok) throw new Error("unreachable");
    projection = p.projection;
    v = p.aggregateVersion;
    p = run(projection, { type: "ActivateParticipant", missionId: MISSION_ID, participantId: id }, v);
    assert.ok(p.ok);
    if (!p.ok) throw new Error("unreachable");
    projection = p.projection;
    v = p.aggregateVersion;
  }

  p = run(
    projection,
    { type: "CreateAssignment", missionId: MISSION_ID, assignmentId: "a-1", title: "t", objective: "o", scope: { allowedPaths: ["src/"], prohibitedPaths: ["src/secrets/"] }, dependencies: [], requiredEvidence: [], approvalPolicy: "auto", budget: { maxDurationMs: null, maxEstimatedTokens: null } },
    v,
  );
  assert.ok(p.ok);
  if (!p.ok) throw new Error("unreachable");
  projection = p.projection;
  v = p.aggregateVersion;

  p = run(projection, { type: "AssignAssignment", missionId: MISSION_ID, assignmentId: "a-1", assigneeParticipantId: "p-1", dispatchKey: "primary" }, v);
  assert.ok(p.ok);
  if (!p.ok) throw new Error("unreachable");
  projection = p.projection;
  v = p.aggregateVersion;

  p = run(projection, { type: "StartAssignment", missionId: MISSION_ID, assignmentId: "a-1" }, v);
  assert.ok(p.ok);
  if (!p.ok) throw new Error("unreachable");
  return p.projection;
}

// ---------------------------------------------------------------------------
// Delegation acceptance -> bounded child assignment
// ---------------------------------------------------------------------------

test("an accepted delegation_response atomically creates a bounded child assignment, in the same command as the message", () => {
  const projection = bootstrap();

  const requested = run(
    projection,
    { type: "PostMessage", missionId: MISSION_ID, messageId: "req-1", senderParticipantId: "p-1", recipientParticipantIds: ["p-2"], assignmentId: "a-1", messageType: "delegation_request", body: "can you take the tests?", evidenceRefs: [], replyToMessageId: null },
    projection.aggregateVersion,
  );
  assert.ok(requested.ok);
  if (!requested.ok) return;

  const accepted = run(
    requested.projection,
    {
      type: "PostMessage",
      missionId: MISSION_ID,
      messageId: "resp-1",
      senderParticipantId: "p-2",
      recipientParticipantIds: ["p-1"],
      assignmentId: "a-1",
      messageType: "delegation_response",
      body: "sure",
      evidenceRefs: [],
      replyToMessageId: "req-1",
      structuredPayload: { accepted: true, childTitle: "Write tests", childObjective: "Cover the new path", allowedPaths: ["src/lib/"] },
    },
    requested.aggregateVersion,
  );
  assert.ok(accepted.ok, "accepting a delegation must succeed");
  if (!accepted.ok) return;

  const children = Object.values(accepted.projection.assignments).filter((a) => a.parentAssignmentId === "a-1");
  assert.equal(children.length, 1);
  const child = children[0];
  assert.equal(child.assigneeParticipantId, "p-2");
  assert.equal(child.delegatorParticipantId, "p-1");
  assert.equal(child.delegationDepth, 1);
  assert.equal(child.originatingMessageId, "resp-1");
  assert.deepEqual(child.scope.allowedPaths, ["src/lib/"]);
  assert.equal(child.status, "proposed");
});

test("a REJECTED delegation_response never creates a child assignment", () => {
  const projection = bootstrap();
  const requested = run(
    projection,
    { type: "PostMessage", missionId: MISSION_ID, messageId: "req-1", senderParticipantId: "p-1", recipientParticipantIds: ["p-2"], assignmentId: "a-1", messageType: "delegation_request", body: "help?", evidenceRefs: [], replyToMessageId: null },
    projection.aggregateVersion,
  );
  assert.ok(requested.ok);
  if (!requested.ok) return;

  const rejected = run(
    requested.projection,
    { type: "PostMessage", missionId: MISSION_ID, messageId: "resp-1", senderParticipantId: "p-2", recipientParticipantIds: ["p-1"], assignmentId: "a-1", messageType: "delegation_response", body: "can't help", evidenceRefs: [], replyToMessageId: "req-1", structuredPayload: { accepted: false } },
    requested.aggregateVersion,
  );
  assert.ok(rejected.ok);
  if (!rejected.ok) return;
  const children = Object.values(rejected.projection.assignments).filter((a) => a.parentAssignmentId === "a-1");
  assert.equal(children.length, 0);
});

test("a child assignment's scope cannot exceed the parent's — an over-broad delegation_response is refused before any assignment is created", () => {
  const projection = bootstrap();
  const requested = run(
    projection,
    { type: "PostMessage", missionId: MISSION_ID, messageId: "req-1", senderParticipantId: "p-1", recipientParticipantIds: ["p-2"], assignmentId: "a-1", messageType: "delegation_request", body: "help?", evidenceRefs: [], replyToMessageId: null },
    projection.aggregateVersion,
  );
  assert.ok(requested.ok);
  if (!requested.ok) return;

  const result = run(
    requested.projection,
    {
      type: "PostMessage",
      missionId: MISSION_ID,
      messageId: "resp-1",
      senderParticipantId: "p-2",
      recipientParticipantIds: ["p-1"],
      assignmentId: "a-1",
      messageType: "delegation_response",
      body: "sure",
      evidenceRefs: [],
      replyToMessageId: "req-1",
      structuredPayload: { accepted: true, allowedPaths: ["src/", "other-repo-area/"] }, // broader than parent's ["src/lib/"]... parent is actually ["src/"] here
    },
    requested.aggregateVersion,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "message_policy_violation");
    if (result.error.code === "message_policy_violation") assert.equal(result.error.violation.code, "delegation_scope_exceeds_parent");
  }
});

test("human_required delegation policy prevents an agent acceptance from materializing a child assignment", () => {
  const projection = bootstrap();
  const requested = run(
    projection,
    { type: "PostMessage", missionId: MISSION_ID, messageId: "req-policy-human", senderParticipantId: "p-1", recipientParticipantIds: ["p-2"], assignmentId: "a-1", messageType: "delegation_request", body: "help?", evidenceRefs: [], replyToMessageId: null },
    projection.aggregateVersion,
  );
  assert.ok(requested.ok);
  if (!requested.ok) return;

  const result = run(
    requested.projection,
    { type: "PostMessage", missionId: MISSION_ID, messageId: "resp-policy-human", senderParticipantId: "p-2", recipientParticipantIds: ["p-1"], assignmentId: "a-1", messageType: "delegation_response", body: "accepted", evidenceRefs: [], replyToMessageId: "req-policy-human", structuredPayload: { accepted: true, allowedPaths: ["src/lib/"] } },
    requested.aggregateVersion,
    { communicationPolicy: { allowBroadcast: false, maxDelegationDepth: 1, delegationApproval: { mode: "human_required" } } },
  );

  assert.equal(result.ok, false);
  if (!result.ok && result.error.code === "message_policy_violation") {
    assert.equal(result.error.violation.code, "delegation_approval_required");
  }
});

test("auto_within_scope delegation policy materializes only child scopes inside its configured boundary", () => {
  const projection = bootstrap();
  const requested = run(
    projection,
    { type: "PostMessage", missionId: MISSION_ID, messageId: "req-policy-auto", senderParticipantId: "p-1", recipientParticipantIds: ["p-2"], assignmentId: "a-1", messageType: "delegation_request", body: "help?", evidenceRefs: [], replyToMessageId: null },
    projection.aggregateVersion,
  );
  assert.ok(requested.ok);
  if (!requested.ok) return;

  const refused = run(
    requested.projection,
    { type: "PostMessage", missionId: MISSION_ID, messageId: "resp-policy-wide", senderParticipantId: "p-2", recipientParticipantIds: ["p-1"], assignmentId: "a-1", messageType: "delegation_response", body: "accepted", evidenceRefs: [], replyToMessageId: "req-policy-auto", structuredPayload: { accepted: true, allowedPaths: ["src/components/"] } },
    requested.aggregateVersion,
    { communicationPolicy: { allowBroadcast: false, maxDelegationDepth: 1, delegationApproval: { mode: "auto_within_scope", allowedPaths: ["src/lib/"] } } },
  );
  assert.equal(refused.ok, false);
  if (!refused.ok && refused.error.code === "message_policy_violation") {
    assert.equal(refused.error.violation.code, "delegation_scope_not_auto_approved");
  }

  const accepted = run(
    requested.projection,
    { type: "PostMessage", missionId: MISSION_ID, messageId: "resp-policy-narrow", senderParticipantId: "p-2", recipientParticipantIds: ["p-1"], assignmentId: "a-1", messageType: "delegation_response", body: "accepted", evidenceRefs: [], replyToMessageId: "req-policy-auto", structuredPayload: { accepted: true, allowedPaths: ["src/lib/mission/"] } },
    requested.aggregateVersion,
    { communicationPolicy: { allowBroadcast: false, maxDelegationDepth: 1, delegationApproval: { mode: "auto_within_scope", allowedPaths: ["src/lib/"] } } },
  );
  assert.ok(accepted.ok);
  if (accepted.ok) {
    const child = Object.values(accepted.projection.assignments).find((assignment) => assignment.originatingMessageId === "resp-policy-narrow");
    assert.deepEqual(child?.scope.allowedPaths, ["src/lib/mission/"]);
  }
});

test("duplicate delegation response (two accepted responses to the same request) is rejected, not double-applied", () => {
  const projection = bootstrap();
  const requested = run(
    projection,
    { type: "PostMessage", missionId: MISSION_ID, messageId: "req-1", senderParticipantId: "p-1", recipientParticipantIds: ["p-2"], assignmentId: "a-1", messageType: "delegation_request", body: "help?", evidenceRefs: [], replyToMessageId: null },
    projection.aggregateVersion,
  );
  assert.ok(requested.ok);
  if (!requested.ok) return;

  const first = run(
    requested.projection,
    { type: "PostMessage", missionId: MISSION_ID, messageId: "resp-1", senderParticipantId: "p-2", recipientParticipantIds: ["p-1"], assignmentId: "a-1", messageType: "delegation_response", body: "sure", evidenceRefs: [], replyToMessageId: "req-1", structuredPayload: { accepted: true } },
    requested.aggregateVersion,
  );
  assert.ok(first.ok);
  if (!first.ok) return;

  const second = run(
    first.projection,
    { type: "PostMessage", missionId: MISSION_ID, messageId: "resp-2", senderParticipantId: "p-2", recipientParticipantIds: ["p-1"], assignmentId: "a-1", messageType: "delegation_response", body: "sure again", evidenceRefs: [], replyToMessageId: "req-1", structuredPayload: { accepted: true } },
    first.aggregateVersion,
  );
  assert.equal(second.ok, false, "a second response to the same request must not create a second child");
  if (!second.ok) {
    assert.equal(second.error.code, "message_policy_violation");
    if (second.error.code === "message_policy_violation") assert.equal(second.error.violation.code, "duplicate_delegation_response");
  }
});

test("delegation against a terminal (cancelled) assignment is refused", () => {
  const projection = bootstrap();
  const requested = run(
    projection,
    { type: "PostMessage", missionId: MISSION_ID, messageId: "req-1", senderParticipantId: "p-1", recipientParticipantIds: ["p-2"], assignmentId: "a-1", messageType: "delegation_request", body: "help?", evidenceRefs: [], replyToMessageId: null },
    projection.aggregateVersion,
  );
  assert.ok(requested.ok);
  if (!requested.ok) return;

  const cancelled = run(requested.projection, { type: "CancelAssignment", missionId: MISSION_ID, assignmentId: "a-1", reason: { code: "x", summary: "s", relatedEntityIds: [], recoverable: false, suggestedActions: [] } }, requested.aggregateVersion);
  assert.ok(cancelled.ok);
  if (!cancelled.ok) return;

  const result = run(
    cancelled.projection,
    { type: "PostMessage", missionId: MISSION_ID, messageId: "resp-1", senderParticipantId: "p-2", recipientParticipantIds: ["p-1"], assignmentId: "a-1", messageType: "delegation_response", body: "sure", evidenceRefs: [], replyToMessageId: "req-1", structuredPayload: { accepted: true } },
    cancelled.aggregateVersion,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "message_policy_violation");
    if (result.error.code === "message_policy_violation") assert.equal(result.error.violation.code, "delegation_against_terminal_assignment");
  }
});

// ---------------------------------------------------------------------------
// Clarification: question / answer / waiting_for_input / resume
// ---------------------------------------------------------------------------

test("Phase 4D Part 4 §6: AskAssignmentQuestion atomically creates the question message AND transitions to waiting_for_input in one command; AnswerAssignmentQuestion atomically creates the answer AND resumes", () => {
  const projection = bootstrap();

  const waiting = run(
    projection,
    { type: "AskAssignmentQuestion", missionId: MISSION_ID, assignmentId: "a-1", messageId: "q-1", senderParticipantId: "p-1", recipientParticipantIds: ["p-2"], body: "which branch?", evidenceRefs: [] },
    projection.aggregateVersion,
  );
  assert.ok(waiting.ok);
  if (!waiting.ok) return;
  assert.equal(waiting.projection.assignments["a-1"].status, "waiting_for_input");
  assert.equal(waiting.projection.messages.some((m) => m.id === "q-1" && m.type === "question"), true, "the question message must exist — created by the SAME command, not a prior PostMessage");
  assert.deepEqual(waiting.projection.unansweredQuestionMessageIds, ["q-1"]);
  assert.equal(waiting.events.length, 2, "one command, one event batch: message_posted + assignment_status_changed, nothing else");

  const resumed = run(
    waiting.projection,
    { type: "AnswerAssignmentQuestion", missionId: MISSION_ID, assignmentId: "a-1", questionMessageId: "q-1", messageId: "a-msg-1", senderParticipantId: "p-2", recipientParticipantIds: ["p-1"], body: "main", evidenceRefs: [] },
    waiting.aggregateVersion,
  );
  assert.ok(resumed.ok);
  if (!resumed.ok) return;
  assert.equal(resumed.projection.assignments["a-1"].status, "running", "the assignment must resume to its prior valid state");
  assert.equal(resumed.projection.messages.some((m) => m.id === "a-msg-1" && m.type === "answer" && m.replyToMessageId === "q-1"), true);
  assert.deepEqual(resumed.projection.unansweredQuestionMessageIds, []);
  assert.equal(resumed.events.length, 2);
});

test("an unrelated messageId cannot resolve the wait — AnswerAssignmentQuestion refuses a questionMessageId that isn't a real question", () => {
  const projection = bootstrap();
  const waiting = run(
    projection,
    { type: "AskAssignmentQuestion", missionId: MISSION_ID, assignmentId: "a-1", messageId: "q-1", senderParticipantId: "p-1", recipientParticipantIds: ["p-2"], body: "which branch?", evidenceRefs: [] },
    projection.aggregateVersion,
  );
  assert.ok(waiting.ok);
  if (!waiting.ok) return;

  const unrelated = run(
    waiting.projection,
    { type: "PostMessage", missionId: MISSION_ID, messageId: "info-1", senderParticipantId: "p-2", recipientParticipantIds: ["p-1"], assignmentId: "a-1", messageType: "information", body: "unrelated update", evidenceRefs: [], replyToMessageId: null },
    waiting.aggregateVersion,
  );
  assert.ok(unrelated.ok);
  if (!unrelated.ok) return;

  // "info-1" is not a question at all — AnswerAssignmentQuestion must
  // refuse to treat it as one, whatever content it carries.
  const result = run(
    unrelated.projection,
    { type: "AnswerAssignmentQuestion", missionId: MISSION_ID, assignmentId: "a-1", questionMessageId: "info-1", messageId: "a-msg-1", senderParticipantId: "p-2", recipientParticipantIds: ["p-1"], body: "main", evidenceRefs: [] },
    unrelated.aggregateVersion,
  );
  assert.equal(result.ok, false, "an unrelated, non-question messageId must never resolve any wait");
  if (!result.ok) assert.equal(result.error.code, "question_not_found");
});

// ---------------------------------------------------------------------------
// Finding lifecycle
// ---------------------------------------------------------------------------

test("finding lifecycle: opened -> acknowledged -> remediation_requested -> remediation_submitted -> verified -> closed", () => {
  const projection = bootstrap();
  const noted = run(
    projection,
    { type: "PostMessage", missionId: MISSION_ID, messageId: "finding-msg-1", senderParticipantId: "p-2", recipientParticipantIds: ["p-1"], assignmentId: "a-1", messageType: "finding", body: "missing null check", evidenceRefs: [], replyToMessageId: null },
    projection.aggregateVersion,
  );
  assert.ok(noted.ok);
  if (!noted.ok) return;

  let result = run(noted.projection, { type: "OpenFinding", missionId: MISSION_ID, findingId: "f-1", assignmentId: "a-1", openedByParticipantId: "p-2", responsibleParticipantId: "p-1", statement: "missing null check", evidenceRefs: [], originatingMessageId: "finding-msg-1" }, noted.aggregateVersion);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.projection.findings["f-1"].status, "opened");
  assert.equal(result.projection.openFindingsCount, 1);
  let projection2 = result.projection;

  for (const nextStatus of ["acknowledged", "remediation_requested", "remediation_submitted", "verified"] as const) {
    result = run(projection2, { type: "TransitionFinding", missionId: MISSION_ID, findingId: "f-1", nextStatus }, projection2.aggregateVersion);
    assert.ok(result.ok, `expected transition to ${nextStatus} to succeed`);
    if (!result.ok) return;
    assert.equal(result.projection.findings["f-1"].status, nextStatus);
    projection2 = result.projection;
  }
  assert.equal(projection2.openFindingsCount, 1, "verified is still counted as open until closed");

  result = run(projection2, { type: "TransitionFinding", missionId: MISSION_ID, findingId: "f-1", nextStatus: "closed", resolutionEvidenceRefs: ["evidence://fix-commit"] }, projection2.aggregateVersion);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.projection.findings["f-1"].status, "closed");
  assert.equal(result.projection.openFindingsCount, 0);
  assert.deepEqual(result.projection.findings["f-1"].resolutionEvidenceRefs, ["evidence://fix-commit"]);
});

test("finding withdrawal closes it without ever implying assignment rejection", () => {
  const projection = bootstrap();
  const opened = run(projection, { type: "OpenFinding", missionId: MISSION_ID, findingId: "f-1", assignmentId: "a-1", openedByParticipantId: "p-2", responsibleParticipantId: "p-1", statement: "false alarm", evidenceRefs: [], originatingMessageId: "m-x" }, projection.aggregateVersion);
  assert.ok(opened.ok);
  if (!opened.ok) return;

  const withdrawn = run(opened.projection, { type: "TransitionFinding", missionId: MISSION_ID, findingId: "f-1", nextStatus: "withdrawn" }, opened.aggregateVersion);
  assert.ok(withdrawn.ok);
  if (!withdrawn.ok) return;
  assert.equal(withdrawn.projection.findings["f-1"].status, "withdrawn");
  assert.equal(withdrawn.projection.assignments["a-1"].status, "running", "a finding's own lifecycle never touches assignment status directly");
});

test("an unresolved (open) finding blocks VerifyAssignment(verified: true) — a finding is never equivalent to rejection, but it can gate verification per explicit policy", () => {
  const projection = bootstrap();
  const opened = run(projection, { type: "OpenFinding", missionId: MISSION_ID, findingId: "f-1", assignmentId: "a-1", openedByParticipantId: "p-2", responsibleParticipantId: "p-1", statement: "issue", evidenceRefs: [], originatingMessageId: "m-x" }, projection.aggregateVersion);
  assert.ok(opened.ok);
  if (!opened.ok) return;

  const submitted = run(opened.projection, { type: "SubmitAssignment", missionId: MISSION_ID, assignmentId: "a-1", evidenceRefs: [] }, opened.aggregateVersion);
  assert.ok(submitted.ok);
  if (!submitted.ok) return;

  const verifyAttempt = run(submitted.projection, { type: "VerifyAssignment", missionId: MISSION_ID, assignmentId: "a-1", verified: true }, submitted.aggregateVersion);
  assert.equal(verifyAttempt.ok, false, "an open finding must block a successful verification");
  if (!verifyAttempt.ok) assert.equal(verifyAttempt.error.code, "unresolved_findings_block_transition");

  // Verification failure (verified: false / rejection path) is NOT blocked by
  // open findings — the policy only gates the SUCCESS path.
  const rejectAttempt = run(submitted.projection, { type: "VerifyAssignment", missionId: MISSION_ID, assignmentId: "a-1", verified: false }, submitted.aggregateVersion);
  assert.equal(rejectAttempt.ok, true);

  // Close the finding, then verification succeeds.
  const closed = run(opened.projection, { type: "TransitionFinding", missionId: MISSION_ID, findingId: "f-1", nextStatus: "withdrawn" }, opened.aggregateVersion);
  assert.ok(closed.ok);
  if (!closed.ok) return;
  const submitted2 = run(closed.projection, { type: "SubmitAssignment", missionId: MISSION_ID, assignmentId: "a-1", evidenceRefs: [] }, closed.aggregateVersion);
  assert.ok(submitted2.ok);
  if (!submitted2.ok) return;
  const verifyAfterWithdrawal = run(submitted2.projection, { type: "VerifyAssignment", missionId: MISSION_ID, assignmentId: "a-1", verified: true }, submitted2.aggregateVersion);
  assert.equal(verifyAfterWithdrawal.ok, true, "once the finding is withdrawn, verification is no longer blocked");
});

// ---------------------------------------------------------------------------
// Deterministic replay / restart recovery, with the full Phase 4B feature set
// ---------------------------------------------------------------------------

test("deterministic replay: rebuilding from raw events after delegation + finding + clarification activity matches the live projection exactly", async () => {
  const { projectMission } = await import("../src/lib/mission/mission-projection.ts");
  const allEvents: import("../src/lib/mission/mission-events.ts").MissionEvent[] = [];

  function runTracked(current: MissionProjection | null, command: MissionCommand, expectedVersion: number) {
    const result = run(current, command, expectedVersion);
    assert.ok(result.ok);
    if (result.ok) allEvents.push(...result.events);
    return result;
  }

  let r = runTracked(null, { type: "CreateMission", missionId: MISSION_ID, workspaceId: "ws-1", repository: "acme/app", goal: "goal", mode: "solo" }, 0);
  assert.ok(r.ok);
  if (!r.ok) return;
  let projection = r.projection;

  for (const id of ["p-1", "p-2"]) {
    r = runTracked(projection, addParticipant(id), projection.aggregateVersion);
    assert.ok(r.ok);
    if (!r.ok) return;
    projection = r.projection;
    r = runTracked(projection, { type: "ActivateParticipant", missionId: MISSION_ID, participantId: id }, projection.aggregateVersion);
    assert.ok(r.ok);
    if (!r.ok) return;
    projection = r.projection;
  }

  r = runTracked(
    projection,
    { type: "CreateAssignment", missionId: MISSION_ID, assignmentId: "a-1", title: "t", objective: "o", scope: { allowedPaths: ["src/"], prohibitedPaths: ["src/secrets/"] }, dependencies: [], requiredEvidence: [], approvalPolicy: "auto", budget: { maxDurationMs: null, maxEstimatedTokens: null } },
    projection.aggregateVersion,
  );
  assert.ok(r.ok);
  if (!r.ok) return;
  projection = r.projection;

  r = runTracked(projection, { type: "AssignAssignment", missionId: MISSION_ID, assignmentId: "a-1", assigneeParticipantId: "p-1", dispatchKey: "primary" }, projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  projection = r.projection;

  r = runTracked(projection, { type: "StartAssignment", missionId: MISSION_ID, assignmentId: "a-1" }, projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  projection = r.projection;

  r = runTracked(
    projection,
    { type: "PostMessage", missionId: MISSION_ID, messageId: "req-1", senderParticipantId: "p-1", recipientParticipantIds: ["p-2"], assignmentId: "a-1", messageType: "delegation_request", body: "help?", evidenceRefs: [], replyToMessageId: null },
    projection.aggregateVersion,
  );
  assert.ok(r.ok);
  if (!r.ok) return;
  projection = r.projection;

  r = runTracked(
    projection,
    { type: "PostMessage", missionId: MISSION_ID, messageId: "resp-1", senderParticipantId: "p-2", recipientParticipantIds: ["p-1"], assignmentId: "a-1", messageType: "delegation_response", body: "sure", evidenceRefs: [], replyToMessageId: "req-1", structuredPayload: { accepted: true } },
    projection.aggregateVersion,
  );
  assert.ok(r.ok);
  if (!r.ok) return;
  projection = r.projection;

  r = runTracked(projection, { type: "OpenFinding", missionId: MISSION_ID, findingId: "f-1", assignmentId: "a-1", openedByParticipantId: "p-2", responsibleParticipantId: "p-1", statement: "issue", evidenceRefs: [], originatingMessageId: "resp-1" }, projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  projection = r.projection;

  const fromScratch = projectMission(MISSION_ID, allEvents);
  assert.deepEqual(fromScratch, projection, "a Runtime restarted from durable events alone, after delegation + finding activity, must reach byte-identical state");
});
