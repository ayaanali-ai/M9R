/**
 * Supabase-backed planning replayable-response store — Phase 5E Task B.
 * ----------------------------------------------------------------------------
 * Calls the already-deployed RPCs in
 * `supabase/migrations/20260727030000_mission_planning_diagnostics.sql`:
 * `create_mission_planning_replayable_response` /
 * `get_mission_planning_replayable_response`. Mirrors the
 * `SupabasePlanningDiagnosticsStore` pattern (`mission-planning-diagnostics-
 * store-supabase.ts`): verified here only at the RPC-argument-shape level
 * against a fake `SupabaseClient`, matching this repo's existing boundary
 * for Supabase-adapter tests — real UNIQUE-constraint/refusal behavior lives
 * in the migration's SQL function and can only be proven against a real
 * Postgres instance.
 *
 * Digest-conflict handling: the RPC returns `status: 'refused', reason:
 * 'digest_conflict'` (never throws) for a same-attempt-different-digest
 * retry, matching the row shape returned for a genuine first insert or an
 * idempotent replay. This adapter maps all three into the same
 * `StoreReplayableResponseResult` union the in-memory store exposes, so
 * callers (a future recovery executor) can depend on either implementation
 * interchangeably.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import type {
  PlanningReplayableResponseRecord,
  PlanningReplayableResponseStore,
  StoreReplayableResponseInput,
  StoreReplayableResponseResult,
} from "./mission-planning-replayable-response-store";

interface ReplayableResponseRpcRow {
  status: "ok" | "refused";
  reason: string;
  response: {
    worker_attempt_id: string;
    workspace_id: string;
    mission_id: string;
    planning_request_id: string;
    model_configuration_id: string;
    schema_version: number;
    redacted_raw_output: string;
    output_digest: string;
    created_at: string;
  } | null;
}

function rowToRecord(row: NonNullable<ReplayableResponseRpcRow["response"]>): PlanningReplayableResponseRecord {
  return {
    workerAttemptId: row.worker_attempt_id,
    workspaceId: row.workspace_id,
    missionId: row.mission_id,
    planningRequestId: row.planning_request_id,
    modelConfigurationId: row.model_configuration_id,
    schemaVersion: row.schema_version,
    redactedRawOutput: row.redacted_raw_output,
    outputDigest: row.output_digest,
    createdAt: row.created_at,
  };
}

export class SupabasePlanningReplayableResponseStore implements PlanningReplayableResponseStore {
  private readonly client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.client = client;
  }

  async store(input: StoreReplayableResponseInput): Promise<StoreReplayableResponseResult> {
    const { data, error } = await this.client.rpc("create_mission_planning_replayable_response", {
      p_worker_attempt_id: input.workerAttemptId,
      p_workspace_id: input.workspaceId,
      p_mission_id: input.missionId,
      p_planning_request_id: input.planningRequestId,
      p_model_configuration_id: input.modelConfigurationId,
      p_schema_version: input.schemaVersion,
      p_redacted_raw_output: input.redactedRawOutput,
      p_output_digest: input.outputDigest,
    });

    if (error) throw new Error(`Failed to store Mission planning replayable response: ${error.message}`);

    const row = Array.isArray(data) ? (data[0] as ReplayableResponseRpcRow | undefined) : (data as ReplayableResponseRpcRow | undefined);
    if (!row || !row.response) throw new Error("create_mission_planning_replayable_response RPC returned no row.");

    const record = rowToRecord(row.response);
    if (row.status === "refused") {
      // Only refusal reason the RPC produces is digest_conflict (see the
      // migration's plpgsql body) — mapped straight through, not thrown,
      // matching the in-memory store's non-throwing refusal contract.
      return { status: "refused", reason: "digest_conflict", response: record };
    }
    return { status: "ok", reason: row.reason === "idempotent_replay" ? "idempotent_replay" : "created", response: record };
  }

  async get(workspaceId: string, workerAttemptId: string): Promise<PlanningReplayableResponseRecord | null> {
    const { data, error } = await this.client.rpc("get_mission_planning_replayable_response", {
      p_workspace_id: workspaceId,
      p_worker_attempt_id: workerAttemptId,
    });
    if (error) throw new Error(`Failed to load Mission planning replayable response ${workerAttemptId}: ${error.message}`);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || !row.worker_attempt_id) return null;
    return rowToRecord(row as NonNullable<ReplayableResponseRpcRow["response"]>);
  }
}

/** Guarded factory — throws if OathLock's Supabase env is not configured, matching the rest of the service layer. */
export function createSupabasePlanningReplayableResponseStore(): SupabasePlanningReplayableResponseStore {
  if (!supabase) throw new Error("M9R agent backend is not configured.");
  return new SupabasePlanningReplayableResponseStore(supabase);
}
