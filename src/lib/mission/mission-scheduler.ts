/**
 * Mission scheduler — dispatch leases (Phase 2D)
 * ----------------------------------------------------------------------------
 * Scope held deliberately narrow, matching every prior Mission phase: pure
 * domain types, a pure lease state machine, and pure dispatch-candidate
 * selection. No database, no orchestrator wiring, no real provider dispatch —
 * those arrive once tenant-scope tests pass against the persisted layer.
 *
 * A dispatch lease answers one question: "who, if anyone, currently owns the
 * right to act on this Mission on the scheduler's behalf, and until when?"
 * It exists to prevent double-dispatch — two workers independently deciding
 * they're both allowed to pick up the same Mission — the same class of
 * problem `mission-concurrency.ts` solves for the aggregate's own event
 * stream, but at the scheduling layer rather than the domain-write layer.
 *
 * A lease is deliberately NOT a Mission state. `Mission.state` describes what
 * is true about the work; a lease describes who is currently allowed to
 * advance it, and for how long. A Mission can be `executing` while its lease
 * has silently expired (the worker crashed) — the Mission is not wrong about
 * its own state, the scheduler's bookkeeping about *who's driving* is just
 * stale, and that staleness must be detectable rather than assumed away.
 */

import type { MissionId, MissionState } from "./mission-domain";
import type { MissionProjection } from "./mission-projection";
import type { RunMode } from "@/lib/run-mode";

// ---------------------------------------------------------------------------
// Lease identity and holder
// ---------------------------------------------------------------------------

export type DispatchLeaseId = string;

/**
 * Identifies WHICH execution slot on a Mission a lease protects.
 *
 * The uniqueness boundary a lease enforces is `workspaceId + missionId +
 * dispatchKey`, never `missionId` alone. One Mission will eventually run
 * several concurrent assignments (a Codex implementation assignment, a
 * Claude security-review assignment, a browser-verification assignment) that
 * must be leased independently — a single mission-wide lock would force them
 * to serialize for no domain reason. For this vertical slice every Mission
 * has exactly one slot, `DEFAULT_DISPATCH_KEY`, representing "the Mission's
 * one execution seat"; a later phase can mint per-assignment dispatch keys
 * without touching this type or the state machine below, because nothing
 * here treats `dispatchKey` as anything other than an opaque identity
 * component.
 */
export type DispatchKey = string;

/** The single execution slot a Mission has before assignment-level dispatch keys exist. */
export const DEFAULT_DISPATCH_KEY: DispatchKey = "primary";

/** Who a lease is held by. Never inferred — always supplied by the caller. */
export type LeaseHolder =
  | { kind: "agent"; id: string }
  | { kind: "system"; id: "orchestrator" | "scheduler" | "reconciler" };

export function sameHolder(a: LeaseHolder, b: LeaseHolder): boolean {
  return a.kind === b.kind && a.id === b.id;
}

// ---------------------------------------------------------------------------
// Lease state
// ---------------------------------------------------------------------------

export const DISPATCH_LEASE_STATES = ["leased", "released", "expired", "revoked"] as const;
export type DispatchLeaseState = (typeof DISPATCH_LEASE_STATES)[number];

/**
 * Terminal with respect to THIS lease record. A new lease (a new
 * `leaseId`) can still be acquired for the same Mission afterward — ending a
 * lease never ends the Mission's eligibility for future dispatch.
 */
export const TERMINAL_LEASE_STATES = ["released", "expired", "revoked"] as const;
export type TerminalLeaseState = (typeof TERMINAL_LEASE_STATES)[number];

export function isTerminalLeaseState(state: DispatchLeaseState): state is TerminalLeaseState {
  return (TERMINAL_LEASE_STATES as readonly string[]).includes(state);
}

