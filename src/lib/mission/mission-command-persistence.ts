/**
 * MissionCommandPersistence — the durable, transactional seam for one
 * already-computed command outcome.
 * ----------------------------------------------------------------------------
 * This is deliberately a SEPARATE interface from `MissionStore` /
 * `IdempotencyStore` (mission-store.ts, mission-idempotency.ts), not a
 * Supabase implementation of either. Those two remain the correct
 * abstraction for the in-memory reference path (`InMemoryMissionStore` +
 * `InMemoryIdempotencyStore`), where two separate synchronous calls really
 * are atomic with respect to each other because JS never interleaves within
 * a synchronous block.
 *
 * Against a real database, calling an "append events" RPC and then a
 * separate "remember outcome" RPC is NOT atomic — each is its own
 * transaction, and a crash or network failure between them can commit the
 * Mission's events while the idempotency record never lands. This interface
 * exists to make that failure mode structurally impossible: `applyCommand`
 * is the only durable write operation, and it commits the version check,
 * the event insert, and the outcome record together or not at all.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import type { MissionId } from "./mission-domain";
import type { MissionEvent } from "./mission-events";
import type { CommandOutcomeRecord } from "./mission-commands";
import { CONCURRENCY_CONFLICT_STATUS, type ConcurrencyConflict } from "./mission-concurrency";

export interface ApplyCommandPersistenceInput {
  missionId: MissionId;
  /**
   * Genesis identity for tenant scoping. Idempotency keys are only unique
   * WITHIN a workspace (see the migration's `mission_command_outcomes`
   * primary key) — two different workspaces are free to reuse the same
   * caller-supplied key without colliding.
   */
  workspaceId: string;
  /** Genesis identity, optional. Only meaningful the first time a mission_id is seen; ignored (a no-op) on every later command for the same mission. */
  repositoryId?: string | null;
  idempotencyKey: string;
  commandType: string;
  /** Independent of the idempotency key — detects "same key, different work." */
  payloadDigest: string;
  expectedVersion: number;
  /** The events `applyMissionCommand` (pure) already computed for this command. */
  events: MissionEvent[];
  /** The full outcome record to store verbatim if this call performs the write. */
  result: CommandOutcomeRecord;
}

export type ApplyCommandPersistenceResult =
  | { status: "applied"; aggregateVersion: number; result: CommandOutcomeRecord }
  | { status: "replayed"; aggregateVersion: number; result: CommandOutcomeRecord }
  | { status: "idempotency_conflict"; message: string }
  | { status: "version_conflict"; conflict: ConcurrencyConflict }
  /** The Mission genesis workspace_id does not match the caller-supplied one — refused before any read or write of Mission state. Never conflated with version_conflict: this is a tenant-isolation failure, not a concurrency one. */
  | { status: "workspace_mismatch"; missionId: MissionId; suppliedWorkspaceId: string };

export interface MissionCommandPersistence {
  /**
   * Read-only pre-check. Lets the caller give `applyMissionCommand` (pure)
   * the prior outcome BEFORE computing, so a genuine replay of e.g.
   * CreateMission is recognized as a replay rather than rejected as
   * "mission_already_exists" (the pure handler's idempotency check runs
   * before its existence check — see mission-command-handler.ts's ordering
   * comment). Safe to call outside any transaction: idempotency records are
   * immutable once written, so a stale miss just means "fall through to
   * `applyCommand`, which re-checks authoritatively under lock" — never a
   * correctness problem, only a missed fast path.
   *
   * `workspaceId` scopes the lookup: idempotency keys are unique per
   * workspace, not globally, so this must never be omitted or two workspaces
   * reusing the same caller-supplied key would see each other's outcomes.
   */
  lookupOutcome(workspaceId: string, idempotencyKey: string): Promise<CommandOutcomeRecord | null>;
  applyCommand(input: ApplyCommandPersistenceInput): Promise<ApplyCommandPersistenceResult>;
}

interface ApplyCommandRpcRow {
  status: "applied" | "replayed" | "idempotency_conflict" | "version_conflict" | "workspace_mismatch";
  current_version: number | null;
  latest_event_id: string | null;
  stored_result: CommandOutcomeRecord | null;
}

/**
 * The one durable write path for the Mission domain. Calls
 * `apply_mission_command_atomic` — a single Postgres function, a single
 * transaction, covering the idempotency check, the version-locked event
 * insert, and the outcome record together. See the migration
 * (`supabase/migrations/20260725120000_mission_event_log.sql`) for why a
 * two-RPC split (append, then remember) is unsafe and was replaced.
 */
export class SupabaseMissionCommandPersistence implements MissionCommandPersistence {
  private readonly client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.client = client;
  }

  async lookupOutcome(workspaceId: string, idempotencyKey: string): Promise<CommandOutcomeRecord | null> {
    const { data, error } = await this.client
      .from("mission_command_outcomes")
      .select("result")
      .eq("workspace_id", workspaceId)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();

    if (error) throw new Error(`Failed to look up Mission command outcome for key ${idempotencyKey}: ${error.message}`);
    return (data as { result: CommandOutcomeRecord } | null)?.result ?? null;
  }

  async applyCommand(input: ApplyCommandPersistenceInput): Promise<ApplyCommandPersistenceResult> {
    const { data, error } = await this.client.rpc("apply_mission_command_atomic", {
      p_mission_id: input.missionId,
      p_workspace_id: input.workspaceId,
      p_repository_id: input.repositoryId ?? null,
      p_idempotency_key: input.idempotencyKey,
      p_command_type: input.commandType,
      p_payload_digest: input.payloadDigest,
      p_expected_version: input.expectedVersion,
      p_events: input.events,
      p_result: input.result,
    });

    if (error) throw new Error(`Failed to apply Mission command for ${input.missionId}: ${error.message}`);

    const row = Array.isArray(data) ? (data[0] as ApplyCommandRpcRow | undefined) : undefined;
    if (!row) throw new Error(`apply_mission_command_atomic returned no row for ${input.missionId}.`);

    switch (row.status) {
      case "applied":
        return { status: "applied", aggregateVersion: row.current_version ?? input.events.length, result: row.stored_result ?? input.result };
      case "replayed": {
        if (!row.stored_result) throw new Error(`apply_mission_command_atomic reported a replay for ${input.missionId} with no stored_result.`);
        return { status: "replayed", aggregateVersion: row.current_version ?? row.stored_result.aggregateVersion, result: row.stored_result };
      }
      case "idempotency_conflict":
        return { status: "idempotency_conflict", message: `Idempotency key ${input.idempotencyKey} was already used for a different command payload.` };
      case "version_conflict": {
        const currentVersion = row.current_version ?? input.expectedVersion;
        const conflict: ConcurrencyConflict = {
          status: CONCURRENCY_CONFLICT_STATUS,
          code: "version_conflict",
          missionId: input.missionId,
          expectedVersion: input.expectedVersion,
          currentVersion,
          latestEventCursor: row.latest_event_id,
          message: `Expected version ${input.expectedVersion} does not match current version ${currentVersion}.`,
        };
        return { status: "version_conflict", conflict };
      }
      case "workspace_mismatch":
        return { status: "workspace_mismatch", missionId: input.missionId, suppliedWorkspaceId: input.workspaceId };
    }
  }
}

/** Guarded factory — throws if OathLock's Supabase env is not configured, matching the rest of the service layer (see resident-service.ts's `db()`). */
export function createSupabaseMissionCommandPersistence(): SupabaseMissionCommandPersistence {
  if (!supabase) throw new Error("M9R agent backend is not configured.");
  return new SupabaseMissionCommandPersistence(supabase);
}
