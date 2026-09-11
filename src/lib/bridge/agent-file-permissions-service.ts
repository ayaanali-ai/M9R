/**
 * agent_file_permissions CRUD -- a per-agent DENY-list of file path glob
 * patterns, enforced at the actual ACP tool-call permission-request
 * boundary (acp-stdio-adapter.ts's requestPermission), not just filtered
 * out of a UI. Absence of any row for a connection means "no restriction,"
 * never "deny everything" -- this is opt-in, not a default lockout.
 */
import { supabase } from "@/lib/supabase";
import { createClient } from "@/lib/supabase/server";
import { resolveActiveOrDefaultProjectId } from "@/lib/projects-service";

function requireService() {
  if (!supabase) throw new Error("M9R backend is not configured.");
  return supabase;
}

export class FilePermissionsError extends Error {
  constructor(message: string, public code: string, public status: number) {
    super(message);
  }
}

/**
 * #20: the human-facing half of this feature -- resolves the signed-in
 * user's active workspace and confirms the target connection actually
 * belongs to it, so one workspace can never read or edit another's deny
 * list by guessing a connection id. Mirrors dashboardUserContext's shape in
 * conversation-service.ts without importing it directly (different domain,
 * would be a needless cross-file coupling for one shared check).
 */
async function requireOwnedConnection(connectionId: string): Promise<{ workspaceId: string }> {
  const auth = await createClient();
  if (!auth) throw new FilePermissionsError("Authentication is unavailable.", "DB_NOT_CONFIGURED", 503);
  const { data: { user } } = await auth.auth.getUser();
  if (!user) throw new FilePermissionsError("Sign in to manage file access.", "UNAUTHENTICATED", 401);
  const workspaceId = await resolveActiveOrDefaultProjectId(auth, { id: user.id, email: user.email, name: (user.user_metadata?.name as string | undefined) ?? null });
  if (!workspaceId) throw new FilePermissionsError("No workspace is available for this account.", "WORKSPACE_NOT_FOUND", 404);

  const db = requireService();
  const { data: connection } = await db.from("agent_connections").select("id").eq("id", connectionId).eq("workspace_id", workspaceId).maybeSingle();
  if (!connection) throw new FilePermissionsError("That agent connection was not found in your workspace.", "CONNECTION_NOT_FOUND", 404);
  return { workspaceId };
}

export async function listDeniedFilePatternsForDashboard(connectionId: string): Promise<Array<{ id: string; pattern: string }>> {
  await requireOwnedConnection(connectionId);
  const db = requireService();
  const { data, error } = await db.from("agent_file_permissions").select("id, pattern").eq("connection_id", connectionId).order("pattern", { ascending: true });
  if (error) throw new FilePermissionsError(`Could not list denied file patterns: ${error.message}`, "READ_FAILED", 500);
  return (data ?? []).map((row) => ({ id: String(row.id), pattern: String(row.pattern) }));
}

export async function addDeniedFilePatternForDashboard(connectionId: string, pattern: string): Promise<{ id: string; pattern: string }> {
  const { workspaceId } = await requireOwnedConnection(connectionId);
  const trimmed = pattern.trim().slice(0, 512);
  if (!trimmed) throw new FilePermissionsError("Enter a file path pattern.", "INVALID_PATTERN", 400);
  try {
    const { id } = await addDeniedFilePattern({ workspaceId, connectionId, pattern: trimmed });
    return { id, pattern: trimmed };
  } catch (err) {
    throw new FilePermissionsError(err instanceof Error ? err.message : "Could not add that pattern.", "WRITE_FAILED", 500);
  }
}

export async function removeDeniedFilePatternForDashboard(connectionId: string, patternId: string): Promise<void> {
  const { workspaceId } = await requireOwnedConnection(connectionId);
  await removeDeniedFilePattern(patternId, workspaceId);
}

export async function listDeniedFilePatterns(connectionId: string): Promise<string[]> {
  const db = requireService();
  const { data, error } = await db.from("agent_file_permissions").select("pattern").eq("connection_id", connectionId);
  if (error) throw new Error(`Could not list denied file patterns: ${error.message}`);
  return (data ?? []).map((row) => String(row.pattern));
}

export async function addDeniedFilePattern(input: { workspaceId: string; connectionId: string; pattern: string }): Promise<{ id: string }> {
  const db = requireService();
  const pattern = input.pattern.trim().slice(0, 512);
  if (!pattern) throw new Error("pattern must not be empty.");
  const { data, error } = await db.from("agent_file_permissions").insert({
    workspace_id: input.workspaceId,
    connection_id: input.connectionId,
    pattern,
  }).select("id").single();
  if (error) throw new Error(`Could not add denied file pattern: ${error.message}`);
  return { id: String(data.id) };
}

export async function removeDeniedFilePattern(id: string, workspaceId: string): Promise<void> {
  const db = requireService();
  const { error } = await db.from("agent_file_permissions").delete().eq("id", id).eq("workspace_id", workspaceId);
  if (error) throw new Error(`Could not remove denied file pattern: ${error.message}`);
}
