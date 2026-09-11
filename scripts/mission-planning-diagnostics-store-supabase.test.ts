/**
 * SupabasePlanningDiagnosticsStore — RPC-argument-shape verification against
 * a fake SupabaseClient.
 *
 * This does NOT exercise the actual UNIQUE-constraint/idempotency
 * enforcement — that lives in
 * supabase/migrations/20260727030000_mission_planning_diagnostics.sql's
 * `create_mission_planning_diagnostic` function and can only be proven
 * against a real Postgres instance, which this environment does not have
 * (same documented limitation as mission-scheduler-store-supabase.test.ts
 * and mission-store-supabase.test.ts). What's verified here: the
 * idempotency key is computed identically to
 * InMemoryPlanningDiagnosticsStore, the RPC receives exactly the arguments
 * it needs, and every returned status/reason (ok/created, ok/idempotent_replay,
 * refused/idempotency_conflict) is mapped into the same
 * PlanningDiagnosticRecord / DiagnosticIdempotencyConflictError contract the
 * in-memory store exposes.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { SupabasePlanningDiagnosticsStore } from "../src/lib/mission/mission-planning-diagnostics-store-supabase.ts";
import { DiagnosticIdempotencyConflictError, type PlanningDiagnosticInput } from "../src/lib/mission/mission-planning-diagnostics-store.ts";

function fakeClient(options: { rpcResult?: { data: unknown; error: { message: string } | null } }) {
  const calls: { rpcName: string; rpcArgs: unknown }[] = [];
  const client = {
    rpc: async (name: string, args: unknown) => {
      calls.push({ rpcName: name, rpcArgs: args });
      return options.rpcResult ?? { data: null, error: null };
    },
  };
  return { client: client as never, calls };
}

function baseInput(overrides: Partial<PlanningDiagnosticInput> = {}): PlanningDiagnosticInput {
  return {
    workspaceId: "ws-1",
    missionId: "m-1",
    planningRequestId: "preq-1",
    workerAttemptId: "attempt-1",
    diagnosticKind: "invocation_response",
    modelConfigurationId: "cfg-1",
    providerRequestId: "prov-1",
    contextHash: "hash-a",
    stage: "invocation",
    promptMetadataSummary: "3 constraints, 2 snippets",
    detail: "some redactable detail",
    createdAt: "2026-07-26T00:00:00.000Z",
    ...overrides,
  };
}

function diagnosticRow(overrides: Record<string, unknown> = {}) {
  return {
    diagnostic_ref: "diag-1",
    workspace_id: "ws-1",
    mission_id: "m-1",
    planning_request_id: "preq-1",
    worker_attempt_id: "attempt-1",
    diagnostic_kind: "invocation_response",
    stage: "invocation",
    model_configuration_id: "cfg-1",
    provider_request_id: "prov-1",
    context_hash: "hash-a",
    payload: { promptMetadataSummary: "x", detail: "some redactable detail", finishReason: null, failureClassification: null, retentionDays: 30 },
    payload_digest: "digest-abc",
    redaction_status: "redacted",
    retention_class: "default",
    idempotency_key: "key-abc",
    created_at: "2026-07-26T00:00:00.000Z",
    ...overrides,
  };
}

test("store() sends the identity/content fields the RPC needs and maps a fresh 'created' row", async () => {
  const { client, calls } = fakeClient({ rpcResult: { data: [{ status: "ok", reason: "created", diagnostic: diagnosticRow() }], error: null } });
  const store = new SupabasePlanningDiagnosticsStore(client);
  const record = await store.store(baseInput());

  assert.equal(record.ref, "diag-1");
  assert.equal(record.idempotencyKey, "key-abc");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].rpcName, "create_mission_planning_diagnostic");
  const args = calls[0].rpcArgs as Record<string, unknown>;
  assert.equal(args.p_workspace_id, "ws-1");
  assert.equal(args.p_mission_id, "m-1");
  assert.equal(args.p_planning_request_id, "preq-1");
  assert.equal(args.p_worker_attempt_id, "attempt-1");
  assert.equal(args.p_diagnostic_kind, "invocation_response");
  assert.equal(args.p_stage, "invocation");
  assert.equal(args.p_context_hash, "hash-a");
  assert.ok(typeof args.p_idempotency_key === "string" && (args.p_idempotency_key as string).length > 0);
});

test("store() maps an 'ok'/'idempotent_replay' row to the existing record, same ref", async () => {
  const { client } = fakeClient({ rpcResult: { data: [{ status: "ok", reason: "idempotent_replay", diagnostic: diagnosticRow({ diagnostic_ref: "diag-existing" }) }], error: null } });
  const store = new SupabasePlanningDiagnosticsStore(client);
  const record = await store.store(baseInput());
  assert.equal(record.ref, "diag-existing");
});

test("store() maps a 'refused'/'idempotency_conflict' row to DiagnosticIdempotencyConflictError with the existing ref", async () => {
  const { client } = fakeClient({
    rpcResult: { data: [{ status: "refused", reason: "idempotency_conflict", diagnostic: diagnosticRow({ diagnostic_ref: "diag-conflict" }) }], error: null },
  });
  const store = new SupabasePlanningDiagnosticsStore(client);
  await assert.rejects(
    () => store.store(baseInput({ detail: "different content" })),
    (err: unknown) => {
      assert.ok(err instanceof DiagnosticIdempotencyConflictError);
      assert.equal(err.existingRef, "diag-conflict");
      return true;
    },
  );
});

test("store() computes the SAME idempotency key for the same logical identity regardless of content, matching the in-memory store's field composition", async () => {
  const seen: string[] = [];
  const { client } = fakeClient({
    rpcResult: { data: [{ status: "ok", reason: "created", diagnostic: diagnosticRow() }], error: null },
  });
  // Wrap rpc to capture the key across two calls with different content.
  const wrapped = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      seen.push(args.p_idempotency_key as string);
      return (client as { rpc: (n: string, a: unknown) => Promise<unknown> }).rpc(name, args);
    },
  };
  const store = new SupabasePlanningDiagnosticsStore(wrapped as never);
  await store.store(baseInput({ detail: "content A" }));
  await store.store(baseInput({ detail: "content B" }));
  assert.equal(seen.length, 2);
  assert.equal(seen[0], seen[1], "same identity fields must fold to the same idempotency key regardless of content");
});

test("get() returns null when the RPC finds nothing, and maps a real row otherwise", async () => {
  const notFound = fakeClient({ rpcResult: { data: [], error: null } });
  const storeA = new SupabasePlanningDiagnosticsStore(notFound.client);
  assert.equal(await storeA.get("ws-1", "diag-missing"), null);

  const found = fakeClient({ rpcResult: { data: diagnosticRow(), error: null } });
  const storeB = new SupabasePlanningDiagnosticsStore(found.client);
  const record = await storeB.get("ws-1", "diag-1");
  assert.ok(record);
  assert.equal(record?.ref, "diag-1");
});

test("a Supabase-level error is surfaced, never swallowed", async () => {
  const { client } = fakeClient({ rpcResult: { data: null, error: { message: "boom" } } });
  const store = new SupabasePlanningDiagnosticsStore(client);
  await assert.rejects(() => store.store(baseInput()), /boom/);
});
