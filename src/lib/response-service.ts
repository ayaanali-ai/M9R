/**
 * Response Service — DB-facing writes/reads for Run Room exchanges (Phase 3).
 * ----------------------------------------------------------------------------
 * Same trust model as dispatch-service.ts: service-role writes scoped in app
 * code, cookie-client reads scoped by RLS.
 */

import { supabase } from "@/lib/supabase";
import { createClient } from "@/lib/supabase/server";
import { AgentJoinError } from "@/lib/agent-join-service";
import { validateResponse, type ResponseInput, type ResponseType, type ResponseSenderRole } from "@/lib/response";

function requireService() {
  if (!supabase) {
    throw new AgentJoinError("M9R agent backend is not configured.", "DB_NOT_CONFIGURED", 503);
  }
  return supabase;
}

/** Same "migration not applied yet" fallback as dispatch-service.ts. */
function isMissingTableError(err: { code?: string | null; message?: string | null } | null): boolean {
  if (!err) return false;
  return err.code === "42P01" || err.code === "PGRST205" || /Could not find the table/i.test(err.message ?? "");
}

export interface PublishResponseResult {
  ok: boolean;
  id: string | null;
  errors: string[];
}

export interface OperatorResponseDelivery {
  status: "delivered" | "unavailable" | "failed";
  conversationId?: string;
  messageId?: string;
  reason?: string;
}

function isMissingColumnError(err: { code?: string | null; message?: string | null } | null): boolean {
  if (!err) return false;
  return err.code === "42703" || /column .* does not exist/i.test(err.message ?? "");
}

/**
 * Run Room responses used to stop at the `responses` table.  That made the
 * dashboard look successful while the provider never received the operator's
 * reply.  Route the operator copy through the same durable workspace-message
 * path the bridge already polls.  The response remains the canonical Run Room
 * record; this is an explicitly linked delivery projection, not a second
 * source of truth.
 */
export async function deliverOperatorResponseToAgent(input: {
  workspaceId: string;
  connectionId: string;
  operatorUserId: string;
  runId: string;
  responseId: string;
  dispatchId: string | null;
  body: string;
}): Promise<OperatorResponseDelivery> {
  try {
    const db = requireService();
    const { data: connection, error: connectionError } = await db
      .from("agent_connections")
      .select("id, agent_kind, repo_hint, status")
      .eq("id", input.connectionId)
      .eq("workspace_id", input.workspaceId)
      .maybeSingle();
    if (connectionError) {
      if (isMissingTableError(connectionError)) return { status: "unavailable", reason: "agent connection storage is unavailable" };
      return { status: "failed", reason: "agent connection lookup failed" };
    }
    if (!connection || connection.status !== "active") {
      return { status: "unavailable", reason: "the target agent connection is not active" };
    }

    const channelSlug = `dm-${input.connectionId}`;
    let { data: conversation, error: conversationError } = await db
      .from("agent_conversations")
      .select("id, status, channel_kind")
      .eq("workspace_id", input.workspaceId)
      .eq("channel_slug", channelSlug)
      .maybeSingle();
    if (conversationError) {
      if (isMissingTableError(conversationError)) return { status: "unavailable", reason: "conversation storage is unavailable" };
      return { status: "failed", reason: "run reply channel lookup failed" };
    }

    if (!conversation) {
      const created = await db.from("agent_conversations").insert({
        workspace_id: input.workspaceId,
        topic: `Run Room · ${String(connection.agent_kind ?? "agent")}`,
        channel_slug: channelSlug,
        channel_kind: "dm",
        is_private: true,
        created_by_user_id: input.operatorUserId,
        repository: typeof connection.repo_hint === "string" ? connection.repo_hint : null,
      }).select("id, status, channel_kind").single();
      if (created.error && created.error.code === "23505") {
        const retry = await db.from("agent_conversations").select("id, status, channel_kind").eq("workspace_id", input.workspaceId).eq("channel_slug", channelSlug).maybeSingle();
        conversation = retry.data;
        conversationError = retry.error;
      } else {
        conversation = created.data;
        conversationError = created.error;
      }
      if (conversationError || !conversation) return { status: "failed", reason: "run reply channel could not be created" };
    }

    const resolvedConversation = conversation;
    if (!resolvedConversation) return { status: "failed", reason: "run reply channel could not be resolved" };
    if (resolvedConversation.channel_kind && resolvedConversation.channel_kind !== "dm") {
      return { status: "failed", reason: "the run reply channel slug is already used by a non-direct channel" };
    }

    if (resolvedConversation.status !== "open") {
      const { data: restored, error: restoreError } = await db.from("agent_conversations")
        .update({ status: "open", archived_at: null })
        .eq("id", resolvedConversation.id)
        .eq("workspace_id", input.workspaceId)
        .select("id, status, channel_kind")
        .single();
      if (restoreError || !restored) return { status: "failed", reason: "run reply channel could not be reopened" };
      conversation = restored;
    }

    const activeConversation = conversation;
    if (!activeConversation) return { status: "failed", reason: "run reply channel could not be resolved" };

    const { error: participantError } = await db.from("conversation_participants").upsert({
      workspace_id: input.workspaceId,
      conversation_id: activeConversation.id,
      connection_id: input.connectionId,
    }, { onConflict: "conversation_id,connection_id", ignoreDuplicates: true });
    if (participantError) return { status: "failed", reason: "run reply channel membership could not be saved" };

    const prefix = `Run Room reply for run ${input.runId}${input.dispatchId ? ` (dispatch ${input.dispatchId})` : ""}:`;
    const { data: message, error: messageError } = await db.from("conversation_messages").insert({
      workspace_id: input.workspaceId,
      conversation_id: activeConversation.id,
      sender_user_id: input.operatorUserId,
      sender_display_name: "Operator",
      recipient_connection_id: input.connectionId,
      kind: "message",
      body: `${prefix} ${input.body}`.slice(0, 2000),
      idempotency_key: `run-room-response:${input.responseId}`,
    }).select("id").single();
    if (messageError || !message) {
      if (isMissingColumnError(messageError)) return { status: "failed", reason: "message idempotency migration is not applied" };
      if (messageError?.code === "23505") {
        const { data: existing } = await db.from("conversation_messages").select("id").eq("workspace_id", input.workspaceId).eq("idempotency_key", `run-room-response:${input.responseId}`).maybeSingle();
        if (existing) return { status: "delivered", conversationId: activeConversation.id, messageId: existing.id as string };
      }
      return { status: "failed", reason: "run reply could not be delivered to the agent inbox" };
    }
    return { status: "delivered", conversationId: activeConversation.id, messageId: message.id as string };
  } catch (error) {
    console.error("deliverOperatorResponseToAgent failed:", error instanceof Error ? error.message : error);
    return { status: "failed", reason: "run reply delivery failed" };
  }
}

