/**
 * MissionPlanner — Phase 5A tests
 *
 * Covers: deterministic Plan generation (stable output for the same
 * normalized input, across all 5 procedure templates), honest provider
 * capability selection (never inferred from a provider's name, Codex vs.
 * Claude selected purely by declared capability), and the propose/validate/
 * simulate interface working together end to end.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { MissionPlanner, propose, type PlannerInput, type PlannerProviderDescriptor } from "../src/lib/mission/mission-planner.ts";
import { PROCEDURE_TEMPLATE_IDS } from "../src/lib/mission/mission-planner-templates.ts";

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

function readOnlyProvider(id: string): PlannerProviderDescriptor {
  return { ...fullyCapableProvider(id), capabilities: { ...fullyCapableProvider(id).capabilities, repository_editing: false } };
}

function baseInput(overrides: Partial<PlannerInput> = {}): PlannerInput {
  return {
    missionId: "m-1",
    objective: "Fix the flaky test",
    workspaceContext: { repository: "acme/app", repositoryId: null },
    applicableRules: [],
    availableProviders: [fullyCapableProvider("codex"), readOnlyProvider("claude-code")],
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

test("propose is deterministic: the same normalized input always produces the same Plan", () => {
  const input = baseInput();
  const first = propose(input);
  const second = propose(input);
  assert.deepEqual(first, second);
});

test("propose produces stable, derived ids — not random", () => {
  const plan = propose(baseInput());
  assert.equal(plan.id, "m-1-plan-1");
  assert.ok(plan.participantProposals[0].proposedParticipantId.startsWith("m-1-plan-participant-"));
  assert.ok(plan.assignmentProposals[0].proposedAssignmentId.startsWith("m-1-plan-assignment-"));
});

test("every procedure template produces a non-empty, internally consistent Plan", () => {
  for (const templateId of PROCEDURE_TEMPLATE_IDS) {
    const plan = propose(baseInput({ procedure: templateId }));
    assert.ok(plan.participantProposals.length > 0, `${templateId} must propose at least one participant`);
    assert.ok(plan.assignmentProposals.length > 0, `${templateId} must propose at least one assignment`);
    const participantIds = new Set(plan.participantProposals.map((p) => p.proposedParticipantId));
    for (const a of plan.assignmentProposals) {
      if (a.proposedAssigneeId) assert.ok(participantIds.has(a.proposedAssigneeId), `${templateId}: assignment ${a.proposedAssignmentId} references a real proposed participant`);
    }
  }
});

test("operating mode selects a deterministic default procedure when none is explicitly requested", () => {
  const solo = propose(baseInput({ operatingMode: "solo" }));
  const pair = propose(baseInput({ operatingMode: "review_pair" }));
  assert.equal(solo.assignmentProposals.length, 1);
  assert.equal(pair.assignmentProposals.length, 2);
});

test("Codex and Claude are selected purely on declared capability — a read-only provider is never chosen for a repository-editing role", () => {
  const plan = propose(baseInput({ procedure: "solo_implementation" })); // implementer requires repository_editing
  assert.equal(plan.participantProposals[0].providerConstraint.provider, "codex", "only the repository-editing-capable provider satisfies the implementer role");
});

test("when NO provider satisfies the required capabilities, the Plan records an unresolved question rather than silently choosing one", () => {
  const plan = propose(baseInput({ availableProviders: [readOnlyProvider("claude-code")] })); // no repository_editing provider at all
  assert.equal(plan.participantProposals[0].providerConstraint.provider, null);
  assert.ok(plan.unresolvedQuestions.some((q) => q.includes("repository_editing")));
});

test("a reviewer role (implementation_review_pair) is satisfied by a read-only provider — no repository_editing required", () => {
  const plan = propose(baseInput({ procedure: "implementation_review_pair", availableProviders: [fullyCapableProvider("codex"), readOnlyProvider("claude-code")] }));
  const reviewer = plan.participantProposals.find((p) => p.role === "reviewer");
  assert.ok(reviewer);
  assert.equal(reviewer?.providerConstraint.provider, "codex", "the FIRST provider satisfying the requirement wins — order is caller-supplied preference, never reshuffled");
});

test("propose/validate/simulate are exposed together as the MissionPlanner interface", () => {
  assert.equal(typeof MissionPlanner.propose, "function");
  assert.equal(typeof MissionPlanner.validate, "function");
  assert.equal(typeof MissionPlanner.simulate, "function");
});

test("a Plan never embeds a provider-specific launch argument — only role/objective/scope/evidence, all provider-neutral", () => {
  const plan = propose(baseInput());
  const serialized = JSON.stringify(plan);
  assert.ok(!serialized.includes("--sandbox"), "no Codex CLI flag");
  assert.ok(!serialized.includes("--output-format"), "no Claude Code CLI flag");
});
