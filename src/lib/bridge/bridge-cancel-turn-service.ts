/**
 * bridge_cancel_turn_requests CRUD -- the human-interrupt request/consume
 * loop, mirroring bridge-permission-service.ts's proven pending/consumed
 * shape. Simpler than a permission: there is no approve/deny decision, only
 * "a human asked to cancel this agent's turn in this conversation" and
 * "the Bridge actually delivered that cancellation."
 */

import { supabase } from "@/lib/supabase";

export interface BridgeCancelTurnRequest {
  id: string;
  workspaceId: string;
  conversationId: string;
  connectionId: string;
  status: "pending" | "consumed";
  requestedByUserId: string;
  createdAt: string;
}

/** A cancel only makes sense against a turn that starts shortly after the click -- see the expiry migration's own comment for the live incident this fixes. */
const CANCEL_TURN_TTL_MS = 2 * 60_000;

function requireService() {
  if (!supabase) throw new Error("M9R backend is not configured.");
  return supabase;
}

const COLUMNS = "id, workspace_id, conversation_id, connection_id, status, requested_by_user_id, created_at";

function toRecord(row: Record<string, unknown>): BridgeCancelTurnRequest {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    conversationId: String(row.conversation_id),
    connectionId: String(row.connection_id),
    status: row.status as BridgeCancelTurnRequest["status"],
    requestedByUserId: String(row.requested_by_user_id),
    createdAt: String(row.created_at),
  };
}

/** The dashboard's Stop button. Idempotent per (conversation, connection): a repeated click while one request is still pending is a no-op, not a pile-up. */
export async function requestCancelTurn(input: { workspaceId: string; conversationId: string; connectionId: string; requestedByUserId: string }): Promise<void> {
  const db = requireService();
  const { data: existing, error: existingError } = await db.from("bridge_cancel_turn_requests")
    .select("id").eq("workspace_id", input.workspaceId).eq("conversation_id", input.conversationId).eq("connection_id", input.connectionId).eq("status", "pending")
    .gt("expires_at", new Date().toISOString()).maybeSingle();
  if (existingError) throw new Error(`Could not check for an existing cancel request: ${existingError.message}`);
  if (existing) return;
  const { error } = await db.from("bridge_cancel_turn_requests").insert({
    workspace_id: input.workspaceId,
    conversation_id: input.conversationId,
    connection_id: input.connectionId,
    requested_by_user_id: input.requestedByUserId,
    expires_at: new Date(Date.now() + CANCEL_TURN_TTL_MS).toISOString(),
  });
  if (error) throw new Error(`Could not request the cancellation: ${error.message}`);
}

/**
 * The Bridge polls this for one of its own live sessions -- scoped to the
 * exact conversation+connection pairing that session owns, so a cancel
 * meant for one agent can never be delivered to another. Excludes expired
 * rows: live-caught, an old click filed while nothing was running sat
 * pending and then reached forward to cancel a completely unrelated later
 * turn -- a cancel only counts against a turn that starts within
 * CANCEL_TURN_TTL_MS of the click, never an indefinitely-lingering one.
 */
export async function listPendingCancelTurnRequests(workspaceId: string, conversationId: string, connectionId: string): Promise<BridgeCancelTurnRequest[]> {
  const db = requireService();
  const { data, error } = await db.from("bridge_cancel_turn_requests").select(COLUMNS)
    .eq("workspace_id", workspaceId).eq("conversation_id", conversationId).eq("connection_id", connectionId).eq("status", "pending")
    .gt("expires_at", new Date().toISOString());
  if (error) throw new Error(`Could not list pending cancel requests: ${error.message}`);
  return (data ?? []).map((row) => toRecord(row as Record<string, unknown>));
}

/** Same workspace scoping as listPendingCancelTurnRequests -- consuming is only ever done by the Bridge that just delivered the cancellation to its own session. */
export async function markCancelTurnConsumed(workspaceId: string, id: string): Promise<void> {
  const db = requireService();
  await db.from("bridge_cancel_turn_requests").update({ status: "consumed", consumed_at: new Date().toISOString() }).eq("workspace_id", workspaceId).eq("id", id).eq("status", "pending");
}

/**
 * The dashboard's own confirmation poll -- lets the Stop button know
 * whether the Bridge actually delivered the cancellation yet, instead of
 * just guessing from a client-side timeout. Returns the most recent
 * request's status, or null if none has ever been filed for this pairing.
 * 'expired' is distinct from 'pending': the TTL passed with no session ever
 * picking it up, so the composer should stop waiting rather than sit on
 * Stop forever for a turn that was never actually going to be cancelled.
 */
export async function latestCancelTurnStatus(workspaceId: string, conversationId: string, connectionId: string): Promise<"pending" | "consumed" | "expired" | null> {
  const db = requireService();
  const { data, error } = await db.from("bridge_cancel_turn_requests").select("status, expires_at")
    .eq("workspace_id", workspaceId).eq("conversation_id", conversationId).eq("connection_id", connectionId)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(`Could not check the cancellation status: ${error.message}`);
  if (!data) return null;
  if (data.status === "pending" && new Date(data.expires_at as string).getTime() < Date.now()) return "expired";
  return data.status as "pending" | "consumed";
}
