/**
 * Model plan normalization — Phase 5B §9/§20 tests.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { normalizeModelPlanProposal } from "../src/lib/mission/mission-model-plan-normalizer.ts";
import type { RawModelPlanOutput } from "../src/lib/mission/mission-model-plan-schema.ts";
import { MODEL_PLAN_OUTPUT_SCHEMA_VERSION } from "../src/lib/mission/mission-model-plan-schema.ts";
import type { PlannerProviderDescriptor } from "../src/lib/mission/mission-planner.ts";

function fullyCapableProvider(id: string): PlannerProviderDescriptor {
  return {
    id,
    capabilities: { non_interactive_execution: true, repository_editing: true, structured_output: true, streaming_output: true, cancellation: false, session_resume: false, usage_reporting: true, tool_event_reporting: true, approval_requests: false, image_input: false, interactive_session: false },
  };
}

function rawOutput(overrides: Partial<RawModelPlanOutput> = {}): RawModelPlanOutput {
  return {
    schemaVersion: MODEL_PLAN_OUTPUT_SCHEMA_VERSION,
    interpretedObjective: "Fix the flaky test",
    procedureTemplate: "solo_implementation",
    operatingMode: "solo",
    participants: [{ participantId: "impl", role: "implementer", requiredCapabilities: ["repository_editing"], allowedPaths: ["src"], prohibitedPaths: [], rationale: "does the work" }],
    assignments: [
      {
        assignmentId: "a1",
        assigneeId: "impl",
        objective: "fix it",
        allowedPaths: ["src"],
        prohibitedPaths: [],
        dependencies: [],
        requiredEvidence: ["evidence://tests"],
        approvalPolicy: "auto",
        maxDurationMs: 600_000,
        maxEstimatedTokens: 100_000,
        dispatchEligibilityConditions: ["assignee_active"],
        completionCriteria: ["completion_notice_submitted"],
      },
    ],
    collaborationTopology: [],
    evidenceRequirements: ["evidence://tests"],
    approvalGates: [],
    executionLimits: { maxDurationMs: 600_000, maxEstimatedTokens: 100_000 },
    assumptions: [],
    unresolvedQuestions: [],
    warnings: [],
    rationale: "solo fix",
    ...overrides,
  };
}

test("normalization maps model-local ids to deterministic canonical ids", () => {
  const { proposal } = normalizeModelPlanProposal({ missionId: "m-1", version: 1, supersedesPlanId: null, raw: rawOutput(), availableProviders: [fullyCapableProvider("codex")], now: "2026-09-10T00:00:00.000Z", createdBy: "human-1" });
  assert.equal(proposal.id, "m-1-plan-1");
  assert.equal(proposal.participantProposals[0].proposedParticipantId, "m-1-plan-participant-1");
  assert.equal(proposal.assignmentProposals[0].proposedAssignmentId, "m-1-plan-assignment-1");
  assert.equal(proposal.assignmentProposals[0].proposedAssigneeId, "m-1-plan-participant-1");
});

test("id mapping is deterministic regardless of the model's own array order (sorted by the model's local id)", () => {
  const raw = rawOutput();
  raw.participants = [
    { participantId: "zzz", role: "reviewer", requiredCapabilities: [], allowedPaths: [], prohibitedPaths: [], rationale: "r" },
    { participantId: "aaa", role: "implementer", requiredCapabilities: [], allowedPaths: [], prohibitedPaths: [], rationale: "r" },
  ];
  raw.assignments[0].assigneeId = "aaa";
  const { proposal } = normalizeModelPlanProposal({ missionId: "m-1", version: 1, supersedesPlanId: null, raw, availableProviders: [], now: "2026-09-10T00:00:00.000Z", createdBy: "human-1" });
  // "aaa" sorts before "zzz" -> aaa becomes participant-1 regardless of array order.
  assert.equal(proposal.participantProposals.find((p) => p.role === "implementer")!.proposedParticipantId, "m-1-plan-participant-1");
  assert.equal(proposal.participantProposals.find((p) => p.role === "reviewer")!.proposedParticipantId, "m-1-plan-participant-2");
});

test("provider assignment is ALWAYS computed from requiredCapabilities via resolveProviderForCapabilities — never trusted from model text", () => {
  const raw = rawOutput();
  const { proposal } = normalizeModelPlanProposal({ missionId: "m-1", version: 1, supersedesPlanId: null, raw, availableProviders: [fullyCapableProvider("codex")], now: "2026-09-10T00:00:00.000Z", createdBy: "human-1" });
  assert.equal(proposal.participantProposals[0].providerConstraint.provider, "codex");
});

test("no available provider satisfying requiredCapabilities leaves provider null and records an unresolved question — never a fabricated capability match", () => {
  const raw = rawOutput();
  const { proposal } = normalizeModelPlanProposal({ missionId: "m-1", version: 1, supersedesPlanId: null, raw, availableProviders: [], now: "2026-09-10T00:00:00.000Z", createdBy: "human-1" });
  assert.equal(proposal.participantProposals[0].providerConstraint.provider, null);
  assert.ok(proposal.unresolvedQuestions.some((q) => q.includes("repository_editing")));
});

test("path normalization: 'src/' and 'src' and './src' all normalize identically", () => {
  const raw1 = rawOutput();
  raw1.participants[0].allowedPaths = ["src/"];
  const raw2 = rawOutput();
  raw2.participants[0].allowedPaths = ["./src"];
  const r1 = normalizeModelPlanProposal({ missionId: "m-1", version: 1, supersedesPlanId: null, raw: raw1, availableProviders: [], now: "t", createdBy: "human-1" });
  const r2 = normalizeModelPlanProposal({ missionId: "m-1", version: 1, supersedesPlanId: null, raw: raw2, availableProviders: [], now: "t", createdBy: "human-1" });
  assert.deepEqual(r1.proposal.participantProposals[0].workspacePermissions.allowedPaths, r2.proposal.participantProposals[0].workspacePermissions.allowedPaths);
  assert.deepEqual(r1.proposal.participantProposals[0].workspacePermissions.allowedPaths, ["src"]);
});

test("equivalent proposals (same content, different key/array order) normalize to deep-equal output", () => {
  const rawA = rawOutput();
  const rawB: RawModelPlanOutput = JSON.parse(JSON.stringify(rawOutput()));
  rawB.evidenceRequirements = [...rawB.evidenceRequirements].reverse();
  const a = normalizeModelPlanProposal({ missionId: "m-1", version: 1, supersedesPlanId: null, raw: rawA, availableProviders: [], now: "t", createdBy: "human-1" });
  const b = normalizeModelPlanProposal({ missionId: "m-1", version: 1, supersedesPlanId: null, raw: rawB, availableProviders: [], now: "t", createdBy: "human-1" });
  assert.deepEqual(a.proposal, b.proposal);
});

test("a solo_implementation proposal with no human_required assignment passes template safeguards (none required)", () => {
  const { templateSafeguardViolations } = normalizeModelPlanProposal({ missionId: "m-1", version: 1, supersedesPlanId: null, raw: rawOutput(), availableProviders: [], now: "t", createdBy: "human-1" });
  assert.deepEqual(templateSafeguardViolations, []);
});

test("an implementation_test_verification proposal that DROPS the mandatory human_required safeguard is flagged", () => {
  const raw = rawOutput({ procedureTemplate: "implementation_test_verification" });
  raw.participants.push({ participantId: "verify", role: "verifier", requiredCapabilities: [], allowedPaths: [], prohibitedPaths: [], rationale: "verifies" });
  raw.assignments.push({ assignmentId: "a2", assigneeId: "verify", objective: "verify it", allowedPaths: [], prohibitedPaths: [], dependencies: ["a1"], requiredEvidence: [], approvalPolicy: "auto", maxDurationMs: null, maxEstimatedTokens: null, dispatchEligibilityConditions: ["dependencies_satisfied"], completionCriteria: ["verification_passed"] });
  raw.collaborationTopology = [{ from: "a2", to: "a1", kind: "review" }];
  // Neither assignment declares approvalPolicy: "human_required" — the model tried to drop the mandatory safeguard.
  const { templateSafeguardViolations } = normalizeModelPlanProposal({ missionId: "m-1", version: 1, supersedesPlanId: null, raw, availableProviders: [], now: "t", createdBy: "human-1" });
  assert.ok(templateSafeguardViolations.some((v) => v.includes("human_required")));
});

test("a review_pair proposal with no 'review' collaboration edge is flagged (mandatory review safeguard removed)", () => {
  const raw = rawOutput({ procedureTemplate: "implementation_review_pair" });
  raw.participants.push({ participantId: "rev", role: "reviewer", requiredCapabilities: [], allowedPaths: [], prohibitedPaths: [], rationale: "reviews" });
  raw.assignments.push({ assignmentId: "a2", assigneeId: "rev", objective: "review it", allowedPaths: [], prohibitedPaths: [], dependencies: ["a1"], requiredEvidence: [], approvalPolicy: "auto", maxDurationMs: null, maxEstimatedTokens: null, dispatchEligibilityConditions: ["dependencies_satisfied"], completionCriteria: ["review_completed_no_blocking_findings"] });
  raw.collaborationTopology = []; // no review edge at all
  const { templateSafeguardViolations } = normalizeModelPlanProposal({ missionId: "m-1", version: 1, supersedesPlanId: null, raw, availableProviders: [], now: "t", createdBy: "human-1" });
  assert.ok(templateSafeguardViolations.some((v) => v.includes("review")));
});

test("supersedesPlanId is preserved when supplied (revision path)", () => {
  const { proposal } = normalizeModelPlanProposal({ missionId: "m-1", version: 2, supersedesPlanId: "m-1-plan-1", raw: rawOutput(), availableProviders: [], now: "t", createdBy: "human-1" });
  assert.equal(proposal.supersedesPlanId, "m-1-plan-1");
  assert.equal(proposal.version, 2);
  assert.equal(proposal.id, "m-1-plan-2");
});
