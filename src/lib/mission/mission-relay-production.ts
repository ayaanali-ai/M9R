import { createSupabaseMissionBridgeStore } from "../bridge/bridge-store";
import { BRIDGE_PROTOCOL_VERSION } from "../bridge/bridge-protocol";
import {
  acknowledgeMissionMessageDelivery,
  getMission,
  getMissionAssignments,
  getMissionConversation,
  getMissionEvidence,
  getMissionExecutionStatus,
  getMissionMessageDeliveries,
  getMissionPlan,
  getMissionRuntimeActivity,
  postMissionMessage,
} from "./mission-application-service";
import type { MissionPrincipal } from "./mission-principal";
import { normalizeMissionRuntimeEvent } from "./mission-runtime-event";
import { createSupabaseMissionRuntimeEventJournal } from "./mission-runtime-event-store-supabase";
import { createSupabaseMissionUsageLedger } from "./mission-usage-store-supabase";
import { verifyMissionRelayToken } from "./mission-relay-token";
import type { MissionRelayAuthenticator, MissionRelayPrincipal } from "./mission-relay-auth";
import type { MissionRelayServiceOptions } from "./mission-relay-service";
import type { RelayFrame } from "./mission-relay-protocol";
import { PROVIDER_EVENT_TYPES, type ProviderEvent, type ProviderEventPayload, type ProviderEventType } from "./mission-provider-adapter";
import { supabase } from "../supabase";
import { containsActiveContent } from "../agent-join";
import { looksLikeSourceCode, SECRET_PATTERNS } from "../agent-run-core";
import type { WorkspaceTurnTimingEvent, WorkspaceTurnTimingStage, WorkspaceTurnTimingOutcome } from "../bridge/workspace-turn-timing";
import { decodeWorkspaceCursor, workspaceCursorFromMessage } from "./workspace-cursor";
import { findPendingEvidenceDecisionTarget, decideChatEvidenceRequestFromMessage } from "../bridge/chat-evidence-service";
import { buildBoundedWorkspaceSnapshot } from "./workspace-relay-snapshot";
import { idempotencyIdentityMatches } from "../conversation-idempotency";
import {
  agentAvailabilityUnknownNoticeBody,
  explicitlyMentionedAgentKinds,
  RECENT_CONNECTION_MAX_AGE_MS,
  unavailableAgentNoticeBody,
  unavailableExplicitAgentKinds,
} from "../conversation-routing";
import { scheduleShadowJudgment } from "../jev-shadow";
import { providerMention } from "../provider-adapter-config";

interface RelayProductionConfig {
  tokenSecret: string;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown, name: string, maxLength = 512): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) throw new Error(`${name} is invalid.`);
  return value.trim();
}

function optionalString(value: unknown, maxLength = 512): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) throw new Error("Optional relay field is invalid.");
  return value.trim();
}

const WORKSPACE_TIMING_STAGES: readonly WorkspaceTurnTimingStage[] = [
  "message.received",
  "message.enqueued",
  "session.ready",
  "ack.completed",
  "prompt.started",
  "provider.first_event",
  "turn.completed",
  "turn.failed",
  "turn.rejected",
  "report.observed",
  "fallback_report.posted",
];

const WORKSPACE_TIMING_OUTCOMES: readonly WorkspaceTurnTimingOutcome[] = ["ok", "failed", "observed", "not_observed", "rejected"];

function missionPrincipal(principal: MissionRelayPrincipal): MissionPrincipal {
  const human = principal.kind === "human";
  return {
    actor: { kind: human ? "human" : "agent", id: principal.id },
    workspaceId: principal.workspaceIds[0],
    kind: human ? "human" : "agent",
    userId: human ? principal.id : null,
    agent: null,
  };
}

function createAuthenticator(config: RelayProductionConfig): MissionRelayAuthenticator {
  return {
    async authenticate(input) {
      const expectedKind = input.kind === "browser" ? "human" : "bridge";
      const claims = verifyMissionRelayToken(input.credential, config.tokenSecret);
      if (claims) {
        if (claims.kind !== expectedKind || claims.workspaceId !== input.workspaceId) throw new Error("Relay credential is invalid or expired.");
        return { kind: claims.kind, id: claims.subject, workspaceIds: [claims.workspaceId] };
      }
      if (input.kind === "bridge") {
        const { authenticateAgent } = await import("../agent-join-service");
        const agent = await authenticateAgent(input.credential);
        if (agent && agent.workspaceId === input.workspaceId) {
          return { kind: "bridge", id: agent.connectionId, workspaceIds: [agent.workspaceId] };
        }
      }
      throw new Error("Relay credential is invalid or expired.");
    },
  };
}

