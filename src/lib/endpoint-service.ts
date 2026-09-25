import { createClient } from "@supabase/supabase-js";
import type { AuthedAgent } from "@/lib/agent-join-service";
import { buildEndpointView, resolveAddress, type EndpointRow, type EndpointView, type ResolveOutcome } from "@/lib/endpoint-core";

function requireService() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase service credentials are not configured.");
  return createClient(url, key, { auth: { persistSession: false } });
}

const ENDPOINT_COLUMNS = "id, workspace_id, owner_user_id, provider, alias, current_connection_id, session_generation, status";

export interface WorkspaceEndpoints {
  rows: EndpointRow[];
  lastSeenByConnection: Map<string, string | null>;
  viewerOwnerId: string | null;
}

/** Every endpoint in the caller's workspace, with the liveness of the connection each one is bound to. */
export async function loadWorkspaceEndpoints(agent: AuthedAgent): Promise<WorkspaceEndpoints> {
  const loaded = await loadWorkspaceEndpointsForHuman(agent.workspaceId, null);
  const db = requireService();
  const viewer = await db.from("agent_connections").select("created_by").eq("id", agent.connectionId).maybeSingle();
  return { ...loaded, viewerOwnerId: (viewer.data?.created_by as string | null | undefined) ?? null };
}

/** Human dashboard variant; the caller must resolve workspace membership before calling. */
export async function loadWorkspaceEndpointsForHuman(workspaceId: string, viewerUserId: string | null): Promise<WorkspaceEndpoints> {
  const db = requireService();
  const endpoints = await db.from("endpoints").select(ENDPOINT_COLUMNS).eq("workspace_id", workspaceId).neq("status", "retired").order("created_at", { ascending: true });
  if (endpoints.error) throw new Error(`Could not list endpoints: ${endpoints.error.message}`);
  const rows = (endpoints.data ?? []) as EndpointRow[];
  const connectionIds = rows.map((row) => row.current_connection_id).filter((id): id is string => id !== null);
  const lastSeenByConnection = new Map<string, string | null>();
  if (connectionIds.length > 0) {
    const { data, error } = await db.from("agent_connections").select("id, last_seen_at").in("id", connectionIds);
    if (error) throw new Error(`Could not read endpoint liveness: ${error.message}`);
    for (const row of (data ?? []) as Array<{ id: string; last_seen_at: string | null }>) lastSeenByConnection.set(row.id, row.last_seen_at);
  }
  return { rows, lastSeenByConnection, viewerOwnerId: viewerUserId };
}

export function viewOf(row: EndpointRow, loaded: WorkspaceEndpoints): EndpointView {
  const lastSeen = row.current_connection_id ? loaded.lastSeenByConnection.get(row.current_connection_id) ?? null : null;
  return buildEndpointView(row, lastSeen, loaded.viewerOwnerId);
}

export async function listEndpoints(agent: AuthedAgent): Promise<EndpointView[]> {
  const loaded = await loadWorkspaceEndpoints(agent);
  return loaded.rows.map((row) => viewOf(row, loaded));
}

export type ResolveEndpointResult =
  | { ok: true; endpoint: EndpointView }
  | Extract<ResolveOutcome, { ok: false }>;

export async function resolveEndpoint(agent: AuthedAgent, address: string): Promise<ResolveEndpointResult> {
  const loaded = await loadWorkspaceEndpoints(agent);
  const outcome = resolveAddress(address, loaded.rows, loaded.viewerOwnerId);
  if (!outcome.ok) return outcome;
  return { ok: true, endpoint: viewOf(outcome.endpoint, loaded) };
}
