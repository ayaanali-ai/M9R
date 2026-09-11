/**
 * Chat-native evidence lifecycle:
 *
 *   request -> human approves in-channel -> structured evidence submitted ->
 *   human reviews the actual facts -> approved evidence is retained.
 *
 * This is deliberately NOT the full terminal-run rules/evidence-draft/
 * Run-Passport pipeline. It is the bounded chat alternative for mention-
 * triggered ACP sessions, which still need a real evidence path.
 */

import { supabase } from "@/lib/supabase";
import type { AuthedAgent } from "@/lib/agent-join-service";
import {
  classifyEvidenceRequestDecision,
  evidenceDecisionMention,
  parseChatEvidenceContract,
  renderChatEvidenceMessage,
  type ChatEvidenceContract,
} from "@/lib/bridge/chat-evidence-contract";
import { MissionApiError } from "@/lib/mission/mission-application-errors";
import { recordMissionEvidence } from "@/lib/mission/mission-application-service";
import { missionAgentParticipantId, missionOwnerParticipantId } from "@/lib/mission/mission-channel-binding";

/**
 * Distinguishes expected, caller-facing rejections (bad input, no matching
 * approved request, already decided, wrong participant) from genuine
 * internal/DB failures. Without this, every throw in this file -- including
 * ones an agent needs to actually read and react to -- collapsed into the
 * same opaque "Internal server error." 500 in handleAgentError, which is
 * exactly what made a real connection-id mismatch indistinguishable from a
 * server crash when an agent hit this (see chat-evidence-request-gate
 * migration's design intent: the human-approval gate is supposed to be
 * legible, not a black box).
 */
export class ChatEvidenceError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "ChatEvidenceError";
    this.code = code;
    this.status = status;
  }
}

export type ChatEvidenceRequestStatus = "pending" | "approved" | "rejected" | "expired";

export interface ChatEvidenceSubmission {
  id: string;
  workspaceId: string;
  conversationId: string;
  requestId: string | null;
  messageId: string | null;
  provider: string | null;
  summary: string;
  evidence: ChatEvidenceContract | null;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
}

export interface ChatEvidenceRequest {
  id: string;
  workspaceId: string;
  conversationId: string;
  agentConnectionId: string;
  provider: string | null;
  requestSummary: string;
  requestMessageId: string | null;
  status: ChatEvidenceRequestStatus;
  decisionMessageId: string | null;
  createdAt: string;
}

export interface PendingEvidenceDecisionTarget {
  requestId: string;
  agentConnectionId: string;
}

function requireService() {
  if (!supabase) throw new Error("M9R backend is not configured.");
  return supabase;
}

const SUBMISSION_COLUMNS = "id, workspace_id, conversation_id, request_id, message_id, provider, summary, evidence, status, created_at";
const REQUEST_COLUMNS = "id, workspace_id, conversation_id, agent_connection_id, provider, request_summary, request_message_id, status, decision_message_id, created_at";

/** Stable cross-store identity: a chat submission can be retried without creating a second Mission record. */
export function missionEvidenceIdForChatSubmission(submissionId: string): string {
  return `chat-evidence:${submissionId}`;
}

/** Human-readable, bounded provenance source for the canonical Mission evidence record. */
export function buildMissionEvidenceSource(submissionId: string, evidence: ChatEvidenceContract): string {
  return `Chat evidence submission ${submissionId}\n${renderChatEvidenceMessage(evidence)}`.slice(0, 2048);
}

function isMissingOptionalBindingError(error: { code?: string | null; message?: string | null } | null): boolean {
  return Boolean(error && (
    error.code === "42703" ||
    error.code === "PGRST204" ||
    /column .*mission_id.*does not exist|schema cache.*mission_id/i.test(error.message ?? "")
  ));
}

async function boundMissionId(db: NonNullable<typeof supabase>, workspaceId: string, conversationId: string): Promise<string | null> {
  const { data, error } = await db
    .from("agent_conversations")
    .select("mission_id")
    .eq("workspace_id", workspaceId)
    .eq("id", conversationId)
    .maybeSingle();
  if (error) {
    if (isMissingOptionalBindingError(error)) return null;
    throw new Error(`Could not resolve the conversation Mission binding: ${error.message}`);
  }
  return typeof data?.mission_id === "string" && data.mission_id.trim() ? data.mission_id : null;
}

