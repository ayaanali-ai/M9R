import { supabase } from "@/lib/supabase";
import { createClient } from "@/lib/supabase/server";
import { AgentJoinError, type AuthedAgent } from "@/lib/agent-join-service";
import { effectiveRunSettings, effortsForModel, validateRunSettings, type AgentRunSettings } from "@/lib/agent-run-settings";

function service() {
  if (!supabase) throw new AgentJoinError("M9R is not configured.", "DB_NOT_CONFIGURED", 503);
  return supabase;
}

async function humanConnection(connectionId: string, manage: boolean) {
  const db = await createClient();
  if (!db) throw new AgentJoinError("Authentication unavailable.", "DB_NOT_CONFIGURED", 503);
  const { data: { user } } = await db.auth.getUser();
  if (!user) throw new AgentJoinError("Sign in to manage agent settings.", "UNAUTHENTICATED", 401);
  const { data, error } = await db.from("agent_connections").select("id, workspace_id, created_by, model, effort, available_models, available_efforts").eq("id", connectionId).eq("status", "active").maybeSingle();
  if (error) throw new AgentJoinError("Could not load agent settings right now. Please try again.", "SETTINGS_UNAVAILABLE", 503);
  if (!data) throw new AgentJoinError("Agent connection not found.", "NOT_FOUND", 404);
  if (manage && data.created_by !== user.id) {
    const { data: project } = await db.from("projects").select("owner_id").eq("id", data.workspace_id).maybeSingle();
    if (project?.owner_id !== user.id) throw new AgentJoinError("Only this agent's owner or the workspace owner can change its settings.", "FORBIDDEN", 403);
  }
  return { db, user, connection: data };
}

async function visibleChannel(db: NonNullable<Awaited<ReturnType<typeof createClient>>>, workspaceId: string, conversationId: string, connectionId: string) {
  const { data } = await db.from("agent_conversations").select("id").eq("id", conversationId).eq("workspace_id", workspaceId).maybeSingle();
  if (!data) throw new AgentJoinError("Channel not found.", "NOT_FOUND", 404);
  const { data: participant } = await service().from("conversation_participants").select("connection_id").eq("conversation_id", conversationId).eq("workspace_id", workspaceId).eq("connection_id", connectionId).maybeSingle();
  if (!participant) throw new AgentJoinError("This agent is not a channel member.", "NOT_A_CHANNEL_MEMBER", 403);
}

export async function readHumanRunSettings(connectionId: string, conversationId?: string | null) {
  const { db, connection } = await humanConnection(connectionId, false);
  const defaults: AgentRunSettings = { model: connection.model ?? null, effort: connection.effort ?? null };
  let override: AgentRunSettings | null = null;
  if (conversationId) {
    await visibleChannel(db, connection.workspace_id, conversationId, connectionId);
    const { data, error } = await db.from("channel_agent_settings").select("model, effort").eq("conversation_id", conversationId).eq("connection_id", connectionId).maybeSingle();
    if (error) throw new AgentJoinError("Channel settings unavailable.", "SETTINGS_UNAVAILABLE", 503);
    override = data;
  }
  return { defaults, override, effective: effectiveRunSettings(defaults, override), models: connection.available_models ?? null, efforts: connection.available_efforts ?? null };
}

export async function saveHumanRunSettings(connectionId: string, raw: unknown, conversationId?: string | null, inherit = false) {
  const { db, user, connection } = await humanConnection(connectionId, true);
  let settings: AgentRunSettings;
  try { settings = validateRunSettings(raw, { models: connection.available_models, efforts: connection.available_efforts }); }
  catch (error) { throw new AgentJoinError(error instanceof Error ? error.message : "Invalid settings.", "INVALID_SETTINGS", 400); }
  if (conversationId) {
    await visibleChannel(db, connection.workspace_id, conversationId, connectionId);
    const query = inherit
      ? service().from("channel_agent_settings").delete().eq("conversation_id", conversationId).eq("connection_id", connectionId).eq("workspace_id", connection.workspace_id)
      : service().from("channel_agent_settings").upsert({ workspace_id: connection.workspace_id, conversation_id: conversationId, connection_id: connectionId, ...settings, updated_by: user.id, updated_at: new Date().toISOString() }, { onConflict: "conversation_id,connection_id" });
    const { error } = await query;
    if (error) throw new AgentJoinError("Could not save channel settings.", "SETTINGS_WRITE_FAILED", 500);
  } else {
    const { error } = await service().from("agent_connections").update(settings).eq("id", connectionId).eq("workspace_id", connection.workspace_id).eq("status", "active");
    if (error) throw new AgentJoinError("Could not save agent settings.", "SETTINGS_WRITE_FAILED", 500);
  }
  return { ok: true, ...settings, applies: "next_turn" };
}

/** Token identity fixes workspace and connection; request input cannot widen either. */
export async function readAgentRunSettings(agent: AuthedAgent, conversationId?: string | null) {
  const db = service();
  const { data: connection, error } = await db.from("agent_connections").select("model, effort, available_models, available_efforts").eq("id", agent.connectionId).eq("workspace_id", agent.workspaceId).eq("status", "active").maybeSingle();
  if (error || !connection) throw new AgentJoinError("Agent settings unavailable.", "SETTINGS_UNAVAILABLE", 503);
  const supported = (settings: AgentRunSettings): AgentRunSettings => ({ model: settings.model, effort: effortsForModel({ models: connection.available_models, efforts: connection.available_efforts }, settings.model)?.some(option => option.id === settings.effort) ? settings.effort : null });
  if (!conversationId) return supported(connection);
  const { data: member, error: memberError } = await db.from("conversation_participants").select("connection_id").eq("workspace_id", agent.workspaceId).eq("conversation_id", conversationId).eq("connection_id", agent.connectionId).maybeSingle();
  if (memberError || !member) throw new AgentJoinError("Agent is not a member of this channel.", "NOT_A_CHANNEL_MEMBER", 403);
  const { data: override, error: overrideError } = await db.from("channel_agent_settings").select("model, effort").eq("workspace_id", agent.workspaceId).eq("conversation_id", conversationId).eq("connection_id", agent.connectionId).maybeSingle();
  if (overrideError) throw new AgentJoinError("Channel settings unavailable.", "SETTINGS_UNAVAILABLE", 503);
  return supported(effectiveRunSettings(connection, override));
}
