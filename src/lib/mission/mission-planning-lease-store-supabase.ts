/**
 * Supabase-backed planning-job lease store — calls the atomic RPCs in
 * `supabase/migrations/20260727020000_mission_planning_leases.sql`.
 * ----------------------------------------------------------------------------
 * Pure RPC-shaping adapter: every refusal reason returned by
 * `claim_mission_planning_lease` / `renew_mission_planning_lease` /
 * `release_mission_planning_lease` / `revoke_mission_planning_lease` /
 * `validate_mission_planning_fence` is mapped to a distinct typed result
 * here — never collapsed into a generic "refused". No fencing/terminal/
 * scoping policy is re-implemented in this file; that all lives in the SQL
 * functions themselves (see the migration's own comments on what each
 * function verifies). This file only shapes RPC calls and RPC responses.
 *
 * `claim_mission_planning_lease` requires the caller to already know whether
 * the Mission is terminal and whether the planning request exists/is
 * terminal (`p_mission_terminal` / `p_request_exists` / `p_request_terminal`)
 * — the function trusts these like `claim_mission_dispatch_candidates_atomic`
 * trusts `p_dispatchable_states` (see the migration header comment). This
 * adapter does not compute those flags itself; the caller (the production
 * composition root / a future durable worker) is responsible for deriving
 * them from a `PlanningRequestPort` snapshot before calling `claim`.
 *
 * Timestamps: every `timestamptz` column the RPCs return comes back through
 * `supabase-js` as an ISO-8601 string already (the client library does not
 * hand back a `Date`), so no conversion happens here beyond passing through
 * exactly what Postgres/PostgREST serialized. Every `*_at` field on this
 * adapter's `SupabasePlanningLease` is therefore an ISO-8601 string, matching
 * `PlanningLease`'s own string timestamp fields in
 * `mission-planning-lease-store.ts`.
 *
 * `fencing_token` is a Postgres `integer` (max 2^31-1) — safely representable
 * as a JS `number` with no precision loss, so no `bigint` handling is needed;
 * this is verified in the tests below by round-tripping token values near
 * (but under) that bound.
 *
 * No provider/model call happens anywhere in this file — it only shapes RPC
 * arguments/responses for lease and (incidentally, via `claim`'s combined
 * return row) initial-attempt bookkeeping. No retry logic lives here either;
 * retries remain the worker's responsibility, exactly like
 * `mission-scheduler-store-supabase.ts`.
 *
 * Verified in `mission-planning-lease-store-supabase.test.ts` only at the
 * RPC-argument-shape level, against a fake SupabaseClient — the same
 * boundary `mission-planning-diagnostics-store-supabase.test.ts` and
 * `mission-store-supabase.test.ts` draw. Real row-locking/concurrency
 * behavior has never executed against a live Postgres instance in this
 * environment; `InMemoryPlanningLeaseStore` is where the concurrency
 * invariants are actually proven (real `Promise.all` interleaving).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";

export type SupabasePlanningLeaseStatus = "leased" | "released" | "expired" | "revoked";

export interface SupabasePlanningLease {
  workspaceId: string;
  missionId: string;
  planningRequestId: string;
  ownerId: string;
  leaseId: string;
  /** Monotonic per (workspaceId, missionId, planningRequestId) key — never resets, even across reclaim/revoke. */
  fencingToken: number;
  status: SupabasePlanningLeaseStatus;
  attempt: number;
  acquiredAt: string;
  renewedAt: string | null;
  expiresAt: string;
  releasedAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
}

export interface SupabasePlanningAttemptRow {
  workerAttemptId: string;
  workspaceId: string;
  missionId: string;
  planningRequestId: string;
  leaseId: string;
  fencingToken: number;
  workerId: string;
  modelConfigurationId: string;
  attemptKind: string;
  attemptNumber: number;
  state: string;
  contextHash: string;
  startedAt: string;
  correlationId: string;
  causationId: string | null;
  parentAttemptId: string | null;
}