async function requireConversationParticipant(
  db: NonNullable<typeof supabase>,
  workspaceId: string,
  conversationId: string,
  agentConnectionId: string,
): Promise<void> {
  const { data: conversation, error: conversationError } = await db
    .from("agent_conversations")
    .select("status")
    .eq("workspace_id", workspaceId)
    .eq("id", conversationId)
    .maybeSingle();
  if (conversationError) throw new Error(`Could not verify the evidence request conversation: ${conversationError.message}`);
  if (!conversation) throw new ChatEvidenceError("Evidence review requires an existing conversation.", "CONVERSATION_NOT_FOUND", 404);
  if (conversation.status !== "open") throw new ChatEvidenceError("Evidence review cannot be requested in a closed conversation.", "CONVERSATION_CLOSED", 409);
  const { data, error } = await db
    .from("conversation_participants")
    .select("connection_id")
    .eq("workspace_id", workspaceId)
    .eq("conversation_id", conversationId)
    .eq("connection_id", agentConnectionId)
    .maybeSingle();
  if (error) throw new Error(`Could not verify the evidence request participant: ${error.message}`);
  if (!data) throw new ChatEvidenceError("Evidence review requires the agent to be a participant in this conversation.", "NOT_A_PARTICIPANT", 403);
}

function missionAgentPrincipal(agent: AuthedAgent) {
  return {
    actor: { kind: "agent" as const, id: agent.connectionId },
    workspaceId: agent.workspaceId,
    kind: "agent" as const,
    userId: null,
    agent,
  };
}

async function recordCanonicalChatEvidence(input: {
  workspaceId: string;
  conversationId: string;
  agent: AuthedAgent;
  provider: string | null;
  submissionId: string;
  evidence: ChatEvidenceContract;
}): Promise<{ missionId: string; evidenceId: string } | null> {
  const db = requireService();
  const missionId = await boundMissionId(db, input.workspaceId, input.conversationId);
  // Intentional, not a gap: a conversation with no real Mission binding has
  // no canonical Mission evidence stream to write into. chat_evidence_submissions
  // (already written above by the caller) plus its inline Watchfloor card remain
  // the real, human-facing evidence surface for chat-triggered work regardless of
  // Mission-binding -- this canonical mirror is additive, not the source of truth.
  if (!missionId) return null;
  const evidenceId = missionEvidenceIdForChatSubmission(input.submissionId);
  try {
    await recordMissionEvidence(missionAgentPrincipal(input.agent), missionId, {
      evidenceId,
      producerParticipantId: missionAgentParticipantId(missionId, input.agent.connectionId),
      producerKind: "agent",
      provider: input.provider,
      kind: "review_evidence",
      source: buildMissionEvidenceSource(input.submissionId, input.evidence),
      lifecycle: "captured",
      availability: "available",
      clientRequestId: `${evidenceId}:capture`,
    });
  } catch (error) {
    if (!(error instanceof MissionApiError) || error.code !== "evidence_already_exists") throw error;
  }
  return { missionId, evidenceId };
}

function toRecord(row: Record<string, unknown>): ChatEvidenceSubmission {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    conversationId: String(row.conversation_id),
    requestId: (row.request_id as string | null) ?? null,
    messageId: (row.message_id as string | null) ?? null,
    provider: (row.provider as string | null) ?? null,
    summary: String(row.summary),
    evidence: (row.evidence as ChatEvidenceContract | null) ?? null,
    status: row.status as ChatEvidenceSubmission["status"],
    createdAt: String(row.created_at),
  };
}

