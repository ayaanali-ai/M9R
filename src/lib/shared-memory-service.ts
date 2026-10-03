import { supabase } from "@/lib/supabase";
import { createClient } from "@/lib/supabase/server";
import { dashboardWorkspaceContext } from "@/lib/dashboard-workspace-context";
import { AgentJoinError, type AuthedAgent } from "@/lib/agent-join-service";
import { requireApproverRole } from "@/lib/workspace-membership-service";
import { memoryAllowance, normalizeMemoryNote } from "@/lib/shared-memory-core";
import { resolveActiveOrDefaultProjectId } from "@/lib/projects-service";

function service() {
  if (!supabase) throw new AgentJoinError("Memory is not configured.", "DB_NOT_CONFIGURED", 503);
  return supabase;
}
export function memoryDatabaseError(error: { message?: string; code?: string }) {
  if (error.message?.includes("WORKSPACE_MEMORY_LIMIT_REACHED")) throw new AgentJoinError("Workspace memory is full. Delete saved memory to make space in the shared 10 MiB allowance.", "WORKSPACE_MEMORY_LIMIT_REACHED", 413);
  throw new AgentJoinError("Shared memory is temporarily unavailable. Please try again in a moment.", "MEMORY_UNAVAILABLE", 503);
}
async function human() {
  const context = await dashboardWorkspaceContext();
  if (!context) throw new AgentJoinError("Sign in to use shared memory.", "UNAUTHENTICATED", 401);
  return context;
}
async function assertChannel(workspaceId: string, conversationId: string, actor: { userId: string } | { connectionId: string }) {
  const db = service();
  const { data: channel, error } = await db.from("agent_conversations").select("id, is_private, channel_kind, created_by_user_id, human_membership_managed").eq("id", conversationId).eq("workspace_id", workspaceId).maybeSingle();
  if (error || !channel) throw new AgentJoinError("Memory channel not found.", "NOT_FOUND", 404);
  if ("connectionId" in actor) {
    const { data: participant, error: participantError } = await db.from("conversation_participants").select("connection_id").eq("workspace_id", workspaceId).eq("conversation_id", conversationId).eq("connection_id", actor.connectionId).maybeSingle();
    if (participantError || !participant) throw new AgentJoinError("This agent cannot access that channel's memory.", "FORBIDDEN", 403);
  } else {
    const { data: project } = await db.from("projects").select("owner_id").eq("id", workspaceId).maybeSingle();
    if (project?.owner_id === actor.userId || channel.created_by_user_id === actor.userId) return;
    const { data: member, error: memberError } = await db.from("workspace_members").select("user_id").eq("workspace_id", workspaceId).eq("user_id", actor.userId).maybeSingle();
    if (memberError || !member) throw new AgentJoinError("Workspace membership required.", "FORBIDDEN", 403);
    if (!channel.is_private && !channel.human_membership_managed && channel.channel_kind !== "dm") return;
    const { data: channelMember } = await db.from("conversation_human_members").select("user_id").eq("workspace_id", workspaceId).eq("conversation_id", conversationId).eq("user_id", actor.userId).maybeSingle();
    if (!channelMember) throw new AgentJoinError("You cannot access that channel's memory.", "FORBIDDEN", 403);
  }
}
export async function sharedMemoryUsage(workspaceId: string) {
  const db = service();
  const [{ data: bytes, error }, { data: quota, error: quotaError }] = await Promise.all([
    db.rpc("m9r_memory_bytes", { p_workspace: workspaceId }),
    db.from("workspace_memory_quotas").select("limit_bytes").eq("workspace_id", workspaceId).maybeSingle(),
  ]);
  if (error || quotaError) memoryDatabaseError(error ?? quotaError!);
  return memoryAllowance(Number(bytes), quota ? Number(quota.limit_bytes) : undefined);
}
const NOTE_COLUMNS = "id, workspace_id, conversation_id, title, body, source, author_user_id, author_connection_id, reviewed, reviewed_by, reviewed_at, created_at";
export async function listSharedMemoryForAgent(agent: AuthedAgent, query = "", conversationId?: string | null) {
  if (!agent.scopes.includes("rules:read")) throw new AgentJoinError("Token lacks rules:read scope.", "FORBIDDEN", 403);
  const db = service();
  let channels: string[] = [];
  if (conversationId) { await assertChannel(agent.workspaceId, conversationId, { connectionId: agent.connectionId }); channels = [conversationId]; }
  else {
    const { data, error } = await db.from("conversation_participants").select("conversation_id").eq("workspace_id", agent.workspaceId).eq("connection_id", agent.connectionId);
    if (error) memoryDatabaseError(error);
    channels = (data ?? []).map(row => row.conversation_id as string);
  }
  let notesQuery = db.from("workspace_memory_notes").select(NOTE_COLUMNS).eq("workspace_id", agent.workspaceId).eq("reviewed", true);
  // IDs originate from DB membership rows, never directly from request input.
  notesQuery = channels.length ? notesQuery.or(`conversation_id.is.null,conversation_id.in.(${channels.join(",")})`) : notesQuery.is("conversation_id", null);
  const q = query.replace(/[%_,().]/g, " ").trim().slice(0, 120);
  if (q) notesQuery = notesQuery.ilike("body", `%${q}%`);
  const { data, error } = await notesQuery.order("created_at", { ascending: false }).limit(20);
  if (error) memoryDatabaseError(error);
  // Recall stays small; full notes remain available to humans in the memory view.
  return (data ?? []).map(note => ({ ...note, body: note.body.slice(0, 1200), truncated: note.body.length > 1200 }));
}
export async function readHumanSharedMemory(conversationId?: string | null) {
  const context = await human();
  if (conversationId) await assertChannel(context.workspaceId, conversationId, context);
  // Cookie RLS filters private channel memory for the viewer before returning text.
  const db = await createClient();
  let query = db!.from("workspace_memory_notes").select(NOTE_COLUMNS).eq("workspace_id", context.workspaceId);
  query = conversationId ? query.or(`conversation_id.is.null,conversation_id.eq.${conversationId}`) : query.is("conversation_id", null);
  const [{ data, error }, usage] = await Promise.all([query.order("created_at", { ascending: false }).limit(100), sharedMemoryUsage(context.workspaceId)]);
  if (error) memoryDatabaseError(error);
  let canManage = false;
  try { await requireApproverRole(context.workspaceId, context.userId); canManage = true; }
  catch (error) { if (!(error instanceof Error) || !("status" in error) || error.status !== 403) throw error; }
  const userIds = [...new Set((data ?? []).flatMap(note => note.author_user_id ? [note.author_user_id] : []))];
  const agentIds = [...new Set((data ?? []).flatMap(note => note.author_connection_id ? [note.author_connection_id] : []))];
  const [users, agents] = await Promise.all([
    userIds.length ? service().from("users").select("id,name").in("id",userIds) : Promise.resolve({data:[]}),
    agentIds.length ? service().from("agent_connections").select("id,agent_kind").eq("workspace_id",context.workspaceId).in("id",agentIds) : Promise.resolve({data:[]}),
  ]);
  const names = new Map<string,string>();
  for (const row of users.data ?? []) names.set(row.id,row.name || "Team member");
  for (const row of agents.data ?? []) names.set(row.id,row.agent_kind);
  return { notes: (data ?? []).map(note => ({...note, authorLabel:names.get(note.author_user_id ?? note.author_connection_id) ?? note.source})), usage, canManage };
}
export async function saveSharedMemory(raw: unknown, agent?: AuthedAgent) {
  const actor = agent ? { workspaceId: agent.workspaceId, connectionId: agent.connectionId } : await human();
  if (agent && !agent.scopes.includes("session:submit")) throw new AgentJoinError("Token lacks session:submit scope.", "FORBIDDEN", 403);
  let note: ReturnType<typeof normalizeMemoryNote>;
  try { note = normalizeMemoryNote(raw); } catch (error) { throw new AgentJoinError(error instanceof Error ? error.message : "Invalid memory.", "INVALID_MEMORY", 400); }
  const channel = (raw as { conversationId?: unknown }).conversationId;
  if (channel !== undefined && channel !== null && typeof channel !== "string") throw new AgentJoinError("Invalid memory channel.", "INVALID_MEMORY", 400);
  if (channel) await assertChannel(actor.workspaceId, channel, actor);
  const { data, error } = await service().from("workspace_memory_notes").insert({ workspace_id: actor.workspaceId, conversation_id: channel || null, title: note.title, body: note.body, content_hash: note.contentHash, source: agent ? "agent" : "human", author_connection_id: agent?.connectionId ?? null, author_user_id: "userId" in actor ? actor.userId : null, reviewed: !agent }).select(NOTE_COLUMNS).single();
  if (error?.code === "23505") return { ok: true, duplicate: true };
  if (error) memoryDatabaseError(error);
  return { ok: true, note: data, reviewRequired: Boolean(agent) };
}
export async function mutateSharedMemory(id: string, action: "approve" | "delete") {
  const context = await human();
  await requireApproverRole(context.workspaceId, context.userId);
  const { data: note, error: lookupError } = await service().from("workspace_memory_notes").select("id, conversation_id").eq("id", id).eq("workspace_id", context.workspaceId).maybeSingle();
  if (lookupError) memoryDatabaseError(lookupError);
  if (!note) throw new AgentJoinError("Memory note not found.", "NOT_FOUND", 404);
  if (note.conversation_id) await assertChannel(context.workspaceId, note.conversation_id, context);
  const {error} = await service().rpc("m9r_review_memory_note", {p_workspace:context.workspaceId,p_note:id,p_actor:context.userId,p_delete:action === "delete"});
  if (error) memoryDatabaseError(error);
  return { ok: true };
}