async function loadSnapshot(input: { principal: MissionRelayPrincipal; workspaceId: string; missionId: string; cursor: string | null }): Promise<unknown> {
  const principal = missionPrincipal(input.principal);
  const [mission, conversation, activity, deliveries, assignments, plan, evidence, executions] = await Promise.all([
    getMission(principal, input.missionId),
    getMissionConversation(principal, input.missionId, { limit: 100, cursor: input.cursor }),
    getMissionRuntimeActivity(principal, input.missionId, { limit: 100 }),
    getMissionMessageDeliveries(principal, input.missionId, { limit: 100 }),
    getMissionAssignments(principal, input.missionId),
    getMissionPlan(principal, input.missionId),
    getMissionEvidence(principal, input.missionId),
    getMissionExecutionStatus(principal, input.missionId),
  ]);
  return { mission, conversation, activity, deliveries, assignments, plan, evidence, executions, cursor: input.cursor };
}

function postMessage(input: { principal: MissionRelayPrincipal; frame: RelayFrame }): Promise<unknown> {
  if (!input.frame.missionId) throw new Error("missionId is required for a Mission message.");
  const payload = object(input.frame.payload);
  if (!payload) throw new Error("Message payload must be an object.");
  const recipients = payload.recipientParticipantIds === "mission_broadcast"
    ? "mission_broadcast" as const
    : Array.isArray(payload.recipientParticipantIds)
      ? payload.recipientParticipantIds.map(String)
      : [];
  return postMissionMessage(missionPrincipal(input.principal), input.frame.missionId, {
    messageId: optionalString(payload.messageId, 256),
    senderParticipantId: stringValue(payload.senderParticipantId, "senderParticipantId", 256),
    recipientParticipantIds: recipients,
    assignmentId: optionalString(payload.assignmentId, 256),
    messageType: stringValue(payload.messageType, "messageType", 64),
    body: stringValue(payload.body, "body", 12_000),
    evidenceRefs: Array.isArray(payload.evidenceRefs) ? payload.evidenceRefs.map(String).slice(0, 32) : [],
    replyToMessageId: optionalString(payload.replyToMessageId, 256),
    structuredPayload: object(payload.structuredPayload) ?? {},
    clientRequestId: input.frame.idempotencyKey ?? input.frame.frameId,
    causationId: input.frame.causationId ?? null,
    correlationId: input.frame.correlationId,
  });
}

function providerEventFromFrame(frame: RelayFrame): { event: ProviderEvent; eventId: string; participantId: string; assignmentId: string | null } {
  const payload = object(frame.payload);
  const rawEvent = object(payload?.event);
  if (!payload || !rawEvent) throw new Error("Runtime event payload must include a structured provider event.");
  const eventType = stringValue(rawEvent.type, "event.type", 128) as ProviderEventType;
  if (!PROVIDER_EVENT_TYPES.includes(eventType)) throw new Error("Runtime event type is not supported.");
  const eventPayload = object(rawEvent.payload);
  if (!eventPayload || eventPayload.type !== eventType) throw new Error("Runtime event payload discriminator is invalid.");
  const eventId = stringValue(rawEvent.eventId ?? frame.frameId, "eventId", 512);
  const participantId = stringValue(payload.participantId, "participantId", 256);
  const assignmentId = optionalString(payload.assignmentId, 256);
  return {
    eventId,
    participantId,
    assignmentId,
    event: {
      type: eventType,
      executionId: stringValue(payload.executionId, "executionId", 256),
      adapterId: stringValue(rawEvent.adapterId, "adapterId", 128),
      providerSessionRef: optionalString(rawEvent.providerSessionRef, 256),
      correlationId: frame.correlationId,
      causationId: frame.causationId ?? null,
      timestamp: stringValue(rawEvent.timestamp, "event.timestamp", 64),
      rawEventRef: null,
      redactionStatus: "not_required",
      turnId: optionalString(rawEvent.turnId, 256),
      participantId,
      assignmentId,
      payload: eventPayload as unknown as ProviderEventPayload,
    },
  };
}

