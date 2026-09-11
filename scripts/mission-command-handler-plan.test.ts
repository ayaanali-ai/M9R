/**
 * Mission command handler — Phase 5A Plan command integration tests
 *
 * Exercises Propose -> Validate -> Approve -> Materialize (and Reject /
 * Supersede) through the SAME `applyMissionCommand` seam every other
 * command goes through — not just the pure planner/validator/simulator in
 * isolation. Covers the human_required Plan-approval authorization gate and
 * idempotent/retry-safe materialization.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { applyMissionCommand } from "../src/lib/mission/mission-command-handler.ts";
import { resolveCommandContext, type MissionCommand } from "../src/lib/mission/mission-commands.ts";
import type { MissionProjection } from "../src/lib/mission/mission-projection.ts";
import { propose, type PlannerInput, type PlannerProviderDescriptor } from "../src/lib/mission/mission-planner.ts";
import type { PlanValidationContext } from "../src/lib/mission/mission-planner-validator.ts";

const MISSION_ID = "m-1";
const SYSTEM_ACTOR = { kind: "system" as const, id: "orchestrator" as const };
const HUMAN_ACTOR = { kind: "human" as const, id: "human-1" as const };

let idCounter = 0;
function mintEventId(): string {
  idCounter += 1;
  return `evt-${idCounter}`;
}

function ctx(actor: typeof SYSTEM_ACTOR | typeof HUMAN_ACTOR = SYSTEM_ACTOR) {
  return resolveCommandContext({ actor, timestamp: "2026-08-01T00:00:00.000Z" });
}

function run(current: MissionProjection | null, command: MissionCommand, expectedVersion: number, actor: typeof SYSTEM_ACTOR | typeof HUMAN_ACTOR = SYSTEM_ACTOR) {
  return applyMissionCommand({ current, command, context: ctx(actor), expectedVersion, priorOutcome: null, mintEventId });
}

function fullyCapableProvider(id: string): PlannerProviderDescriptor {
  return {
    id,
    capabilities: {
      non_interactive_execution: true,
      interactive_session: false,
      structured_output: true,
      streaming_output: true,
      cancellation: false,
      session_resume: false,
      usage_reporting: true,
      tool_event_reporting: true,
      approval_requests: false,
      image_input: false,
      repository_editing: true,
    },
  };
}

function plannerInput(overrides: Partial<PlannerInput> = {}): PlannerInput {
  return {
    missionId: MISSION_ID,
    objective: "Fix the flaky test",
    workspaceContext: { repository: "acme/app", repositoryId: null },
    applicableRules: [],
    availableProviders: [fullyCapableProvider("codex")],
    allowedRoles: ["implementer", "reviewer", "verifier"],
    budget: { maxDurationMs: 10 * 60_000, maxEstimatedTokens: 100_000 },
    scope: { allowedPaths: ["."], prohibitedPaths: [] },
    approvalPolicy: "auto",
    collaborationPolicy: { allowBroadcast: false, maxDelegationDepth: 1 },
    operatingMode: "solo",
    constraints: [],
    now: "2026-08-01T00:00:00.000Z",
    createdBy: "human-1",
    ...overrides,
  };
}

function validationContext(overrides: Partial<PlanValidationContext> = {}): PlanValidationContext {
  return {
    missionScope: { allowedPaths: ["."], prohibitedPaths: [] },
    missionBudget: { maxDurationMs: 10 * 60_000, maxEstimatedTokens: 100_000 },
    availableApprovalAuthorities: ["human"],
    ...overrides,
  };
}

function bootstrapMission(): MissionProjection {
  const created = run(null, { type: "CreateMission", missionId: MISSION_ID, workspaceId: "ws-1", repository: "acme/app", goal: "goal", mode: "solo" }, 0);
  assert.ok(created.ok);
  if (!created.ok) throw new Error("unreachable");
  return created.projection;
}

test("full lifecycle: Propose -> Validate -> Approve -> Materialize creates the proposed participant and assignment", () => {
  let projection = bootstrapMission();
  const plan = propose(plannerInput());

  const proposed = run(projection, { type: "ProposeMissionPlan", missionId: MISSION_ID, planId: plan.id, plan }, projection.aggregateVersion);
  assert.ok(proposed.ok);
  if (!proposed.ok) throw new Error("unreachable");
  projection = proposed.projection;
  assert.equal(projection.planProposals[plan.id].status, "draft");

  const validated = run(projection, { type: "ValidateMissionPlan", missionId: MISSION_ID, planId: plan.id, context: validationContext() }, projection.aggregateVersion);
  assert.ok(validated.ok);
  if (!validated.ok) throw new Error("unreachable");
  projection = validated.projection;
  assert.equal(projection.planProposals[plan.id].status, "valid");

  const approved = run(projection, { type: "ApproveMissionPlan", missionId: MISSION_ID, planId: plan.id }, projection.aggregateVersion);
  assert.ok(approved.ok);
  if (!approved.ok) throw new Error("unreachable");
  projection = approved.projection;
  assert.equal(projection.planProposals[plan.id].status, "approved");

  const materialized = run(projection, { type: "MaterializeMissionPlan", missionId: MISSION_ID, planId: plan.id }, projection.aggregateVersion);
  assert.ok(materialized.ok);
  if (!materialized.ok) throw new Error("unreachable");
  projection = materialized.projection;

  assert.equal(projection.planProposals[plan.id].status, "active");
  const participantId = plan.participantProposals[0].proposedParticipantId;
  const assignmentId = plan.assignmentProposals[0].proposedAssignmentId;
  assert.ok(projection.participants[participantId], "materialization creates the real participant under the SAME id proposed");
  assert.ok(projection.assignments[assignmentId], "materialization creates the real assignment under the SAME id proposed");
  assert.equal(projection.assignments[assignmentId].assigneeParticipantId, participantId);
});

test("ValidateMissionPlan against an invalid Plan (unresolved provider) records validationErrors and marks it invalid, never approved", () => {
  let projection = bootstrapMission();
  const plan = propose(plannerInput({ availableProviders: [] })); // no provider resolves -> invalid

  const proposed = run(projection, { type: "ProposeMissionPlan", missionId: MISSION_ID, planId: plan.id, plan }, projection.aggregateVersion);
  assert.ok(proposed.ok);
  if (!proposed.ok) throw new Error("unreachable");
  projection = proposed.projection;

  const validated = run(projection, { type: "ValidateMissionPlan", missionId: MISSION_ID, planId: plan.id, context: validationContext() }, projection.aggregateVersion);
  assert.ok(validated.ok);
  if (!validated.ok) throw new Error("unreachable");
  projection = validated.projection;
  assert.equal(projection.planProposals[plan.id].status, "invalid");
  assert.ok(projection.planProposals[plan.id].validationErrors.length > 0);

  const approveAttempt = run(projection, { type: "ApproveMissionPlan", missionId: MISSION_ID, planId: plan.id }, projection.aggregateVersion);
  assert.equal(approveAttempt.ok, false);
  if (!approveAttempt.ok) assert.equal(approveAttempt.error.code, "invalid_plan_transition");
});

test("ProposeMissionPlan refuses a duplicate planId", () => {
  let projection = bootstrapMission();
  const plan = propose(plannerInput());
  const first = run(projection, { type: "ProposeMissionPlan", missionId: MISSION_ID, planId: plan.id, plan }, projection.aggregateVersion);
  assert.ok(first.ok);
  if (!first.ok) throw new Error("unreachable");
  projection = first.projection;

  const second = run(projection, { type: "ProposeMissionPlan", missionId: MISSION_ID, planId: plan.id, plan }, projection.aggregateVersion);
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.error.code, "plan_already_exists");
});

test("a human_required Plan (implementation_test_verification) cannot be approved by an agent actor", () => {
  let projection = bootstrapMission();
  const plan = propose(plannerInput({ procedure: "implementation_test_verification" }));

  const proposed = run(projection, { type: "ProposeMissionPlan", missionId: MISSION_ID, planId: plan.id, plan }, projection.aggregateVersion);
  assert.ok(proposed.ok);
  if (!proposed.ok) throw new Error("unreachable");
  projection = proposed.projection;

  const validated = run(projection, { type: "ValidateMissionPlan", missionId: MISSION_ID, planId: plan.id, context: validationContext() }, projection.aggregateVersion);
  assert.ok(validated.ok);
  if (!validated.ok) throw new Error("unreachable");
  projection = validated.projection;
  assert.equal(projection.planProposals[plan.id].status, "valid");

  const agentApproval = run(projection, { type: "ApproveMissionPlan", missionId: MISSION_ID, planId: plan.id }, projection.aggregateVersion, SYSTEM_ACTOR);
  assert.equal(agentApproval.ok, false);
  if (!agentApproval.ok) assert.equal(agentApproval.error.code, "unauthorized_plan_approval");

  const humanApproval = run(projection, { type: "ApproveMissionPlan", missionId: MISSION_ID, planId: plan.id }, projection.aggregateVersion, HUMAN_ACTOR);
  assert.ok(humanApproval.ok, "a human actor CAN approve a human_required Plan");
});

test("RejectMissionPlan moves a draft Plan to the terminal rejected status", () => {
  let projection = bootstrapMission();
  const plan = propose(plannerInput());
  const proposed = run(projection, { type: "ProposeMissionPlan", missionId: MISSION_ID, planId: plan.id, plan }, projection.aggregateVersion);
  assert.ok(proposed.ok);
  if (!proposed.ok) throw new Error("unreachable");
  projection = proposed.projection;

  const rejected = run(projection, { type: "RejectMissionPlan", missionId: MISSION_ID, planId: plan.id, reason: { code: "not_needed", summary: "s", relatedEntityIds: [], recoverable: false, suggestedActions: [] } }, projection.aggregateVersion);
  assert.ok(rejected.ok);
  if (!rejected.ok) throw new Error("unreachable");
  assert.equal(rejected.projection.planProposals[plan.id].status, "rejected");

  const secondRejectAttempt = run(rejected.projection, { type: "RejectMissionPlan", missionId: MISSION_ID, planId: plan.id, reason: { code: "not_needed", summary: "s", relatedEntityIds: [], recoverable: false, suggestedActions: [] } }, rejected.aggregateVersion);
  assert.equal(secondRejectAttempt.ok, false, "a terminal (rejected) Plan can never transition again");
});

test("SupersedeMissionPlan: an approved-unmaterialized Plan can be superseded by a new version, old Plan becomes superseded and immutable", () => {
  let projection = bootstrapMission();
  const planV1 = propose(plannerInput());
  let step = run(projection, { type: "ProposeMissionPlan", missionId: MISSION_ID, planId: planV1.id, plan: planV1 }, projection.aggregateVersion);
  assert.ok(step.ok);
  if (!step.ok) throw new Error("unreachable");
  projection = step.projection;

  step = run(projection, { type: "ValidateMissionPlan", missionId: MISSION_ID, planId: planV1.id, context: validationContext() }, projection.aggregateVersion);
  assert.ok(step.ok);
  if (!step.ok) throw new Error("unreachable");
  projection = step.projection;

  step = run(projection, { type: "ApproveMissionPlan", missionId: MISSION_ID, planId: planV1.id }, projection.aggregateVersion);
  assert.ok(step.ok);
  if (!step.ok) throw new Error("unreachable");
  projection = step.projection;

  const planV2 = propose(plannerInput({ version: 2, supersedesPlanId: planV1.id }));
  const superseded = run(projection, { type: "SupersedeMissionPlan", missionId: MISSION_ID, planId: planV1.id, newPlan: planV2 }, projection.aggregateVersion);
  assert.ok(superseded.ok);
  if (!superseded.ok) throw new Error("unreachable");
  projection = superseded.projection;

  assert.equal(projection.planProposals[planV1.id].status, "superseded");
  assert.equal(projection.planProposals[planV2.id].status, "draft");
  assert.equal(projection.planProposals[planV2.id].supersedesPlanId, planV1.id);

  // An already-terminal (superseded) Plan can never be superseded again.
  const planV3 = propose(plannerInput({ version: 3 }));
  const secondSupersede = run(projection, { type: "SupersedeMissionPlan", missionId: MISSION_ID, planId: planV1.id, newPlan: planV3 }, projection.aggregateVersion);
  assert.equal(secondSupersede.ok, false);
});

test("audit item 3: SupersedeMissionPlan from 'active' is now allowed and cancels the in-flight assignment(s) it materialized, atomically", () => {
  let projection = bootstrapMission();
  const planV1 = propose(plannerInput());
  let step = run(projection, { type: "ProposeMissionPlan", missionId: MISSION_ID, planId: planV1.id, plan: planV1 }, projection.aggregateVersion);
  assert.ok(step.ok);
  if (!step.ok) throw new Error("unreachable");
  projection = step.projection;

  step = run(projection, { type: "ValidateMissionPlan", missionId: MISSION_ID, planId: planV1.id, context: validationContext() }, projection.aggregateVersion);
  assert.ok(step.ok);
  if (!step.ok) throw new Error("unreachable");
  projection = step.projection;

  step = run(projection, { type: "ApproveMissionPlan", missionId: MISSION_ID, planId: planV1.id }, projection.aggregateVersion);
  assert.ok(step.ok);
  if (!step.ok) throw new Error("unreachable");
  projection = step.projection;

  step = run(projection, { type: "MaterializeMissionPlan", missionId: MISSION_ID, planId: planV1.id }, projection.aggregateVersion);
  assert.ok(step.ok);
  if (!step.ok) throw new Error("unreachable");
  projection = step.projection;
  assert.equal(projection.planProposals[planV1.id].status, "active");

  const assignmentId = planV1.assignmentProposals[0].proposedAssignmentId;
  assert.equal(projection.assignments[assignmentId].status, "proposed", "materialization leaves the assignment 'proposed' — still in a cancellable state");

  // Previously refused outright: TERMINAL_PLAN_STATUSES includes "active",
  // so validatePlanTransition short-circuited before the table was even
  // consulted. Now explicitly allowed, ONLY through this command's own
  // reconciliation step (mission-command-handler.ts's SupersedeMissionPlan
  // case) — the generic terminal guard is untouched for every other
  // command.
  const planV2 = propose(plannerInput({ version: 2, supersedesPlanId: planV1.id }));
  const superseded = run(projection, { type: "SupersedeMissionPlan", missionId: MISSION_ID, planId: planV1.id, newPlan: planV2 }, projection.aggregateVersion);
  assert.ok(superseded.ok, "superseding an active Plan is now allowed");
  if (!superseded.ok) throw new Error("unreachable");
  projection = superseded.projection;

  assert.equal(projection.planProposals[planV1.id].status, "superseded");
  assert.equal(projection.planProposals[planV2.id].status, "draft");
  assert.equal(
    projection.assignments[assignmentId].status,
    "cancelled",
    "the reconciliation policy: an in-flight assignment this active Plan materialized is cancelled in the SAME event batch as the supersession",
  );
});

test("audit item 3: an assignment already past the cancellable window (e.g. 'submitted') is left untouched by supersession reconciliation", () => {
  let projection = bootstrapMission();
  const plan = propose(plannerInput());
  let step = run(projection, { type: "ProposeMissionPlan", missionId: MISSION_ID, planId: plan.id, plan }, projection.aggregateVersion);
  assert.ok(step.ok);
  if (!step.ok) throw new Error("unreachable");
  projection = step.projection;
  step = run(projection, { type: "ValidateMissionPlan", missionId: MISSION_ID, planId: plan.id, context: validationContext() }, projection.aggregateVersion);
  assert.ok(step.ok);
  if (!step.ok) throw new Error("unreachable");
  projection = step.projection;
  step = run(projection, { type: "ApproveMissionPlan", missionId: MISSION_ID, planId: plan.id }, projection.aggregateVersion);
  assert.ok(step.ok);
  if (!step.ok) throw new Error("unreachable");
  projection = step.projection;
  step = run(projection, { type: "MaterializeMissionPlan", missionId: MISSION_ID, planId: plan.id }, projection.aggregateVersion);
  assert.ok(step.ok);
  if (!step.ok) throw new Error("unreachable");
  projection = step.projection;

  const assignmentId = plan.assignmentProposals[0].proposedAssignmentId;
  const participantId = plan.participantProposals[0].proposedParticipantId;

  step = run(projection, { type: "ActivateParticipant", missionId: MISSION_ID, participantId }, projection.aggregateVersion);
  assert.ok(step.ok);
  if (!step.ok) throw new Error("unreachable");
  projection = step.projection;
  step = run(projection, { type: "AssignAssignment", missionId: MISSION_ID, assignmentId, assigneeParticipantId: participantId, dispatchKey: "dk-1" }, projection.aggregateVersion);
  assert.ok(step.ok);
  if (!step.ok) throw new Error("unreachable");
  projection = step.projection;
  step = run(projection, { type: "StartAssignment", missionId: MISSION_ID, assignmentId }, projection.aggregateVersion);
  assert.ok(step.ok);
  if (!step.ok) throw new Error("unreachable");
  projection = step.projection;
  step = run(projection, { type: "SubmitAssignment", missionId: MISSION_ID, assignmentId, evidenceRefs: [] }, projection.aggregateVersion);
  assert.ok(step.ok);
  if (!step.ok) throw new Error("unreachable");
  projection = step.projection;
  assert.equal(projection.assignments[assignmentId].status, "submitted");

  const planV2 = propose(plannerInput({ version: 2, supersedesPlanId: plan.id }));
  const superseded = run(projection, { type: "SupersedeMissionPlan", missionId: MISSION_ID, planId: plan.id, newPlan: planV2 }, projection.aggregateVersion);
  assert.ok(superseded.ok);
  if (!superseded.ok) throw new Error("unreachable");
  assert.equal(
    superseded.projection.assignments[assignmentId].status,
    "submitted",
    "'submitted' has no legal transition to 'cancelled' in ASSIGNMENT_TRANSITIONS — left for human review rather than forcing an invalid transition",
  );
});

test("MaterializeMissionPlan is idempotent: a second call after the Plan is already active is a true no-op, never duplicating participants or assignments", () => {
  let projection = bootstrapMission();
  const plan = propose(plannerInput());
  let step = run(projection, { type: "ProposeMissionPlan", missionId: MISSION_ID, planId: plan.id, plan }, projection.aggregateVersion);
  assert.ok(step.ok);
  if (!step.ok) throw new Error("unreachable");
  projection = step.projection;
  step = run(projection, { type: "ValidateMissionPlan", missionId: MISSION_ID, planId: plan.id, context: validationContext() }, projection.aggregateVersion);
  assert.ok(step.ok);
  if (!step.ok) throw new Error("unreachable");
  projection = step.projection;
  step = run(projection, { type: "ApproveMissionPlan", missionId: MISSION_ID, planId: plan.id }, projection.aggregateVersion);
  assert.ok(step.ok);
  if (!step.ok) throw new Error("unreachable");
  projection = step.projection;
  step = run(projection, { type: "MaterializeMissionPlan", missionId: MISSION_ID, planId: plan.id }, projection.aggregateVersion);
  assert.ok(step.ok);
  if (!step.ok) throw new Error("unreachable");
  projection = step.projection;

  const versionBefore = projection.aggregateVersion;
  const participantCountBefore = Object.keys(projection.participants).length;
  const assignmentCountBefore = Object.keys(projection.assignments).length;

  const retry = run(projection, { type: "MaterializeMissionPlan", missionId: MISSION_ID, planId: plan.id }, projection.aggregateVersion);
  assert.ok(retry.ok);
  if (!retry.ok) throw new Error("unreachable");
  assert.equal(retry.events.length, 0, "an already-active Plan's re-materialization emits no events at all");
  assert.equal(retry.aggregateVersion, versionBefore);
  assert.equal(Object.keys(retry.projection.participants).length, participantCountBefore);
  assert.equal(Object.keys(retry.projection.assignments).length, assignmentCountBefore);
});

test("MaterializeMissionPlan refuses a Plan that was never approved", () => {
  let projection = bootstrapMission();
  const plan = propose(plannerInput());
  const proposed = run(projection, { type: "ProposeMissionPlan", missionId: MISSION_ID, planId: plan.id, plan }, projection.aggregateVersion);
  assert.ok(proposed.ok);
  if (!proposed.ok) throw new Error("unreachable");
  projection = proposed.projection;

  const materializeAttempt = run(projection, { type: "MaterializeMissionPlan", missionId: MISSION_ID, planId: plan.id }, projection.aggregateVersion);
  assert.equal(materializeAttempt.ok, false);
  if (!materializeAttempt.ok) assert.equal(materializeAttempt.error.code, "plan_not_materializable");
});

test("commands against an unknown planId fail with plan_not_found", () => {
  const projection = bootstrapMission();
  const result = run(projection, { type: "ValidateMissionPlan", missionId: MISSION_ID, planId: "no-such-plan", context: validationContext() }, projection.aggregateVersion);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "plan_not_found");
});

test("rebuilding the projection from raw events after a full Propose->Validate->Approve->Materialize sequence matches the incrementally-applied projection", async () => {
  const { projectMission } = await import("../src/lib/mission/mission-projection.ts");
  const created = run(null, { type: "CreateMission", missionId: MISSION_ID, workspaceId: "ws-1", repository: "acme/app", goal: "goal", mode: "solo" }, 0);
  assert.ok(created.ok);
  if (!created.ok) throw new Error("unreachable");
  let projection = created.projection;
  const allEvents: import("../src/lib/mission/mission-events.ts").MissionEvent[] = [...created.events];
  const plan = propose(plannerInput());

  for (const command of [
    { type: "ProposeMissionPlan", missionId: MISSION_ID, planId: plan.id, plan } as MissionCommand,
    { type: "ValidateMissionPlan", missionId: MISSION_ID, planId: plan.id, context: validationContext() } as MissionCommand,
    { type: "ApproveMissionPlan", missionId: MISSION_ID, planId: plan.id } as MissionCommand,
    { type: "MaterializeMissionPlan", missionId: MISSION_ID, planId: plan.id } as MissionCommand,
  ]) {
    const result = run(projection, command, projection.aggregateVersion);
    assert.ok(result.ok);
    if (!result.ok) throw new Error("unreachable");
    allEvents.push(...result.events);
    projection = result.projection;
  }

  const rebuilt = projectMission(MISSION_ID, allEvents);
  assert.deepEqual(rebuilt, projection);
});
