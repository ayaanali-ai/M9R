/**
 * Recovery executors — Phase 5E Tasks C/D/E.
 * ----------------------------------------------------------------------------
 * Exercises `executeRerunDeterministicPipeline` / `executeReplayPersistence`
 * against the REAL `applyMissionCommand`/`InMemoryMissionStore` path (via
 * `PlanningRequestPortImpl`), the same boundary `mission-planning-worker.
 * test.ts` uses, so a passing "completed" outcome here proves a real Plan
 * really lands through the authoritative command — not a shortcut.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { applyMissionCommand } from "../src/lib/mission/mission-command-handler.ts";
import { resolveCommandContext, type MissionCommand } from "../src/lib/mission/mission-commands.ts";
import { InMemoryMissionStore } from "../src/lib/mission/mission-store.ts";
import { InMemoryIdempotencyStore } from "../src/lib/mission/mission-idempotency.ts";
import { MODEL_PLAN_OUTPUT_SCHEMA_VERSION, PLANNING_MODEL_PLAN_SCHEMA_VERSION, type RawModelPlanOutput } from "../src/lib/mission/mission-model-plan-schema.ts";
import { allPlanningCapabilitiesFalse, type PlanningCapabilityRecord } from "../src/lib/mission/mission-planning-capability.ts";
import type { PlannerProviderDescriptor } from "../src/lib/mission/mission-planner.ts";
import type { PlanValidationContext } from "../src/lib/mission/mission-planner-validator.ts";
import { PlanningRequestPortImpl } from "../src/lib/mission/mission-planning-request-port.ts";
import { InMemoryPlanningLeaseStore } from "../src/lib/mission/mission-planning-lease-store.ts";
import { InMemoryPlanningAttemptStore, type PlanningWorkerAttempt } from "../src/lib/mission/mission-planning-attempt-store.ts";
import { InMemoryPlanningDiagnosticsStore } from "../src/lib/mission/mission-planning-diagnostics-store.ts";
import { InMemoryPlanningReplayableResponseStore, computeReplayableResponseDigest } from "../src/lib/mission/mission-planning-replayable-response-store.ts";
import { classifyRecoveryAction, recoverPlanningAttempts, type RecoveryAction } from "../src/lib/mission/mission-planning-recovery.ts";
import {
  executeRerunDeterministicPipeline,
  executeReplayPersistence,
  type RecoveryExecutorDeps,
} from "../src/lib/mission/mission-planning-recovery-executor.ts";

const MISSION_ID = "m-1";
const WORKSPACE_ID = "ws-1";

function ctx() {
  return resolveCommandContext({ actor: { kind: "system", id: "orchestrator" } as never, timestamp: "2026-09-15T00:00:00.000Z" });
}

function mintIdFactory(prefix: string) {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}-${n}`;
  };
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

interface Harness {
  missionStore: InMemoryMissionStore;
  port: PlanningRequestPortImpl;
  leaseStore: InMemoryPlanningLeaseStore;
  attemptStore: InMemoryPlanningAttemptStore;
  diagnostics: InMemoryPlanningDiagnosticsStore;
  replayStore: InMemoryPlanningReplayableResponseStore;
  clock: () => string;
}

function makeHarness(): Harness {
  const missionStore = new InMemoryMissionStore();
  const idempotencyStore = new InMemoryIdempotencyStore<import("../src/lib/mission/mission-commands.ts").CommandOutcomeRecord>();
  const port = new PlanningRequestPortImpl(missionStore, idempotencyStore);
  const leaseStore = new InMemoryPlanningLeaseStore();
  const attemptStore = new InMemoryPlanningAttemptStore();
  const diagnostics = new InMemoryPlanningDiagnosticsStore();
  const replayStore = new InMemoryPlanningReplayableResponseStore();
  let tick = 0;
  const clock = () => new Date(Date.parse("2026-09-15T00:00:00.000Z") + tick++ * 1000).toISOString();
  return { missionStore, port, leaseStore, attemptStore, diagnostics, replayStore, clock };
}

async function bootstrapMission(missionStore: InMemoryMissionStore, missionId = MISSION_ID): Promise<void> {
  const created = applyMissionCommand({
    current: null,
    command: { type: "CreateMission", missionId, workspaceId: WORKSPACE_ID, repository: "acme/app", goal: "goal", mode: "solo" },
    context: ctx(),
    expectedVersion: 0,
    priorOutcome: null,
    mintEventId: mintIdFactory("evt"),
  });
  assert.ok(created.ok);
  if (!created.ok) throw new Error("unreachable");
  await missionStore.append({ missionId, expectedVersion: 0, events: created.events });
}

async function createPlanningRequest(missionStore: InMemoryMissionStore, planningRequestId: string, contextHash: string, maxAttempts = 3): Promise<void> {
  const events = await missionStore.loadEvents(MISSION_ID);
  const { projectMission } = await import("../src/lib/mission/mission-projection.ts");
  const projection = projectMission(MISSION_ID, events);
  const command: MissionCommand = {
    type: "RequestModelPlanning",
    missionId: MISSION_ID,
    planningRequestId,
    kind: "proposal",
    targetPlanVersion: 1,
    basePlanId: null,
    modelConfigurationId: "planner-config-1",
    planningCapabilities: CAPABLE_CAPABILITIES,
    contextHash,
    maxAttempts,
  };
  const result = applyMissionCommand({ current: projection, command, context: ctx(), expectedVersion: events[events.length - 1]?.aggregateVersion ?? 0, priorOutcome: null, mintEventId: mintIdFactory("evt") });
  assert.ok(result.ok);
  if (!result.ok) throw new Error("unreachable");
  await missionStore.append({ missionId: MISSION_ID, expectedVersion: events[events.length - 1]?.aggregateVersion ?? 0, events: result.events });
}

/** Builds a durable attempt row + matching replayable-response + diagnostic, as if a real worker crashed right after receiving a response but before finishing the local pipeline/recording — the exact shape `rerun_deterministic_pipeline_only`/`replay_persistence_only` are classified for. */
async function seedCrashedAttempt(
  h: Harness,
  opts: {
    planningRequestId: string;
    state: PlanningWorkerAttempt["state"];
    rawOutputText: string;
    attemptNumber?: number;
  },
): Promise<{ attempt: PlanningWorkerAttempt; providerRequestId: string }> {
  const providerRequestId = `prov-${opts.planningRequestId}`;
  const claim = h.leaseStore.claim({
    workspaceId: WORKSPACE_ID,
    missionId: MISSION_ID,
    planningRequestId: opts.planningRequestId,
    ownerId: "worker-1",
    now: h.clock(),
    leaseDurationMs: 60_000,
    mintLeaseId: mintIdFactory("lease"),
  });
  assert.ok(claim.ok);
  if (!claim.ok) throw new Error("unreachable");

  const created = h.attemptStore.create({
    workspaceId: WORKSPACE_ID,
    missionId: MISSION_ID,
    planningRequestId: opts.planningRequestId,
    leaseId: claim.lease.leaseId,
    fencingToken: claim.lease.fencingToken,
    workerIdentity: "worker-1",
    modelConfigurationId: "planner-config-1",
    attemptKind: "initial",
    attemptNumber: opts.attemptNumber ?? 1,
    contextHash: "hash-1",
    correlationId: "corr-1",
    now: h.clock(),
    mintId: mintIdFactory("attempt"),
  });

  const diagnostic = await h.diagnostics.store({
    workspaceId: WORKSPACE_ID,
    missionId: MISSION_ID,
    planningRequestId: opts.planningRequestId,
    workerAttemptId: providerRequestId,
    modelConfigurationId: "planner-config-1",
    providerRequestId,
    contextHash: "hash-1",
    stage: "invocation",
    promptMetadataSummary: "0 constraints, 0 snippets",
    detail: opts.rawOutputText,
    createdAt: h.clock(),
  });

  const digest = await computeReplayableResponseDigest(opts.rawOutputText);
  await h.replayStore.store({
    workerAttemptId: providerRequestId,
    workspaceId: WORKSPACE_ID,
    missionId: MISSION_ID,
    planningRequestId: opts.planningRequestId,
    modelConfigurationId: "planner-config-1",
    schemaVersion: PLANNING_MODEL_PLAN_SCHEMA_VERSION,
    redactedRawOutput: opts.rawOutputText,
    outputDigest: digest,
    createdAt: h.clock(),
  });

  h.attemptStore.attachProviderRequestId(created.workerAttemptId, created.fencingToken, providerRequestId);
  h.attemptStore.transition(created.workerAttemptId, created.fencingToken, "response_received", h.clock());
  h.attemptStore.transition(created.workerAttemptId, created.fencingToken, opts.state, h.clock());
  h.attemptStore.attachDiagnosticRef(created.workerAttemptId, created.fencingToken, diagnostic.ref);

  const attempt = h.attemptStore.get(created.workerAttemptId);
  assert.ok(attempt);
  return { attempt: attempt!, providerRequestId };
}

