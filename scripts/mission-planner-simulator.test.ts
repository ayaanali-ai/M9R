/**
 * Plan simulator — Phase 5A tests
 *
 * A pure dry-run: topological order, initially-ready/blocked assignments,
 * approval points, capability failures, terminal conditions, and safe
 * behavior on a cyclic graph (never calls a provider or mutates anything —
 * there is nothing to assert there beyond "it only reads the Plan").
 */

import test from "node:test";
import assert from "node:assert/strict";

import { simulateMissionPlanProposal } from "../src/lib/mission/mission-planner-simulator.ts";
import { propose, type PlannerInput, type PlannerProviderDescriptor } from "../src/lib/mission/mission-planner.ts";

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

test("solo Plan simulation: one assignment, initially ready, terminal, no approval points", () => {
  const plan = propose(baseInput());
  const sim = simulateMissionPlanProposal(plan);
  const assignmentId = plan.assignmentProposals[0].proposedAssignmentId;
  assert.deepEqual(sim.topologicalOrder, [assignmentId]);
  assert.deepEqual(sim.initiallyReady, [assignmentId]);
  assert.deepEqual(sim.blockedByDependency, []);
  assert.deepEqual(sim.requiredApprovalPoints, []);
  assert.deepEqual(sim.terminalSuccessConditions, [assignmentId]);
  assert.equal(sim.maxDependencyChainDepth, 0);
});

test("review-pair Plan simulation: review is blocked until implementation completes, ordered correctly", () => {
  const plan = propose(baseInput({ procedure: "implementation_review_pair" }));
  const [impl, review] = plan.assignmentProposals;
  const sim = simulateMissionPlanProposal(plan);
  assert.deepEqual(sim.topologicalOrder, [impl.proposedAssignmentId, review.proposedAssignmentId]);
  assert.deepEqual(sim.initiallyReady, [impl.proposedAssignmentId]);
  assert.deepEqual(sim.blockedByDependency, [review.proposedAssignmentId]);
  assert.deepEqual(sim.terminalSuccessConditions, [review.proposedAssignmentId]);
  assert.equal(sim.maxDependencyChainDepth, 1);
  assert.equal(sim.collaborationLinks.length, 1);
});

test("human_led Plan simulation: the verification assignment is a required approval point", () => {
  const plan = propose(baseInput({ procedure: "implementation_test_verification" }));
  const verify = plan.assignmentProposals[1];
  const sim = simulateMissionPlanProposal(plan);
  assert.deepEqual(sim.requiredApprovalPoints, [verify.proposedAssignmentId]);
});

test("unresolved provider capability shows up as a possible capability failure in simulation", () => {
  const plan = propose(baseInput({ availableProviders: [] }));
  const sim = simulateMissionPlanProposal(plan);
  assert.deepEqual(sim.possibleCapabilityFailures, [plan.participantProposals[0].proposedParticipantId]);
});

test("a cyclic dependency graph never causes infinite recursion — cyclic members are excluded from topologicalOrder and reported as unreachable", () => {
  const plan = propose(baseInput({ procedure: "implementation_review_pair" }));
  const [a, b] = plan.assignmentProposals;
  a.dependencies = [b.proposedAssignmentId];
  b.dependencies = [a.proposedAssignmentId];
  const sim = simulateMissionPlanProposal(plan);
  assert.deepEqual(sim.topologicalOrder, []);
  assert.deepEqual(sim.unreachableAssignments.sort(), [a.proposedAssignmentId, b.proposedAssignmentId].sort());
  // chainDepth guards a cycle by returning 0 the moment it revisits an id
  // already on the current path — it terminates (doesn't blow the stack),
  // but a finite depth is still computed for the acyclic portion of the
  // walk before that guard fires, so this is not itself 0.
  assert.equal(sim.maxDependencyChainDepth, 2, "cyclic recursion terminates via the visiting-set guard rather than recursing forever");
});

test("investigation_then_implementation: dependency chain depth of 1, investigation is initially ready", () => {
  const plan = propose(baseInput({ procedure: "investigation_then_implementation" }));
  const [investigate, implement] = plan.assignmentProposals;
  const sim = simulateMissionPlanProposal(plan);
  assert.deepEqual(sim.initiallyReady, [investigate.proposedAssignmentId]);
  assert.deepEqual(sim.blockedByDependency, [implement.proposedAssignmentId]);
  assert.equal(sim.maxDependencyChainDepth, 1);
});

test("simulator never mutates the Plan it is given", () => {
  const plan = propose(baseInput({ procedure: "implementation_review_pair" }));
  const snapshot = JSON.parse(JSON.stringify(plan));
  simulateMissionPlanProposal(plan);
  assert.deepEqual(plan, snapshot);
});