export interface ClaimSupabasePlanningLeaseInput {
  workspaceId: string;
  missionId: string;
  planningRequestId: string;
  /**
   * Precomputed by the caller from a fresh `PlanningRequestPort` snapshot —
   * this adapter does not derive it. Optional, defaulting to `false`/`true`/
   * `false` (i.e. "don't refuse based on these") when omitted, matching
   * `InMemoryPlanningLeaseStore.claim`'s behavior exactly: the in-memory
   * store never checks Mission/request terminality at claim time either —
   * `MissionPlanningWorker` re-verifies both independently right after
   * claiming (`processCore`'s eligibility checks) and again immediately
   * before recording (`finalizeWithFencingCheck`). A caller that HAS already
   * computed these (e.g. a future discovery/scheduler pass) may still pass
   * them for defense-in-depth at the SQL layer.
   */
  missionTerminal?: boolean;
  requestExists?: boolean;
  requestTerminal?: boolean;
  ownerId: string;
  now: string;
  leaseDurationMs: number;
  /** Unused by this adapter — `mission_planning_leases.lease_id` is minted server-side via `gen_random_uuid()`. Accepted only so callers written against `ClaimPlanningLeaseInput`'s shape (mission-planning-lease-store.ts) can pass this adapter the same input object unmodified. */
  mintLeaseId?: () => string;
  /** Identifies the initial worker-attempt row `claim_mission_planning_lease` creates in the same transaction. Defaults to a freshly minted id via the constructor-injected `mintId` if omitted. */
  workerAttemptId?: string;
  workerId?: string;
  modelConfigurationId?: string;
  attemptKind?: string;
  attemptNumber?: number;
  contextHash?: string;
  correlationId?: string;
  causationId?: string | null;
}

export type ClaimSupabasePlanningLeaseResult =
  | { ok: true; lease: SupabasePlanningLease; attempt: SupabasePlanningAttemptRow }
  | {
      ok: false;
      reason:
        | "mission_not_found"
        | "workspace_mismatch"
        | "mission_terminal"
        | "planning_request_not_found"
        | "planning_request_terminal"
        | "already_leased";
    };

export interface RenewSupabasePlanningLeaseInput {
  workspaceId: string;
  missionId: string;
  planningRequestId: string;
  leaseId: string;
  fencingToken: number;
  now: string;
  leaseDurationMs: number;
}

export type RenewSupabasePlanningLeaseResult =
  | { ok: true; lease: SupabasePlanningLease }
  | { ok: false; reason: "not_found" | "stale_fencing_token" | "not_active" };

export type ReleaseSupabasePlanningLeaseResult =
  | { ok: true; lease: SupabasePlanningLease }
  | { ok: false; reason: "not_found" | "stale_fencing_token" | "already_released" };

export type RevokeSupabasePlanningLeaseResult =
  | { ok: true; lease: SupabasePlanningLease }
  | { ok: false; reason: "not_found" | "lease_already_terminal" };

const KNOWN_CLAIM_REASONS = new Set([
  "mission_not_found",
  "workspace_mismatch",
  "mission_terminal",
  "planning_request_not_found",
  "planning_request_terminal",
  "already_leased",
]);
const KNOWN_RENEW_REASONS = new Set(["not_found", "stale_fencing_token", "not_active"]);
const KNOWN_RELEASE_REASONS = new Set(["not_found", "stale_fencing_token", "already_released"]);
const KNOWN_REVOKE_REASONS = new Set(["not_found", "lease_already_terminal"]);

interface LeaseRow {
  workspace_id: string;
  mission_id: string;
  planning_request_id: string;
  lease_id: string;
  owner_id: string;
  fencing_token: number;
  status: SupabasePlanningLeaseStatus;
  attempt: number;
  acquired_at: string;
  renewed_at: string | null;
  expires_at: string;
  released_at: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
}

interface AttemptRow {
  worker_attempt_id: string;
  workspace_id: string;
  mission_id: string;
  planning_request_id: string;
  lease_id: string;
  fencing_token: number;
  worker_id: string;
  model_configuration_id: string;
  attempt_kind: string;
  attempt_number: number;
  state: string;
  context_hash: string;
  started_at: string;
  correlation_id: string;
  causation_id: string | null;
  parent_attempt_id: string | null;
}

function rowToLease(row: LeaseRow): SupabasePlanningLease {
  return {
    workspaceId: row.workspace_id,
    missionId: row.mission_id,
    planningRequestId: row.planning_request_id,
    ownerId: row.owner_id,
    leaseId: row.lease_id,
    fencingToken: row.fencing_token,
    status: row.status,
    attempt: row.attempt,
    acquiredAt: row.acquired_at,
    renewedAt: row.renewed_at,
    expiresAt: row.expires_at,
    releasedAt: row.released_at,
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason,
  };
}

function rowToAttempt(row: AttemptRow): SupabasePlanningAttemptRow {
  return {
    workerAttemptId: row.worker_attempt_id,
    workspaceId: row.workspace_id,
    missionId: row.mission_id,
    planningRequestId: row.planning_request_id,
    leaseId: row.lease_id,
    fencingToken: row.fencing_token,
    workerId: row.worker_id,
    modelConfigurationId: row.model_configuration_id,
    attemptKind: row.attempt_kind,
    attemptNumber: row.attempt_number,
    state: row.state,
    contextHash: row.context_hash,
    startedAt: row.started_at,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    parentAttemptId: row.parent_attempt_id,
  };
}

