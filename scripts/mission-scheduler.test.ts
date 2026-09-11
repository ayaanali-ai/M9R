/**
 * Mission scheduler — Phase 2D tests
 *
 * Covers: lease acquisition (fresh, contested, post-expiry, post-terminal),
 * renewal (window enforcement, holder enforcement, fencing token bump),
 * release, revoke, expiry evaluation, fencing-token currency, and dispatch
 * candidate selection (state eligibility, live-lease exclusion, per-workspace
 * concurrency budget, deterministic ordering).
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SCHEDULER_POLICY,
  acquireLease,
  evaluateLeaseExpiry,
  isFencingTokenCurrent,
  releaseLease,
  renewLease,
  revokeLease,
  selectDispatchCandidates,
  type DispatchLease,
  type LeaseHolder,
  type SchedulerPolicy,
} from "../src/lib/mission/mission-scheduler.ts";
import { emptyMissionProjection, type MissionProjection } from "../src/lib/mission/mission-projection.ts";

const agentA: LeaseHolder = { kind: "agent", id: "agent-a" };
const agentB: LeaseHolder = { kind: "agent", id: "agent-b" };
const policy: SchedulerPolicy = DEFAULT_SCHEDULER_POLICY;

const T0 = "2026-07-25T00:00:00.000Z";
function minutesAfterT0(mins: number): string {
  return new Date(Date.parse(T0) + mins * 60_000).toISOString();
}

function projectionInState(missionId: string, state: MissionProjection["state"]): MissionProjection {
  return { ...emptyMissionProjection(missionId), state };
}

// ---------------------------------------------------------------------------
// acquireLease
// ---------------------------------------------------------------------------

test("acquireLease succeeds when nothing is on record", () => {
  const result = acquireLease({
    leaseId: "lease-1",
    missionId: "m-1",
    workspaceId: "ws-1",
    dispatchKey: "primary",
    holder: agentA,
    current: null,
    now: T0,
    policy,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.lease.state, "leased");
    assert.equal(result.lease.fencingToken, 1);
    assert.equal(result.lease.expiresAt, minutesAfterT0(5));
  }
});

test("acquireLease refuses a live lease held by a different holder", () => {
  const current: DispatchLease = {
    leaseId: "lease-1",
    missionId: "m-1",
    workspaceId: "ws-1",
    dispatchKey: "primary",
    holder: agentA,
    state: "leased",
    fencingToken: 1,
    acquiredAt: T0,
    expiresAt: minutesAfterT0(5),
    renewedAt: null,
    releasedAt: null,
    revokedReason: null,
  };
  const result = acquireLease({
    leaseId: "lease-2",
    missionId: "m-1",
    workspaceId: "ws-1",
    dispatchKey: "primary",
    holder: agentB,
    current,
    now: minutesAfterT0(1),
    policy,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "lease_held");
    assert.deepEqual(result.error.holder, agentA);
  }
});

test("acquireLease succeeds for the SAME holder re-acquiring a still-live lease (idempotent-ish reacquire)", () => {
  const current: DispatchLease = {
    leaseId: "lease-1",
    missionId: "m-1",
    workspaceId: "ws-1",
    dispatchKey: "primary",
    holder: agentA,
    state: "leased",
    fencingToken: 1,
    acquiredAt: T0,
    expiresAt: minutesAfterT0(5),
    renewedAt: null,
    releasedAt: null,
    revokedReason: null,
  };
  const result = acquireLease({
    leaseId: "lease-2",
    missionId: "m-1",
    workspaceId: "ws-1",
    dispatchKey: "primary",
    holder: agentA,
    current,
    now: minutesAfterT0(1),
    policy,
  });
  assert.equal(result.ok, true);
});

test("acquireLease succeeds once the recorded lease has actually expired, even if its stored state is still 'leased'", () => {
  const current: DispatchLease = {
    leaseId: "lease-1",
    missionId: "m-1",
    workspaceId: "ws-1",
    dispatchKey: "primary",
    holder: agentA,
    state: "leased",
    fencingToken: 1,
    acquiredAt: T0,
    expiresAt: minutesAfterT0(5),
    renewedAt: null,
    releasedAt: null,
    revokedReason: null,
  };
  const result = acquireLease({
    leaseId: "lease-2",
    missionId: "m-1",
    workspaceId: "ws-1",
    dispatchKey: "primary",
    holder: agentB,
    current,
    now: minutesAfterT0(6),
    policy,
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.lease.holder, agentB);
});

test("acquireLease succeeds over a released/revoked/expired terminal lease", () => {
  for (const state of ["released", "revoked", "expired"] as const) {
    const current: DispatchLease = {
      leaseId: "lease-1",
      missionId: "m-1",
      workspaceId: "ws-1",
      dispatchKey: "primary",
      holder: agentA,
      state,
      fencingToken: 1,
      acquiredAt: T0,
      expiresAt: minutesAfterT0(5),
      renewedAt: null,
      releasedAt: minutesAfterT0(2),
      revokedReason: state === "revoked" ? "test" : null,
    };
    const result = acquireLease({
      leaseId: "lease-2",
      missionId: "m-1",
      workspaceId: "ws-1",
      dispatchKey: "primary",
      holder: agentB,
      current,
      now: minutesAfterT0(1),
      policy,
    });
    assert.equal(result.ok, true, `expected acquire to succeed over terminal state ${state}`);
  }
});

test("acquireLease's fencing token is monotonic across generations, never resets to 1 on reacquire", () => {
  const gen1: DispatchLease = {
    leaseId: "lease-1",
    missionId: "m-1",
    workspaceId: "ws-1",
    dispatchKey: "primary",
    holder: agentA,
    state: "leased",
    fencingToken: 7,
    acquiredAt: T0,
    expiresAt: minutesAfterT0(5),
    renewedAt: null,
    releasedAt: null,
    revokedReason: null,
  };
  const reacquired = acquireLease({
    leaseId: "lease-2",
    missionId: "m-1",
    workspaceId: "ws-1",
    dispatchKey: "primary",
    holder: agentB,
    current: gen1,
    now: minutesAfterT0(6),
    policy,
  });
  assert.equal(reacquired.ok, true);
  if (reacquired.ok) {
    assert.equal(reacquired.lease.fencingToken, 8, "must continue gen1's sequence, not reset to 1");
  }
});

// ---------------------------------------------------------------------------
// renewLease
// ---------------------------------------------------------------------------

function freshLease(overrides: Partial<DispatchLease> = {}): DispatchLease {
  return {
    leaseId: "lease-1",
    missionId: "m-1",
    workspaceId: "ws-1",
    dispatchKey: "primary",
    holder: agentA,
    state: "leased",
    fencingToken: 1,
    acquiredAt: T0,
    expiresAt: minutesAfterT0(5),
    renewedAt: null,
    releasedAt: null,
    revokedReason: null,
    ...overrides,
  };
}

test("renewLease extends expiry and bumps the fencing token, inside the renewal window", () => {
  const current = freshLease();
  const result = renewLease({ current, holder: agentA, now: minutesAfterT0(4.5), policy });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.lease.fencingToken, 2);
    assert.equal(result.lease.expiresAt, new Date(Date.parse(minutesAfterT0(4.5)) + policy.leaseDurationMs).toISOString());
  }
});

test("renewLease refuses outside the renewal window (too early)", () => {
  const current = freshLease();
  const result = renewLease({ current, holder: agentA, now: minutesAfterT0(1), policy });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "renewal_outside_window");
});

test("renewLease refuses once the lease has already expired", () => {
  const current = freshLease();
  const result = renewLease({ current, holder: agentA, now: minutesAfterT0(6), policy });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "lease_expired");
});

test("renewLease refuses a caller that does not hold the lease", () => {
  const current = freshLease();
  const result = renewLease({ current, holder: agentB, now: minutesAfterT0(4.5), policy });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "lease_not_held_by_caller");
});

test("renewLease refuses an already-terminal lease", () => {
  const current = freshLease({ state: "released", releasedAt: minutesAfterT0(2) });
  const result = renewLease({ current, holder: agentA, now: minutesAfterT0(4.5), policy });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "lease_already_terminal");
});

// ---------------------------------------------------------------------------
// releaseLease / revokeLease
// ---------------------------------------------------------------------------

test("releaseLease succeeds for the current holder", () => {
  const current = freshLease();
  const result = releaseLease({ current, holder: agentA, now: minutesAfterT0(2) });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.lease.state, "released");
});

test("releaseLease refuses a non-holder", () => {
  const current = freshLease();
  const result = releaseLease({ current, holder: agentB, now: minutesAfterT0(2) });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "lease_not_held_by_caller");
});

test("revokeLease succeeds regardless of holder", () => {
  const current = freshLease();
  const result = revokeLease({ current, now: minutesAfterT0(2), reason: "mission cancelled" });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.lease.state, "revoked");
    assert.equal(result.lease.revokedReason, "mission cancelled");
  }
});

test("revokeLease refuses an already-terminal lease", () => {
  const current = freshLease({ state: "expired" });
  const result = revokeLease({ current, now: minutesAfterT0(2), reason: "n/a" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "lease_already_terminal");
});

// ---------------------------------------------------------------------------
// evaluateLeaseExpiry / isFencingTokenCurrent
// ---------------------------------------------------------------------------

test("evaluateLeaseExpiry returns null while still live", () => {
  const current = freshLease();
  assert.equal(evaluateLeaseExpiry(current, minutesAfterT0(1)), null);
});

test("evaluateLeaseExpiry returns an expired lease once past expiresAt", () => {
  const current = freshLease();
  const expired = evaluateLeaseExpiry(current, minutesAfterT0(6));
  assert.ok(expired);
  assert.equal(expired?.state, "expired");
});

test("evaluateLeaseExpiry returns null for a lease already in a terminal state", () => {
  const current = freshLease({ state: "released" });
  assert.equal(evaluateLeaseExpiry(current, minutesAfterT0(999)), null);
});

test("isFencingTokenCurrent accepts only the exact current token on a live lease", () => {
  const current = freshLease({ fencingToken: 3 });
  assert.equal(isFencingTokenCurrent(current, 3), true);
  assert.equal(isFencingTokenCurrent(current, 2), false);
  assert.equal(isFencingTokenCurrent({ ...current, state: "expired" }, 3), false);
});

// ---------------------------------------------------------------------------
// selectDispatchCandidates
// ---------------------------------------------------------------------------

test("selectDispatchCandidates admits only dispatchable states", () => {
  const result = selectDispatchCandidates({
    candidates: [
      { projection: projectionInState("m-draft", "draft"), workspaceId: "ws-1", lease: null, now: T0 },
      { projection: projectionInState("m-ready", "ready"), workspaceId: "ws-1", lease: null, now: T0 },
      { projection: projectionInState("m-blocked", "blocked"), workspaceId: "ws-1", lease: null, now: T0 },
      { projection: projectionInState("m-accepted", "accepted"), workspaceId: "ws-1", lease: null, now: T0 },
    ],
    policy,
  });
  assert.deepEqual(
    result.eligible.map((e) => e.missionId),
    ["m-ready"],
  );
  assert.deepEqual(
    result.refused.map((r) => r.missionId),
    ["m-draft", "m-blocked", "m-accepted"],
  );
  assert.ok(result.refused.every((r) => r.reason === "not_dispatchable_state"));
});

test("selectDispatchCandidates excludes a Mission with a live lease", () => {
  const lease = freshLease({ missionId: "m-1" });
  const result = selectDispatchCandidates({
    candidates: [{ projection: projectionInState("m-1", "executing"), workspaceId: "ws-1", lease, now: T0 }],
    policy,
  });
  assert.deepEqual(result.eligible, []);
  assert.deepEqual(result.refused, [{ missionId: "m-1", dispatchKey: "primary", reason: "already_leased" }]);
});

test("selectDispatchCandidates re-admits a Mission whose lease has actually expired", () => {
  const lease = freshLease({ missionId: "m-1" });
  const result = selectDispatchCandidates({
    candidates: [{ projection: projectionInState("m-1", "executing"), workspaceId: "ws-1", lease, now: minutesAfterT0(6) }],
    policy,
  });
  assert.deepEqual(result.eligible, [{ missionId: "m-1", dispatchKey: "primary" }]);
});

test("selectDispatchCandidates enforces the per-workspace concurrency budget, deterministically by input order", () => {
  const tightPolicy: SchedulerPolicy = { ...policy, maxConcurrentLeasesPerWorkspace: 2 };
  const result = selectDispatchCandidates({
    candidates: [
      { projection: projectionInState("m-1", "ready"), workspaceId: "ws-1", lease: null, now: T0 },
      { projection: projectionInState("m-2", "ready"), workspaceId: "ws-1", lease: null, now: T0 },
      { projection: projectionInState("m-3", "ready"), workspaceId: "ws-1", lease: null, now: T0 },
      { projection: projectionInState("m-4", "ready"), workspaceId: "ws-2", lease: null, now: T0 },
    ],
    policy: tightPolicy,
  });
  assert.deepEqual(
    result.eligible.map((e) => e.missionId),
    ["m-1", "m-2", "m-4"],
  );
  assert.deepEqual(result.refused, [{ missionId: "m-3", dispatchKey: "primary", reason: "workspace_budget_exhausted" }]);
});

test("selectDispatchCandidates treats different dispatchKeys on the same Mission as independent slots", () => {
  const implLease = freshLease({ missionId: "m-1", dispatchKey: "impl" });
  const result = selectDispatchCandidates({
    candidates: [
      { projection: projectionInState("m-1", "executing"), workspaceId: "ws-1", dispatchKey: "impl", lease: implLease, now: T0 },
      { projection: projectionInState("m-1", "executing"), workspaceId: "ws-1", dispatchKey: "review", lease: null, now: T0 },
    ],
    policy,
  });
  assert.deepEqual(result.eligible, [{ missionId: "m-1", dispatchKey: "review" }]);
  assert.deepEqual(result.refused, [{ missionId: "m-1", dispatchKey: "impl", reason: "already_leased" }]);
});
