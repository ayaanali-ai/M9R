/**
 * Approval Requests (bearer-CLI 403 dead-end fix)
 * ----------------------------------------------------------------------------
 * Durable store for human-approval requests created when a bearer (CLI)
 * run-start hits `needs_approval`. Scoped narrowly to `agent_run_start` — not
 * a general approval system, and NOT the Mission-planning `approvalPolicy`
 * subsystem (unrelated, untouched).
 *
 * Service-role only, matching how the rest of this bearer-auth surface
 * (agent_connections / agent_runs, see agent-join-service.ts /
 * agent-run-service.ts) is written: app code scopes every lookup to the
 * caller's own workspace_id, rather than relying on RLS + authenticated-role
 * policies.
 */

import { randomBytes, createHash } from "node:crypto";
import { supabase } from "@/lib/supabase";

export type ApprovalRequestStatus = "pending" | "approved" | "rejected" | "expired" | "consumed";
export type ApprovalDecision = "approved" | "rejected";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h — see migration comment.
const MAX_DECISION_NOTE_LENGTH = 1000;

export interface ApprovalRequestRecord {
  id: string;
  workspaceId: string;
  connectionId: string;
  operationType: string;
  operationIdentity: string;
  idempotencyKey: string;
  riskClassification: string;
  status: ApprovalRequestStatus;
  requestSummary: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decidedByUserId: string | null;
  decisionNote: string | null;
}

/** Minimal surface this module needs from the Supabase client — lets tests inject a fake. */
export interface ApprovalRequestsDb {
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
}

export class ApprovalRequestError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "ApprovalRequestError";
    this.code = code;
    this.status = status;
  }
}

function requireDb(db?: ApprovalRequestsDb): ApprovalRequestsDb {
  const client = db ?? (supabase as unknown as ApprovalRequestsDb | null);
  if (!client) {
    throw new ApprovalRequestError("M9R agent backend is not configured.", "DB_NOT_CONFIGURED", 503);
  }
  return client;
}

/** apr_<24 hex chars>, matching the human-readable apr_... convention used across this API surface. */
export function generateApprovalRequestId(): string {
  return `apr_${randomBytes(12).toString("hex")}`;
}

/**
 * Stable idempotency key for a single approval cycle: same workspace +
 * connection + operation + target always derives the same key, so a retried
 * bearer request resolves to the same pending row instead of creating a
 * duplicate. Mirrors the general approach of
 * src/lib/mission/mission-idempotency.ts's deriveIdempotencyKey (sha256 of a
 * canonical JSON payload) without importing from or coupling to Mission
 * internals.
 */
