/**
 * Conversation Service — Gate 14: real multi-turn, multi-party agent talk.
 * ----------------------------------------------------------------------------
 * Same trust model as dispatch-service.ts / agent-run-service.ts: writes go
 * through the service-role client, scoped in app code to the caller's own
 * workspace and conversation membership -- never a client-supplied workspace
 * id trusted blind. A message body gets the same "don't accept source code or
 * secret-shaped content" discipline as a Dispatch summary (dispatch.ts).
 */

import { supabase } from "@/lib/supabase";
import { createClient } from "@/lib/supabase/server";
import { AgentJoinError, type AuthedAgent } from "@/lib/agent-join-service";
import { looksLikeSourceCode, SECRET_PATTERNS } from "@/lib/agent-run-core";
import { containsActiveContent } from "@/lib/agent-join";
import { startAgentRunFromHandoff } from "@/lib/agent-run-service";
import { isMissingColumnError } from "@/lib/agent-runs-read";
import { isRecentlySeenConnection } from "@/lib/agent-dashboard-presenter";
import { isMissionFeatureEnabled } from "@/lib/mission/mission-feature-flags";
import { reformatRunOnListReply } from "@/lib/reformat-run-on-list-reply";
import { ensureChannelMission, missionOwnerParticipantId, missionAgentParticipantId, type ChannelMentionedAgent } from "@/lib/mission/mission-channel-binding";
import { postMissionMessage } from "@/lib/mission/mission-application-service";
import { runChannelWorkflowsForMessage } from "@/lib/mission/mission-workflow-executor";
import { normalizeAgentKind } from "@/lib/agent-workspace-data";
import { agentAvailabilityUnknownNoticeBody, explicitlyMentionedAgentKinds, RECENT_CONNECTION_MAX_AGE_MS, unavailableAgentNoticeBody, unavailableExplicitAgentKinds } from "@/lib/conversation-routing";
import { scheduleShadowJudgment } from "@/lib/jev-shadow";
import { providerMention } from "@/lib/provider-adapter-config";
import { MISSION_BROADCAST_CHANNEL } from "@/lib/mission/mission-domain";
import { decideChatEvidenceRequestFromMessage, findPendingEvidenceDecisionTarget } from "@/lib/bridge/chat-evidence-service";
import { decodeWorkspaceCursor } from "@/lib/mission/workspace-cursor";
import { DIAGNOSTIC_INACTIVITY_MS, channelGroupForConversation, isDiagnosticConversation } from "@/lib/workspace-channel-groups";
import { resolveActiveOrDefaultProjectId } from "@/lib/projects-service";
import { requestCancelTurn, latestCancelTurnStatus } from "@/lib/bridge/bridge-cancel-turn-service";
import { listMessageTodosForConversations, normalizeMessageTodoEntries, upsertMessageTodos, type MessageTodoState } from "@/lib/bridge/message-todo-service";
import { listDraftsForConversation, upsertDraftSection, setDraftStatus, type Draft, type DraftStatus } from "@/lib/bridge/conversation-draft-service";
import type { WorkspaceRole } from "@/lib/workspace-membership-service";
import { idempotencyIdentityMatches } from "@/lib/conversation-idempotency";
import { publishInternalRelayFrame } from "@/lib/mission/mission-relay-internal-publish";
import { loadDashboardMessageWindows, loadDashboardUnreadCounts } from "@/lib/dashboard-list-batching";

export const ALLOWED_ATTACHMENT_MEDIA_TYPES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf",
  "text/plain", "text/markdown", "application/json", "audio/mpeg", "audio/ogg", "audio/wav",
]);
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
// A capped depth is plenty for "genuine long-running back-and-forth" (the
// human's own bar) while still being a hard, deterministic stop -- not a
// number tuned to feel generous, just large enough that a real working
// exchange never brushes it while an actual loop always hits it fast.
const MAX_AGENT_REPLY_DEPTH = 5;

export const CONVERSATION_MESSAGE_KINDS = ["message", "handoff", "ack", "result", "notice"] as const;
export type ConversationMessageKind = (typeof CONVERSATION_MESSAGE_KINDS)[number];

export function isConversationMessageKind(value: unknown): value is ConversationMessageKind {
  return typeof value === "string" && (CONVERSATION_MESSAGE_KINDS as readonly string[]).includes(value);
}

const CONVERSATION_MESSAGE_OUTCOMES = ["ok", "failed", "incomplete"] as const;

function normalizeOptionalMessageId(value: unknown, field: string, errorCode: "INVALID_PARENT" | "INVALID_RECIPIENT" | "INVALID_RELATED_RUN"): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 256) {
    throw new AgentJoinError(`${field} is invalid.`, errorCode, 400);
  }
  return value.trim();
}

export interface ConversationMessage {
  id: string;
  conversation_id: string;
  sender_connection_id: string | null;
  sender_user_id?: string | null;
  sender_display_name?: string | null;
  recipient_connection_id: string | null;
  kind: ConversationMessageKind;
  body: string;
  /** Only meaningful for kind:"result" -- whether the turn actually
   * succeeded. Null means unknown (legacy rows, or a message kind where the
   * concept doesn't apply) and must render with no outcome tint, never
   * guessed as success. */
  outcome?: "ok" | "failed" | "incomplete" | null;
  created_at: string;
  parent_message_id?: string | null;
  edited_at?: string | null;
  deleted_at?: string | null;
  /** The run this message is *about* (a run-start request, an evidence
   * submission, a permission request), not necessarily one it caused to
   * exist -- see spawned_run_id for that narrower, handoff-specific case.
   * Null means no known run, which must render with no link, never a guess. */
  related_run_id?: string | null;
}

export interface ConversationSummary {
  id: string;
  workspace_id: string;
  topic: string;
  status: "open" | "closed";
  created_at: string;
  participant_connection_ids: string[];
  channel_slug?: string | null;
  channel_kind?: "channel" | "dm";
  /** Bridge-runtime.ts's scanWorkspaceMessages reads this to decide whether a mention in this channel can spawn a dynamic ACP session at all (ensureDynamicSessionForConversation requires it) -- omitting it from the query below meant that check silently always failed. */
  mission_id?: string | null;
  /** Loop-prevention Layer 3 (the human kill switch) AND Layer 2's own
   * durable auto-pause: non-null means agent delivery is paused in this
   * conversation, for either reason. bridge-runtime.ts reads this the same
   * way it reads mission_id, on the same poll cycle. */
  agent_replies_paused_at?: string | null;
  /** Distinguishes the two reasons above -- see agent_replies_paused_at's own comment. */
  agent_replies_paused_reason?: "human" | "loop_detected" | null;
}

function requireService() {
  if (!supabase) {
    throw new AgentJoinError("M9R agent backend is not configured.", "DB_NOT_CONFIGURED", 503);
  }
  return supabase;
}

/**
 * The agent MCP tool writes through the stateless Next.js API route. That
 * route has no WebSocket of its own, so without this server-to-server publish
 * the row is durable but every already-open dashboard waits for its fallback
 * poll to see the reply. Keep the publish additive: the database row remains
 * authoritative, and a relay outage must never turn a successful message
 * write into a failed provider turn.
 *
 * The message id is the UI's deduplication key. Replaying an idempotent HTTP
 * request may publish the same row more than once, but the UI merge collapses
 * that safely and the row is never duplicated.
 */
async function publishAgentWorkspaceMessage(input: { workspaceId: string; conversationId: string; message: Record<string, unknown> }): Promise<void> {
  try {
    await publishInternalRelayFrame({
      workspaceId: input.workspaceId,
      channelId: input.conversationId,
      type: "workspace.event",
      payload: { message: { ...input.message, reactions: [] }, activity: [], cursor: null },
    });
  } catch (error) {
    console.warn(`Live workspace publish failed for conversation ${input.conversationId}; durable message remains available:`, error instanceof Error ? error.message : error);
  }
}

/** Keep the no-consumer diagnostic attached to a durable human post even when
 * the request is an idempotent replay after the original response was lost.
 * Without this shared helper, a crash between the human-message insert and
 * the notice insert left the retry looking successful while the channel still
 * had no explanation for its silence. */
async function ensureAgentAvailabilityNotice(input: { db: ReturnType<typeof requireService>; workspaceId: string; conversationId: string; messageId: string; body: string }): Promise<void> {
  const [{ data: connections, error: connectionsError }, { data: participants, error: participantsError }] = await Promise.all([
    input.db.from("agent_connections")
      .select("id, agent_kind, status, last_seen_at")
      .eq("workspace_id", input.workspaceId)
      .eq("status", "active"),
    input.db.from("conversation_participants")
      .select("connection_id")
      .eq("workspace_id", input.workspaceId)
      .eq("conversation_id", input.conversationId),
  ]);
  const channelMemberIds = new Set((participants ?? []).map((row) => String(row.connection_id)));
  const availabilityRows = (connections ?? []).map((row) => ({
    ...row,
    is_channel_member: channelMemberIds.has(String(row.id)),
  }));
  // Shadow-mode Jev judgment of this same message (off unless M9R_JEV_MODE is set): it only logs how
  // its call compares with the explicit-@mention routing below and changes nothing.
  if (!connectionsError && !participantsError) {
    const nowMs = Date.now();
    scheduleShadowJudgment({
      messageId: input.messageId,
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      source: "http",
      body: input.body,
      agents: availabilityRows
        .filter((row) => row.agent_kind)
        .map((row) => ({
          kind: providerMention(String(row.agent_kind)),
          connected: Number.isFinite(Date.parse(String(row.last_seen_at ?? ""))) && nowMs - Date.parse(String(row.last_seen_at)) <= RECENT_CONNECTION_MAX_AGE_MS,
          isChannelMember: row.is_channel_member,
        })),
      actualMentionedKinds: explicitlyMentionedAgentKinds(input.body, availabilityRows),
    });
  }
  const noticeBody = connectionsError || participantsError
    ? agentAvailabilityUnknownNoticeBody()
    : (() => {
        const unavailable = unavailableExplicitAgentKinds(input.body, availabilityRows);
        return unavailable.length > 0 ? unavailableAgentNoticeBody(unavailable) : null;
      })();
  if (!noticeBody) return;
  const { error: noticeError } = await input.db.from("conversation_messages").insert({
    workspace_id: input.workspaceId,
    conversation_id: input.conversationId,
    sender_user_id: null,
    sender_connection_id: null,
    sender_display_name: "M9R",
    sender_kind: "system",
    recipient_connection_id: null,
    kind: "notice",
    body: noticeBody,
    parent_message_id: input.messageId,
    idempotency_key: `agent-availability:${input.messageId}`,
  });
  if (noticeError && noticeError.code !== "23505") {
    console.warn(`Agent availability notice failed for conversation ${input.conversationId}:`, noticeError.message);
  }
}

/** Same table-not-migrated-yet detection as dispatch-service.ts. */
function isMissingTableError(err: { code?: string | null; message?: string | null } | null): boolean {
  if (!err) return false;
  return err.code === "42P01" || err.code === "PGRST205" || /Could not find the table/i.test(err.message ?? "");
}

function migrationRequiredError(): AgentJoinError {
  return new AgentJoinError(
    "Conversations are not available yet: the database migration adding agent_conversations hasn't been applied.",
    "MIGRATION_REQUIRED",
    503,
  );
}

/** Same "don't accept source code or secret-shaped content" gate as a Dispatch summary. */
function sanitizeBody(raw: string): { ok: true; body: string } | { ok: false; error: string } {
  const body = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!body) return { ok: false, error: "body is required." };
  if (body.length > 2000) return { ok: false, error: "body exceeds 2000 characters." };
  if (containsActiveContent(body)) return { ok: false, error: "Rejected: active script or markup content found in body." };
  if (looksLikeSourceCode(body)) return { ok: false, error: "Rejected: body reads like source code, not a message." };
  for (const [pattern] of SECRET_PATTERNS) {
    if (pattern.test(body)) return { ok: false, error: "Rejected: secret-shaped content found in body." };
    pattern.lastIndex = 0;
  }
  return { ok: true, body };
}

/**
 * Start a conversation among the caller and one or more other connections in
 * the same workspace. The caller is always a participant, even if omitted
 * from participantConnectionIds.
 */
export async function startConversation(
  agent: AuthedAgent,
  input: { topic: string; participantConnectionIds: string[] },
): Promise<ConversationSummary> {
  const db = requireService();
  const topic = (input.topic ?? "").replace(/\s+/g, " ").trim();
  if (!topic) throw new AgentJoinError("topic is required.", "INVALID_TOPIC", 400);
  if (topic.length > 200) throw new AgentJoinError("topic exceeds 200 characters.", "INVALID_TOPIC", 400);

  const participantIds = [...new Set([agent.connectionId, ...input.participantConnectionIds])];
  if (participantIds.length < 2) {
    throw new AgentJoinError("A conversation needs at least one other participant.", "INVALID_PARTICIPANTS", 400);
  }

  const { data: connections, error: connectionsError } = await db
    .from("agent_connections")
    .select("id, status, last_seen_at")
    .eq("workspace_id", agent.workspaceId)
    .in("id", participantIds)
    .eq("status", "active")
    .is("revoked_at", null);
  if (connectionsError) {
    if (isMissingTableError(connectionsError)) throw migrationRequiredError();
    throw new AgentJoinError("Could not verify conversation participants.", "CONVERSATION_START_FAILED", 500);
  }
  const validIds = new Set((connections ?? [])
    .filter((row) => isRecentlySeenConnection({ last_seen_at: row.last_seen_at as string | null }))
    .map((row) => row.id as string));
  const missing = participantIds.filter((id) => !validIds.has(id));
  if (missing.length > 0) {
    throw new AgentJoinError("Every participant must be an active connection in this workspace.", "INVALID_PARTICIPANTS", 400);
  }

  const { data: conversation, error: conversationError } = await db
    .from("agent_conversations")
    .insert({ workspace_id: agent.workspaceId, topic, created_by_connection_id: agent.connectionId })
    .select("id, workspace_id, topic, status, created_at")
    .single();
  if (conversationError || !conversation) {
    if (isMissingTableError(conversationError)) throw migrationRequiredError();
    throw new AgentJoinError("Could not start the conversation.", "CONVERSATION_START_FAILED", 500);
  }

  const { error: participantsError } = await db.from("conversation_participants").insert(
    participantIds.map((connectionId) => ({
      workspace_id: agent.workspaceId,
      conversation_id: conversation.id,
      connection_id: connectionId,
    })),
  );
  if (participantsError) {
    await db.from("agent_conversations")
      .delete()
      .eq("id", conversation.id)
      .eq("workspace_id", agent.workspaceId);
    throw new AgentJoinError("Could not add conversation participants.", "CONVERSATION_START_FAILED", 500);
  }

  return {
    id: conversation.id,
    workspace_id: conversation.workspace_id,
    topic: conversation.topic,
    status: conversation.status,
    created_at: conversation.created_at,
    participant_connection_ids: participantIds,
  };
}

async function requireParticipant(
  db: NonNullable<typeof supabase>,
  agent: AuthedAgent,
  conversationId: string,
): Promise<Set<string>> {
  const { data: conversation, error: conversationError } = await db
    .from("agent_conversations")
    .select("id, status")
    .eq("workspace_id", agent.workspaceId)
    .eq("id", conversationId)
    .maybeSingle();
  if (conversationError) {
    if (isMissingTableError(conversationError)) throw migrationRequiredError();
    throw new AgentJoinError("Could not read the conversation.", "CONVERSATION_READ_FAILED", 500);
  }
  if (!conversation) throw new AgentJoinError("Conversation was not found.", "CONVERSATION_NOT_FOUND", 404);
  if (conversation.status !== "open") {
    throw new AgentJoinError("Conversation is closed and cannot receive new messages.", "CONVERSATION_CLOSED", 409);
  }

  const { data: participants, error } = await db
    .from("conversation_participants")
    .select("connection_id")
    .eq("workspace_id", agent.workspaceId)
    .eq("conversation_id", conversationId);
  if (error) {
    if (isMissingTableError(error)) throw migrationRequiredError();
    throw new AgentJoinError("Could not read conversation participants.", "CONVERSATION_READ_FAILED", 500);
  }
  const ids = new Set((participants ?? []).map((row) => row.connection_id as string));
  if (ids.size === 0) throw new AgentJoinError("Conversation was not found.", "CONVERSATION_NOT_FOUND", 404);
  if (!ids.has(agent.connectionId)) {
    throw new AgentJoinError("You are not a participant in this conversation.", "CONVERSATION_FORBIDDEN", 403);
  }
  return ids;
}

