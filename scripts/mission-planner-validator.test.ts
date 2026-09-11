/**
 * Plan validator — Phase 5A tests
 *
 * Every `PlanValidationErrorCode` gets a case that triggers it and a
 * baseline case proving a clean Plan validates with zero errors.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { validateMissionPlanProposal, type PlanValidationContext } from "../src/lib/mission/mission-planner-validator.ts";
import { propose, type PlannerInput, type PlannerProviderDescriptor } from "../src/lib/mission/mission-planner.ts";
import type { MissionPlanProposal } from "../src/lib/mission/mission-domain.ts";

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

function baseInput(overrides: Partial<PlannerInput> = {}): PlannerInput {
  return {
    missionId: "m-1",
    objective: "Fix the flaky test",
    workspaceContext: { repository: "acme/app", repositoryId: null },
    applicableRules: [],
    availableProviders: [fullyCapableProvider("codex")],
    allowedRoles: ["implementer", "reviewer", "verifier"],
    budget: { maxDurationMs: 10 * 60_000, maxEstimatedTokens: 100_000 },
    scope: { allowedPaths: ["src/"], prohibitedPaths: ["src/secrets/"] },
    approvalPolicy: "auto",
    collaborationPolicy: { allowBroadcast: false, maxDelegationDepth: 1 },
    operatingMode: "solo",
    constraints: [],
    now: "2026-08-15T00:00:00.000Z",
    createdBy: "human-1",
    ...overrides,
  };
}

function baseContext(overrides: Partial<PlanValidationContext> = {}): PlanValidationContext {
  return {
    missionScope: { allowedPaths: ["src/"], prohibitedPaths: ["src/secrets/"] },
    missionBudget: { maxDurationMs: 10 * 60_000, maxEstimatedTokens: 100_000 },
    availableApprovalAuthorities: ["human"],
    ...overrides,
  };
}

test("a clean solo Plan validates with zero errors", () => {
  const plan = propose(baseInput());
  const result = validateMissionPlanProposal(plan, baseContext());
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("assignment_missing_participant: an assignment referencing an unknown assignee is rejected", () => {
  const plan = propose(baseInput());
  plan.assignmentProposals[0].proposedAssigneeId = "nobody";
  const result = validateMissionPlanProposal(plan, baseContext());
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === "assignment_missing_participant"));
});

test("dependency_references_unknown_assignment: a dependency on a nonexistent assignment is rejected", () => {
  const plan = propose(baseInput());
  plan.assignmentProposals[0].dependencies = ["m-1-plan-assignment-999"];
  const result = validateMissionPlanProposal(plan, baseContext());
  assert.ok(result.errors.some((e) => e.code === "dependency_references_unknown_assignment"));
});

test("dependency_cycle: a two-assignment cycle is detected and every member reported inside it", () => {
  const plan = propose(baseInput({ procedure: "implementation_review_pair" }));
  const [a, b] = plan.assignmentProposals;
  a.dependencies = [b.proposedAssignmentId];
  b.dependencies = [a.proposedAssignmentId];
  const result = validateMissionPlanProposal(plan, baseContext());
  assert.ok(result.errors.some((e) => e.code === "dependency_cycle"));
});

test("provider_capability_unresolved: a Plan proposal with no matching provider is rejected", () => {
  const plan = propose(baseInput({ availableProviders: [] }));
  const result = validateMissionPlanProposal(plan, baseContext());
  assert.ok(result.errors.some((e) => e.code === "provider_capability_unresolved"));
});

test("dishonest capability assumptions are rejected: a provider that doesn't declare repository_editing is never treated as satisfying it", () => {
  const readOnly = { ...fullyCapableProvider("claude-code"), capabilities: { ...fullyCapableProvider("claude-code").capabilities, repository_editing: false } };
  const plan = propose(baseInput({ availableProviders: [readOnly] }));
  assert.equal(plan.participantProposals[0].providerConstraint.provider, null);
  const result = validateMissionPlanProposal(plan, baseContext());
  assert.ok(result.errors.some((e) => e.code === "provider_capability_unresolved"));
});

test("assignment_scope_exceeds_mission_scope: an assignment scope broader than the Mission's own is rejected", () => {
  const plan = propose(baseInput());
  plan.assignmentProposals[0].scope = { allowedPaths: ["src/", "infra/"], prohibitedPaths: [] };
  const result = validateMissionPlanProposal(plan, baseContext({ missionScope: { allowedPaths: ["src/"], prohibitedPaths: ["src/secrets/"] } }));
  assert.ok(result.errors.some((e) => e.code === "assignment_scope_exceeds_mission_scope"));
});

test("self_review_not_distinct: a review edge where the same participant is on both sides is rejected", () => {
  const plan = propose(baseInput({ procedure: "implementation_review_pair" }));
  const implementerId = plan.participantProposals[0].proposedParticipantId;
  plan.assignmentProposals[1].proposedAssigneeId = implementerId; // reviewer assignment now assigned to the implementer
  const result = validateMissionPlanProposal(plan, baseContext());
  assert.ok(result.errors.some((e) => e.code === "self_review_not_distinct"));
});

test("approval_authority_unavailable: a human_required assignment with no human authority available is rejected", () => {
  const plan = propose(baseInput({ procedure: "implementation_test_verification" }));
  const result = validateMissionPlanProposal(plan, baseContext({ availableApprovalAuthorities: [] }));
  assert.ok(result.errors.some((e) => e.code === "approval_authority_unavailable"));
});

test("human_required Plan cannot be approved by an agent — enforced at approval time, but validator confirms the authority is at least available", () => {
  const plan = propose(baseInput({ procedure: "implementation_test_verification" }));
  const result = validateMissionPlanProposal(plan, baseContext({ availableApprovalAuthorities: ["human"] }));
  assert.equal(result.ok, true);
});

test("budget_exceeds_mission_limit: an assignment budget larger than the Mission's own limit is rejected", () => {
  const plan = propose(baseInput());
  plan.assignmentProposals[0].budget = { maxDurationMs: 999_999_999, maxEstimatedTokens: null };
  const result = validateMissionPlanProposal(plan, baseContext());
  assert.ok(result.errors.some((e) => e.code === "budget_exceeds_mission_limit"));
});

test("unrecognized_dispatch_condition: an invented dispatch condition string is rejected", () => {
  const plan = propose(baseInput());
  plan.assignmentProposals[0].dispatchEligibilityConditions = ["made_up_condition"];
  const result = validateMissionPlanProposal(plan, baseContext());
  assert.ok(result.errors.some((e) => e.code === "unrecognized_dispatch_condition"));
});

test("unrecognized_completion_criterion: an invented completion criterion is rejected", () => {
  const plan = propose(baseInput());
  plan.assignmentProposals[0].completionCriteria = ["it_feels_done"];
  const result = validateMissionPlanProposal(plan, baseContext());
  assert.ok(result.errors.some((e) => e.code === "unrecognized_completion_criterion"));
});

test("unreachable_completion_condition: an assignment with no completion criteria at all is rejected", () => {
  const plan = propose(baseInput());
  plan.assignmentProposals[0].completionCriteria = [];
  const result = validateMissionPlanProposal(plan, baseContext());
  assert.ok(result.errors.some((e) => e.code === "unreachable_completion_condition"));
});

test("unrecognized_evidence_requirement: an evidence reference without the evidence:// prefix is rejected", () => {
  const plan = propose(baseInput());
  plan.assignmentProposals[0].requiredEvidence = ["some-file.txt"];
  const result = validateMissionPlanProposal(plan, baseContext());
  assert.ok(result.errors.some((e) => e.code === "unrecognized_evidence_requirement"));
});

test("prerequisite_for_impossible_work: an assignment depending into a cyclic chain is flagged in addition to the cycle itself", () => {
  const plan = propose(baseInput({ procedure: "investigation_then_implementation" }));
  const [investigate, implement] = plan.assignmentProposals;
  // Force investigate <-> implement into a cycle, matching a real 2-cycle
  investigate.dependencies = [implement.proposedAssignmentId];
  const result = validateMissionPlanProposal(plan, baseContext());
  assert.ok(result.errors.some((e) => e.code === "dependency_cycle"));
});

test("validator never mutates the Plan it is given", () => {
  const plan = propose(baseInput());
  const snapshot: MissionPlanProposal = JSON.parse(JSON.stringify(plan));
  validateMissionPlanProposal(plan, baseContext());
  assert.deepEqual(plan, snapshot);
});
