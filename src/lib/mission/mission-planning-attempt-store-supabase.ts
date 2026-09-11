/**
 * Supabase-backed durable worker-attempt store — calls the atomic RPCs in
 * `supabase/migrations/20260727010000_mission_planning_worker_attempts.sql`,
 * plus plain reads against `mission_planning_worker_attempts` (no new RPC
 * needed for reads — see the note below).
 * ----------------------------------------------------------------------------
 * Pure RPC-shaping adapter, matching the same boundary
 * `mission-planning-lease-store-supabase.ts` and
 * `mission-planning-diagnostics-store-supabase.ts` draw: no domain-policy
 * duplication here. Append-only transition semantics, stale-fence rejection,
 * duplicate-vs-conflicting terminal writes, and providerRequestId
 * immutability are all enforced by `transition_mission_planning_attempt` /
 * `attach_mission_planning_attempt_provider_request_id` themselves (see that
 * migration's own header comments) — this file only shapes RPC
 * arguments/responses and maps every distinct reason to a distinct typed
 * result, exactly like `InMemoryPlanningAttemptStore.transition`'s own
 * documented contract.
 *
 * NEW READ-ONLY MIGRATION FUNCTION: NOT ADDED. The task allowed adding
 * exactly one narrowly-scoped read-only SQL function if genuinely needed for
 * `get`/`listForRequest`/`listNonTerminal`, following
 * `get_mission_planning_diagnostic`'s style. It turned out not to be
 * needed: `mission_planning_worker_attempts` already grants
 * `select` to `service_role` (see the migration's closing grants), so plain
 * `.from("mission_planning_worker_attempts").select(...)` reads work
 * directly — the exact same precedent
 * `mission-scheduler-store-supabase.ts`'s `listOutstandingDispatchIntents`
 * already uses against `mission_dispatch_intents`. No RLS exists on this
 * table (service-role-only, like every other Mission-adjacent table), so a
 * plain select is not blocked. Because a plain select already covers every
 * read this adapter needs, no new migration file was added.
 *
 * Cross-workspace refusal: `transition_mission_planning_attempt` /
 * `attach_mission_planning_attempt_provider_request_id` look up the attempt
 * row by `worker_attempt_id` alone (its own primary key) and do not take a
 * `workspace_id` argument at all (see the migration) — so cross-workspace
 * protection for those two calls is NOT enforced by that SQL layer itself.
 * This adapter closes that gap the same way `PlanningRequestPortImpl`
 * closes the analogous gap for Mission commands (defense-in-depth, not a
 * replacement for a real workspace column check): every mutating method
 * here takes the caller's `workspaceId`, reads the attempt row first, and
 * refuses with a distinct `workspace_mismatch` result if the row's own
 * `workspace_id` does not match — before ever calling the mutating RPC.
 * `getForRequest`-style reads (`listForRequest`) are scoped by
 * `workspace_id` directly in the `.eq(...)` filter, so no attempt belonging
 * to a different workspace is ever returned to begin with.
 *
 * Timestamps: `supabase-js` already deserializes every `timestamptz` column
 * as an ISO-8601 string (never a `Date`), so no conversion happens here.
 * `outcome_unknown` is passed through verbatim as a real
 * `PlanningAttemptOutcome` value, never coerced to a different terminal
 * classification.
 *
 * No raw model output or secrets ever pass through this file — every method
 * signature only accepts/returns attempt-metadata fields (state, timestamps,
 * ids, context hash, retry counters), never diagnostic payloads or model
 * text; that data lives exclusively in
 * `mission-planning-diagnostics-store-supabase.ts`.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import type { CreateAttemptInput, PlanningAttemptOutcome, PlanningAttemptState } from "./mission-planning-attempt-store";

export interface SupabasePlanningWorkerAttempt {
  workerAttemptId: string;
  workspaceId: string;
  missionId: string;
  planningRequestId: string;
  leaseId: string;
  fencingToken: number;
  workerId: string;
  modelConfigurationId: string;
  providerRequestId: string | null;
  attemptKind: string;
  attemptNumber: number;
  state: PlanningAttemptState;
  contextHash: string;
  outcomeClassification: PlanningAttemptOutcome;
  diagnosticRef: string | null;
  retryClass: string | null;
  startedAt: string;
  responseReceivedAt: string | null;
  completedAt: string | null;
  correlationId: string;
  causationId: string | null;
  parentAttemptId: string | null;
}

export type TransitionSupabaseAttemptResult =
  | { ok: true; attempt: SupabasePlanningWorkerAttempt; noop: boolean }
  | { ok: false; reason: "not_found" | "stale_fencing_token" | "conflicting_terminal_write" | "workspace_mismatch" };

export type AttachProviderRequestIdResult =
  | { ok: true; attempt: SupabasePlanningWorkerAttempt }
  | { ok: false; reason: "not_found" | "stale_fencing_token" | "conflicting_terminal_write" | "workspace_mismatch" };

const KNOWN_TRANSITION_REASONS = new Set(["not_found", "stale_fencing_token", "conflicting_terminal_write"]);
const NOOP_REASON = "noop_duplicate_terminal";

interface AttemptRow {
  worker_attempt_id: string;
  workspace_id: string;
  mission_id: string;
  planning_request_id: string;
  lease_id: string;
  fencing_token: number;
  worker_id: string;
  model_configuration_id: string;
  provider_request_id: string | null;
  attempt_kind: string;
  attempt_number: number;
  state: string;
  context_hash: string;
  outcome_classification: string | null;
  diagnostic_ref: string | null;
  retry_class: string | null;
  started_at: string;
  response_received_at: string | null;
  completed_at: string | null;
  correlation_id: string;
  causation_id: string | null;
  parent_attempt_id: string | null;
}

function rowToAttempt(row: AttemptRow): SupabasePlanningWorkerAttempt {
  return {
    workerAttemptId: row.worker_attempt_id,
    workspaceId: row.workspace_id,
    missionId: row.mission_id,
    planningRequestId: row.planning_request_id,
    leaseId: row.lease_id,
    fencingToken: row.fencing_token,
    workerId: row.worker_id,
    modelConfigurationId: row.model_configuration_id,
    providerRequestId: row.provider_request_id,
    attemptKind: row.attempt_kind,
    attemptNumber: row.attempt_number,
    state: row.state as PlanningAttemptState,
    contextHash: row.context_hash,
    outcomeClassification: (row.outcome_classification ?? null) as PlanningAttemptOutcome,
    diagnosticRef: row.diagnostic_ref,
    retryClass: row.retry_class,
    startedAt: row.started_at,
    responseReceivedAt: row.response_received_at,
    completedAt: row.completed_at,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    parentAttemptId: row.parent_attempt_id,
  };
}

function firstRow<T>(data: unknown, rpcName: string): T {
  const row = Array.isArray(data) ? (data[0] as T | undefined) : (data as T | undefined);
  if (row === undefined || row === null) throw new Error(`${rpcName} RPC returned no row.`);
  return row;
}

export class SupabaseMissionPlanningAttemptStore {
  private readonly client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.client = client;
  }

  /**
   * Standalone creation path via `create_mission_planning_attempt` — used by
   * `MissionPlanningWorker`'s post-hoc attempt bookkeeping
   * (`process()`'s wrapper) for a lease this store did not already create an
   * attempt for. When `claim_mission_planning_lease` was used instead (the
   * normal path), that RPC already created the initial attempt row in the
   * SAME transaction as the claim (see the lease migration) — calling this
   * method again for that exact `leaseId`/`fencingToken` pair would be
   * redundant, so callers should check `listForRequest` first (the worker
   * already does this).
   */
  async create(input: CreateAttemptInput): Promise<SupabasePlanningWorkerAttempt> {
    const { data, error } = await this.client.rpc("create_mission_planning_attempt", {
      p_worker_attempt_id: input.mintId(),
      p_workspace_id: input.workspaceId,
      p_mission_id: input.missionId,
      p_planning_request_id: input.planningRequestId,
      p_lease_id: input.leaseId,
      p_fencing_token: input.fencingToken,
      p_worker_id: input.workerIdentity,
      p_model_configuration_id: input.modelConfigurationId,
      p_attempt_kind: input.attemptKind === "initial" ? "initial_invocation" : "schema_repair",
      p_attempt_number: input.attemptNumber,
      p_context_hash: input.contextHash,
      p_correlation_id: input.correlationId,
      p_causation_id: input.causationId ?? null,
      p_parent_attempt_id: input.parentAttemptId ?? null,
      p_now: input.now,
    });
    if (error) throw new Error(`Failed to create Mission planning worker attempt: ${error.message}`);
    const row = Array.isArray(data) ? (data[0] as AttemptRow | undefined) : (data as AttemptRow | undefined);
    if (!row) throw new Error("create_mission_planning_attempt RPC returned no row.");
    return rowToAttempt(row);
  }

  /** Plain read by primary key — covers the "initial attempt row created by claim_mission_planning_lease must be readable" requirement. No RPC needed (see file header). */
  async get(workerAttemptId: string): Promise<SupabasePlanningWorkerAttempt | null> {
    const { data, error } = await this.client
      .from("mission_planning_worker_attempts")
      .select(
        "worker_attempt_id, workspace_id, mission_id, planning_request_id, lease_id, fencing_token, worker_id, model_configuration_id, provider_request_id, attempt_kind, attempt_number, state, context_hash, outcome_classification, diagnostic_ref, retry_class, started_at, response_received_at, completed_at, correlation_id, causation_id, parent_attempt_id",
      )
      .eq("worker_attempt_id", workerAttemptId)
      .maybeSingle();
    if (error) throw new Error(`Failed to read Mission planning worker attempt ${workerAttemptId}: ${error.message}`);
    if (!data) return null;
    return rowToAttempt(data as AttemptRow);
  }

  /** All attempts for one planning request, oldest first, scoped by workspace — matches `InMemoryPlanningAttemptStore.listForRequest`. */
  async listForRequest(workspaceId: string, missionId: string, planningRequestId: string): Promise<SupabasePlanningWorkerAttempt[]> {
    const { data, error } = await this.client
      .from("mission_planning_worker_attempts")
      .select(
        "worker_attempt_id, workspace_id, mission_id, planning_request_id, lease_id, fencing_token, worker_id, model_configuration_id, provider_request_id, attempt_kind, attempt_number, state, context_hash, outcome_classification, diagnostic_ref, retry_class, started_at, response_received_at, completed_at, correlation_id, causation_id, parent_attempt_id",
      )
      .eq("workspace_id", workspaceId)
      .eq("mission_id", missionId)
      .eq("planning_request_id", planningRequestId)
      .order("started_at", { ascending: true });
    if (error) throw new Error(`Failed to list Mission planning worker attempts for ${planningRequestId}: ${error.message}`);
    return (data ?? []).map((row) => rowToAttempt(row as AttemptRow));
  }

  /** Non-terminal attempts for one workspace — what a recovery pass scans. Matches `InMemoryPlanningAttemptStore.listNonTerminal`, but workspace-scoped (the in-memory store has no notion of scanning "the whole store" across workspaces safely). */
  async listNonTerminal(workspaceId: string): Promise<SupabasePlanningWorkerAttempt[]> {
    const { data, error } = await this.client
      .from("mission_planning_worker_attempts")
      .select(
        "worker_attempt_id, workspace_id, mission_id, planning_request_id, lease_id, fencing_token, worker_id, model_configuration_id, provider_request_id, attempt_kind, attempt_number, state, context_hash, outcome_classification, diagnostic_ref, retry_class, started_at, response_received_at, completed_at, correlation_id, causation_id, parent_attempt_id",
      )
      .eq("workspace_id", workspaceId)
      .not("state", "in", "(completed,failed,cancelled,stale,superseded,lease_lost,outcome_unknown)");
    if (error) throw new Error(`Failed to list non-terminal Mission planning worker attempts for ${workspaceId}: ${error.message}`);
    return (data ?? []).map((row) => rowToAttempt(row as AttemptRow));
  }

  /**
   * Append-only transition. Cross-workspace defense-in-depth: reads the
   * attempt first and refuses with `workspace_mismatch` if
   * `input.workspaceId` does not match the row's own `workspace_id`, BEFORE
   * calling `transition_mission_planning_attempt` (which has no
   * `workspace_id` argument of its own — see file header).
   */
  async transition(input: {
    workspaceId: string;
    workerAttemptId: string;
    fencingToken: number;
    toState: PlanningAttemptState;
    now: string;
    detail?: string;
    outcomeClassification?: PlanningAttemptOutcome;
  }): Promise<TransitionSupabaseAttemptResult> {
    const existing = await this.get(input.workerAttemptId);
    if (!existing) return { ok: false, reason: "not_found" };
    if (existing.workspaceId !== input.workspaceId) return { ok: false, reason: "workspace_mismatch" };

    const { data, error } = await this.client.rpc("transition_mission_planning_attempt", {
      p_worker_attempt_id: input.workerAttemptId,
      p_fencing_token: input.fencingToken,
      p_to_state: input.toState,
      p_now: input.now,
      p_detail: input.detail ?? null,
      p_outcome_classification: input.outcomeClassification ?? null,
    });
    if (error) throw new Error(`Failed to transition Mission planning worker attempt ${input.workerAttemptId}: ${error.message}`);

    const row = firstRow<{ status: string; reason: string | null; attempt: AttemptRow | null }>(data, "transition_mission_planning_attempt");
    if (row.status === "ok") {
      if (!row.attempt) throw new Error("transition_mission_planning_attempt returned 'ok' with no attempt row.");
      if (row.reason === NOOP_REASON) return { ok: true, attempt: rowToAttempt(row.attempt), noop: true };
      if (row.reason !== null) throw new Error(`transition_mission_planning_attempt returned an unrecognized 'ok' reason: ${String(row.reason)}`);
      return { ok: true, attempt: rowToAttempt(row.attempt), noop: false };
    }
    if (row.status === "refused") {
      if (!row.reason || !KNOWN_TRANSITION_REASONS.has(row.reason)) {
        throw new Error(`transition_mission_planning_attempt returned an unrecognized refusal reason: ${String(row.reason)}`);
      }
      return { ok: false, reason: row.reason as "not_found" | "stale_fencing_token" | "conflicting_terminal_write" };
    }
    throw new Error(`transition_mission_planning_attempt returned an unrecognized status: ${String(row.status)}`);
  }

  /**
   * providerRequestId cannot be replaced once set to a different value — the
   * RPC returns `conflicting_terminal_write` for that case (reusing the same
   * refusal reason name `transition` uses for a conflicting terminal write,
   * per the migration's own function body). Same cross-workspace
   * defense-in-depth as `transition`.
   */
  async attachProviderRequestId(input: { workspaceId: string; workerAttemptId: string; fencingToken: number; providerRequestId: string }): Promise<AttachProviderRequestIdResult> {
    const existing = await this.get(input.workerAttemptId);
    if (!existing) return { ok: false, reason: "not_found" };
    if (existing.workspaceId !== input.workspaceId) return { ok: false, reason: "workspace_mismatch" };

    const { data, error } = await this.client.rpc("attach_mission_planning_attempt_provider_request_id", {
      p_worker_attempt_id: input.workerAttemptId,
      p_fencing_token: input.fencingToken,
      p_provider_request_id: input.providerRequestId,
    });
    if (error) throw new Error(`Failed to attach provider request id to Mission planning worker attempt ${input.workerAttemptId}: ${error.message}`);

    const row = firstRow<{ status: string; reason: string | null; attempt: AttemptRow | null }>(data, "attach_mission_planning_attempt_provider_request_id");
    if (row.status === "ok") {
      if (!row.attempt) throw new Error("attach_mission_planning_attempt_provider_request_id returned 'ok' with no attempt row.");
      return { ok: true, attempt: rowToAttempt(row.attempt) };
    }
    if (row.status === "refused") {
      if (!row.reason || !KNOWN_TRANSITION_REASONS.has(row.reason)) {
        throw new Error(`attach_mission_planning_attempt_provider_request_id returned an unrecognized refusal reason: ${String(row.reason)}`);
      }
      return { ok: false, reason: row.reason as "not_found" | "stale_fencing_token" | "conflicting_terminal_write" };
    }
    throw new Error(`attach_mission_planning_attempt_provider_request_id returned an unrecognized status: ${String(row.status)}`);
  }
}

/** Guarded factory — throws if OathLock's Supabase env is not configured, matching the rest of the service layer. */
export function createSupabaseMissionPlanningAttemptStore(): SupabaseMissionPlanningAttemptStore {
  if (!supabase) throw new Error("M9R agent backend is not configured.");
  return new SupabaseMissionPlanningAttemptStore(supabase);
}
