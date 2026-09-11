/**
 * SupabasePlanningReplayableResponseStore — RPC-argument-shape verification
 * against a fake SupabaseClient (Phase 5E Task B), mirroring the boundary
 * mission-planning-diagnostics-store-supabase.test.ts draws: no real
 * Postgres instance in this environment, so the UNIQUE-constraint / digest-
 * conflict enforcement itself lives in and is only provable against the
 * migration's SQL function. What's verified here: the RPC receives exactly
 * the arguments it needs, and every returned status/reason (ok/created,
 * ok/idempotent_replay, refused/digest_conflict) is mapped into the same
 * StoreReplayableResponseResult contract the in-memory store exposes.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { SupabasePlanningReplayableResponseStore } from "../src/lib/mission/mission-planning-replayable-response-store-supabase.ts";
import type { StoreReplayableResponseInput } from "../src/lib/mission/mission-planning-replayable-response-store.ts";

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

function baseInput(overrides: Partial<StoreReplayableResponseInput> = {}): StoreReplayableResponseInput {
  return {
    workerAttemptId: "attempt-1",
    workspaceId: "ws-1",
    missionId: "m-1",
    planningRequestId: "preq-1",
    modelConfigurationId: "cfg-1",
    schemaVersion: 1,
    redactedRawOutput: '{"interpretedObjective":"fix it"}',
    outputDigest: "digest-a",
    createdAt: "2026-07-26T00:00:00.000Z",
    ...overrides,
  };
}

function responseRow(overrides: Record<string, unknown> = {}) {
  return {
    worker_attempt_id: "attempt-1",
    workspace_id: "ws-1",
    mission_id: "m-1",
    planning_request_id: "preq-1",
    model_configuration_id: "cfg-1",
    schema_version: 1,
    redacted_raw_output: '{"interpretedObjective":"fix it"}',
    output_digest: "digest-a",
    created_at: "2026-07-26T00:00:00.000Z",
    ...overrides,
  };
}

test("store() sends every identity/content field the RPC needs and maps a fresh 'created' row", async () => {
  const { client, calls } = fakeClient({ rpcResult: { data: [{ status: "ok", reason: "created", response: responseRow() }], error: null } });
  const store = new SupabasePlanningReplayableResponseStore(client);
  const result = await store.store(baseInput());

  assert.equal(result.status, "ok");
  assert.equal(result.reason, "created");
  assert.equal(result.response.workerAttemptId, "attempt-1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].rpcName, "create_mission_planning_replayable_response");
  const args = calls[0].rpcArgs as Record<string, unknown>;
  assert.equal(args.p_worker_attempt_id, "attempt-1");
  assert.equal(args.p_workspace_id, "ws-1");
  assert.equal(args.p_mission_id, "m-1");
  assert.equal(args.p_planning_request_id, "preq-1");
  assert.equal(args.p_model_configuration_id, "cfg-1");
  assert.equal(args.p_schema_version, 1);
  assert.equal(args.p_redacted_raw_output, baseInput().redactedRawOutput);
  assert.equal(args.p_output_digest, "digest-a");
});

test("store() maps an 'ok'/'idempotent_replay' row through unchanged", async () => {
  const { client } = fakeClient({ rpcResult: { data: [{ status: "ok", reason: "idempotent_replay", response: responseRow() }], error: null } });
  const store = new SupabasePlanningReplayableResponseStore(client);
  const result = await store.store(baseInput());
  assert.equal(result.status, "ok");
  assert.equal(result.reason, "idempotent_replay");
});

test("store() maps a 'refused'/'digest_conflict' row to a non-throwing refused result carrying the EXISTING stored material", async () => {
  const { client } = fakeClient({
    rpcResult: { data: [{ status: "refused", reason: "digest_conflict", response: responseRow({ output_digest: "digest-original" }) }], error: null },
  });
  const store = new SupabasePlanningReplayableResponseStore(client);
  const result = await store.store(baseInput({ redactedRawOutput: "different content", outputDigest: "digest-new" }));
  assert.equal(result.status, "refused");
  assert.equal(result.reason, "digest_conflict");
  // The refusal carries the ORIGINAL stored digest back, not the caller's new one — proves no silent overwrite.
  assert.equal(result.response.outputDigest, "digest-original");
});

test("get() returns null when the RPC finds nothing, and maps a real row otherwise", async () => {
  const notFound = fakeClient({ rpcResult: { data: [], error: null } });
  const storeA = new SupabasePlanningReplayableResponseStore(notFound.client);
  assert.equal(await storeA.get("ws-1", "attempt-missing"), null);

  const found = fakeClient({ rpcResult: { data: responseRow(), error: null } });
  const storeB = new SupabasePlanningReplayableResponseStore(found.client);
  const record = await storeB.get("ws-1", "attempt-1");
  assert.ok(record);
  assert.equal(record?.workerAttemptId, "attempt-1");
  assert.equal(record?.schemaVersion, 1);
});

test("a Supabase-level error on store() is surfaced, never swallowed", async () => {
  const { client } = fakeClient({ rpcResult: { data: null, error: { message: "boom" } } });
  const store = new SupabasePlanningReplayableResponseStore(client);
  await assert.rejects(() => store.store(baseInput()), /boom/);
});

test("a Supabase-level error on get() is surfaced, never swallowed", async () => {
  const { client } = fakeClient({ rpcResult: { data: null, error: { message: "boom-get" } } });
  const store = new SupabasePlanningReplayableResponseStore(client);
  await assert.rejects(() => store.get("ws-1", "attempt-1"), /boom-get/);
});