function workspaceTimingFromFrame(frame: RelayFrame): WorkspaceTurnTimingEvent {
  const payload = object(frame.payload);
  if (!payload || payload.schema !== "oathlock.workspace_timing.v1") throw new Error("Workspace timing payload schema is invalid.");
  const stage = stringValue(payload.stage, "stage", 64) as WorkspaceTurnTimingStage;
  if (!WORKSPACE_TIMING_STAGES.includes(stage)) throw new Error("Workspace timing stage is unsupported.");
  const source = stringValue(payload.source, "source", 16);
  if (source !== "relay" && source !== "poll") throw new Error("Workspace timing source is unsupported.");
  const outcome = optionalString(payload.outcome, 32) as WorkspaceTurnTimingOutcome | null;
  if (outcome && !WORKSPACE_TIMING_OUTCOMES.includes(outcome)) throw new Error("Workspace timing outcome is unsupported.");
  const atMs = payload.atMs;
  const elapsedMs = payload.elapsedMs;
  if (typeof atMs !== "number" || !Number.isSafeInteger(atMs) || atMs < 0) throw new Error("Workspace timing atMs is invalid.");
  if (typeof elapsedMs !== "number" || !Number.isSafeInteger(elapsedMs) || elapsedMs < 0) throw new Error("Workspace timing elapsedMs is invalid.");
  const bridgeInstanceId = optionalString(payload.bridgeInstanceId, 256);
  const sessionId = optionalString(payload.sessionId, 256);
  const provider = optionalString(payload.provider, 64);
  const event: WorkspaceTurnTimingEvent = {
    schema: "oathlock.workspace_timing.v1",
    timingId: stringValue(payload.timingId, "timingId", 128),
    eventId: stringValue(payload.eventId, "eventId", 256),
    correlationId: stringValue(payload.correlationId, "correlationId", 256),
    causationId: optionalString(payload.causationId, 256),
    workspaceId: stringValue(payload.workspaceId, "workspaceId", 256),
    conversationId: stringValue(payload.conversationId, "conversationId", 256),
    messageId: stringValue(payload.messageId, "messageId", 256),
    ...(bridgeInstanceId ? { bridgeInstanceId } : {}),
    ...(sessionId ? { sessionId } : {}),
    stage,
    atMs,
    elapsedMs,
    source,
    ...(provider ? { provider } : {}),
    ...(typeof payload.queueDepth === "number" ? { queueDepth: Math.max(0, Math.min(1_000_000, Math.trunc(payload.queueDepth))) } : {}),
    ...(typeof payload.batchSize === "number" ? { batchSize: Math.max(0, Math.min(1_000_000, Math.trunc(payload.batchSize))) } : {}),
    ...(optionalString(payload.providerEventType, 128) ? { providerEventType: optionalString(payload.providerEventType, 128)! } : {}),
    ...(outcome ? { outcome } : {}),
    ...(payload.ledger === true ? { ledger: true } : {}),
  };
  if (event.workspaceId !== frame.workspaceId || event.conversationId !== frame.channelId) throw new Error("Workspace timing scope does not match its relay frame.");
  return event;
}

async function receiveRuntimeEvent(input: { principal: MissionRelayPrincipal; frame: RelayFrame }): Promise<unknown | null> {
  const parsed = providerEventFromFrame(input.frame);
  const workspaceId = input.principal.workspaceIds[0];
  const normalized = normalizeMissionRuntimeEvent({
    event: parsed.event,
    workspaceId,
    missionId: stringValue(input.frame.missionId, "missionId", 256),
    executionId: parsed.event.executionId,
    participantId: parsed.participantId,
    assignmentId: parsed.assignmentId,
    eventId: parsed.eventId,
    correlationId: parsed.event.correlationId,
    causationId: parsed.event.causationId,
  });
  await createSupabaseMissionRuntimeEventJournal().append([normalized]);
  try {
    await createSupabaseMissionUsageLedger().appendFromRuntimeEvents([normalized]);
  } catch (error) {
    // The runtime journal remains authoritative for replay. Usage projection is
    // additive and must not make a provider response fail while its migration
    // is rolling out or while a transient ledger write is retried.
    console.error("Mission usage ledger projection failed.", error instanceof Error ? error.message : error);
  }
  return { eventId: normalized.eventId, eventType: normalized.eventType, summary: normalized.summary, activity: normalized.activity ?? null };
}

async function receiveWorkspaceTiming(input: { principal: MissionRelayPrincipal; frame: RelayFrame }): Promise<void> {
  const event = workspaceTimingFromFrame(input.frame);
  const { error } = await workspaceDb().from("workspace_turn_timing_events").upsert({
    workspace_id: event.workspaceId,
    conversation_id: event.conversationId,
    message_id: event.messageId,
    timing_id: event.timingId,
    event_id: event.eventId,
    correlation_id: event.correlationId,
    causation_id: event.causationId,
    bridge_instance_id: event.bridgeInstanceId ?? null,
    session_id: event.sessionId ?? null,
    provider: event.provider ?? null,
    stage: event.stage,
    source: event.source,
    at_ms: event.atMs,
    elapsed_ms: event.elapsedMs,
    metadata: {
      ...(event.queueDepth !== undefined ? { queueDepth: event.queueDepth } : {}),
      ...(event.batchSize !== undefined ? { batchSize: event.batchSize } : {}),
      ...(event.providerEventType ? { providerEventType: event.providerEventType } : {}),
      ...(event.outcome ? { outcome: event.outcome } : {}),
      ...(event.ledger === true ? { ledger: true } : {}),
    },
    occurred_at: new Date(event.atMs).toISOString(),
  }, { onConflict: "workspace_id,event_id", ignoreDuplicates: true });
  if (error) throw new Error("Workspace timing event could not be persisted.");
}

async function acknowledgeDelivery(input: { principal: MissionRelayPrincipal; frame: RelayFrame }): Promise<void> {
  if (!input.frame.missionId) throw new Error("missionId is required for delivery acknowledgement.");
  const payload = object(input.frame.payload);
  const deliveryId = stringValue(payload?.deliveryId, "deliveryId", 256);
  await acknowledgeMissionMessageDelivery(missionPrincipal(input.principal), input.frame.missionId, deliveryId);
}

