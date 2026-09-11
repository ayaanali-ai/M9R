/**
 * DurablePlanningRequestPort — the Postgres-backed sibling of
 * `PlanningRequestPortImpl`, exercised against the same in-process
 * MissionEventReader/MissionCommandPersistence fake `mission-runtime-durable.test.ts`
 * uses (not a real Postgres — see mission-store-supabase.test.ts for the
 * RPC-shape tests).
 *
 * What's verified: the read path (loadSnapshot/loadPlanningRequest) projects
 * off `reader.loadEvents` the same way `runMissionCommandDurable` itself
 * does, the write path calls `runMissionCommandDurable` (proven via the
 * fake's `applyCommandCallCount`) rather than the in-memory `runMissionCommand`,
 * and the workspace-mismatch defense-in-depth check refuses before any write
 * is attempted.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { DurablePlanningRequestPort, WORKSPACE_MISMATCH_ERROR } from "../src/lib/mission/mission-planning-request-port.ts";
import { runMissionCommandDurable, type MissionEventReader } from "../src/lib/mission/mission-runtime-durable.ts";
import { resolveCommandContext } from "../src/lib/mission/mission-commands.ts";
import type { MissionCommand, CommandOutcomeRecord } from "../src/lib/mission/mission-commands.ts";
import { deriveIdempotencyKey } from "../src/lib/mission/mission-idempotency.ts";
import type { ApplyCommandPersistenceInput, ApplyCommandPersistenceResult, MissionCommandPersistence } from "../src/lib/mission/mission-command-persistence.ts";
import type { MissionEvent } from "../src/lib/mission/mission-events.ts";
import { CONCURRENCY_CONFLICT_STATUS } from "../src/lib/mission/mission-concurrency.ts";
import { allPlanningCapabilitiesFalse, type PlanningCapabilityRecord } from "../src/lib/mission/mission-planning-capability.ts";
import type { PlanValidationContext } from "../src/lib/mission/mission-planner-validator.ts";

const MISSION_ID = "m-1";
const WORKSPACE_ID = "ws-1";
const ACTOR = { kind: "system" as const, id: "orchestrator" as const };

let idCounter = 0;
function mintEventId(): string {
  idCounter += 1;
  return `evt-${idCounter}`;
}

function ctx() {
  return resolveCommandContext({ actor: ACTOR, timestamp: "2026-08-15T00:00:00.000Z" });
}

function keyFor(command: MissionCommand, extra?: string): string {
  return deriveIdempotencyKey({ missionId: command.missionId, commandType: command.type, payload: command, clientKey: extra });
}

/** Same in-process reader/persistence fake mission-runtime-durable.test.ts uses — an honest state machine, not a mocked response. */
class FakeDurableBackend implements MissionEventReader, MissionCommandPersistence {
  private events: MissionEvent[] = [];
  private outcomes = new Map<string, CommandOutcomeRecord>();
  applyCommandCallCount = 0;

  async loadEvents(): Promise<MissionEvent[]> {
    return [...this.events];
  }

  private scopedKey(workspaceId: string, idempotencyKey: string): string {
    return `${workspaceId}::${idempotencyKey}`;
  }

  async lookupOutcome(workspaceId: string, idempotencyKey: string): Promise<CommandOutcomeRecord | null> {
    return this.outcomes.get(this.scopedKey(workspaceId, idempotencyKey)) ?? null;
  }

  async applyCommand(input: ApplyCommandPersistenceInput): Promise<ApplyCommandPersistenceResult> {
    this.applyCommandCallCount += 1;

    const existing = this.outcomes.get(this.scopedKey(input.workspaceId, input.idempotencyKey));
    if (existing) {
      if (existing.payloadDigest !== input.payloadDigest) {
        return { status: "idempotency_conflict", message: "reused key, different payload" };
      }
      return { status: "replayed", aggregateVersion: existing.aggregateVersion, result: existing };
    }

    const currentVersion = this.events.length > 0 ? this.events[this.events.length - 1].aggregateVersion : 0;
    if (currentVersion !== input.expectedVersion) {
      return {
        status: "version_conflict",
        conflict: {
          status: CONCURRENCY_CONFLICT_STATUS,
          code: "version_conflict",
          missionId: input.missionId,
          expectedVersion: input.expectedVersion,
          currentVersion,
          latestEventCursor: this.events.length > 0 ? this.events[this.events.length - 1].eventId : null,
          message: "stale version",
        },
      };
    }

    this.events.push(...input.events);
    this.outcomes.set(this.scopedKey(input.workspaceId, input.idempotencyKey), input.result);
    return { status: "applied", aggregateVersion: input.result.aggregateVersion, result: input.result };
  }
}

const CAPABLE_CAPABILITIES: PlanningCapabilityRecord = { ...allPlanningCapabilitiesFalse(), structured_output: true, strict_json_schema: true, tool_free_generation: true };

function validationContext(): PlanValidationContext {
  return { missionScope: { allowedPaths: ["."], prohibitedPaths: [] }, missionBudget: { maxDurationMs: 600_000, maxEstimatedTokens: 100_000 }, availableApprovalAuthorities: ["human"] };
}

async function bootstrapMission(backend: FakeDurableBackend, workspaceId = WORKSPACE_ID): Promise<void> {
  const create: MissionCommand = { type: "CreateMission", missionId: MISSION_ID, workspaceId, repository: "acme/app", goal: "goal", mode: "solo" };
  const result = await runMissionCommandDurable({ reader: backend, persistence: backend, command: create, context: ctx(), idempotencyKey: keyFor(create), workspaceId, mintEventId });
  assert.ok(result.ok, "bootstrap CreateMission must succeed");
}