function deps(h: Harness): RecoveryExecutorDeps {
  return {
    workspaceId: WORKSPACE_ID,
    requestPort: h.port,
    leaseStore: h.leaseStore,
    attemptStore: h.attemptStore,
    diagnosticsStore: h.diagnostics,
    replayableResponseStore: h.replayStore,
    availableProviders: [fullyCapableProvider("codex")],
    planValidationContext: validationContext(),
    createdBy: "human-1",
    clock: h.clock,
    mintId: mintIdFactory("recovery"),
  };
}

// ---------------------------------------------------------------------------
// Task C — executeRerunDeterministicPipeline
// ---------------------------------------------------------------------------

test("rerun: successful stored material produces a real completed Plan, no model call needed", async () => {
  const h = makeHarness();
  await bootstrapMission(h.missionStore);
  await createPlanningRequest(h.missionStore, "preq-1", "hash-1");
  const { attempt } = await seedCrashedAttempt(h, { planningRequestId: "preq-1", state: "response_received", rawOutputText: JSON.stringify(validRawOutput()) });
  const lease = h.leaseStore.peek(WORKSPACE_ID, MISSION_ID, "preq-1");
  assert.ok(lease);

  const result = await executeRerunDeterministicPipeline(deps(h), { attempt, lease: { leaseId: lease!.leaseId, fencingToken: lease!.fencingToken } });
  assert.ok(result.ok);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.outcome, "completed");
  assert.ok(result.resultingPlanId);

  const snapshot = await h.port.loadSnapshot(WORKSPACE_ID, MISSION_ID);
  assert.equal(snapshot?.planningRequests["preq-1"].status, "completed");
});