/** Create the explicit in-channel consent request. */
export async function requestChatEvidenceReview(input: {
  workspaceId: string;
  conversationId: string;
  agentConnectionId: string;
  provider?: string | null;
  summary: string;
  idempotencyKey?: string | null;
}): Promise<{ id: string; created: boolean; status: ChatEvidenceRequestStatus }> {
  const db = requireService();
  await requireConversationParticipant(db, input.workspaceId, input.conversationId, input.agentConnectionId);
  const idempotencyKey = input.idempotencyKey?.trim() || null;
  if (idempotencyKey && idempotencyKey.length > 256) throw new ChatEvidenceError("Evidence request idempotency key exceeds 256 characters.", "BAD_INPUT", 400);
  if (idempotencyKey) {
    const { data: existing, error: existingError } = await db.from("chat_evidence_requests")
      .select("id, conversation_id, agent_connection_id, status")
      .eq("workspace_id", input.workspaceId)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (existingError) throw new Error(`Could not check for an existing evidence request: ${existingError.message}`);
    if (existing) {
      if (existing.conversation_id !== input.conversationId || existing.agent_connection_id !== input.agentConnectionId) throw new ChatEvidenceError("Evidence request idempotency key is already used by another request.", "IDEMPOTENCY_KEY_CONFLICT", 409);
      return { id: String(existing.id), created: false, status: existing.status as ChatEvidenceRequestStatus };
    }
  }
  const { data, error } = await db.from("chat_evidence_requests").insert({
    workspace_id: input.workspaceId,
    conversation_id: input.conversationId,
    agent_connection_id: input.agentConnectionId,
    provider: input.provider ?? null,
    request_summary: input.summary.slice(0, 500),
    idempotency_key: idempotencyKey,
  }).select("id").single();
  if (error || !data) {
    if (idempotencyKey && error?.code === "23505") {
      const { data: existing } = await db.from("chat_evidence_requests").select("id, conversation_id, agent_connection_id, status").eq("workspace_id", input.workspaceId).eq("idempotency_key", idempotencyKey).maybeSingle();
      if (existing && existing.conversation_id === input.conversationId && existing.agent_connection_id === input.agentConnectionId) return { id: String(existing.id), created: false, status: existing.status as ChatEvidenceRequestStatus };
    }
    throw new Error(`Could not request evidence review: ${error?.message ?? "unknown error"}`);
  }
  return { id: String(data.id), created: true, status: "pending" };
}

/** Links the consent request to the chat message that announced it. */
export async function attachEvidenceRequestMessage(id: string, messageId: string): Promise<void> {
  const db = requireService();
  const { data, error } = await db.from("chat_evidence_requests").update({ request_message_id: messageId }).eq("id", id).select("id");
  if (error || !data?.length) throw new Error(`Could not attach the evidence request to its message: ${error?.message ?? "request not found"}`);
}

/** Links the actual evidence to the chat message that announced it. */
export async function attachEvidenceMessage(id: string, messageId: string): Promise<void> {
  const db = requireService();
  const { data, error } = await db.from("chat_evidence_submissions").update({ message_id: messageId }).eq("id", id).select("id");
  if (error || !data?.length) throw new Error(`Could not attach the evidence submission to its message: ${error?.message ?? "submission not found"}`);
}

