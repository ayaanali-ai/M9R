/**
 * Agent Workspace data model (pure, server-free)
 * ----------------------------------------------------------------------------
 * Reshapes the truthful, owner-scoped rows the page fetches into an AGENT-FIRST
 * model: one visible view per supported provider (Claude Code, Codex, Grok Build)
 * with its connection state, run-linked runs/sessions, the recommendations that
 * came from THIS agent's sessions, and a Run B readiness verdict.
 *
 * Attribution is real, not guessed:
 *  - A run/session belongs to an agent kind via its stored `agent_kind`.
 *  - A reviewable rule belongs to an agent via its source session id
 *    (source_report_id) → that session's agent_kind. Recommendations with no
 *    run-linked source session are workspace "legacy" and never attributed here.
 *  - Active rules are workspace-scoped (what `npx oathlock rules` returns for the
 *    workspace), so their count is shared across agents — labeled as such.
 *
 * IO-free so the workflow/readiness logic is unit-testable without a DB or React.
 */

import type { ConnectionLiveness } from "@/lib/agent-dashboard-presenter";
import type { PassportStatus, RunPassport } from "@/lib/run-passport-service";

export const AGENT_KINDS = [
  { key: "claude-code", label: "Claude", initial: "C" },
  { key: "codex", label: "Codex", initial: "Cx" },
  { key: "grok-build", label: "Grok Build", initial: "G" },
  { key: "opencode", label: "OpenCode", initial: "O" },
] as const;

/**
 * Known provider keys stay literal for branded UI paths; arbitrary connected
 * providers use their normalized slug as a stable key instead of collapsing
 * into one shared `other` bucket.
 */
export type AgentKindKey = (typeof AGENT_KINDS)[number]["key"] | "other" | (string & {});

const KNOWN_KEYS = new Set<string>([...AGENT_KINDS.map((a) => a.key), "other"]);

/** Map a stored agent_kind to one of the five workspace agent buckets. */
export function normalizeAgentKind(kind: string | null | undefined): AgentKindKey {
  const k = (kind ?? "").trim().toLowerCase();
  return (KNOWN_KEYS.has(k) ? k : "other") as AgentKindKey;
}

/** Stable display/grouping key for a provider connection or stored row. */
export function agentKeyForKind(kind: string | null | undefined): AgentKindKey {
  const normalized = normalizeAgentKind(kind);
  if (normalized !== "other") return normalized;
  const slug = (kind ?? "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return slug || "other";
}

/** The exact setup command to connect a given agent kind (PowerShell form). */
export function setupCommandFor(kind: string): string {
  const safeKind = kind.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40) || "other";
  const command = `$env:OATHLOCK_AGENT_KIND="${kind}"; npx m9r-cli init`;
  return command.replace(kind, safeKind);
}

export function agentLabel(kind: AgentKindKey): string {
  if (kind === "other") return "Other";
  return AGENT_KINDS.find((a) => a.key === kind)?.label ?? agentDisplayLabel(kind);
}

