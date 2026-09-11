/**
 * Supabase-backed Mission event reader
 * ----------------------------------------------------------------------------
 * Read-only. This is NOT a `MissionStore` implementation — it deliberately
 * does not expose an `append` method. Durable writes to `mission_events` go
 * exclusively through `apply_mission_command_atomic`
 * (`mission-command-persistence.ts`), which commits the version check, the
 * event insert, and the idempotency outcome record as one transaction. An
 * independent `append` method on this class would let a caller write events
 * without recording the matching outcome, reintroducing the exact partial-
 * commit failure the atomic RPC exists to rule out.
 *
 * `loadEvents` is safe to keep separate: it is a plain read, never a write,
 * so it carries no transactional obligation of its own. It exists so the
 * runtime layer can build the projection `applyMissionCommand` (pure) needs
 * before it computes anything to persist.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import type { MissionId } from "./mission-domain";
import { MISSION_EVENT_SCHEMA_VERSION, type MissionEvent, type MissionEventPayload, type MissionEventType } from "./mission-events";

interface MissionEventRow {
  event_id: string;
  event_type: string;
  aggregate_version: number;
  schema_version: number;
  actor: MissionEvent["actor"];
  reason: MissionEvent["reason"];
  correlation_id: string;
  causation_id: string | null;
  provenance: MissionEvent["provenance"];
  occurred_at: string;
  payload: Record<string, unknown>;
}

function rowToEvent(missionId: MissionId, row: MissionEventRow): MissionEvent {
  const type = row.event_type as MissionEventType;
  return Object.freeze({
    schemaVersion: MISSION_EVENT_SCHEMA_VERSION,
    eventId: row.event_id,
    type,
    missionId,
    aggregateVersion: row.aggregate_version,
    actor: row.actor,
    reason: row.reason,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    timestamp: row.occurred_at,
    provenance: row.provenance,
    payload: { type, ...row.payload } as MissionEventPayload,
  }) satisfies MissionEvent;
}

export class SupabaseMissionEventReader {
  private readonly client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.client = client;
  }

  async loadEvents(missionId: MissionId): Promise<MissionEvent[]> {
    const { data, error } = await this.client
      .from("mission_events")
      .select("event_id, event_type, aggregate_version, schema_version, actor, reason, correlation_id, causation_id, provenance, occurred_at, payload")
      .eq("mission_id", missionId)
      .order("aggregate_version", { ascending: true });

    if (error) throw new Error(`Failed to load Mission events for ${missionId}: ${error.message}`);
    return (data ?? []).map((row) => rowToEvent(missionId, row as MissionEventRow));
  }
}

/** Guarded factory — throws if OathLock's Supabase env is not configured, matching the rest of the service layer (see resident-service.ts's `db()`). */
export function createSupabaseMissionEventReader(): SupabaseMissionEventReader {
  if (!supabase) throw new Error("M9R agent backend is not configured.");
  return new SupabaseMissionEventReader(supabase);
}
