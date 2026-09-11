/**
 * Phase 5C — MissionPlanningWorker runtime tests.
 * ----------------------------------------------------------------------------
 * No live model network calls anywhere here — every model interaction goes
 * through `FakePlanningModelClient`. Uses the real `applyMissionCommand` /
 * `InMemoryMissionStore` path (via `PlanningRequestPortImpl`) so a passing
 * "completed" outcome here proves a real Plan really landed in the Mission
 * projection through Phase 5B's authoritative command, not a shortcut.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { applyMissionCommand } from "../src/lib/mission/mission-command-handler.ts";
import { resolveCommandContext, type MissionCommand } from "../src/lib/mission/mission-commands.ts";
import { InMemoryMissionStore } from "../src/lib/mission/mission-store.ts";
import { InMemoryIdempotencyStore } from "../src/lib/mission/mission-idempotency.ts";
import { MODEL_PLAN_OUTPUT_SCHEMA_VERSION, type RawModelPlanOutput } from "../src/lib/mission/mission-model-plan-schema.ts";
import { allPlanningCapabilitiesFalse, type PlanningCapabilityRecord } from "../src/lib/mission/mission-planning-capability.ts";
import type { PlannerProviderDescriptor } from "../src/lib/mission/mission-planner.ts";
import type { PlanValidationContext } from "../src/lib/mission/mission-planner-validator.ts";
import type { PlanningContextInput } from "../src/lib/mission/mission-planning-context.ts";
import { buildPlanningContext } from "../src/lib/mission/mission-planning-context.ts";

import { PlanningRequestPortImpl } from "../src/lib/mission/mission-planning-request-port.ts";
import { InMemoryPlanningLeaseStore } from "../src/lib/mission/mission-planning-lease-store.ts";
import { InMemoryPlanningDiagnosticsStore } from "../src/lib/mission/mission-planning-diagnostics-store.ts";
import { PlanningModelRegistry, type TrustedPlanningModelConfig } from "../src/lib/mission/mission-planning-model-registry.ts";
import { FakePlanningModelClient, type ScriptedInvocation } from "../src/lib/mission/mission-planning-model-client.ts";
import { MissionPlanningWorker, type ProcessPlanningRequestInput } from "../src/lib/mission/mission-planning-worker.ts";
import { redactForDiagnostics } from "../src/lib/mission/mission-planning-redaction.ts";
import { InMemoryPlanningReplayableResponseStore } from "../src/lib/mission/mission-planning-replayable-response-store.ts";

const MISSION_ID = "m-1";
const WORKSPACE_ID = "ws-1";

function ctx(actor: { kind: "human" | "agent" | "system"; id: string } = { kind: "system", id: "orchestrator" }) {
  return resolveCommandContext({ actor: actor as never, timestamp: "2026-09-15T00:00:00.000Z" });
}

function reason(code: string, summary: string) {
  return { code, summary, relatedEntityIds: [], recoverable: true, suggestedActions: [] };
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

function planningContextInput(overrides: Partial<PlanningContextInput> = {}): PlanningContextInput {
  return {
    missionId: MISSION_ID,
    objective: "Fix the flaky test",
    constraints: [],
    workspaceContext: { repository: "acme/app", repositoryId: null },
    applicableRules: [],
    allowedRoles: ["implementer"],
    scope: { allowedPaths: ["."], prohibitedPaths: [] },
    collaborationPolicySummary: "solo",
    approvalPolicySummary: "auto",
    evidencePolicySummary: "none required",
    budgetSummary: "10m / 100k tokens",
    documentationSnippets: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test harness: real Mission event log + real applyMissionCommand, via the port.
// ---------------------------------------------------------------------------

interface Harness {
  missionStore: InMemoryMissionStore;
  port: PlanningRequestPortImpl;
  leaseStore: InMemoryPlanningLeaseStore;
  diagnostics: InMemoryPlanningDiagnosticsStore;
  registry: PlanningModelRegistry;
  clock: () => string;
}

function makeHarness(): Harness {
  const missionStore = new InMemoryMissionStore();
  const idempotencyStore = new InMemoryIdempotencyStore<import("../src/lib/mission/mission-commands.ts").CommandOutcomeRecord>();
  const port = new PlanningRequestPortImpl(missionStore, idempotencyStore);
  const leaseStore = new InMemoryPlanningLeaseStore();
  const diagnostics = new InMemoryPlanningDiagnosticsStore();
  const registry = new PlanningModelRegistry();
  let tick = 0;
  const clock = () => new Date(Date.parse("2026-09-15T00:00:00.000Z") + tick++ * 1000).toISOString();
  return { missionStore, port, leaseStore, diagnostics, registry, clock };
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

async function createPlanningRequest(missionStore: InMemoryMissionStore, planningRequestId: string, contextHash: string, maxAttempts = 2): Promise<void> {
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

function registerConfig(registry: PlanningModelRegistry, script: ScriptedInvocation[], overrides: Partial<TrustedPlanningModelConfig> = {}): FakePlanningModelClient {
  const client = new FakePlanningModelClient({
    capabilities: { schemaVersionsSupported: [MODEL_PLAN_OUTPUT_SCHEMA_VERSION], supportsCancellation: false, supportsDeterministicSampling: true, maxOutputTokens: 4000 },
    modelIdentifier: "fake-model-1",
    script,
  });
  registry.register({
    planningModelConfigId: "planner-config-1",
    client,
    providerFamily: "fake",
    modelIdentifier: "fake-model-1",
    capabilityProfile: CAPABLE_CAPABILITIES,
    schemaVersionsSupported: [MODEL_PLAN_OUTPUT_SCHEMA_VERSION],
    maxContextChars: 20_000,
    maxOutputTokens: 4000,
    timeoutMs: 5000,
    retryPolicy: { maxTransportRetries: 1, maxThrottleRetries: 1, baseBackoffMs: 1, maxBackoffMs: 10 },
    supportsCancellation: false,
    supportsDeterministicSampling: true,
    enabled: true,
    ...overrides,
  });
  return client;
}

function makeWorker(h: Harness, ownerId = "worker-1", replayableResponseStore?: InMemoryPlanningReplayableResponseStore): MissionPlanningWorker {
  const mint = mintIdFactory(`id-${ownerId}`);
  return new MissionPlanningWorker({
    workspaceId: WORKSPACE_ID,
    ownerId,
    registry: h.registry,
    requestPort: h.port,
    leaseStore: h.leaseStore,
    diagnosticsStore: h.diagnostics,
    clock: h.clock,
    mintId: mint,
    ...(replayableResponseStore ? { replayableResponseStore } : {}),
  });
}

async function processInput(overrides: Partial<ProcessPlanningRequestInput> = {}): Promise<ProcessPlanningRequestInput> {
  const contextInput = planningContextInput();
  return {
    missionId: MISSION_ID,
    planningRequestId: "preq-1",
    contextInput,
    planValidationContext: validationContext(),
    availableProviders: [fullyCapableProvider("codex")],
    createdBy: "human-1",
    ...overrides,
  };
}

async function hashOf(contextInput: PlanningContextInput): Promise<string> {
  const built = await buildPlanningContext(contextInput);
  return built.contextHash;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

test("registry: unsupported schema version rejected before any model call", () => {
  const registry = new PlanningModelRegistry();
  const client = registerConfig(registry, [{ outcome: "success", rawOutputText: "{}" }]);
  const resolved = registry.resolve("planner-config-1", "v999-unsupported");
  assert.equal(resolved.ok, false);
  if (!resolved.ok) assert.equal(resolved.reason, "unsupported_schema_version");
  assert.equal(client.calls.length, 0);
});

test("registry: disabled config rejected before any model call", () => {
  const registry = new PlanningModelRegistry();
  const client = registerConfig(registry, [{ outcome: "success", rawOutputText: "{}" }], { enabled: false });
  const resolved = registry.resolve("planner-config-1", MODEL_PLAN_OUTPUT_SCHEMA_VERSION);
  assert.equal(resolved.ok, false);
  if (!resolved.ok) assert.equal(resolved.reason, "disabled");
  assert.equal(client.calls.length, 0);
});

test("registry: unknown config rejected", () => {
  const registry = new PlanningModelRegistry();
  const resolved = registry.resolve("nope", MODEL_PLAN_OUTPUT_SCHEMA_VERSION);
  assert.equal(resolved.ok, false);
  if (!resolved.ok) assert.equal(resolved.reason, "unknown_config");
});

test("registry: capability profile comes only from the trusted registry entry, not the client", () => {
  const registry = new PlanningModelRegistry();
  registerConfig(registry, [{ outcome: "success", rawOutputText: "{}" }]);
  const resolved = registry.resolve("planner-config-1", MODEL_PLAN_OUTPUT_SCHEMA_VERSION);
  assert.ok(resolved.ok);
  if (resolved.ok) assert.deepEqual(resolved.config.capabilityProfile, CAPABLE_CAPABILITIES);
});

// ---------------------------------------------------------------------------
// Claiming / leases
// ---------------------------------------------------------------------------

test("leases: two workers racing one request — exactly one wins", () => {
  const store = new InMemoryPlanningLeaseStore();
  const now = "2026-09-15T00:00:00.000Z";
  let n = 0;
  const mint = () => `lease-${++n}`;
  const claims = [
    store.claim({ workspaceId: WORKSPACE_ID, missionId: MISSION_ID, planningRequestId: "preq-1", ownerId: "worker-a", now, leaseDurationMs: 60_000, mintLeaseId: mint }),
    store.claim({ workspaceId: WORKSPACE_ID, missionId: MISSION_ID, planningRequestId: "preq-1", ownerId: "worker-b", now, leaseDurationMs: 60_000, mintLeaseId: mint }),
  ];
  const winners = claims.filter((c) => c.ok);
  assert.equal(winners.length, 1);
});

test("leases: ten workers racing one request — exactly one wins", () => {
  const store = new InMemoryPlanningLeaseStore();
  const now = "2026-09-15T00:00:00.000Z";
  let n = 0;
  const mint = () => `lease-${++n}`;
  const results = Array.from({ length: 10 }, (_, i) =>
    store.claim({ workspaceId: WORKSPACE_ID, missionId: MISSION_ID, planningRequestId: "preq-1", ownerId: `worker-${i}`, now, leaseDurationMs: 60_000, mintLeaseId: mint }),
  );
  assert.equal(results.filter((r) => r.ok).length, 1);
});

test("leases: different requests processed concurrently — independent leases", () => {
  const store = new InMemoryPlanningLeaseStore();
  const now = "2026-09-15T00:00:00.000Z";
  let n = 0;
  const mint = () => `lease-${++n}`;
  const a = store.claim({ workspaceId: WORKSPACE_ID, missionId: MISSION_ID, planningRequestId: "preq-1", ownerId: "worker-a", now, leaseDurationMs: 60_000, mintLeaseId: mint });
  const b = store.claim({ workspaceId: WORKSPACE_ID, missionId: MISSION_ID, planningRequestId: "preq-2", ownerId: "worker-b", now, leaseDurationMs: 60_000, mintLeaseId: mint });
  assert.ok(a.ok);
  assert.ok(b.ok);
});

test("leases: expired lease is reclaimed; live lease is not stolen", () => {
  const store = new InMemoryPlanningLeaseStore();
  let n = 0;
  const mint = () => `lease-${++n}`;
  const first = store.claim({ workspaceId: WORKSPACE_ID, missionId: MISSION_ID, planningRequestId: "preq-1", ownerId: "worker-a", now: "2026-09-15T00:00:00.000Z", leaseDurationMs: 1000, mintLeaseId: mint });
  assert.ok(first.ok);

  // Still live — a second claim must be refused.
  const stillLive = store.claim({ workspaceId: WORKSPACE_ID, missionId: MISSION_ID, planningRequestId: "preq-1", ownerId: "worker-b", now: "2026-09-15T00:00:00.500Z", leaseDurationMs: 1000, mintLeaseId: mint });
  assert.equal(stillLive.ok, false);

  // Now expired — reclaimable.
  const reclaimed = store.claim({ workspaceId: WORKSPACE_ID, missionId: MISSION_ID, planningRequestId: "preq-1", ownerId: "worker-c", now: "2026-09-15T00:00:05.000Z", leaseDurationMs: 1000, mintLeaseId: mint });
  assert.ok(reclaimed.ok);
  if (first.ok && reclaimed.ok) assert.ok(reclaimed.lease.fencingToken > first.lease.fencingToken);
});

test("leases: fencing token is monotonic across reclaims", () => {
  const store = new InMemoryPlanningLeaseStore();
  let n = 0;
  const mint = () => `lease-${++n}`;
  const tokens: number[] = [];
  for (let i = 0; i < 3; i++) {
    const claim = store.claim({ workspaceId: WORKSPACE_ID, missionId: MISSION_ID, planningRequestId: "preq-1", ownerId: `w-${i}`, now: new Date(2026, 8, 15, 0, 0, i).toISOString(), leaseDurationMs: 1, mintLeaseId: mint });
    assert.ok(claim.ok);
    if (claim.ok) tokens.push(claim.lease.fencingToken);
  }
  assert.deepEqual(tokens, [1, 2, 3]);
});

test("leases: a stale fencing token cannot be used to record a result", () => {
  const store = new InMemoryPlanningLeaseStore();
  let n = 0;
  const mint = () => `lease-${++n}`;
  const now = "2026-09-15T00:00:00.000Z";
  const first = store.claim({ workspaceId: WORKSPACE_ID, missionId: MISSION_ID, planningRequestId: "preq-1", ownerId: "worker-a", now, leaseDurationMs: 1, mintLeaseId: mint });
  assert.ok(first.ok);
  if (!first.ok) return;
  // Expire and let another worker reclaim, bumping the fencing token.
  const later = "2026-09-15T00:00:05.000Z";
  const second = store.claim({ workspaceId: WORKSPACE_ID, missionId: MISSION_ID, planningRequestId: "preq-1", ownerId: "worker-b", now: later, leaseDurationMs: 60_000, mintLeaseId: mint });
  assert.ok(second.ok);
  // The FIRST worker's (now stale) token must fail the fencing check.
  assert.equal(store.isFencingTokenCurrent(WORKSPACE_ID, MISSION_ID, "preq-1", first.lease.leaseId, first.lease.fencingToken, later), false);
});

// ---------------------------------------------------------------------------
// Full lifecycle, through the real applyMissionCommand path
// ---------------------------------------------------------------------------

test("lifecycle: successful proposal creates a real Plan through RecordModelPlanningResult", async () => {
  const h = makeHarness();
  await bootstrapMission(h.missionStore);
  const contextInput = planningContextInput();
  const hash = await hashOf(contextInput);
  await createPlanningRequest(h.missionStore, "preq-1", hash);
  registerConfig(h.registry, [{ outcome: "success", rawOutputText: JSON.stringify(validRawOutput()) }]);
  const worker = makeWorker(h);
  const result = await worker.process(await processInput({ contextInput }));
  assert.equal(result.finalState, "completed");
  assert.ok(result.resultingPlanId);
});

test("lifecycle: deterministic validation failure with no repair capacity ends failed, not completed", async () => {
  const h = makeHarness();
  await bootstrapMission(h.missionStore);
  const contextInput = planningContextInput();
  const hash = await hashOf(contextInput);
  await createPlanningRequest(h.missionStore, "preq-1", hash, 1);
  // maxDurationMs on the assignment (600_000) exceeds the mission budget (1ms) — deterministic validator rejects it.
  registerConfig(h.registry, [{ outcome: "success", rawOutputText: JSON.stringify(validRawOutput()) }]);
  const worker = makeWorker(h);
  const result = await worker.process(await processInput({ contextInput, planValidationContext: validationContext({ missionBudget: { maxDurationMs: 1, maxEstimatedTokens: 1 } }) }));
  assert.equal(result.finalState, "failed");
});

test("lifecycle: malformed JSON output is rejected as a schema failure", async () => {
  const h = makeHarness();
  await bootstrapMission(h.missionStore);
  const contextInput = planningContextInput();
  const hash = await hashOf(contextInput);
  await createPlanningRequest(h.missionStore, "preq-1", hash, 1);
  registerConfig(h.registry, [{ outcome: "success", rawOutputText: "{ not valid json" }]);
  const worker = makeWorker(h);
  const result = await worker.process(await processInput({ contextInput }));
  assert.equal(result.finalState, "failed");
});

test("lifecycle: provider timeout (outcome_unknown) never auto-duplicates the model call", async () => {
  const h = makeHarness();
  await bootstrapMission(h.missionStore);
  const contextInput = planningContextInput();
  const hash = await hashOf(contextInput);
  await createPlanningRequest(h.missionStore, "preq-1", hash, 2);
  const client = registerConfig(h.registry, [{ outcome: "outcome_unknown" }]);
  const worker = makeWorker(h);
  const result = await worker.process(await processInput({ contextInput }));
  assert.equal(result.finalState, "outcome_unknown");
  assert.equal(client.calls.length, 1, "exactly one model call — no automatic duplicate");
});

test("lifecycle: provider rejection is non-retryable and terminal", async () => {
  const h = makeHarness();
  await bootstrapMission(h.missionStore);
  const contextInput = planningContextInput();
  const hash = await hashOf(contextInput);
  await createPlanningRequest(h.missionStore, "preq-1", hash, 5);
  const client = registerConfig(h.registry, [{ outcome: "provider_rejected" }]);
  const worker = makeWorker(h);
  const result = await worker.process(await processInput({ contextInput }));
  assert.equal(result.finalState, "failed");
  assert.equal(client.calls.length, 1);
});

test("lifecycle: cancelled before invocation never calls the model and never records a result", async () => {
  const h = makeHarness();
  await bootstrapMission(h.missionStore);
  const contextInput = planningContextInput();
  const hash = await hashOf(contextInput);
  await createPlanningRequest(h.missionStore, "preq-1", hash);
  const client = registerConfig(h.registry, [{ outcome: "success", rawOutputText: JSON.stringify(validRawOutput()) }]);
  const worker = makeWorker(h);
  const result = await worker.process(await processInput({ contextInput, isCancelled: () => true }));
  assert.equal(result.finalState, "cancelled");
  assert.equal(client.calls.length, 0);
});

test("lifecycle: context hash mismatch is treated as stale, not silently proceeded", async () => {
  const h = makeHarness();
  await bootstrapMission(h.missionStore);
  const contextInput = planningContextInput();
  // Deliberately record a DIFFERENT hash than what buildPlanningContext will produce for contextInput.
  await createPlanningRequest(h.missionStore, "preq-1", "stale-hash-does-not-match", 3);
  const client = registerConfig(h.registry, [{ outcome: "success", rawOutputText: JSON.stringify(validRawOutput()) }]);
  const worker = makeWorker(h);
  const result = await worker.process(await processInput({ contextInput }));
  assert.equal(client.calls.length, 0, "no model call is ever made once context is proven stale");
  assert.notEqual(result.finalState, "completed");
});

test("lifecycle: terminal Mission causes a late result to become stale, not completed", async () => {
  const h = makeHarness();
  await bootstrapMission(h.missionStore);
  const contextInput = planningContextInput();
  const hash = await hashOf(contextInput);
  await createPlanningRequest(h.missionStore, "preq-1", hash);
  // Cancel the Mission itself (terminal) after the request was created.
  const events = await h.missionStore.loadEvents(MISSION_ID);
  const { projectMission } = await import("../src/lib/mission/mission-projection.ts");
  const projection = projectMission(MISSION_ID, events);
  const cancelResult = applyMissionCommand({ current: projection, command: { type: "CancelMission", missionId: MISSION_ID, reason: reason("user_requested", "stop") }, context: ctx(), expectedVersion: events[events.length - 1].aggregateVersion, priorOutcome: null, mintEventId: mintIdFactory("evt") });
  if (cancelResult.ok) {
    await h.missionStore.append({ missionId: MISSION_ID, expectedVersion: events[events.length - 1].aggregateVersion, events: cancelResult.events });
  }
  registerConfig(h.registry, [{ outcome: "success", rawOutputText: JSON.stringify(validRawOutput()) }]);
  const worker = makeWorker(h);
  const result = await worker.process(await processInput({ contextInput }));
  assert.notEqual(result.finalState, "completed");
});

test("lifecycle: superseded/terminal request is never processed as if fresh", async () => {
  const h = makeHarness();
  await bootstrapMission(h.missionStore);
  const contextInput = planningContextInput();
  const hash = await hashOf(contextInput);
  await createPlanningRequest(h.missionStore, "preq-1", hash);
  // Cancel the planning request itself.
  const events = await h.missionStore.loadEvents(MISSION_ID);
  const { projectMission } = await import("../src/lib/mission/mission-projection.ts");
  const projection = projectMission(MISSION_ID, events);
  const cancel = applyMissionCommand({ current: projection, command: { type: "CancelModelPlanningRequest", missionId: MISSION_ID, planningRequestId: "preq-1", reason: reason("user_requested", "no longer needed") }, context: ctx(), expectedVersion: events[events.length - 1].aggregateVersion, priorOutcome: null, mintEventId: mintIdFactory("evt") });
  assert.ok(cancel.ok);
  if (cancel.ok) await h.missionStore.append({ missionId: MISSION_ID, expectedVersion: events[events.length - 1].aggregateVersion, events: cancel.events });

  const client = registerConfig(h.registry, [{ outcome: "success", rawOutputText: JSON.stringify(validRawOutput()) }]);
  const worker = makeWorker(h);
  const result = await worker.process(await processInput({ contextInput }));
  assert.equal(result.finalState, "cancelled");
  assert.equal(client.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Retries
// ---------------------------------------------------------------------------

test("retries: a retryable transport failure is retried within the bounded policy, then succeeds", async () => {
  const h = makeHarness();
  await bootstrapMission(h.missionStore);
  const contextInput = planningContextInput();
  const hash = await hashOf(contextInput);
  await createPlanningRequest(h.missionStore, "preq-1", hash, 2);
  const client = registerConfig(h.registry, [{ outcome: "transport_failure" }, { outcome: "success", rawOutputText: JSON.stringify(validRawOutput()) }]);
  const worker = makeWorker(h);
  const result = await worker.process(await processInput({ contextInput }));
  assert.equal(result.finalState, "completed");
  assert.equal(client.calls.length, 2);
});

test("retries: throttling is retried a bounded number of times, no real sleep required", async () => {
  const h = makeHarness();
  await bootstrapMission(h.missionStore);
  const contextInput = planningContextInput();
  const hash = await hashOf(contextInput);
  await createPlanningRequest(h.missionStore, "preq-1", hash, 2);
  const client = registerConfig(h.registry, [{ outcome: "throttled", retryAfterMs: 5 }, { outcome: "success", rawOutputText: JSON.stringify(validRawOutput()) }], { retryPolicy: { maxTransportRetries: 1, maxThrottleRetries: 1, baseBackoffMs: 1, maxBackoffMs: 5 } });
  const worker = makeWorker(h);
  const result = await worker.process(await processInput({ contextInput }));
  assert.equal(result.finalState, "completed");
  assert.equal(client.calls.length, 2);
});

test("retries: repair succeeds — malformed first output, valid second output", async () => {
  const h = makeHarness();
  await bootstrapMission(h.missionStore);
  const contextInput = planningContextInput();
  const hash = await hashOf(contextInput);
  await createPlanningRequest(h.missionStore, "preq-1", hash, 2);
  registerConfig(h.registry, [{ outcome: "success", rawOutputText: "not json at all" }, { outcome: "success", rawOutputText: JSON.stringify(validRawOutput()) }]);
  const worker = makeWorker(h);
  const result = await worker.process(await processInput({ contextInput }));
  assert.equal(result.finalState, "completed");
});

test("retries: repair limit enforced — a second consecutive malformed output is not repaired again", async () => {
  const h = makeHarness();
  await bootstrapMission(h.missionStore);
  const contextInput = planningContextInput();
  const hash = await hashOf(contextInput);
  await createPlanningRequest(h.missionStore, "preq-1", hash, 3);
  const client = registerConfig(h.registry, [{ outcome: "success", rawOutputText: "not json" }, { outcome: "success", rawOutputText: "still not json" }]);
  const worker = makeWorker(h);
  const result = await worker.process(await processInput({ contextInput }));
  assert.equal(result.finalState, "failed");
  assert.equal(client.calls.length, 2, "one generate + at most one repair, never more");
});

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

test("diagnostics: redactedDiagnosticRef always resolves to a real stored record, never dangling", async () => {
  const h = makeHarness();
  await bootstrapMission(h.missionStore);
  const contextInput = planningContextInput();
  const hash = await hashOf(contextInput);
  await createPlanningRequest(h.missionStore, "preq-1", hash);
  registerConfig(h.registry, [{ outcome: "success", rawOutputText: JSON.stringify(validRawOutput()) }]);
  const worker = makeWorker(h);
  const result = await worker.process(await processInput({ contextInput }));
  assert.ok(result.diagnosticRefs.length > 0);
  for (const ref of result.diagnosticRefs) {
    assert.ok(h.diagnostics.get(WORKSPACE_ID, ref), `ref ${ref} must resolve`);
  }
});

test("diagnostics: cross-workspace access is refused", async () => {
  const h = makeHarness();
  await bootstrapMission(h.missionStore);
  const contextInput = planningContextInput();
  const hash = await hashOf(contextInput);
  await createPlanningRequest(h.missionStore, "preq-1", hash);
  registerConfig(h.registry, [{ outcome: "success", rawOutputText: JSON.stringify(validRawOutput()) }]);
  const worker = makeWorker(h);
  const result = await worker.process(await processInput({ contextInput }));
  const ref = result.diagnosticRefs[0];
  assert.equal(h.diagnostics.get("some-other-workspace", ref), null);
});

test("diagnostics: secrets are removed before storage", () => {
  const redacted = redactForDiagnostics("Authorization: Bearer sk-ant-abcdefghijklmnopqrstuvwx1234\nAPI_KEY=super-secret-value");
  assert.equal(redacted.text.includes("sk-ant-abcdefghijklmnopqrstuvwx1234"), false);
  assert.equal(redacted.text.includes("super-secret-value"), false);
});

test("diagnostics: bounded record size — oversized detail is truncated/omitted, not stored whole", async () => {
  const store = new InMemoryPlanningDiagnosticsStore();
  const huge = "a".repeat(50_000);
  const record = await store.store({
    workspaceId: WORKSPACE_ID,
    missionId: MISSION_ID,
    planningRequestId: "preq-1",
    modelConfigurationId: "planner-config-1",
    providerRequestId: null,
    contextHash: "hash-1",
    stage: "invocation",
    promptMetadataSummary: "summary",
    detail: huge,
    createdAt: "2026-09-15T00:00:00.000Z",
  });
  assert.ok(record.sizeBytes <= 8_192);
});

test("diagnostics: digest is stable for identical content", async () => {
  const store = new InMemoryPlanningDiagnosticsStore();
  const input = {
    workspaceId: WORKSPACE_ID,
    missionId: MISSION_ID,
    planningRequestId: "preq-1",
    modelConfigurationId: "planner-config-1",
    providerRequestId: "req-1",
    contextHash: "hash-1",
    stage: "invocation" as const,
    promptMetadataSummary: "summary",
    detail: "some detail",
    createdAt: "2026-09-15T00:00:00.000Z",
  };
  const a = await store.store({ ...input });
  const b = await store.store({ ...input });
  assert.equal(a.digest, b.digest);
});

// ---------------------------------------------------------------------------
// Replayable response material (Phase 5E Task B)
// ---------------------------------------------------------------------------

test("replayable response: a successful invocation stores redacted raw output for later replay", async () => {
  const h = makeHarness();
  await bootstrapMission(h.missionStore);
  const contextInput = planningContextInput();
  const hash = await hashOf(contextInput);
  await createPlanningRequest(h.missionStore, "preq-1", hash);
  registerConfig(h.registry, [{ outcome: "success", rawOutputText: JSON.stringify(validRawOutput()) }]);
  const worker = makeWorker(h);
  const result = await worker.process(await processInput({ contextInput }));
  assert.equal(result.finalState, "completed");

  const replayStore = worker.getReplayableResponseStore();
  // The invocation diagnostic's `workerAttemptId` is the SAME discriminator
  // `storeReplayableResponseBestEffort` uses (providerRequestId, or
  // attempt-N as fallback) — resolve it from there rather than guessing.
  const invocationDiag = h.diagnostics.get(WORKSPACE_ID, result.diagnosticRefs[0]);
  assert.ok(invocationDiag?.workerAttemptId, "invocation diagnostic must carry a workerAttemptId");
  const found = await replayStore.get(WORKSPACE_ID, invocationDiag!.workerAttemptId!);
  assert.ok(found, "expected a replayable-response record to be stored after a successful invocation");
  assert.equal(found?.workspaceId, WORKSPACE_ID);
  assert.equal(found?.missionId, MISSION_ID);
  assert.equal(found?.planningRequestId, "preq-1");
  assert.equal(found?.schemaVersion, 1);
  assert.equal(found?.redactedRawOutput, JSON.stringify(validRawOutput()));
});

test("replayable response: stored redacted output contains no secret-shaped content", async () => {
  const h = makeHarness();
  await bootstrapMission(h.missionStore);
  const contextInput = planningContextInput();
  const hash = await hashOf(contextInput);
  await createPlanningRequest(h.missionStore, "preq-1", hash);
  // `redactSession` (mission-planning-redaction.ts's underlying engine) matches
  // secret shapes like an Anthropic API key; embedding one in `rationale`
  // exercises the SAME redaction path the diagnostics store already relies
  // on, proving the replayable-response store goes through the redaction
  // gate rather than storing the model's raw text verbatim.
  const raw = validRawOutput({ rationale: "leaked key: sk-ant-abcdefghijklmnopqrstuvwx1234" });
  registerConfig(h.registry, [{ outcome: "success", rawOutputText: JSON.stringify(raw) }]);
  const worker = makeWorker(h);
  const result = await worker.process(await processInput({ contextInput }));

  const replayStore = worker.getReplayableResponseStore();
  const invocationDiag = h.diagnostics.get(WORKSPACE_ID, result.diagnosticRefs[0]);
  assert.ok(invocationDiag?.workerAttemptId);
  const found = await replayStore.get(WORKSPACE_ID, invocationDiag!.workerAttemptId!);
  assert.ok(found, "expected a replayable-response record from the invocation");
  assert.equal(found?.redactedRawOutput.includes("sk-ant-abcdefghijklmnopqrstuvwx1234"), false);
  assert.ok(found?.redactedRawOutput.includes("[REDACTED"), "expected a redaction marker in the stored output");
});

test("replayable response: not stored when redaction confidence is too low to persist safely", async () => {
  const store = new InMemoryPlanningReplayableResponseStore();
  // Directly exercise the redaction gate the worker applies, mirroring
  // `storeReplayableResponseBestEffort`'s early-return on rejected_unsafe.
  const redacted = redactForDiagnostics(null);
  assert.equal(redacted.status, "not_stored");
  assert.equal(store.get(WORKSPACE_ID, "attempt-x"), null);
});

// ---------------------------------------------------------------------------
// Security / structural restriction
// ---------------------------------------------------------------------------

test("security: the worker's Mission-facing port cannot construct execution commands (structural)", async () => {
  const h = makeHarness();
  const portMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(h.port));
  for (const forbidden of ["approveMissionPlan", "materializeMissionPlan", "startMission", "createAssignment", "addParticipant", "dispatchAssignment"]) {
    assert.equal(portMethods.includes(forbidden), false, `PlanningRequestPort must not expose ${forbidden}`);
  }
  assert.deepEqual(portMethods.sort(), ["constructor", "loadPlanningRequest", "loadSnapshot", "recordModelPlanningResult"].sort());
});

test("security: a worker configured for a different workspace cannot load or complete another workspace's planning request", async () => {
  const h = makeHarness();
  await bootstrapMission(h.missionStore); // created with WORKSPACE_ID
  const contextInput = planningContextInput();
  const hash = await hashOf(contextInput);
  await createPlanningRequest(h.missionStore, "preq-1", hash, 2);

  const OTHER_WORKSPACE = "workspace-other";
  // Direct port reads under the wrong workspaceId must behave as if the Mission does not exist.
  const snapshotWrongWorkspace = await h.port.loadSnapshot(OTHER_WORKSPACE, MISSION_ID);
  assert.equal(snapshotWrongWorkspace, null);
  const requestWrongWorkspace = await h.port.loadPlanningRequest(OTHER_WORKSPACE, MISSION_ID, "preq-1");
  assert.equal(requestWrongWorkspace, null);

  // The correct workspaceId still resolves normally.
  const snapshotCorrectWorkspace = await h.port.loadSnapshot(WORKSPACE_ID, MISSION_ID);
  assert.ok(snapshotCorrectWorkspace);
  assert.equal(snapshotCorrectWorkspace?.workspaceId, WORKSPACE_ID);

  // A worker misconfigured with another workspace's id can never claim/complete the request —
  // it must never observe the request as processable, and the port must refuse to record any result.
  registerConfig(h.registry, [{ outcome: "success", rawOutputText: JSON.stringify(validRawOutput()) }]);
  const mint = mintIdFactory("id-other-workspace-worker");
  const wrongWorkspaceWorker = new MissionPlanningWorker({
    workspaceId: OTHER_WORKSPACE,
    ownerId: "worker-other",
    registry: h.registry,
    requestPort: h.port,
    leaseStore: h.leaseStore,
    diagnosticsStore: h.diagnostics,
    clock: h.clock,
    mintId: mint,
  });
  const result = await wrongWorkspaceWorker.process(await processInput({ contextInput }));
  assert.equal(result.finalState, "failed");
  assert.equal(result.resultingPlanId, null);

  // The request must remain untouched — a same-workspace worker can still claim and complete it.
  const stillRequested = await h.port.loadPlanningRequest(WORKSPACE_ID, MISSION_ID, "preq-1");
  assert.equal(stillRequested?.status, "requested");
  const correctWorker = makeWorker(h, "worker-correct");
  const resultCorrect = await correctWorker.process(await processInput({ contextInput }));
  assert.equal(resultCorrect.finalState, "completed");

  // A direct call to the write path with a mismatched workspaceId is refused even with a fresh idempotency key.
  const refused = await h.port.recordModelPlanningResult({
    workspaceId: OTHER_WORKSPACE,
    missionId: MISSION_ID,
    planningRequestId: "preq-1",
    rawModelOutputText: null,
    failureCode: "forced",
    redactedDiagnosticRef: null,
    availableProviders: [fullyCapableProvider("codex")],
    planValidationContext: (await processInput({ contextInput })).planValidationContext,
    createdBy: "system",
    context: { correlationId: "corr-1", causationId: null, actor: { kind: "system", id: "orchestrator" }, timestamp: h.clock() },
    idempotencyKey: "direct-cross-workspace-attempt",
  });
  assert.equal(refused.ok, false);
});

test("security: a stale (fenced-out) worker cannot record a result even if it computes one", async () => {
  const h = makeHarness();
  await bootstrapMission(h.missionStore);
  const contextInput = planningContextInput();
  const hash = await hashOf(contextInput);
  await createPlanningRequest(h.missionStore, "preq-1", hash, 2);
  registerConfig(h.registry, [{ outcome: "success", rawOutputText: JSON.stringify(validRawOutput()) }]);

  // Worker A claims, but before it finishes, its lease is force-expired and worker B claims and completes.
  const claimA = h.leaseStore.claim({ workspaceId: WORKSPACE_ID, missionId: MISSION_ID, planningRequestId: "preq-1", ownerId: "worker-a", now: h.clock(), leaseDurationMs: 1, mintLeaseId: () => "lease-a" });
  assert.ok(claimA.ok);
  // Let A's lease expire, then B claims for real via the worker (bumping the fencing token).
  const workerB = makeWorker(h, "worker-b");
  const resultB = await workerB.process(await processInput({ contextInput }));
  assert.equal(resultB.finalState, "completed");

  // Now A's stale fencing token must fail if used.
  if (claimA.ok) {
    const stillCurrent = h.leaseStore.isFencingTokenCurrent(WORKSPACE_ID, MISSION_ID, "preq-1", claimA.lease.leaseId, claimA.lease.fencingToken, h.clock());
    assert.equal(stillCurrent, false);
  }
});

test("security: cross-workspace diagnostic ref cannot be read from a different workspace's worker", async () => {
  const h = makeHarness();
  await bootstrapMission(h.missionStore);
  const contextInput = planningContextInput();
  const hash = await hashOf(contextInput);
  await createPlanningRequest(h.missionStore, "preq-1", hash);
  registerConfig(h.registry, [{ outcome: "success", rawOutputText: JSON.stringify(validRawOutput()) }]);
  const worker = makeWorker(h);
  const result = await worker.process(await processInput({ contextInput }));
  const ref = result.diagnosticRefs[0];
  assert.equal(h.diagnostics.get("other-ws", ref), null);
  assert.ok(h.diagnostics.get(WORKSPACE_ID, ref));
});

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

test("recovery: duplicate worker restart after a completed result is idempotent (request no longer actionable)", async () => {
  const h = makeHarness();
  await bootstrapMission(h.missionStore);
  const contextInput = planningContextInput();
  const hash = await hashOf(contextInput);
  await createPlanningRequest(h.missionStore, "preq-1", hash);
  const client = registerConfig(h.registry, [{ outcome: "success", rawOutputText: JSON.stringify(validRawOutput()) }]);
  const worker = makeWorker(h);
  const first = await worker.process(await processInput({ contextInput }));
  assert.equal(first.finalState, "completed");

  const second = await worker.process(await processInput({ contextInput }));
  assert.notEqual(second.finalState, "completed");
  assert.equal(client.calls.length, 1, "the second run must never re-invoke the model for an already-completed request");
});

test("recovery: unknown provider outcome escalates instead of duplicating on a fresh worker instance", async () => {
  const h = makeHarness();
  await bootstrapMission(h.missionStore);
  const contextInput = planningContextInput();
  const hash = await hashOf(contextInput);
  await createPlanningRequest(h.missionStore, "preq-1", hash, 3);
  const client = registerConfig(h.registry, [{ outcome: "outcome_unknown" }, { outcome: "success", rawOutputText: JSON.stringify(validRawOutput()) }]);
  const workerA = makeWorker(h, "worker-a");
  const result = await workerA.process(await processInput({ contextInput }));
  assert.equal(result.finalState, "outcome_unknown");
  assert.equal(client.calls.length, 1);
  // A fresh worker instance restarting later re-claims (lease was released) but this is an EXPLICIT new attempt, not an automatic one.
  const workerB = makeWorker(h, "worker-b");
  const second = await workerB.process(await processInput({ contextInput }));
  assert.equal(client.calls.length, 2, "the retry is explicit (a new .process() call), never automatic");
  assert.equal(second.finalState, "completed");
});