async function requestPlanning(backend: FakeDurableBackend, planningRequestId: string, maxAttempts = 2, workspaceId = WORKSPACE_ID): Promise<void> {
  const command: MissionCommand = {
    type: "RequestModelPlanning",
    missionId: MISSION_ID,
    planningRequestId,
    kind: "proposal",
    targetPlanVersion: 1,
    basePlanId: null,
    modelConfigurationId: "planner-config-1",
    planningCapabilities: CAPABLE_CAPABILITIES,
    contextHash: "hash-1",
    maxAttempts,
  };
  const result = await runMissionCommandDurable({ reader: backend, persistence: backend, command, context: ctx(), idempotencyKey: keyFor(command, planningRequestId), workspaceId, mintEventId });
  assert.ok(result.ok, "bootstrap RequestModelPlanning must succeed");
}

// ---------------------------------------------------------------------------
// Read path
// ---------------------------------------------------------------------------

test("loadSnapshot returns null for a Mission that does not exist (zero events)", async () => {
  const backend = new FakeDurableBackend();
  const port = new DurablePlanningRequestPort(backend, backend);
  assert.equal(await port.loadSnapshot(WORKSPACE_ID, MISSION_ID), null);
});

test("loadSnapshot returns null when the caller's workspaceId does not match the Mission's genesis workspaceId", async () => {
  const backend = new FakeDurableBackend();
  await bootstrapMission(backend, WORKSPACE_ID);
  const port = new DurablePlanningRequestPort(backend, backend);
  assert.equal(await port.loadSnapshot("some-other-workspace", MISSION_ID), null, "cross-workspace access must look identical to not-found");
});

test("loadSnapshot projects the real event log — planningRequests/terminal reflect a real RequestModelPlanning command", async () => {
  const backend = new FakeDurableBackend();
  await bootstrapMission(backend);
  await requestPlanning(backend, "preq-1");
  const port = new DurablePlanningRequestPort(backend, backend);

  const snapshot = await port.loadSnapshot(WORKSPACE_ID, MISSION_ID);
  assert.ok(snapshot);
  assert.equal(snapshot?.workspaceId, WORKSPACE_ID);
  assert.equal(snapshot?.terminal, false);
  assert.ok(snapshot?.planningRequests["preq-1"], "the requested planning request must appear in the projected snapshot");
  assert.equal(snapshot?.planningRequests["preq-1"].status, "requested");
});

test("loadPlanningRequest returns the specific record from the projected snapshot", async () => {
  const backend = new FakeDurableBackend();
  await bootstrapMission(backend);
  await requestPlanning(backend, "preq-1");
  const port = new DurablePlanningRequestPort(backend, backend);

  const record = await port.loadPlanningRequest(WORKSPACE_ID, MISSION_ID, "preq-1");
  assert.ok(record);
  assert.equal(record?.id, "preq-1");

  assert.equal(await port.loadPlanningRequest(WORKSPACE_ID, MISSION_ID, "does-not-exist"), null);
});

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

test("recordModelPlanningResult calls the durable path (persistence.applyCommand), not the in-memory one", async () => {
  const backend = new FakeDurableBackend();
  await bootstrapMission(backend);
  await requestPlanning(backend, "preq-1", 1);
  const port = new DurablePlanningRequestPort(backend, backend);
  const callsBeforeWrite = backend.applyCommandCallCount;

  const outcome = await port.recordModelPlanningResult({
    workspaceId: WORKSPACE_ID,
    missionId: MISSION_ID,
    planningRequestId: "preq-1",
    rawModelOutputText: null,
    failureCode: "model_error",
    redactedDiagnosticRef: null,
    availableProviders: [],
    planValidationContext: validationContext(),
    createdBy: "worker-1",
    context: ctx(),
    idempotencyKey: "record-1",
  });

  assert.equal(backend.applyCommandCallCount, callsBeforeWrite + 1, "the write must go through persistence.applyCommand exactly once, via runMissionCommandDurable");
  assert.ok(outcome.ok);
  if (outcome.ok) {
    // maxAttempts=1, one failed attempt exhausts the repair budget: terminal "failed".
    assert.equal(outcome.nextStatus, "failed");
    assert.equal(outcome.finalOutcome, "rejected");
  }

  const snapshot = await port.loadSnapshot(WORKSPACE_ID, MISSION_ID);
  assert.equal(snapshot?.planningRequests["preq-1"].status, "failed", "the durable write must be visible on the next read, through the same event log");
});

test("recordModelPlanningResult refuses with WORKSPACE_MISMATCH_ERROR before any write is attempted, when workspaceId does not match", async () => {
  const backend = new FakeDurableBackend();
  await bootstrapMission(backend, WORKSPACE_ID);
  await requestPlanning(backend, "preq-1", 1);
  const port = new DurablePlanningRequestPort(backend, backend);
  const callsBeforeAttempt = backend.applyCommandCallCount;

  const outcome = await port.recordModelPlanningResult({
    workspaceId: "wrong-workspace",
    missionId: MISSION_ID,
    planningRequestId: "preq-1",
    rawModelOutputText: null,
    failureCode: "model_error",
    redactedDiagnosticRef: null,
    availableProviders: [],
    planValidationContext: validationContext(),
    createdBy: "worker-1",
    context: ctx(),
    idempotencyKey: "record-2",
  });

  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    const error = outcome.error as { code: string };
    assert.equal(error.code, WORKSPACE_MISMATCH_ERROR);
  }
  assert.equal(backend.applyCommandCallCount, callsBeforeAttempt, "the defense-in-depth workspace check must refuse before runMissionCommandDurable/applyCommand is ever reached");
});