export function deriveApprovalIdempotencyKey(input: {
  workspaceId: string;
  connectionId: string;
  operationType: string;
  operationIdentity: string;
}): string {
  const canonical = JSON.stringify({
    workspace: input.workspaceId,
    connection: input.connectionId,
    operation: input.operationType,
    identity: input.operationIdentity,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function rowToRecord(row: Record<string, unknown>): ApprovalRequestRecord {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    connectionId: row.connection_id as string,
    operationType: row.operation_type as string,
    operationIdentity: row.operation_identity as string,
    idempotencyKey: row.idempotency_key as string,
    riskClassification: row.risk_classification as string,
    status: row.status as ApprovalRequestStatus,
    requestSummary: (row.request_summary ?? {}) as Record<string, unknown>,
    createdAt: row.created_at as string,
    expiresAt: row.expires_at as string,
    decidedAt: (row.decided_at as string | null) ?? null,
    decidedByUserId: (row.decided_by_user_id as string | null) ?? null,
    decisionNote: (row.decision_note as string | null) ?? null,
  };
}

export interface CreateOrGetPendingApprovalRequestInput {
  workspaceId: string;
  connectionId: string;
  operationType: string;
  operationIdentity: string;
  riskClassification: string;
  requestSummary: Record<string, unknown>;
  now?: Date;
  ttlMs?: number;
  db?: ApprovalRequestsDb;
}

export async function createOrGetPendingApprovalRequest(
  input: CreateOrGetPendingApprovalRequestInput,
): Promise<ApprovalRequestRecord> {
  const db = requireDb(input.db);
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (input.ttlMs ?? DEFAULT_TTL_MS));
  const idempotencyKey = deriveApprovalIdempotencyKey(input);

  const { data, error } = await db.rpc("create_or_get_pending_approval_request", {
    p_id: generateApprovalRequestId(),
    p_workspace_id: input.workspaceId,
    p_connection_id: input.connectionId,
    p_operation_type: input.operationType,
    p_operation_identity: input.operationIdentity,
    p_idempotency_key: idempotencyKey,
    p_risk_classification: input.riskClassification,
    p_request_summary: input.requestSummary,
    p_now: now.toISOString(),
    p_expires_at: expiresAt.toISOString(),
  });

  if (error || !data) {
    throw new ApprovalRequestError("Could not create the approval request.", "APPROVAL_CREATE_FAILED", 500);
  }
  return rowToRecord(data as Record<string, unknown>);
}

/**
 * Read-only lookup by idempotency key, used by the retry-after-approval
 * check: before re-triggering a 403, look up whether this exact operation
 * already has a decided (approved/rejected) request.
 */
export async function findApprovalRequestByIdempotencyKey(
  input: {
    workspaceId: string;
    connectionId: string;
    operationType: string;
    operationIdentity: string;
  },
  db?: ApprovalRequestsDb,
): Promise<ApprovalRequestRecord | null> {
  const client = requireDb(db);
  const idempotencyKey = deriveApprovalIdempotencyKey(input);
  const { data, error } = await client.rpc("get_approval_request_by_idempotency_key", {
    p_idempotency_key: idempotencyKey,
    p_workspace_id: input.workspaceId,
  });
  if (error) {
    throw new ApprovalRequestError("Could not look up the approval request.", "APPROVAL_LOOKUP_FAILED", 500);
  }
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null | undefined;
  if (!row || !row.id) return null;
  return rowToRecord(row);
}

export type DecideApprovalResult =
  | { ok: true; request: ApprovalRequestRecord }
  | { ok: false; reason: "not_found" | "already_decided" | "expired" | "invalid_decision"; request: ApprovalRequestRecord | null };

export async function decideApprovalRequest(input: {
  id: string;
  workspaceId: string;
  decision: ApprovalDecision;
  decidedByUserId: string;
  decisionNote?: string | null;
  now?: Date;
  db?: ApprovalRequestsDb;
}): Promise<DecideApprovalResult> {
  const db = requireDb(input.db);
  const now = input.now ?? new Date();
  const note = (input.decisionNote ?? "").slice(0, MAX_DECISION_NOTE_LENGTH) || null;

  const { data, error } = await db.rpc("decide_approval_request", {
    p_id: input.id,
    p_workspace_id: input.workspaceId,
    p_decision: input.decision,
    p_decided_by_user_id: input.decidedByUserId,
    p_decision_note: note,
    p_now: now.toISOString(),
  });

  if (error) {
    throw new ApprovalRequestError("Could not record the approval decision.", "APPROVAL_DECIDE_FAILED", 500);
  }
  const row = (Array.isArray(data) ? data[0] : data) as
    | { status: string; reason: string | null; request: Record<string, unknown> | null }
    | undefined;
  if (!row) {
    throw new ApprovalRequestError("Could not record the approval decision.", "APPROVAL_DECIDE_FAILED", 500);
  }
  if (row.status === "ok" && row.request) {
    return { ok: true, request: rowToRecord(row.request) };
  }
  const reason = (row.reason ?? "not_found") as "not_found" | "already_decided" | "expired" | "invalid_decision";
  return { ok: false, reason, request: row.request ? rowToRecord(row.request) : null };
}

export async function getApprovalRequest(
  id: string,
  workspaceId: string,
  db?: ApprovalRequestsDb,
): Promise<ApprovalRequestRecord | null> {
  const client = requireDb(db);
  const { data, error } = await client.rpc("get_approval_request", {
    p_id: id,
    p_workspace_id: workspaceId,
  });
  if (error) {
    throw new ApprovalRequestError("Could not look up the approval request.", "APPROVAL_LOOKUP_FAILED", 500);
  }
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null | undefined;
  if (!row || !row.id) return null;
  return rowToRecord(row);
}

/**
 * Links a run-start approval request to the chat message that announced it,
 * so the Watchfloor message feed can show the inline Approve/Reject card
 * under that exact message -- the same way chat_evidence_requests.request_message_id
 * links an evidence "may I submit?" request to its own announcement message.
 * Stashed inside request_summary (already jsonb) rather than a new column,
 * since creation/decision both go through Postgres RPCs this doesn't need to touch.
 */
export async function attachApprovalRequestMessage(id: string, workspaceId: string, messageId: string): Promise<void> {
  if (!supabase) throw new ApprovalRequestError("M9R agent backend is not configured.", "DB_NOT_CONFIGURED", 503);
  const { data: existing } = await supabase.from("approval_requests").select("request_summary").eq("id", id).eq("workspace_id", workspaceId).maybeSingle();
  if (!existing) return;
  const nextSummary = { ...((existing.request_summary as Record<string, unknown>) ?? {}), requestMessageId: messageId };
  const { error } = await supabase.from("approval_requests").update({ request_summary: nextSummary }).eq("id", id).eq("workspace_id", workspaceId);
  if (error) throw new ApprovalRequestError("Could not attach the approval request to its message.", "APPROVAL_ATTACH_MESSAGE_FAILED", 500);
}

export async function markApprovalRequestConsumed(
  id: string,
  workspaceId: string,
  db?: ApprovalRequestsDb,
  now?: Date,
): Promise<void> {
  const client = requireDb(db);
  const { error } = await client.rpc("mark_approval_request_consumed", {
    p_id: id,
    p_workspace_id: workspaceId,
    p_now: (now ?? new Date()).toISOString(),
  });
  if (error) {
    throw new ApprovalRequestError("Could not mark the approval request consumed.", "APPROVAL_CONSUME_FAILED", 500);
  }
}