/** Send a message. recipientConnectionId null = broadcast to every participant. */
export async function sendConversationMessage(
  agent: AuthedAgent,
  input: { conversationId: string; recipientConnectionId: string | null; kind: string; body: string; parentMessageId?: string | null; idempotencyKey?: string | null; outcome?: "ok" | "failed" | "incomplete" | null; relatedRunId?: string | null },
): Promise<ConversationMessage> {
  const db = requireService();
  if (!isConversationMessageKind(input.kind)) {
    throw new AgentJoinError(`kind must be one of: ${CONVERSATION_MESSAGE_KINDS.join(", ")}.`, "INVALID_KIND", 400);
  }
  const recipientConnectionId = normalizeOptionalMessageId(input.recipientConnectionId, "recipientConnectionId", "INVALID_RECIPIENT");
  const parentMessageId = normalizeOptionalMessageId(input.parentMessageId, "parentMessageId", "INVALID_PARENT");
  const relatedRunId = normalizeOptionalMessageId(input.relatedRunId, "relatedRunId", "INVALID_RELATED_RUN");
  const sanitized = sanitizeBody(input.body);
  if (!sanitized.ok) throw new AgentJoinError(sanitized.error, "INVALID_BODY", 400);
  sanitized.body = reformatRunOnListReply(sanitized.body);
  if (input.idempotencyKey !== undefined && input.idempotencyKey !== null && typeof input.idempotencyKey !== "string") {
    throw new AgentJoinError("idempotencyKey is invalid.", "INVALID_IDEMPOTENCY_KEY", 400);
  }
  const idempotencyKey = typeof input.idempotencyKey === "string" ? input.idempotencyKey.trim() : "";
  if (idempotencyKey.length > 256) throw new AgentJoinError("idempotencyKey exceeds 256 characters.", "INVALID_IDEMPOTENCY_KEY", 400);
  if (input.outcome !== undefined && input.outcome !== null && !CONVERSATION_MESSAGE_OUTCOMES.includes(input.outcome as typeof CONVERSATION_MESSAGE_OUTCOMES[number])) {
    throw new AgentJoinError(`outcome must be one of: ${CONVERSATION_MESSAGE_OUTCOMES.join(", ")}.`, "INVALID_OUTCOME", 400);
  }
  const normalizedOutcome = input.outcome ?? null;

  const { assertMayPost } = await import("@/lib/moderation-service");
  try {
    await assertMayPost(agent.workspaceId, "connection", agent.connectionId, input.conversationId);
  } catch (error) {
    throw new AgentJoinError(error instanceof Error ? error.message : "This connection may not post here.", "MODERATION_BLOCKED", 403);
  }

  const participantIds = await requireParticipant(db, agent, input.conversationId);
  if (recipientConnectionId && !participantIds.has(recipientConnectionId)) {
    throw new AgentJoinError("recipient is not a participant in this conversation.", "INVALID_RECIPIENT", 400);
  }
  // Anti-loop guard for raw agent-to-agent messaging: this connection's own
  // directed reply chain has no cap anywhere else, so two agents replying to
  // each other indefinitely was previously stopped by nothing at all. Only
  // counts a genuine back-and-forth continuation (this reply directly
  // answers the immediately preceding message, addressed the other way) --
  // a fresh directed message to someone new always starts back at 0, this
  // is depth-of-one-exchange, not a lifetime message count.
  let replyDepth = 0;
  if (parentMessageId) {
    const { data: parent } = await db
      .from("conversation_messages")
      .select("id, sender_connection_id, recipient_connection_id, reply_depth")
      .eq("id", parentMessageId)
      .eq("workspace_id", agent.workspaceId)
      .eq("conversation_id", input.conversationId)
      .maybeSingle();
    if (!parent) throw new AgentJoinError("parent_message_id must reference a message in this conversation.", "INVALID_PARENT", 400);
    const isContinuation = Boolean(
      recipientConnectionId
      && parent.sender_connection_id === recipientConnectionId
      && parent.recipient_connection_id === agent.connectionId,
    );
    if (isContinuation) {
      replyDepth = ((parent.reply_depth as number | null) ?? 0) + 1;
      if (replyDepth > MAX_AGENT_REPLY_DEPTH) {
        throw new AgentJoinError(
          `This directed exchange has gone back and forth ${MAX_AGENT_REPLY_DEPTH} times without resolving -- bring a human in instead of continuing to reply.`,
          "REPLY_DEPTH_EXCEEDED",
          409,
        );
      }
    }
  }

  if (idempotencyKey) {
    const { data: existing, error: existingError } = await db.from("conversation_messages")
      .select("id, conversation_id, sender_connection_id, recipient_connection_id, kind, body, outcome, created_at, parent_message_id, edited_at, deleted_at, related_run_id")
      .eq("workspace_id", agent.workspaceId)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (existingError) {
      if (isMissingColumnError(existingError)) throw new AgentJoinError("Message retry protection is not available until the latest database migration is applied.", "MIGRATION_REQUIRED", 503);
      throw new AgentJoinError("Could not verify whether this message was already sent.", "MESSAGE_READ_FAILED", 500);
    }
    if (existing) {
      if (!idempotencyIdentityMatches(existing as Record<string, unknown>, {
        conversationId: input.conversationId,
        senderConnectionId: agent.connectionId,
        recipientConnectionId,
        kind: input.kind,
        body: sanitized.body,
        parentMessageId,
        outcome: normalizedOutcome,
        relatedRunId,
      })) throw new AgentJoinError("idempotencyKey is already used by another message.", "IDEMPOTENCY_KEY_CONFLICT", 409);
      // A retry may be the first request whose relay publication succeeds
      // (the original writer can lose only the live-ingest response). Replay
      // the durable row into the live room; the UI deduplicates by message id.
      void publishAgentWorkspaceMessage({ workspaceId: agent.workspaceId, conversationId: input.conversationId, message: existing as Record<string, unknown> });
      return existing as ConversationMessage;
    }
  }

  const { data: message, error } = await db
    .from("conversation_messages")
    .insert({
      workspace_id: agent.workspaceId,
      conversation_id: input.conversationId,
      sender_connection_id: agent.connectionId,
      recipient_connection_id: recipientConnectionId,
      kind: input.kind,
      body: sanitized.body,
      parent_message_id: parentMessageId,
      idempotency_key: idempotencyKey || null,
      outcome: normalizedOutcome,
      related_run_id: relatedRunId,
      reply_depth: replyDepth,
      sender_kind: "connection",
    })
    .select("id, conversation_id, sender_connection_id, recipient_connection_id, kind, body, outcome, created_at, parent_message_id, edited_at, deleted_at, related_run_id")
    .single();
  if (error || !message) {
    if (idempotencyKey && error?.code === "23505") {
      const { data: existing } = await db.from("conversation_messages")
        .select("id, conversation_id, sender_connection_id, recipient_connection_id, kind, body, outcome, created_at, parent_message_id, edited_at, deleted_at, related_run_id")
        .eq("workspace_id", agent.workspaceId)
        .eq("idempotency_key", idempotencyKey)
        .maybeSingle();
      if (existing && idempotencyIdentityMatches(existing as Record<string, unknown>, {
        conversationId: input.conversationId,
        senderConnectionId: agent.connectionId,
        recipientConnectionId,
        kind: input.kind,
        body: sanitized.body,
        parentMessageId,
        outcome: normalizedOutcome,
        relatedRunId,
      })) {
        void publishAgentWorkspaceMessage({ workspaceId: agent.workspaceId, conversationId: input.conversationId, message: existing as Record<string, unknown> });
        return existing as ConversationMessage;
      }
      if (existing) throw new AgentJoinError("idempotencyKey is already used by another message.", "IDEMPOTENCY_KEY_CONFLICT", 409);
    }
    throw new AgentJoinError("Could not send the message.", "MESSAGE_SEND_FAILED", 500);
  }
  // Persist first, then fan the same durable row out to already-open browser
  // rooms. This is intentionally fire-and-forget: the API response must not
  // become slow or fail merely because the optional live relay is restarting;
  // the bridge/browser polling paths still recover the database row.
  void publishAgentWorkspaceMessage({ workspaceId: agent.workspaceId, conversationId: input.conversationId, message: message as Record<string, unknown> });
  await createAgentActivityNotification(db, {
    workspaceId: agent.workspaceId,
    conversationId: input.conversationId,
    messageId: message.id as string,
    body: sanitized.body,
    kind: input.kind as ConversationMessageKind,
  }).catch((notificationError) => {
    // The conversation row is already the durable source of truth. A
    // notification projection outage must not turn a successfully posted
    // agent message into a 500, which prompts the provider to retry and can
    // make a live reply appear lost or duplicated.
    console.warn(`Agent activity notification failed for conversation ${input.conversationId}:`, notificationError instanceof Error ? notificationError.message : notificationError);
  });
  await bindAgentReplyToMission({ agent, conversationId: input.conversationId, body: sanitized.body }).catch((bindError) => {
    console.warn(`Agent reply Mission binding failed for conversation ${input.conversationId}:`, bindError instanceof Error ? bindError.message : bindError);
  });
  return message as ConversationMessage;
}

/**
 * Symmetric counterpart to bindChannelMessageToMission: the ACP bridge's
 * reply (services/mission-bridge posts it here via
 * /api/agent/conversations/[id]/messages) is mirrored into the same Mission,
 * as the agent participant, broadcast to the channel — mirroring Buzz posting
 * the agent's ACP response back as a relay event. A channel with no bound
 * Mission (never messaged with a mention) is a silent no-op, same refusal
 * discipline as the human-side path.
 */
async function bindAgentReplyToMission(input: { agent: AuthedAgent; conversationId: string; body: string }): Promise<void> {
  const db = requireService();
  const { data: conversation } = await db.from("agent_conversations").select("mission_id").eq("id", input.conversationId).maybeSingle();
  const missionId = conversation?.mission_id as string | null | undefined;
  if (!missionId) return;

  const principal = {
    actor: { kind: "agent" as const, id: input.agent.connectionId },
    workspaceId: input.agent.workspaceId,
    kind: "agent" as const,
    userId: null,
    agent: input.agent,
  };
  await postMissionMessage(principal, missionId, {
    senderParticipantId: missionAgentParticipantId(missionId, input.agent.connectionId),
    messageType: "information",
    recipientParticipantIds: MISSION_BROADCAST_CHANNEL,
    body: input.body,
    clientRequestId: `channel-binding:${input.conversationId}:agent-reply:${input.agent.connectionId}:${Date.now()}`,
  });
}

/**
 * Messages visible to this agent: broadcasts, messages directed at them, and
 * their own sent messages -- never another participant's private DM to a
 * third party. Optional sinceCursor supports replay-safe polling.
 */
export async function listConversationMessagesForAgent(
  agent: AuthedAgent,
  input: { conversationId: string; sinceCursor?: string | null },
): Promise<ConversationMessage[]> {
  const db = requireService();
  await requireParticipant(db, agent, input.conversationId);

  let query = db
    .from("conversation_messages")
    .select("id, conversation_id, sender_connection_id, sender_user_id, sender_display_name, recipient_connection_id, kind, body, outcome, created_at, parent_message_id, edited_at, deleted_at")
    .eq("workspace_id", agent.workspaceId)
    .eq("conversation_id", input.conversationId)
    .or(`recipient_connection_id.is.null,recipient_connection_id.eq.${agent.connectionId},sender_connection_id.eq.${agent.connectionId}`)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(200);
  const cursor = decodeWorkspaceCursor(input.sinceCursor);
  if (input.sinceCursor && !cursor) throw new AgentJoinError("The conversation cursor is invalid.", "INVALID_CURSOR", 400);
  if (cursor?.messageId) {
    query = query.or(`created_at.gt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.gt.${cursor.messageId})`);
  } else if (cursor) {
    query = query.gte("created_at", cursor.createdAt);
  }

  const { data, error } = await query;
  if (error) {
    if (isMissingTableError(error)) throw migrationRequiredError();
    throw new AgentJoinError("Could not list conversation messages.", "CONVERSATION_READ_FAILED", 500);
  }
  return (data ?? []) as ConversationMessage[];
}

/**
 * Open conversations this agent participates in, for the Agent Inbox check
 * every connected agent already performs at its own logical checkpoints --
 * the same real mechanism, now carrying peer messages, not only human
 * instructions.
 */
/**
 * The agent-facing checklist write.
 *
 * Two independent guards, neither taken from the request body: the caller
 * must be a participant in the conversation, and the message must actually
 * live in that conversation. The checklist row itself is then keyed by the
 * AUTHENTICATED connection id, so an agent writes only ever into its own
 * (message, connection) slot -- one agent structurally cannot overwrite
 * another agent's checklist, even on the same anchor message.
 *
 * Deliberately NOT restricted to messages the agent sent: a live checklist
 * is reported *during* a turn, and the agent's own reply message does not
 * exist until that turn ends. The anchor is the triggering message, exactly
 * as workspace.step and workspace.turn already anchor to it.
 */
export async function setMessageTodosForAgent(
  agent: AuthedAgent,
  input: { conversationId: string; messageId: string; entries: unknown },
): Promise<MessageTodoState> {
  const db = requireService();
  await requireParticipant(db, agent, input.conversationId);
  const entries = normalizeMessageTodoEntries(input.entries);
  if (entries.length === 0) throw new AgentJoinError("entries must contain at least one usable checklist entry.", "INVALID_TODO_ENTRIES", 400);

  const { data: message, error } = await db
    .from("conversation_messages")
    .select("id")
    .eq("id", input.messageId)
    .eq("workspace_id", agent.workspaceId)
    .eq("conversation_id", input.conversationId)
    .maybeSingle();
  if (error) {
    if (isMissingTableError(error)) throw migrationRequiredError();
    throw new AgentJoinError("Could not load the message.", "CONVERSATION_READ_FAILED", 500);
  }
  if (!message) throw new AgentJoinError("messageId must reference a message in this conversation.", "INVALID_MESSAGE", 404);

  try {
    return await upsertMessageTodos({
      workspaceId: agent.workspaceId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      connectionId: agent.connectionId,
      entries,
    });
  } catch (todoError) {
    // upsertMessageTodos re-wraps the PostgREST error as a plain Error, so
    // the missing-table case is only recognizable from its text here.
    if (isMissingTableError({ message: todoError instanceof Error ? todoError.message : null })) throw migrationRequiredError();
    throw new AgentJoinError("Could not store the message checklist.", "TODO_WRITE_FAILED", 500);
  }
}

/**
 * #13 shared co-drafting, agent side: write one named section of a shared
 * document. Same participant guard as every other agent write here --
 * the actual find-or-create-draft / upsert-section logic lives in
 * conversation-draft-service.ts, this just establishes who is allowed to
 * call it and stamps the write with the authenticated connection id (an
 * agent can never write a section under another agent's name).
 */
export async function writeDraftSectionForAgent(
  agent: AuthedAgent,
  input: { conversationId: string; draftTitle: string; heading: string; body: string },
): Promise<Draft> {
  const db = requireService();
  await requireParticipant(db, agent, input.conversationId);
  try {
    return await upsertDraftSection({
      workspaceId: agent.workspaceId,
      conversationId: input.conversationId,
      draftTitle: input.draftTitle,
      heading: input.heading,
      body: input.body,
      author: { kind: "agent", connectionId: agent.connectionId },
    });
  } catch (draftError) {
    if (isMissingTableError({ message: draftError instanceof Error ? draftError.message : null })) throw migrationRequiredError();
    throw new AgentJoinError(draftError instanceof Error ? draftError.message : "Could not write the draft section.", "DRAFT_WRITE_FAILED", 400);
  }
}