async function receiveBridgeHeartbeat(input: { principal: MissionRelayPrincipal; frame: RelayFrame }): Promise<void> {
  const payload = object(input.frame.payload);
  if (!payload || payload.protocolVersion !== BRIDGE_PROTOCOL_VERSION || typeof payload.bridgeInstanceId !== "string" || !Array.isArray(payload.activeSessionIds)) throw new Error("Invalid Bridge heartbeat payload.");
  const store = createSupabaseMissionBridgeStore();
  const bridgeInstanceId = stringValue(payload.bridgeInstanceId, "bridgeInstanceId", 256);
  const workspaceId = input.principal.workspaceIds[0];
  const now = new Date().toISOString();
  const instance = await store.heartbeatInstance({ id: bridgeInstanceId, workspaceId, now });
  if (!instance) throw new Error("Bridge instance was not found or is not active.");
  await store.touchSessions({ bridgeInstanceId, workspaceId, sessionIds: payload.activeSessionIds.map(String).slice(0, 8), now });
}

function workspaceDb() {
  if (!supabase) throw new Error("Workspace relay persistence is not configured.");
  return supabase;
}

function workspaceBody(value: unknown): string {
  if (typeof value !== "string") throw new Error("Workspace message body is required.");
  const body = value.replace(/\s+/g, " ").trim();
  if (!body || body.length > 2_000) throw new Error("Workspace message body is invalid.");
  if (containsActiveContent(body) || looksLikeSourceCode(body) || /<script|javascript:|BEGIN (RSA|OPENSSH|PRIVATE) KEY/i.test(body)) throw new Error("Workspace message contains blocked active or secret-shaped content.");
  for (const [pattern] of SECRET_PATTERNS) {
    if (pattern.test(body)) throw new Error("Workspace message contains blocked active or secret-shaped content.");
    pattern.lastIndex = 0;
  }
  return body;
}

async function authorizeWorkspaceChannel(principal: MissionRelayPrincipal, workspaceId: string, channelId: string) {
  const db = workspaceDb();
  const { data: channel, error } = await db.from("agent_conversations")
    .select("id, workspace_id, topic, channel_slug, channel_kind, description, is_private, status")
    .eq("id", channelId).eq("workspace_id", workspaceId).eq("status", "open").maybeSingle();
  if (error || !channel) throw new Error("Workspace channel was not found.");
  if (principal.kind === "human") {
    const { data: project } = await db.from("projects").select("id").eq("id", workspaceId).eq("owner_id", principal.id).maybeSingle();
    if (!project) throw new Error("Workspace access was denied.");
  } else {
    const { data: connection } = await db.from("agent_connections").select("id").eq("id", principal.id).eq("workspace_id", workspaceId).eq("status", "active").maybeSingle();
    if (!connection) throw new Error("Agent workspace access was denied.");
    const { data: member } = await db.from("conversation_participants").select("connection_id").eq("workspace_id", workspaceId).eq("conversation_id", channelId).eq("connection_id", principal.id).maybeSingle();
    if (!member) throw new Error("Agent is not a member of this channel.");
  }
  return channel;
}

async function loadWorkspaceSnapshot(input: { principal: MissionRelayPrincipal; workspaceId: string; channelId: string; cursor: string | null }): Promise<unknown> {
  const db = workspaceDb();
  const channel = await authorizeWorkspaceChannel(input.principal, input.workspaceId, input.channelId);
  const cursor = decodeWorkspaceCursor(input.cursor);
  if (input.cursor && !cursor) throw new Error("Workspace cursor is invalid.");
  let messagesQuery = db.from("conversation_messages")
    .select("id, conversation_id, sender_connection_id, sender_user_id, sender_display_name, recipient_connection_id, kind, body, outcome, created_at, spawned_run_id, related_run_id, parent_message_id, edited_at, deleted_at, correlation_id")
    .eq("workspace_id", input.workspaceId).eq("conversation_id", input.channelId);
  // A direct agent handoff is private to its recipient and sender. Keep the
  // durable reconnect snapshot under the same visibility rule as live relay
  // fan-out; otherwise a reconnect could disclose another agent's targeted
  // message even though the live socket correctly filtered it.
  if (input.principal.kind === "bridge") {
    messagesQuery = messagesQuery.or(`recipient_connection_id.is.null,recipient_connection_id.eq.${input.principal.id},sender_connection_id.eq.${input.principal.id}`);
  }
  // A first subscription establishes a durable high-water mark. Historical
  // chat is already loaded through the dashboard HTTP projection, and sending
  // it over the 8 KB relay frame would make a busy channel unconnectable.
  const initialBaseline = !cursor;
  messagesQuery = messagesQuery
    .order("created_at", { ascending: !initialBaseline }).order("id", { ascending: !initialBaseline })
    .limit(initialBaseline ? 1 : 100);
  // A reconnect resumes from the ordered (created_at, id) tuple. Timestamp
  // alone is not a cursor: Postgres can legitimately assign the same
  // timestamp to multiple messages, and a timestamp-only `gt` skips siblings.
  if (cursor?.messageId) {
    messagesQuery = messagesQuery.or(`created_at.gt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.gt.${cursor.messageId})`);
  } else if (cursor) {
    messagesQuery = messagesQuery.gte("created_at", cursor.createdAt);
  }
  const [{ data: rawMessages }, { data: reactions }, { data: participants }, { data: activity }] = await Promise.all([
    messagesQuery,
    db.from("conversation_message_reactions").select("id, message_id, emoji, actor_user_id, actor_connection_id").eq("workspace_id", input.workspaceId).eq("conversation_id", input.channelId).order("created_at", { ascending: true }),
    db.from("conversation_participants").select("connection_id").eq("workspace_id", input.workspaceId).eq("conversation_id", input.channelId),
    db.from("mission_runtime_events").select("id, mission_id, execution_id, participant_id, event_type, occurred_at, summary, activity").eq("workspace_id", input.workspaceId).not("activity", "is", null).order("occurred_at", { ascending: false }).limit(80),
  ]);
  const reactionsBy = new Map<string, unknown[]>();
  for (const reaction of reactions ?? []) reactionsBy.set(reaction.message_id, [...(reactionsBy.get(reaction.message_id) ?? []), reaction]);
  const messages = (rawMessages ?? []).map((message) => ({ ...message, reactions: reactionsBy.get(message.id) ?? [] }));
  const messagesToDeliver = initialBaseline ? [] : messages;
  const bounded = buildBoundedWorkspaceSnapshot({
    conversation: channel,
    messages: messagesToDeliver,
    participants: (participants ?? []).map((row) => row.connection_id),
    activity: (activity ?? []) as Record<string, unknown>[],
    cursor: input.cursor,
    incremental: Boolean(input.cursor),
  });
  return {
    ...bounded,
    // For the baseline, advance to the newest stored message without replaying
    // history. For incremental pages, advance only to the last message that
    // actually fit so a later reconnect can continue the backlog safely.
    cursor: initialBaseline
      ? messages[0] ? workspaceCursorFromMessage(messages[0] as { created_at: string; id: string }) : input.cursor
      : bounded.messages.at(-1) ? workspaceCursorFromMessage(bounded.messages.at(-1) as { created_at: string; id: string }) : input.cursor,
  };
}

