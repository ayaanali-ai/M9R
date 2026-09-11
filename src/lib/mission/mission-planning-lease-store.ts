/**
 * Planning-job lease store — Phase 5C §1.
 * ----------------------------------------------------------------------------
 * A lease over ONE `PlanningRequestRecord` (Phase 5B), distinct in every way
 * from `mission-scheduler-store.ts`'s dispatch lease: different keying
 * (`workspaceId + missionId + planningRequestId`, never a `dispatchKey`
 * slot), different owner (a planning worker, never an assignment executor),
 * different lifecycle (planning workers never dispatch, materialize, or
 * approve anything). The atomicity argument mirrors
 * `InMemoryMissionSchedulerStore`'s exactly: every method here is fully
 * synchronous internally — no `await` between reading a lease's state and
 * committing a mutation — so two concurrent claims raced via `Promise.all`
 * can never interleave mid-decision.
 *
 * In-memory only. A real Postgres-backed store would copy the same
 * atomic-claim contract `supabase/migrations/20260726010000_mission_dispatch_leases.sql`
 * uses (ordered-lock claim function, monotonic fencing token, security
 * definer, workspace-scoped) — deferred here; see Phase 5C report for why.
 */

export type PlanningLeaseStatus = "active" | "expired" | "released";

export interface PlanningLease {
  workspaceId: string;
  missionId: string;
  planningRequestId: string;
  ownerId: string;
  leaseId: string;
  /** Monotonic per (workspaceId, missionId, planningRequestId) key — never resets, even across reclaim. */
  fencingToken: number;
  acquiredAt: string;
  expiresAt: string;
  attempt: number;
  status: PlanningLeaseStatus;
}

export interface ClaimPlanningLeaseInput {
  workspaceId: string;
  missionId: string;
  planningRequestId: string;
  ownerId: string;
  now: string;
  leaseDurationMs: number;
  mintLeaseId: () => string;
}

export type ClaimPlanningLeaseResult =
  | { ok: true; lease: PlanningLease }
  | { ok: false; reason: "already_leased"; heldBy: string; expiresAt: string };

export interface RenewPlanningLeaseInput {
  workspaceId: string;
  missionId: string;
  planningRequestId: string;
  leaseId: string;
  fencingToken: number;
  now: string;
  leaseDurationMs: number;
}

export type RenewPlanningLeaseResult =
  | { ok: true; lease: PlanningLease }
  | { ok: false; reason: "not_found" | "stale_fencing_token" | "not_active" };

export type ReleasePlanningLeaseResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "stale_fencing_token" | "already_released" };

function key(workspaceId: string, missionId: string, planningRequestId: string): string {
  return `${workspaceId}::${missionId}::${planningRequestId}`;
}

function isExpired(lease: PlanningLease, now: string): boolean {
  return new Date(lease.expiresAt).getTime() <= new Date(now).getTime();
}

export class InMemoryPlanningLeaseStore {
  private readonly leases = new Map<string, PlanningLease>();
  /** Highest fencing token ever issued per key — survives release/expiry so a token is never reused. */
  private readonly maxFencingToken = new Map<string, number>();

  /** Two (or ten) workers racing the same request: exactly one call here wins — no `await` between read and write. */
  claim(input: ClaimPlanningLeaseInput): ClaimPlanningLeaseResult {
    const k = key(input.workspaceId, input.missionId, input.planningRequestId);
    const current = this.leases.get(k);

    if (current && current.status === "active" && !isExpired(current, input.now)) {
      return { ok: false, reason: "already_leased", heldBy: current.ownerId, expiresAt: current.expiresAt };
    }

    const priorAttempt = current ? current.attempt : 0;
    const nextToken = (this.maxFencingToken.get(k) ?? 0) + 1;
    this.maxFencingToken.set(k, nextToken);

    const lease: PlanningLease = {
      workspaceId: input.workspaceId,
      missionId: input.missionId,
      planningRequestId: input.planningRequestId,
      ownerId: input.ownerId,
      leaseId: input.mintLeaseId(),
      fencingToken: nextToken,
      acquiredAt: input.now,
      expiresAt: new Date(new Date(input.now).getTime() + input.leaseDurationMs).toISOString(),
      attempt: priorAttempt + 1,
      status: "active",
    };
    this.leases.set(k, lease);
    return { ok: true, lease };
  }

  renew(input: RenewPlanningLeaseInput): RenewPlanningLeaseResult {
    const k = key(input.workspaceId, input.missionId, input.planningRequestId);
    const current = this.leases.get(k);
    if (!current || current.leaseId !== input.leaseId) return { ok: false, reason: "not_found" };
    if (current.fencingToken !== input.fencingToken) return { ok: false, reason: "stale_fencing_token" };
    if (current.status !== "active" || isExpired(current, input.now)) return { ok: false, reason: "not_active" };
    const renewed: PlanningLease = { ...current, expiresAt: new Date(new Date(input.now).getTime() + input.leaseDurationMs).toISOString() };
    this.leases.set(k, renewed);
    return { ok: true, lease: renewed };
  }

  release(workspaceId: string, missionId: string, planningRequestId: string, leaseId: string, fencingToken: number): ReleasePlanningLeaseResult {
    const k = key(workspaceId, missionId, planningRequestId);
    const current = this.leases.get(k);
    if (!current || current.leaseId !== leaseId) return { ok: false, reason: "not_found" };
    if (current.fencingToken !== fencingToken) return { ok: false, reason: "stale_fencing_token" };
    if (current.status !== "active") return { ok: false, reason: "already_released" };
    this.leases.set(k, { ...current, status: "released" });
    return { ok: true };
  }

  /** Used just before `RecordModelPlanningResult` — a stale/fenced-out worker must fail this check. */
  isFencingTokenCurrent(workspaceId: string, missionId: string, planningRequestId: string, leaseId: string, fencingToken: number, now: string): boolean {
    const k = key(workspaceId, missionId, planningRequestId);
    const current = this.leases.get(k);
    if (!current || current.leaseId !== leaseId) return false;
    if (current.fencingToken !== fencingToken) return false;
    if (current.status !== "active") return false;
    if (isExpired(current, now)) return false;
    return true;
  }

  peek(workspaceId: string, missionId: string, planningRequestId: string): PlanningLease | null {
    return this.leases.get(key(workspaceId, missionId, planningRequestId)) ?? null;
  }
}
