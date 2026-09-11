/**
 * bridge_permission_requests CRUD -- the missing link found live tonight
 * between acp-stdio-adapter.ts's requestPermission (which genuinely waits
 * for a decision) and an actual human decision. Two callers:
 *  - The Bridge process itself: creates a pending row when a session asks
 *    for permission, then polls for a decision on it (HTTP, not the
 *    WebSocket relay -- see the migration's own comment on why).
 *  - The dashboard: lists pending rows for a human to see, records their
 *    decision.
 */

import { supabase } from "@/lib/supabase";

export interface BridgePermissionRequest {
  id: string;
  workspaceId: string;
  missionId: string;
  executionId: string;
  requestId: string;
  summary: string;
  command: string | null;
  filePath: string | null;
  status: "pending" | "approved" | "denied" | "consumed";
  messageId: string | null;
  createdAt: string;
}

function requireService() {
  if (!supabase) throw new Error("M9R backend is not configured.");
  return supabase;
}

const COLUMNS = "id, workspace_id, mission_id, execution_id, request_id, summary, command, file_path, status, message_id, created_at";

function toRecord(row: Record<string, unknown>): BridgePermissionRequest {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    missionId: String(row.mission_id),
    executionId: String(row.execution_id),
    requestId: String(row.request_id),
    summary: String(row.summary),
    command: (row.command as string | null) ?? null,
    filePath: (row.file_path as string | null) ?? null,
    status: row.status as BridgePermissionRequest["status"],
    messageId: (row.message_id as string | null) ?? null,
    createdAt: String(row.created_at),
  };
}

/**
 * The Bridge reports a new pending permission the moment a live session
 * asks for one. Idempotent on (executionId, requestId): a retried report of
 * the same request is a no-op, not a duplicate row. Returns the row's id
 * and whether this call is the one that actually created it (vs. a replay)
 * -- the caller only announces a chat message on genuine creation.
 */
export async function reportPendingPermission(input: {
  workspaceId: string; missionId: string; executionId: string; requestId: string; summary: string; command?: string | null; filePath?: string | null;
}): Promise<{ id: string; created: boolean }> {
  const db = requireService();
  const { data, error } = await db.from("bridge_permission_requests").upsert({
    workspace_id: input.workspaceId,
    mission_id: input.missionId,
    execution_id: input.executionId,
    request_id: input.requestId,
    summary: input.summary.slice(0, 2048),
    command: input.command?.slice(0, 2048) ?? null,
    file_path: input.filePath?.slice(0, 1024) ?? null,
  }, { onConflict: "execution_id,request_id", ignoreDuplicates: true })
    .select("id, message_id")
    .maybeSingle();
  if (error) throw new Error(`Could not report the pending permission: ${error.message}`);
  // ignoreDuplicates makes a replay return no row at all (Postgres upsert
  // with DO NOTHING has nothing to RETURNING) -- fall back to reading the
  // existing row so the caller always gets a real id either way.
  if (data) return { id: String(data.id), created: true };
  const { data: existing, error: existingError } = await db.from("bridge_permission_requests")
    .select("id").eq("execution_id", input.executionId).eq("request_id", input.requestId).maybeSingle();
  if (existingError || !existing) throw new Error(`Could not report the pending permission: ${existingError?.message ?? "row not found after upsert"}`);
  return { id: String(existing.id), created: false };
}

/** Best-effort link from a permission row to the chat message announcing it -- mirrors attachEvidenceMessage/attachFindingAnnouncementMessage. */
export async function attachPermissionMessage(id: string, workspaceId: string, messageId: string): Promise<void> {
  const db = requireService();
  const { error } = await db.from("bridge_permission_requests").update({ message_id: messageId }).eq("id", id).eq("workspace_id", workspaceId);
  if (error) throw new Error(`Could not attach the permission request to its message: ${error.message}`);
}

/** The Bridge polls this for its own sessions -- rows that have been decided (approved/denied) but not yet consumed. Marking 'consumed' happens separately (markPermissionConsumed) once the Bridge has actually delivered the decision to the waiting session, so a Bridge restart mid-delivery can't silently lose a decision. Scoped to the caller's own workspace -- an agent bearer token from workspace A must never see or drain workspace B's pending decisions. */
export async function listDecidedPermissionsForExecution(workspaceId: string, executionId: string): Promise<BridgePermissionRequest[]> {
  const db = requireService();
  const { data, error } = await db.from("bridge_permission_requests").select(COLUMNS)
    .eq("workspace_id", workspaceId).eq("execution_id", executionId).in("status", ["approved", "denied"]);
  if (error) throw new Error(`Could not list decided permissions: ${error.message}`);
  return (data ?? []).map((row) => toRecord(row as Record<string, unknown>));
}

/** Same workspace scoping as listDecidedPermissionsForExecution -- an agent from another workspace must never be able to mark someone else's pending decision consumed. */
export async function markPermissionConsumed(workspaceId: string, id: string): Promise<void> {
  const db = requireService();
  await db.from("bridge_permission_requests").update({ status: "consumed" }).eq("workspace_id", workspaceId).eq("id", id).in("status", ["approved", "denied"]);
}

/** Human-facing: every still-pending permission request for a workspace. */
export async function listPendingPermissionsForWorkspace(workspaceId: string): Promise<BridgePermissionRequest[]> {
  const db = requireService();
  const { data, error } = await db.from("bridge_permission_requests").select(COLUMNS)
    .eq("workspace_id", workspaceId).eq("status", "pending").order("created_at", { ascending: true });
  if (error) throw new Error(`Could not list pending permissions: ${error.message}`);
  return (data ?? []).map((row) => toRecord(row as Record<string, unknown>));
}

/** The one place a human decision gets recorded. Only a genuinely 'pending' row can be decided -- deciding an already-decided or already-consumed row is refused rather than silently overwritten. */
export async function decidePendingPermission(input: { id: string; workspaceId: string; approved: boolean; decidedByUserId: string }): Promise<void> {
  const db = requireService();
  const { data, error } = await db.from("bridge_permission_requests")
    .update({ status: input.approved ? "approved" : "denied", decided_by_user_id: input.decidedByUserId, decided_at: new Date().toISOString() })
    .eq("id", input.id).eq("workspace_id", input.workspaceId).eq("status", "pending")
    .select("id").maybeSingle();
  if (error) throw new Error(`Could not record the decision: ${error.message}`);
  if (!data) throw new Error("This permission request was already decided, or doesn't belong to this workspace.");
}