/** Human label for any connected provider, including providers added after this UI ships. */
export function agentDisplayLabel(kind: string | null | undefined): string {
  const raw = (kind ?? "").trim();
  const normalized = normalizeAgentKind(raw);
  if (normalized !== "other") return agentLabel(normalized);
  return raw
    .split(/[-_\s]+/g)
    .filter(Boolean)
    .map((part) => part.length <= 3 ? part.toUpperCase() : `${part[0].toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(" ") || "Other agent";
}

// ---------------------------------------------------------------------------
// Input row shapes (serializable subsets of the DB rows)
// ---------------------------------------------------------------------------

export interface WsConnection {
  id: string;
  workspace_id: string;
  agent_kind: string;
  repo_hint: string | null;
  last_seen_at: string | null;
  liveness: ConnectionLiveness;
  /** Active connections can start work; revoked rows remain readable for history. */
  status?: string;
  /** Human-set model override (agent_connections.model). Null = use the provider's own default. */
  model?: string | null;
  /** This connection's real, live ACP model options, self-reported by the bridge (agent_connections.available_models). Null until at least one session has started. Never a guessed/hardcoded catalog. */
  available_models?: { id: string; label: string }[] | null;
  /** The connecting human's display name/email, resolved server-side from
   * agent_connections.created_by. Null when unresolved (older row, or no
   * owner recorded) -- disambiguation falls back to a short connection id
   * rather than showing nothing. */
  owner_label?: string | null;
  /**
   * The raw agent_connections.created_by id, alongside the resolved
   * owner_label. Needed to answer "is the current viewer this connection's
   * owner" (e.g. the terminal Sharing toggle) -- a display label can't be
   * compared against a viewer's own user id, only the real id can.
   */
  owner_user_id?: string | null;
}

/**
 * Serializable subset of agent-run-service's RunBehavior snapshot (counts only,
 * never content). Optional end-to-end: absent means the run never reported it,
 * and the UI must omit the metric rather than showing 0.
 */
export interface WsRunBehavior {
  toolCalls?: number;
  changedFiles?: number;
  failedCommands?: number;
  totalTokens?: number | null;
  costUsd?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
}

export interface WsRun {
  id: string;
  connection_id?: string;
  agent_kind: string | null;
  repo_hint: string | null;
  task_title: string | null;
  status: string;
  current_phase: string | null;
  rules_loaded_count: number;
  latest_session_id: string | null;
  started_at: string | null;
  last_seen_at: string;
  completed_at?: string | null;
  behavior?: WsRunBehavior | null;
}

export const CURRENT_RUN_STALE_AFTER_MS = 6 * 60 * 60 * 1000;
/**
 * "Working" on the tab bar means actively working RIGHT NOW, not merely
 * "there is an unreviewed run" -- a run that hasn't been touched in the last
 * couple minutes isn't actively doing anything, even if it's still within the
 * 6-hour window that keeps it selected as the current run.
 */
export const ACTIVELY_WORKING_WITHIN_MS = 2 * 60 * 1000;

/**
 * Real agent_runs.status values that mean "still live." Exported so every
 * component that needs a working/idle check reads the same set instead of
 * keeping its own copy that can silently drift out of sync.
 */
export const LIVE_RUN_STATUSES = new Set(["started", "working", "blocked", "waiting_for_human", "waiting"]);
const EVIDENCE_WAITING_STATUSES = new Set(["waiting_for_human", "waiting"]);

function runActivityMs(run: WsRun): number {
  return Math.max(Date.parse(run.last_seen_at) || 0, Date.parse(run.started_at ?? "") || 0);
}

function runIsFresh(run: WsRun, nowMs: number): boolean {
  const activityMs = runActivityMs(run);
  return activityMs > 0 && nowMs - activityMs <= CURRENT_RUN_STALE_AFTER_MS;
}

/**
 * Spec vocabulary (Run lifecycle): CREATED, WORKING, BLOCKED, WAITING_FOR_EVIDENCE,
 * EVIDENCE_READY, WAITING_FOR_APPROVAL, REVIEW_READY, REVIEWED, NEEDS_FOLLOW_UP,
 * NOT_ACCEPTED, REVOKED, STALE, FAILED. Only the states below are actually
 * distinguishable from real DB signals (evidence/passport/review records) today;
 * CREATED, BLOCKED, REVIEW_READY, and FAILED have no distinct trigger yet and are
 * intentionally not fabricated here (see product guardrail: no unsupported claims).
 */
export type RunDisplayState =
  | "working"
  | "waiting_for_evidence"
  | "evidence_ready"
  | "waiting_for_approval"
  | "reviewed"
  | "needs_follow_up"
  | "not_accepted"
  | "stale"
  | "revoked"
  | "cancelled"
  | "expired";

export type RunPipelineStage = "working" | "evidence" | "approval" | "record";
export type RunConnectionState = "active" | "revoked" | "unavailable";
export type RunReviewDecision = Exclude<RunPassport["human_review"]["decision"], null>;

export interface RunDisplayStateView {
  state: RunDisplayState;
  label: string;
  tone: "ok" | "warn" | "neutral" | "danger" | "stale";
  stage: RunPipelineStage;
}

export interface RunDisplayStateInput {
  run: WsRun;
  evidence: {
    /** The recorded agent-evidence session, if one exists. */
    sessionId: string | null;
    /**
     * Whether a human review/approval marker is already present on this
     * evidence (e.g. behavior.humanApproval or a session's
     * human_approved_submission flag) — this means a human already acted,
     * not merely that the evidence pipeline judged the record complete.
     */
    humanReviewPresent: boolean;
  };
  passport: { status: PassportStatus | null } | null;
  review: { decision: RunReviewDecision | null } | null;
  connection: { status: RunConnectionState };
  /** True only when selectCurrentRun chose this run for its active connection. */
  isCurrentRun: boolean;
  nowMs?: number;
}

const RUN_DISPLAY_STATES: Record<RunDisplayState, Omit<RunDisplayStateView, "state">> = {
  working: { label: "Active", tone: "ok", stage: "working" },
  waiting_for_evidence: { label: "Waiting for agent evidence", tone: "warn", stage: "evidence" },
  evidence_ready: { label: "Evidence ready", tone: "warn", stage: "approval" },
  waiting_for_approval: { label: "Review needed", tone: "warn", stage: "approval" },
  reviewed: { label: "Reviewed", tone: "ok", stage: "record" },
  needs_follow_up: { label: "Needs follow-up", tone: "warn", stage: "record" },
  not_accepted: { label: "Not accepted", tone: "danger", stage: "record" },
  stale: { label: "Stale", tone: "stale", stage: "evidence" },
  revoked: { label: "Revoked", tone: "neutral", stage: "record" },
  cancelled: { label: "Cancelled", tone: "neutral", stage: "record" },
  expired: { label: "Expired", tone: "stale", stage: "record" },
};

function runDisplayState(state: RunDisplayState): RunDisplayStateView {
  return { state, ...RUN_DISPLAY_STATES[state] };
}

/**
 * The single display-state classifier for Agent Workspace run records.
 *
 * Review records win over connection state so revoking a connection never
 * erases the meaning of historical evidence or a saved human decision. Active
 * is deliberately narrow: it requires the selected current run, an active
 * connection, a live run status, and activity within the existing stale window.
 */
export function deriveRunDisplayState(input: RunDisplayStateInput): RunDisplayStateView {
  if (input.run.status.toLowerCase() === "cancelled") return runDisplayState("cancelled");
  if (input.run.status.toLowerCase() === "expired") return runDisplayState("expired");
  const decision = input.review?.decision;
  if (decision === "reviewed") return runDisplayState("reviewed");
  if (decision === "needs_follow_up") return runDisplayState("needs_follow_up");
  if (decision === "not_accepted") return runDisplayState("not_accepted");

  const evidenceRecorded = Boolean(input.evidence.sessionId || input.run.latest_session_id);
  // NOTE: despite the name similarity, none of these three conditions mean a
  // human has approved anything — "review_ready"/"needs_review" just mean the
  // evidence pipeline judged the record complete enough to show a human. Only
  // input.evidence.humanReviewPresent reflects an actual human action. This
  // combined flag answers "is this ready for a human to look at," not "has a
  // human already decided" — that distinction lives in `review.decision` above.
  const evidenceReadyForReview = input.evidence.humanReviewPresent
    || input.passport?.status === "review_ready"
    || input.passport?.status === "needs_review";
  if (evidenceReadyForReview) return runDisplayState("waiting_for_approval");
  if (evidenceRecorded) return runDisplayState("evidence_ready");

  const live = LIVE_RUN_STATUSES.has(input.run.status.toLowerCase());
  if (input.connection.status === "revoked" && live) return runDisplayState("revoked");
  if (live && !runIsFresh(input.run, input.nowMs ?? Date.now())) return runDisplayState("stale");
  if (EVIDENCE_WAITING_STATUSES.has(input.run.status.toLowerCase())) {
    return runDisplayState("waiting_for_evidence");
  }
  if (input.isCurrentRun && input.connection.status === "active" && live) return runDisplayState("working");
  return runDisplayState("waiting_for_evidence");
}

/**
 * Adapts dashboard records to the one shared run-state classifier. Every
 * component that shows a run's status (Watchfloor rows, the pixel-agent
 * strip, the Run Passport) must call this instead of computing its own
 * status locally — that duplication is what let the Watchfloor and the
 * Passport disagree about whether a run needed action.
 */
export function workspaceRunState(
  run: WsRun,
  agent: AgentView | null,
  passport: RunPassport | null,
  isCurrentRun: boolean,
  nowMs?: number,
): RunDisplayStateView {
  return deriveRunDisplayState({
    run,
    evidence: {
      sessionId: passport?.latest_session_id ?? run.latest_session_id,
      humanReviewPresent: passport?.evidence.human_review_present === true,
    },
    passport: { status: passport?.passport_status ?? null },
    review: { decision: passport?.human_review.decision ?? null },
    connection: { status: agent?.connectionStatus ?? "unavailable" },
    isCurrentRun,
    nowMs,
  });
}

/**
 * THE canonical run lifecycle vocabulary. One status per run, asserted here
 * and nowhere else.
 *
 * Deliberately says "Running", not "Working": "Working" was previously used
 * for six unrelated things — a presence state, a queue label, a run state
 * label, a phase fallback, a pipeline stage, and an event type — so the same
 * word meant six things on one screen. "Running" is the run's status;
 * "Working" survives only as the name of a pipeline STAGE, which is a
 * different axis (where the run is in its lifecycle, not what it needs).
 *
 * Terminal states are distinct from blocked ones: a cancelled or expired run
 * is finished, not waiting for someone to unblock it.
 */
export const RUN_LIFECYCLE = {
  running: "Running",
  waitingOnAgent: "Waiting on agent",
  waitingOnYou: "Waiting on you",
  blocked: "Blocked",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  expired: "Expired",
} as const;

export type RunLifecycleLabel = (typeof RUN_LIFECYCLE)[keyof typeof RUN_LIFECYCLE];

/**
 * "What does a human need to do about this run right now" — the single
 * function every surface calls. No component computes its own answer.
 */
export function queueLabelFor(view: RunDisplayStateView, agentLabel: string): RunLifecycleLabel {
  switch (view.state) {
    case "working":
      return RUN_LIFECYCLE.running;
    case "waiting_for_evidence":
      return `Waiting on ${agentLabel}` as RunLifecycleLabel;
    case "evidence_ready":
    case "waiting_for_approval":
      return RUN_LIFECYCLE.waitingOnYou;
    case "reviewed":
    case "needs_follow_up":
    case "not_accepted":
      return RUN_LIFECYCLE.completed;
    case "cancelled":
      return RUN_LIFECYCLE.cancelled;
    case "expired":
      return RUN_LIFECYCLE.expired;
    case "stale":
    case "revoked":
      return RUN_LIFECYCLE.blocked;
    default:
      return RUN_LIFECYCLE.blocked;
  }
}

export function selectCurrentRun(
  runs: WsRun[],
  options: { nowMs?: number; agentConnected: boolean },
): WsRun | null {
  if (!options.agentConnected) return null;
  const nowMs = options.nowMs ?? Date.now();
  return [...runs]
    .filter((run) => LIVE_RUN_STATUSES.has(run.status) && !run.latest_session_id && runIsFresh(run, nowMs))
    .sort((a, b) => runActivityMs(b) - runActivityMs(a))[0] ?? null;
}

export interface WsSession {
  id: string;
  agent_kind: string | null;
  source_quality: string | null;
  findings_count: number | null;
  rules_generated: number | null;
  summary: string | null;
  created_at: string;
  /** The run this session is attached to (run-linked only). */
  runId: string | null;
}

export interface WsRule {
  id: string;
  workspaceId: string;
  title: string;
  body?: string;
  ruleType: string;
  status: string;
  sourceReportId: string | null;
  sourceSessionName: string | null;
  evidenceSummary: string;
  confidence: string;
  promotedAt: string | null;
  createdAt?: string;
  /** The condition this rule applies under, if a human recorded one -- null
   * means no narrower condition was ever set, never "applies everywhere." */
  scopeCondition?: string | null;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type RunBReadiness = "blocked" | "ready" | "mismatch";
/** Provider authentication is independently observed by a live ACP session.
 * A M9R registration or heartbeat alone must never be represented as a
 * provider account being ready. */
export type ProviderReadiness = "ready" | "unverified";

export interface RunBReadinessView {
  state: RunBReadiness;
  title: string;
  detail: string;
}

export interface AgentView {
  /** Stable UI identity for one connected agent connection. `key` remains the provider brand. */
  id: string;
  key: AgentKindKey;
  label: string;
  initial: string;
  connectionId: string | null;
  workspaceId: string | null;
  setupCommand: string;
  /** A human-approved, non-revoked M9R connection row exists. */
  registered: boolean;
  /** A recent authenticated M9R runtime is present and can receive live work. */
  connected: boolean;
  connectionStatus?: RunConnectionState;
  /** Separate from M9R registration/presence; only ACP model discovery proves it. */
  providerReadiness: ProviderReadiness;
  liveness: ConnectionLiveness | "none";
  repoHint: string | null;
  lastSeenAt: string | null;
  runs: WsRun[];
  /** Run-linked sessions from this agent kind. */
  sessions: WsSession[];
  /** Run-linked reviewable rules (source session belongs to this agent). */
  reviewRules: WsRule[];
  /**
   * Legacy/unlinked rule candidates attributed to this agent (by their source
   * workspace). Actionable — promotable into this agent's workspace — but NOT
   * current run-linked evidence.
   */
  unassignedCandidates: WsRule[];
  /** Run-linked review rules visible in the normal Agent Workspace. */
  rulesForReviewCount: number;
  /** All actionable approvals for this agent (rulesForReviewCount + others). */
  approvalCount: number;
  /** Back-compat alias for approvalCount (rail badge). */
  pendingApprovals: number;
  /** Active rules in this agent connection's fetchable workspace. */
  activeRulesCount: number;
  readiness: RunBReadinessView;
  /** Human-set model override for this connection. Null = provider default. Only meaningful for providers whose bridge actually applies it (codex, claude-code today). */
  model?: string | null;
  /** This connection's real, live ACP model options, self-reported by the bridge. Null until at least one session has started. Never a guessed/hardcoded catalog. */
  availableModels?: { id: string; label: string }[] | null;
  /** agent_connections.created_by, carried through past the display-label computation above -- needed to answer "is the current viewer this connection's owner" (e.g. the terminal Sharing toggle), which a display string can never answer. */
  ownerUserId?: string | null;
}

export type AgentWorkspaceState = "working" | "waiting" | "idle" | "offline";

export interface AgentWorkspaceView {
  key: AgentKindKey;
  label: string;
  state: AgentWorkspaceState;
  stateLabel: string;
  task: string;
  currentPhase: string;
  confirmed: string | null;
  linked: boolean;
}

function relativeObservation(value: string | null, nowMs: number): string | null {
  if (!value) return null;
  const secs = Math.max(0, Math.floor((nowMs - new Date(value).getTime()) / 1000));
  if (!Number.isFinite(secs)) return null;
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

/** Pure sourced-state derivation for one Watchfloor workspace. */
export function deriveAgentWorkspace(agent: AgentView, nowMs = Date.now()): AgentWorkspaceView {
  const current = selectCurrentRun(agent.runs, { agentConnected: agent.connected, nowMs });
  if (!agent.registered) {
    return {
      key: agent.key,
      label: agent.label,
      state: "offline",
      stateLabel: agent.connectionStatus === "revoked" ? "Revoked" : "Not registered",
      task: "No registered workspace",
      currentPhase: "Run the connect command and approve it in M9R",
      confirmed: relativeObservation(agent.lastSeenAt, nowMs),
      linked: false,
    };
  }
  if (!agent.connected) {
    return {
      key: agent.key,
      label: agent.label,
      state: "offline",
      stateLabel: "Registered · Offline",
      task: "No live authenticated runtime",
      currentPhase: "Waiting for an authenticated runtime check-in",
      confirmed: relativeObservation(agent.lastSeenAt, nowMs),
      linked: true,
    };
  }
  if (!current) {
    return {
      key: agent.key,
      label: agent.label,
      state: "idle",
      stateLabel: "Ready",
      task: "No active controlled run",
      currentPhase: "Terminal may still be running locally",
      confirmed: relativeObservation(agent.lastSeenAt, nowMs),
      linked: true,
    };
  }
  const status = current.status.toLowerCase();
  const waiting = status === "waiting_for_human" || status === "blocked";
  const activelyWorking = nowMs - runActivityMs(current) <= ACTIVELY_WORKING_WITHIN_MS;
  const state: AgentWorkspaceState = waiting ? "waiting" : activelyWorking ? "working" : "idle";
  return {
    key: agent.key,
    label: agent.label,
    state,
    stateLabel: waiting
      ? (status === "blocked" ? RUN_LIFECYCLE.blocked : RUN_LIFECYCLE.waitingOnYou)
      : activelyWorking
        ? RUN_LIFECYCLE.running
        : "Idle",
    task: current.task_title || "Untitled run",
    // A phase is WHAT the agent is doing, not the run's status — falling back
    // to "Working" here is what made one word mean two different things in
    // adjacent columns.
    currentPhase: current.current_phase || (activelyWorking ? "No phase reported" : "No recent activity"),
    confirmed: relativeObservation(current.last_seen_at, nowMs),
    linked: true,
  };
}

function readinessFor(
  activeRulesCount: number,
  runs: WsRun[],
  rulesForReviewCount: number,
  label: string,
): RunBReadinessView {
  if (activeRulesCount === 0) {
    return {
      state: "blocked",
      title: "Run B blocked",
      detail:
        rulesForReviewCount > 0
          ? `${rulesForReviewCount} rule candidate${rulesForReviewCount === 1 ? "" : "s"} need review. Promote one for ${label} before starting Run B.`
          : "No active rules are available. Record approved agent evidence or promote a trusted candidate first.",
    };
  }
  // Active rules exist. If the agent's most recent run never loaded them, flag it.
  const latest = runs[0];
  if (latest && latest.rules_loaded_count === 0) {
    return {
      state: "mismatch",
      title: "Rules mismatch",
      detail:
        "Dashboard shows active rules, but the agent's last run loaded 0. Run npx m9r-cli rules again, and check promotion/workspace scoping before continuing.",
    };
  }
  return {
    state: "ready",
    title: "Ready for Run B",
    detail: "This agent should load active rules with npx m9r-cli rules.",
  };
}

/**
 * Build one AgentView per distinct connection from already-truthful inputs.
 * `key` remains the provider brand for icons and aggregate approval counts;
 * `id` is the connection-scoped selection identity. Missing provider buckets
 * remain as disconnected setup slots so the connect ceremony still works.
 */
export function buildAgentViews(input: {
  connections: WsConnection[];
  runs: WsRun[];
  sessions: WsSession[];
  reviewRules: WsRule[];
  activeRules: WsRule[];
  /** Legacy/unlinked needs_review rules, attributed by their source workspace. */
  unassignedCandidates?: WsRule[];
  /** The live Watchfloor passes false so users only see agents they actually connected. */
  includeDisconnectedDescriptors?: boolean;
}): AgentView[] {
  const connections = [...input.connections];
  const kindCounts = new Map<AgentKindKey, number>();
  // Same kind AND same (or absent) owner -- e.g. two Codex connections both
  // made by the same person, confirmed to be real live data, not just a
  // hypothetical. Owner-label disambiguation alone can't tell those apart
  // (both would render as the identical "Ayaan's Codex"), so this tracks
  // whether the id-based suffix still needs to be appended on top.
  const kindOwnerCounts = new Map<string, number>();
  const connectionsByKind = new Map<AgentKindKey, WsConnection[]>();
  const connectionById = new Map<string, WsConnection>();
  for (const connection of connections) {
    const kind = agentKeyForKind(connection.agent_kind);
    kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
    const kindOwnerKey = `${kind}::${connection.owner_label ?? connection.id}`;
    kindOwnerCounts.set(kindOwnerKey, (kindOwnerCounts.get(kindOwnerKey) ?? 0) + 1);
    (connectionsByKind.get(kind) ?? connectionsByKind.set(kind, []).get(kind)!).push(connection);
    connectionById.set(connection.id, connection);
  }

  const firstConnectionByKind = new Map<AgentKindKey, string>();
  for (const [kind, kindConnections] of connectionsByKind) firstConnectionByKind.set(kind, kindConnections[0].id);

  const runsByConnection = new Map<string, WsRun[]>();
  const fallbackRunsByKind = new Map<AgentKindKey, WsRun[]>();
  for (const run of input.runs) {
    const connection = run.connection_id ? connectionById.get(run.connection_id) : undefined;
    if (connection) {
      (runsByConnection.get(connection.id) ?? runsByConnection.set(connection.id, []).get(connection.id)!).push(run);
    } else {
      const kind = agentKeyForKind(run.agent_kind);
      (fallbackRunsByKind.get(kind) ?? fallbackRunsByKind.set(kind, []).get(kind)!).push(run);
    }
  }

  // A run's latest_session_id is the only durable link available on the
  // session row, so use that run link to preserve connection-level evidence
  // attribution without inventing a session connection column.
  const sessionConnectionById = new Map<string, string>();
  for (const run of input.runs) {
    if (run.latest_session_id && run.connection_id && connectionById.has(run.connection_id)) {
      sessionConnectionById.set(run.latest_session_id, run.connection_id);
    }
  }
  const sessionsByConnection = new Map<string, WsSession[]>();
  const fallbackSessionsByKind = new Map<AgentKindKey, WsSession[]>();
  for (const session of input.sessions) {
    const connectionId = sessionConnectionById.get(session.id);
    if (connectionId) {
      (sessionsByConnection.get(connectionId) ?? sessionsByConnection.set(connectionId, []).get(connectionId)!).push(session);
    } else {
      const kind = agentKeyForKind(session.agent_kind);
      (fallbackSessionsByKind.get(kind) ?? fallbackSessionsByKind.set(kind, []).get(kind)!).push(session);
    }
  }

  const reviewByConnection = new Map<string, WsRule[]>();
  const fallbackReviewByKind = new Map<AgentKindKey, WsRule[]>();
  const sessionById = new Map(input.sessions.map((session) => [session.id, session]));
  for (const rule of input.reviewRules) {
    const connectionId = rule.sourceReportId ? sessionConnectionById.get(rule.sourceReportId) : undefined;
    if (connectionId) {
      (reviewByConnection.get(connectionId) ?? reviewByConnection.set(connectionId, []).get(connectionId)!).push(rule);
    } else {
      const kind = agentKeyForKind(rule.sourceReportId ? sessionById.get(rule.sourceReportId)?.agent_kind : null);
      (fallbackReviewByKind.get(kind) ?? fallbackReviewByKind.set(kind, []).get(kind)!).push(rule);
    }
  }

  const unassignedByConnection = new Map<string, WsRule[]>();
  const fallbackUnassignedByKind = new Map<AgentKindKey, WsRule[]>();
  const firstConnectionByWorkspace = new Map<string, string>();
  for (const connection of connections) if (!firstConnectionByWorkspace.has(connection.workspace_id)) firstConnectionByWorkspace.set(connection.workspace_id, connection.id);
  for (const rule of input.unassignedCandidates ?? []) {
    const connectionId = firstConnectionByWorkspace.get(rule.workspaceId);
    if (connectionId) {
      (unassignedByConnection.get(connectionId) ?? unassignedByConnection.set(connectionId, []).get(connectionId)!).push(rule);
    } else {
      (fallbackUnassignedByKind.get("other") ?? fallbackUnassignedByKind.set("other", []).get("other")!).push(rule);
    }
  }

  const buildView = (key: AgentKindKey, initial: string, label: string, conn: WsConnection | null): AgentView => {
    // `status = active` is durable registration state. Only a fresh heartbeat
    // makes this connection live on the Watchfloor or eligible for interaction.
    const registered = Boolean(conn && (conn.status === "active" || !conn.status));
    const connectionActive = registered && conn?.liveness === "active";
    const id = conn ? `connection:${conn.id}` : `kind:${key}`;
    const fallbackRuns = firstConnectionByKind.get(key) === conn?.id ? fallbackRunsByKind.get(key) ?? [] : [];
    const fallbackSessions = firstConnectionByKind.get(key) === conn?.id ? fallbackSessionsByKind.get(key) ?? [] : [];
    const fallbackReview = firstConnectionByKind.get(key) === conn?.id ? fallbackReviewByKind.get(key) ?? [] : [];
    const fallbackUnassigned = firstConnectionByKind.get(key) === conn?.id ? fallbackUnassignedByKind.get(key) ?? [] : [];
    const runs = conn ? [...(runsByConnection.get(conn.id) ?? []), ...fallbackRuns] : fallbackRunsByKind.get(key) ?? [];
    const sessions = conn ? [...(sessionsByConnection.get(conn.id) ?? []), ...fallbackSessions] : fallbackSessionsByKind.get(key) ?? [];
    const reviewRules = conn ? [...(reviewByConnection.get(conn.id) ?? []), ...fallbackReview] : fallbackReviewByKind.get(key) ?? [];
    const unassignedCandidates = conn ? [...(unassignedByConnection.get(conn.id) ?? []), ...fallbackUnassigned] : fallbackUnassignedByKind.get(key) ?? [];
    const rulesForReviewCount = reviewRules.length;
    const approvalCount = rulesForReviewCount;
    const activeRulesCount = conn ? input.activeRules.filter((rule) => rule.workspaceId === conn.workspace_id && rule.status === "active").length : 0;
    const connectionLabel = conn ? agentDisplayLabel(conn.agent_kind) : label;
    // Per-owner identity: once a workspace has more than one connection of
    // the same agent kind, disambiguate by who connected it ("Maya's Claude
    // Code") rather than a short connection id -- a computed display rule,
    // not a stored field, so it never goes stale and a single connection of
    // a kind still shows the plain provider name with no clutter. Falls back
    // to the id-based form only when no owner could be resolved (an older
    // row, or a workspace-scoped connection with no recorded creator).
    const sameKindOwnerCount = conn ? kindOwnerCounts.get(`${key}::${conn.owner_label ?? conn.id}`) ?? 1 : 1;
    const displayLabel = conn && (kindCounts.get(key) ?? 0) > 1
      ? conn.owner_label
        ? sameKindOwnerCount > 1
          // Same kind AND same owner still collide (e.g. one person's two
          // Codex connections) -- owner-qualify AND disambiguate by id, so
          // two rows never render as the identical string.
          ? `${conn.owner_label}'s ${connectionLabel} · ${shortIdentity(conn.id)}`
          : `${conn.owner_label}'s ${connectionLabel}`
        : `${connectionLabel} · ${shortIdentity(conn.id)}`
      : connectionLabel;
    return {
      id,
      key,
      label: displayLabel,
      ownerUserId: conn?.owner_user_id ?? null,
      initial,
      connectionId: conn?.id ?? null,
      workspaceId: conn?.workspace_id ?? null,
      setupCommand: setupCommandFor(conn?.agent_kind ?? key),
      registered,
      connected: connectionActive,
      connectionStatus: conn?.status === "revoked" ? "revoked" : connectionActive ? "active" : "unavailable",
      providerReadiness: conn?.available_models?.length ? "ready" : "unverified",
      liveness: conn ? conn.liveness : "none",
      repoHint: conn?.repo_hint ?? null,
      lastSeenAt: conn?.last_seen_at ?? null,
      runs,
      sessions,
      reviewRules,
      unassignedCandidates,
      rulesForReviewCount,
      approvalCount,
      pendingApprovals: approvalCount,
      activeRulesCount,
      readiness: readinessFor(activeRulesCount, runs, rulesForReviewCount, displayLabel),
      model: conn?.model ?? null,
      availableModels: conn?.available_models ?? null,
    };
  };

  const views: AgentView[] = [];
  for (const connection of connections) {
    const kind = agentKeyForKind(connection.agent_kind);
    const descriptor = AGENT_KINDS.find((agent) => agent.key === kind);
    views.push(buildView(kind, descriptor?.initial ?? "A", descriptor?.label ?? "Other", connection));
  }
  if (input.includeDisconnectedDescriptors !== false) {
    for (const descriptor of AGENT_KINDS) {
      if (!connectionsByKind.has(descriptor.key)) views.push(buildView(descriptor.key, descriptor.initial, descriptor.label, null));
    }
  }
  return views;
}

