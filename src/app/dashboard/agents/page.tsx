import { PageHeader } from "@/components/product/WorkspaceUI";
import AgentWorkspaceClient from "@/components/product/AgentWorkspaceClient";
import WorkspaceEndpointCard from "@/components/product/WorkspaceEndpointCard";
import { createClient } from "@/lib/supabase/server";
import { supabase as adminDb } from "@/lib/supabase";
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
  type WsConnection,
  type WsRun,
  type WsSession,
  type WsRule,
} from "@/lib/agent-workspace-data";
import { buildAgentApprovalCenter } from "@/lib/agent-approval-center";
import { whisperActivitySummary } from "@/lib/bridge/whisper-activity-service";
import { loadAgentApprovalData } from "@/lib/agent-approval-center-data";
import ReviewerDemoWorkspace from "@/components/product/ReviewerDemoWorkspace";
import { isReviewerDemoAppMetadata } from "@/lib/reviewer-demo-access";
import { resolveMissionPrincipalForServerComponent } from "@/lib/mission/mission-principal";
import { ensureWorkspaceChannelsForDashboard } from "@/lib/conversation-service";

/**
 * /dashboard/agents — the Agent Workspace command center.
 * ----------------------------------------------------------------------------
 * Organized around current and historical run records, not database nouns.
 * Displayed data is run-linked and owner-scoped (RLS). Unlinked historical
 * records remain stored for audit, but are omitted from the normal workspace.
 */

export const dynamic = "force-dynamic";

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
    createdAt: r.createdAt,
    scopeCondition: r.scopeCondition,
  };
}