test("rerun: refuses missing_replay_material when no stored replay row exists for the attempt", async () => {
  const h = makeHarness();
  await bootstrapMission(h.missionStore);
  await createPlanningRequest(h.missionStore, "preq-1", "hash-1");
  const { attempt } = await seedCrashedAttempt(h, { planningRequestId: "preq-1", state: "response_received", rawOutputText: JSON.stringify(validRawOutput()) });
  // Simulate the store never having been written (Task B's own gap being closed) by pointing at a store with no rows.
  const emptyDeps = deps(h);
  emptyDeps.replayableResponseStore = new InMemoryPlanningReplayableResponseStore();
  const lease = h.leaseStore.peek(WORKSPACE_ID, MISSION_ID, "preq-1")!;
  const result = await executeRerunDeterministicPipeline(emptyDeps, { attempt, lease: { leaseId: lease.leaseId, fencingToken: lease.fencingToken } });
  assert.deepEqual(result, { ok: false, reason: "missing_replay_material" });
});

test("rerun: refuses digest_mismatch rather than proceeding against unverified material", async () => {
  const h = makeHarness();
  await bootstrapMission(h.missionStore);
  await createPlanningRequest(h.missionStore, "preq-1", "hash-1");
  const { attempt, providerRequestId } = await seedCrashedAttempt(h, { planningRequestId: "preq-1", state: "response_received", rawOutputText: JSON.stringify(validRawOutput()) });
  // Craft a store whose row's outputDigest does not match its own redactedRawOutput content.
  const tamperedStore = new InMemoryPlanningReplayableResponseStore();
  await tamperedStore.store({
    workerAttemptId: providerRequestId,
    workspaceId: WORKSPACE_ID,
    missionId: MISSION_ID,
    planningRequestId: "preq-1",
    modelConfigurationId: "planner-config-1",
    schemaVersion: PLANNING_MODEL_PLAN_SCHEMA_VERSION,
    redactedRawOutput: JSON.stringify(validRawOutput()),
    outputDigest: "not-the-real-digest",
    createdAt: h.clock(),
  });
  const tamperedDeps = deps(h);
  tamperedDeps.replayableResponseStore = tamperedStore;
  const lease = h.leaseStore.peek(WORKSPACE_ID, MISSION_ID, "preq-1")!;
  const result = await executeRerunDeterministicPipeline(tamperedDeps, { attempt, lease: { leaseId: lease.leaseId, fencingToken: lease.fencingToken } });
  assert.deepEqual(result, { ok: false, reason: "digest_mismatch" });
});