/** The agent may submit only its own request after a human has approved it. */
export async function submitChatEvidence(input: {
  workspaceId: string;
  conversationId: string;
  agent: AuthedAgent;
  requestId: string;
  provider?: string | null;
  evidence: unknown;
}): Promise<{ id: string; evidence: ChatEvidenceContract; requestMessageId: string | null; missionId: string | null; missionEvidenceId: string | null }> {
  const parsed = parseChatEvidenceContract(input.evidence);
  if (!parsed.ok) throw new ChatEvidenceError(`Evidence was rejected: ${parsed.errors.join(" ")}`, "INVALID_EVIDENCE", 400);
  const db = requireService();
  const { data: request, error: requestError } = await db.from("chat_evidence_requests")
    .select(REQUEST_COLUMNS)
    .eq("id", input.requestId)
    .eq("workspace_id", input.workspaceId)
    .eq("conversation_id", input.conversationId)
    .eq("agent_connection_id", input.agent.connectionId)
    .eq("status", "approved")
    .maybeSingle();
  if (requestError || !request) {
    throw new ChatEvidenceError(
      "No approved evidence request matches this requestId for your connection. " +
      "Either the request wasn't approved yet, the requestId is wrong, or it was created by a different agent connection than the one submitting now.",
      "NO_MATCHING_APPROVED_REQUEST",
      404,
    );
  }
  const approvedRequest = request;

  // Factored out so both the pre-insert existence check below AND the
  // post-insert 23505 recovery path (a real retry racing its own earlier
  // attempt -- e.g. a submit_evidence call that timed out client-side but
  // actually landed) return the exact same idempotent-replay shape, instead
  // of only the first ever handling a duplicate gracefully.
  async function replayExisting(row: { id: unknown; evidence: unknown; status: unknown }) {
    if (row.status !== "pending") throw new ChatEvidenceError("This evidence request already has a decided submission.", "ALREADY_DECIDED", 409);
    const existingEvidence = parseChatEvidenceContract(row.evidence);
    if (!existingEvidence.ok) throw new Error("The existing evidence submission is not a valid structured contract.");
    const canonical = await recordCanonicalChatEvidence({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      agent: input.agent,
      provider: input.provider ?? null,
      submissionId: String(row.id),
      evidence: existingEvidence.value,
    });
    return {
      id: String(row.id),
      evidence: existingEvidence.value,
      requestMessageId: (approvedRequest.request_message_id as string | null) ?? null,
      missionId: canonical?.missionId ?? null,
      missionEvidenceId: canonical?.evidenceId ?? null,
    };
  }

  const { data: existing, error: existingError } = await db.from("chat_evidence_submissions")
    .select("id, message_id, evidence, status")
    .eq("request_id", input.requestId)
    .eq("workspace_id", input.workspaceId)
    .maybeSingle();
  if (existingError) throw new Error(`Could not check for an existing evidence submission: ${existingError.message}`);
  if (existing) return replayExisting(existing);

  const submissionId = crypto.randomUUID();
  const { data, error } = await db.from("chat_evidence_submissions").insert({
    id: submissionId,
    workspace_id: input.workspaceId,
    conversation_id: input.conversationId,
    request_id: input.requestId,
    provider: input.provider ?? null,
    summary: parsed.value.summary,
    evidence: parsed.value,
  }).select("id").single();
  if (error || !data) {
    // A genuine race: another call for this same requestId (a client retry
    // after a timeout, most likely) already inserted the row between our
    // existence check above and this insert. Every other message-send path
    // in this codebase treats a 23505 on a request-scoped unique index as
    // "already happened, replay it" -- this one didn't, so a legitimate
    // retry got a raw constraint-violation error instead of the same
    // idempotent success a first-time caller would see.
    if (error?.code === "23505") {
      const { data: raced } = await db.from("chat_evidence_submissions")
        .select("id, message_id, evidence, status")
        .eq("request_id", input.requestId)
        .eq("workspace_id", input.workspaceId)
        .maybeSingle();
      if (raced) return replayExisting(raced);
    }
    throw new Error(`Could not submit evidence: ${error?.message ?? "unknown error"}`);
  }
  try {
    const canonical = await recordCanonicalChatEvidence({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      agent: input.agent,
      provider: input.provider ?? null,
      submissionId: String(data.id),
      evidence: parsed.value,
    });
    return {
      id: String(data.id),
      evidence: parsed.value,
      requestMessageId: (request.request_message_id as string | null) ?? null,
      missionId: canonical?.missionId ?? null,
      missionEvidenceId: canonical?.evidenceId ?? null,
    };
  } catch (error) {
    await db.from("chat_evidence_submissions").delete().eq("id", submissionId).eq("workspace_id", input.workspaceId);
    throw error;
  }
}

/**
 * Resolve the one pending evidence request a human message is allowed to
 * decide. A reply wins; otherwise an explicit `@provider` names that
 * provider's newest pending request. This prevents `yes @codex` from
 * unlocking whichever agent happened to ask most recently.
 */