/**
 * Sync for a person's own M9R install, authenticated by a personal API token (Settings > API tokens) that the route has
 * already resolved to `userId`. Only workspace-level notes travel: a private channel's memory never leaves the dashboard.
 */
async function workspaceForUser(userId: string): Promise<string> {
  return resolveActiveOrDefaultProjectId(service(), { id: userId, email: null, name: null });
}
export async function listSyncedNotesForUser(userId: string) {
  const workspaceId = await workspaceForUser(userId);
  const { data, error } = await service().from("workspace_memory_notes").select("id, title, body, created_at").eq("workspace_id", workspaceId).is("conversation_id", null).eq("reviewed", true).order("created_at", { ascending: false }).limit(50);
  if (error) memoryDatabaseError(error);
  return (data ?? []).map((note) => ({ id: note.id as string, title: note.title as string, body: String(note.body).slice(0, 1_200), createdAt: note.created_at as string }));
}
/** A note the person saved is shared at once; `propose` is for notes an agent wrote, which wait in the dashboard for Save or No. */
export async function saveSyncedNoteForUser(userId: string, raw: unknown, propose: boolean) {
  const workspaceId = await workspaceForUser(userId);
  let note: ReturnType<typeof normalizeMemoryNote>;
  try { note = normalizeMemoryNote(raw); } catch (error) { throw new AgentJoinError(error instanceof Error ? error.message : "Invalid memory.", "INVALID_MEMORY", 400); }
  const { error } = await service().from("workspace_memory_notes").insert({ workspace_id: workspaceId, conversation_id: null, title: note.title, body: note.body, content_hash: note.contentHash, source: propose ? "agent" : "human", author_connection_id: null, author_user_id: userId, reviewed: !propose });
  if (error?.code === "23505") return { ok: true, duplicate: true };
  if (error) memoryDatabaseError(error);
  return { ok: true, proposed: propose };
}