test("rerun: refuses model_call_still_required when the attempt never received a response", async () => {
  const h = makeHarness();
  await bootstrapMission(h.missionStore);
  await createPlanningRequest(h.missionStore, "preq-1", "hash-1");
  const claim = h.leaseStore.claim({ workspaceId: WORKSPACE_ID, missionId: MISSION_ID, planningRequestId: "preq-1", ownerId: "worker-1", now: h.clock(), leaseDurationMs: 60_000, mintLeaseId: mintIdFactory("lease") });
  assert.ok(claim.ok);
  if (!claim.ok) throw new Error("unreachable");
  const created = h.attemptStore.create({ workspaceId: WORKSPACE_ID, missionId: MISSION_ID, planningRequestId: "preq-1", leaseId: claim.lease.leaseId, fencingToken: claim.lease.fencingToken, workerIdentity: "worker-1", modelConfigurationId: "planner-config-1", attemptKind: "initial", attemptNumber: 1, contextHash: "hash-1", correlationId: "corr-1", now: h.clock(), mintId: mintIdFactory("attempt") });
  const attempt = h.attemptStore.get(created.workerAttemptId)!;
  const result = await executeRerunDeterministicPipeline(deps(h), { attempt, lease: { leaseId: claim.lease.leaseId, fencingToken: claim.lease.fencingToken } });
  assert.deepEqual(result, { ok: false, reason: "model_call_still_required" });
});

test("rerun: refuses lease_fence_invalid for a stale fencing token, never writing a result", async () => {
  const h = makeHarness();
  await bootstrapMission(h.missionStore);
  await createPlanningRequest(h.missionStore, "preq-1", "hash-1");
  const { attempt } = await seedCrashedAttempt(h, { planningRequestId: "preq-1", state: "response_received", rawOutputText: JSON.stringify(validRawOutput()) });
  const result = await executeRerunDeterministicPipeline(deps(h), { attempt, lease: { leaseId: "wrong-lease", fencingToken: 999 } });
  assert.deepEqual(result, { ok: false, reason: "lease_fence_invalid" });
  const snapshot = await h.port.loadSnapshot(WORKSPACE_ID, MISSION_ID);
  assert.equal(snapshot?.planningRequests["preq-1"].status, "requested");
});

// ---------------------------------------------------------------------------
// Task D — executeReplayPersistence
// ---------------------------------------------------------------------------

test("replay: not-yet-terminal request replays recordModelPlanningResult using the derived idempotency key", async () => {
  const h = makeHarness();
  await bootstrapMission(h.missionStore);
  await createPlanningRequest(h.missionStore, "preq-1", "hash-1");
  const { attempt } = await seedCrashedAttempt(h, { planningRequestId: "preq-1", state: "recording_result", rawOutputText: JSON.stringify(validRawOutput()) });
  const lease = h.leaseStore.peek(WORKSPACE_ID, MISSION_ID, "preq-1")!;

  const result = await executeReplayPersistence(deps(h), { attempt, lease: { leaseId: lease.leaseId, fencingToken: lease.fencingToken } });
  assert.ok(result.ok);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.outcome, "completed");
  const snapshot = await h.port.loadSnapshot(WORKSPACE_ID, MISSION_ID);
  assert.equal(snapshot?.planningRequests["preq-1"].status, "completed");
});