export async function findPendingEvidenceDecisionTarget(input: {
  workspaceId: string;
  conversationId: string;
  body: string;
  parentMessageId?: string | null;
}): Promise<PendingEvidenceDecisionTarget | null> {
  if (classifyEvidenceRequestDecision({ body: input.body, requestMessageId: null, parentMessageId: input.parentMessageId }) === "unclear") return null;
  const db = requireService();
  const { data, error } = await db.from("chat_evidence_requests")
    .select(REQUEST_COLUMNS)
    .eq("workspace_id", input.workspaceId)
    .eq("conversation_id", input.conversationId)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(32);
  if (error) throw new Error(`Could not find a pending evidence request: ${error.message}`);
  const requests = (data ?? []) as Array<Record<string, unknown>>;
  const namedProvider = evidenceDecisionMention(input.body);
  const target = input.parentMessageId
    ? requests.find((request) => request.request_message_id === input.parentMessageId)
    : namedProvider
      ? requests.find((request) => String(request.provider ?? "").toLowerCase() === namedProvider)
      : requests[0];
  if (!target) return null;
  const decision = classifyEvidenceRequestDecision({
    body: input.body,
    requestMessageId: (target.request_message_id as string | null) ?? null,
    parentMessageId: input.parentMessageId,
  });
  if (decision === "unclear") return null;
  return { requestId: String(target.id), agentConnectionId: String(target.agent_connection_id) };
}

/** Human-facing: every still-pending evidence submission for a workspace. */
export async function listPendingChatEvidenceForWorkspace(workspaceId: string): Promise<ChatEvidenceSubmission[]> {
  const db = requireService();
  const { data, error } = await db.from("chat_evidence_submissions").select(SUBMISSION_COLUMNS)
    .eq("workspace_id", workspaceId).eq("status", "pending").order("created_at", { ascending: true });
  if (error) throw new Error(`Could not list pending evidence: ${error.message}`);
  return (data ?? []).map((row) => toRecord(row as Record<string, unknown>));
}

/**
 * A dashboard-authored message can approve/reject the newest pending request
 * in that channel. A message is not treated as consent unless it uses an
 * explicit approval phrase; unrelated conversation never unlocks evidence.
 */
export async function decideChatEvidenceRequestFromMessage(input: {
  workspaceId: string;
  conversationId: string;
  decidedByUserId: string;
  decisionMessageId: string;
  parentMessageId?: string | null;
  body: string;
  requestId?: string | null;
}): Promise<ChatEvidenceRequestStatus | "unclear" | null> {
  const decision = classifyEvidenceRequestDecision({ body: input.body, requestMessageId: null, parentMessageId: input.parentMessageId });
  if (decision === "unclear") return "unclear";
  const db = requireService();
  let requestQuery = db.from("chat_evidence_requests")
    .select(REQUEST_COLUMNS)
    .eq("workspace_id", input.workspaceId)
    .eq("conversation_id", input.conversationId)
    .eq("status", "pending");
  if (input.requestId) requestQuery = requestQuery.eq("id", input.requestId);
  else requestQuery = requestQuery.order("created_at", { ascending: false }).limit(1);
  const { data: request, error: requestError } = await requestQuery.maybeSingle();
  if (requestError || !request) return null;
  const gatedDecision = classifyEvidenceRequestDecision({ body: input.body, requestMessageId: request.request_message_id as string | null, parentMessageId: input.parentMessageId });
  if (gatedDecision === "unclear") return "unclear";
  const nextStatus: ChatEvidenceRequestStatus = gatedDecision === "approved" ? "approved" : "rejected";
  const { data, error } = await db.from("chat_evidence_requests")
    .update({ status: nextStatus, decided_by_user_id: input.decidedByUserId, decision_message_id: input.decisionMessageId, decided_at: new Date().toISOString() })
    .eq("id", request.id)
    .eq("status", "pending")
    .select("status")
    .maybeSingle();
  if (error) throw new Error(`Could not record the evidence request decision: ${error.message}`);
  return (data?.status as ChatEvidenceRequestStatus | undefined) ?? null;
}

