/**
 * SupabaseMissionPlanningAttemptStore — RPC-argument-shape verification
 * against a fake SupabaseClient. Mirrors
 * mission-planning-diagnostics-store-supabase.test.ts's structure.
 *
 * This does NOT exercise the real row-level atomicity/locking that
 * `transition_mission_planning_attempt` provides — only provable against a
 * live Postgres instance, unavailable in this environment. What's verified:
 * every RPC receives exactly the arguments it needs, every distinct
 * status/reason is mapped into a distinct typed result (duplicate vs.
 * conflicting terminal write, stale fence, provider-identity conflict,
 * cross-workspace refusal enforced client-side before the RPC call), reads
 * work via plain `.from(...)` selects (no RPC), and `outcome_unknown` is
 * preserved verbatim.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { SupabaseMissionPlanningAttemptStore } from "../src/lib/mission/mission-planning-attempt-store-supabase.ts";

function attemptRow(overrides: Record<string, unknown> = {}) {
  return {
    worker_attempt_id: "attempt-1",
    workspace_id: "ws-1",
    mission_id: "m-1",
    planning_request_id: "preq-1",
    lease_id: "lease-1",
    fencing_token: 1,
    worker_id: "worker-1",
    model_configuration_id: "cfg-1",
    provider_request_id: null,
    attempt_kind: "initial_invocation",
    attempt_number: 1,
    state: "claimed",
    context_hash: "hash-a",
    outcome_classification: null,
    diagnostic_ref: null,
    retry_class: null,
    started_at: "2026-07-26T00:00:00.000Z",
    response_received_at: null,
    completed_at: null,
    correlation_id: "corr-1",
    causation_id: null,
    parent_attempt_id: null,
    ...overrides,
  };
}

function fakeClient(options: {
  getResult?: { data: unknown; error: { message: string } | null };
  listResult?: { data: unknown; error: { message: string } | null };
  rpcResult?: { data: unknown; error: { message: string } | null };
}) {
  const rpcCalls: { rpcName: string; rpcArgs: unknown }[] = [];
  let fromCallCount = 0;
  const client = {
    rpc: async (name: string, args: unknown) => {
      rpcCalls.push({ rpcName: name, rpcArgs: args });
      return options.rpcResult ?? { data: null, error: null };
    },
    from: () => {
      fromCallCount += 1;
      const isListCall = fromCallCount > 1 || options.listResult !== undefined;
      const resolved = () => Promise.resolve(options.listResult ?? { data: [], error: null });
      const builder = {
        select: () => builder,
        eq: () => builder,
        not: () => builder,
        order: () => resolved(),
        maybeSingle: async () => (isListCall && options.listResult ? options.listResult : options.getResult ?? { data: null, error: null }),
        then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) => resolved().then(onFulfilled, onRejected),
      };
      return builder;
    },
  };
  return { client: client as never, rpcCalls };
}

test("get() reads directly from the table (no RPC) and returns null when nothing is found", async () => {
  const notFound = fakeClient({ getResult: { data: null, error: null } });
  const storeA = new SupabaseMissionPlanningAttemptStore(notFound.client);
  assert.equal(await storeA.get("attempt-missing"), null);
  assert.equal(notFound.rpcCalls.length, 0);

  const found = fakeClient({ getResult: { data: attemptRow(), error: null } });
  const storeB = new SupabaseMissionPlanningAttemptStore(found.client);
  const attempt = await storeB.get("attempt-1");
  assert.ok(attempt);
  assert.equal(attempt?.workerAttemptId, "attempt-1");
  assert.equal(attempt?.state, "claimed");
});

test("listForRequest() reads all attempts for a request via plain select, oldest first", async () => {
  const { client } = fakeClient({ listResult: { data: [attemptRow(), attemptRow({ worker_attempt_id: "attempt-2", attempt_number: 2 })], error: null } });
  const store = new SupabaseMissionPlanningAttemptStore(client);
  const attempts = await store.listForRequest("ws-1", "m-1", "preq-1");
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].workerAttemptId, "attempt-1");
  assert.equal(attempts[1].workerAttemptId, "attempt-2");
});

test("listNonTerminal() reads via plain select scoped by workspace", async () => {
  const { client } = fakeClient({ listResult: { data: [attemptRow({ state: "invoking" })], error: null } });
  const store = new SupabaseMissionPlanningAttemptStore(client);
  const attempts = await store.listNonTerminal("ws-1");
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].state, "invoking");
});

test("transition() applies a legal transition and preserves outcome_unknown verbatim", async () => {
  const { client, rpcCalls } = fakeClient({
    getResult: { data: attemptRow(), error: null },
    rpcResult: { data: [{ status: "ok", reason: null, attempt: attemptRow({ state: "outcome_unknown", outcome_classification: "outcome_unknown" }) }], error: null },
  });
  const store = new SupabaseMissionPlanningAttemptStore(client);
  const result = await store.transition({ workspaceId: "ws-1", workerAttemptId: "attempt-1", fencingToken: 1, toState: "outcome_unknown", now: "2026-07-26T00:01:00.000Z", outcomeClassification: "outcome_unknown" });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.noop, false);
    assert.equal(result.attempt.state, "outcome_unknown");
    assert.equal(result.attempt.outcomeClassification, "outcome_unknown");
  }
  assert.equal(rpcCalls[0].rpcName, "transition_mission_planning_attempt");
  const args = rpcCalls[0].rpcArgs as Record<string, unknown>;
  assert.equal(args.p_worker_attempt_id, "attempt-1");
  assert.equal(args.p_fencing_token, 1);
  assert.equal(args.p_to_state, "outcome_unknown");
});

test("transition() maps a duplicate identical terminal write to noop: true, distinct from a fresh success", async () => {
  const { client } = fakeClient({
    getResult: { data: attemptRow({ state: "completed" }), error: null },
    rpcResult: { data: [{ status: "ok", reason: "noop_duplicate_terminal", attempt: attemptRow({ state: "completed" }) }], error: null },
  });
  const store = new SupabaseMissionPlanningAttemptStore(client);
  const result = await store.transition({ workspaceId: "ws-1", workerAttemptId: "attempt-1", fencingToken: 1, toState: "completed", now: "2026-07-26T00:01:00.000Z" });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.noop, true);
});

test("transition() maps a conflicting terminal write to a distinct typed result", async () => {
  const { client } = fakeClient({
    getResult: { data: attemptRow({ state: "completed" }), error: null },
    rpcResult: { data: [{ status: "refused", reason: "conflicting_terminal_write", attempt: null }], error: null },
  });
  const store = new SupabaseMissionPlanningAttemptStore(client);
  const result = await store.transition({ workspaceId: "ws-1", workerAttemptId: "attempt-1", fencingToken: 1, toState: "failed", now: "2026-07-26T00:01:00.000Z" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "conflicting_terminal_write");
});

test("transition() maps a stale fencing token to a distinct typed result", async () => {
  const { client } = fakeClient({
    getResult: { data: attemptRow(), error: null },
    rpcResult: { data: [{ status: "refused", reason: "stale_fencing_token", attempt: null }], error: null },
  });
  const store = new SupabaseMissionPlanningAttemptStore(client);
  const result = await store.transition({ workspaceId: "ws-1", workerAttemptId: "attempt-1", fencingToken: 99, toState: "failed", now: "2026-07-26T00:01:00.000Z" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "stale_fencing_token");
});

test("transition() refuses cross-workspace mutation as a typed result, before ever calling the RPC", async () => {
  const { client, rpcCalls } = fakeClient({ getResult: { data: attemptRow({ workspace_id: "ws-owner" }), error: null } });
  const store = new SupabaseMissionPlanningAttemptStore(client);
  const result = await store.transition({ workspaceId: "ws-attacker", workerAttemptId: "attempt-1", fencingToken: 1, toState: "failed", now: "2026-07-26T00:01:00.000Z" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "workspace_mismatch");
  assert.equal(rpcCalls.length, 0, "must never call the mutating RPC once workspace ownership fails");
});

test("transition() throws on an unrecognized status/reason rather than silently succeeding", async () => {
  const { client } = fakeClient({ getResult: { data: attemptRow(), error: null }, rpcResult: { data: [{ status: "weird", reason: null, attempt: null }], error: null } });
  const store = new SupabaseMissionPlanningAttemptStore(client);
  await assert.rejects(() => store.transition({ workspaceId: "ws-1", workerAttemptId: "attempt-1", fencingToken: 1, toState: "failed", now: "2026-07-26T00:01:00.000Z" }), /unrecognized status/);
});

test("attachProviderRequestId() attaches on first call and round-trips the parent repair linkage via listForRequest", async () => {
  const { client, rpcCalls } = fakeClient({
    getResult: { data: attemptRow({ provider_request_id: null }), error: null },
    rpcResult: { data: [{ status: "ok", reason: null, attempt: attemptRow({ provider_request_id: "prov-abc" }) }], error: null },
  });
  const store = new SupabaseMissionPlanningAttemptStore(client);
  const result = await store.attachProviderRequestId({ workspaceId: "ws-1", workerAttemptId: "attempt-1", fencingToken: 1, providerRequestId: "prov-abc" });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.attempt.providerRequestId, "prov-abc");
  assert.equal(rpcCalls[0].rpcName, "attach_mission_planning_attempt_provider_request_id");

  const repairChild = attemptRow({ worker_attempt_id: "attempt-2", parent_attempt_id: "attempt-1", attempt_kind: "schema_repair" });
  const listing = fakeClient({ listResult: { data: [repairChild], error: null } });
  const storeList = new SupabaseMissionPlanningAttemptStore(listing.client);
  const attempts = await storeList.listForRequest("ws-1", "m-1", "preq-1");
  assert.equal(attempts[0].parentAttemptId, "attempt-1");
});

test("attachProviderRequestId() rejects a mismatched providerRequestId once already set (conflict, not silent overwrite)", async () => {
  const { client } = fakeClient({
    getResult: { data: attemptRow({ provider_request_id: "prov-original" }), error: null },
    rpcResult: { data: [{ status: "refused", reason: "conflicting_terminal_write", attempt: null }], error: null },
  });
  const store = new SupabaseMissionPlanningAttemptStore(client);
  const result = await store.attachProviderRequestId({ workspaceId: "ws-1", workerAttemptId: "attempt-1", fencingToken: 1, providerRequestId: "prov-different" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "conflicting_terminal_write");
});

test("attachProviderRequestId() refuses cross-workspace mutation before calling the RPC", async () => {
  const { client, rpcCalls } = fakeClient({ getResult: { data: attemptRow({ workspace_id: "ws-owner" }), error: null } });
  const store = new SupabaseMissionPlanningAttemptStore(client);
  const result = await store.attachProviderRequestId({ workspaceId: "ws-attacker", workerAttemptId: "attempt-1", fencingToken: 1, providerRequestId: "prov-x" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "workspace_mismatch");
  assert.equal(rpcCalls.length, 0);
});

test("a Supabase-level RPC error is surfaced, never swallowed", async () => {
  const { client } = fakeClient({ getResult: { data: attemptRow(), error: null }, rpcResult: { data: null, error: { message: "boom" } } });
  const store = new SupabaseMissionPlanningAttemptStore(client);
  await assert.rejects(() => store.transition({ workspaceId: "ws-1", workerAttemptId: "attempt-1", fencingToken: 1, toState: "failed", now: "2026-07-26T00:01:00.000Z" }), /boom/);
});
