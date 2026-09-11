import { supabase } from "@/lib/supabase";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MissionRuntimeEvent, MissionRuntimeEventJournal } from "./mission-runtime-event";
import type { MissionRuntimeActivity } from "./mission-runtime-activity";
import type { MissionRuntimeActivityReader } from "./mission-runtime-activity-relay";

export function isMissingTurnIdColumnError(
  error: { code?: string | null; message?: string | null } | null,
): boolean {
  if (!error) return false;
  return (
    error.code === "42703" ||
    error.code === "PGRST204" ||
    /(?:column|schema cache).*turn_id|turn_id.*(?:column|schema cache)/i.test(error.message ?? "")
  );
}

export class SupabaseMissionRuntimeEventJournal implements MissionRuntimeEventJournal, MissionRuntimeActivityReader {
  private readonly client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.client = client;
  }

  async append(events: readonly MissionRuntimeEvent[]): Promise<{ stored: number; duplicates: number }> {
    if (events.length === 0) return { stored: 0, duplicates: 0 };
    const unique = new Map<string, MissionRuntimeEvent>();
    for (const event of events) unique.set(`${event.workspaceId}:${event.eventId}`, event);
    const rows = [...unique.values()].map((event) => ({
      workspace_id: event.workspaceId,
      mission_id: event.missionId,
      execution_id: event.executionId,
      participant_id: event.participantId,
      assignment_id: event.assignmentId,
      event_id: event.eventId,
      turn_id: event.turnId ?? null,
      event_type: event.eventType,
      adapter_id: event.adapterId,
      provider_session_ref: event.providerSessionRef,
      correlation_id: event.correlationId,
      causation_id: event.causationId,
      occurred_at: event.occurredAt,
      raw_event_ref: event.rawEventRef,
      redaction_status: event.redactionStatus,
      summary: event.summary,
      payload: event.payload,
      activity: event.activity ?? null,
    }));
    let result = await this.client
      .from("mission_runtime_events")
      .upsert(rows, { onConflict: "workspace_id,event_id", ignoreDuplicates: true })
      .select("event_id");

    if (result.error && isMissingTurnIdColumnError(result.error)) {
      const legacyRows = rows.map((row) => {
        const legacyRow = { ...row } as Record<string, unknown>;
        delete legacyRow.turn_id;
        return legacyRow;
      });
      result = await this.client
        .from("mission_runtime_events")
        .upsert(legacyRows, { onConflict: "workspace_id,event_id", ignoreDuplicates: true })
        .select("event_id");
    }

    if (result.error) throw new Error(`Failed to append Mission runtime events: ${result.error.message}`);
    const { data } = result;
    const stored = data?.length ?? rows.length;
    return { stored, duplicates: events.length - stored };
  }

  async listActivities(input: { workspaceId: string; missionId: string; participantId?: string | null; limit?: number }): Promise<MissionRuntimeActivity[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
    let query = this.client
      .from("mission_runtime_events")
      .select("activity")
      .eq("workspace_id", input.workspaceId)
      .eq("mission_id", input.missionId)
      .not("activity", "is", null)
      .order("occurred_at", { ascending: false })
      .limit(limit);
    if (input.participantId != null) query = query.eq("participant_id", input.participantId);
    const { data, error } = await query;
    if (error) throw new Error(`Failed to list Mission runtime activities: ${error.message}`);
    return (data ?? []).flatMap((row) => isMissionRuntimeActivity(row.activity) ? [row.activity] : []);
  }
}

function isMissionRuntimeActivity(value: unknown): value is MissionRuntimeActivity {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.activityId === "string"
    && typeof record.workspaceId === "string"
    && typeof record.missionId === "string"
    && typeof record.kind === "string"
    && typeof record.source === "string"
    && typeof record.status === "string"
    && typeof record.occurredAt === "string";
}

export function createSupabaseMissionRuntimeEventJournal(): SupabaseMissionRuntimeEventJournal {
  if (!supabase) throw new Error("M9R agent backend is not configured.");
  return new SupabaseMissionRuntimeEventJournal(supabase);
}
