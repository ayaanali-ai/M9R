import { supabase } from "@/lib/supabase";
import type { SupabaseClient } from "@supabase/supabase-js";
import { MissionApiError } from "./mission-application-errors";
import type { MissionPrincipal } from "./mission-principal";
import { createSupabaseMissionEventReader } from "./mission-store-supabase";
import { projectMission } from "./mission-projection";
import type { MissionId, MissionMessage } from "./mission-domain";

const ALLOWED_MEDIA_TYPES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf",
  "text/plain", "text/markdown", "application/json", "audio/mpeg", "audio/ogg", "audio/wav",
]);

export interface CollaborationSnapshot {
  visibility: "workspace" | "private";
  members: string[];
  reactions: Array<{ messageId: string; participantId: string; emoji: string }>;
  revisions: Array<{ messageId: string; editorParticipantId: string; version: number; body: string | null; deleted: boolean; createdAt: string }>;
  attachments: Array<{ id: string; messageId: string; name: string; mediaType: string; sizeBytes: number; url: string }>;
  canvases: Array<{ id: string; title: string; currentVersion: number; content: Record<string, unknown> | null; editors: string[] }>;
  huddle: { id: string; startedBy: string; startedAt: string } | null;
}

type Context = {
  client: SupabaseClient;
  participantId: string;
  messages: MissionMessage[];
  participantIds: Set<string>;
  visibility: "workspace" | "private";
  members: Set<string>;
};

function db(): SupabaseClient {
  if (!supabase) throw new MissionApiError("M9R is not configured.", "backend_not_configured", 503);
  return supabase;
}

async function context(principal: MissionPrincipal, missionId: string, requireMember = true): Promise<Context> {
  const client = db();
  const { data: mission, error } = await client.from("missions").select("id,workspace_id").eq("id", missionId).maybeSingle();
  if (error) throw new Error(`Failed to load Mission collaboration context: ${error.message}`);
  if (!mission || String(mission.workspace_id) !== principal.workspaceId) throw new MissionApiError("Mission was not found.", "mission_not_found", 404);
  const events = await createSupabaseMissionEventReader().loadEvents(missionId as MissionId);
  const projection = projectMission(missionId as MissionId, events);
  const participantId = principal.actor.id;
  const participantIds = new Set(Object.keys(projection.participants));
  if (!participantIds.has(participantId) && principal.kind !== "human") throw new MissionApiError("Active Mission membership is required.", "unauthorized_command", 403);
  const { data: channel } = await client.from("mission_channels").select("visibility").eq("mission_id", missionId).maybeSingle();
  const { data: memberRows } = await client.from("mission_channel_members").select("participant_id").eq("mission_id", missionId);
  const visibility = channel?.visibility === "private" ? "private" : "workspace";
  const members = new Set((memberRows ?? []).map((row) => String(row.participant_id)));
  if (requireMember && visibility === "private" && !members.has(participantId)) {
    throw new MissionApiError("Mission was not found.", "mission_not_found", 404);
  }
  const messages = events.flatMap((event) => event.payload.type === "mission.message_posted" ? [event.payload.message] : []);
  return { client, participantId, messages, participantIds, visibility, members };
}

function messageOrThrow(ctx: Context, messageId: string): MissionMessage {
  const message = ctx.messages.find((candidate) => candidate.id === messageId);
  if (!message) throw new MissionApiError("Message was not found.", "validation_error", 404);
  return message;
}

function assertHuman(principal: MissionPrincipal): void {
  if (principal.kind !== "human") throw new MissionApiError("A human Mission owner is required.", "human_required", 403);
}