/** #13 read side, shared by the agent-facing GET and the dashboard panel. */
export async function listDraftsForAgent(agent: AuthedAgent, conversationId: string): Promise<Draft[]> {
  const db = requireService();
  await requireParticipant(db, agent, conversationId);
  return listDraftsForConversation(agent.workspaceId, conversationId);
}

export async function listOpenConversationsForAgent(agent: AuthedAgent): Promise<ConversationSummary[]> {
  const db = requireService();
  const { data: memberships, error: membershipError } = await db
    .from("conversation_participants")
    .select("conversation_id")
    .eq("workspace_id", agent.workspaceId)
    .eq("connection_id", agent.connectionId);
  if (membershipError) {
    if (isMissingTableError(membershipError)) return [];
    throw new AgentJoinError("Could not list conversations.", "CONVERSATION_READ_FAILED", 500);
  }
  const conversationIds = [...new Set((memberships ?? []).map((row) => row.conversation_id as string))];
  if (conversationIds.length === 0) return [];

  const { data: conversations, error: conversationsError } = await db
    .from("agent_conversations")
    .select("id, workspace_id, topic, status, created_at, mission_id, agent_replies_paused_at, agent_replies_paused_reason, channel_kind")
    .eq("workspace_id", agent.workspaceId)
    .in("id", conversationIds)
    .eq("status", "open")
    .order("created_at", { ascending: false });
  if (conversationsError) throw new AgentJoinError("Could not list conversations.", "CONVERSATION_READ_FAILED", 500);

  const { data: allParticipants, error: allParticipantsError } = await db
    .from("conversation_participants")
    .select("conversation_id, connection_id")
    .eq("workspace_id", agent.workspaceId)
    .in("conversation_id", conversationIds);
  if (allParticipantsError) throw new AgentJoinError("Could not list conversations.", "CONVERSATION_READ_FAILED", 500);

  const participantsByConversation = new Map<string, string[]>();
  for (const row of allParticipants ?? []) {
    const list = participantsByConversation.get(row.conversation_id as string) ?? [];
    list.push(row.connection_id as string);
    participantsByConversation.set(row.conversation_id as string, list);
  }

  return (conversations ?? []).map((conversation) => ({
    id: conversation.id,
    workspace_id: conversation.workspace_id,
    topic: conversation.topic,
    status: conversation.status,
    created_at: conversation.created_at,
    participant_connection_ids: participantsByConversation.get(conversation.id) ?? [],
    mission_id: (conversation as { mission_id?: string | null }).mission_id ?? null,
    agent_replies_paused_at: (conversation as { agent_replies_paused_at?: string | null }).agent_replies_paused_at ?? null,
    agent_replies_paused_reason: (conversation as { agent_replies_paused_reason?: "human" | "loop_detected" | null }).agent_replies_paused_reason ?? null,
    channel_kind: (conversation as { channel_kind?: "channel" | "dm" }).channel_kind ?? undefined,
  }));
}

export interface SpawnedHandoffRun {
  conversation_id: string;
  message_id: string;
  run_id: string;
  task_title: string;
}

/**
 * The auto-start half of a handoff: at the same Agent Inbox checkpoint that
 * already surfaces open conversations, look for handoff-kind messages
 * addressed to this connection in an open conversation that haven't spawned
 * a run yet, and start one on THIS agent's own connection for each -- same
 * mechanism as `m9r run start`, just triggered by a peer instead of a
 * human. spawned_run_id is set immediately after each insert so re-polling
 * the inbox never double-starts the same handoff.
 *
 * Best-effort by design (mirrors recordRunEvent): a run-start failure or a
 * pre-migration database logs and is skipped rather than failing the whole
 * inbox check, since human instructions must still come through either way.
 */
export async function consumeHandoffsForAgent(agent: AuthedAgent): Promise<SpawnedHandoffRun[]> {
  const db = requireService();
  const { data: pending, error } = await db
    .from("conversation_messages")
    .select("id, conversation_id, body")
    .eq("workspace_id", agent.workspaceId)
    .eq("recipient_connection_id", agent.connectionId)
    .eq("kind", "handoff")
    .is("spawned_run_id", null)
    .order("created_at", { ascending: true })
    .limit(20);

  if (error) {
    if (isMissingTableError(error) || isMissingColumnError(error)) return [];
    console.error("consumeHandoffsForAgent list failed:", error.message, error.code);
    return [];
  }
  const candidates = (pending ?? []) as Array<{ id: string; conversation_id: string; body: string }>;
  if (candidates.length === 0) return [];

  // Only act on still-open conversations -- a closed conversation's unread
  // handoffs stay as history, not a run trigger.
  const conversationIds = [...new Set(candidates.map((row) => row.conversation_id))];
  const { data: openConversations } = await db
    .from("agent_conversations")
    .select("id")
    .eq("workspace_id", agent.workspaceId)
    .eq("status", "open")
    .in("id", conversationIds);
  const openIds = new Set((openConversations ?? []).map((row) => row.id as string));

  const spawned: SpawnedHandoffRun[] = [];
  for (const row of candidates.filter((row) => openIds.has(row.conversation_id))) {
    try {
      const run = await startAgentRunFromHandoff(agent, { messageId: row.id, taskTitle: row.body, runMode: "coordinated" });
      if (!run) continue;
      spawned.push({ conversation_id: row.conversation_id, message_id: row.id, run_id: run.run_id, task_title: row.body });
    } catch (err) {
      console.error("consumeHandoffsForAgent run-start failed:", err instanceof Error ? err.message : err);
    }
  }
  return spawned;
}

export interface DashboardReaction {
  id: string;
  message_id: string;
  emoji: string;
  actor_user_id: string | null;
  actor_connection_id: string | null;
}

export interface DashboardConversationMessage {
  id: string;
  sender_connection_id: string | null;
  sender_user_id: string | null;
  sender_display_name: string | null;
  recipient_connection_id: string | null;
  kind: ConversationMessageKind;
  body: string;
  /** Only meaningful for kind:"result". Null means unknown and must render
   * with no outcome tint -- never guessed as success. */
  outcome?: "ok" | "failed" | "incomplete" | null;
  created_at: string;
  spawned_run_id: string | null;
  parent_message_id: string | null;
  edited_at: string | null;
  deleted_at: string | null;
  reactions: DashboardReaction[];
  attachments: DashboardAttachment[];
  /** The agent's live checklist for this message (ACP `plan` entries),
   * rendered inline in the bubble. Null when the message has none -- most
   * messages never will. Live updates arrive separately as `workspace.todos`
   * relay frames; this is the last known state a reload reads back. One
   * entry per reporting agent -- two agents can work the same anchor
   * message at once, so the checklist is theirs, not the message's. */
  todos: MessageTodoState[];
}

export interface DashboardAttachment {
  id: string;
  name: string;
  mediaType: string;
  sizeBytes: number;
  url: string;
}

export interface DashboardConversation {
  id: string;
  topic: string;
  channel_slug: string | null;
  channel_kind: "channel" | "dm";
  description: string | null;
  is_private: boolean;
  status: "open" | "closed";
  created_at: string;
  participant_connection_ids: string[];
  messages: DashboardConversationMessage[];
  unread_count: number;
  mission_id: string | null;
  /** Loop-prevention Layer 3: non-null means a human has paused agent
   * delivery in this conversation. See the matching field on
   * ConversationSummary (the agent-facing read path). */
  agent_replies_paused_at: string | null;
}

interface DashboardUserContext {
  auth: NonNullable<Awaited<ReturnType<typeof createClient>>>;
  user: { id: string; email?: string | null; user_metadata?: Record<string, unknown> };
  workspaceId: string;
}

async function dashboardUserContext(): Promise<DashboardUserContext> {
  const auth = await createClient();
  if (!auth) throw new AgentJoinError("Authentication is unavailable.", "DB_NOT_CONFIGURED", 503);
  const { data: { user } } = await auth.auth.getUser();
  if (!user) throw new AgentJoinError("Sign in to use workspace chat.", "UNAUTHENTICATED", 401);
  const workspaceId = await resolveActiveOrDefaultProjectId(auth, {
    id: user.id,
    email: user.email,
    name: (user.user_metadata?.name as string | undefined) ?? null,
  });
  if (!workspaceId) throw new AgentJoinError("No workspace is available for this account.", "WORKSPACE_NOT_FOUND", 404);
  return { auth, user, workspaceId };
}

async function ownedConversation(context: DashboardUserContext, conversationId: string) {
  const { data: conversation } = await context.auth
    .from("agent_conversations")
    .select("id, workspace_id, topic, channel_slug, channel_kind, description, is_private, status, repository, repository_id, mission_id")
    .eq("id", conversationId)
    .eq("workspace_id", context.workspaceId)
    .maybeSingle();
  if (!conversation) throw new AgentJoinError("Conversation was not found.", "CONVERSATION_NOT_FOUND", 404);
  return conversation as {
    id: string; workspace_id: string; topic: string; channel_slug: string | null;
    channel_kind: "channel" | "dm"; description: string | null; is_private: boolean; status: "open" | "closed";
    repository: string | null; repository_id: string | null; mission_id: string | null;
  };
}

function channelSlug(raw: string): string {
  return raw.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

function displayNameForUser(user: DashboardUserContext["user"]): string {
  const metadata = user.user_metadata ?? {};
  return (typeof metadata.username === "string" ? metadata.username : null)
    || (typeof metadata.name === "string" ? metadata.name : null)
    || user.email?.split("@")[0]
    || "You";
}

export function agentMentionNames(agentKind: string): string[] {
  const normalized = agentKind.toLowerCase().trim();
  return [normalized, normalized.replace(/-/g, " "), normalized.replace(/[^a-z0-9]/g, "")];
}

/**
 * Match a real mention token, not a substring such as "@code" in prose. An
 * explicit "@name" always counts; a bare "name" also counts as long as it
 * isn't glued to other word characters -- "just say the agent's name" was a
 * real, deliberate product decision, not an oversight, so this stays
 * consistent with the bridge's own routing gate (bridge-runtime.ts's
 * agentMentionsSession / ensureDynamicSessionForConversation), which already
 * matches bare names the same way.
 */
export function containsAgentMention(body: string, name: string): boolean {
  const escaped = name.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) return false;
  return new RegExp(`(?:^|[^a-z0-9_-])@?${escaped}(?=$|[^a-z0-9_-])`, "i").test(body);
}

async function createAgentActivityNotification(db: NonNullable<typeof supabase>, input: { workspaceId: string; conversationId: string; messageId: string; body: string; kind: ConversationMessageKind }) {
  const { data: workspace } = await db.from("projects").select("owner_id").eq("id", input.workspaceId).maybeSingle();
  if (!workspace?.owner_id) return;
  await db.from("workspace_notifications").upsert({
    workspace_id: input.workspaceId,
    recipient_user_id: workspace.owner_id,
    conversation_id: input.conversationId,
    message_id: input.messageId,
    kind: input.kind === "result" || input.kind === "handoff" ? "agent_activity" : "reply",
    title: input.kind === "result" ? "Agent posted a result" : "New agent activity",
    body: input.body.slice(0, 2048),
    payload: { conversationId: input.conversationId },
  }, { onConflict: "recipient_user_id,message_id,kind", ignoreDuplicates: true });
}

/**
 * A channel only gets a shared Mission report (mission-channel-binding.ts)
 * once it has a `repository` bound -- and until this, nothing in the app
 * ever set one, so every channel stayed permanently unbound and that whole
 * system silently never fired. Derives the channel's repository from the
 * one place a repo is already known: connected agents self-report it as
 * `repo_hint` when they connect. Only commits to a value when every
 * candidate connection agrees on the same repo -- if a workspace's agents
 * are split across different repos, guessing wrong would silently attach
 * work to the wrong codebase, which is exactly what this system already
 * refuses to do elsewhere (see mission-channel-binding.ts's own comment).
 */
async function resolveChannelRepositoryHint(
  db: ReturnType<typeof requireService>,
  workspaceId: string,
  connectionIds: string[],
): Promise<string | null> {
  const query = db.from("agent_connections").select("repo_hint").eq("workspace_id", workspaceId).eq("status", "active");
  const { data } = connectionIds.length > 0 ? await query.in("id", connectionIds) : await query;
  const hints = new Set((data ?? []).map((row) => (row.repo_hint as string | null)?.trim()).filter((hint): hint is string => Boolean(hint)));
  return hints.size === 1 ? [...hints][0] : null;
}

// A-3: this does up to a dozen+ Supabase round trips (select/insert/update
// per default channel, plus archival and repo-hint resolution) and was
// running on every single dashboard load AND every 2s liveness
// router.refresh() while any run/decision is live -- forever, for a
// workspace whose channels are already correctly set up 99.9% of the time.
// Keyed on workspaceId + the exact connected-connection-id set (not just
// workspaceId) so a genuinely new agent connection still busts the cache
// and runs the real backfill immediately -- only a REPEATED call with the
// same inputs short-circuits. TTL, not a permanent skip: a warm serverless
// instance can go stale (a channel manually archived elsewhere), so this
// bounds the waste without silently freezing self-healing forever.
const ENSURE_CHANNELS_CACHE_TTL_MS = 30_000;
const ensureChannelsCache = new Map<string, number>();

/** Ensure every connected workspace has a real #general room without requiring a Mission. */
export async function ensureWorkspaceChannelsForDashboard(workspaceId: string, userId: string, connectionIds: string[]): Promise<void> {
  const cacheKey = `${workspaceId}:${[...connectionIds].sort().join(",")}`;
  const now = Date.now();
  const lastRunAt = ensureChannelsCache.get(cacheKey);
  if (lastRunAt !== undefined && now - lastRunAt < ENSURE_CHANNELS_CACHE_TTL_MS) return;
  ensureChannelsCache.set(cacheKey, now);
  // Opportunistic prune, not a timer: a warm instance that sees a changing
  // connection set over hours would otherwise accumulate one stale entry
  // per distinct combination forever.
  if (ensureChannelsCache.size > 200) {
    for (const [key, at] of ensureChannelsCache) if (now - at >= ENSURE_CHANNELS_CACHE_TTL_MS) ensureChannelsCache.delete(key);
  }
  const db = requireService();
  await archiveStaleDiagnosticConversations(db, workspaceId);
  const repository = await resolveChannelRepositoryHint(db, workspaceId, connectionIds);
  const defaults = [
    { slug: "general", topic: "General", description: "A shared room for the workspace." },
    { slug: "agents", topic: "Agents", description: "Talk to connected agents and route work." },
    { slug: "activity", topic: "Activity", description: "Live file, command, test, review, and approval activity." },
  ];
  for (const channel of defaults) {
    const { data: existing, error: existingError } = await db.from("agent_conversations")
      .select("id, status").eq("workspace_id", workspaceId).eq("channel_slug", channel.slug).maybeSingle();
    if (existingError) continue;
    let conversationId = existing?.id as string | undefined;
    if (!conversationId) {
      const { data: created } = await db.from("agent_conversations").insert({
        workspace_id: workspaceId, topic: channel.topic, channel_slug: channel.slug, channel_kind: "channel", description: channel.description, created_by_user_id: userId, repository,
      }).select("id").single();
      conversationId = created?.id as string | undefined;
    } else {
      // Core rooms are durable workspace primitives. A previous manual
      // archive must never make a built-in disappear on the next load.
      if (existing?.status !== "open") {
        await db.from("agent_conversations").update({ status: "open", archived_at: null }).eq("id", conversationId).eq("workspace_id", workspaceId);
      }
      if (repository) {
        // Self-healing backfill: this function runs on every dashboard load,
        // so a channel created before a repository could be resolved (or
        // before this existed at all) picks one up the next time its agents'
        // repo agrees, instead of staying permanently unbound.
        await db.from("agent_conversations").update({ repository }).eq("id", conversationId).is("repository", null);
      }
    }
    if (!conversationId) continue;
    const { data: members } = await db.from("conversation_participants").select("connection_id").eq("conversation_id", conversationId).eq("workspace_id", workspaceId);
    const known = new Set((members ?? []).map((row) => row.connection_id as string));
    const missing = [...new Set(connectionIds)].filter((connectionId) => !known.has(connectionId));
    if (missing.length > 0) await db.from("conversation_participants").insert(missing.map((connectionId) => ({ workspace_id: workspaceId, conversation_id: conversationId, connection_id: connectionId })));
  }
}