test("replay: already-terminal request short-circuits as already_complete without a second command call", async () => {
  const h = makeHarness();
  await bootstrapMission(h.missionStore);
  await createPlanningRequest(h.missionStore, "preq-1", "hash-1");
  const { attempt } = await seedCrashedAttempt(h, { planningRequestId: "preq-1", state: "recording_result", rawOutputText: JSON.stringify(validRawOutput()) });
  const lease = h.leaseStore.peek(WORKSPACE_ID, MISSION_ID, "preq-1")!;

  // First call actually records the result (request becomes completed).
  const first = await executeReplayPersistence(deps(h), { attempt, lease: { leaseId: lease.leaseId, fencingToken: lease.fencingToken } });
  assert.ok(first.ok);

  // Re-fetch the attempt (transitioned to a terminal state by the first call) and reclaim a lease for the "recovery runs again" scenario.
  const attemptAfter = h.attemptStore.get(attempt.workerAttemptId)!;
  const second = await executeReplayPersistence(deps(h), { attempt: attemptAfter, lease: null });
  assert.deepEqual(second, { ok: true, outcome: "already_complete", resultingPlanId: null });
});

test("replay: refuses missing_diagnostic when the attempt has no diagnosticRef to anchor identity", async () => {
  const h = makeHarness();
  await bootstrapMission(h.missionStore);
  await createPlanningRequest(h.missionStore, "preq-1", "hash-1");
  const { attempt } = await seedCrashedAttempt(h, { planningRequestId: "preq-1", state: "recording_result", rawOutputText: JSON.stringify(validRawOutput()) });
  const withoutDiagRef: PlanningWorkerAttempt = { ...attempt, diagnosticRef: null };
  const lease = h.leaseStore.peek(WORKSPACE_ID, MISSION_ID, "preq-1")!;
  const result = await executeReplayPersistence(deps(h), { attempt: withoutDiagRef, lease: { leaseId: lease.leaseId, fencingToken: lease.fencingToken } });
  assert.deepEqual(result, { ok: false, reason: "missing_diagnostic" });
});

test("replay: refuses model_call_still_required when the attempt never received a response", async () => {
  const h = makeHarness();
  await bootstrapMission(h.missionStore);
  await createPlanningRequest(h.missionStore, "preq-1", "hash-1");
  const claim = h.leaseStore.claim({ workspaceId: WORKSPACE_ID, missionId: MISSION_ID, planningRequestId: "preq-1", ownerId: "worker-1", now: h.clock(), leaseDurationMs: 60_000, mintLeaseId: mintIdFactory("lease") });
  assert.ok(claim.ok);
  if (!claim.ok) throw new Error("unreachable");
  const created = h.attemptStore.create({ workspaceId: WORKSPACE_ID, missionId: MISSION_ID, planningRequestId: "preq-1", leaseId: claim.lease.leaseId, fencingToken: claim.lease.fencingToken, workerIdentity: "worker-1", modelConfigurationId: "planner-config-1", attemptKind: "initial", attemptNumber: 1, contextHash: "hash-1", correlationId: "corr-1", now: h.clock(), mintId: mintIdFactory("attempt") });
  const attempt = h.attemptStore.get(created.workerAttemptId)!;
  const result = await executeReplayPersistence(deps(h), { attempt, lease: { leaseId: claim.lease.leaseId, fencingToken: claim.lease.fencingToken } });
  assert.deepEqual(result, { ok: false, reason: "model_call_still_required" });
});

// ---------------------------------------------------------------------------
// Task E — outcome_unknown guard: neither executor is ever invoked for
// `unsafe_requires_new_attempt_decision`.
// ---------------------------------------------------------------------------