export async function publishResponse(input: ResponseInput): Promise<PublishResponseResult> {
  const result = validateResponse(input);
  if (!result.ok || !result.normalized) {
    return { ok: false, id: null, errors: result.errors.map((e) => `${e.field}: ${e.message}`) };
  }
  const r = result.normalized;

  try {
    const db = requireService();
    const { data, error } = await db
      .from("responses")
      .insert({
        workspace_id: r.workspaceId,
        run_id: r.runId,
        dispatch_id: r.dispatchId,
        schema_version: r.schemaVersion,
        type: r.type,
        sender_role: r.senderRole,
        sender: r.sender,
        recipient: r.recipient,
        body: r.body,
        scope: r.scope,
        resolution_state: r.resolutionState,
      })
      .select("id")
      .single();

    if (error) {
      if (isMissingTableError(error)) return { ok: true, id: null, errors: [] };
      console.error("publishResponse failed:", error.message, error.code);
      return { ok: false, id: null, errors: [error.message] };
    }

    // A resolving Response closes the Dispatch it answers (best-effort — this
    // never blocks the Response itself from having been recorded).
    if (r.dispatchId && r.resolutionState === "resolved") {
      const { error: dispatchError } = await db
        .from("dispatches")
        .update({ resolution_state: "resolved" })
        .eq("id", r.dispatchId);
      if (dispatchError && !isMissingTableError(dispatchError)) {
        console.error("resolving parent dispatch failed:", dispatchError.message, dispatchError.code);
      }
    }

    return { ok: true, id: (data as { id: string }).id, errors: [] };
  } catch (err) {
    console.error("publishResponse threw:", err instanceof Error ? err.message : err);
    return { ok: false, id: null, errors: ["Response publish failed."] };
  }
}

export interface ResponseEntry {
  id: string;
  runId: string;
  dispatchId: string | null;
  type: ResponseType;
  senderRole: ResponseSenderRole;
  sender: string;
  recipient: string;
  body: string;
  scope: string[];
  resolutionState: string;
  createdAt: string;
}

/** Read all Responses for one run (RLS-scoped) — used to build the Run Thread. */
export async function listResponsesForRun(runId: string): Promise<ResponseEntry[]> {
  const db = await createClient();
  if (!db) return [];
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return [];

  const { data, error } = await db
    .from("responses")
    .select("id, run_id, dispatch_id, type, sender_role, sender, recipient, body, scope, resolution_state, created_at")
    .eq("run_id", runId)
    .order("created_at", { ascending: true });

  if (error) {
    if (isMissingTableError(error)) return [];
    throw error;
  }

  return ((data ?? []) as Array<{
    id: string;
    run_id: string;
    dispatch_id: string | null;
    type: string;
    sender_role: string;
    sender: string;
    recipient: string;
    body: string;
    scope: string[] | null;
    resolution_state: string;
    created_at: string;
  }>).map((row) => ({
    id: row.id,
    runId: row.run_id,
    dispatchId: row.dispatch_id,
    type: row.type as ResponseType,
    senderRole: row.sender_role as ResponseSenderRole,
    sender: row.sender,
    recipient: row.recipient,
    body: row.body,
    scope: row.scope ?? [],
    resolutionState: row.resolution_state,
    createdAt: row.created_at,
  }));
}