/** Every RPC returns exactly one row (a `returns table (...)` function with a single `return query select ...` per branch); this unwraps that array shape once, centrally. */
function firstRow<T>(data: unknown, rpcName: string): T {
  const row = Array.isArray(data) ? (data[0] as T | undefined) : (data as T | undefined);
  if (row === undefined || row === null) throw new Error(`${rpcName} RPC returned no row.`);
  return row;
}

export class SupabaseMissionPlanningLeaseStore {
  private readonly client: SupabaseClient;
  private readonly mintId: () => string;
  private idCounter = 0;

  constructor(client: SupabaseClient, mintId?: () => string) {
    this.client = client;
    this.mintId = mintId ?? (() => `spl-${Date.now().toString(36)}-${(this.idCounter += 1)}`);
  }

  async claim(input: ClaimSupabasePlanningLeaseInput): Promise<ClaimSupabasePlanningLeaseResult> {
    const { data, error } = await this.client.rpc("claim_mission_planning_lease", {
      p_workspace_id: input.workspaceId,
      p_mission_id: input.missionId,
      p_planning_request_id: input.planningRequestId,
      p_mission_terminal: input.missionTerminal ?? false,
      p_request_exists: input.requestExists ?? true,
      p_request_terminal: input.requestTerminal ?? false,
      p_owner_id: input.ownerId,
      p_now: input.now,
      p_lease_duration_ms: input.leaseDurationMs,
      p_worker_attempt_id: input.workerAttemptId ?? this.mintId(),
      p_worker_id: input.workerId ?? input.ownerId,
      p_model_configuration_id: input.modelConfigurationId ?? "unknown",
      p_attempt_kind: input.attemptKind ?? "initial_invocation",
      p_attempt_number: input.attemptNumber ?? 1,
      p_context_hash: input.contextHash ?? "unknown",
      p_correlation_id: input.correlationId ?? this.mintId(),
      p_causation_id: input.causationId ?? null,
    });
    if (error) throw new Error(`Failed to claim Mission planning lease: ${error.message}`);

    const row = firstRow<{ status: string; reason: string | null; lease: LeaseRow | null; attempt: AttemptRow | null }>(
      data,
      "claim_mission_planning_lease",
    );

    if (row.status === "claimed") {
      if (!row.lease || !row.attempt) throw new Error("claim_mission_planning_lease returned 'claimed' with a missing lease or attempt row.");
      return { ok: true, lease: rowToLease(row.lease), attempt: rowToAttempt(row.attempt) };
    }
    if (row.status === "refused") {
      if (!row.reason || !KNOWN_CLAIM_REASONS.has(row.reason)) {
        throw new Error(`claim_mission_planning_lease returned an unrecognized refusal reason: ${String(row.reason)}`);
      }
      return {
        ok: false,
        reason: row.reason as
          | "mission_not_found"
          | "workspace_mismatch"
          | "mission_terminal"
          | "planning_request_not_found"
          | "planning_request_terminal"
          | "already_leased",
      };
    }
    throw new Error(`claim_mission_planning_lease returned an unrecognized status: ${String(row.status)}`);
  }

  async renew(input: RenewSupabasePlanningLeaseInput): Promise<RenewSupabasePlanningLeaseResult> {
    const { data, error } = await this.client.rpc("renew_mission_planning_lease", {
      p_workspace_id: input.workspaceId,
      p_mission_id: input.missionId,
      p_planning_request_id: input.planningRequestId,
      p_lease_id: input.leaseId,
      p_fencing_token: input.fencingToken,
      p_now: input.now,
      p_lease_duration_ms: input.leaseDurationMs,
    });
    if (error) throw new Error(`Failed to renew Mission planning lease: ${error.message}`);
    const row = firstRow<{ status: string; reason: string | null; lease: LeaseRow | null }>(data, "renew_mission_planning_lease");
    if (row.status === "ok") {
      if (!row.lease) throw new Error("renew_mission_planning_lease returned 'ok' with no lease row.");
      return { ok: true, lease: rowToLease(row.lease) };
    }
    if (row.status === "refused") {
      if (!row.reason || !KNOWN_RENEW_REASONS.has(row.reason)) {
        throw new Error(`renew_mission_planning_lease returned an unrecognized refusal reason: ${String(row.reason)}`);
      }
      return { ok: false, reason: row.reason as "not_found" | "stale_fencing_token" | "not_active" };
    }
    throw new Error(`renew_mission_planning_lease returned an unrecognized status: ${String(row.status)}`);
  }