test("guard: recoverPlanningAttempts never routes an unsafe_requires_new_attempt_decision attempt to either executor, even in a batch alongside a rerun-eligible attempt", async () => {
  const h = makeHarness();
  await bootstrapMission(h.missionStore);
  await createPlanningRequest(h.missionStore, "preq-1", "hash-1");

  // A second `RequestModelPlanning` proposal on the SAME mission would
  // supersede "preq-1" outright — `findOutstandingPlanningRequestForSlot`
  // keys a "slot" by missionId + kind, not by targetPlanVersion, so two
  // outstanding proposal requests on one mission are mutually exclusive by
  // design. A second, independent MISSION keeps both requests live side by
  // side, which is what this test needs to prove the guard is selective
  // within one batch, not just correct in isolation.
  const MISSION_ID_2 = "m-2";
  await bootstrapMission(h.missionStore, MISSION_ID_2);
  {
    const events = await h.missionStore.loadEvents(MISSION_ID_2);
    const { projectMission } = await import("../src/lib/mission/mission-projection.ts");
    const projection = projectMission(MISSION_ID_2, events);
    const command: MissionCommand = {
      type: "RequestModelPlanning",
      missionId: MISSION_ID_2,
      planningRequestId: "preq-2",
      kind: "proposal",
      targetPlanVersion: 1,
      basePlanId: null,
      modelConfigurationId: "planner-config-1",
      planningCapabilities: CAPABLE_CAPABILITIES,
      contextHash: "hash-1",
      maxAttempts: 3,
    };
    const result = applyMissionCommand({ current: projection, command, context: ctx(), expectedVersion: events[events.length - 1]?.aggregateVersion ?? 0, priorOutcome: null, mintEventId: mintIdFactory("evt") });
    assert.ok(result.ok);
    if (!result.ok) throw new Error("unreachable");
    await h.missionStore.append({ missionId: MISSION_ID_2, expectedVersion: events[events.length - 1]?.aggregateVersion ?? 0, events: result.events });
  }

  // Attempt 1: providerRequestId known, responseReceivedAt still null -> classifyRecoveryAction's rule (5), ALWAYS wins, before any other rule.
  // Built directly (not via seedCrashedAttempt, which always advances through
  // "response_received") so responseReceivedAt genuinely stays null.
  // Shared mint-id counters across both attempts below — each fixture must
  // get a genuinely distinct workerAttemptId/leaseId, which a freshly
  // constructed `mintIdFactory(...)` closure per call would NOT guarantee
  // (both would start back at "-1" and collide in the stores' Maps).
  const mintAttemptId = mintIdFactory("attempt");
  const mintLeaseId = mintIdFactory("lease");

  const claimOne = h.leaseStore.claim({ workspaceId: WORKSPACE_ID, missionId: MISSION_ID, planningRequestId: "preq-1", ownerId: "worker-1", now: h.clock(), leaseDurationMs: 60_000, mintLeaseId });
  assert.ok(claimOne.ok);
  if (!claimOne.ok) throw new Error("unreachable");
  const createdUnsafe = h.attemptStore.create({ workspaceId: WORKSPACE_ID, missionId: MISSION_ID, planningRequestId: "preq-1", leaseId: claimOne.lease.leaseId, fencingToken: claimOne.lease.fencingToken, workerIdentity: "worker-1", modelConfigurationId: "planner-config-1", attemptKind: "initial", attemptNumber: 1, contextHash: "hash-1", correlationId: "corr-1", now: h.clock(), mintId: mintAttemptId });
  h.attemptStore.transition(createdUnsafe.workerAttemptId, createdUnsafe.fencingToken, "invoking", h.clock());
  h.attemptStore.attachProviderRequestId(createdUnsafe.workerAttemptId, createdUnsafe.fencingToken, "prov-preq-1");
  // Release the lease so recovery treats it as expired/gone (the case recovery exists for).
  h.leaseStore.release(WORKSPACE_ID, MISSION_ID, "preq-1", claimOne.lease.leaseId, claimOne.lease.fencingToken);
  const unsafeAttempt = h.attemptStore.get(createdUnsafe.workerAttemptId)!;
  assert.equal(unsafeAttempt.providerRequestId, "prov-preq-1");
  assert.equal(unsafeAttempt.responseReceivedAt, null, "fixture sanity: rule (5) requires responseReceivedAt still null");

  // Attempt 2: on the SECOND mission, response received, state
  // response_received -> rerun_deterministic_pipeline_only, a REAL executor
  // call, batched together with attempt 1 in the same `recoverPlanningAttempts` run.
  const claimTwo = h.leaseStore.claim({ workspaceId: WORKSPACE_ID, missionId: MISSION_ID_2, planningRequestId: "preq-2", ownerId: "worker-1", now: h.clock(), leaseDurationMs: 60_000, mintLeaseId });
  assert.ok(claimTwo.ok);
  if (!claimTwo.ok) throw new Error("unreachable");
  const createdRerun = h.attemptStore.create({ workspaceId: WORKSPACE_ID, missionId: MISSION_ID_2, planningRequestId: "preq-2", leaseId: claimTwo.lease.leaseId, fencingToken: claimTwo.lease.fencingToken, workerIdentity: "worker-1", modelConfigurationId: "planner-config-1", attemptKind: "initial", attemptNumber: 1, contextHash: "hash-1", correlationId: "corr-2", now: h.clock(), mintId: mintAttemptId });
  const rawText = JSON.stringify(validRawOutput());
  const digest = await computeReplayableResponseDigest(rawText);
  await h.replayStore.store({ workerAttemptId: "prov-preq-2", workspaceId: WORKSPACE_ID, missionId: MISSION_ID_2, planningRequestId: "preq-2", modelConfigurationId: "planner-config-1", schemaVersion: PLANNING_MODEL_PLAN_SCHEMA_VERSION, redactedRawOutput: rawText, outputDigest: digest, createdAt: h.clock() });
  h.attemptStore.attachProviderRequestId(createdRerun.workerAttemptId, createdRerun.fencingToken, "prov-preq-2");
  h.attemptStore.transition(createdRerun.workerAttemptId, createdRerun.fencingToken, "response_received", h.clock());
  // Deliberately NOT released: `classifyRecoveryAction`'s liveness check
  // (rule 4) compares the LEASE'S OWN `expiresAt` against the `now` passed to
  // `recoverPlanningAttempts` below (far in the future, past the 60s lease
  // duration) — so this still classifies as non-live/eligible for recovery
  // without needing an explicit release. Leaving it "active" is what lets the
  // executor's OWN fencing check (`isFencingTokenCurrent`, evaluated against
  // `deps.clock()`, which is still ticking near the fixture's early
  // timestamps) find a genuinely current, non-released lease — matching the
  // "rerun: successful stored material..." test's fixture pattern above.
  const seededRerun = h.attemptStore.get(createdRerun.workerAttemptId)!;

  // Sanity: classifyRecoveryAction independently agrees with what the batch run below must produce.
  const snapshotOne = await h.port.loadSnapshot(WORKSPACE_ID, MISSION_ID);
  const classifiedUnsafe = classifyRecoveryAction({
    attempt: unsafeAttempt,
    lease: null,
    requestSnapshot: { request: snapshotOne!.planningRequests["preq-1"], missionTerminal: false },
    now: Date.parse("2026-09-15T00:10:00.000Z"),
  });
  assert.equal(classifiedUnsafe, "unsafe_requires_new_attempt_decision" as RecoveryAction);

  // Run the REAL runner-dispatch path (Task E) with executorDeps supplied —
  // this is the actual production wiring, not a locally-simulated switch.
  const results = await recoverPlanningAttempts(h.attemptStore, h.leaseStore, h.port, Date.parse("2026-09-15T00:10:00.000Z"), deps(h));

  const unsafeResult = results.find((r) => r.attempt.workerAttemptId === unsafeAttempt.workerAttemptId);
  assert.ok(unsafeResult);
  assert.equal(unsafeResult!.action, "unsafe_requires_new_attempt_decision");
  assert.equal(unsafeResult!.executorResult, undefined, "unsafe_requires_new_attempt_decision must never carry an executorResult — proves neither executor was routed to for it");

  const rerunResult = results.find((r) => r.attempt.workerAttemptId === seededRerun.workerAttemptId);
  assert.ok(rerunResult);
  assert.equal(rerunResult!.action, "rerun_deterministic_pipeline_only");
  assert.ok(rerunResult!.executorResult, "the rerun-eligible attempt in the SAME batch must actually be routed to an executor, proving the guard is selective, not a blanket no-op");
  assert.equal(rerunResult!.executorResult!.ok, true);
});
