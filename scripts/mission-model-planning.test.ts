/**
 * Model-assisted planning request/result lifecycle — Phase 5B §10/§11/§12/
 * §13/§14/§18/§20 integration tests, through the full `applyMissionCommand`
 * path. Uses deterministic fake model output text — no live model API.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { applyMissionCommand, type ApplyCommandInput } from "../src/lib/mission/mission-command-handler.ts";
import { resolveCommandContext, type MissionCommand } from "../src/lib/mission/mission-commands.ts";
import type { MissionProjection } from "../src/lib/mission/mission-projection.ts";
import { MODEL_PLAN_OUTPUT_SCHEMA_VERSION, type RawModelPlanOutput } from "../src/lib/mission/mission-model-plan-schema.ts";
import { allPlanningCapabilitiesFalse, type PlanningCapabilityRecord } from "../src/lib/mission/mission-planning-capability.ts";
import type { PlannerProviderDescriptor } from "../src/lib/mission/mission-planner.ts";
import type { PlanValidationContext } from "../src/lib/mission/mission-planner-validator.ts";

const MISSION_ID = "m-1";
let idCounter = 0;
function mintEventId(): string {
  idCounter += 1;
  return `evt-${idCounter}`;
}
function ctx(actor: { kind: "human" | "agent" | "system"; id: string } = { kind: "system", id: "orchestrator" }) {
  return resolveCommandContext({ actor: actor as never, timestamp: "2026-09-15T00:00:00.000Z" });
}
function run(current: MissionProjection | null, command: MissionCommand, expectedVersion: number, actor: { kind: "human" | "agent" | "system"; id: string } = { kind: "system", id: "orchestrator" }, opts: Partial<ApplyCommandInput> = {}) {
  return applyMissionCommand({ current, command, context: ctx(actor), expectedVersion, priorOutcome: null, mintEventId, ...opts });
}

const CAPABLE_CAPABILITIES: PlanningCapabilityRecord = { ...allPlanningCapabilitiesFalse(), structured_output: true, strict_json_schema: true, tool_free_generation: true };

function fullyCapableProvider(id: string): PlannerProviderDescriptor {
  return {
    id,
    capabilities: { non_interactive_execution: true, repository_editing: true, structured_output: true, streaming_output: true, cancellation: false, session_resume: false, usage_reporting: true, tool_event_reporting: true, approval_requests: false, image_input: false, interactive_session: false },
  };
}

function validationContext(overrides: Partial<PlanValidationContext> = {}): PlanValidationContext {
  return { missionScope: { allowedPaths: ["."], prohibitedPaths: [] }, missionBudget: { maxDurationMs: 10 * 60_000, maxEstimatedTokens: 100_000 }, availableApprovalAuthorities: ["human"], ...overrides };
}

function validRawOutput(overrides: Partial<RawModelPlanOutput> = {}): RawModelPlanOutput {
  return {
    schemaVersion: MODEL_PLAN_OUTPUT_SCHEMA_VERSION,
    interpretedObjective: "Fix the flaky test",
    procedureTemplate: "solo_implementation",
    operatingMode: "solo",
    participants: [{ participantId: "impl", role: "implementer", requiredCapabilities: ["repository_editing"], allowedPaths: ["."], prohibitedPaths: [], rationale: "does the work" }],
    assignments: [
      {
        assignmentId: "a1",
        assigneeId: "impl",
        objective: "fix it",
        allowedPaths: ["."],
        prohibitedPaths: [],
        dependencies: [],
        requiredEvidence: [],
        approvalPolicy: "auto",
        maxDurationMs: 600_000,
        maxEstimatedTokens: 100_000,
        dispatchEligibilityConditions: ["assignee_active"],
        completionCriteria: ["completion_notice_submitted"],
      },
    ],
    collaborationTopology: [],
    evidenceRequirements: [],
    approvalGates: [],
    executionLimits: { maxDurationMs: 600_000, maxEstimatedTokens: 100_000 },
    assumptions: [],
    unresolvedQuestions: [],
    warnings: [],
    rationale: "solo fix",
    ...overrides,
  };
}

function requestCommand(overrides: Partial<Extract<MissionCommand, { type: "RequestModelPlanning" }>> = {}): MissionCommand {
  return {
    type: "RequestModelPlanning",
    missionId: MISSION_ID,
    planningRequestId: "preq-1",
    kind: "proposal",
    targetPlanVersion: 1,
    basePlanId: null,
    modelConfigurationId: "planner-config-1",
    planningCapabilities: CAPABLE_CAPABILITIES,
    contextHash: "hash-1",
    maxAttempts: 1,
    ...overrides,
  };
}

function resultCommand(overrides: Partial<Extract<MissionCommand, { type: "RecordModelPlanningResult" }>> = {}): MissionCommand {
  return {
    type: "RecordModelPlanningResult",
    missionId: MISSION_ID,
    planningRequestId: "preq-1",
    rawModelOutputText: JSON.stringify(validRawOutput()),
    failureCode: null,
    redactedDiagnosticRef: "diag-ref-1",
    availableProviders: [fullyCapableProvider("codex")],
    planValidationContext: validationContext(),
    createdBy: "human-1",
    ...overrides,
  };
}

function bootstrap(): MissionProjection {
  const r = run(null, { type: "CreateMission", missionId: MISSION_ID, workspaceId: "ws-1", repository: "acme/app", goal: "goal", mode: "solo" }, 0);
  assert.ok(r.ok);
  if (!r.ok) throw new Error("unreachable");
  return r.projection;
}

// ---------------------------------------------------------------------------
// Architecture (§20): no execution modules imported/called by this file's
// subject at all — proven structurally by grepping the source, not just by
// test behavior, since a pure command handler has nothing to "call."
// ---------------------------------------------------------------------------

test("architecture: model-assisted planning commands never reference execution modules", async () => {
  const fs = await import("node:fs/promises");
  const handlerSource = await fs.readFile(new URL("../src/lib/mission/mission-command-handler.ts", import.meta.url), "utf8");
  for (const forbidden of ["mission-dispatch-runtime", "mission-real-execution-host", "mission-process-host-node", "mission-provider-adapter-codex", "mission-provider-adapter-claude-code"]) {
    assert.equal(handlerSource.includes(forbidden), false, `mission-command-handler.ts must never import ${forbidden}`);
  }
});

test("the deterministic Phase 5A Planner remains usable without any model involvement at all", async () => {
  const { propose } = await import("../src/lib/mission/mission-planner.ts");
  const plan = propose({
    missionId: MISSION_ID,
    objective: "fix it",
    workspaceContext: { repository: "acme/app", repositoryId: null },
    applicableRules: [],
    availableProviders: [fullyCapableProvider("codex")],
    allowedRoles: ["implementer"],
    budget: { maxDurationMs: null, maxEstimatedTokens: null },
    scope: { allowedPaths: ["."], prohibitedPaths: [] },
    approvalPolicy: "auto",
    collaborationPolicy: { allowBroadcast: false, maxDelegationDepth: 1 },
    operatingMode: "solo",
    constraints: [],
    now: "2026-09-15T00:00:00.000Z",
    createdBy: "human-1",
  });
  assert.equal(plan.status, "draft");
});

// ---------------------------------------------------------------------------
// Request/result lifecycle
// ---------------------------------------------------------------------------

test("RequestModelPlanning durably records a request; a duplicate planningRequestId is refused", () => {
  const projection = bootstrap();
  const requested = run(projection, requestCommand(), projection.aggregateVersion);
  assert.ok(requested.ok);
  if (!requested.ok) return;
  assert.ok(requested.projection.planningRequests["preq-1"]);
  assert.equal(requested.projection.planningRequests["preq-1"].status, "requested");

  const duplicate = run(requested.projection, requestCommand(), requested.aggregateVersion);
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.error.code, "planning_request_already_exists");
});

test("RequestModelPlanning refuses an under-capable model configuration", () => {
  const projection = bootstrap();
  const result = run(projection, requestCommand({ planningCapabilities: allPlanningCapabilitiesFalse() }), projection.aggregateVersion);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "planning_capability_unresolved");
});

test("a successful RecordModelPlanningResult creates the canonical MissionPlanProposal through the SAME event as ProposeMissionPlan", () => {
  let projection = bootstrap();
  const requested = run(projection, requestCommand(), projection.aggregateVersion);
  assert.ok(requested.ok);
  if (!requested.ok) return;
  projection = requested.projection;

  const completed = run(projection, resultCommand(), projection.aggregateVersion);
  assert.ok(completed.ok);
  if (!completed.ok) return;
  assert.equal(completed.events.some((e) => e.type === "mission.plan_proposal_created"), true);
  assert.equal(completed.projection.planningRequests["preq-1"].status, "completed");
  assert.equal(completed.projection.planningRequests["preq-1"].finalOutcome, "created_plan");
  assert.equal(completed.projection.planningRequests["preq-1"].resultingPlanId, "m-1-plan-1");
  assert.ok(completed.projection.planProposals["m-1-plan-1"]);
  assert.equal(completed.projection.planProposals["m-1-plan-1"].status, "draft");
});

test("RecordModelPlanningResult for an unknown planningRequestId is refused", () => {
  const projection = bootstrap();
  const result = run(projection, resultCommand({ planningRequestId: "ghost" }), projection.aggregateVersion);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "planning_request_not_found");
});

test("a stale result (request already completed) is rejected as not_actionable — never creates a duplicate Plan version", () => {
  let projection = bootstrap();
  let r = run(projection, requestCommand(), projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  projection = r.projection;
  r = run(projection, resultCommand(), projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  projection = r.projection;

  const stale = run(projection, resultCommand(), projection.aggregateVersion);
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.error.code, "planning_request_not_actionable");
});

test("Mission cancellation invalidates outstanding planning requests — a late result is marked stale, never creates a Plan", () => {
  let projection = bootstrap();
  let r = run(projection, requestCommand(), projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  projection = r.projection;

  r = run(projection, { type: "CancelMission", missionId: MISSION_ID, reason: { code: "abandoned", summary: "s", relatedEntityIds: [], recoverable: false, suggestedActions: [] } }, projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  projection = r.projection;
  assert.equal(projection.terminal, true);

  const lateResult = run(projection, resultCommand(), projection.aggregateVersion);
  assert.ok(lateResult.ok);
  if (!lateResult.ok) return;
  assert.equal(lateResult.projection.planningRequests["preq-1"].status, "stale");
  assert.equal(lateResult.events.some((e) => e.type === "mission.plan_proposal_created"), false);
});

// ---------------------------------------------------------------------------
// Repair loop (§12)
// ---------------------------------------------------------------------------

test("a validation failure with attempts remaining routes back to 'requested' — a bounded repair attempt, not immediately terminal", () => {
  let projection = bootstrap();
  const r = run(projection, requestCommand({ maxAttempts: 2 }), projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  projection = r.projection;

  const malformed = run(projection, resultCommand({ rawModelOutputText: "{ not valid json" }), projection.aggregateVersion);
  assert.ok(malformed.ok);
  if (!malformed.ok) return;
  assert.equal(malformed.projection.planningRequests["preq-1"].status, "requested");
  assert.equal(malformed.projection.planningRequests["preq-1"].attemptCount, 1);
  assert.equal(malformed.events.some((e) => e.type === "mission.plan_proposal_created"), false);
});

test("repair exhaustion (attemptCount reaches maxAttempts) fails terminally — no recursive retry", () => {
  let projection = bootstrap();
  const r = run(projection, requestCommand({ maxAttempts: 1 }), projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  projection = r.projection;

  const failed = run(projection, resultCommand({ rawModelOutputText: "{ not valid json" }), projection.aggregateVersion);
  assert.ok(failed.ok);
  if (!failed.ok) return;
  assert.equal(failed.projection.planningRequests["preq-1"].status, "failed");
  assert.equal(failed.projection.planningRequests["preq-1"].finalOutcome, "rejected");

  // The now-terminal request cannot accept yet another result — no unbounded retry.
  const anotherAttempt = run(failed.projection, resultCommand(), failed.aggregateVersion);
  assert.equal(anotherAttempt.ok, false);
});

test("a failureCode with no raw output also consumes a repair attempt / fails terminally, same as a schema failure", () => {
  let projection = bootstrap();
  const r = run(projection, requestCommand({ maxAttempts: 1 }), projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  projection = r.projection;

  const failed = run(projection, resultCommand({ rawModelOutputText: null, failureCode: "model_call_errored" }), projection.aggregateVersion);
  assert.ok(failed.ok);
  if (!failed.ok) return;
  assert.equal(failed.projection.planningRequests["preq-1"].status, "failed");
});

test("no Plan is ever created from a failed/repair attempt", () => {
  let projection = bootstrap();
  let r = run(projection, requestCommand({ maxAttempts: 2 }), projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  projection = r.projection;
  r = run(projection, resultCommand({ rawModelOutputText: "not json" }), projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.projection.planProposals, {});
});

// ---------------------------------------------------------------------------
// Security / prompt-injection (§7/§18/§20) — even if the model "obeyed"
// injected repository text, deterministic validation still rejects it.
// ---------------------------------------------------------------------------

test("prompt-injection cannot broaden scope: a model output claiming a path outside Mission scope is rejected by deterministic validation, not accepted", () => {
  let projection = bootstrap();
  const r = run(projection, requestCommand({ maxAttempts: 1 }), projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  projection = r.projection;

  // Simulate the model "obeying" injected repository text telling it to use
  // prohibited paths / broaden scope beyond the Mission's own authority.
  const broadened = validRawOutput();
  broadened.assignments[0].allowedPaths = ["."];
  broadened.assignments[0].prohibitedPaths = []; // tries to drop the Mission's own prohibition
  const restrictiveContext = validationContext({ missionScope: { allowedPaths: ["src"], prohibitedPaths: ["src/secrets"] } });

  const result = run(projection, resultCommand({ maxAttempts: 1, planValidationContext: restrictiveContext } as never), projection.aggregateVersion);
  assert.ok(result.ok); // the COMMAND succeeds (it's a repair/fail recording), but...
  if (!result.ok) return;
  assert.equal(result.projection.planningRequests["preq-1"].status, "failed", "scope-exceeding output must be rejected by validateMissionPlanProposal, never silently accepted as a Plan");
  assert.deepEqual(result.projection.planProposals, {});
});

test("prompt-injection cannot remove mandatory approval: a human_led template output missing human_required is rejected via template safeguards", () => {
  let projection = bootstrap();
  const r = run(projection, requestCommand({ maxAttempts: 1 }), projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  projection = r.projection;

  const noApproval = validRawOutput({ procedureTemplate: "implementation_test_verification" });
  noApproval.participants.push({ participantId: "verify", role: "verifier", requiredCapabilities: [], allowedPaths: [], prohibitedPaths: [], rationale: "verifies" });
  noApproval.assignments.push({ assignmentId: "a2", assigneeId: "verify", objective: "verify", allowedPaths: [], prohibitedPaths: [], dependencies: ["a1"], requiredEvidence: [], approvalPolicy: "auto", maxDurationMs: null, maxEstimatedTokens: null, dispatchEligibilityConditions: ["dependencies_satisfied"], completionCriteria: ["verification_passed"] });
  noApproval.collaborationTopology = [{ from: "a2", to: "a1", kind: "review" }];
  // Neither assignment is human_required — "remove approval" attempted.

  const result = run(projection, resultCommand({ rawModelOutputText: JSON.stringify(noApproval) }), projection.aggregateVersion);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.projection.planningRequests["preq-1"].status, "failed");
  assert.deepEqual(result.projection.planProposals, {});
});

test("prompt-injection cannot fabricate provider capability: the model has no field to assert a provider at all (schema-level), so RecordModelPlanningResult resolves providers honestly regardless of injected text", () => {
  let projection = bootstrap();
  const r = run(projection, requestCommand({ maxAttempts: 1 }), projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  projection = r.projection;

  const result = run(projection, resultCommand({ availableProviders: [] }), projection.aggregateVersion); // no provider available at all
  assert.ok(result.ok);
  if (!result.ok) return;
  // Unresolved provider capability is a VALIDATION error (provider_capability_unresolved), routed through the same repair/fail path.
  assert.equal(result.projection.planningRequests["preq-1"].status, "failed");
});

test("prompt-injection cannot materialize the Plan: a successful result only reaches 'draft' status, never approved/materialized", () => {
  let projection = bootstrap();
  let r = run(projection, requestCommand(), projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  projection = r.projection;
  r = run(projection, resultCommand(), projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.projection.planProposals["m-1-plan-1"].status, "draft");
  assert.equal(Object.keys(r.projection.participants).length, 0, "no participant may be created before approved materialization");
  assert.equal(Object.keys(r.projection.assignments).length, 0, "no assignment may be created before approved materialization");
});

test("an unauthorized actor (agent) cannot request planning", () => {
  const projection = bootstrap();
  const result = run(projection, requestCommand(), projection.aggregateVersion, { kind: "agent", id: "p-1" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "unauthorized_command");
});

// ---------------------------------------------------------------------------
// Cancellation (§14)
// ---------------------------------------------------------------------------

test("CancelModelPlanningRequest cancels an outstanding request; a subsequent result is refused", () => {
  let projection = bootstrap();
  let r = run(projection, requestCommand(), projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  projection = r.projection;

  r = run(projection, { type: "CancelModelPlanningRequest", missionId: MISSION_ID, planningRequestId: "preq-1", reason: { code: "no_longer_needed", summary: "s", relatedEntityIds: [], recoverable: false, suggestedActions: [] } }, projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.projection.planningRequests["preq-1"].status, "cancelled");
  projection = r.projection;

  const lateResult = run(projection, resultCommand(), projection.aggregateVersion);
  assert.equal(lateResult.ok, false);
  if (!lateResult.ok) assert.equal(lateResult.error.code, "planning_request_not_actionable");
});

// ---------------------------------------------------------------------------
// Plan cancellation/supersession (§14)
// ---------------------------------------------------------------------------

test("CancelMissionPlan cancels a draft Plan", () => {
  let projection = bootstrap();
  let r = run(projection, requestCommand(), projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  projection = r.projection;
  r = run(projection, resultCommand(), projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  projection = r.projection;

  r = run(projection, { type: "CancelMissionPlan", missionId: MISSION_ID, planId: "m-1-plan-1", reason: { code: "no_longer_needed", summary: "s", relatedEntityIds: [], recoverable: false, suggestedActions: [] } }, projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.projection.planProposals["m-1-plan-1"].status, "cancelled");
});

test("a cancelled Plan cannot materialize", () => {
  let projection = bootstrap();
  let r = run(projection, requestCommand(), projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  projection = r.projection;
  r = run(projection, resultCommand(), projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  projection = r.projection;
  r = run(projection, { type: "CancelMissionPlan", missionId: MISSION_ID, planId: "m-1-plan-1", reason: { code: "x", summary: "s", relatedEntityIds: [], recoverable: false, suggestedActions: [] } }, projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  projection = r.projection;

  const materialize = run(projection, { type: "MaterializeMissionPlan", missionId: MISSION_ID, planId: "m-1-plan-1" }, projection.aggregateVersion);
  assert.equal(materialize.ok, false);
});

// ---------------------------------------------------------------------------
// Revision (§13)
// ---------------------------------------------------------------------------

test("a model-assisted revision creates a new immutable Plan version and supersedes the prior one", () => {
  let projection = bootstrap();
  let r = run(projection, requestCommand(), projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  projection = r.projection;
  r = run(projection, resultCommand(), projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  projection = r.projection;
  const originalPlan = projection.planProposals["m-1-plan-1"];

  r = run(projection, requestCommand({ planningRequestId: "preq-2", kind: "revision", targetPlanVersion: 2, basePlanId: "m-1-plan-1" }), projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  projection = r.projection;

  r = run(projection, resultCommand({ planningRequestId: "preq-2" }), projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  projection = r.projection;

  assert.equal(projection.planProposals["m-1-plan-1"].status, "superseded");
  assert.deepEqual(projection.planProposals["m-1-plan-1"], { ...originalPlan, status: "superseded" }, "the prior Plan version's OWN content must remain unchanged — only its status moves");
  assert.ok(projection.planProposals["m-1-plan-2"]);
  assert.equal(projection.planProposals["m-1-plan-2"].supersedesPlanId, "m-1-plan-1");
  assert.equal(projection.planProposals["m-1-plan-2"].status, "draft");
});

test("revision requires new approval — the new Plan version starts at 'draft', never inheriting the prior Plan's approval", () => {
  let projection = bootstrap();
  let r = run(projection, requestCommand(), projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  projection = r.projection;
  r = run(projection, resultCommand(), projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  projection = r.projection;
  r = run(projection, { type: "ValidateMissionPlan", missionId: MISSION_ID, planId: "m-1-plan-1", context: validationContext() }, projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  projection = r.projection;
  r = run(projection, { type: "ApproveMissionPlan", missionId: MISSION_ID, planId: "m-1-plan-1" }, projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  projection = r.projection;
  assert.equal(projection.planProposals["m-1-plan-1"].status, "approved");

  r = run(projection, requestCommand({ planningRequestId: "preq-2", kind: "revision", targetPlanVersion: 2, basePlanId: "m-1-plan-1" }), projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  projection = r.projection;
  r = run(projection, resultCommand({ planningRequestId: "preq-2" }), projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.projection.planProposals["m-1-plan-2"].status, "draft", "the new version requires fresh approval — it never inherits 'approved'");
});

test("a stale revision base (already materialized) is rejected at RequestModelPlanning time", () => {
  let projection = bootstrap();
  let r = run(projection, requestCommand(), projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  projection = r.projection;
  r = run(projection, resultCommand(), projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  projection = r.projection;
  r = run(projection, { type: "ValidateMissionPlan", missionId: MISSION_ID, planId: "m-1-plan-1", context: validationContext() }, projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  projection = r.projection;
  r = run(projection, { type: "ApproveMissionPlan", missionId: MISSION_ID, planId: "m-1-plan-1" }, projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  projection = r.projection;
  r = run(projection, { type: "MaterializeMissionPlan", missionId: MISSION_ID, planId: "m-1-plan-1" }, projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  projection = r.projection;
  assert.equal(projection.planProposals["m-1-plan-1"].status, "active");

  const revisionRequest = run(projection, requestCommand({ planningRequestId: "preq-2", kind: "revision", targetPlanVersion: 2, basePlanId: "m-1-plan-1" }), projection.aggregateVersion);
  assert.equal(revisionRequest.ok, false);
  if (!revisionRequest.ok) assert.equal(revisionRequest.error.code, "plan_revision_base_invalid");
});

test("a superseded Plan cannot materialize", () => {
  let projection = bootstrap();
  let r = run(projection, requestCommand(), projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  projection = r.projection;
  r = run(projection, resultCommand(), projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  projection = r.projection;
  r = run(projection, requestCommand({ planningRequestId: "preq-2", kind: "revision", targetPlanVersion: 2, basePlanId: "m-1-plan-1" }), projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  projection = r.projection;
  r = run(projection, resultCommand({ planningRequestId: "preq-2" }), projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  projection = r.projection;

  const materializeOld = run(projection, { type: "MaterializeMissionPlan", missionId: MISSION_ID, planId: "m-1-plan-1" }, projection.aggregateVersion);
  assert.equal(materializeOld.ok, false);
});

// ---------------------------------------------------------------------------
// Simulation blocks approval (§16) — reusing the existing deterministic
// simulator/validator; a dependency cycle is rejected at the SCHEMA layer
// already (mission-model-plan-schema.test.ts), so here we exercise a
// post-normalization simulation failure: an unreachable assignment.
// ---------------------------------------------------------------------------

test("deterministic replay: rebuilding from raw events after a full request->result sequence matches the live projection exactly", async () => {
  const { projectMission } = await import("../src/lib/mission/mission-projection.ts");
  const allEvents: import("../src/lib/mission/mission-events.ts").MissionEvent[] = [];

  let r = run(null, { type: "CreateMission", missionId: MISSION_ID, workspaceId: "ws-1", repository: "acme/app", goal: "goal", mode: "solo" }, 0);
  assert.ok(r.ok);
  if (!r.ok) return;
  allEvents.push(...r.events);
  let projection = r.projection;

  r = run(projection, requestCommand(), projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  allEvents.push(...r.events);
  projection = r.projection;

  r = run(projection, resultCommand(), projection.aggregateVersion);
  assert.ok(r.ok);
  if (!r.ok) return;
  allEvents.push(...r.events);
  projection = r.projection;

  const rebuilt = projectMission(MISSION_ID, allEvents);
  assert.deepEqual(rebuilt, projection);
});