  async release(workspaceId: string, missionId: string, planningRequestId: string, leaseId: string, fencingToken: number, now: string): Promise<ReleaseSupabasePlanningLeaseResult> {
    const { data, error } = await this.client.rpc("release_mission_planning_lease", {
      p_workspace_id: workspaceId,
      p_mission_id: missionId,
      p_planning_request_id: planningRequestId,
      p_lease_id: leaseId,
      p_fencing_token: fencingToken,
      p_now: now,
    });
    if (error) throw new Error(`Failed to release Mission planning lease: ${error.message}`);
    const row = firstRow<{ status: string; reason: string | null; lease: LeaseRow | null }>(data, "release_mission_planning_lease");
    if (row.status === "ok") {
      if (!row.lease) throw new Error("release_mission_planning_lease returned 'ok' with no lease row.");
      return { ok: true, lease: rowToLease(row.lease) };
    }
    if (row.status === "refused") {
      if (!row.reason || !KNOWN_RELEASE_REASONS.has(row.reason)) {
        throw new Error(`release_mission_planning_lease returned an unrecognized refusal reason: ${String(row.reason)}`);
      }
      return { ok: false, reason: row.reason as "not_found" | "stale_fencing_token" | "already_released" };
    }
    throw new Error(`release_mission_planning_lease returned an unrecognized status: ${String(row.status)}`);
  }

  /** Reconciler-only override for a terminal Mission / dead worker — not fencing-checked, matching the SQL function's own doc comment. */
  async revoke(workspaceId: string, missionId: string, planningRequestId: string, now: string, reason: string): Promise<RevokeSupabasePlanningLeaseResult> {
    const { data, error } = await this.client.rpc("revoke_mission_planning_lease", {
      p_workspace_id: workspaceId,
      p_mission_id: missionId,
      p_planning_request_id: planningRequestId,
      p_now: now,
      p_reason: reason,
    });
    if (error) throw new Error(`Failed to revoke Mission planning lease: ${error.message}`);
    const row = firstRow<{ status: string; reason: string | null; lease: LeaseRow | null }>(data, "revoke_mission_planning_lease");
    if (row.status === "ok") {
      if (!row.lease) throw new Error("revoke_mission_planning_lease returned 'ok' with no lease row.");
      return { ok: true, lease: rowToLease(row.lease) };
    }
    if (row.status === "refused") {
      if (!row.reason || !KNOWN_REVOKE_REASONS.has(row.reason)) {
        throw new Error(`revoke_mission_planning_lease returned an unrecognized refusal reason: ${String(row.reason)}`);
      }
      return { ok: false, reason: row.reason as "not_found" | "lease_already_terminal" };
    }
    throw new Error(`revoke_mission_planning_lease returned an unrecognized status: ${String(row.status)}`);
  }

  /** Used just before recording a result — a stale/fenced-out worker must fail this check. Matches `InMemoryPlanningLeaseStore.isFencingTokenCurrent`'s name/shape. */
  async isFencingTokenCurrent(workspaceId: string, missionId: string, planningRequestId: string, leaseId: string, fencingToken: number): Promise<boolean> {
    const { data, error } = await this.client.rpc("validate_mission_planning_fence", {
      p_workspace_id: workspaceId,
      p_mission_id: missionId,
      p_planning_request_id: planningRequestId,
      p_lease_id: leaseId,
      p_fencing_token: fencingToken,
    });
    if (error) throw new Error(`Failed to validate Mission planning fence: ${error.message}`);
    if (typeof data !== "boolean") throw new Error(`validate_mission_planning_fence returned a non-boolean value: ${String(data)}`);
    return data;
  }

  /** Plain read — no RPC needed, matching `listOutstandingDispatchIntents`'s direct-select precedent in `mission-scheduler-store-supabase.ts`. */
  async peek(workspaceId: string, missionId: string, planningRequestId: string): Promise<SupabasePlanningLease | null> {
    const { data, error } = await this.client
      .from("mission_planning_leases")
      .select(
        "workspace_id, mission_id, planning_request_id, lease_id, owner_id, fencing_token, status, attempt, acquired_at, renewed_at, expires_at, released_at, revoked_at, revoked_reason",
      )
      .eq("workspace_id", workspaceId)
      .eq("mission_id", missionId)
      .eq("planning_request_id", planningRequestId)
      .maybeSingle();
    if (error) throw new Error(`Failed to read Mission planning lease for ${planningRequestId}: ${error.message}`);
    if (!data) return null;
    return rowToLease(data as LeaseRow);
  }
}

/** Guarded factory — throws if OathLock's Supabase env is not configured, matching the rest of the service layer. */
export function createSupabaseMissionPlanningLeaseStore(mintId?: () => string): SupabaseMissionPlanningLeaseStore {
  if (!supabase) throw new Error("M9R agent backend is not configured.");
  return new SupabaseMissionPlanningLeaseStore(supabase, mintId);
}
