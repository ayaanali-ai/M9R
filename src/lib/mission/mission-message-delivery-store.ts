import { supabase } from "@/lib/supabase";
import type { SupabaseClient } from "@supabase/supabase-js";
import { advanceDelivery, type DeliveryStatus, type MissionMessageDelivery } from "./mission-message-delivery";

export interface MissionMessageDeliveryStore {
  insert(deliveries: readonly MissionMessageDelivery[]): Promise<{ stored: number; duplicates: number }>;
  get(id: string): Promise<MissionMessageDelivery | null>;
  transition(input: { id: string; expectedStatus: DeliveryStatus; nextStatus: DeliveryStatus; now: string; failureCode?: string | null }): Promise<MissionMessageDelivery | null>;
  listReady(input: { workspaceId: string; now: string; limit?: number }): Promise<MissionMessageDelivery[]>;
  listForMission(input: { workspaceId: string; missionId: string; recipientParticipantId?: string | null; limit?: number }): Promise<MissionMessageDelivery[]>;
}

export class InMemoryMissionMessageDeliveryStore implements MissionMessageDeliveryStore {
  private readonly rows = new Map<string, MissionMessageDelivery>();

  async insert(deliveries: readonly MissionMessageDelivery[]): Promise<{ stored: number; duplicates: number }> {
    let stored = 0;
    let duplicates = 0;
    for (const delivery of deliveries) {
      if (this.rows.has(delivery.id)) {
        duplicates += 1;
        continue;
      }
      this.rows.set(delivery.id, delivery);
      stored += 1;
    }
    return { stored, duplicates };
  }

  async get(id: string): Promise<MissionMessageDelivery | null> {
    return this.rows.get(id) ?? null;
  }

  async transition(input: { id: string; expectedStatus: DeliveryStatus; nextStatus: DeliveryStatus; now: string; failureCode?: string | null }): Promise<MissionMessageDelivery | null> {
    const current = this.rows.get(input.id);
    if (!current || current.status !== input.expectedStatus) return null;
    const next = advanceDelivery(current, input.nextStatus, input.now, input.failureCode ?? null);
    if (!next.ok) return null;
    const delivery = withoutOk(next);
    this.rows.set(input.id, delivery);
    return delivery;
  }

  async listReady(input: { workspaceId: string; now: string; limit?: number }): Promise<MissionMessageDelivery[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
    return [...this.rows.values()]
      .filter((delivery) => delivery.workspaceId === input.workspaceId && (delivery.status === "queued" || delivery.status === "failed") && (delivery.nextAttemptAt === null || delivery.nextAttemptAt <= input.now))
      .slice(0, limit);
  }

  async listForMission(input: { workspaceId: string; missionId: string; recipientParticipantId?: string | null; limit?: number }): Promise<MissionMessageDelivery[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
    return [...this.rows.values()]
      .filter((delivery) =>
        delivery.workspaceId === input.workspaceId &&
        delivery.missionId === input.missionId &&
        (!input.recipientParticipantId || delivery.recipientParticipantId === input.recipientParticipantId),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .slice(0, limit);
  }
}

export class SupabaseMissionMessageDeliveryStore implements MissionMessageDeliveryStore {
  private readonly client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.client = client;
  }

  async insert(deliveries: readonly MissionMessageDelivery[]): Promise<{ stored: number; duplicates: number }> {
    if (deliveries.length === 0) return { stored: 0, duplicates: 0 };
    const rows = deliveries.map((delivery) => toRow(delivery));
    const { data, error } = await this.client.from("mission_message_deliveries").upsert(rows, { onConflict: "message_id,recipient_participant_id", ignoreDuplicates: true }).select("id");
    if (error) throw new Error(`Failed to insert Mission message deliveries: ${error.message}`);
    const stored = data?.length ?? rows.length;
    return { stored, duplicates: deliveries.length - stored };
  }

  async get(id: string): Promise<MissionMessageDelivery | null> {
    const { data, error } = await this.client.from("mission_message_deliveries").select("*").eq("id", id).maybeSingle();
    if (error) throw new Error(`Failed to load Mission message delivery: ${error.message}`);
    return data ? fromRow(data as Record<string, unknown>) : null;
  }

