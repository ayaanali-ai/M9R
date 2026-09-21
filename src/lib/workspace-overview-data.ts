/**
 * Workspace Overview loader (server)
 * ----------------------------------------------------------------------------
 * The /dashboard Overview needs a cross-agent roll-up: the status strip, each
 * agent's pending approvals + Run B readiness, and a live-runs seed. It builds
 * that from the SAME truthful, owner-scoped rows and the SAME pure model
 * (buildAgentViews / buildWorkspaceStatus) the Agent Workspace uses.
 *
 * This is deliberately a separate, lean loader rather than a refactor of
 * dashboard/agents/page.tsx: that page is asserted line-by-line by
 * agent-dashboard.test.ts, so it stays untouched. The overlap here is limited to
 * the fetch + partition wiring; all workflow/readiness logic lives in the shared
 * pure module.
 */

import { createClient } from "@/lib/supabase/server";
import { listAgentRunsForUser, type DashboardRun } from "@/lib/agent-run-service";
import { listWorkspaceRules } from "@/lib/workspace-rules-service";
import type { WorkspaceRule } from "@/lib/workspace-rule-matching";
import {
  dedupeConnections,
  sessionRunLinks,
  partitionSessionsByLink,
  partitionRecommendationsByLink,
  linkedSessionIdSet,
  type ConnectionRow,
} from "@/lib/agent-dashboard-presenter";
import {
  buildAgentViews,
  buildWorkspaceStatus,
  type AgentView,
  type WorkspaceStatus,
  type WsConnection,
  type WsRun,
  type WsSession,
  type WsRule,
} from "@/lib/agent-workspace-data";
import type { LiveRun } from "@/components/product/LiveRunsPanel";

type SessionRow = {
  id: string;
  agent_kind: string | null;
  source_quality: string | null;
  findings_count: number | null;
  rules_generated: number | null;
  summary: string | null;
  created_at: string;
};

function toWsRule(r: WorkspaceRule): WsRule {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    title: r.title,
    body: r.body,
    ruleType: r.ruleType,
    status: r.status,
    sourceReportId: r.sourceReportId,
    sourceSessionName: r.sourceSessionName,
    evidenceSummary: r.evidenceSummary ?? "",
    confidence: r.confidence,
    promotedAt: r.promotedAt,
  };
}

export interface WorkspaceOverview {
  status: WorkspaceStatus;
  agents: AgentView[];
  /** Seed for the live-runs panel (newest first). */
  initialRuns: LiveRun[];
}

export async function loadWorkspaceOverview(): Promise<WorkspaceOverview> {
  const supabase = await createClient();

  const [connResult, sessionResult] = supabase
    ? await Promise.all([
        supabase
          .from("agent_connections")
          .select("id, workspace_id, agent_kind, repo_hint, status, created_at, last_seen_at, model, available_models, display_name, title, avatar_url, mascot_body, voice, speak_replies, soul, section, chief_of_staff, managed_sections, peers")
          .eq("status", "active")
          .order("last_seen_at", { ascending: false })
          .limit(50),
        supabase
          .from("agent_sessions")
          .select("id, agent_kind, source_quality, findings_count, rules_generated, summary, created_at")
          .order("created_at", { ascending: false })
          .limit(25),
      ])
    : [
        { data: [], error: null },
        { data: [], error: null },
      ];

  const connections = (connResult.data ?? []) as ConnectionRow[];
  const sessions = (sessionResult.data ?? []) as SessionRow[];
  const runs = await listAgentRunsForUser();

  const { groups: connectionGroups } = dedupeConnections(connections);
  const sessionLinks = sessionRunLinks(runs);
  const { linked: linkedSessions } = partitionSessionsByLink(sessions, sessionLinks);

  const workspaceIds = Array.from(
    new Set(connectionGroups.map((g) => g.latest.workspace_id).filter((id): id is string => Boolean(id))),
  );
  let rules: WorkspaceRule[] = [];
  try {
    const ruleLists = await Promise.all([
      listWorkspaceRules(),
      ...workspaceIds.map((workspaceId) => listWorkspaceRules(workspaceId)),
    ]);
    const byId = new Map<string, WorkspaceRule>();
    for (const rule of ruleLists.flat()) byId.set(rule.id, rule);
    rules = [...byId.values()];
  } catch {
    rules = [];
  }
  const allRecommended = rules.filter((r) => r.status === "needs_review");
  const active = rules.filter((r) => r.status === "active");
  const linkedSessionIds = linkedSessionIdSet(runs);
  const { linked: recommended, legacy: legacyRecommended } = partitionRecommendationsByLink(
    allRecommended,
    linkedSessionIds,
  );

const wsConnections: WsConnection[] = connectionGroups.map((g) => ({
    id: g.latest.id,
    workspace_id: g.latest.workspace_id,
    agent_kind: g.latest.agent_kind,
    repo_hint: g.latest.repo_hint,
    last_seen_at: g.latest.last_seen_at,
    liveness: g.liveness,
    status: g.latest.status,
    model: g.latest.model ?? null,
    available_models: g.latest.available_models ?? null,
    owner_label: g.latest.owner_label ?? null,
    owner_user_id: g.latest.owner_user_id ?? null,
    display_name: g.latest.display_name ?? null,
    title: g.latest.title ?? null,
    avatar_url: g.latest.avatar_url ?? null,
    mascot_body: g.latest.mascot_body ?? null,
    voice: g.latest.voice ?? null,
    speak_replies: g.latest.speak_replies ?? null,
    soul: g.latest.soul ?? null,
    section: g.latest.section ?? null,
    chief_of_staff: g.latest.chief_of_staff ?? null,
    managed_sections: g.latest.managed_sections ?? null,
    peers: g.latest.peers ?? null,
  }));
  const wsRuns: WsRun[] = runs.map((r: DashboardRun) => ({
    id: r.id,
    agent_kind: r.agent_kind,
    repo_hint: r.repo_hint,
    task_title: r.task_title,
    status: r.status,
    current_phase: r.current_phase,
    rules_loaded_count: r.rules_loaded_count,
    latest_session_id: r.latest_session_id,
    started_at: r.started_at,
    last_seen_at: r.last_seen_at,
  }));
  const wsLinkedSessions: WsSession[] = linkedSessions.map((s) => ({
    id: s.id,
    agent_kind: s.agent_kind,
    source_quality: s.source_quality,
    findings_count: s.findings_count,
    rules_generated: s.rules_generated,
    summary: s.summary,
    created_at: s.created_at,
    runId: sessionLinks.get(s.id) ?? null,
  }));
  const reviewRules = recommended.map(toWsRule);
  const activeRules = active.map(toWsRule);
  const legacyRules = legacyRecommended.map(toWsRule);

  const agents = buildAgentViews({
    connections: wsConnections,
    runs: wsRuns,
    sessions: wsLinkedSessions,
    reviewRules,
    activeRules,
    unassignedCandidates: legacyRules,
  });
  const status = buildWorkspaceStatus({
    agents,
    runs: wsRuns,
    reviewRules,
    activeRules,
    unassignedCandidates: legacyRules,
  });

  const initialRuns: LiveRun[] = wsRuns.map((r) => ({
    id: r.id,
    agent_kind: r.agent_kind,
    repo_hint: r.repo_hint,
    task_title: r.task_title,
    status: r.status,
    current_phase: r.current_phase,
    rules_loaded_count: r.rules_loaded_count,
    latest_session_id: r.latest_session_id,
    last_seen_at: r.last_seen_at,
  }));

  return { status, agents, initialRuns };
}
