/**
 * Moderation primitives — Buzz-parity (crates/buzz-db's `moderation`/
 * `admin_moderation` modules). Scoped to a workspace owner moderating their
 * own workspace, not a site-wide static-bearer surface (a different concern
 * — request-security.ts's authorizedStaticBearer, used by the internal cron
 * routes).
 */

import { supabase } from "@/lib/supabase";
import { appendAuditLogEntry } from "@/lib/audit-log";

export type ModerationTargetKind = "user" | "connection";

function requireService() {
  if (!supabase) throw new Error("M9R backend is not configured.");
  return supabase;
}

export interface BanTarget {
  workspaceId: string;
  targetKind: ModerationTargetKind;
  targetId: string;
}

export async function banTarget(input: BanTarget & { reason: string | null; bannedByUserId: string }): Promise<void> {
  const db = requireService();
  const { error } = await db.from("workspace_bans").upsert({
    workspace_id: input.workspaceId, target_kind: input.targetKind, target_id: input.targetId,
    reason: input.reason, banned_by: input.bannedByUserId, banned_at: new Date().toISOString(),
  });
  if (error) throw new Error(`Could not ban target: ${error.message}`);
  // Not best-effort/swallowed: banning is a security action, and a ban with
  // no audit record is exactly the blind spot the tamper-evident chain
  // exists to prevent (see audit-log.ts's own documented contract). If the
  // write already happened but the audit append fails, this throws and the
  // caller sees a real error rather than a silently missing record.
  await appendAuditLogEntry({ workspaceId: input.workspaceId, action: "moderation.banned", actorKind: "human", actorId: input.bannedByUserId, payload: { targetKind: input.targetKind, targetId: input.targetId, reason: input.reason } });
}

export async function unbanTarget(input: BanTarget & { unbannedByUserId: string }): Promise<void> {
  const db = requireService();
  const { error } = await db.from("workspace_bans").delete().eq("workspace_id", input.workspaceId).eq("target_kind", input.targetKind).eq("target_id", input.targetId);
  if (error) throw new Error(`Could not unban target: ${error.message}`);
  await appendAuditLogEntry({ workspaceId: input.workspaceId, action: "moderation.unbanned", actorKind: "human", actorId: input.unbannedByUserId, payload: { targetKind: input.targetKind, targetId: input.targetId } });
}

/**
 * Fails OPEN on a database/infrastructure error (missing table, transient
 * connectivity issue), not closed. A real, severe regression this guarded
 * against: before this fix, a workspace whose `workspace_bans` migration
 * hadn't been applied yet got "Could not find the table 'public.
 * workspace_bans' in the schema cache" from Supabase on every single
 * message send, and assertMayPost's throw blocked the entire core
 * messaging path -- an optional safety feature's outage should never take
 * down the product it's supposed to be protecting. A genuine ban/mute
 * record (the actual security-relevant case) still fails closed below.
 */
export async function isBanned(workspaceId: string, targetKind: ModerationTargetKind, targetId: string): Promise<boolean> {
  const db = requireService();
  const { data, error } = await db.from("workspace_bans").select("workspace_id").eq("workspace_id", workspaceId).eq("target_kind", targetKind).eq("target_id", targetId).maybeSingle();
  if (error) {
    console.error(`Ban check failed open (workspace ${workspaceId}, ${targetKind}:${targetId}):`, error.message);
    return false;
  }
  return data !== null;
}

export interface MuteTarget {
  workspaceId: string;
  targetKind: ModerationTargetKind;
  targetId: string;
  /** null = muted workspace-wide, not just in one channel. */
  conversationId: string | null;
}

export async function muteTarget(input: MuteTarget & { reason: string | null; mutedByUserId: string }): Promise<void> {
  const db = requireService();
  const { error } = await db.from("workspace_mutes").upsert({
    workspace_id: input.workspaceId, target_kind: input.targetKind, target_id: input.targetId, conversation_id: input.conversationId,
    reason: input.reason, muted_by: input.mutedByUserId, muted_at: new Date().toISOString(),
  });
  if (error) throw new Error(`Could not mute target: ${error.message}`);
  await appendAuditLogEntry({ workspaceId: input.workspaceId, action: "moderation.muted", actorKind: "human", actorId: input.mutedByUserId, payload: { targetKind: input.targetKind, targetId: input.targetId, conversationId: input.conversationId, reason: input.reason } });
}