async function postWorkspaceMessage(input: { principal: MissionRelayPrincipal; frame: RelayFrame }): Promise<unknown> {
  if (!input.frame.channelId) throw new Error("channelId is required for a workspace message.");
  const channel = await authorizeWorkspaceChannel(input.principal, input.frame.workspaceId, input.frame.channelId);
  const payload = object(input.frame.payload) ?? {};
  const body = workspaceBody(payload.body);
  const parentMessageId = optionalString(payload.parentMessageId, 256);
  const recipientConnectionId = optionalString(payload.recipientConnectionId ?? payload.recipient_connection_id, 256);
  const idempotencyKey = optionalString(input.frame.idempotencyKey, 256);
  const kind = payload.kind === undefined || payload.kind === null
    ? "message"
    : typeof payload.kind === "string" && ["message", "handoff", "ack", "result", "notice"].includes(payload.kind)
      ? payload.kind
      : (() => { throw new Error("Workspace message kind is invalid."); })();
  const outcome = payload.outcome === undefined || payload.outcome === null
    ? null
    : typeof payload.outcome === "string" && ["ok", "failed", "incomplete"].includes(payload.outcome)
      ? payload.outcome
      : (() => { throw new Error("Workspace message outcome is invalid."); })();
  const db = workspaceDb();
  if (parentMessageId) {
    const { data: parent } = await db.from("conversation_messages").select("id").eq("id", parentMessageId).eq("workspace_id", input.frame.workspaceId).eq("conversation_id", input.frame.channelId).maybeSingle();
    if (!parent) throw new Error("parentMessageId must belong to this channel.");
  }
  if (recipientConnectionId) {
    if (input.principal.kind === "bridge" && recipientConnectionId === input.principal.id) throw new Error("recipientConnectionId must identify another active agent.");
    const { data: target } = await db.from("agent_connections").select("id").eq("id", recipientConnectionId).eq("workspace_id", input.frame.workspaceId).eq("status", "active").maybeSingle();
    if (!target) throw new Error("recipientConnectionId must identify an active agent in this workspace.");
    const { data: member } = await db.from("conversation_participants").select("connection_id").eq("workspace_id", input.frame.workspaceId).eq("conversation_id", input.frame.channelId).eq("connection_id", recipientConnectionId).maybeSingle();
    if (!member) throw new Error("recipientConnectionId must identify an agent in this channel.");
  }
  // Confirmed live: a human typing "Approved." (exactly what the agent's own
  // instructions ask for) into this channel did nothing, while the inline
  // card's button worked -- because the button's decision goes through the
  // dashboard HTTP route, sendDashboardConversationMessage, which has always
  // run findPendingEvidenceDecisionTarget/decideChatEvidenceRequestFromMessage.
  // This relay path is what actually persists a message whenever the live
  // connection is up (the normal case, not a fallback) and never called
  // either -- a real human message was silently never even checked for
  // approval language. Same two calls, same place in the flow, human
  // principals only: an agent's own reply must never self-approve its
  // request via this path.
  const evidenceDecisionTarget = input.principal.kind === "human"
    ? await findPendingEvidenceDecisionTarget({
        workspaceId: input.frame.workspaceId,
        conversationId: channel.id,
        body,
        parentMessageId: parentMessageId ?? null,
      }).catch((decisionError) => {
        console.warn(`Evidence request target lookup failed for conversation ${channel.id}:`, decisionError instanceof Error ? decisionError.message : decisionError);
        return null;
      })
    : null;
  let dmRecipientConnectionId: string | null = null;
  if (input.principal.kind === "human" && !evidenceDecisionTarget && channel.channel_kind === "dm") {
    const { data: participant } = await db.from("conversation_participants")
      .select("connection_id")
      .eq("workspace_id", input.frame.workspaceId)
      .eq("conversation_id", channel.id)
      .limit(1)
      .maybeSingle();
    dmRecipientConnectionId = (participant?.connection_id as string | undefined) ?? null;
    if (!dmRecipientConnectionId) throw new Error("Direct-message recipient is unavailable.");
  }
  const effectiveRecipientConnectionId = recipientConnectionId ?? evidenceDecisionTarget?.agentConnectionId ?? dmRecipientConnectionId;
  const senderConnectionId = input.principal.kind === "bridge" ? input.principal.id : null;
  const senderUserId = input.principal.kind === "human" ? input.principal.id : null;
  const ensureAvailabilityNotice = async (messageId: string): Promise<Record<string, unknown> | null> => {
    if (input.principal.kind !== "human") return null;
    const noticeIdempotencyKey = `agent-availability:${messageId}`;
    // Recover a notice that was already durably inserted before a relay
    // response was lost. Availability may have changed by the time the
    // idempotent replay arrives, but the original warning still needs to be
    // replayed to the live browser once.
    const { data: existingNotice } = await db.from("conversation_messages")
      .select("id, conversation_id, sender_connection_id, sender_user_id, sender_display_name, recipient_connection_id, kind, body, outcome, created_at, spawned_run_id, related_run_id, parent_message_id, edited_at, deleted_at, correlation_id, idempotency_key")
      .eq("workspace_id", input.frame.workspaceId)
      .eq("idempotency_key", noticeIdempotencyKey)
      .maybeSingle();
    if (existingNotice) return { ...existingNotice, reactions: [] };
    // The live browser normally reaches this relay path, while the older
    // dashboard HTTP path has its own equivalent check. Keep the diagnostic
    // here too: a saved human message must never look successful while every
    // named provider is missing, stale, or absent from this channel.
    const [{ data: connections, error: connectionsError }, { data: participants, error: participantsError }] = await Promise.all([
      db.from("agent_connections")
        .select("id, agent_kind, status, last_seen_at")
        .eq("workspace_id", input.frame.workspaceId)
        .eq("status", "active"),
      db.from("conversation_participants")
        .select("connection_id")
        .eq("workspace_id", input.frame.workspaceId)
        .eq("conversation_id", channel.id),
    ]);
    let noticeBody: string | null = null;
    if (connectionsError || participantsError) {
      console.warn(`Agent availability lookup failed for conversation ${channel.id}:`, connectionsError?.message ?? participantsError?.message);
      noticeBody = agentAvailabilityUnknownNoticeBody();
    } else {
      const memberIds = new Set((participants ?? []).map((row) => String(row.connection_id)));
      const rows = (connections ?? []).map((row) => ({ ...row, is_channel_member: memberIds.has(String(row.id)) }));
      const unavailable = unavailableExplicitAgentKinds(body, rows);
      if (unavailable.length > 0) noticeBody = unavailableAgentNoticeBody(unavailable);
      // Shadow-mode Jev judgment (off unless M9R_JEV_MODE is set). The live browser reaches this path,
      // not the dashboard HTTP route, so it needs its own hook; it only logs and never changes routing.
      const nowMs = Date.now();
      scheduleShadowJudgment({
        messageId,
        workspaceId: input.frame.workspaceId,
        conversationId: channel.id,
        source: "relay",
        body,
        agents: rows
          .filter((row) => row.agent_kind)
          .map((row) => ({
            kind: providerMention(String(row.agent_kind)),
            connected: Number.isFinite(Date.parse(String(row.last_seen_at ?? ""))) && nowMs - Date.parse(String(row.last_seen_at)) <= RECENT_CONNECTION_MAX_AGE_MS,
            isChannelMember: row.is_channel_member,
          })),
        actualMentionedKinds: explicitlyMentionedAgentKinds(body, rows),
      });
    }
    if (!noticeBody) return null;
    const noticeInsert = {
      workspace_id: input.frame.workspaceId,
      conversation_id: channel.id,
      sender_user_id: null,
      sender_connection_id: null,
      sender_display_name: "M9R",
      sender_kind: "system",
      recipient_connection_id: null,
      kind: "notice",
      body: noticeBody,
      parent_message_id: messageId,
      correlation_id: null,
      idempotency_key: noticeIdempotencyKey,
      outcome: null,
    };
    const { data: notice, error: noticeError } = await db.from("conversation_messages")
      .insert(noticeInsert)
      .select("id, conversation_id, sender_connection_id, sender_user_id, sender_display_name, recipient_connection_id, kind, body, outcome, created_at, spawned_run_id, related_run_id, parent_message_id, edited_at, deleted_at, correlation_id, idempotency_key")
      .single();
    if (notice) return { ...notice, reactions: [] };
    if (noticeError?.code === "23505") {
      // A retry of the same human post may race this diagnostic insert. The
      // unique idempotency key is the authority; recover the existing notice
      // so a replay still returns the warning to the live relay publisher.
      const { data: existingNotice } = await db.from("conversation_messages")
        .select("id, conversation_id, sender_connection_id, sender_user_id, sender_display_name, recipient_connection_id, kind, body, outcome, created_at, spawned_run_id, related_run_id, parent_message_id, edited_at, deleted_at, correlation_id, idempotency_key")
        .eq("workspace_id", input.frame.workspaceId)
        .eq("idempotency_key", noticeInsert.idempotency_key)
        .maybeSingle();
      if (existingNotice) return { ...existingNotice, reactions: [] };
    } else if (noticeError) {
      console.warn(`Agent availability notice failed for conversation ${channel.id}:`, noticeError.message);
    }
    return null;
  };
  if (idempotencyKey) {
    const { data: existing, error: existingError } = await db.from("conversation_messages")
      .select("id, conversation_id, sender_connection_id, sender_user_id, sender_display_name, recipient_connection_id, kind, body, outcome, created_at, spawned_run_id, related_run_id, parent_message_id, edited_at, deleted_at, correlation_id, idempotency_key")
      .eq("workspace_id", input.frame.workspaceId).eq("idempotency_key", idempotencyKey).maybeSingle();
    if (existingError) throw new Error("Workspace message idempotency lookup failed.");
    if (existing) {
      if (!idempotencyIdentityMatches(existing as Record<string, unknown>, {
        conversationId: channel.id,
        senderConnectionId,
        senderUserId,
        recipientConnectionId: effectiveRecipientConnectionId,
        kind,
        body,
        parentMessageId,
        outcome,
      })) throw new Error("idempotencyKey is already used by another message.");
      const availabilityNotice = await ensureAvailabilityNotice(String(existing.id));
      return { message: { ...existing, reactions: [] }, messages: availabilityNotice ? [availabilityNotice] : [], activity: [], cursor: workspaceCursorFromMessage(existing), idempotentReplay: true };
    }
  }
  const insert = {
    workspace_id: input.frame.workspaceId,
    conversation_id: channel.id,
    sender_connection_id: senderConnectionId,
    sender_user_id: senderUserId,
    sender_display_name: input.principal.kind === "human" ? "You" : null,
    sender_kind: input.principal.kind === "human" ? "user" : "connection",
    recipient_connection_id: effectiveRecipientConnectionId,
    kind,
    body,
    parent_message_id: parentMessageId,
    correlation_id: input.frame.correlationId,
    idempotency_key: idempotencyKey,
    outcome,
  };
  const { data: message, error } = await db.from("conversation_messages").insert(insert).select("id, conversation_id, sender_connection_id, sender_user_id, sender_display_name, recipient_connection_id, kind, body, outcome, created_at, spawned_run_id, related_run_id, parent_message_id, edited_at, deleted_at, correlation_id, idempotency_key").single();
  if (error || !message) {
    // Two reconnect attempts can race after both miss the initial lookup. The
    // unique index is the authority; resolve its conflict back to the
    // original row instead of turning a successful post into a false error.
    if (idempotencyKey && error?.code === "23505") {
      const { data: existing } = await db.from("conversation_messages")
        .select("id, conversation_id, sender_connection_id, sender_user_id, sender_display_name, recipient_connection_id, kind, body, outcome, created_at, spawned_run_id, related_run_id, parent_message_id, edited_at, deleted_at, correlation_id, idempotency_key")
        .eq("workspace_id", input.frame.workspaceId).eq("idempotency_key", idempotencyKey).maybeSingle();
      if (existing && idempotencyIdentityMatches(existing as Record<string, unknown>, {
        conversationId: channel.id,
        senderConnectionId,
        senderUserId,
        recipientConnectionId: effectiveRecipientConnectionId,
        kind,
        body,
        parentMessageId,
        outcome,
      })) {
        const availabilityNotice = await ensureAvailabilityNotice(String(existing.id));
        return { message: { ...existing, reactions: [] }, messages: availabilityNotice ? [availabilityNotice] : [], activity: [], cursor: workspaceCursorFromMessage(existing), idempotentReplay: true };
      }
      if (existing) throw new Error("idempotencyKey is already used by another message.");
    }
    throw new Error("Workspace message could not be saved.");
  }
  const availabilityNotice = await ensureAvailabilityNotice(String(message.id));
  if (input.principal.kind === "bridge") {
    const { data: project } = await db.from("projects").select("owner_id").eq("id", input.frame.workspaceId).maybeSingle();
    if (project?.owner_id) await db.from("workspace_notifications").upsert({ workspace_id: input.frame.workspaceId, recipient_user_id: project.owner_id, conversation_id: channel.id, message_id: message.id, kind: "agent_activity", title: "Agent activity", body: body.slice(0, 2048), payload: { channelId: channel.id } }, { onConflict: "recipient_user_id,message_id,kind", ignoreDuplicates: true });
  }
  if (input.principal.kind === "human") {
    // A normal chat message stays a normal message. Only explicit approval
    // language against a pending evidence request changes its state; a
    // missing or unmigrated evidence table must never block the message.
    await decideChatEvidenceRequestFromMessage({
      workspaceId: input.frame.workspaceId,
      conversationId: channel.id,
      decidedByUserId: input.principal.id,
      decisionMessageId: String(message.id),
      parentMessageId: parentMessageId ?? null,
      body,
      requestId: evidenceDecisionTarget?.requestId ?? null,
    }).catch((decisionError) => {
      console.warn(`Evidence request decision check failed for conversation ${channel.id}:`, decisionError instanceof Error ? decisionError.message : decisionError);
    });

    // Task negotiation (item 5): a human naming 2+ agents in ONE message is
    // a team task -- one agent proposes the split, the rest are held until
    // they get their own sub-task.
    //
    // This lives here as well as in sendDashboardConversationMessage for the
    // exact reason documented above for evidence decisions: THIS relay path
    // is what actually persists a human's message whenever the live
    // connection is up, which is the normal case, not a fallback. A trigger
    // wired only into the dashboard HTTP path silently never runs -- caught
    // live here (the message persisted, no contract opened), the same shape
    // of bug that comment describes.
    await (async () => {
      // Imported lazily: conversation-service reaches supabase/server, which
      // imports next/headers. Pulling that into this module's load-time graph
      // breaks every plain-Node consumer of the relay (its own test suite
      // included), even though the code path itself is fine.
      const [{ agentMentionNames, containsAgentMention }, { isRecentlySeenConnection }] = await Promise.all([
        import("../conversation-service"),
        import("../agent-dashboard-presenter"),
      ]);
      const { data: connections } = await db.from("agent_connections")
        .select("id, agent_kind, last_seen_at")
        .eq("workspace_id", input.frame.workspaceId)
        .eq("status", "active");
      const normalizedBody = body.toLowerCase();
      const mentioned = (connections ?? []).filter((row) => {
        if (!isRecentlySeenConnection({ last_seen_at: row.last_seen_at as string | null })) return false;
        return agentMentionNames(String(row.agent_kind)).some((name) => name && containsAgentMention(normalizedBody, name));
      });
      if (mentioned.length < 2) return;
      // "First mentioned" means first in the human's own sentence, not
      // whichever row the database happened to return first -- writing
      // "@claude-code @codex ..." should make Claude the decomposer.
      const earliestMentionIndex = (agentKind: string): number => {
        const positions = agentMentionNames(String(agentKind))
          .map((name) => (name ? normalizedBody.indexOf(name) : -1))
          .filter((index) => index >= 0);
        return positions.length > 0 ? Math.min(...positions) : Number.MAX_SAFE_INTEGER;
      };
      const decomposer = [...mentioned].sort((left, right) => earliestMentionIndex(String(left.agent_kind)) - earliestMentionIndex(String(right.agent_kind)))[0];
      const { openTaskContractForMultiMention } = await import("@/lib/bridge/task-contract-service");
      await openTaskContractForMultiMention({
        workspaceId: input.frame.workspaceId,
        conversationId: channel.id,
        anchorMessageId: String(message.id),
        decomposerConnectionId: String(decomposer.id),
      });
    })().catch((contractError) => {
      // Additive: never breaks the human's message.
      console.warn(`Task contract open failed for conversation ${channel.id}:`, contractError instanceof Error ? contractError.message : contractError);
    });
  }
  return {
    message: { ...message, reactions: [] },
    // The relay service publishes these as additional workspace.event frames
    // so the browser sees an availability diagnostic immediately, without a
    // refresh. The persisted row remains the source of truth on reconnect.
    messages: availabilityNotice ? [availabilityNotice] : [],
    activity: [],
    cursor: workspaceCursorFromMessage(message),
  };
}

/**
 * Looked up by the agent's real, DB-stable connection id (agent_connections.id
 * -- what the relay stores as a pty's ownerParticipantId), never the relay's
 * own transient per-socket id, which no database row could ever match. A
 * human's browser is always a separate live connection from their agent's
 * own socket, so this is the one lookup that answers "does this agent
 * connection belong to that human" -- letting "the owner" mean the person,
 * not just the bridge process no human ever holds a socket for.
 */
async function resolvePtyOwnerHuman(agentConnectionId: string): Promise<string | null> {
  const db = workspaceDb();
  const { data } = await db.from("agent_connections").select("created_by").eq("id", agentConnectionId).maybeSingle();
  return (data?.created_by as string | null) ?? null;
}

export function createProductionMissionRelayOptions(config: RelayProductionConfig): MissionRelayServiceOptions {
  return {
    authenticator: createAuthenticator(config),
    loadMissionSnapshot: loadSnapshot,
    loadWorkspaceSnapshot,
    postMessage,
    postWorkspaceMessage,
    receiveWorkspaceTiming,
    acknowledgeDelivery,
    receiveRuntimeEvent,
    receiveBridgeHeartbeat,
    resolvePtyOwnerHuman,
  };
}
