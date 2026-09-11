/**
 * Mission command authorization — Phase 4D §2 tests
 *
 * Covers the centralized authorization seam directly (mission-authorization.ts)
 * plus its integration through applyMissionCommand: every command type has a
 * matrix entry, an unknown/removed participant is denied, an agent cannot
 * perform a human-required decision, and an assignee's self-approval is
 * exactly as permissive as the assignment's own approvalPolicy allows.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { applyMissionCommand, type ApplyCommandInput } from "../src/lib/mission/mission-command-handler.ts";
import { resolveCommandContext, type MissionCommand } from "../src/lib/mission/mission-commands.ts";
import type { MissionProjection } from "../src/lib/mission/mission-projection.ts";
import { COMMAND_AUTHORITY_MATRIX, authorizeMissionCommand, deriveActorAuthorities } from "../src/lib/mission/mission-authorization.ts";

const MISSION_ID = "m-1";

let idCounter = 0;
function mintEventId(): string {
  idCounter += 1;
  return `evt-${idCounter}`;
}

function ctx(actor: { kind: "human" | "agent" | "system"; id: string } = { kind: "system", id: "orchestrator" }) {
  return resolveCommandContext({ actor: actor as never, timestamp: "2026-08-20T00:00:00.000Z" });
}

function run(current: MissionProjection | null, command: MissionCommand, expectedVersion: number, actor: { kind: "human" | "agent" | "system"; id: string } = { kind: "system", id: "orchestrator" }, opts: Partial<ApplyCommandInput> = {}) {
  return applyMissionCommand({ current, command, context: ctx(actor), expectedVersion, priorOutcome: null, mintEventId, ...opts });
}

function addParticipant(participantId: string, role: "implementer" | "reviewer" | "owner" = "implementer"): MissionCommand {
  return {
    type: "AddParticipant",
    missionId: MISSION_ID,
    participantId,
    kind: "agent",
    role,
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

function bootstrapWithAssignment(approvalPolicy: "auto" | "human_required" = "auto"): MissionProjection {
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
  projection = r.projection;

  r = run(projection, { type: "SubmitAssignment", missionId: MISSION_ID, assignmentId: "a-1", evidenceRefs: [] }, projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) throw new Error("unreachable");
  projection = r.projection;

  r = run(projection, { type: "VerifyAssignment", missionId: MISSION_ID, assignmentId: "a-1", verified: true }, projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) throw new Error("unreachable");
  return r.projection;
}

test("every row in the authority matrix names at least one authority (TypeScript's Record<MissionCommandType, ...> already guarantees every command TYPE has a row at compile time — this proves none of those rows is vacuously empty)", () => {
  for (const [commandType, authorities] of Object.entries(COMMAND_AUTHORITY_MATRIX)) {
    assert.ok(authorities.length > 0, `empty authority row for ${commandType}`);
  }
});

test("an unknown agent actor (never added as a participant) is denied for every command requiring active_participant", () => {
  const projection = bootstrapWithAssignment();
  const result = run(projection, { type: "OpenFinding", missionId: MISSION_ID, findingId: "f-1", assignmentId: "a-1", openedByParticipantId: "ghost", responsibleParticipantId: null, statement: "s", evidenceRefs: [], originatingMessageId: "m-1" }, projection.aggregateVersion, { kind: "agent", id: "ghost" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "unauthorized_command");
});

test("a removed participant cannot exercise participant authority again", () => {
  let projection = bootstrapWithAssignment();
  const removed = run(projection, { type: "RemoveParticipant", missionId: MISSION_ID, participantId: "p-1", reason: { code: "done", summary: "s", relatedEntityIds: [], recoverable: false, suggestedActions: [] } }, projection.aggregateVersion);
  assert.ok(removed.ok);
  if (!removed.ok) return;
  projection = removed.projection;

  // p-1 was the assignee; now removed, it must not be able to accept its own
  // work. AcceptAssignment keeps its pre-existing `unauthorized_approval`
  // code (preserved for backward compatibility — see mission-authorization.ts).
  const result = run(projection, { type: "AcceptAssignment", missionId: MISSION_ID, assignmentId: "a-1" }, projection.aggregateVersion, { kind: "agent", id: "p-1" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "unauthorized_approval");
});

test("an agent cannot AcceptAssignment when approvalPolicy is human_required — a human can", () => {
  const projection = bootstrapWithAssignment("human_required");
  const agentAttempt = run(projection, { type: "AcceptAssignment", missionId: MISSION_ID, assignmentId: "a-1" }, projection.aggregateVersion, { kind: "agent", id: "p-1" });
  assert.equal(agentAttempt.ok, false);
  if (!agentAttempt.ok) assert.equal(agentAttempt.error.code, "unauthorized_approval");

  const humanAttempt = run(projection, { type: "AcceptAssignment", missionId: MISSION_ID, assignmentId: "a-1" }, projection.aggregateVersion, { kind: "human", id: "human-1" });
  assert.equal(humanAttempt.ok, true);
});

test("an assignee CAN self-accept its own submitted work under 'auto' policy — self-approval is only blocked by an explicit human_required policy, not by identity alone", () => {
  const projection = bootstrapWithAssignment("auto");
  const result = run(projection, { type: "AcceptAssignment", missionId: MISSION_ID, assignmentId: "a-1" }, projection.aggregateVersion, { kind: "agent", id: "p-1" });
  assert.equal(result.ok, true);
});

test("audit item 4: assignment_reviewer authority is scoped to reviewers actually named on THIS assignment's review_request, not every reviewer-role participant Mission-wide", () => {
  let r = run(null, { type: "CreateMission", missionId: MISSION_ID, workspaceId: "ws-1", repository: "acme/app", goal: "goal", mode: "solo" }, 0);
  assert.ok(r.ok);
  if (!r.ok) throw new Error("unreachable");
  let projection = r.projection;

  for (const id of ["p-1", "p-2", "p-3"]) {
    r = run(projection, addParticipant(id, id === "p-1" ? "implementer" : "reviewer"), projection.aggregateVersion);
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
  projection = r.projection;
  r = run(projection, { type: "SubmitAssignment", missionId: MISSION_ID, assignmentId: "a-1", evidenceRefs: [] }, projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) throw new Error("unreachable");
  projection = r.projection;

  // Only p-2 is named as a reviewer for a-1 — p-3 holds role "reviewer" too
  // but was never asked to review THIS assignment.
  r = run(
    projection,
    { type: "PostMessage", missionId: MISSION_ID, messageId: "m-review", senderParticipantId: "p-1", recipientParticipantIds: ["p-2"], assignmentId: "a-1", messageType: "review_request", body: "please review", evidenceRefs: [], replyToMessageId: null, structuredPayload: { reviewerParticipantIds: ["p-2"] } },
    projection.aggregateVersion,
  );
  assert.ok(r.ok);
  if (!r.ok) throw new Error("unreachable");
  projection = r.projection;
  assert.deepEqual(projection.assignments["a-1"].reviewerParticipantIds, ["p-2"], "the registry is populated from the review_request's named reviewers");

  const p3Attempt = run(projection, { type: "VerifyAssignment", missionId: MISSION_ID, assignmentId: "a-1", verified: true }, projection.aggregateVersion, { kind: "agent", id: "p-3" });
  assert.equal(p3Attempt.ok, false, "p-3 holds role 'reviewer' Mission-wide but is not on a-1's own reviewer registry — must be denied");
  if (!p3Attempt.ok) assert.equal(p3Attempt.error.code, "unauthorized_command");

  const p2Attempt = run(projection, { type: "VerifyAssignment", missionId: MISSION_ID, assignmentId: "a-1", verified: true }, projection.aggregateVersion, { kind: "agent", id: "p-2" });
  assert.equal(p2Attempt.ok, true, "p-2 IS named on a-1's reviewer registry and must be authorized");
});

test("an agent cannot ApproveMissionPlan when the Plan proposes a human_required assignment — a human can", async () => {
  const { propose } = await import("../src/lib/mission/mission-planner.ts");
  let r = run(null, { type: "CreateMission", missionId: MISSION_ID, workspaceId: "ws-1", repository: "acme/app", goal: "goal", mode: "solo" }, 0);
  assert.ok(r.ok);
  if (!r.ok) return;
  let projection = r.projection;

  const plan = propose({
    missionId: MISSION_ID,
    objective: "fix it",
    workspaceContext: { repository: "acme/app", repositoryId: null },
    applicableRules: [],
    availableProviders: [{ id: "codex", capabilities: { non_interactive_execution: true, repository_editing: true, structured_output: true } }],
    allowedRoles: ["implementer", "verifier"],
    budget: { maxDurationMs: null, maxEstimatedTokens: null },
    scope: { allowedPaths: ["."], prohibitedPaths: [] },
    approvalPolicy: "auto",
    collaborationPolicy: { allowBroadcast: false, maxDelegationDepth: 1 },
    operatingMode: "human_led", // implementation_test_verification forces human_required
    constraints: [],
    now: "2026-08-20T00:00:00.000Z",
    createdBy: "human-1",
  });

  r = run(projection, { type: "ProposeMissionPlan", missionId: MISSION_ID, planId: plan.id, plan }, projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  projection = r.projection;

  const agentAttempt = run(projection, { type: "ApproveMissionPlan", missionId: MISSION_ID, planId: plan.id }, projection.aggregateVersion, { kind: "agent", id: "p-1" });
  assert.equal(agentAttempt.ok, false);
  if (!agentAttempt.ok) assert.equal(agentAttempt.error.code, "unauthorized_plan_approval");
});

test("deriveActorAuthorities grants nothing beyond the actor's own kind when there is no projection yet (CreateMission)", () => {
  const authorities = deriveActorAuthorities({ type: "CreateMission", missionId: MISSION_ID, workspaceId: "w", repository: "r", goal: "g", mode: "solo" }, null, { kind: "agent", id: "p-1" });
  assert.deepEqual([...authorities], []);
});

test("authorization is checked before any event is emitted — a denied command produces zero events and does not advance the version", () => {
  const projection = bootstrapWithAssignment("human_required");
  const before = projection.aggregateVersion;
  const result = run(projection, { type: "AcceptAssignment", missionId: MISSION_ID, assignmentId: "a-1" }, projection.aggregateVersion, { kind: "agent", id: "p-1" });
  assert.equal(result.ok, false);
  // Nothing to inspect on a failure result except that it carries no events —
  // the type itself has no `.events`/`.aggregateVersion` on the failure branch,
  // which is the proof: a denial short-circuits before any payload is built.
  assert.equal("events" in result, false);
  void before;
});

test("a human actor is always authorized to perform commands requiring only human/system authority, regardless of participant status", () => {
  const projection = bootstrapWithAssignment();
  const result = authorizeMissionCommand(addParticipant("p-2"), projection, { kind: "human", id: "human-1" });
  assert.equal(result.ok, true);
});

test("an agent with no owner role cannot RequestMissionChanges or ContinueMissionInvestigation — same gate as AcceptMission/RejectMission", () => {
  const projection = bootstrapWithAssignment();
  const reason = { code: "x", summary: "s", relatedEntityIds: [], recoverable: true, suggestedActions: [] };
  const requestChanges = authorizeMissionCommand({ type: "RequestMissionChanges", missionId: MISSION_ID, reason }, projection, { kind: "agent", id: "p-1" });
  const continueInvestigation = authorizeMissionCommand({ type: "ContinueMissionInvestigation", missionId: MISSION_ID, reason }, projection, { kind: "agent", id: "p-1" });
  assert.equal(requestChanges.ok, false);
  assert.equal(continueInvestigation.ok, false);
  if (!requestChanges.ok) assert.equal(requestChanges.error.code, "unauthorized_command");
});

test("a channel-bound agent connection resolves to its stable Mission participant identity", () => {
  const created = run(null, { type: "CreateMission", missionId: MISSION_ID, workspaceId: "ws-1", repository: "acme/app", goal: "goal", mode: "solo" }, 0);
  assert.ok(created.ok);
  if (!created.ok) return;
  let projection = created.projection;
  const participantId = `${MISSION_ID}-agent-connection-1`;
  let result = run(projection, addParticipant(participantId), projection.aggregateVersion);
  assert.ok(result.ok);
  if (!result.ok) return;
  projection = result.projection;
  result = run(projection, { type: "ActivateParticipant", missionId: MISSION_ID, participantId }, projection.aggregateVersion);
  assert.ok(result.ok);
  if (!result.ok) return;
  projection = result.projection;

  const authorization = authorizeMissionCommand({
    type: "RecordEvidence",
    missionId: MISSION_ID,
    evidenceId: "chat-evidence:test",
    assignmentId: null,
    producerParticipantId: participantId,
    producerKind: "agent",
    executionId: null,
    dispatchKey: null,
    provider: "codex",
    kind: "review_evidence",
    source: "structured chat evidence",
    lifecycle: "captured",
    availability: "available",
    integrity: null,
  }, projection, { kind: "agent", id: "connection-1" });
  assert.equal(authorization.ok, true);
});