export interface DispatchLease {
  leaseId: DispatchLeaseId;
  missionId: MissionId;
  workspaceId: string;
  /** Which slot on the Mission this lease protects. See `DispatchKey`. */
  dispatchKey: DispatchKey;
  holder: LeaseHolder;
  state: DispatchLeaseState;
  /**
   * Monotonically increasing per lease lifetime: 1 on acquire, +1 on every
   * renewal. A worker must present the fencing token it was last given
   * before writing dispatch results; a stale worker that missed a renewal
   * (or was revoked and replaced) presents an old token and must be refused
   * by the caller, even if it doesn't yet know it lost the lease. See
   * `isFencingTokenCurrent`.
   */
  fencingToken: number;
  acquiredAt: string;
  expiresAt: string;
  renewedAt: string | null;
  releasedAt: string | null;
  revokedReason: string | null;
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export interface SchedulerPolicy {
  /** How long a freshly acquired or renewed lease is valid for. */
  leaseDurationMs: number;
  /**
   * A renewal is only honored within this many ms of the current
   * expiry — renewing an hour early would let a holder extend its grip
   * indefinitely by renewing constantly instead of on a real heartbeat
   * cadence. Renewing too late (past expiry) is not a renewal at all; the
   * lease has already lapsed and a fresh `acquireLease` is required.
   */
  renewalWindowMs: number;
  /** How many Missions one workspace may have under active lease at once. */
  maxConcurrentLeasesPerWorkspace: number;
}

export const DEFAULT_SCHEDULER_POLICY: SchedulerPolicy = {
  leaseDurationMs: 5 * 60_000,
  renewalWindowMs: 60_000,
  maxConcurrentLeasesPerWorkspace: 3,
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface LeaseHeldError {
  code: "lease_held";
  missionId: MissionId;
  dispatchKey: DispatchKey;
  holder: LeaseHolder;
  expiresAt: string;
  message: string;
}

export interface LeaseNotFoundError {
  code: "lease_not_found";
  missionId: MissionId;
}

export interface LeaseNotHeldByCallerError {
  code: "lease_not_held_by_caller";
  leaseId: DispatchLeaseId;
  actualHolder: LeaseHolder;
  message: string;
}

export interface LeaseAlreadyTerminalError {
  code: "lease_already_terminal";
  leaseId: DispatchLeaseId;
  state: TerminalLeaseState;
}

export interface LeaseExpiredError {
  code: "lease_expired";
  leaseId: DispatchLeaseId;
  expiresAt: string;
}

export interface RenewalOutsideWindowError {
  code: "renewal_outside_window";
  leaseId: DispatchLeaseId;
  expiresAt: string;
  renewalWindowOpensAt: string;
}

export type AcquireLeaseError = LeaseHeldError;
export type RenewLeaseError = LeaseAlreadyTerminalError | LeaseExpiredError | RenewalOutsideWindowError | LeaseNotHeldByCallerError;
export type ReleaseLeaseError = LeaseAlreadyTerminalError | LeaseNotHeldByCallerError;

// ---------------------------------------------------------------------------
// State machine — pure functions, no clock/id source of their own
// ---------------------------------------------------------------------------

export interface AcquireLeaseInput {
  leaseId: DispatchLeaseId;
  missionId: MissionId;
  workspaceId: string;
  dispatchKey: DispatchKey;
  holder: LeaseHolder;
  /** The currently recorded lease for this slot, if any. Null if never leased. */
  current: DispatchLease | null;
  now: string;
  policy: SchedulerPolicy;
}

export type AcquireLeaseResult = { ok: true; lease: DispatchLease } | { ok: false; error: AcquireLeaseError };

/**
 * Acquire a fresh lease. Succeeds when there is no lease on record, or the
 * recorded one is terminal, or the recorded one is still `leased` on paper
 * but has actually expired (a crashed holder does not get to keep blocking
 * dispatch forever). Refuses when a DIFFERENT, still-live holder is in
 * possession — the caller must wait, or a human/reconciler must `revokeLease`
 * first.
 */
export function acquireLease(input: AcquireLeaseInput): AcquireLeaseResult {
  const { current, now, policy } = input;

  if (current) {
    const stillLive = current.state === "leased" && Date.parse(current.expiresAt) > Date.parse(now);
    if (stillLive && !sameHolder(current.holder, input.holder)) {
      return {
        ok: false,
        error: {
          code: "lease_held",
          missionId: input.missionId,
          dispatchKey: input.dispatchKey,
          holder: current.holder,
          expiresAt: current.expiresAt,
          message: `Mission ${input.missionId} slot "${input.dispatchKey}" is already leased by ${current.holder.kind}:${current.holder.id} until ${current.expiresAt}.`,
        },
      };
    }
  }

  const expiresAt = new Date(Date.parse(now) + policy.leaseDurationMs).toISOString();
  return {
    ok: true,
    lease: {
      leaseId: input.leaseId,
      missionId: input.missionId,
      workspaceId: input.workspaceId,
      dispatchKey: input.dispatchKey,
      holder: input.holder,
      state: "leased",
      // Continues the PREVIOUS record's sequence rather than resetting to 1
      // whenever one exists — even a terminal or expired one. Fencing must be
      // monotonic across the whole slot's lifetime, not just within one
      // holder's tenancy: if generation N (fencingToken 1) expired and
      // generation N+2 reset back to 1, a write from the long-dead N worker
      // would be indistinguishable from a current N+2 write. Only a truly
      // fresh slot (current === null) starts at 1.
      fencingToken: current ? current.fencingToken + 1 : 1,
      acquiredAt: now,
      expiresAt,
      renewedAt: null,
      releasedAt: null,
      revokedReason: null,
    },
  };
}

export interface RenewLeaseInput {
  current: DispatchLease;
  holder: LeaseHolder;
  now: string;
  policy: SchedulerPolicy;
}

export type RenewLeaseResult = { ok: true; lease: DispatchLease } | { ok: false; error: RenewLeaseError };

/**
 * Extend a live lease's expiry and bump its fencing token. Only the current
 * holder may renew — a scheduler-side reconciler must `revokeLease` instead,
 * never silently take over via renewal.
 */
export function renewLease(input: RenewLeaseInput): RenewLeaseResult {
  const { current, holder, now, policy } = input;

  if (isTerminalLeaseState(current.state)) {
    return { ok: false, error: { code: "lease_already_terminal", leaseId: current.leaseId, state: current.state } };
  }
  if (!sameHolder(current.holder, holder)) {
    return {
      ok: false,
      error: {
        code: "lease_not_held_by_caller",
        leaseId: current.leaseId,
        actualHolder: current.holder,
        message: `Lease ${current.leaseId} is held by ${current.holder.kind}:${current.holder.id}, not ${holder.kind}:${holder.id}.`,
      },
    };
  }

  const nowMs = Date.parse(now);
  const expiresAtMs = Date.parse(current.expiresAt);
  if (nowMs > expiresAtMs) {
    return { ok: false, error: { code: "lease_expired", leaseId: current.leaseId, expiresAt: current.expiresAt } };
  }

  const renewalWindowOpensAtMs = expiresAtMs - policy.renewalWindowMs;
  if (nowMs < renewalWindowOpensAtMs) {
    return {
      ok: false,
      error: {
        code: "renewal_outside_window",
        leaseId: current.leaseId,
        expiresAt: current.expiresAt,
        renewalWindowOpensAt: new Date(renewalWindowOpensAtMs).toISOString(),
      },
    };
  }

  return {
    ok: true,
    lease: {
      ...current,
      fencingToken: current.fencingToken + 1,
      expiresAt: new Date(nowMs + policy.leaseDurationMs).toISOString(),
      renewedAt: now,
    },
  };
}

export interface ReleaseLeaseInput {
  current: DispatchLease;
  holder: LeaseHolder;
  now: string;
}

export type ReleaseLeaseResult = { ok: true; lease: DispatchLease } | { ok: false; error: ReleaseLeaseError };

/** Voluntary release by the current holder — e.g. work finished or handed off cleanly. */
export function releaseLease(input: ReleaseLeaseInput): ReleaseLeaseResult {
  const { current, holder, now } = input;

  if (isTerminalLeaseState(current.state)) {
    return { ok: false, error: { code: "lease_already_terminal", leaseId: current.leaseId, state: current.state } };
  }
  if (!sameHolder(current.holder, holder)) {
    return {
      ok: false,
      error: {
        code: "lease_not_held_by_caller",
        leaseId: current.leaseId,
        actualHolder: current.holder,
        message: `Lease ${current.leaseId} is held by ${current.holder.kind}:${current.holder.id}, not ${holder.kind}:${holder.id}.`,
      },
    };
  }

  return { ok: true, lease: { ...current, state: "released", releasedAt: now } };
}

export interface RevokeLeaseInput {
  current: DispatchLease;
  now: string;
  reason: string;
}

export type RevokeLeaseResult = { ok: true; lease: DispatchLease } | { ok: false; error: LeaseAlreadyTerminalError };

/**
 * Forcibly end a lease regardless of holder — the scheduler/reconciler's
 * escape hatch for a Mission that was cancelled, a holder that's known-dead,
 * or a human override. Unlike `releaseLease`, no holder match is required:
 * that asymmetry is the point.
 */
export function revokeLease(input: RevokeLeaseInput): RevokeLeaseResult {
  const { current, now, reason } = input;
  if (isTerminalLeaseState(current.state)) {
    return { ok: false, error: { code: "lease_already_terminal", leaseId: current.leaseId, state: current.state } };
  }
  return { ok: true, lease: { ...current, state: "revoked", releasedAt: now, revokedReason: reason } };
}

/**
 * Pure expiry check — does not mutate anything, just reports what a caller
 * SHOULD persist. Returns null when the lease is not actually expired (still
 * live, or already in a different terminal state) so a caller can tell
 * "nothing to do" apart from "here is the expired lease to write back."
 */
export function evaluateLeaseExpiry(current: DispatchLease, now: string): DispatchLease | null {
  if (current.state !== "leased") return null;
  if (Date.parse(now) <= Date.parse(current.expiresAt)) return null;
  return { ...current, state: "expired" };
}

/**
 * Whether a fencing token presented by a worker is still current for this
 * lease. A worker that renewed successfully has the latest token; one that
 * missed a renewal (its own network partition, a revoke it hasn't learned
 * about yet) presents a stale one and must be refused, even though from its
 * own point of view it still holds the lease.
 */
export function isFencingTokenCurrent(lease: DispatchLease, presentedToken: number): boolean {
  return lease.state === "leased" && presentedToken === lease.fencingToken;
}

// ---------------------------------------------------------------------------
// Dispatch candidate selection
// ---------------------------------------------------------------------------

/**
 * Mission states the scheduler is allowed to dispatch work for. Deliberately
 * excludes `needs_input`/`blocked`/`paused` (an interruption means a human or
 * external signal must act first, not the scheduler) and every terminal
 * state (spec STATE_MODEL §16 — terminal Missions never get new dispatch).
 */
export const DISPATCHABLE_MISSION_STATES: readonly MissionState[] = ["ready", "initializing", "executing", "reviewing", "verifying"];

export function isDispatchableMissionState(state: MissionState): boolean {
  return DISPATCHABLE_MISSION_STATES.includes(state);
}

export interface DispatchCandidateInput {
  projection: MissionProjection;
  workspaceId: string;
  /** Which slot on this Mission is being considered. Defaults callers to `DEFAULT_DISPATCH_KEY` if omitted. */
  dispatchKey?: DispatchKey;
  /** The lease currently on record for this Mission+slot, if any. */
  lease: DispatchLease | null;
  now: string;
}

export interface DispatchCandidateRefusal {
  missionId: MissionId;
  dispatchKey: DispatchKey;
  reason: "not_dispatchable_state" | "already_leased" | "workspace_budget_exhausted";
}

export interface DispatchCandidateSelection {
  missionId: MissionId;
  dispatchKey: DispatchKey;
}

export interface SelectDispatchCandidatesInput {
  candidates: DispatchCandidateInput[];
  policy: SchedulerPolicy;
}

export interface SelectDispatchCandidatesResult {
  eligible: DispatchCandidateSelection[];
  refused: DispatchCandidateRefusal[];
}

/**
 * Filter a batch of Missions down to the ones the scheduler may actually
 * dispatch right now: dispatchable state, no live competing lease, and still
 * within the workspace's concurrency budget. Order-sensitive and
 * deterministic — candidates are considered in the order given, so which
 * Missions win a scarce budget is a property of caller-supplied ordering
 * (e.g. oldest-first), never of iteration happenstance.
 */
export function selectDispatchCandidates(input: SelectDispatchCandidatesInput): SelectDispatchCandidatesResult {
  const { candidates, policy } = input;
  const eligible: DispatchCandidateSelection[] = [];
  const refused: DispatchCandidateRefusal[] = [];
  const activeLeaseCountByWorkspace = new Map<string, number>();

  for (const candidate of candidates) {
    const missionId = candidate.projection.missionId;
    const dispatchKey = candidate.dispatchKey ?? DEFAULT_DISPATCH_KEY;

    if (!isDispatchableMissionState(candidate.projection.state)) {
      refused.push({ missionId, dispatchKey, reason: "not_dispatchable_state" });
      continue;
    }

    const leaseIsLive = candidate.lease?.state === "leased" && Date.parse(candidate.lease.expiresAt) > Date.parse(candidate.now);
    if (leaseIsLive) {
      refused.push({ missionId, dispatchKey, reason: "already_leased" });
      continue;
    }

    const usedSoFar = activeLeaseCountByWorkspace.get(candidate.workspaceId) ?? 0;
    if (usedSoFar >= policy.maxConcurrentLeasesPerWorkspace) {
      refused.push({ missionId, dispatchKey, reason: "workspace_budget_exhausted" });
      continue;
    }

    activeLeaseCountByWorkspace.set(candidate.workspaceId, usedSoFar + 1);
    eligible.push({ missionId, dispatchKey });
  }

  return { eligible, refused };
}

/** Re-exported for callers that need to size a scheduler policy off a Mission's own RunMode budget, without importing run-mode.ts twice. */
export type { RunMode };