export async function getMissionCollaboration(principal: MissionPrincipal, missionId: string): Promise<CollaborationSnapshot> {
  const ctx = await context(principal, missionId);
  const [reactionResult, revisionResult, attachmentResult, canvasResult, huddleResult] = await Promise.all([
    ctx.client.from("mission_message_reactions").select("message_id,participant_id,emoji").eq("mission_id", missionId),
    ctx.client.from("mission_message_revisions").select("message_id,editor_participant_id,version,body,deleted,created_at").eq("mission_id", missionId).order("version", { ascending: true }),
    ctx.client.from("mission_message_attachments").select("id,message_id,name,media_type,size_bytes,url").eq("mission_id", missionId),
    ctx.client.from("mission_canvases").select("id,title,current_version").eq("mission_id", missionId).order("updated_at", { ascending: false }),
    ctx.client.from("mission_huddles").select("id,started_by,started_at").eq("mission_id", missionId).is("ended_at", null).maybeSingle(),
  ]);
  for (const result of [reactionResult, revisionResult, attachmentResult, canvasResult, huddleResult]) if (result.error) throw new Error(result.error.message);
  const canvases = await Promise.all((canvasResult.data ?? []).map(async (canvas) => {
    const [version, editors] = await Promise.all([
      ctx.client.from("mission_canvas_versions").select("content").eq("canvas_id", canvas.id).eq("version", canvas.current_version).maybeSingle(),
      ctx.client.from("mission_canvas_editors").select("participant_id").eq("canvas_id", canvas.id),
    ]);
    if (version.error || editors.error) throw new Error(version.error?.message ?? editors.error?.message);
    return { id: String(canvas.id), title: String(canvas.title), currentVersion: Number(canvas.current_version), content: (version.data?.content as Record<string, unknown> | undefined) ?? null, editors: (editors.data ?? []).map((row) => String(row.participant_id)) };
  }));
  return {
    visibility: ctx.visibility,
    members: [...ctx.members],
    reactions: (reactionResult.data ?? []).map((row) => ({ messageId: String(row.message_id), participantId: String(row.participant_id), emoji: String(row.emoji) })),
    revisions: (revisionResult.data ?? []).map((row) => ({ messageId: String(row.message_id), editorParticipantId: String(row.editor_participant_id), version: Number(row.version), body: row.body === null ? null : String(row.body), deleted: Boolean(row.deleted), createdAt: String(row.created_at) })),
    attachments: await Promise.all((attachmentResult.data ?? []).map(async (row) => {
      const storedUrl = String(row.url);
      if (!storedUrl.startsWith("mission-media://")) return { id: String(row.id), messageId: String(row.message_id), name: String(row.name), mediaType: String(row.media_type), sizeBytes: Number(row.size_bytes), url: storedUrl };
      const signed = await ctx.client.storage.from("mission-media").createSignedUrl(storedUrl.slice("mission-media://".length), 900);
      if (signed.error) throw new Error(signed.error.message);
      return { id: String(row.id), messageId: String(row.message_id), name: String(row.name), mediaType: String(row.media_type), sizeBytes: Number(row.size_bytes), url: signed.data.signedUrl };
    })),
    canvases,
    huddle: huddleResult.data ? { id: String(huddleResult.data.id), startedBy: String(huddleResult.data.started_by), startedAt: String(huddleResult.data.started_at) } : null,
  };
}

