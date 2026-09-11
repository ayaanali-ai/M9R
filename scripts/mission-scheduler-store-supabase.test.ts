/**
 * SupabaseMissionSchedulerStore — RPC-argument-shape verification against a
 * fake SupabaseClient.
 *
 * This does NOT exercise the actual concurrency/atomicity guarantee — that
 * lives in the atomic RPC functions
 * (supabase/migrations/20260726010000_mission_dispatch_leases.sql) and can
 * only be proven against a real Postgres instance, which this environment
 * does not have (same documented limitation as mission-store-supabase.test.ts
 * for the Mission aggregate). What's verified here: each store method sends
 * the RPC exactly the arguments it needs, and maps every returned shape
 * (claimed / refused rows, renew/release/revoke outcomes, the fencing
 * boolean, outbox rows) into what `MissionSchedulerStore` promises callers.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { SupabaseMissionSchedulerStore } from "../src/lib/mission/mission-scheduler-store-supabase.ts";
import { DEFAULT_SCHEDULER_POLICY, DISPATCHABLE_MISSION_STATES } from "../src/lib/mission/mission-scheduler.ts";
import type { DispatchCandidateRequest } from "../src/lib/mission/mission-scheduler-store.ts";

const HOLDER = { kind: "agent" as const, id: "agent-a" };
const policy = DEFAULT_SCHEDULER_POLICY;

function fakeClient(options: { rpcResult?: { data: unknown; error: { message: string } | null }; tableRows?: unknown[] }) {
  const calls: { rpcName?: string; rpcArgs?: unknown; table?: string; op?: string; args?: unknown }[] = [];
  const client = {
    from(table: string) {
      return {
        select: () => ({
          eq: () => ({
            is: () => ({
              is: async () => ({ data: options.tableRows ?? [], error: null }),
            }),
          }),
        }),
        update: (args: unknown) => {
          calls.push({ table, op: "update", args });
          return { eq: async () => ({ error: null }) };
        },
      };
    },
    rpc: async (name: string, args: unknown) => {
      calls.push({ rpcName: name, rpcArgs: args });
      return options.rpcResult ?? { data: null, error: null };
    },
  };
  return { client, calls };
}

test("claimCandidates sends the batch, holder, timing, and dispatchable-state whitelist, and maps claimed/refused rows", async () => {
  const candidates: DispatchCandidateRequest[] = [
    { missionId: "m-1", workspaceId: "ws-1", dispatchKey: "primary", missionState: "ready" },
    { missionId: "m-2", workspaceId: "ws-1", dispatchKey: "primary", missionState: "blocked" },
  ];
  const { client, calls } = fakeClient({
    rpcResult: {
      data: [
        {
          mission_id: "m-1",
          dispatch_key: "primary",
          status: "claimed",
          reason: null,
          lease: {
            leaseId: "lease-1",
            missionId: "m-1",
            workspaceId: "ws-1",
            dispatchKey: "primary",
            holder: HOLDER,
            state: "leased",
            fencingToken: 1,
            acquiredAt: "2026-07-26T00:00:00.000Z",
            expiresAt: "2026-07-26T00:05:00.000Z",
            renewedAt: null,
            releasedAt: null,
            revokedReason: null,
          },
          instruction: {
            instructionId: "intent-1",
            missionId: "m-1",
            workspaceId: "ws-1",
            repositoryId: null,
            dispatchKey: "primary",
            adapterRequirement: null,
            leaseId: "lease-1",
            fencingToken: 1,
            attempt: 1,
            executionConstraints: {},
            createdAt: "2026-07-26T00:00:00.000Z",
            deliveredAt: null,
            supersededAt: null,
          },
        },
        { mission_id: "m-2", dispatch_key: "primary", status: "refused", reason: "not_dispatchable_state", lease: null, instruction: null },
      ],
      error: null,
    },
  });

  const store = new SupabaseMissionSchedulerStore(client as never);
  const result = await store.claimCandidates({
    candidates,
    holder: HOLDER,
    now: "2026-07-26T00:00:00.000Z",
    policy,
    dispatchableStates: DISPATCHABLE_MISSION_STATES,
  });

  assert.equal(result.claimed.length, 1);
  assert.equal(result.claimed[0].missionId, "m-1");
  assert.equal(result.claimed[0].lease.fencingToken, 1);
  assert.deepEqual(result.refused, [{ missionId: "m-2", dispatchKey: "primary", reason: "not_dispatchable_state" }]);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].rpcName, "claim_mission_dispatch_candidates_atomic");
  assert.deepEqual(calls[0].rpcArgs, {
    p_candidates: candidates,
    p_holder: HOLDER,
    p_now: "2026-07-26T00:00:00.000Z",
    p_lease_duration_ms: policy.leaseDurationMs,
    p_dispatchable_states: DISPATCHABLE_MISSION_STATES,
  });
});

test("renewLease maps a refused row without throwing", async () => {
  const { client } = fakeClient({ rpcResult: { data: [{ status: "refused", reason: "stale_fencing_token", lease: null }], error: null } });
  const store = new SupabaseMissionSchedulerStore(client as never);

  const result = await store.renewLease({
    workspaceId: "ws-1",
    missionId: "m-1",
    dispatchKey: "primary",
    leaseId: "lease-1",
    fencingToken: 2,
    holder: HOLDER,
    now: "2026-07-26T00:01:00.000Z",
    policy,
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "stale_fencing_token");
});

test("releaseLease maps a successful row", async () => {
  const { client } = fakeClient({
    rpcResult: {
      data: [
        {
          status: "released",
          reason: null,
          lease: {
            leaseId: "lease-1",
            missionId: "m-1",
            workspaceId: "ws-1",
            dispatchKey: "primary",
            holder: HOLDER,
            state: "released",
            fencingToken: 1,
            acquiredAt: "2026-07-26T00:00:00.000Z",
            expiresAt: "2026-07-26T00:05:00.000Z",
            renewedAt: null,
            releasedAt: "2026-07-26T00:01:00.000Z",
            revokedReason: null,
          },
        },
      ],
      error: null,
    },
  });
  const store = new SupabaseMissionSchedulerStore(client as never);

  const result = await store.releaseLease({
    workspaceId: "ws-1",
    missionId: "m-1",
    dispatchKey: "primary",
    leaseId: "lease-1",
    fencingToken: 1,
    holder: HOLDER,
    now: "2026-07-26T00:01:00.000Z",
  });

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.lease.state, "released");
});

test("validateFence returns exactly the boolean the RPC reports", async () => {
  const { client } = fakeClient({ rpcResult: { data: true, error: null } });
  const store = new SupabaseMissionSchedulerStore(client as never);
  const valid = await store.validateFence({
    workspaceId: "ws-1",
    missionId: "m-1",
    dispatchKey: "primary",
    leaseId: "lease-1",
    fencingToken: 1,
  });
  assert.equal(valid, true);
});

test("a Supabase-level error surfaces as a thrown Error, not a silent status", async () => {
  const { client } = fakeClient({ rpcResult: { data: null, error: { message: "connection reset" } } });
  const store = new SupabaseMissionSchedulerStore(client as never);

  await assert.rejects(
    () =>
      store.claimCandidates({
        candidates: [],
        holder: HOLDER,
        now: "2026-07-26T00:00:00.000Z",
        policy,
        dispatchableStates: DISPATCHABLE_MISSION_STATES,
      }),
    /connection reset/,
  );
});

test("listOutstandingDispatchIntents maps table rows into DispatchInstruction shape", async () => {
  const { client } = fakeClient({
    tableRows: [
      {
        id: "intent-1",
        mission_id: "m-1",
        workspace_id: "ws-1",
        repository_id: null,
        dispatch_key: "primary",
        adapter_requirement: "codex",
        lease_id: "lease-1",
        fencing_token: 1,
        attempt: 1,
        execution_constraints: {},
        created_at: "2026-07-26T00:00:00.000Z",
        delivered_at: null,
        superseded_at: null,
      },
    ],
  });
  const store = new SupabaseMissionSchedulerStore(client as never);
  const intents = await store.listOutstandingDispatchIntents("ws-1");
  assert.equal(intents.length, 1);
  assert.equal(intents[0].instructionId, "intent-1");
  assert.equal(intents[0].adapterRequirement, "codex");
});
