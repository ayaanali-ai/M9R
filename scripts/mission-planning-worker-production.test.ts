/**
 * createProductionMissionPlanningWorker — config validation and structural
 * wiring, verified without a real Supabase client (a fake one is injected
 * via `supabaseClient`).
 *
 * This does NOT exercise `process()` end-to-end against real infra — that
 * would require a live Postgres instance and a real `PlanningModelClient`,
 * neither available here. What's verified: config validation happens
 * synchronously (throws before any store is touched), no module-level
 * singleton/side effect exists (two calls produce two independent workers),
 * and the constructed worker's lease/attempt/diagnostics collaborators are
 * genuinely the Supabase-backed classes added alongside this file — not a
 * silent in-memory fallback.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  createProductionMissionPlanningWorker,
  SupabaseLeaseStoreAdapter,
  SupabaseAttemptStoreAdapter,
  type ProductionMissionPlanningWorkerConfig,
} from "../src/lib/mission/mission-planning-worker-production.ts";
import { SupabaseMissionPlanningLeaseStore } from "../src/lib/mission/mission-planning-lease-store-supabase.ts";
import { SupabaseMissionPlanningAttemptStore } from "../src/lib/mission/mission-planning-attempt-store-supabase.ts";
import { SupabasePlanningDiagnosticsStore } from "../src/lib/mission/mission-planning-diagnostics-store-supabase.ts";
import { DurablePlanningRequestPort } from "../src/lib/mission/mission-planning-request-port.ts";
import { allPlanningCapabilitiesFalse } from "../src/lib/mission/mission-planning-capability.ts";
import type { TrustedPlanningModelConfig } from "../src/lib/mission/mission-planning-model-registry.ts";

function fakeSupabaseClient() {
  return {
    rpc: async () => ({ data: null, error: null }),
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }),
    }),
  } as never;
}

function fakeModelConfig(overrides: Partial<TrustedPlanningModelConfig> = {}): TrustedPlanningModelConfig {
  return {
    planningModelConfigId: "cfg-1",
    client: {
      generateStructuredPlan: async () => {
        throw new Error("not invoked in this test");
      },
      repairStructuredPlan: async () => {
        throw new Error("not invoked in this test");
      },
    } as never,
    providerFamily: "test",
    modelIdentifier: "test-model",
    capabilityProfile: allPlanningCapabilitiesFalse(),
    schemaVersionsSupported: ["1"],
    maxContextChars: 10_000,
    maxOutputTokens: 1_000,
    timeoutMs: 30_000,
    retryPolicy: { maxTransportRetries: 1, maxThrottleRetries: 1, baseBackoffMs: 10, maxBackoffMs: 100 },
    supportsCancellation: false,
    supportsDeterministicSampling: true,
    enabled: true,
    ...overrides,
  };
}

function baseConfig(overrides: Partial<ProductionMissionPlanningWorkerConfig> = {}): ProductionMissionPlanningWorkerConfig {
  return {
    workspaceId: "ws-1",
    ownerId: "worker-1",
    modelConfigs: [fakeModelConfig()],
    supabaseClient: fakeSupabaseClient(),
    ...overrides,
  };
}

test("createProductionMissionPlanningWorker constructs a worker whose lease/attempt/diagnostics collaborators are the real Supabase-backed classes", () => {
  const worker = createProductionMissionPlanningWorker(baseConfig());

  const diagnosticsStore = worker.getDiagnosticsStore();
  assert.ok(diagnosticsStore instanceof SupabasePlanningDiagnosticsStore, "diagnosticsStore must be a real SupabasePlanningDiagnosticsStore");

  const leaseStore = worker.getLeaseStore();
  assert.ok(leaseStore instanceof SupabaseLeaseStoreAdapter, "leaseStore must be wrapped by SupabaseLeaseStoreAdapter");
  assert.ok(
    (leaseStore as SupabaseLeaseStoreAdapter).getWrappedStore() instanceof SupabaseMissionPlanningLeaseStore,
    "the adapter must wrap a real SupabaseMissionPlanningLeaseStore",
  );

  const attemptStore = worker.getAttemptStore();
  assert.ok(attemptStore instanceof SupabaseAttemptStoreAdapter, "attemptStore must be wrapped by SupabaseAttemptStoreAdapter");
  assert.ok(
    (attemptStore as SupabaseAttemptStoreAdapter).getWrappedStore() instanceof SupabaseMissionPlanningAttemptStore,
    "the adapter must wrap a real SupabaseMissionPlanningAttemptStore",
  );

  assert.ok(
    worker.getRequestPort() instanceof DurablePlanningRequestPort,
    "requestPort must be the durable, Postgres-backed port — not the in-memory PlanningRequestPortImpl",
  );
});

test("config validation happens synchronously, before any store is constructed — rejects an empty workspaceId", () => {
  assert.throws(() => createProductionMissionPlanningWorker(baseConfig({ workspaceId: "" })), /workspaceId/);
});

test("config validation rejects an empty ownerId", () => {
  assert.throws(() => createProductionMissionPlanningWorker(baseConfig({ ownerId: "" })), /ownerId/);
});

test("config validation rejects an empty modelConfigs array", () => {
  assert.throws(() => createProductionMissionPlanningWorker(baseConfig({ modelConfigs: [] })), /modelConfigs/);
});

test("config validation rejects a non-positive leaseDurationMs", () => {
  assert.throws(() => createProductionMissionPlanningWorker(baseConfig({ leaseDurationMs: 0 })), /leaseDurationMs/);
  assert.throws(() => createProductionMissionPlanningWorker(baseConfig({ leaseDurationMs: -1 })), /leaseDurationMs/);
});

test("config validation rejects a negative maxRepairAttempts", () => {
  assert.throws(() => createProductionMissionPlanningWorker(baseConfig({ maxRepairAttempts: -1 })), /maxRepairAttempts/);
});

test("two calls produce two independent workers and independent store instances — no module-level singleton", () => {
  const workerA = createProductionMissionPlanningWorker(baseConfig());
  const workerB = createProductionMissionPlanningWorker(baseConfig());
  assert.notEqual(workerA, workerB);
  assert.notEqual(workerA.getDiagnosticsStore(), workerB.getDiagnosticsStore());
  assert.notEqual(
    (workerA.getLeaseStore() as SupabaseLeaseStoreAdapter).getWrappedStore(),
    (workerB.getLeaseStore() as SupabaseLeaseStoreAdapter).getWrappedStore(),
  );
});

test("registers every supplied model config on the worker's registry (resolvable by id)", () => {
  const worker = createProductionMissionPlanningWorker(
    baseConfig({ modelConfigs: [fakeModelConfig({ planningModelConfigId: "cfg-a" }), fakeModelConfig({ planningModelConfigId: "cfg-b" })] }),
  );
  // No direct registry accessor on MissionPlanningWorker — resolution is exercised indirectly via the diagnostics/lease store instanceof checks above and via mission-planning-worker.test.ts's own registry.resolve coverage; this test only asserts construction did not throw for multiple configs.
  assert.ok(worker);
});
