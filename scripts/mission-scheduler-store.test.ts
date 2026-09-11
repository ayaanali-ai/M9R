/**
 * Mission scheduler store — Phase 2D.1 tests
 *
 * Exercised against `InMemoryMissionSchedulerStore`, the rigorous reference
 * implementation: every method is synchronous internally end-to-end (no
 * `await` between reading a slot's state and committing its mutation), so
 * two concurrent calls raced via `Promise.all` genuinely cannot interleave —
 * the same argument `mission-store.test.ts` rests its concurrency proofs on
 * for the Mission aggregate itself. See `mission-scheduler-store-supabase.test.ts`
 * for the RPC-argument-shape tests against the real persistence path, and
 * IMPLEMENTATION_NOTES.md for what remains unverified without a live
 * Postgres instance.
 *
 * Covers every scenario Phase 2D.1 was asked for: single/ten-way races on
 * one slot, independent concurrent claims across different Missions and
 * different dispatch keys on the same Mission, expired-lease replacement
 * with monotonic fencing, stale-fencing refusal on renew/release/validate,
 * revoked-lease refusal, cross-workspace and repository-mismatch rejection,
 * all-or-nothing batch rollback on a mid-batch fault, and outbox recovery.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  InMemoryMissionSchedulerStore,
  type ClaimCandidatesInput,
  type DispatchCandidateRequest,
  type InMemoryMissionRecord,
} from "../src/lib/mission/mission-scheduler-store.ts";
import { DEFAULT_SCHEDULER_POLICY, DISPATCHABLE_MISSION_STATES, type LeaseHolder, type SchedulerPolicy } from "../src/lib/mission/mission-scheduler.ts";

const agentA: LeaseHolder = { kind: "agent", id: "agent-a" };
const agentB: LeaseHolder = { kind: "agent", id: "agent-b" };
const policy: SchedulerPolicy = DEFAULT_SCHEDULER_POLICY;

const T0 = "2026-07-26T00:00:00.000Z";
function minutesAfterT0(mins: number): string {
  return new Date(Date.parse(T0) + mins * 60_000).toISOString();
}

function missionRegistry(entries: Record<string, InMemoryMissionRecord>): Map<string, InMemoryMissionRecord> {
  return new Map(Object.entries(entries));
}

let leaseIdCounter = 0;
function freshStore(missions: Map<string, InMemoryMissionRecord>): InMemoryMissionSchedulerStore {
  return new InMemoryMissionSchedulerStore(missions, () => {
    leaseIdCounter += 1;
    return `lease-${leaseIdCounter}`;
  });
}

function candidate(overrides: Partial<DispatchCandidateRequest> = {}): DispatchCandidateRequest {
  return {
    missionId: "m-1",
    workspaceId: "ws-1",
    dispatchKey: "primary",
    missionState: "ready",
    ...overrides,
  };
}

function claimInput(candidates: DispatchCandidateRequest[], overrides: Partial<ClaimCandidatesInput> = {}): ClaimCandidatesInput {
  return {
    candidates,
    holder: agentA,
    now: T0,
    policy,
    dispatchableStates: DISPATCHABLE_MISSION_STATES,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Races on one slot
// ---------------------------------------------------------------------------

test("two workers race for one candidate: exactly one winner", async () => {
  const store = freshStore(missionRegistry({ "m-1": { workspaceId: "ws-1", repositoryId: null } }));

  const [a, b] = await Promise.all([
    store.claimCandidates(claimInput([candidate()], { holder: agentA })),
    store.claimCandidates(claimInput([candidate()], { holder: agentB })),
  ]);

  const claimedCount = a.claimed.length + b.claimed.length;
  const refusedCount = a.refused.length + b.refused.length;
  assert.equal(claimedCount, 1, "exactly one of the two racing claims must win");
  assert.equal(refusedCount, 1);
});

test("ten workers race for one candidate: exactly one winner", async () => {
  const store = freshStore(missionRegistry({ "m-1": { workspaceId: "ws-1", repositoryId: null } }));
  const holders: LeaseHolder[] = Array.from({ length: 10 }, (_, i) => ({ kind: "agent", id: `agent-${i}` }));

  const results = await Promise.all(holders.map((holder) => store.claimCandidates(claimInput([candidate()], { holder }))));

  const claimedCount = results.reduce((sum, r) => sum + r.claimed.length, 0);
  const refusedCount = results.reduce((sum, r) => sum + r.refused.length, 0);
  assert.equal(claimedCount, 1, "exactly one of ten racing claims must win");
  assert.equal(refusedCount, 9);
});

test("different Missions may be claimed concurrently", async () => {
  const store = freshStore(
    missionRegistry({
      "m-1": { workspaceId: "ws-1", repositoryId: null },
      "m-2": { workspaceId: "ws-1", repositoryId: null },
    }),
  );

  const [a, b] = await Promise.all([
    store.claimCandidates(claimInput([candidate({ missionId: "m-1" })], { holder: agentA })),
    store.claimCandidates(claimInput([candidate({ missionId: "m-2" })], { holder: agentB })),
  ]);

  assert.equal(a.claimed.length, 1);
  assert.equal(b.claimed.length, 1);
});

test("different dispatchKeys on the same Mission are independent slots and may be claimed concurrently", async () => {
  const store = freshStore(missionRegistry({ "m-1": { workspaceId: "ws-1", repositoryId: null } }));

  const [a, b] = await Promise.all([
    store.claimCandidates(claimInput([candidate({ dispatchKey: "impl" })], { holder: agentA })),
    store.claimCandidates(claimInput([candidate({ dispatchKey: "review" })], { holder: agentB })),
  ]);

  assert.equal(a.claimed.length, 1);
  assert.equal(b.claimed.length, 1);
});

// ---------------------------------------------------------------------------
// Expiry, replacement, fencing
// ---------------------------------------------------------------------------

test("an expired lease may be replaced, and the replacement receives a strictly higher fencing token", async () => {
  const store = freshStore(missionRegistry({ "m-1": { workspaceId: "ws-1", repositoryId: null } }));

  const first = await store.claimCandidates(claimInput([candidate()], { holder: agentA, now: T0 }));
  assert.equal(first.claimed.length, 1);
  const firstToken = first.claimed[0].lease.fencingToken;

  const second = await store.claimCandidates(claimInput([candidate()], { holder: agentB, now: minutesAfterT0(999) }));
  assert.equal(second.claimed.length, 1, "an expired lease must be reclaimable by a different holder");
  assert.ok(second.claimed[0].lease.fencingToken > firstToken, "the replacement's fencing token must exceed the expired generation's");
  assert.notEqual(second.claimed[0].lease.leaseId, first.claimed[0].lease.leaseId);
});

// ---------------------------------------------------------------------------
// Stale-fencing refusals
// ---------------------------------------------------------------------------

test("a stale worker (wrong fencing token) cannot renew", async () => {
  const store = freshStore(missionRegistry({ "m-1": { workspaceId: "ws-1", repositoryId: null } }));
  const claimed = await store.claimCandidates(claimInput([candidate()], { holder: agentA, now: T0 }));
  const lease = claimed.claimed[0].lease;

  const result = await store.renewLease({
    workspaceId: "ws-1",
    missionId: "m-1",
    dispatchKey: "primary",
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken + 1, // wrong on purpose
    holder: agentA,
    now: minutesAfterT0(1),
    policy,
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "stale_fencing_token");
});

test("a stale worker (superseded generation) cannot release", async () => {
  const store = freshStore(missionRegistry({ "m-1": { workspaceId: "ws-1", repositoryId: null } }));
  const first = await store.claimCandidates(claimInput([candidate()], { holder: agentA, now: T0 }));
  const staleLease = first.claimed[0].lease;

  // Someone else reclaims the slot after it expires — a new generation.
  await store.claimCandidates(claimInput([candidate()], { holder: agentB, now: minutesAfterT0(999) }));

  const result = await store.releaseLease({
    workspaceId: "ws-1",
    missionId: "m-1",
    dispatchKey: "primary",
    leaseId: staleLease.leaseId,
    fencingToken: staleLease.fencingToken,
    holder: agentA,
    now: minutesAfterT0(1000),
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "stale_fencing_token");
});

test("a stale worker cannot pass the fencing boundary a completion report would be checked against", async () => {
  const store = freshStore(missionRegistry({ "m-1": { workspaceId: "ws-1", repositoryId: null } }));
  const first = await store.claimCandidates(claimInput([candidate()], { holder: agentA, now: T0 }));
  const staleLease = first.claimed[0].lease;

  await store.claimCandidates(claimInput([candidate()], { holder: agentB, now: minutesAfterT0(999) }));

  const stillValid = await store.validateFence({
    workspaceId: "ws-1",
    missionId: "m-1",
    dispatchKey: "primary",
    leaseId: staleLease.leaseId,
    fencingToken: staleLease.fencingToken,
  });
  assert.equal(stillValid, false, "a superseded generation's fencing token must never validate, even though it once held the slot");
});

test("a revoked lease cannot be renewed", async () => {
  const store = freshStore(missionRegistry({ "m-1": { workspaceId: "ws-1", repositoryId: null } }));
  const claimed = await store.claimCandidates(claimInput([candidate()], { holder: agentA, now: T0 }));
  const lease = claimed.claimed[0].lease;

  const revoked = await store.revokeLease({ workspaceId: "ws-1", missionId: "m-1", dispatchKey: "primary", now: minutesAfterT0(1), reason: "mission cancelled" });
  assert.equal(revoked.ok, true);

  const renewAttempt = await store.renewLease({
    workspaceId: "ws-1",
    missionId: "m-1",
    dispatchKey: "primary",
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
    holder: agentA,
    now: minutesAfterT0(2),
    policy,
  });
  assert.equal(renewAttempt.ok, false);
  if (!renewAttempt.ok) assert.equal(renewAttempt.reason, "lease_already_terminal");
});

// ---------------------------------------------------------------------------
// Tenant scope
// ---------------------------------------------------------------------------

test("a cross-workspace claim is rejected even though the Mission exists", async () => {
  const store = freshStore(missionRegistry({ "m-1": { workspaceId: "ws-owner", repositoryId: null } }));
  const result = await store.claimCandidates(claimInput([candidate({ missionId: "m-1", workspaceId: "ws-attacker" })]));
  assert.equal(result.claimed.length, 0);
  assert.deepEqual(result.refused, [{ missionId: "m-1", dispatchKey: "primary", reason: "workspace_mismatch" }]);
});

test("a repository mismatch is rejected", async () => {
  const store = freshStore(missionRegistry({ "m-1": { workspaceId: "ws-1", repositoryId: "repo-a" } }));
  const result = await store.claimCandidates(claimInput([candidate({ missionId: "m-1", repositoryId: "repo-b" })]));
  assert.equal(result.claimed.length, 0);
  assert.deepEqual(result.refused, [{ missionId: "m-1", dispatchKey: "primary", reason: "repository_mismatch" }]);
});

test("a claim for an unknown Mission is rejected as mission_not_found", async () => {
  const store = freshStore(missionRegistry({}));
  const result = await store.claimCandidates(claimInput([candidate({ missionId: "m-ghost" })]));
  assert.deepEqual(result.refused, [{ missionId: "m-ghost", dispatchKey: "primary", reason: "mission_not_found" }]);
});

test("a candidate whose Mission state is not in the caller-supplied dispatchable whitelist is refused", async () => {
  const store = freshStore(missionRegistry({ "m-1": { workspaceId: "ws-1", repositoryId: null } }));
  const result = await store.claimCandidates(claimInput([candidate({ missionState: "blocked" })]));
  assert.deepEqual(result.refused, [{ missionId: "m-1", dispatchKey: "primary", reason: "not_dispatchable_state" }]);
});

// ---------------------------------------------------------------------------
// Transaction failure and outbox recovery
// ---------------------------------------------------------------------------

test("a fault mid-batch rolls back the ENTIRE claim call, not just the failing candidate", async () => {
  const missions = missionRegistry({
    "m-1": { workspaceId: "ws-1", repositoryId: null },
    "m-2": { workspaceId: "ws-1", repositoryId: null },
  });
  let calls = 0;
  const store = new InMemoryMissionSchedulerStore(missions, () => {
    calls += 1;
    if (calls === 2) throw new Error("simulated fault while minting the second lease id");
    return `lease-${calls}`;
  });

  await assert.rejects(() => store.claimCandidates(claimInput([candidate({ missionId: "m-1" }), candidate({ missionId: "m-2" })])));

  // Nothing from the failed batch may be observable — including the FIRST
  // candidate, which "succeeded" before the fault, exactly matching what a
  // real single-transaction RPC call guarantees on an uncaught exception.
  const outstanding = await store.listOutstandingDispatchIntents("ws-1");
  assert.equal(outstanding.length, 0, "a rolled-back batch must leave no dispatch intents behind");

  const retry = await store.claimCandidates(claimInput([candidate({ missionId: "m-1" })], { holder: agentA }));
  assert.equal(retry.claimed.length, 1, "the slot must still be genuinely unclaimed after the rollback, not left in a half-claimed state");
});

test("scheduler restart can recover an outstanding dispatch intent, and delivery clears it", async () => {
  const store = freshStore(missionRegistry({ "m-1": { workspaceId: "ws-1", repositoryId: null } }));
  const result = await store.claimCandidates(claimInput([candidate({ adapterRequirement: "codex" })]));
  assert.equal(result.claimed.length, 1);

  const outstandingBefore = await store.listOutstandingDispatchIntents("ws-1");
  assert.equal(outstandingBefore.length, 1);
  assert.equal(outstandingBefore[0].adapterRequirement, "codex");
  assert.equal(outstandingBefore[0].leaseId, result.claimed[0].lease.leaseId);

  await store.markDispatchIntentDelivered(outstandingBefore[0].instructionId, minutesAfterT0(1));

  const outstandingAfter = await store.listOutstandingDispatchIntents("ws-1");
  assert.equal(outstandingAfter.length, 0, "a delivered intent is no longer outstanding");
});

test("reclaiming an expired slot supersedes its prior outstanding intent", async () => {
  const store = freshStore(missionRegistry({ "m-1": { workspaceId: "ws-1", repositoryId: null } }));
  await store.claimCandidates(claimInput([candidate()], { holder: agentA, now: T0 }));
  assert.equal((await store.listOutstandingDispatchIntents("ws-1")).length, 1);

  await store.claimCandidates(claimInput([candidate()], { holder: agentB, now: minutesAfterT0(999) }));

  const outstanding = await store.listOutstandingDispatchIntents("ws-1");
  assert.equal(outstanding.length, 1, "exactly the NEW generation's intent should be outstanding, the old one superseded");
  assert.equal(outstanding[0].attempt, 2);
});

// ---------------------------------------------------------------------------
// Integration with the pure candidate-selection policy (workspace budget)
// ---------------------------------------------------------------------------

test("the store claims exactly what selectDispatchCandidates (pure policy) already filtered down to — it does not re-derive the budget itself", async () => {
  // This is deliberately an integration shape test, not a re-test of
  // selectDispatchCandidates's own budget enforcement (covered exhaustively
  // in mission-scheduler.test.ts). The store's job is claiming a slot list
  // it's handed, atomically — never deciding which slots are in-budget.
  const store = freshStore(
    missionRegistry({
      "m-1": { workspaceId: "ws-1", repositoryId: null },
      "m-2": { workspaceId: "ws-1", repositoryId: null },
      "m-3": { workspaceId: "ws-1", repositoryId: null },
    }),
  );

  // Caller already ran selectDispatchCandidates and dropped m-3 for budget
  // reasons; only m-1 and m-2 are ever presented to the store.
  const result = await store.claimCandidates(claimInput([candidate({ missionId: "m-1" }), candidate({ missionId: "m-2" })]));
  assert.equal(result.claimed.length, 2);
  assert.equal(result.refused.length, 0);
});