export async function unmuteTarget(input: MuteTarget & { unmutedByUserId: string }): Promise<void> {
  const db = requireService();
  let query = db.from("workspace_mutes").delete().eq("workspace_id", input.workspaceId).eq("target_kind", input.targetKind).eq("target_id", input.targetId);
  query = input.conversationId ? query.eq("conversation_id", input.conversationId) : query.is("conversation_id", null);
  const { error } = await query;
  if (error) throw new Error(`Could not unmute target: ${error.message}`);
  await appendAuditLogEntry({ workspaceId: input.workspaceId, action: "moderation.unmuted", actorKind: "human", actorId: input.unmutedByUserId, payload: { targetKind: input.targetKind, targetId: input.targetId, conversationId: input.conversationId } });
}

/** True if muted workspace-wide OR muted specifically in this conversation. Fails OPEN on a database error, same reasoning as isBanned above. */
export async function isMuted(workspaceId: string, targetKind: ModerationTargetKind, targetId: string, conversationId: string): Promise<boolean> {
  const db = requireService();
  const { data, error } = await db.from("workspace_mutes").select("conversation_id")
    .eq("workspace_id", workspaceId).eq("target_kind", targetKind).eq("target_id", targetId)
    .or(`conversation_id.is.null,conversation_id.eq.${conversationId}`);
  if (error) {
    console.error(`Mute check failed open (workspace ${workspaceId}, ${targetKind}:${targetId}, conversation ${conversationId}):`, error.message);
    return false;
  }
  return (data?.length ?? 0) > 0;
}

/** Throws a plain Error (callers map to their own HTTP error type) if the sender may not post — banned workspace-wide or muted in this conversation. */
export async function assertMayPost(workspaceId: string, targetKind: ModerationTargetKind, targetId: string, conversationId: string): Promise<void> {
  if (await isBanned(workspaceId, targetKind, targetId)) throw new Error("This account is banned from posting in this workspace.");
  if (await isMuted(workspaceId, targetKind, targetId, conversationId)) throw new Error("This account is muted in this channel.");
}

export async function reportMessage(input: { workspaceId: string; conversationId: string; messageId: string; reporterUserId: string; reason: string }): Promise<void> {
  if (!input.reason.trim()) throw new Error("A reason is required to report a message.");
  const db = requireService();
  const { error } = await db.from("workspace_message_reports").insert({
    workspace_id: input.workspaceId, conversation_id: input.conversationId, message_id: input.messageId,
    reporter_user_id: input.reporterUserId, reason: input.reason.trim().slice(0, 2000),
  });
  if (error) throw new Error(`Could not submit the report: ${error.message}`);
  await appendAuditLogEntry({ workspaceId: input.workspaceId, action: "moderation.message_reported", actorKind: "human", actorId: input.reporterUserId, payload: { conversationId: input.conversationId, messageId: input.messageId } });
}

export interface ModerationReport {
  id: string;
  conversationId: string;
  messageId: string;
  reporterUserId: string;
  reason: string;
  status: "open" | "reviewed" | "dismissed";
  createdAt: string;
}

export async function listModerationReports(workspaceId: string, status?: "open" | "reviewed" | "dismissed"): Promise<ModerationReport[]> {
  const db = requireService();
  let query = db.from("workspace_message_reports").select("id, conversation_id, message_id, reporter_user_id, reason, status, created_at").eq("workspace_id", workspaceId).order("created_at", { ascending: false }).limit(200);
  if (status) query = query.eq("status", status);
  const { data, error } = await query;
  if (error) throw new Error(`Could not load reports: ${error.message}`);
  return (data ?? []).map((row) => ({
    id: row.id, conversationId: row.conversation_id, messageId: row.message_id, reporterUserId: row.reporter_user_id,
    reason: row.reason, status: row.status as ModerationReport["status"], createdAt: row.created_at,
  }));
}

export async function setReportStatus(reportId: string, workspaceId: string, status: "reviewed" | "dismissed", actorUserId: string): Promise<void> {
  const db = requireService();
  const { error } = await db.from("workspace_message_reports").update({ status }).eq("id", reportId).eq("workspace_id", workspaceId);
  if (error) throw new Error(`Could not update the report: ${error.message}`);
  await appendAuditLogEntry({ workspaceId, action: "moderation.report_resolved", actorKind: "human", actorId: actorUserId, payload: { reportId, status } });
}