export async function applyMissionCollaborationAction(principal: MissionPrincipal, missionId: string, action: Record<string, unknown>): Promise<void> {
  const kind = String(action.type ?? "");
  const ctx = await context(principal, missionId, kind !== "set_visibility");
  if (kind === "toggle_reaction") {
    const messageId = String(action.messageId ?? ""); const emoji = String(action.emoji ?? "").trim();
    messageOrThrow(ctx, messageId);
    if (!emoji || emoji.length > 16) throw new MissionApiError("Reaction emoji is invalid.", "validation_error", 400);
    const query = ctx.client.from("mission_message_reactions").delete().eq("mission_id", missionId).eq("message_id", messageId).eq("participant_id", ctx.participantId).eq("emoji", emoji).select("emoji");
    const removed = await query; if (removed.error) throw new Error(removed.error.message);
    if (!removed.data?.length) { const inserted = await ctx.client.from("mission_message_reactions").insert({ mission_id: missionId, message_id: messageId, participant_id: ctx.participantId, emoji }); if (inserted.error) throw new Error(inserted.error.message); }
    return;
  }
  if (kind === "edit_message" || kind === "delete_message") {
    const messageId = String(action.messageId ?? ""); const message = messageOrThrow(ctx, messageId);
    if (message.senderParticipantId !== ctx.participantId && principal.kind !== "human") throw new MissionApiError("Only the author or human owner may change this message.", "unauthorized_command", 403);
    const { data: latest } = await ctx.client.from("mission_message_revisions").select("version").eq("mission_id", missionId).eq("message_id", messageId).order("version", { ascending: false }).limit(1).maybeSingle();
    const deleted = kind === "delete_message"; const body = deleted ? null : String(action.body ?? "").trim();
    if (!deleted && (!body || body.length > 12000)) throw new MissionApiError("Edited message body is invalid.", "validation_error", 400);
    const inserted = await ctx.client.from("mission_message_revisions").insert({ mission_id: missionId, message_id: messageId, editor_participant_id: ctx.participantId, version: Number(latest?.version ?? 0) + 1, body, deleted });
    if (inserted.error) throw new Error(inserted.error.message); return;
  }
  if (kind === "add_attachment") {
    const messageId = String(action.messageId ?? ""); messageOrThrow(ctx, messageId);
    const name = String(action.name ?? "").trim(); const mediaType = String(action.mediaType ?? ""); const sizeBytes = Number(action.sizeBytes); const url = String(action.url ?? "");
    let parsed: URL; try { parsed = new URL(url); } catch { throw new MissionApiError("Attachment URL is invalid.", "validation_error", 400); }
    if (parsed.protocol !== "https:" || !name || name.length > 256 || !ALLOWED_MEDIA_TYPES.has(mediaType) || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > 25 * 1024 * 1024) throw new MissionApiError("Attachment metadata is invalid.", "validation_error", 400);
    const inserted = await ctx.client.from("mission_message_attachments").insert({ mission_id: missionId, message_id: messageId, uploader_participant_id: ctx.participantId, name, media_type: mediaType, size_bytes: sizeBytes, url }); if (inserted.error) throw new Error(inserted.error.message); return;
  }
  if (kind === "set_visibility") {
    assertHuman(principal); const visibility = action.visibility === "private" ? "private" : "workspace";
    const upserted = await ctx.client.from("mission_channels").upsert({ mission_id: missionId, workspace_id: principal.workspaceId, visibility, created_by: ctx.participantId, updated_at: new Date().toISOString() }); if (upserted.error) throw new Error(upserted.error.message);
    if (visibility === "private") { const owner = await ctx.client.from("mission_channel_members").upsert({ mission_id: missionId, participant_id: ctx.participantId, added_by: ctx.participantId }); if (owner.error) throw new Error(owner.error.message); } return;
  }
  if (kind === "set_member") {
    assertHuman(principal); const participantId = String(action.participantId ?? ""); if (!ctx.participantIds.has(participantId)) throw new MissionApiError("Participant was not found.", "validation_error", 404);
    if (!action.member && participantId === ctx.participantId) throw new MissionApiError("The human owner cannot remove their own private-channel membership.", "validation_error", 400);
    const result = action.member ? await ctx.client.from("mission_channel_members").upsert({ mission_id: missionId, participant_id: participantId, added_by: ctx.participantId }) : await ctx.client.from("mission_channel_members").delete().eq("mission_id", missionId).eq("participant_id", participantId);
    if (result.error) throw new Error(result.error.message); return;
  }
  if (kind === "create_canvas") {
    const title = String(action.title ?? "").trim(); const content = action.content;
    if (!title || title.length > 160 || !content || typeof content !== "object" || Array.isArray(content) || JSON.stringify(content).length > 262144) throw new MissionApiError("Canvas is invalid.", "validation_error", 400);
    const created = await ctx.client.from("mission_canvases").insert({ mission_id: missionId, title, created_by: ctx.participantId, current_version: 1 }).select("id").single(); if (created.error) throw new Error(created.error.message);
    const [version, editor] = await Promise.all([ctx.client.from("mission_canvas_versions").insert({ canvas_id: created.data.id, version: 1, editor_participant_id: ctx.participantId, content }), ctx.client.from("mission_canvas_editors").insert({ canvas_id: created.data.id, participant_id: ctx.participantId, added_by: ctx.participantId })]);
    if (version.error || editor.error) throw new Error(version.error?.message ?? editor.error?.message); return;
  }
  if (kind === "update_canvas") {
    const canvasId = String(action.canvasId ?? ""); const content = action.content;
    if (!content || typeof content !== "object" || Array.isArray(content) || JSON.stringify(content).length > 262144) throw new MissionApiError("Canvas content is invalid.", "validation_error", 400);
    const { data: editor } = await ctx.client.from("mission_canvas_editors").select("participant_id").eq("canvas_id", canvasId).eq("participant_id", ctx.participantId).maybeSingle(); if (!editor && principal.kind !== "human") throw new MissionApiError("Canvas editor access is required.", "unauthorized_command", 403);
    const { data: canvas } = await ctx.client.from("mission_canvases").select("current_version").eq("id", canvasId).eq("mission_id", missionId).single(); if (!canvas) throw new MissionApiError("Canvas was not found.", "validation_error", 404);
    const version = Number(canvas.current_version) + 1; const inserted = await ctx.client.from("mission_canvas_versions").insert({ canvas_id: canvasId, version, editor_participant_id: ctx.participantId, content }); if (inserted.error) throw new Error(inserted.error.message);
    const updated = await ctx.client.from("mission_canvases").update({ current_version: version, updated_at: new Date().toISOString() }).eq("id", canvasId).eq("current_version", canvas.current_version); if (updated.error) throw new Error(updated.error.message); return;
  }
  if (kind === "start_huddle") {
    const inserted = await ctx.client.from("mission_huddles").insert({ mission_id: missionId, started_by: ctx.participantId }); if (inserted.error) throw new MissionApiError("A huddle is already live for this Mission.", "conflict", 409); return;
  }
  if (kind === "end_huddle") {
    const updated = await ctx.client.from("mission_huddles").update({ ended_by: ctx.participantId, ended_at: new Date().toISOString() }).eq("mission_id", missionId).is("ended_at", null); if (updated.error) throw new Error(updated.error.message); return;
  }
  throw new MissionApiError("Unsupported collaboration action.", "validation_error", 400);
}

export async function uploadMissionAttachment(principal: MissionPrincipal, missionId: string, messageId: string, file: File): Promise<void> {
  const ctx = await context(principal, missionId);
  messageOrThrow(ctx, messageId);
  if (!file.name || file.name.length > 256 || !ALLOWED_MEDIA_TYPES.has(file.type) || file.size <= 0 || file.size > 25 * 1024 * 1024) throw new MissionApiError("Attachment file is invalid or unsupported.", "validation_error", 400);
  const safeName = file.name.normalize("NFKC").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(-120) || "attachment";
  const path = `${principal.workspaceId}/${missionId}/${messageId}/${crypto.randomUUID()}-${safeName}`;
  const uploaded = await ctx.client.storage.from("mission-media").upload(path, await file.arrayBuffer(), { contentType: file.type, upsert: false });
  if (uploaded.error) throw new Error(uploaded.error.message);
  const inserted = await ctx.client.from("mission_message_attachments").insert({ mission_id: missionId, message_id: messageId, uploader_participant_id: ctx.participantId, name: file.name, media_type: file.type, size_bytes: file.size, url: `mission-media://${path}` });
  if (inserted.error) {
    await ctx.client.storage.from("mission-media").remove([path]);
    throw new Error(inserted.error.message);
  }
}