function shortIdentity(value: string): string {
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

// ---------------------------------------------------------------------------
// Workspace status strip
// ---------------------------------------------------------------------------

export interface WorkspaceStatus {
  connectedAgents: number;
  activeRuns: number;
  needsApproval: number;
  rulesForReview: number;
  activeRules: number;
}

export function buildWorkspaceStatus(input: {
  agents: AgentView[];
  runs: WsRun[];
  reviewRules: WsRule[];
  activeRules: WsRule[];
  /** Legacy/unlinked candidates — actionable, so they count toward approvals. */
  unassignedCandidates?: WsRule[];
  nowMs?: number;
}): WorkspaceStatus {
  const nowMs = input.nowMs ?? Date.now();
  const activeRuns = input.agents.filter(
    (agent) => agent.connected && agent.runs.some((run) => {
      const status = run.status.toLowerCase();
      return (status === "started" || status === "working")
        && !run.latest_session_id
        && runIsFresh(run, nowMs);
    }),
  ).length;
  const reviewable = input.reviewRules.length;
  return {
    connectedAgents: input.agents.filter((a) => a.connected).length,
    activeRuns,
    needsApproval: reviewable,
    rulesForReview: reviewable,
    activeRules: input.activeRules.filter((r) => r.status === "active").length,
  };
}