export default async function AgentsDashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = supabase ? await supabase.auth.getUser() : { data: { user: null } };

  if (isReviewerDemoAppMetadata(user?.app_metadata)) {
    return (
      <>
        <PageHeader
          title="Agent Workspace"
          description="Seeded run-control record with rules, controlled handoff, evidence, Run Passports, comparison, and human review."
        />
        <ReviewerDemoWorkspace />
      </>
    );
  }

  // Resolve the human's active workspace before shaping agent data. The RLS
  // connection query can include rows from workspaces the same account owns;
  // the Watchfloor and its relay subscription must stay on the one workspace
  // the current dashboard session actually selected.
  let humanWorkspaceId: string | null = null;
  if (user) {
    try {
      humanWorkspaceId = (await resolveMissionPrincipalForServerComponent()).workspaceId;
    } catch {
      // The existing empty-state path below remains valid when no workspace
      // can be resolved yet (for example during first-time setup).
    }
  }

  // Fetch connections + sessions via the cookie client (RLS → owner-scoped).
  // A missing active workspace is an empty state, never permission to shape
  // navigation from every connection the account can see.
  const connectionRequest = supabase && humanWorkspaceId
    ? supabase
        .from("agent_connections")
        .select("id, workspace_id, agent_kind, repo_hint, status, created_at, last_seen_at, model, available_models, last_provider_session_ref, created_by")
        .eq("workspace_id", humanWorkspaceId)
        .eq("status", "active")
        .order("last_seen_at", { ascending: false })
        .limit(50)
    : Promise.resolve({ data: [], error: null });
  const sessionRequest = supabase
    ? supabase
        .from("agent_sessions")
        .select("id, agent_kind, source_quality, findings_count, rules_generated, summary, created_at")
        .order("created_at", { ascending: false })
        .limit(25)
    : Promise.resolve({ data: [], error: null });
  // Supabase's query builder resolves with { data: null, error } on a normal
  // query failure (handled below via `?? []`) but the underlying fetch can
  // still reject outright on a real network drop/timeout -- same crash risk
  // as loadAgentApprovalData above, guarded the same way.
  // Runs and the whisper summary depend on neither the connection rows nor each
  // other, so they start now and overlap with the queries above instead of
  // adding two more serial round trips before the page can render.
  const runsRequest = listAgentRunsForUser().catch(() => []);
  const whisperRequest = whisperActivitySummary().catch(() => null);
  const [connResult, sessionResult] = await Promise.all([connectionRequest, sessionRequest]).catch(() => [{ data: [] }, { data: [] }]);

  const connections = ((connResult.data ?? []) as ConnectionRow[])
    .filter((connection) => Boolean(humanWorkspaceId && connection.workspace_id === humanWorkspaceId));
  const sessions = (sessionResult.data ?? []) as SessionRow[];
  const runs = await runsRequest;
  // The Watchfloor is a live multi-agent surface: preserve each distinct
  // connection so two Codex/Claude/OpenCode residents cannot collapse into
  // one visible slot. Callsigns may still use stable provider grouping.
  const { groups: connectionGroups } = dedupeConnections(connections, undefined, { preserveDistinctConnections: true });

  // Run-linked vs legacy/unlinked sessions (via run.latest_session_id).
  // Unlinked sessions remain stored for audit; the Watchfloor shows only
  // run-linked evidence.
  const sessionLinks = sessionRunLinks(runs);
  const { linked: linkedSessions } = partitionSessionsByLink(sessions, sessionLinks);

  // `agent_connections` is durable registration state. Keep every active
  // registration visible so a quiet runtime is "Registered · Offline", never
  // falsely "Disconnected". Relay/channel membership remains strictly live.
  const visibleConnectionGroups = connectionGroups
    .sort((a, b) => {
      const rank = (kind: string) => ({ codex: 0, "claude-code": 1, opencode: 2, "grok-build": 3 }[kind.trim().toLowerCase()] ?? 4);
      return rank(a.agent_kind) - rank(b.agent_kind)
        || a.agent_kind.localeCompare(b.agent_kind)
        || a.latest.id.localeCompare(b.latest.id);
    });
  const liveConnectionGroups = visibleConnectionGroups
    .filter((group) => group.liveness === "active");
  const workspaceIds = Array.from(
    new Set(visibleConnectionGroups.map((g) => g.latest.workspace_id).filter((id): id is string => Boolean(id))),
  );
  let relayWorkspaceId: string | null = humanWorkspaceId ?? workspaceIds[0] ?? null;
  if (user) {
    try {
      const principalWorkspaceId = humanWorkspaceId ?? (await resolveMissionPrincipalForServerComponent()).workspaceId;
      relayWorkspaceId = principalWorkspaceId;
      const channelWorkspaceIds = workspaceIds.length > 0 ? workspaceIds : [principalWorkspaceId];
      await Promise.all(channelWorkspaceIds.map((workspaceId) => ensureWorkspaceChannelsForDashboard(
        workspaceId,
        user.id,
        liveConnectionGroups
          .filter((group) => group.latest.workspace_id === workspaceId)
          .map((group) => group.latest.id),
      )));
    } catch {
      // A missing default workspace must not block the rest of the Watchfloor.
    }
  }
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
  // Run-linked recommendations vs legacy (by stored source session id).
  const linkedSessionIds = linkedSessionIdSet(runs);
  const { linked: recommended, legacy: legacyRecommended } = partitionRecommendationsByLink(
    allRecommended,
    linkedSessionIds,
  );

  // Per-owner agent identity: resolve each connection's owner (created_by)
  // to a display name. Requires the service-role client -- users' own RLS
  // ("Users can read own user row") restricts a teammate's cookie session to
  // reading only their own row, not a co-worker's, so this can't run through
  // the normal per-request client. Read-only, and no new exposure: teammate
  // emails are already visible to each other in Settings -> Team.
  const ownerIds = Array.from(
    new Set(visibleConnectionGroups.map((g) => g.latest.created_by).filter((id): id is string => Boolean(id))),
  );
  const ownerLabelById = new Map<string, string>();
  if (ownerIds.length > 0 && adminDb) {
    const { data: owners } = await adminDb.from("users").select("id, email, name").in("id", ownerIds);
    for (const owner of owners ?? []) {
      const label = (owner.name as string | null) || ((owner.email as string | null)?.split("@")[0] ?? null);
      if (label) ownerLabelById.set(owner.id as string, label);
    }
  }

  // --- Shape inputs for the agent-first workspace model ---------------------
  const wsConnections: WsConnection[] = visibleConnectionGroups.map((g) => ({
    id: g.latest.id,
    workspace_id: g.latest.workspace_id,
    agent_kind: g.agent_kind,
    repo_hint: g.repo_hint,
    last_seen_at: g.latest.last_seen_at,
    liveness: g.liveness,
    status: g.latest.status,
    model: g.latest.model ?? null,
    available_models: g.latest.available_models ?? null,
    last_provider_session_ref: g.latest.last_provider_session_ref ?? null,
    owner_label: g.latest.created_by ? ownerLabelById.get(g.latest.created_by) ?? null : null,
    owner_user_id: g.latest.created_by ?? null,
  }));
  const wsRuns: WsRun[] = runs.map((r: DashboardRun) => ({
    id: r.id,
    connection_id: r.connection_id,
    agent_kind: r.agent_kind,
    repo_hint: r.repo_hint,
    task_title: r.task_title,
    status: r.status,
    current_phase: r.current_phase,
    rules_loaded_count: r.rules_loaded_count,
    latest_session_id: r.latest_session_id,
    started_at: r.started_at,
    last_seen_at: r.last_seen_at,
    completed_at: r.completed_at,
    behavior: r.behavior
      ? {
          toolCalls: r.behavior.toolCalls,
          changedFiles: r.behavior.changedFiles,
          failedCommands: r.behavior.failedCommands,
          totalTokens: r.behavior.totalTokens,
          costUsd: r.behavior.costUsd,
          inputTokens: r.behavior.inputTokens,
          outputTokens: r.behavior.outputTokens,
        }
      : null,
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

  const baseAgents = buildAgentViews({
    connections: wsConnections,
    runs: wsRuns,
    sessions: wsLinkedSessions,
    reviewRules,
    activeRules,
    unassignedCandidates: legacyRules,
    includeDisconnectedDescriptors: false,
  });
  // Was the only unguarded fetch on this force-dynamic page -- every other
  // query here already degrades to a safe empty state on failure (see
  // listWorkspaceRules and resolveMissionPrincipalForServerComponent above),
  // but this one threw straight through to the route's error boundary,
  // crashing the whole Watchfloor to "Workspace data could not be loaded"
  // on what should be a transient, recoverable data hiccup. A human losing
  // the Approval Center for one request is a real cost, but nowhere near as
  // bad as losing the entire workspace they're mid-conversation in.
  let approvalData: Awaited<ReturnType<typeof loadAgentApprovalData>>;
  try {
    approvalData = await loadAgentApprovalData({
      runs,
      activeRules: active,
    });
  } catch {
    approvalData = { passports: [] };
  }
  const approvalCenter = buildAgentApprovalCenter({
    agents: baseAgents,
    passports: approvalData.passports,
  });
  // Whispers is a real but usually-empty surface -- only show the toggle at
  // all when there's something to show, same as Review's badge count. Best
  // effort: a failure here should never block the page from rendering.
  let hasWhispers = false;
  const whisperActivity = await whisperRequest;
  hasWhispers = Boolean(whisperActivity && whisperActivity.totalCount30d > 0);
  const agents = baseAgents.map((agent) => ({
    ...agent,
    approvalCount: approvalCenter.by_agent[agent.key],
    pendingApprovals: approvalCenter.by_agent[agent.key],
  }));

  return (
    <div className="wf-atmosphere">
      <div className="mx-auto w-full max-w-[1400px]">
        <WorkspaceEndpointCard />
        <AgentWorkspaceClient
          agents={agents}
          viewerUserId={user?.id ?? null}
          workspaceId={relayWorkspaceId}
          approvalRules={[...reviewRules, ...legacyRules]}
          approvalCenter={approvalCenter}
          passports={approvalData.passports}
          initialHasWhispers={hasWhispers}
        />

      </div>
    </div>
  );
}
