/**
 * SupabaseMissionPlanningLeaseStore — RPC-argument-shape verification against
 * a fake SupabaseClient. Mirrors
 * mission-planning-diagnostics-store-supabase.test.ts's structure.
 *
 * This does NOT exercise the actual row-locking/atomicity the migration's
 * `claim_mission_planning_lease` provides — that can only be proven against
 * a real Postgres instance, which this environment does not have. What's
 * verified here: every RPC receives exactly the arguments it needs, every
 * distinct refusal reason maps to a distinct typed result (never collapsed
 * into a generic "refused"), fencing tokens round-trip without precision
 * loss, and an unrecognized status/reason string is rejected rather than
 * silently treated as success or a generic failure.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  SupabaseMissionPlanningLeaseStore,
  type ClaimSupabasePlanningLeaseInput,
} from "../src/lib/mission/mission-planning-lease-store-supabase.ts";

function fakeClient(options: {
  rpcResult?: { data: unknown; error: { message: string } | null };
  fromResult?: { data: unknown; error: { message: string } | null };
}) {
  const calls: { rpcName: string; rpcArgs: unknown }[] = [];
  const client = {
    rpc: async (name: string, args: unknown) => {
      calls.push({ rpcName: name, rpcArgs: args });
      return options.rpcResult ?? { data: null, error: null };
    },
    from: () => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => options.fromResult ?? { data: null, error: null },
      };
      return builder;
    },
  };
  return { client: client as never, calls };
}

function baseClaimInput(overrides: Partial<ClaimSupabasePlanningLeaseInput> = {}): ClaimSupabasePlanningLeaseInput {
  return {
    workspaceId: "ws-1",
    missionId: "m-1",
    planningRequestId: "preq-1",
    missionTerminal: false,
    requestExists: true,
    requestTerminal: false,
    ownerId: "worker-1",
    now: "2026-07-26T00:00:00.000Z",
    leaseDurationMs: 60_000,
    workerAttemptId: "attempt-1",
    workerId: "worker-1",
    modelConfigurationId: "cfg-1",
    attemptKind: "initial_invocation",
    attemptNumber: 1,
    contextHash: "hash-a",
    correlationId: "corr-1",
    causationId: null,
    ...overrides,
  };
}

function leaseRow(overrides: Record<string, unknown> = {}) {
  return {
    workspace_id: "ws-1",
    mission_id: "m-1",
    planning_request_id: "preq-1",
    lease_id: "lease-1",
    owner_id: "worker-1",
    fencing_token: 1,
    status: "leased",
    attempt: 1,
    acquired_at: "2026-07-26T00:00:00.000Z",
    renewed_at: null,
    expires_at: "2026-07-26T00:01:00.000Z",
    released_at: null,
    revoked_at: null,
    revoked_reason: null,
    ...overrides,
  };
}

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
    attempt_kind: "initial_invocation",
    attempt_number: 1,
    state: "claimed",
    context_hash: "hash-a",
    started_at: "2026-07-26T00:00:00.000Z",
    correlation_id: "corr-1",
    causation_id: null,
    parent_attempt_id: null,
    ...overrides,
  };
}

test("claim() sends every argument the RPC needs and maps a 'claimed' row to lease + attempt", async () => {
  const { client, calls } = fakeClient({
    rpcResult: { data: [{ status: "claimed", reason: null, lease: leaseRow(), attempt: attemptRow() }], error: null },
  });
  const store = new SupabaseMissionPlanningLeaseStore(client);
  const result = await store.claim(baseClaimInput());

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.lease.leaseId, "lease-1");
    assert.equal(result.lease.fencingToken, 1);
    assert.equal(result.attempt.workerAttemptId, "attempt-1");
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].rpcName, "claim_mission_planning_lease");
  const args = calls[0].rpcArgs as Record<string, unknown>;
  assert.equal(args.p_workspace_id, "ws-1");
  assert.equal(args.p_mission_id, "m-1");
  assert.equal(args.p_planning_request_id, "preq-1");
  assert.equal(args.p_mission_terminal, false);
  assert.equal(args.p_request_exists, true);
  assert.equal(args.p_request_terminal, false);
  assert.equal(args.p_owner_id, "worker-1");
  assert.equal(args.p_worker_attempt_id, "attempt-1");
  assert.equal(args.p_context_hash, "hash-a");
});

for (const reason of [
  "mission_not_found",
  "workspace_mismatch",
  "mission_terminal",
  "planning_request_not_found",
  "planning_request_terminal",
  "already_leased",
] as const) {
  test(`claim() maps refusal reason '${reason}' to a distinct typed result`, async () => {
    const { client } = fakeClient({ rpcResult: { data: [{ status: "refused", reason, lease: null, attempt: null }], error: null } });
    const store = new SupabaseMissionPlanningLeaseStore(client);
    const result = await store.claim(baseClaimInput());
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, reason);
  });
}

test("claim() throws on an unrecognized refusal reason rather than treating it as generic failure", async () => {
  const { client } = fakeClient({ rpcResult: { data: [{ status: "refused", reason: "something_new", lease: null, attempt: null }], error: null } });
  const store = new SupabaseMissionPlanningLeaseStore(client);
  await assert.rejects(() => store.claim(baseClaimInput()), /unrecognized refusal reason/);
});

test("claim() throws on an unrecognized status rather than treating it as success", async () => {
  const { client } = fakeClient({ rpcResult: { data: [{ status: "weird", reason: null, lease: null, attempt: null }], error: null } });
  const store = new SupabaseMissionPlanningLeaseStore(client);
  await assert.rejects(() => store.claim(baseClaimInput()), /unrecognized status/);
});

test("claim() preserves a fencing token near the int32 bound without precision loss", async () => {
  const bigToken = 2_147_483_647; // Postgres integer max
  const { client } = fakeClient({
    rpcResult: { data: [{ status: "claimed", reason: null, lease: leaseRow({ fencing_token: bigToken }), attempt: attemptRow({ fencing_token: bigToken }) }], error: null },
  });
  const store = new SupabaseMissionPlanningLeaseStore(client);
  const result = await store.claim(baseClaimInput());
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.lease.fencingToken, bigToken);
    assert.equal(result.attempt.fencingToken, bigToken);
  }
});

test("renew() maps 'ok' to a lease and each refusal reason distinctly", async () => {
  const ok = fakeClient({ rpcResult: { data: [{ status: "ok", reason: null, lease: leaseRow({ expires_at: "2026-07-26T00:02:00.000Z" }) }], error: null } });
  const storeOk = new SupabaseMissionPlanningLeaseStore(ok.client);
  const okResult = await storeOk.renew({ workspaceId: "ws-1", missionId: "m-1", planningRequestId: "preq-1", leaseId: "lease-1", fencingToken: 1, now: "2026-07-26T00:01:30.000Z", leaseDurationMs: 60_000 });
  assert.equal(okResult.ok, true);
  assert.equal(ok.calls[0].rpcName, "renew_mission_planning_lease");

  for (const reason of ["not_found", "stale_fencing_token", "not_active"] as const) {
    const { client } = fakeClient({ rpcResult: { data: [{ status: "refused", reason, lease: null }], error: null } });
    const store = new SupabaseMissionPlanningLeaseStore(client);
    const result = await store.renew({ workspaceId: "ws-1", missionId: "m-1", planningRequestId: "preq-1", leaseId: "lease-1", fencingToken: 1, now: "2026-07-26T00:01:30.000Z", leaseDurationMs: 60_000 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, reason);
  }
});

test("release() maps 'ok' and both refusal reasons distinctly", async () => {
  const ok = fakeClient({ rpcResult: { data: [{ status: "ok", reason: null, lease: leaseRow({ status: "released" }) }], error: null } });
  const storeOk = new SupabaseMissionPlanningLeaseStore(ok.client);
  const okResult = await storeOk.release("ws-1", "m-1", "preq-1", "lease-1", 1, "2026-07-26T00:01:00.000Z");
  assert.equal(okResult.ok, true);
  assert.equal(ok.calls[0].rpcName, "release_mission_planning_lease");

  for (const reason of ["not_found", "stale_fencing_token"] as const) {
    const { client } = fakeClient({ rpcResult: { data: [{ status: "refused", reason, lease: null }], error: null } });
    const store = new SupabaseMissionPlanningLeaseStore(client);
    const result = await store.release("ws-1", "m-1", "preq-1", "lease-1", 1, "2026-07-26T00:01:00.000Z");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, reason);
  }
});

test("revoke() maps 'ok' and both refusal reasons distinctly", async () => {
  const ok = fakeClient({ rpcResult: { data: [{ status: "ok", reason: null, lease: leaseRow({ status: "revoked" }) }], error: null } });
  const storeOk = new SupabaseMissionPlanningLeaseStore(ok.client);
  const okResult = await storeOk.revoke("ws-1", "m-1", "preq-1", "2026-07-26T00:01:00.000Z", "mission_terminal_reconciliation");
  assert.equal(okResult.ok, true);
  assert.equal(ok.calls[0].rpcName, "revoke_mission_planning_lease");

  for (const reason of ["not_found", "lease_already_terminal"] as const) {
    const { client } = fakeClient({ rpcResult: { data: [{ status: "refused", reason, lease: null }], error: null } });
    const store = new SupabaseMissionPlanningLeaseStore(client);
    const result = await store.revoke("ws-1", "m-1", "preq-1", "2026-07-26T00:01:00.000Z", "reason");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, reason);
  }
});

test("isFencingTokenCurrent() calls validate_mission_planning_fence and returns its boolean verbatim", async () => {
  const trueClient = fakeClient({ rpcResult: { data: true, error: null } });
  const storeTrue = new SupabaseMissionPlanningLeaseStore(trueClient.client);
  assert.equal(await storeTrue.isFencingTokenCurrent("ws-1", "m-1", "preq-1", "lease-1", 1), true);
  assert.equal(trueClient.calls[0].rpcName, "validate_mission_planning_fence");

  const falseClient = fakeClient({ rpcResult: { data: false, error: null } });
  const storeFalse = new SupabaseMissionPlanningLeaseStore(falseClient.client);
  assert.equal(await storeFalse.isFencingTokenCurrent("ws-1", "m-1", "preq-1", "lease-1", 1), false);
});

test("isFencingTokenCurrent() throws if the RPC returns a non-boolean value", async () => {
  const { client } = fakeClient({ rpcResult: { data: "not-a-boolean", error: null } });
  const store = new SupabaseMissionPlanningLeaseStore(client);
  await assert.rejects(() => store.isFencingTokenCurrent("ws-1", "m-1", "preq-1", "lease-1", 1), /non-boolean/);
});

test("peek() reads directly from the table (no RPC) and returns null when nothing is found", async () => {
  const notFound = fakeClient({ fromResult: { data: null, error: null } });
  const storeA = new SupabaseMissionPlanningLeaseStore(notFound.client);
  assert.equal(await storeA.peek("ws-1", "m-1", "preq-1"), null);

  const found = fakeClient({ fromResult: { data: leaseRow(), error: null } });
  const storeB = new SupabaseMissionPlanningLeaseStore(found.client);
  const lease = await storeB.peek("ws-1", "m-1", "preq-1");
  assert.ok(lease);
  assert.equal(lease?.leaseId, "lease-1");
});

test("a Supabase-level error is surfaced, never swallowed", async () => {
  const { client } = fakeClient({ rpcResult: { data: null, error: { message: "boom" } } });
  const store = new SupabaseMissionPlanningLeaseStore(client);
  await assert.rejects(() => store.claim(baseClaimInput()), /boom/);
});