/**
 * Test and routing conversations are intentionally retained for audit, but
 * they should not stay in the active workspace list forever.  We only touch
 * un-slugged agent-created records whose topic matches the explicit diagnostic
 * prefixes and whose last message (or creation) is older than one day.  This
 * leaves real human-created channels and active handoffs untouched, while
 * using the existing reversible `status`/`archived_at` lifecycle.
 */
async function archiveStaleDiagnosticConversations(
  db: ReturnType<typeof requireService>,
  workspaceId: string,
): Promise<void> {
  const { data: candidates, error } = await db.from("agent_conversations")
    .select("id, topic, channel_slug, channel_kind, mission_id, created_at")
    .eq("workspace_id", workspaceId)
    .eq("status", "open")
    .is("channel_slug", null)
    .eq("channel_kind", "channel")
    .is("mission_id", null);
  if (error || !candidates || candidates.length === 0) return;

  const diagnosticCandidates = candidates.filter((conversation) => isDiagnosticConversation({
    channelSlug: conversation.channel_slug as string | null,
    channelKind: conversation.channel_kind as "channel" | "dm",
    topic: conversation.topic as string,
  }));
  if (diagnosticCandidates.length === 0) return;

  const ids = diagnosticCandidates.map((conversation) => conversation.id as string);
  const { data: messages } = await db.from("conversation_messages")
    .select("conversation_id, created_at")
    .in("conversation_id", ids)
    .order("created_at", { ascending: false })
    .limit(10_000);
  const lastActivityByConversation = new Map<string, number>();
  for (const message of messages ?? []) {
    const timestamp = Date.parse(String(message.created_at));
    if (!Number.isFinite(timestamp)) continue;
    const id = String(message.conversation_id);
    if (!lastActivityByConversation.has(id)) lastActivityByConversation.set(id, timestamp);
  }

  const cutoff = Date.now() - DIAGNOSTIC_INACTIVITY_MS;
  const staleIds = diagnosticCandidates.filter((conversation) => {
    const createdAt = Date.parse(String(conversation.created_at));
    const lastActivity = lastActivityByConversation.get(String(conversation.id)) ?? createdAt;
    return Number.isFinite(lastActivity) && lastActivity < cutoff;
  }).map((conversation) => String(conversation.id));
  if (staleIds.length === 0) return;
  await db.from("agent_conversations")
    .update({ status: "closed", archived_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .in("id", staleIds)
    .eq("status", "open");
}

export async function createDashboardChannel(input: {
  name: string;
  /** Optional -- a channel is a fast, low-friction action, not a form. When
   * given, still shown everywhere a channel's purpose is displayed. */
  description?: string | null;
  isPrivate?: boolean;
  participantConnectionIds?: string[];
  humanUserIds?: string[];
}): Promise<DashboardConversation> {
  const context = await dashboardUserContext();
  const topic = input.name.replace(/\s+/g, " ").trim();
  const slug = channelSlug(topic);
  if (!slug || topic.length > 80) throw new AgentJoinError("Channel name is invalid.", "INVALID_CHANNEL", 400);
  const purpose = input.description?.replace(/\s+/g, " ").trim().slice(0, 240) || null;
  const db = requireService();
  const repository = await resolveChannelRepositoryHint(db, context.workspaceId, input.participantConnectionIds ?? []);
  const { data: created, error } = await db.from("agent_conversations").insert({
    workspace_id: context.workspaceId, topic, channel_slug: slug, channel_kind: "channel",
    description: purpose,
    is_private: input.isPrivate === true, created_by_user_id: context.user.id, repository,
    human_membership_managed: true,
  }).select("id").single();
  if (error || !created) throw new AgentJoinError("A channel with that name may already exist.", "CHANNEL_CREATE_FAILED", 409);

  const { data: connections } = await db.from("agent_connections").select("id, last_seen_at").eq("workspace_id", context.workspaceId).eq("status", "active");
  const activeIds = new Set((connections ?? [])
    .filter((row) => isRecentlySeenConnection({ last_seen_at: row.last_seen_at as string | null }))
    .map((row) => row.id as string));
  // An explicit agent list (from the create-channel picker) is always
  // respected, whether or not the channel is private -- previously it was
  // silently ignored for a public channel, which meant "which agents can
  // act here" had no real effect unless the human also made the channel
  // private. Omitting the field entirely (no picker used) keeps the old
  // default of every currently active agent.
  const requestedIds = input.participantConnectionIds !== undefined
    ? [...new Set(input.participantConnectionIds)]
    : [...activeIds];
  const unavailableRequestedIds = requestedIds.filter((id) => !activeIds.has(id));
  if (unavailableRequestedIds.length > 0) {
    await db.from("agent_conversations").delete().eq("id", created.id).eq("workspace_id", context.workspaceId);
    throw new AgentJoinError("Every selected agent must be currently connected in this workspace.", "INVALID_CHANNEL_MEMBERS", 400);
  }
  if (input.isPrivate && requestedIds.length === 0) {
    await db.from("agent_conversations").delete().eq("id", created.id).eq("workspace_id", context.workspaceId);
    throw new AgentJoinError("A private channel needs at least one connected agent.", "INVALID_CHANNEL_MEMBERS", 400);
  }
  if (requestedIds.length > 0) {
    const { error: participantError } = await db.from("conversation_participants").insert(requestedIds.map((connectionId) => ({ workspace_id: context.workspaceId, conversation_id: created.id, connection_id: connectionId })));
    if (participantError) {
      await db.from("agent_conversations").delete().eq("id", created.id).eq("workspace_id", context.workspaceId);
      throw new AgentJoinError("Channel participants could not be saved; the channel was not created.", "CHANNEL_CREATE_FAILED", 500);
    }
  }

  // Human roster: the creator is always included, plus anyone else explicitly
  // picked -- validated against this workspace's own membership so a human
  // can't be added to a channel they have no access to the workspace at all.
  const requestedHumanIds = new Set(input.humanUserIds ?? []);
  requestedHumanIds.add(context.user.id);
  const { data: validMembers } = await db.from("workspace_members").select("user_id").eq("workspace_id", context.workspaceId).in("user_id", [...requestedHumanIds]);
  const humanIds = new Set((validMembers ?? []).map((row) => row.user_id as string));
  humanIds.add(context.user.id);
  const { error: humanMemberError } = await db.from("conversation_human_members").insert(
    [...humanIds].map((userId) => ({ workspace_id: context.workspaceId, conversation_id: created.id, user_id: userId })),
  );
  if (humanMemberError) {
    await db.from("agent_conversations").delete().eq("id", created.id).eq("workspace_id", context.workspaceId);
    throw new AgentJoinError("Channel members could not be saved; the channel was not created.", "CHANNEL_CREATE_FAILED", 500);
  }

  const conversations = await listConversationsForDashboard();
  const result = conversations.find((conversation) => conversation.id === created.id);
  if (!result) throw new AgentJoinError("Channel was created but could not be loaded.", "CHANNEL_READ_FAILED", 500);
  return result;
}

/** A non-owner human leaves a channel they're a member of. Core channels
 * (#general and the like) can't be left, same rule as "can't archive a core
 * channel" just above -- the workspace's baseline shared room always exists
 * for every member. */
export async function leaveDashboardConversation(conversationId: string): Promise<void> {
  const context = await dashboardUserContext();
  const conversation = await ownedConversation(context, conversationId);
  if (channelGroupForConversation({ channelSlug: conversation.channel_slug, channelKind: conversation.channel_kind, topic: conversation.topic }) === "core") {
    throw new AgentJoinError("This channel can't be left -- it's part of every workspace member's baseline access.", "CORE_CHANNEL_LEAVE_FORBIDDEN", 400);
  }
  const db = requireService();

  // A channel whose human_membership_managed flag is still false (created
  // before this existed) is visible to every workspace member -- deleting
  // just this user's row would leave the roster at zero either way, and
  // zero rows means nothing without the flag (see
  // listConversationsForDashboard's own comment on why row count alone was
  // a real bug here). Seeding the full current roster (everyone but the
  // leaver) and setting the flag turns this into a real, explicit
  // membership list going forward, in the same write.
  const { data: managedRow } = await db.from("agent_conversations").select("human_membership_managed").eq("id", conversationId).eq("workspace_id", context.workspaceId).maybeSingle();
  if (!managedRow?.human_membership_managed) {
    const { data: allMembers } = await db.from("workspace_members").select("user_id").eq("workspace_id", context.workspaceId);
    const seedIds = (allMembers ?? []).map((row) => row.user_id as string).filter((userId) => userId !== context.user.id);
    if (seedIds.length > 0) {
      await db.from("conversation_human_members").insert(
        seedIds.map((userId) => ({ workspace_id: context.workspaceId, conversation_id: conversationId, user_id: userId })),
      );
    }
    await db.from("agent_conversations").update({ human_membership_managed: true }).eq("id", conversationId).eq("workspace_id", context.workspaceId);
    return;
  }

  const { error } = await db.from("conversation_human_members").delete()
    .eq("workspace_id", context.workspaceId).eq("conversation_id", conversationId).eq("user_id", context.user.id);
  if (error) throw new AgentJoinError("Could not leave the channel.", "CHANNEL_LEAVE_FAILED", 500);
}

/**
 * #19 session-sharing: the roster a channel's "Add people" UI reads --
 * every workspace member, each flagged with whether they're already in
 * this specific channel. Same grandfather rule as listConversationsForDashboard:
 * a channel that has never had its human_membership_managed flag set reads
 * as "everyone already in it" (matching the visibility it actually has),
 * not "nobody in it."
 */
export async function listConversationHumanRoster(conversationId: string): Promise<Array<{ userId: string; email: string | null; name: string | null; role: WorkspaceRole; inChannel: boolean }>> {
  const context = await dashboardUserContext();
  await ownedConversation(context, conversationId);
  const db = requireService();

  const { data: allMembers, error: membersError } = await db
    .from("workspace_members")
    .select("user_id, role")
    .eq("workspace_id", context.workspaceId);
  if (membersError) throw new AgentJoinError("Could not read workspace members.", "MEMBERS_READ_FAILED", 500);

  const { data: managedRow } = await db.from("agent_conversations").select("human_membership_managed").eq("id", conversationId).eq("workspace_id", context.workspaceId).maybeSingle();
  const managed = Boolean(managedRow?.human_membership_managed);

  const { data: humanRows, error: humanError } = await db.from("conversation_human_members")
    .select("user_id").eq("workspace_id", context.workspaceId).eq("conversation_id", conversationId);
  if (humanError) throw new AgentJoinError("Could not read channel members.", "MEMBERS_READ_FAILED", 500);
  const inChannelIds = new Set((humanRows ?? []).map((row) => row.user_id as string));

  const rows = allMembers ?? [];
  // Same table/columns the per-owner agent-identity resolution already uses
  // (src/app/dashboard/agents/page.tsx) -- a real "name" column, falling back
  // to the email's local part only when no name was ever set, never the raw
  // email as the primary display string.
  const userIds = rows.map((row) => row.user_id as string);
  const nameByUserId = new Map<string, string | null>();
  const emailByUserId = new Map<string, string | null>();
  if (userIds.length > 0) {
    const { data: users } = await db.from("users").select("id, email, name").in("id", userIds);
    for (const user of users ?? []) {
      nameByUserId.set(user.id as string, (user.name as string | null) ?? null);
      emailByUserId.set(user.id as string, (user.email as string | null) ?? null);
    }
  }

  return rows.map((row) => {
    const userId = row.user_id as string;
    const email = emailByUserId.get(userId) ?? null;
    return {
      userId,
      email,
      name: nameByUserId.get(userId) ?? (email ? email.split("@")[0] : null),
      role: row.role as WorkspaceRole,
      inChannel: managed ? inChannelIds.has(userId) : true,
    };
  });
}

/**
 * #19: add a workspace member to an existing private channel -- the
 * post-creation counterpart to the human picker channel creation already
 * has. Flips human_membership_managed on first use, same as leave's own
 * seed-then-write logic, so a previously "open to everyone" channel becomes
 * an explicit roster starting from its actual current visibility rather
 * than silently narrowing to just the people added from here.
 */
export async function addHumanToConversation(conversationId: string, targetUserId: string): Promise<void> {
  const context = await dashboardUserContext();
  const conversation = await ownedConversation(context, conversationId);
  const db = requireService();

  const { data: target } = await db.from("workspace_members").select("user_id").eq("workspace_id", context.workspaceId).eq("user_id", targetUserId).maybeSingle();
  if (!target) throw new AgentJoinError("That person is not a member of this workspace.", "NOT_A_WORKSPACE_MEMBER", 400);

  const { data: managedRow } = await db.from("agent_conversations").select("human_membership_managed").eq("id", conversationId).eq("workspace_id", context.workspaceId).maybeSingle();
  if (!managedRow?.human_membership_managed) {
    const { data: allMembers } = await db.from("workspace_members").select("user_id").eq("workspace_id", context.workspaceId);
    const seedIds = new Set((allMembers ?? []).map((row) => row.user_id as string));
    seedIds.add(targetUserId);
    const { error: seedError } = await db.from("conversation_human_members").insert(
      [...seedIds].map((userId) => ({ workspace_id: context.workspaceId, conversation_id: conversation.id, user_id: userId })),
    );
    if (seedError) throw new AgentJoinError("Could not add that person to the channel.", "CHANNEL_MEMBER_ADD_FAILED", 500);
    await db.from("agent_conversations").update({ human_membership_managed: true }).eq("id", conversationId).eq("workspace_id", context.workspaceId);
    return;
  }

  const { error } = await db.from("conversation_human_members").upsert(
    { workspace_id: context.workspaceId, conversation_id: conversation.id, user_id: targetUserId },
    { onConflict: "conversation_id,user_id" },
  );
  if (error) throw new AgentJoinError("Could not add that person to the channel.", "CHANNEL_MEMBER_ADD_FAILED", 500);
}

/** #19: remove a human from a channel -- an admin-initiated version of
 * leaveDashboardConversation's self-serve path. Same core-channel guard: the
 * workspace's baseline rooms always include every member. */
export async function removeHumanFromConversation(conversationId: string, targetUserId: string): Promise<void> {
  const context = await dashboardUserContext();
  const conversation = await ownedConversation(context, conversationId);
  if (channelGroupForConversation({ channelSlug: conversation.channel_slug, channelKind: conversation.channel_kind, topic: conversation.topic }) === "core") {
    throw new AgentJoinError("This channel can't have members removed -- it's part of every workspace member's baseline access.", "CORE_CHANNEL_MEMBER_REMOVE_FORBIDDEN", 400);
  }
  const db = requireService();
  const { data: managedRow } = await db.from("agent_conversations").select("human_membership_managed").eq("id", conversationId).eq("workspace_id", context.workspaceId).maybeSingle();
  if (!managedRow?.human_membership_managed) {
    const { data: allMembers } = await db.from("workspace_members").select("user_id").eq("workspace_id", context.workspaceId);
    const seedIds = (allMembers ?? []).map((row) => row.user_id as string).filter((userId) => userId !== targetUserId);
    if (seedIds.length > 0) {
      await db.from("conversation_human_members").insert(
        seedIds.map((userId) => ({ workspace_id: context.workspaceId, conversation_id: conversationId, user_id: userId })),
      );
    }
    await db.from("agent_conversations").update({ human_membership_managed: true }).eq("id", conversationId).eq("workspace_id", context.workspaceId);
    return;
  }
  const { error } = await db.from("conversation_human_members").delete()
    .eq("workspace_id", context.workspaceId).eq("conversation_id", conversationId).eq("user_id", targetUserId);
  if (error) throw new AgentJoinError("Could not remove that person from the channel.", "CHANNEL_MEMBER_REMOVE_FAILED", 500);
}

export async function updateDashboardConversation(input: { conversationId: string; action: "archive" | "restore" | "update" | "pause_agents" | "resume_agents"; description?: string; isPrivate?: boolean }): Promise<void> {
  const context = await dashboardUserContext();
  const conversation = await ownedConversation(context, input.conversationId);
  if (conversation.channel_kind === "dm" && input.action === "update") throw new AgentJoinError("Direct messages cannot be reconfigured.", "CONVERSATION_UPDATE_FORBIDDEN", 400);
  if (input.action === "archive" && channelGroupForConversation({ channelSlug: conversation.channel_slug, channelKind: conversation.channel_kind, topic: conversation.topic }) === "core") {
    throw new AgentJoinError("Built-in workspace channels cannot be archived.", "BUILT_IN_CHANNEL_ARCHIVE_FORBIDDEN", 400);
  }
  const update: Record<string, unknown> = {};
  if (input.action === "archive") { update.status = "closed"; update.archived_at = new Date().toISOString(); }
  if (input.action === "restore") { update.status = "open"; update.archived_at = null; }
  // Deliberately allowed on every channel kind, including core -- #general is
  // exactly where a runaway agent loop happens, and unlike archive/delete
  // this only stops automated agent delivery, never human messaging, and is
  // instantly reversible.
  if (input.action === "pause_agents") { update.agent_replies_paused_at = new Date().toISOString(); update.agent_replies_paused_reason = "human"; }
  if (input.action === "resume_agents") { update.agent_replies_paused_at = null; update.agent_replies_paused_reason = null; }
  if (input.action === "update") {
    if (typeof input.description === "string") update.description = input.description.replace(/\s+/g, " ").trim().slice(0, 240) || null;
    if (typeof input.isPrivate === "boolean") update.is_private = input.isPrivate;
  }
  if (Object.keys(update).length === 0) throw new AgentJoinError("No channel changes were supplied.", "INVALID_CHANNEL_UPDATE", 400);
  const { error } = await requireService().from("agent_conversations").update(update).eq("id", conversation.id).eq("workspace_id", context.workspaceId);
  if (error) throw new AgentJoinError("Could not update the channel.", "CHANNEL_UPDATE_FAILED", 500);
}

/**
 * Layer 2's own pause write -- race-safe by construction. Any number of
 * bridge processes can independently decide "this channel just crossed the
 * hard-stop threshold" at nearly the same instant (confirmed live: several
 * processes for the same connection can be briefly alive together across a
 * restart); the `.is("agent_replies_paused_at", null)` guard means only the
 * first UPDATE that actually lands changes the row, and every later one is
 * a genuine no-op with `data: null`. `created` tells the caller whether it
 * won that race -- only the winner should post the chat notice, which is
 * what turns a possible N-way duplicate into exactly one message.
 */
export async function setLoopAutoPause(agent: AuthedAgent, conversationId: string): Promise<{ created: boolean }> {
  const db = requireService();
  const { data, error } = await db.from("agent_conversations")
    .update({ agent_replies_paused_at: new Date().toISOString(), agent_replies_paused_reason: "loop_detected" })
    .eq("id", conversationId).eq("workspace_id", agent.workspaceId).is("agent_replies_paused_at", null)
    .select("id").maybeSingle();
  if (error) {
    if (isMissingColumnError(error)) throw migrationRequiredError();
    throw new AgentJoinError("Could not record the loop auto-pause.", "LOOP_PAUSE_WRITE_FAILED", 500);
  }
  return { created: Boolean(data) };
}

/**
 * The other half of Layer 2's pause: cleared the instant a human posts a
 * real message in the channel, same as the in-memory version this replaces
 * -- but scoped to `agent_replies_paused_reason = 'loop_detected'` so it can
 * never touch a human's own deliberate pause (Layer 3), which only the
 * explicit resume_agents dashboard action may lift.
 */
export async function clearLoopAutoPauseIfActive(agent: AuthedAgent, conversationId: string): Promise<void> {
  const db = requireService();
  const { error } = await db.from("agent_conversations")
    .update({ agent_replies_paused_at: null, agent_replies_paused_reason: null })
    .eq("id", conversationId).eq("workspace_id", agent.workspaceId).eq("agent_replies_paused_reason", "loop_detected");
  if (error && !isMissingColumnError(error)) throw new AgentJoinError("Could not clear the loop auto-pause.", "LOOP_PAUSE_CLEAR_FAILED", 500);
}

/**
 * The Stop button. Resolves the caller's own workspace and verifies the
 * conversation actually belongs to it (same ownedConversation check as
 * every other per-conversation dashboard action), then leaves a durable
 * request row for the owning Bridge process to pick up on its next
 * cancel-turn poll -- there is no direct dashboard-to-Bridge channel, so
 * this can never silently no-op the way the old "Reconnect agents" button
 * did against a bridge that wasn't in exactly the right in-memory state.
 */
export async function requestCancelTurnForConversation(input: { conversationId: string; connectionId: string }): Promise<void> {
  const context = await dashboardUserContext();
  const conversation = await ownedConversation(context, input.conversationId);
  await requestCancelTurn({ workspaceId: context.workspaceId, conversationId: conversation.id, connectionId: input.connectionId, requestedByUserId: context.user.id });
}

/** The Stop button's confirmation poll -- lets the composer know whether the Bridge actually delivered the cancellation yet, instead of just guessing from a timeout. */
export async function cancelTurnStatusForConversation(input: { conversationId: string; connectionId: string }): Promise<"pending" | "consumed" | "expired" | null> {
  const context = await dashboardUserContext();
  const conversation = await ownedConversation(context, input.conversationId);
  return latestCancelTurnStatus(context.workspaceId, conversation.id, input.connectionId);
}

/**
 * Permanently deletes a channel or DM and everything in it -- unlike Archive,
 * this is not reversible. conversation_participants/conversation_messages
 * (and reactions/mentions/read markers off those) cascade-delete via their
 * own foreign keys (agent_conversations.sql), so one row delete here is
 * enough. Built-in workspace channels refuse deletion for the same reason
 * they refuse archiving -- they're durable workspace primitives, not
 * content a human accumulates and cleans up.
 */
export async function deleteDashboardConversation(conversationId: string): Promise<void> {
  const context = await dashboardUserContext();
  const conversation = await ownedConversation(context, conversationId);
  if (channelGroupForConversation({ channelSlug: conversation.channel_slug, channelKind: conversation.channel_kind, topic: conversation.topic }) === "core") {
    throw new AgentJoinError("Built-in workspace channels cannot be deleted.", "BUILT_IN_CHANNEL_DELETE_FORBIDDEN", 400);
  }
  const { error } = await requireService().from("agent_conversations").delete().eq("id", conversation.id).eq("workspace_id", context.workspaceId);
  if (error) throw new AgentJoinError("Could not delete the channel.", "CHANNEL_DELETE_FAILED", 500);
}

export interface ConversationBatchResult {
  ok: string[];
  failed: Array<{ id: string; error: string }>;
}

/**
 * Bulk cleanup (the sidebar's multi-select bar) needs one round trip that
 * reports which ids actually succeeded, not N independent fire-and-forget
 * DELETEs the client can't tell apart on partial failure. Each item still
 * goes through the same single-item path (ownership check, core-channel
 * guard) -- this only batches the network call, not the authorization.
 * Delete-only: Archive was removed from this product entirely per direction
 * (commit 4fe11bd) -- there is no archiveDashboardConversations to match.
 */
export async function deleteDashboardConversations(conversationIds: string[]): Promise<ConversationBatchResult> {
  const ok: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  for (const id of conversationIds) {
    try {
      await deleteDashboardConversation(id);
      ok.push(id);
    } catch (error) {
      failed.push({ id, error: error instanceof AgentJoinError ? error.message : "Could not delete this channel." });
    }
  }
  return { ok, failed };
}

/**
 * Bearer-agent-safe DM lookup/creation -- same "dm-<connectionId>" channel a
 * human sees under createDashboardDirectMessage, but callable from a bearer
 * (CLI) route with no cookie session. Used so a run-start approval request
 * (a plain 403 today, with nothing posted anywhere) can announce itself in
 * the same DM the human already has open with that agent, instead of only
 * existing in the Approval Center drawer.
 */
export async function findOrCreateAgentDmForBearer(agent: AuthedAgent): Promise<string> {
  const db = requireService();
  const dmSlug = `dm-${agent.connectionId}`;
  const { data: existing } = await db.from("agent_conversations").select("id, status")
    .eq("workspace_id", agent.workspaceId).eq("channel_slug", dmSlug).maybeSingle();
  if (existing) {
    if (existing.status !== "open") {
      await db.from("agent_conversations").update({ status: "open", archived_at: null }).eq("id", existing.id).eq("workspace_id", agent.workspaceId);
    }
    return String(existing.id);
  }
  const { data: workspace } = await db.from("projects").select("owner_id").eq("id", agent.workspaceId).maybeSingle();
  if (!workspace?.owner_id) throw new AgentJoinError("Could not resolve the workspace owner for this DM.", "DM_CREATE_FAILED", 500);
  const { data: created, error } = await db.from("agent_conversations").insert({
    workspace_id: agent.workspaceId, topic: agent.agentKind ?? "agent", channel_slug: dmSlug, channel_kind: "dm", created_by_user_id: workspace.owner_id,
  }).select("id").single();
  if (error || !created) throw new AgentJoinError("Could not start the direct message.", "DM_CREATE_FAILED", 500);
  const { error: participantError } = await db.from("conversation_participants").upsert(
    { workspace_id: agent.workspaceId, conversation_id: created.id, connection_id: agent.connectionId },
    { onConflict: "conversation_id,connection_id", ignoreDuplicates: true },
  );
  if (participantError) {
    await db.from("agent_conversations").delete().eq("id", created.id).eq("workspace_id", agent.workspaceId);
    throw new AgentJoinError("Direct message membership could not be saved; the direct message was not created.", "DM_CREATE_FAILED", 500);
  }
  return String(created.id);
}

export async function createDashboardDirectMessage(connectionId: string): Promise<DashboardConversation> {
  const context = await dashboardUserContext();
  const db = requireService();
  const { data: connection } = await context.auth.from("agent_connections").select("id, agent_kind, repo_hint, last_seen_at").eq("id", connectionId).eq("workspace_id", context.workspaceId).eq("status", "active").maybeSingle();
  if (!connection || !isRecentlySeenConnection({ last_seen_at: connection.last_seen_at as string | null })) throw new AgentJoinError("That agent is not available in this workspace.", "AGENT_NOT_FOUND", 404);
  const dmSlug = `dm-${connectionId}`;
  const { data: existing } = await context.auth.from("agent_conversations").select("id").eq("workspace_id", context.workspaceId).eq("channel_slug", dmSlug).maybeSingle();
  if (existing) {
    const conversations = await listConversationsForDashboard();
    const result = conversations.find((conversation) => conversation.id === existing.id);
    if (result) return result;
    const { data: restored, error: restoreError } = await db.from("agent_conversations")
      .update({ status: "open", archived_at: null })
      .eq("id", existing.id)
      .eq("workspace_id", context.workspaceId)
      .select("id")
      .single();
    if (restoreError || !restored) throw new AgentJoinError("The direct message could not be reopened.", "DM_RESTORE_FAILED", 500);
    const reopened = (await listConversationsForDashboard()).find((conversation) => conversation.id === existing.id);
    if (reopened) return reopened;
  }
  // A DM has exactly one agent, so there's no cross-connection ambiguity to
  // check -- that agent's own repo_hint is unambiguously "the repository."
  const repository = (connection.repo_hint as string | null)?.trim() || null;
  const { data: created, error } = await db.from("agent_conversations").insert({
    workspace_id: context.workspaceId, topic: String(connection.agent_kind), channel_slug: dmSlug, channel_kind: "dm", created_by_user_id: context.user.id, repository,
  }).select("id").single();
  if (error || !created) throw new AgentJoinError("Could not start the direct message.", "DM_CREATE_FAILED", 500);
  const { error: participantError } = await db.from("conversation_participants").upsert({ workspace_id: context.workspaceId, conversation_id: created.id, connection_id: connection.id }, { onConflict: "conversation_id,connection_id", ignoreDuplicates: true });
  if (participantError) {
    await db.from("agent_conversations").delete().eq("id", created.id).eq("workspace_id", context.workspaceId);
    throw new AgentJoinError("Direct message membership could not be saved; the direct message was not created.", "DM_CREATE_FAILED", 500);
  }
  const conversations = await listConversationsForDashboard();
  const result = conversations.find((conversation) => conversation.id === created.id);
  if (!result) throw new AgentJoinError("Direct message was created but could not be loaded.", "DM_READ_FAILED", 500);
  return result;
}

/** #13, dashboard read side: same conversationId ownership check every other dashboard conversation read uses. */
export async function listDraftsForDashboard(conversationId: string): Promise<Draft[]> {
  const context = await dashboardUserContext();
  const conversation = await ownedConversation(context, conversationId);
  return listDraftsForConversation(context.workspaceId, conversation.id);
}

/**
 * #13, dashboard write side: the human's own contribution to a shared
 * draft, same shape as an agent's but stamped with the signed-in user id.
 */
export async function writeDraftSectionForDashboard(input: { conversationId: string; draftTitle: string; heading: string; body: string }): Promise<Draft> {
  const context = await dashboardUserContext();
  const conversation = await ownedConversation(context, input.conversationId);
  try {
    return await upsertDraftSection({
      workspaceId: context.workspaceId,
      conversationId: conversation.id,
      draftTitle: input.draftTitle,
      heading: input.heading,
      body: input.body,
      author: { kind: "human", userId: context.user.id },
    });
  } catch (draftError) {
    throw new AgentJoinError(draftError instanceof Error ? draftError.message : "Could not write the draft section.", "DRAFT_WRITE_FAILED", 400);
  }
}

/** #13: the human-only "this is finished" signal -- see conversation-draft-service.ts's setDraftStatus for why writes lock once a draft is ready. */
export async function setDraftStatusForDashboard(input: { conversationId: string; draftId: string; status: DraftStatus }): Promise<void> {
  const context = await dashboardUserContext();
  const conversation = await ownedConversation(context, input.conversationId);
  try {
    await setDraftStatus({ workspaceId: context.workspaceId, conversationId: conversation.id, draftId: input.draftId, status: input.status });
  } catch (draftError) {
    throw new AgentJoinError(draftError instanceof Error ? draftError.message : "Could not update the draft.", "DRAFT_STATUS_FAILED", 400);
  }
}

/** Human-authored channel post with optional thread parent and mention resolution. */
export async function sendDashboardConversationMessage(input: { conversationId: string; body: string; parentMessageId?: string | null; idempotencyKey?: string | null }): Promise<DashboardConversationMessage> {
  const context = await dashboardUserContext();
  const conversation = await ownedConversation(context, input.conversationId);
  if (conversation.status !== "open") throw new AgentJoinError("Conversation is closed and cannot receive new messages.", "CONVERSATION_CLOSED", 409);
  const sanitized = sanitizeBody(input.body);
  if (!sanitized.ok) throw new AgentJoinError(sanitized.error, "INVALID_BODY", 400);
  const idempotencyKey = typeof input.idempotencyKey === "string" ? input.idempotencyKey.trim() : "";
  if (idempotencyKey.length > 256) throw new AgentJoinError("idempotencyKey exceeds 256 characters.", "INVALID_IDEMPOTENCY_KEY", 400);
  const db = requireService();
  const { assertMayPost } = await import("@/lib/moderation-service");
  try {
    await assertMayPost(context.workspaceId, "user", context.user.id, conversation.id);
  } catch (error) {
    throw new AgentJoinError(error instanceof Error ? error.message : "You may not post here.", "MODERATION_BLOCKED", 403);
  }
  if (input.parentMessageId) {
    const { data: parent } = await context.auth.from("conversation_messages").select("id").eq("id", input.parentMessageId).eq("conversation_id", conversation.id).maybeSingle();
    if (!parent) throw new AgentJoinError("Reply target was not found in this channel.", "INVALID_PARENT", 400);
  }
  // Evidence consent is a control-plane response, not a new task. Resolve its
  // target before persisting so the delivery is direct to the agent that owns
  // the pending request; other bridges never receive or acknowledge it.
  const evidenceDecisionTarget = await findPendingEvidenceDecisionTarget({
    workspaceId: conversation.workspace_id,
    conversationId: conversation.id,
    body: sanitized.body,
    parentMessageId: input.parentMessageId ?? null,
  }).catch((decisionError) => {
    console.warn(`Evidence request target lookup failed for conversation ${conversation.id}:`, decisionError instanceof Error ? decisionError.message : decisionError);
    return null;
  });
  // A DM's whole point is that it's addressed to one specific agent, but
  // nothing here previously marked it that way -- the bridge's own routing
  // (ensureDynamicSessionForConversation) only starts a session when it finds
  // a literal "@provider" token in the message body or an explicit
  // recipient_connection_id matching that bridge's own connection. A DM
  // conversation's topic being the agent's name was never enough on its own:
  // a plain message typed straight into "the opencode DM" with no "@opencode"
  // in it went nowhere, silently, confirmed live. DMs have exactly one
  // participant by construction, so that's the recipient whenever this isn't
  // already resolving an evidence decision.
  let dmRecipientConnectionId: string | null = null;
  if (!evidenceDecisionTarget && conversation.channel_kind === "dm") {
    const { data: participant } = await context.auth.from("conversation_participants").select("connection_id").eq("conversation_id", conversation.id).limit(1).maybeSingle();
    dmRecipientConnectionId = (participant?.connection_id as string | undefined) ?? null;
  }
  const recipientConnectionId = evidenceDecisionTarget?.agentConnectionId ?? dmRecipientConnectionId;
  if (idempotencyKey) {
    const { data: existing, error: existingError } = await db.from("conversation_messages")
      .select("id, conversation_id, sender_connection_id, sender_user_id, sender_display_name, recipient_connection_id, kind, body, outcome, created_at, spawned_run_id, related_run_id, parent_message_id, edited_at, deleted_at")
      .eq("workspace_id", conversation.workspace_id)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (existingError) {
      if (isMissingColumnError(existingError)) throw new AgentJoinError("Message retry protection is not available until the latest database migration is applied.", "MIGRATION_REQUIRED", 503);
      throw new AgentJoinError("Could not verify whether this message was already sent.", "MESSAGE_READ_FAILED", 500);
    }
    if (existing) {
      if (!idempotencyIdentityMatches(existing as Record<string, unknown>, {
        conversationId: conversation.id,
        senderConnectionId: null,
        senderUserId: context.user.id,
        recipientConnectionId,
        kind: "message",
        body: sanitized.body,
        parentMessageId: input.parentMessageId ?? null,
        outcome: null,
      })) throw new AgentJoinError("idempotencyKey is already used by another message.", "IDEMPOTENCY_KEY_CONFLICT", 409);
      await ensureAgentAvailabilityNotice({
        db,
        workspaceId: conversation.workspace_id,
        conversationId: conversation.id,
        messageId: String(existing.id),
        body: sanitized.body,
      });
      return { ...(existing as unknown as DashboardConversationMessage), reactions: [], attachments: [], todos: [] };
    }
  }
  const { data: message, error } = await db.from("conversation_messages").insert({
    workspace_id: conversation.workspace_id, conversation_id: conversation.id, sender_user_id: context.user.id,
    sender_display_name: displayNameForUser(context.user), sender_kind: "user", recipient_connection_id: recipientConnectionId, kind: "message", body: sanitized.body,
    parent_message_id: input.parentMessageId ?? null,
    idempotency_key: idempotencyKey || null,
  }).select("id, conversation_id, sender_connection_id, sender_user_id, sender_display_name, recipient_connection_id, kind, body, created_at, spawned_run_id, related_run_id, parent_message_id, edited_at, deleted_at").single();
  if (error || !message) {
    if (idempotencyKey && error?.code === "23505") {
      const { data: existing } = await db.from("conversation_messages")
        .select("id, conversation_id, sender_connection_id, sender_user_id, sender_display_name, recipient_connection_id, kind, body, outcome, created_at, spawned_run_id, related_run_id, parent_message_id, edited_at, deleted_at")
        .eq("workspace_id", conversation.workspace_id).eq("idempotency_key", idempotencyKey).maybeSingle();
      if (existing && idempotencyIdentityMatches(existing as Record<string, unknown>, {
        conversationId: conversation.id,
        senderConnectionId: null,
        senderUserId: context.user.id,
        recipientConnectionId,
        kind: "message",
        body: sanitized.body,
        parentMessageId: input.parentMessageId ?? null,
        outcome: null,
      })) {
        await ensureAgentAvailabilityNotice({
          db,
          workspaceId: conversation.workspace_id,
          conversationId: conversation.id,
          messageId: String(existing.id),
          body: sanitized.body,
        });
        return { ...(existing as unknown as DashboardConversationMessage), reactions: [], attachments: [], todos: [] };
      }
      if (existing) throw new AgentJoinError("idempotencyKey is already used by another message.", "IDEMPOTENCY_KEY_CONFLICT", 409);
    }
    throw new AgentJoinError("Could not send the message.", "MESSAGE_SEND_FAILED", 500);
  }
  // The normal browser path publishes through the authenticated relay socket.
  // The HTTP fallback still needs to fan out to other open dashboards when
  // their own socket is the thing that is restarting; durable polling remains
  // the recovery path if this optional publish cannot reach the relay.
  void publishAgentWorkspaceMessage({ workspaceId: conversation.workspace_id, conversationId: conversation.id, message: message as Record<string, unknown> });

  const [connections, participants] = await Promise.all([
    db.from("agent_connections").select("id, agent_kind, status, last_seen_at").eq("workspace_id", conversation.workspace_id).eq("status", "active"),
    db.from("conversation_participants").select("connection_id").eq("workspace_id", conversation.workspace_id).eq("conversation_id", conversation.id),
  ]);
  const channelMemberIds = new Set((participants.data ?? []).map((row) => String(row.connection_id)));
  const normalizedBody = sanitized.body.toLowerCase();
  const explicitlyMentioned = new Set(explicitlyMentionedAgentKinds(sanitized.body, connections.data ?? []));
  const mentionedConnections = (connections.data ?? []).filter((row) => {
    if (!channelMemberIds.has(String(row.id))) return false;
    if (!isRecentlySeenConnection({ last_seen_at: row.last_seen_at as string | null })) return false;
    const names = agentMentionNames(String(row.agent_kind));
    return explicitlyMentioned.has(providerMention(String(row.agent_kind)))
      || names.some((name) => name && containsAgentMention(normalizedBody, name));
  });
  const mentionRows = mentionedConnections.map((row) => ({ message_id: message.id, workspace_id: conversation.workspace_id, mentioned_connection_id: row.id }));
  if (mentionRows.length > 0) await db.from("conversation_message_mentions").insert(mentionRows);

  // A human message can be persisted successfully while no local runtime is
  // listening for the named provider. Keep that state visible and durable;
  // the helper also repairs the diagnostic when this request is a retry whose
  // first attempt lost the response before reaching this point.
  await ensureAgentAvailabilityNotice({
    db,
    workspaceId: conversation.workspace_id,
    conversationId: conversation.id,
    messageId: String(message.id),
    body: sanitized.body,
  });
  if (input.parentMessageId) await db.from("workspace_notifications").upsert({
    workspace_id: conversation.workspace_id, recipient_user_id: context.user.id, conversation_id: conversation.id,
    message_id: message.id, kind: "reply", title: "New reply", body: sanitized.body.slice(0, 2048), payload: { parentMessageId: input.parentMessageId },
  }, { onConflict: "recipient_user_id,message_id,kind", ignoreDuplicates: true });

  // A normal chat message stays a normal message. Only explicit approval
  // language against a pending evidence request changes its state; a missing
  // or unmigrated evidence table must never block the user's message.
  await decideChatEvidenceRequestFromMessage({
    workspaceId: conversation.workspace_id,
    conversationId: conversation.id,
    decidedByUserId: context.user.id,
    decisionMessageId: String(message.id),
    parentMessageId: input.parentMessageId ?? null,
    body: sanitized.body,
    requestId: evidenceDecisionTarget?.requestId ?? null,
  }).catch((decisionError) => {
    console.warn(`Evidence request decision check failed for conversation ${conversation.id}:`, decisionError instanceof Error ? decisionError.message : decisionError);
  });

  // Task negotiation (item 5): a human naming 2+ agents in ONE message is a
  // team task, not the same message answered twice independently. The
  // contract is opened HERE, server-side, rather than in a resident: each
  // agent's bridge runs on its own machine and only knows its own sessions,
  // so no single bridge can reliably see "2+ agents were mentioned" or agree
  // on which one decomposes. The first mentioned connection is the
  // decomposer; the rest are held until it posts the split.
  if (mentionedConnections.length >= 2 && context.user.id) {
    // "First mentioned" means first in the human's own sentence, not
    // whichever row the database happened to return first.
    const earliestMentionIndex = (agentKind: string): number => {
      const positions = agentMentionNames(String(agentKind))
        .map((name) => (name ? normalizedBody.indexOf(name) : -1))
        .filter((index) => index >= 0);
      return positions.length > 0 ? Math.min(...positions) : Number.MAX_SAFE_INTEGER;
    };
    const decomposer = [...mentionedConnections].sort((left, right) => earliestMentionIndex(String(left.agent_kind)) - earliestMentionIndex(String(right.agent_kind)))[0];
    const { openTaskContractForMultiMention } = await import("@/lib/bridge/task-contract-service");
    await openTaskContractForMultiMention({
      workspaceId: conversation.workspace_id,
      conversationId: conversation.id,
      anchorMessageId: String(message.id),
      decomposerConnectionId: String(decomposer.id),
    }).catch((contractError) => {
      // Additive: a failure here must never break the human's message.
      console.warn(`Task contract open failed for conversation ${conversation.id}:`, contractError instanceof Error ? contractError.message : contractError);
    });
  }

  await bindChannelMessageToMission({ context, conversation, message, mentionedConnections, body: sanitized.body }).catch((bindError) => {
    // Additive Buzz-parity path (Phase A1/A2) — never breaks the legacy send
    // it rides beside. See mission-channel-binding.ts.
    console.warn(`Channel-to-Mission binding failed for conversation ${conversation.id}:`, bindError instanceof Error ? bindError.message : bindError);
  });
  await runChannelMessagePostedWorkflows({ context, conversation, message, body: sanitized.body }).catch((workflowError) => {
    console.warn(`Channel workflow evaluation failed for conversation ${conversation.id}:`, workflowError instanceof Error ? workflowError.message : workflowError);
  });
  return { ...(message as unknown as DashboardConversationMessage), reactions: [], attachments: [], todos: [] };
}

/** Real file/media attachment, replacing the old text-only /-command stub. Uploads to the private "conversation-media" bucket and links the row to an already-sent message. */
export async function uploadDashboardConversationAttachment(input: { conversationId: string; messageId: string; file: File }): Promise<DashboardAttachment> {
  const context = await dashboardUserContext();
  const conversation = await ownedConversation(context, input.conversationId);
  const { data: message } = await context.auth.from("conversation_messages").select("id").eq("id", input.messageId).eq("conversation_id", conversation.id).maybeSingle();
  if (!message) throw new AgentJoinError("Message was not found in this conversation.", "MESSAGE_NOT_FOUND", 404);
  const file = input.file;
  if (!file.name || file.name.length > 256 || !ALLOWED_ATTACHMENT_MEDIA_TYPES.has(file.type) || file.size <= 0 || file.size > MAX_ATTACHMENT_BYTES) {
    throw new AgentJoinError("Attachment file is invalid or unsupported.", "INVALID_ATTACHMENT", 400);
  }
  const db = requireService();
  const safeName = file.name.normalize("NFKC").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(-120) || "attachment";
  const path = `${conversation.workspace_id}/${conversation.id}/${input.messageId}/${crypto.randomUUID()}-${safeName}`;
  const uploaded = await db.storage.from("conversation-media").upload(path, await file.arrayBuffer(), { contentType: file.type, upsert: false });
  if (uploaded.error) throw new AgentJoinError("Could not upload the attachment.", "ATTACHMENT_UPLOAD_FAILED", 500);
  const inserted = await db.from("conversation_message_attachments").insert({
    workspace_id: conversation.workspace_id, conversation_id: conversation.id, message_id: input.messageId,
    uploader_user_id: context.user.id, name: file.name, media_type: file.type, size_bytes: file.size, storage_path: path,
  }).select("id").single();
  if (inserted.error || !inserted.data) {
    await db.storage.from("conversation-media").remove([path]);
    throw new AgentJoinError("Could not save the attachment.", "ATTACHMENT_SAVE_FAILED", 500);
  }
  const signed = await db.storage.from("conversation-media").createSignedUrl(path, 900);
  if (signed.error || !signed.data) throw new AgentJoinError("Attachment saved but could not be linked for viewing.", "ATTACHMENT_SIGN_FAILED", 500);
  return { id: inserted.data.id as string, name: file.name, mediaType: file.type, sizeBytes: file.size, url: signed.data.signedUrl };
}

/**
 * Buzz's `message_posted` trigger fires on any message in the workflow's
 * channel (schema.rs's TriggerDef::MessagePosted), independent of whether
 * the message @mentions anyone. This mirrors that — it does not require the
 * mention-driven bindChannelMessageToMission path above to have fired first,
 * but it does require a Mission to already be bound to the channel, since a
 * workflow step posts through the Mission's own PostMessage/
 * MarkReadyForDecision commands. A channel with no Mission yet (no
 * repository bound, or no agent ever mentioned) has nothing to run
 * workflow steps against — this refuses silently, same discipline as
 * mission-channel-binding.ts, rather than guessing a Mission into existence.
 */
async function runChannelMessagePostedWorkflows(input: {
  context: DashboardUserContext;
  conversation: Awaited<ReturnType<typeof ownedConversation>>;
  message: { id: string };
  body: string;
}): Promise<void> {
  if (!isMissionFeatureEnabled("channelWorkflows")) return;
  const missionId = input.conversation.mission_id;
  if (!missionId) return;

  const principal = {
    actor: { kind: "human" as const, id: input.context.user.id },
    workspaceId: input.context.workspaceId,
    kind: "human" as const,
    userId: input.context.user.id,
    agent: null,
  };
  await runChannelWorkflowsForMessage(input.conversation.id, principal, {
    missionId,
    senderParticipantId: missionOwnerParticipantId(missionId, input.context.user.id),
    triggerMessageId: input.message.id,
    body: input.body,
    author: displayNameForUser(input.context.user),
  });
}

/**
 * Buzz-parity path: a channel-bound repository + an @mention implicitly
 * creates/reuses a Mission and posts this same message into `mission_events`
 * — there is no manual "New Mission" form anymore. Refuses silently (returns
 * without effect) whenever the channel has no repository bound or the
 * message mentions no agent — it never guesses either.
 */
async function bindChannelMessageToMission(input: {
  context: DashboardUserContext;
  conversation: Awaited<ReturnType<typeof ownedConversation>>;
  message: { id: string };
  mentionedConnections: { id: string; agent_kind: string }[];
  body: string;
}): Promise<void> {
  if (!input.conversation.repository) return;
  if (input.mentionedConnections.length === 0) return;

  const principal = {
    actor: { kind: "human" as const, id: input.context.user.id },
    workspaceId: input.context.workspaceId,
    kind: "human" as const,
    userId: input.context.user.id,
    agent: null,
  };
  const mentionedAgents: ChannelMentionedAgent[] = [];
  for (const row of input.mentionedConnections) {
    const agentKind = normalizeAgentKind(row.agent_kind);
    mentionedAgents.push({ connectionId: row.id, agentKind, displayName: agentLabelFor(agentKind), provider: agentKind });
  }

  const { missionId } = await ensureChannelMission({
    principal,
    conversationId: input.conversation.id,
    existingMissionId: input.conversation.mission_id,
    repository: input.conversation.repository,
    repositoryId: input.conversation.repository_id,
    goal: input.conversation.topic || input.body.slice(0, 200),
    humanDisplayName: displayNameForUser(input.context.user),
    mentionedAgents,
  });

  const structured = parseStructuredMessagePrefix(input.body);
  await postMissionMessage(principal, missionId, {
    senderParticipantId: missionOwnerParticipantId(missionId, input.context.user.id),
    messageType: structured.messageType,
    recipientParticipantIds: mentionedAgents.map((agent) => missionAgentParticipantId(missionId, agent.connectionId)),
    body: structured.body,
    structuredPayload: structured.intent ? { intent: structured.intent } : undefined,
    clientRequestId: `channel-binding:${input.conversation.id}:message:${input.message.id}`,
  });
}

/**
 * The composer's "what can I say" shortcuts (ConversationPanel.tsx's
 * MESSAGE_SHORTCUTS) resolve here. Only /finding and /question map to their
 * real Mission messageType — mission-command-handler.ts's PostMessage schema
 * checks (validateReviewRequestPayload, validateBlockerPayload,
 * validateEvidenceNoticePayload) require structured fields free text alone
 * can't safely supply, and posting a type that then fails validation would
 * silently drop the message from the Mission feed entirely. /review,
 * /blocker, /delegate, /evidence are recorded as an "intent" tag on an
 * "information" message instead — visible, never fabricated as governance
 * state this module can't actually back up.
 */
function parseStructuredMessagePrefix(body: string): { messageType: import("./mission/mission-domain").MessageType; body: string; intent: string | null } {
  const match = body.match(/^\/(\w+)\s+([\s\S]+)$/);
  if (!match) return { messageType: "information", body, intent: null };
  const [, prefix, rest] = match;
  const normalized = prefix.toLowerCase();
  if (normalized === "finding") return { messageType: "finding", body: rest, intent: null };
  if (normalized === "question") return { messageType: "question", body: rest, intent: null };
  if (["review", "blocker", "delegate", "evidence"].includes(normalized)) return { messageType: "information", body: rest, intent: normalized };
  return { messageType: "information", body, intent: null };
}

function agentLabelFor(agentKind: string): string {
  return agentKind === "claude-code" ? "Claude"
    : agentKind === "codex" ? "Codex"
      : agentKind === "grok-build" ? "Grok Build"
        : agentKind === "opencode" ? "OpenCode"
          : agentKind;
}

// Superseded by src/lib/bridge/session-service.ts (Shared Live Sessions v2)
// -- listActiveTurnsForDashboard used to list raw turns here, with a
// terminal-stage set that was missing report.observed/fallback_report.posted
// (both fire AFTER turn.completed), which left every finished turn showing
// as permanently "active". session-service.ts fixes that and replaces the
// flat turn list with a bounded, lifecycled Session object.

export async function listConversationsForDashboard(selectedConversationId?: string | null): Promise<DashboardConversation[]> {
  const context = await dashboardUserContext();
  const { data: conversations, error } = await context.auth.from("agent_conversations")
    .select("id, topic, channel_slug, channel_kind, description, is_private, status, created_at, mission_id, agent_replies_paused_at, human_membership_managed")
    .eq("workspace_id", context.workspaceId).eq("status", "open").order("created_at", { ascending: true }).limit(100);
  if (error) {
    if (isMissingTableError(error)) throw migrationRequiredError();
    throw new AgentJoinError("Could not load workspace conversations.", "CONVERSATION_READ_FAILED", 500);
  }
  if (!conversations) return [];
  const ids = conversations.map((row) => row.id as string);
  if (ids.length === 0) return [];
  const detailIds = selectedConversationId && ids.includes(selectedConversationId) ? [selectedConversationId] : ids;
  const [{ data: participants, error: participantsError }, { data: humanMembers, error: humanMembersError }, messageResults, { data: reactions, error: reactionsError }, { data: markers, error: markersError }, { data: attachmentRows, error: attachmentsError }] = await Promise.all([
    context.auth.from("conversation_participants").select("conversation_id, connection_id").eq("workspace_id", context.workspaceId).in("conversation_id", ids),
    context.auth.from("conversation_human_members").select("conversation_id, user_id").eq("workspace_id", context.workspaceId).in("conversation_id", ids),
    // Descending + limit, then reversed below -- the previous ascending+limit(200)
    // kept a channel's OLDEST 200 messages and silently dropped new ones once a
    // channel passed that count (confirmed live: a freshly-posted message in a
    // busy test channel never appeared in this listing). Also cut 200 -> 80:
    // this query re-runs on every dashboard poll (every 2-10s per open tab),
    // and re-downloading up to 200 full message bodies per conversation on that
    // cadence is what actually burned through the Supabase free-tier egress cap.
    //
    // Second egress fix: only the currently-open channel actually needs the
    // 80-message window. Every other channel in this list is only ever read
    // for its single latest message (the channel-switcher preview line), so
    // fetching 80 full message bodies for up to 100 channels the viewer isn't
    // looking at was ~99% wasted transfer. limit(1) for anything that isn't
    // selectedConversationId keeps the exact same response shape (still an
    // array under `messages`) so no client change is needed beyond passing
    // which channel is open.
    loadDashboardMessageWindows(context.auth, context.workspaceId, ids, selectedConversationId),
    // Reactions and attachments only render on messages the viewer can see, i.e. the
    // open channel's 80-message window. Every other channel contributes one preview
    // line, so scoping these to the open channel drops the cross-channel scans (and the
    // per-attachment signed URLs below) from every poll.
    context.auth.from("conversation_message_reactions").select("id, message_id, emoji, actor_user_id, actor_connection_id").eq("workspace_id", context.workspaceId).in("conversation_id", detailIds),
    context.auth.from("conversation_read_markers").select("conversation_id, read_at").eq("workspace_id", context.workspaceId).eq("user_id", context.user.id).in("conversation_id", ids),
    requireService().from("conversation_message_attachments").select("id, message_id, name, media_type, size_bytes, storage_path").in("conversation_id", detailIds),
  ]);
  if (participantsError || humanMembersError || reactionsError || markersError || messageResults.error || attachmentsError) {
    const error = participantsError || humanMembersError || reactionsError || markersError || attachmentsError || messageResults.error;
    if (isMissingTableError(error as Parameters<typeof isMissingTableError>[0])) throw migrationRequiredError();
    throw new AgentJoinError("Could not load workspace conversation details.", "CONVERSATION_READ_FAILED", 500);
  }
  // Each per-conversation result came back newest-first (see the query above);
  // reverse each one back to ascending before flattening so display order is
  // unaffected by the egress fix.
  const rawMessagesUnfiltered = messageResults.rows;
  // Shared Live Sessions v2: an archived session's messages leave the
  // normal channel view entirely (not just Live Sessions) -- they're only
  // reachable via the Archived tab or an agent's recall lookup. This is the
  // one place that filter has to apply, since every channel's visible
  // history is just this query.
  const { archivedMessageIdsFor } = await import("@/lib/bridge/session-service");
  const archivedIds = await archivedMessageIdsFor(context.workspaceId, ids).catch(() => new Set<string>());
  const rawMessages = archivedIds.size === 0 ? rawMessagesUnfiltered : rawMessagesUnfiltered.filter((row) => !archivedIds.has(row.id as string));
  const participantsBy = new Map<string, string[]>();
  for (const row of participants ?? []) participantsBy.set(row.conversation_id, [...(participantsBy.get(row.conversation_id) ?? []), row.connection_id]);
  const humanMembersBy = new Map<string, string[]>();
  for (const row of humanMembers ?? []) humanMembersBy.set(row.conversation_id, [...(humanMembersBy.get(row.conversation_id) ?? []), row.user_id]);
  // Visibility is gated by the human roster once human_membership_managed
  // is true -- set the first time that roster was ever written (creation,
  // or a leave) -- regardless of is_private. is_private only ever gated
  // AGENT participation; a human explicitly leaving a channel must work the
  // same way whether the channel is public or private, or "leave" would
  // silently do nothing for the vast majority of channels (public ones).
  // Checking roster row count instead of this flag was a separate real bug:
  // the workspace's only member left a channel, emptying the roster to zero
  // rows, and zero rows read as "never restricted," reopening the channel
  // to everyone (i.e. them) right after they'd just left it.
  const visibleConversations = conversations.filter((row) => {
    if (!row.human_membership_managed) return true;
    const roster = humanMembersBy.get(row.id) ?? [];
    return roster.includes(context.user.id);
  });
  const reactionsBy = new Map<string, DashboardReaction[]>();
  for (const row of reactions ?? []) reactionsBy.set(row.message_id, [...(reactionsBy.get(row.message_id) ?? []), row as DashboardReaction]);
  const readBy = new Map((markers ?? []).map((row) => [row.conversation_id as string, row.read_at as string]));
  const attachmentsBy = new Map<string, DashboardAttachment[]>();
  if (attachmentRows?.length) {
    const storage = requireService().storage.from("conversation-media");
    const signed = await Promise.all(attachmentRows.map((row) => storage.createSignedUrl(row.storage_path as string, 900)));
    attachmentRows.forEach((row, index) => {
      const url = signed[index].data?.signedUrl;
      if (!url) return;
      const attachment: DashboardAttachment = { id: row.id as string, name: row.name as string, mediaType: row.media_type as string, sizeBytes: Number(row.size_bytes), url };
      attachmentsBy.set(row.message_id as string, [...(attachmentsBy.get(row.message_id as string) ?? []), attachment]);
    });
  }
  // One batched follow-up read rather than a join, matching how reactions
  // and attachments are already attached to this message list. Never fatal:
  // listMessageTodosForConversations swallows its own read error so an
  // unapplied additive migration cannot take the channel list down.
  const todosBy = await listMessageTodosForConversations(ids);
  const messagesBy = new Map<string, DashboardConversationMessage[]>();
  for (const row of rawMessages ?? []) {
    if (typeof row.id !== "string" || typeof row.conversation_id !== "string") continue;
    const message = { ...row, reactions: reactionsBy.get(row.id) ?? [], attachments: attachmentsBy.get(row.id) ?? [], todos: todosBy.get(row.id) ?? [] } as unknown as DashboardConversationMessage & { conversation_id: string };
    messagesBy.set(row.conversation_id, [...(messagesBy.get(row.conversation_id) ?? []), message]);
  }
  // Unread counts for non-selected channels can no longer be derived from
  // the (now 1-message) fetched array above -- that array is a preview, not
  // the real message set. Real counts still matter here: ChannelSwitcher
  // renders an actual number, not a presence dot. head:true keeps this a
  // count-only index scan with no message bodies returned, so it's cheap
  // even at up to ~100 channels -- nowhere near what fetching full history
  // for every channel used to cost.
  // An archived message must stay excluded from unread counts the same way
  // it's excluded from the message list above (rawMessages), or a channel
  // with an unread archived message would show a phantom badge count.
  const unreadCountsBy = await loadDashboardUnreadCounts(context.auth, context.workspaceId, context.user.id, visibleConversations.filter((row) => row.id !== selectedConversationId).map((row) => row.id as string), [...archivedIds], readBy);
  return visibleConversations.map((row) => {
    const messages = messagesBy.get(row.id) ?? [];
    const readAt = readBy.get(row.id);
    const unreadCount = row.id === selectedConversationId
      ? messages.filter((message) => !readAt || message.created_at > readAt).length
      : unreadCountsBy.get(row.id) ?? 0;
    return {
      ...row,
      participant_connection_ids: participantsBy.get(row.id) ?? [],
      messages,
      unread_count: unreadCount,
    } as DashboardConversation;
  });
}

export async function toggleDashboardReaction(input: { conversationId: string; messageId: string; emoji: string }): Promise<{ active: boolean; emoji: string }> {
  const context = await dashboardUserContext();
  const conversation = await ownedConversation(context, input.conversationId);
  const emoji = input.emoji.trim().slice(0, 16);
  if (!emoji) throw new AgentJoinError("Reaction emoji is required.", "INVALID_REACTION", 400);
  const db = requireService();
  const { data: existing } = await db.from("conversation_message_reactions").select("id").eq("workspace_id", conversation.workspace_id).eq("conversation_id", conversation.id).eq("message_id", input.messageId).eq("actor_user_id", context.user.id).eq("emoji", emoji).maybeSingle();
  if (existing) {
    const { error } = await db.from("conversation_message_reactions").delete().eq("id", existing.id).eq("workspace_id", conversation.workspace_id);
    if (error) throw new AgentJoinError("Could not remove reaction.", "REACTION_FAILED", 500);
    return { active: false, emoji };
  }
  const { error } = await db.from("conversation_message_reactions").insert({ workspace_id: conversation.workspace_id, conversation_id: conversation.id, message_id: input.messageId, actor_user_id: context.user.id, emoji });
  // 23505 = the unique index (conversation_message_reactions_actor_user_unique)
  // caught a genuine race -- a double-click or two open tabs both reading
  // "not yet reacted" before either insert lands. The reaction the other
  // request just created already satisfies this one's intent; treat it as
  // the same idempotent-replay success every other insert race in this
  // codebase gets, not an error.
  if (error && error.code !== "23505") throw new AgentJoinError("Could not add reaction.", "REACTION_FAILED", 500);
  return { active: true, emoji };
}

export async function updateDashboardMessage(input: { conversationId: string; messageId: string; body: string | null }): Promise<void> {
  const context = await dashboardUserContext();
  const conversation = await ownedConversation(context, input.conversationId);
  const sanitized = input.body === null ? null : sanitizeBody(input.body);
  if (sanitized && !sanitized.ok) throw new AgentJoinError(sanitized.error, "INVALID_BODY", 400);
  const db = requireService();
  const { data: message } = await context.auth.from("conversation_messages").select("id").eq("id", input.messageId).eq("conversation_id", conversation.id).eq("sender_user_id", context.user.id).maybeSingle();
  if (!message) throw new AgentJoinError("Only your own messages can be changed.", "MESSAGE_FORBIDDEN", 403);
  const { error } = await db.from("conversation_messages").update(input.body === null ? { body: "[Message deleted]", deleted_at: new Date().toISOString(), edited_at: null } : { body: sanitized?.body, edited_at: new Date().toISOString() }).eq("id", input.messageId).eq("workspace_id", conversation.workspace_id);
  if (error) throw new AgentJoinError("Could not update the message.", "MESSAGE_UPDATE_FAILED", 500);
}

export async function markDashboardConversationRead(input: { conversationId: string; messageId?: string | null }): Promise<void> {
  const context = await dashboardUserContext();
  const conversation = await ownedConversation(context, input.conversationId);
  const db = requireService();
  const { error } = await db.from("conversation_read_markers").upsert({ workspace_id: conversation.workspace_id, conversation_id: conversation.id, user_id: context.user.id, last_read_message_id: input.messageId ?? null, read_at: new Date().toISOString() }, { onConflict: "conversation_id,user_id" });
  if (error) throw new AgentJoinError("Could not mark the channel read.", "READ_MARKER_FAILED", 500);
}

export interface DashboardNotification {
  id: string;
  conversation_id: string | null;
  message_id: string | null;
  kind: string;
  title: string;
  body: string;
  created_at: string;
  read_at: string | null;
}

export async function listDashboardNotifications(): Promise<DashboardNotification[]> {
  const context = await dashboardUserContext();
  const { data, error } = await context.auth.from("workspace_notifications").select("id, conversation_id, message_id, kind, title, body, created_at, read_at").eq("workspace_id", context.workspaceId).eq("recipient_user_id", context.user.id).order("created_at", { ascending: false }).limit(100);
  if (error) {
    if (isMissingTableError(error)) throw migrationRequiredError();
    throw new AgentJoinError("Could not load workspace notifications.", "NOTIFICATION_READ_FAILED", 500);
  }
  return (data ?? []) as DashboardNotification[];
}

/**
 * A real unread total, not `listDashboardNotifications().filter(...)`. That
 * list is a capped 100-row page of read AND unread rows interleaved, so any
 * count derived from it silently undercounts once a workspace passes 100
 * notifications. The badge needs the true total, so it gets its own
 * head-only count query with no row limit.
 */
export async function countUnreadDashboardNotifications(): Promise<number> {
  const context = await dashboardUserContext();
  const { count, error } = await context.auth.from("workspace_notifications").select("id", { count: "exact", head: true }).eq("workspace_id", context.workspaceId).eq("recipient_user_id", context.user.id).is("read_at", null);
  if (error) {
    if (isMissingTableError(error)) throw migrationRequiredError();
    throw new AgentJoinError("Could not load workspace notifications.", "NOTIFICATION_READ_FAILED", 500);
  }
  return count ?? 0;
}

/**
 * Mark-all cannot be "read the capped page, then PATCH those ids" -- that
 * misses everything past the 100-row page, which is exactly the population
 * the badge fix exists for. This updates by predicate instead, so the client
 * never needs to know the ids.
 */
export async function markAllDashboardNotificationsRead(): Promise<number> {
  const context = await dashboardUserContext();
  const db = requireService();
  const { data, error } = await db.from("workspace_notifications").update({ read_at: new Date().toISOString() }).eq("workspace_id", context.workspaceId).eq("recipient_user_id", context.user.id).is("read_at", null).select("id");
  if (error) throw new AgentJoinError("Could not mark notifications read.", "NOTIFICATION_UPDATE_FAILED", 500);
  return data?.length ?? 0;
}

export async function markDashboardNotificationsRead(ids: string[]): Promise<number> {
  const context = await dashboardUserContext();
  if (ids.length === 0) return 0;
  const db = requireService();
  const { data, error } = await db.from("workspace_notifications").update({ read_at: new Date().toISOString() }).eq("workspace_id", context.workspaceId).eq("recipient_user_id", context.user.id).in("id", [...new Set(ids)].slice(0, 200)).is("read_at", null).select("id");
  if (error) throw new AgentJoinError("Could not mark notifications read.", "NOTIFICATION_UPDATE_FAILED", 500);
  return data?.length ?? 0;
}

// ---------------------------------------------------------------------------
// Channel workflow automation (Buzz-parity gap) — dashboard-scoped CRUD.
// Actual trigger evaluation happens in runChannelMessagePostedWorkflows
// above; these are the authoring/management endpoints a human uses from the
// Watchfloor to create, list, enable/disable, and delete workflow
// definitions for a channel they own.
// ---------------------------------------------------------------------------

export async function createDashboardChannelWorkflow(input: { conversationId: string; definitionYaml: string }): Promise<import("@/lib/mission/mission-workflow-store").ChannelWorkflowRecord> {
  const context = await dashboardUserContext();
  const conversation = await ownedConversation(context, input.conversationId);
  const { createChannelWorkflow } = await import("@/lib/mission/mission-workflow-store");
  return createChannelWorkflow({ workspaceId: conversation.workspace_id, conversationId: conversation.id, definitionYaml: input.definitionYaml, createdByUserId: context.user.id });
}

export async function listDashboardChannelWorkflows(conversationId: string): Promise<import("@/lib/mission/mission-workflow-store").ChannelWorkflowRecord[]> {
  const context = await dashboardUserContext();
  const conversation = await ownedConversation(context, conversationId);
  const { listChannelWorkflows } = await import("@/lib/mission/mission-workflow-store");
  return listChannelWorkflows(conversation.id, conversation.workspace_id);
}

export async function setDashboardChannelWorkflowEnabled(input: { conversationId: string; workflowId: string; enabled: boolean }): Promise<void> {
  const context = await dashboardUserContext();
  const conversation = await ownedConversation(context, input.conversationId);
  const { setChannelWorkflowEnabled } = await import("@/lib/mission/mission-workflow-store");
  await setChannelWorkflowEnabled(input.workflowId, conversation.workspace_id, input.enabled);
}

export async function deleteDashboardChannelWorkflow(input: { conversationId: string; workflowId: string }): Promise<void> {
  const context = await dashboardUserContext();
  const conversation = await ownedConversation(context, input.conversationId);
  const { deleteChannelWorkflow } = await import("@/lib/mission/mission-workflow-store");
  await deleteChannelWorkflow(input.workflowId, conversation.workspace_id);
}

// ---------------------------------------------------------------------------
// Moderation (Buzz-parity gap) — dashboard-scoped ban/mute/report actions.
// Enforcement itself lives in sendConversationMessage/sendDashboardConversationMessage above (assertMayPost).
// ---------------------------------------------------------------------------

export async function reportDashboardMessage(input: { conversationId: string; messageId: string; reason: string }): Promise<void> {
  const context = await dashboardUserContext();
  const conversation = await ownedConversation(context, input.conversationId);
  const { reportMessage } = await import("@/lib/moderation-service");
  await reportMessage({ workspaceId: conversation.workspace_id, conversationId: conversation.id, messageId: input.messageId, reporterUserId: context.user.id, reason: input.reason });
}

export async function listDashboardModerationReports(status?: "open" | "reviewed" | "dismissed"): Promise<import("@/lib/moderation-service").ModerationReport[]> {
  const context = await dashboardUserContext();
  const { listModerationReports } = await import("@/lib/moderation-service");
  return listModerationReports(context.workspaceId, status);
}

export async function resolveDashboardModerationReport(input: { reportId: string; status: "reviewed" | "dismissed" }): Promise<void> {
  const context = await dashboardUserContext();
  const { setReportStatus } = await import("@/lib/moderation-service");
  await setReportStatus(input.reportId, context.workspaceId, input.status, context.user.id);
}

export async function setDashboardModerationBan(input: { targetKind: "user" | "connection"; targetId: string; banned: boolean; reason?: string | null }): Promise<void> {
  const context = await dashboardUserContext();
  const { banTarget, unbanTarget } = await import("@/lib/moderation-service");
  if (input.banned) await banTarget({ workspaceId: context.workspaceId, targetKind: input.targetKind, targetId: input.targetId, reason: input.reason ?? null, bannedByUserId: context.user.id });
  else await unbanTarget({ workspaceId: context.workspaceId, targetKind: input.targetKind, targetId: input.targetId, unbannedByUserId: context.user.id });
}

export async function setDashboardModerationMute(input: { targetKind: "user" | "connection"; targetId: string; conversationId: string | null; muted: boolean; reason?: string | null }): Promise<void> {
  const context = await dashboardUserContext();
  const { muteTarget, unmuteTarget } = await import("@/lib/moderation-service");
  if (input.muted) await muteTarget({ workspaceId: context.workspaceId, targetKind: input.targetKind, targetId: input.targetId, conversationId: input.conversationId, reason: input.reason ?? null, mutedByUserId: context.user.id });
  else await unmuteTarget({ workspaceId: context.workspaceId, targetKind: input.targetKind, targetId: input.targetId, conversationId: input.conversationId, unmutedByUserId: context.user.id });
}

// ---------------------------------------------------------------------------
// Persona packs (Buzz-parity gap) — dashboard-scoped CRUD + assignment.
// ---------------------------------------------------------------------------

export async function createDashboardPersonaPack(manifestInput: unknown): Promise<import("@/lib/mission/persona-pack-store").PersonaPackRecord> {
  const context = await dashboardUserContext();
  const { createPersonaPack } = await import("@/lib/mission/persona-pack-store");
  return createPersonaPack({ workspaceId: context.workspaceId, manifestInput, createdByUserId: context.user.id });
}

export async function listDashboardPersonaPacks(): Promise<import("@/lib/mission/persona-pack-store").PersonaPackRecord[]> {
  const context = await dashboardUserContext();
  const { listPersonaPacks } = await import("@/lib/mission/persona-pack-store");
  return listPersonaPacks(context.workspaceId);
}

export async function deleteDashboardPersonaPack(id: string): Promise<void> {
  const context = await dashboardUserContext();
  const { deletePersonaPack } = await import("@/lib/mission/persona-pack-store");
  await deletePersonaPack(id, context.workspaceId);
}

export async function assignDashboardPersona(input: { agentKind: string; packId: string; personaName: string }): Promise<import("@/lib/mission/persona-pack-schema").PersonaDefinition> {
  const context = await dashboardUserContext();
  const { assignPersonaToAgentKind } = await import("@/lib/mission/persona-pack-store");
  return assignPersonaToAgentKind({ workspaceId: context.workspaceId, agentKind: input.agentKind, packId: input.packId, personaName: input.personaName, assignedByUserId: context.user.id });
}

export async function clearDashboardPersonaAssignment(agentKind: string): Promise<void> {
  const context = await dashboardUserContext();
  const { clearPersonaAssignment } = await import("@/lib/mission/persona-pack-store");
  await clearPersonaAssignment(context.workspaceId, agentKind);
}

export interface GithubRepoBinding {
  id: string;
  repoFullName: string;
  conversationId: string;
  conversationTopic: string;
  createdAt: string;
}

/** Repo->channel bindings for git-as-events (github-events-service.ts's webhook route reads these to route an incoming push/PR/review to the right channel). Owner-scoped through the RLS policy on github_repo_bindings, same as everything else under dashboardUserContext. */
export async function listDashboardGithubBindings(): Promise<GithubRepoBinding[]> {
  const context = await dashboardUserContext();
  const { data, error } = await context.auth
    .from("github_repo_bindings")
    .select("id, repo_full_name, conversation_id, agent_conversations(topic), created_at")
    .eq("workspace_id", context.workspaceId)
    .order("created_at", { ascending: false });
  // A genuine read failure used to look identical to "no bindings exist" --
  // silently hiding a real error from the settings UI that lists these.
  if (error) throw new AgentJoinError("Could not list repo bindings.", "BINDINGS_LIST_FAILED", 500);
  if (!data) return [];
  return (data as unknown as Array<{ id: string; repo_full_name: string; conversation_id: string; agent_conversations: { topic: string } | null; created_at: string }>).map((row) => ({
    id: row.id,
    repoFullName: row.repo_full_name,
    conversationId: row.conversation_id,
    conversationTopic: row.agent_conversations?.topic ?? "Channel",
    createdAt: row.created_at,
  }));
}

const REPO_FULL_NAME_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export async function createDashboardGithubBinding(input: { repoFullName: string; conversationId: string }): Promise<GithubRepoBinding> {
  const context = await dashboardUserContext();
  const repoFullName = input.repoFullName.trim();
  if (!REPO_FULL_NAME_PATTERN.test(repoFullName)) {
    throw new AgentJoinError("repoFullName must look like owner/repo.", "INVALID_REPO", 400);
  }
  await ownedConversation(context, input.conversationId);
  const db = requireService();
  const { data, error } = await db
    .from("github_repo_bindings")
    .insert({ workspace_id: context.workspaceId, repo_full_name: repoFullName, conversation_id: input.conversationId, created_by_user_id: context.user.id })
    .select("id, repo_full_name, conversation_id, created_at")
    .single();
  if (error || !data) {
    if (error?.code === "23505") throw new AgentJoinError("This repo is already bound to a channel.", "ALREADY_BOUND", 409);
    throw new AgentJoinError("Could not save the binding.", "BINDING_FAILED", 500);
  }
  return { id: data.id as string, repoFullName: data.repo_full_name as string, conversationId: data.conversation_id as string, conversationTopic: "", createdAt: data.created_at as string };
}

export async function deleteDashboardGithubBinding(id: string): Promise<void> {
  const context = await dashboardUserContext();
  const db = requireService();
  // The delete's own error was never checked -- this always reported success
  // to the caller even when the row was never actually removed.
  const { error } = await db.from("github_repo_bindings").delete().eq("id", id).eq("workspace_id", context.workspaceId);
  if (error) throw new AgentJoinError("Could not remove the binding.", "BINDING_DELETE_FAILED", 500);
}

export async function searchDashboardWorkspace(query: string): Promise<Array<{ message_id: string; conversation_id: string; topic: string; body: string; created_at: string }>> {
  const context = await dashboardUserContext();
  const q = query.replace(/[%_]/g, "").trim().slice(0, 160);
  if (!q) return [];
  const [{ data: bodyMessages, error: bodyError }, { data: topicMatches, error: topicError }, { data: agentMatches, error: agentError }] = await Promise.all([
    context.auth.from("conversation_messages").select("id, conversation_id, body, created_at").eq("workspace_id", context.workspaceId).ilike("body", `%${q}%`).order("created_at", { ascending: false }).limit(50),
    context.auth.from("agent_conversations").select("id, topic").eq("workspace_id", context.workspaceId).eq("status", "open").ilike("topic", `%${q}%`).limit(50),
    context.auth.from("agent_connections").select("id, agent_kind").eq("workspace_id", context.workspaceId).eq("status", "active").ilike("agent_kind", `%${q}%`).limit(50),
  ]);
  if (bodyError || topicError || agentError) {
    const error = bodyError || topicError || agentError;
    if (isMissingTableError(error)) throw migrationRequiredError();
    throw new AgentJoinError("Could not search workspace conversations.", "CONVERSATION_SEARCH_FAILED", 500);
  }
  const ids = new Set<string>((bodyMessages ?? []).map((row) => String(row.conversation_id)));
  for (const row of topicMatches ?? []) ids.add(String(row.id));
  const agentIds = (agentMatches ?? []).map((row) => String(row.id));
  if (agentIds.length > 0) {
    const { data: memberships, error: membershipError } = await context.auth.from("conversation_participants").select("conversation_id").eq("workspace_id", context.workspaceId).in("connection_id", agentIds);
    if (membershipError) throw new AgentJoinError("Could not search conversation participants.", "CONVERSATION_SEARCH_FAILED", 500);
    for (const row of memberships ?? []) ids.add(String(row.conversation_id));
  }
  if (ids.size === 0) return [];
  const { data: conversations, error: conversationsError } = await context.auth.from("agent_conversations").select("id, topic").eq("workspace_id", context.workspaceId).in("id", [...ids]);
  if (conversationsError) throw new AgentJoinError("Could not load searched conversations.", "CONVERSATION_SEARCH_FAILED", 500);
  const topicBy = new Map((conversations ?? []).map((row) => [String(row.id), String(row.topic)]));
  const { data: latestMessages, error: latestError } = await context.auth.from("conversation_messages")
    .select("id, conversation_id, body, created_at")
    .eq("workspace_id", context.workspaceId)
    .in("conversation_id", [...ids])
    .order("created_at", { ascending: false })
    .limit(100);
  if (latestError) throw new AgentJoinError("Could not load searched messages.", "CONVERSATION_SEARCH_FAILED", 500);
  const bodyIds = new Set((bodyMessages ?? []).map((row) => String(row.id)));
  const ordered = [...(bodyMessages ?? []), ...(latestMessages ?? []).filter((row) => !bodyIds.has(String(row.id)))];
  return ordered.slice(0, 100).map((row) => ({ message_id: row.id as string, conversation_id: row.conversation_id as string, topic: topicBy.get(String(row.conversation_id)) ?? "Channel", body: row.body as string, created_at: row.created_at as string }));
}