/** Human-facing: every still-pending "may I submit?" request for a workspace, newest first. */
export async function listPendingChatEvidenceRequestsForWorkspace(workspaceId: string): Promise<ChatEvidenceRequest[]> {
  const db = requireService();
  const { data, error } = await db.from("chat_evidence_requests").select(REQUEST_COLUMNS)
    .eq("workspace_id", workspaceId).eq("status", "pending").order("created_at", { ascending: true });
  if (error) throw new Error(`Could not list pending evidence requests: ${error.message}`);
  return (data ?? []).map((row) => ({
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    conversationId: String(row.conversation_id),
    agentConnectionId: String(row.agent_connection_id),
    provider: (row.provider as string | null) ?? null,
    requestSummary: String(row.request_summary),
    requestMessageId: (row.request_message_id as string | null) ?? null,
    status: row.status as ChatEvidenceRequestStatus,
    decisionMessageId: (row.decision_message_id as string | null) ?? null,
    createdAt: String(row.created_at),
  }));
}

/**
 * Direct, id-targeted decision on the "may I submit?" gate -- the inline
 * Approve/Reject card in the message feed calls this instead of requiring a
 * human to type "yes"/"okay" as a chat reply (decideChatEvidenceRequestFromMessage
 * remains for that older text-based path; this is the click-button path).
 */
export async function decideChatEvidenceRequestById(input: { id: string; workspaceId: string; approved: boolean; decidedByUserId: string }): Promise<{ conversationId: string; requestMessageId: string | null }> {
  const db = requireService();
  const { data, error } = await db.from("chat_evidence_requests")
    .update({ status: input.approved ? "approved" : "rejected", decided_by_user_id: input.decidedByUserId, decided_at: new Date().toISOString() })
    .eq("id", input.id).eq("workspace_id", input.workspaceId).eq("status", "pending")
    .select("conversation_id, request_message_id").maybeSingle();
  if (error) throw new Error(`Could not record the evidence request decision: ${error.message}`);
  if (!data) throw new Error("This evidence request was already decided, or doesn't belong to this workspace.");
  return { conversationId: String(data.conversation_id), requestMessageId: (data.request_message_id as string | null) ?? null };
}

/** The one place a human decision gets recorded. Only a genuinely 'pending' row can be decided. */
export async function decideChatEvidence(input: { id: string; workspaceId: string; approved: boolean; decidedByUserId: string }): Promise<void> {
  const db = requireService();
  const { data: submission, error: submissionError } = await db.from("chat_evidence_submissions")
    .select("id, conversation_id, status")
    .eq("id", input.id)
    .eq("workspace_id", input.workspaceId)
    .maybeSingle();
  if (submissionError) throw new Error(`Could not read the evidence submission: ${submissionError.message}`);
  if (!submission || submission.status !== "pending") throw new Error("This evidence submission was already decided, or doesn't belong to this workspace.");

  if (input.approved) {
    const missionId = await boundMissionId(db, input.workspaceId, String(submission.conversation_id));
    if (missionId) {
      const evidenceId = `chat-evidence-review:${input.id}`;
      try {
        await recordMissionEvidence({
          actor: { kind: "human", id: input.decidedByUserId },
          workspaceId: input.workspaceId,
          kind: "human",
          userId: input.decidedByUserId,
          agent: null,
        }, missionId, {
          evidenceId,
          producerParticipantId: missionOwnerParticipantId(missionId, input.decidedByUserId),
          producerKind: "human",
          kind: "review_evidence",
          source: `Human approved chat evidence submission ${input.id}. The structured facts remain in the chat evidence record.`,
          lifecycle: "attested",
          availability: "available",
          clientRequestId: `${evidenceId}:attestation`,
        });
      } catch (error) {
        if (!(error instanceof MissionApiError) || error.code !== "evidence_already_exists") throw error;
      }
    }
  }

  const { data, error } = await db.from("chat_evidence_submissions")
    .update({ status: input.approved ? "approved" : "rejected", decided_by_user_id: input.decidedByUserId, decided_at: new Date().toISOString() })
    .eq("id", input.id).eq("workspace_id", input.workspaceId).eq("status", "pending")
    .select("id").maybeSingle();
  if (error) throw new Error(`Could not record the decision: ${error.message}`);
  if (!data) throw new Error("This evidence submission was already decided, or doesn't belong to this workspace.");
}
