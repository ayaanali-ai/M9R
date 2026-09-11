/**
 * Phase 5D Priority 4 — diagnostic store / worker ordering coherence.
 * ----------------------------------------------------------------------------
 * Confirms (does not re-implement) audit finding #11: the worker always
 * calls `diagnosticsStore.store()` BEFORE it ever calls
 * `requestPort.recordModelPlanningResult()` with that diagnostic's ref, and
 * if `store()` throws, the worker aborts before the port is ever reached —
 * so a non-null `redactedDiagnosticRef` is never handed to
 * `RecordModelPlanningResult` for a diagnostic that doesn't actually exist.
 *
 * UPDATE: the idempotency gap this file originally called out is now closed.
 * `InMemoryPlanningDiagnosticsStore.store()` now derives a stable
 * `idempotencyKey` (workspaceId + missionId + planningRequestId +
 * workerAttemptId + diagnosticKind + stage + contextHash) and enforces
 * dedup-by-key: a same-identity/same-content retry returns the original
 * record; a same-identity/different-content retry throws
 * `DiagnosticIdempotencyConflictError` rather than overwriting. See
 * `scripts/mission-planning-diagnostics-idempotency.test.ts` for the
 * dedicated coverage of that behavior — this file's own scope (call-order
 * coherence between the diagnostics store and `recordModelPlanningResult`)
 * is unchanged.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { applyMissionCommand } from "../src/lib/mission/mission-command-handler.ts";
import { resolveCommandContext, type MissionCommand, type CommandOutcomeRecord } from "../src/lib/mission/mission-commands.ts";
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
import { InMemoryPlanningDiagnosticsStore, type PlanningDiagnosticInput, type PlanningDiagnosticRecord } from "../src/lib/mission/mission-planning-diagnostics-store.ts";
import { PlanningModelRegistry } from "../src/lib/mission/mission-planning-model-registry.ts";
import { FakePlanningModelClient, type ScriptedInvocation } from "../src/lib/mission/mission-planning-model-client.ts";
import { MissionPlanningWorker, type ProcessPlanningRequestInput } from "../src/lib/mission/mission-planning-worker.ts";

const MISSION_ID = "m-diag-1";
const WORKSPACE_ID = "ws-diag-1";

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

function provider(id: string): PlannerProviderDescriptor {
  return {
    id,
    capabilities: { non_interactive_execution: true, repository_editing: true, structured_output: true, streaming_output: true, cancellation: false, session_resume: false, usage_reporting: true, tool_event_reporting: true, approval_requests: false, image_input: false, interactive_session: false },
  };
}

function validationContext(): PlanValidationContext {
  return { missionScope: { allowedPaths: ["."], prohibitedPaths: [] }, missionBudget: { maxDurationMs: 600_000, maxEstimatedTokens: 100_000 }, availableApprovalAuthorities: ["human"] };
}

function validRawOutput(): RawModelPlanOutput {
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
  };
}

function planningContextInput(): PlanningContextInput {
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
  };
}

async function setupMissionWithRequest(missionStore: InMemoryMissionStore, contextHash: string): Promise<void> {
  const created = applyMissionCommand({
    current: null,
    command: { type: "CreateMission", missionId: MISSION_ID, workspaceId: WORKSPACE_ID, repository: "acme/app", goal: "goal", mode: "solo" },
    context: ctx(),
    expectedVersion: 0,
    priorOutcome: null,
    mintEventId: mintIdFactory("evt"),
  });
  assert.ok(created.ok);
  if (!created.ok) throw new Error("unreachable");
  await missionStore.append({ missionId: MISSION_ID, expectedVersion: 0, events: created.events });

  const events = await missionStore.loadEvents(MISSION_ID);
  const { projectMission } = await import("../src/lib/mission/mission-projection.ts");
  const projection = projectMission(MISSION_ID, events);
  const command: MissionCommand = {
    type: "RequestModelPlanning",
    missionId: MISSION_ID,
    planningRequestId: "preq-1",
    kind: "proposal",
    targetPlanVersion: 1,
    basePlanId: null,
    modelConfigurationId: "planner-config-1",
    planningCapabilities: CAPABLE_CAPABILITIES,
    contextHash,
    maxAttempts: 2,
  };
  const result = applyMissionCommand({ current: projection, command, context: ctx(), expectedVersion: events[events.length - 1]?.aggregateVersion ?? 0, priorOutcome: null, mintEventId: mintIdFactory("evt") });
  assert.ok(result.ok);
  if (!result.ok) throw new Error("unreachable");
  await missionStore.append({ missionId: MISSION_ID, expectedVersion: events[events.length - 1]?.aggregateVersion ?? 0, events: result.events });
}

test("diagnostic is stored BEFORE recordModelPlanningResult is called, and if store() throws the port is never reached", async () => {
  const missionStore = new InMemoryMissionStore();
  const idempotencyStore = new InMemoryIdempotencyStore<CommandOutcomeRecord>();
  const port = new PlanningRequestPortImpl(missionStore, idempotencyStore);
  const leaseStore = new InMemoryPlanningLeaseStore();
  const registry = new PlanningModelRegistry();
  let tick = 0;
  const clock = () => new Date(Date.parse("2026-09-15T00:00:00.000Z") + tick++ * 1000).toISOString();

  const contextInput = planningContextInput();
  const built = await buildPlanningContext(contextInput);
  await setupMissionWithRequest(missionStore, built.contextHash);

  const script: ScriptedInvocation[] = [{ outcome: "success", rawOutputText: JSON.stringify(validRawOutput()), finishReason: "stop" }];
  const client = new FakePlanningModelClient({ capabilities: { schemaVersionsSupported: [MODEL_PLAN_OUTPUT_SCHEMA_VERSION], supportsCancellation: false, supportsDeterministicSampling: true, maxOutputTokens: 4000 }, modelIdentifier: "fake-model-1", script });
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
  });

  // ---- call order tracing: wrap both diagnosticsStore.store and port.recordModelPlanningResult ----
  const callOrder: string[] = [];
  const diagnostics = new InMemoryPlanningDiagnosticsStore();
  const originalStore = diagnostics.store.bind(diagnostics);
  let interceptedRecord: PlanningDiagnosticRecord | null = null;
  diagnostics.store = async (input: PlanningDiagnosticInput) => {
    callOrder.push("diagnostic_store");
    const record = await originalStore(input);
    interceptedRecord = record;
    return record;
  };
  const originalRecord = port.recordModelPlanningResult.bind(port);
  port.recordModelPlanningResult = async (input) => {
    callOrder.push("record_model_planning_result");
    // The ref passed here must already correspond to a real, previously stored diagnostic.
    if (input.redactedDiagnosticRef !== null) {
      assert.ok(interceptedRecord, "recordModelPlanningResult was called with a non-null ref before any diagnostic was stored");
      assert.equal(input.redactedDiagnosticRef, (interceptedRecord as PlanningDiagnosticRecord).ref);
    }
    return originalRecord(input);
  };

  const worker = new MissionPlanningWorker({
    workspaceId: WORKSPACE_ID,
    ownerId: "worker-1",
    registry,
    requestPort: port,
    leaseStore,
    diagnosticsStore: diagnostics,
    clock,
    mintId: mintIdFactory("id"),
  });

  const input: ProcessPlanningRequestInput = {
    missionId: MISSION_ID,
    planningRequestId: "preq-1",
    contextInput,
    planValidationContext: validationContext(),
    availableProviders: [provider("codex")],
    createdBy: "human-1",
  };

  const result = await worker.process(input);
  assert.equal(result.finalState, "completed");
  // diagnostic_store must appear before record_model_planning_result in the trace.
  const diagIdx = callOrder.indexOf("diagnostic_store");
  const recordIdx = callOrder.indexOf("record_model_planning_result");
  assert.ok(diagIdx >= 0 && recordIdx >= 0 && diagIdx < recordIdx, `expected diagnostic_store before record_model_planning_result, got: ${callOrder.join(",")}`);
});

test("if diagnosticsStore.store() throws, the worker aborts BEFORE ever calling recordModelPlanningResult", async () => {
  const missionStore = new InMemoryMissionStore();
  const idempotencyStore = new InMemoryIdempotencyStore<CommandOutcomeRecord>();
  const port = new PlanningRequestPortImpl(missionStore, idempotencyStore);
  const leaseStore = new InMemoryPlanningLeaseStore();
  const registry = new PlanningModelRegistry();
  let tick = 0;
  const clock = () => new Date(Date.parse("2026-09-15T00:00:00.000Z") + tick++ * 1000).toISOString();

  const contextInput = planningContextInput();
  const built = await buildPlanningContext(contextInput);
  await setupMissionWithRequest(missionStore, built.contextHash);

  const script: ScriptedInvocation[] = [{ outcome: "success", rawOutputText: JSON.stringify(validRawOutput()), finishReason: "stop" }];
  const client = new FakePlanningModelClient({ capabilities: { schemaVersionsSupported: [MODEL_PLAN_OUTPUT_SCHEMA_VERSION], supportsCancellation: false, supportsDeterministicSampling: true, maxOutputTokens: 4000 }, modelIdentifier: "fake-model-1", script });
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
  });

  let recordCalled = false;
  const diagnostics = new InMemoryPlanningDiagnosticsStore();
  diagnostics.store = async () => {
    throw new Error("simulated diagnostic store failure");
  };
  const originalRecord = port.recordModelPlanningResult.bind(port);
  port.recordModelPlanningResult = async (input) => {
    recordCalled = true;
    return originalRecord(input);
  };

  const worker = new MissionPlanningWorker({
    workspaceId: WORKSPACE_ID,
    ownerId: "worker-1",
    registry,
    requestPort: port,
    leaseStore,
    diagnosticsStore: diagnostics,
    clock,
    mintId: mintIdFactory("id"),
  });

  const input: ProcessPlanningRequestInput = {
    missionId: MISSION_ID,
    planningRequestId: "preq-1",
    contextInput,
    planValidationContext: validationContext(),
    availableProviders: [provider("codex")],
    createdBy: "human-1",
  };

  await assert.rejects(() => worker.process(input));
  assert.equal(recordCalled, false, "recordModelPlanningResult must never be called after diagnosticsStore.store() throws");
});
