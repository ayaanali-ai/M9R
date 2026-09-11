import { supabase } from "@/lib/supabase";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendPushNotificationForUser } from "../push-notification-service";

export const MISSION_NOTIFICATION_KINDS = ["mention", "question", "blocker", "review_request", "approval_request", "delivery_failed", "runtime_waiting", "mission_decision"] as const;
export type MissionNotificationKind = (typeof MISSION_NOTIFICATION_KINDS)[number];

export interface MissionNotification {
  id: string;
  workspaceId: string;
  missionId: string;
  recipientUserId: string;
  recipientParticipantId: string | null;
  sourceMessageId: string | null;
  kind: MissionNotificationKind;
  title: string;
  body: string;
  payload: Record<string, unknown>;
  createdAt: string;
  readAt: string | null;
}

export interface MissionNotificationStore {
  insert(rows: readonly MissionNotification[]): Promise<{ stored: number; duplicates: number }>;
  list(input: { workspaceId: string; recipientUserId: string; unreadOnly?: boolean; limit?: number }): Promise<MissionNotification[]>;
  markRead(input: { workspaceId: string; recipientUserId: string; notificationIds: readonly string[]; readAt: string }): Promise<number>;
}

export class InMemoryMissionNotificationStore implements MissionNotificationStore {
  private readonly rows = new Map<string, MissionNotification>();

  async insert(rows: readonly MissionNotification[]): Promise<{ stored: number; duplicates: number }> {
    let stored = 0;
    let duplicates = 0;
    for (const row of rows) {
      if (this.rows.has(row.id)) { duplicates += 1; continue; }
      this.rows.set(row.id, row);
      stored += 1;
    }
    return { stored, duplicates };
  }

  async list(input: { workspaceId: string; recipientUserId: string; unreadOnly?: boolean; limit?: number }): Promise<MissionNotification[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 100, 200));
    return [...this.rows.values()]
      .filter((row) => row.workspaceId === input.workspaceId && row.recipientUserId === input.recipientUserId && (!input.unreadOnly || row.readAt === null))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .slice(0, limit);
  }

  async markRead(input: { workspaceId: string; recipientUserId: string; notificationIds: readonly string[]; readAt: string }): Promise<number> {
    let marked = 0;
    const ids = new Set(input.notificationIds);
    for (const [id, row] of this.rows) {
      if (ids.has(id) && row.workspaceId === input.workspaceId && row.recipientUserId === input.recipientUserId && row.readAt === null) {
        this.rows.set(id, { ...row, readAt: input.readAt });
        marked += 1;
      }
    }
    return marked;
  }
}

export class SupabaseMissionNotificationStore implements MissionNotificationStore {
  private readonly client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.client = client;
  }

  async insert(rows: readonly MissionNotification[]): Promise<{ stored: number; duplicates: number }> {
    if (rows.length === 0) return { stored: 0, duplicates: 0 };
    const { data, error } = await this.client.from("mission_notifications").upsert(rows.map(toRow), {
      onConflict: "workspace_id,recipient_user_id,mission_id,source_message_id,kind",
      ignoreDuplicates: true,
    }).select("id");
    if (error) throw new Error(`Failed to insert Mission notifications: ${error.message}`);
    // `data` should never legitimately be null here when `error` is null --
    // a successful upsert().select() returns an array, empty or not. If it
    // somehow is, treating it the same as "nothing was confirmed new"
    // (rather than falling back to `rows`, i.e. assuming every candidate --
    // including ones ignoreDuplicates just correctly filtered out -- was
    // freshly inserted) is the safe direction: it under-reports/under-pushes
    // in an already-anomalous case instead of defeating the dedup entirely
    // and re-pushing notifications for genuine duplicates.
    if (data === null) console.warn("Mission notification upsert returned null data with no error; treating as zero confirmed inserts.");
    const confirmed = data ?? [];
    const stored = confirmed.length;
    const insertedIds = new Set(confirmed.map((row) => String(row.id)));
    // The durable inbox remains the source of truth. Push is an opt-in,
    // best-effort side effect and never blocks Mission message delivery.
    for (const row of rows.filter((candidate) => insertedIds.has(candidate.id))) {
      void sendPushNotificationForUser(this.client, row.recipientUserId, {
        title: row.title,
        body: row.body,
        url: "/dashboard/agents",
        tag: `oathlock-${row.kind}`,
      }).catch(() => undefined);
    }
    return { stored, duplicates: rows.length - stored };
  }

  async list(input: { workspaceId: string; recipientUserId: string; unreadOnly?: boolean; limit?: number }): Promise<MissionNotification[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 100, 200));
    let query = this.client.from("mission_notifications").select("*")
      .eq("workspace_id", input.workspaceId)
      .eq("recipient_user_id", input.recipientUserId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (input.unreadOnly) query = query.is("read_at", null);
    const { data, error } = await query;
    if (error) throw new Error(`Failed to list Mission notifications: ${error.message}`);
    return (data ?? []).map((row) => fromRow(row as Record<string, unknown>));
  }

  async markRead(input: { workspaceId: string; recipientUserId: string; notificationIds: readonly string[]; readAt: string }): Promise<number> {
    if (input.notificationIds.length === 0) return 0;
    const { data, error } = await this.client.from("mission_notifications")
      .update({ read_at: input.readAt })
      .eq("workspace_id", input.workspaceId)
      .eq("recipient_user_id", input.recipientUserId)
      .in("id", [...new Set(input.notificationIds)].slice(0, 200))
      .is("read_at", null)
      .select("id");
    if (error) throw new Error(`Failed to mark Mission notifications read: ${error.message}`);
    return data?.length ?? 0;
  }
}

function toRow(row: MissionNotification): Record<string, unknown> {
  return {
    id: row.id,
    workspace_id: row.workspaceId,
    mission_id: row.missionId,
    recipient_user_id: row.recipientUserId,
    recipient_participant_id: row.recipientParticipantId,
    source_message_id: row.sourceMessageId,
    kind: row.kind,
    title: row.title,
    body: row.body,
    payload: row.payload,
    created_at: row.createdAt,
    read_at: row.readAt,
  };
}

function fromRow(row: Record<string, unknown>): MissionNotification {
  const payload = row.payload && typeof row.payload === "object" && !Array.isArray(row.payload) ? row.payload as Record<string, unknown> : {};
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    missionId: String(row.mission_id),
    recipientUserId: String(row.recipient_user_id),
    recipientParticipantId: row.recipient_participant_id == null ? null : String(row.recipient_participant_id),
    sourceMessageId: row.source_message_id == null ? null : String(row.source_message_id),
    kind: String(row.kind) as MissionNotificationKind,
    title: String(row.title),
    body: String(row.body),
    payload,
    createdAt: String(row.created_at),
    readAt: row.read_at == null ? null : String(row.read_at),
  };
}

export function createSupabaseMissionNotificationStore(): SupabaseMissionNotificationStore {
  if (!supabase) throw new Error("M9R agent backend is not configured.");
  return new SupabaseMissionNotificationStore(supabase);
}
