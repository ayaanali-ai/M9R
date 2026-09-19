/**
 * Agent status summary (server) — a lean, layout-level query so the sidebar's
 * per-agent LED can show real connection/liveness state without pulling in
 * runs, sessions, or rules (that's loadWorkspaceOverview's job, for the
 * Overview page). Reuses the same pure, unit-tested classification
 * (dedupeConnections/connectionLiveness) the rest of the workspace uses —
 * never invents a status.
 */
import { createClient } from "@/lib/supabase/server";
import { connectionLiveness, type ConnectionLiveness, type ConnectionRow } from "@/lib/agent-dashboard-presenter";
import { agentDisplayLabel, normalizeAgentKind } from "@/lib/agent-workspace-data";

export interface ConnectedAgentNavItem {
  /** Connection-scoped key. This stays unique when a workspace has two copies of one provider. */
  key: string;
  connectionId: string;
  agentKind: string;
  label: string;
  /** Durable registration exists until the human explicitly disconnects it. */
  registered: boolean;
  /** Current heartbeat lease state, kept separate from registration. */
  liveness: ConnectionLiveness;
  connected: boolean;
  live: boolean;
  lastSeenAt: string | null;
}

export interface AgentStatusSummary {
  /** Provider lookup retained for status dots on older consumers. */
  byKey: Record<string, { registered: boolean; connected: boolean; live: boolean }>;
  /** Active durable registrations stay in navigation, including offline ones. */
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
      .select("id, workspace_id, agent_kind, repo_hint, status, created_at, last_seen_at, model, available_models, display_name, title, avatar_url, mascot_body, voice, speak_replies, soul, section, chief_of_staff, managed_sections, peers")
      .eq("workspace_id", workspaceId)
      .eq("status", "active")
      .order("last_seen_at", { ascending: false })
      .limit(50);
    if (error) return { byKey: {}, agents: [] };

    const connections = (data ?? []) as ConnectionRow[];
    const agents = connections.map((connection) => {
      const liveness = connectionLiveness(connection.last_seen_at);
      const live = liveness === "active";
      return {
        key: `connection:${connection.id}`,
        connectionId: connection.id,
        agentKind: connection.agent_kind,
        label: agentDisplayLabel(connection.agent_kind),
        registered: true,
        liveness,
        connected: live,
        live,
        lastSeenAt: connection.last_seen_at,
      };
    })
      .sort((a, b) => displayRank(a.agentKind) - displayRank(b.agentKind)
        || a.label.localeCompare(b.label)
        || a.connectionId.localeCompare(b.connectionId));
    const byKey: AgentStatusSummary["byKey"] = {};
    for (const agent of agents) {
      const key = normalizeAgentKind(agent.agentKind);
      const existing = byKey[key];
      byKey[key] = {
        registered: true,
        connected: Boolean(existing?.connected || agent.connected),
        live: Boolean(existing?.live || agent.live),
      };
    }
    return { byKey, agents };
  } catch {
    return { byKey: {}, agents: [] };
  }
}
