/**
 * Agent status summary (server) — a lean, layout-level query so the sidebar's
 * per-agent LED can show real connection/liveness state without pulling in
 * runs, sessions, or rules (that's loadWorkspaceOverview's job, for the
 * Overview page). Reuses the same pure, unit-tested classification
 * (dedupeConnections/connectionLiveness) the rest of the workspace uses —
 * never invents a status.
 */
import { createClient } from "@/lib/supabase/server";
import { isRecentlySeenConnection, type ConnectionRow } from "@/lib/agent-dashboard-presenter";
import { agentDisplayLabel, normalizeAgentKind } from "@/lib/agent-workspace-data";

export interface ConnectedAgentNavItem {
  /** Connection-scoped key. This stays unique when a workspace has two copies of one provider. */
  key: string;
  connectionId: string;
  agentKind: string;
  label: string;
  connected: boolean;
  live: boolean;
  lastSeenAt: string | null;
}

export interface AgentStatusSummary {
  /** Legacy provider lookup retained for status dots on older consumers. */
  byKey: Record<string, { connected: boolean; live: boolean }>;
  /** Only agents that are actually connected and recently seen belong in navigation. */
  agents: ConnectedAgentNavItem[];
}

function displayRank(agentKind: string): number {
  const order = ["codex", "claude-code", "opencode", "grok-build"];
  const index = order.indexOf(agentKind.trim().toLowerCase());
  return index === -1 ? order.length : index;
}

export async function loadAgentStatusSummary(workspaceId: string | null): Promise<AgentStatusSummary> {
  // Navigation must never be populated from another workspace. Callers resolve
  // the active workspace first; an unresolved workspace is an empty state, not
  // permission to query every connection visible to the service role.
  if (!workspaceId) return { byKey: {}, agents: [] };
  const supabase = await createClient();
  if (!supabase) return { byKey: {}, agents: [] };
  try {
    const { data, error } = await supabase
      .from("agent_connections")
      .select("id, workspace_id, agent_kind, repo_hint, status, created_at, last_seen_at")
      .eq("workspace_id", workspaceId)
      .eq("status", "active")
      .order("last_seen_at", { ascending: false })
      .limit(50);
    if (error) return { byKey: {}, agents: [] };

    const connections = (data ?? []) as ConnectionRow[];
    const agents = connections
      .filter((connection) => isRecentlySeenConnection(connection))
      .map((connection) => ({
        key: `connection:${connection.id}`,
        connectionId: connection.id,
        agentKind: connection.agent_kind,
        label: agentDisplayLabel(connection.agent_kind),
        connected: true,
        live: true,
        lastSeenAt: connection.last_seen_at,
      }))
      .sort((a, b) => displayRank(a.agentKind) - displayRank(b.agentKind)
        || a.label.localeCompare(b.label)
        || a.connectionId.localeCompare(b.connectionId));
    const byKey: AgentStatusSummary["byKey"] = {};
    for (const agent of agents) {
      const key = normalizeAgentKind(agent.agentKind);
      byKey[key] = { connected: true, live: true };
    }
    return { byKey, agents };
  } catch {
    return { byKey: {}, agents: [] };
  }
}