  async transition(input: { id: string; expectedStatus: DeliveryStatus; nextStatus: DeliveryStatus; now: string; failureCode?: string | null }): Promise<MissionMessageDelivery | null> {
    const current = await this.get(input.id);
    if (!current || current.status !== input.expectedStatus) return null;
    const next = advanceDelivery(current, input.nextStatus, input.now, input.failureCode ?? null);
    if (!next.ok) return null;
    const delivery = withoutOk(next);
    const { data, error } = await this.client
      .from("mission_message_deliveries")
      .update(toRow(delivery))
      .eq("id", input.id)
      .eq("status", input.expectedStatus)
      .select("*")
      .maybeSingle();
    if (error) throw new Error(`Failed to transition Mission message delivery: ${error.message}`);
    return data ? fromRow(data as Record<string, unknown>) : null;
  }

  async listReady(input: { workspaceId: string; now: string; limit?: number }): Promise<MissionMessageDelivery[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
    const { data, error } = await this.client
      .from("mission_message_deliveries")
      .select("*")
      .eq("workspace_id", input.workspaceId)
      .in("status", ["queued", "failed"])
      .or(`next_attempt_at.is.null,next_attempt_at.lte.${input.now}`)
      .order("created_at", { ascending: true })
      .limit(limit);
    if (error) throw new Error(`Failed to list Mission message deliveries: ${error.message}`);
    return (data ?? []).map((row) => fromRow(row as Record<string, unknown>));
  }

  async listForMission(input: { workspaceId: string; missionId: string; recipientParticipantId?: string | null; limit?: number }): Promise<MissionMessageDelivery[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
    let query = this.client
      .from("mission_message_deliveries")
      .select("*")
      .eq("workspace_id", input.workspaceId)
      .eq("mission_id", input.missionId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(limit);
    if (input.recipientParticipantId) query = query.eq("recipient_participant_id", input.recipientParticipantId);
    const { data, error } = await query;
    if (error) throw new Error(`Failed to list Mission message deliveries: ${error.message}`);
    return (data ?? []).map((row) => fromRow(row as Record<string, unknown>));
  }
}

function withoutOk<T extends { ok: true }>(value: T): Omit<T, "ok"> {
  const copy = { ...value } as Record<string, unknown>;
  delete copy.ok;
  return copy as Omit<T, "ok">;
}

function toRow(delivery: MissionMessageDelivery): Record<string, unknown> {
  return {
    id: delivery.id,
    workspace_id: delivery.workspaceId,
    mission_id: delivery.missionId,
    message_id: delivery.messageId,
    recipient_participant_id: delivery.recipientParticipantId,
    bridge_instance_id: delivery.bridgeInstanceId,
    agent_session_id: delivery.agentSessionId,
    status: delivery.status,
    attempt_count: delivery.attemptCount,
    next_attempt_at: delivery.nextAttemptAt,
    last_attempt_at: delivery.lastAttemptAt,
    delivered_at: delivery.deliveredAt,
    acknowledged_at: delivery.acknowledgedAt,
    failure_code: delivery.failureCode,
    created_at: delivery.createdAt,
    updated_at: delivery.updatedAt,
  };
}

function fromRow(row: Record<string, unknown>): MissionMessageDelivery {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    missionId: String(row.mission_id),
    messageId: String(row.message_id),
    recipientParticipantId: String(row.recipient_participant_id),
    bridgeInstanceId: row.bridge_instance_id == null ? null : String(row.bridge_instance_id),
    agentSessionId: row.agent_session_id == null ? null : String(row.agent_session_id),
    status: String(row.status) as DeliveryStatus,
    attemptCount: Number(row.attempt_count ?? 0),
    nextAttemptAt: row.next_attempt_at == null ? null : String(row.next_attempt_at),
    lastAttemptAt: row.last_attempt_at == null ? null : String(row.last_attempt_at),
    deliveredAt: row.delivered_at == null ? null : String(row.delivered_at),
    acknowledgedAt: row.acknowledged_at == null ? null : String(row.acknowledged_at),
    failureCode: row.failure_code == null ? null : String(row.failure_code),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function createSupabaseMissionMessageDeliveryStore(): SupabaseMissionMessageDeliveryStore {
  if (!supabase) throw new Error("M9R agent backend is not configured.");
  return new SupabaseMissionMessageDeliveryStore(supabase);
}
