import { supabase } from "@/lib/supabase";
import type { SupabaseClient } from "@supabase/supabase-js";
import { missionUsageSnapshotFromRuntimeEvent, type MissionUsageSnapshot } from "./mission-usage";
import type { MissionRuntimeEvent } from "./mission-runtime-event";

export class SupabaseMissionUsageLedger {
  private readonly client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.client = client;
  }

  async appendFromRuntimeEvents(events: readonly MissionRuntimeEvent[]): Promise<{ stored: number; ignored: number }> {
    const snapshots = events.flatMap((event) => {
      const snapshot = missionUsageSnapshotFromRuntimeEvent(event);
      return snapshot ? [{ event, snapshot }] : [];
    });
    if (snapshots.length === 0) return { stored: 0, ignored: events.length };
    const rows = snapshots.map(({ event, snapshot }) => ({
      workspace_id: event.workspaceId,
      mission_id: event.missionId,
      execution_id: event.executionId,
      turn_id: event.turnId ?? null,
      participant_id: event.participantId,
      assignment_id: event.assignmentId,
      provider: event.adapterId,
      provider_session_ref: event.providerSessionRef,
      event_id: event.eventId,
      occurred_at: event.occurredAt,
      input_tokens: snapshot.inputTokens,
      output_tokens: snapshot.outputTokens,
      total_tokens: snapshot.totalTokens,
      cost_usd: snapshot.costUsd,
      context_used_tokens: snapshot.contextUsedTokens,
      context_window_tokens: snapshot.contextWindowTokens,
      usage_basis: typeof event.payload.usageBasis === "string" ? event.payload.usageBasis : null,
    }));
    const { data, error } = await this.client
      .from("mission_usage_ledger")
      .upsert(rows, { onConflict: "workspace_id,event_id", ignoreDuplicates: true })
      .select("event_id");
    if (error) throw new Error(`Failed to append Mission usage ledger rows: ${error.message}`);
    return { stored: data?.length ?? rows.length, ignored: events.length - (data?.length ?? rows.length) };
  }

  /**
   * Repair projection misses from the durable runtime journal. Runtime event
   * retention is authoritative; the usage table is a derived read model and
   * may have missed a write during a transient outage. Existing ledger event
   * ids are filtered first so a dashboard poll remains read-heavy and does
   * not repeatedly rewrite already-projected rows.
   */
  async reconcileFromRuntimeEvents(input: { workspaceId: string; since: string; limit?: number }): Promise<{ stored: number; ignored: number }> {
    const limit = Math.max(1, Math.min(input.limit ?? 10_000, 10_000));
    const { data: existingRows, error: existingError } = await this.client
      .from("mission_usage_ledger")
      .select("event_id")
      .eq("workspace_id", input.workspaceId)
      .gte("occurred_at", input.since)
      .limit(limit);
    if (existingError) throw new Error(`Failed to inspect Mission usage ledger projection: ${existingError.message}`);
    const existingEventIds = new Set((existingRows ?? []).map((row) => typeof row.event_id === "string" ? row.event_id : "").filter(Boolean));

    const { data: runtimeRows, error: runtimeError } = await this.client
      .from("mission_runtime_events")
      .select("workspace_id, mission_id, execution_id, participant_id, assignment_id, event_id, turn_id, event_type, adapter_id, provider_session_ref, occurred_at, payload")
      .eq("workspace_id", input.workspaceId)
      .eq("event_type", "provider.usage_updated")
      .gte("occurred_at", input.since)
      .order("occurred_at", { ascending: true })
      .limit(limit);
    if (runtimeError) throw new Error(`Failed to read Mission runtime usage events: ${runtimeError.message}`);

    const missingEvents = (runtimeRows ?? [])
      .map(runtimeUsageEventFromRow)
      .filter((event): event is MissionRuntimeEvent => event !== null && !existingEventIds.has(event.eventId));
    if (missingEvents.length === 0) return { stored: 0, ignored: runtimeRows?.length ?? 0 };
    return this.appendFromRuntimeEvents(missingEvents);
  }

  async list(input: { workspaceId: string; since: string; limit?: number }): Promise<MissionUsageSnapshot[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 5_000, 10_000));
    const { data, error } = await this.client
      .from("mission_usage_ledger")
      .select("turn_id, provider, occurred_at, input_tokens, output_tokens, total_tokens, cost_usd, context_used_tokens, context_window_tokens, event_id")
      .eq("workspace_id", input.workspaceId)
      .gte("occurred_at", input.since)
      .order("occurred_at", { ascending: true })
      .limit(limit);
    if (error) throw new Error(`Failed to list Mission usage ledger rows: ${error.message}`);
    return (data ?? []).map((row) => ({
      turnId: typeof row.turn_id === "string" && row.turn_id.length > 0 ? row.turn_id : row.event_id,
      provider: row.provider,
      occurredAt: row.occurred_at,
      inputTokens: numberOrNull(row.input_tokens),
      outputTokens: numberOrNull(row.output_tokens),
      totalTokens: numberOrNull(row.total_tokens),
      costUsd: numberOrNull(row.cost_usd),
      contextUsedTokens: numberOrNull(row.context_used_tokens),
      contextWindowTokens: numberOrNull(row.context_window_tokens),
      eventId: row.event_id,
    }));
  }
}

function runtimeUsageEventFromRow(row: Record<string, unknown>): MissionRuntimeEvent | null {
  const workspaceId = stringOrNull(row.workspace_id);
  const missionId = stringOrNull(row.mission_id);
  const executionId = stringOrNull(row.execution_id);
  const eventId = stringOrNull(row.event_id);
  const adapterId = stringOrNull(row.adapter_id);
  const occurredAt = stringOrNull(row.occurred_at);
  const payload = row.payload && typeof row.payload === "object" && !Array.isArray(row.payload) ? row.payload as Record<string, unknown> : null;
  if (!workspaceId || !missionId || !executionId || !eventId || !adapterId || !occurredAt || !payload) return null;
  return {
    workspaceId,
    missionId,
    executionId,
    participantId: stringOrNull(row.participant_id),
    assignmentId: stringOrNull(row.assignment_id),
    eventId,
    turnId: stringOrNull(row.turn_id),
    eventType: "provider.usage_updated",
    adapterId,
    providerSessionRef: stringOrNull(row.provider_session_ref),
    correlationId: `reconcile:${eventId}`,
    causationId: null,
    occurredAt,
    rawEventRef: null,
    redactionStatus: "redacted",
    summary: "Provider usage updated.",
    payload,
    activity: null,
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) && Number(value) >= 0
      ? Number(value)
      : null;
}

export function createSupabaseMissionUsageLedger(): SupabaseMissionUsageLedger {
  if (!supabase) throw new Error("M9R agent backend is not configured.");
  return new SupabaseMissionUsageLedger(supabase);
}
