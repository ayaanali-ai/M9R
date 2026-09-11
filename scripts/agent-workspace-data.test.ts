/**
 * Agent Workspace data model — pure tests
 * ----------------------------------------------------------------------------
 * Proves the agent-first reshaping is truthful: connection state per kind,
 * run/session/recommendation attribution by agent_kind (recommendations via
 * their source session id), Run B readiness states, and the workspace status
 * strip — all without a DB or React.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_KINDS,
  agentDisplayLabel,
  normalizeAgentKind,
  agentKeyForKind,
  setupCommandFor,
  buildAgentViews,
  buildWorkspaceStatus,
  CURRENT_RUN_STALE_AFTER_MS,
  deriveRunDisplayState,
  selectCurrentRun,
  type RunDisplayStateInput,
  type WsConnection,
  type WsRun,
  type WsSession,
  type WsRule,
} from "../src/lib/agent-workspace-data.ts";

const now = "2026-06-30T03:00:00Z";

function run(p: Partial<WsRun>): WsRun {
  return {
    id: "run-1",
    agent_kind: "codex",
    repo_hint: "runleak",
    task_title: "task",
    status: "completed",
    current_phase: "completed",
    rules_loaded_count: 0,
    latest_session_id: "sess-1",
    started_at: now,
    last_seen_at: now,
    ...p,
  };
}
function session(p: Partial<WsSession>): WsSession {
  return {
    id: "sess-1",
    agent_kind: "codex",
    source_quality: "limited",
    findings_count: 1,
    rules_generated: 1,
    summary: "session",
    created_at: now,
    runId: "run-1",
    ...p,
  };
}
function rule(p: Partial<WsRule>): WsRule {
  return {
    id: "rule-1",
    workspaceId: "ws-codex",
    title: "Inspect root cause",
    ruleType: "edit_thrash_prevention",
    status: "needs_review",
    sourceReportId: "sess-1",
    sourceSessionName: "agent session",
    evidenceSummary: "",
    confidence: "medium",
    promotedAt: null,
    ...p,
  };
}

function displayState(overrides: Partial<RunDisplayStateInput> = {}) {
  return deriveRunDisplayState({
    run: run({ status: "working", latest_session_id: null, last_seen_at: "2026-07-09T11:55:00Z" }),
    evidence: { sessionId: null, humanReviewPresent: false },
    passport: { status: null },
    review: { decision: null },
    connection: { status: "active" },
    isCurrentRun: true,
    nowMs: Date.parse("2026-07-09T12:00:00Z"),
    ...overrides,
  });
}

test("the four visible connectable agent kinds are the supported Watchfloor set", () => {
  assert.deepEqual(AGENT_KINDS.map((a) => a.key), ["claude-code", "codex", "grok-build", "opencode"]);
  assert.deepEqual(AGENT_KINDS.map((a) => a.label), ["Claude", "Codex", "Grok Build", "OpenCode"]);
});

test("normalizeAgentKind maps unknowns to other", () => {
  assert.equal(normalizeAgentKind("codex"), "codex");
  assert.equal(normalizeAgentKind("CLAUDE-CODE"), "claude-code");
  assert.equal(normalizeAgentKind("gemini-cli"), "other");
  assert.equal(normalizeAgentKind(null), "other");
});

test("arbitrary connected providers keep a useful label and setup command", () => {
  assert.equal(agentDisplayLabel("gemini-cli"), "Gemini CLI");
  assert.equal(agentKeyForKind("gemini-cli"), "gemini-cli");
  const views = buildAgentViews({
    connections: [{ id: "conn-gemini", workspace_id: "ws-gemini", agent_kind: "gemini-cli", repo_hint: "repo", last_seen_at: now, liveness: "active" }],
    runs: [], sessions: [], reviewRules: [], activeRules: [], includeDisconnectedDescriptors: false,
  });
  assert.deepEqual(views.map((view) => view.label), ["Gemini CLI"]);
  assert.deepEqual(views.map((view) => view.key), ["gemini-cli"]);
  assert.match(views[0]?.setupCommand ?? "", /OATHLOCK_AGENT_KIND="gemini-cli"/);
});

test("two arbitrary providers stay separate instead of collapsing into Other", () => {
  const views = buildAgentViews({
    connections: [
      { id: "conn-gemini", workspace_id: "ws", agent_kind: "gemini-cli", repo_hint: null, last_seen_at: now, liveness: "active" },
      { id: "conn-mistral", workspace_id: "ws", agent_kind: "mistral-agent", repo_hint: null, last_seen_at: now, liveness: "active" },
    ],
    runs: [], sessions: [], reviewRules: [], activeRules: [], includeDisconnectedDescriptors: false,
  });
  assert.deepEqual(views.map((view) => view.key), ["gemini-cli", "mistral-agent"]);
  assert.deepEqual(views.map((view) => view.label), ["Gemini CLI", "Mistral Agent"]);
});

test("live Watchfloor mode can omit disconnected provider placeholders", () => {
  const views = buildAgentViews({ connections: [], runs: [], sessions: [], reviewRules: [], activeRules: [], includeDisconnectedDescriptors: false });
  assert.deepEqual(views, []);
});

test("setupCommandFor uses the agent kind in the PowerShell env form", () => {
  assert.equal(setupCommandFor("grok-build"), '$env:OATHLOCK_AGENT_KIND="grok-build"; npx m9r-cli init');
});

test("only the latest fresh eligible run is Current", () => {
  const nowMs = Date.parse("2026-07-09T12:00:00Z");
  const runs = [
    run({ id: "older-working", status: "working", latest_session_id: null, last_seen_at: "2026-07-09T11:15:00Z" }),
    run({ id: "newest-started", status: "started", latest_session_id: null, last_seen_at: "2026-07-09T11:50:00Z" }),
    run({ id: "newest-completed", status: "completed", latest_session_id: "sess-complete", last_seen_at: "2026-07-09T11:59:00Z" }),
  ];
  assert.equal(selectCurrentRun(runs, { nowMs, agentConnected: true })?.id, "newest-started");
});

test("old active-looking runs become Stale, never Current", () => {
  const nowMs = Date.parse("2026-07-09T12:00:00Z");
  const nineDaysOld = run({
    id: "nine-days-old",
    status: "working",
    latest_session_id: null,
    started_at: "2026-06-30T12:00:00Z",
    last_seen_at: "2026-06-30T12:00:00Z",
  });
  const fresh = run({
    id: "fresh",
    status: "working",
    latest_session_id: null,
    last_seen_at: "2026-07-09T11:30:00Z",
  });
  const current = selectCurrentRun([nineDaysOld, fresh], { nowMs, agentConnected: true });
  assert.equal(current?.id, "fresh");
  assert.equal(displayState({ run: nineDaysOld, isCurrentRun: Boolean(current?.id === nineDaysOld.id), nowMs }).label, "Stale");
  assert.equal(CURRENT_RUN_STALE_AFTER_MS, 6 * 60 * 60 * 1000);
});

test("waiting_for_human moves a finished agent run into the Evidence stage", () => {
  const waiting = run({
    id: "waiting",
    status: "waiting_for_human",
    latest_session_id: null,
    last_seen_at: "2026-07-09T11:59:00Z",
  });
  const state = displayState({ run: waiting, isCurrentRun: true, nowMs: Date.parse("2026-07-09T12:00:00Z") });
  assert.equal(state.state, "waiting_for_evidence");
  assert.equal(state.stage, "evidence");
});

test("a fresh waiting_for_human run remains the current run until evidence arrives", () => {
  const waiting = run({
    id: "waiting",
    status: "waiting_for_human",
    latest_session_id: null,
    last_seen_at: "2026-07-09T11:59:00Z",
  });
  assert.equal(
    selectCurrentRun([waiting], { nowMs: Date.parse("2026-07-09T12:00:00Z"), agentConnected: true })?.id,
    "waiting",
  );
});

test("an old waiting_for_human run is stale instead of cluttering the active human queue", () => {
  const waiting = run({
    id: "old-waiting",
    status: "waiting_for_human",
    latest_session_id: null,
    last_seen_at: "2026-07-09T05:59:59Z",
  });
  const state = displayState({ run: waiting, isCurrentRun: false, nowMs: Date.parse("2026-07-09T12:00:00Z") });
  assert.equal(state.state, "stale");
  assert.equal(state.label, "Stale");
});

test("shared run-state helper covers every supported display state", () => {
  assert.equal(displayState().label, "Active");
  assert.equal(displayState({ isCurrentRun: false }).label, "Waiting for agent evidence");
  assert.equal(displayState({ evidence: { sessionId: "evidence", humanReviewPresent: false } }).label, "Evidence ready");
  assert.equal(displayState({ evidence: { sessionId: "evidence", humanReviewPresent: true } }).label, "Review needed");
  assert.equal(displayState({ review: { decision: "reviewed" } }).label, "Reviewed");
  assert.equal(displayState({ review: { decision: "needs_follow_up" } }).label, "Needs follow-up");
  assert.equal(displayState({ review: { decision: "not_accepted" } }).label, "Not accepted");
  assert.equal(
    displayState({ run: run({ status: "working", latest_session_id: null, last_seen_at: "2026-07-09T05:59:59Z" }) }).label,
    "Stale",
  );
  assert.equal(displayState({ connection: { status: "revoked" } }).label, "Revoked");
  assert.equal(displayState({ run: run({ status: "expired", latest_session_id: null }) }).label, "Expired");
});

test("shared run-state precedence protects review records and never leaves old runs Active", () => {
  const staleRun = run({ status: "working", latest_session_id: null, last_seen_at: "2026-07-09T05:59:59Z" });
  assert.equal(displayState({ run: staleRun }).label, "Stale");
  assert.equal(
    displayState({ evidence: { sessionId: "approved-evidence", humanReviewPresent: true }, connection: { status: "revoked" } }).label,
    "Review needed",
  );
  assert.equal(
    displayState({ run: staleRun, connection: { status: "revoked" }, review: { decision: "reviewed" } }).label,
    "Reviewed",
  );
});

test("buildAgentViews attributes runs/sessions/recommendations to the right agent", () => {
  const connections: WsConnection[] = [
    { id: "conn-codex", workspace_id: "ws-codex", agent_kind: "codex", repo_hint: "runleak", last_seen_at: now, liveness: "active" },
  ];
  const views = buildAgentViews({
    connections,
    runs: [run({ id: "rA", agent_kind: "codex", latest_session_id: "sess-codex" })],
    sessions: [session({ id: "sess-codex", agent_kind: "codex" })],
    reviewRules: [rule({ id: "rec-codex", sourceReportId: "sess-codex" })],
    activeRules: [],
  });
  const codex = views.find((v) => v.key === "codex")!;
  assert.equal(codex.connected, true);
  assert.equal(codex.liveness, "active");
  assert.equal(codex.runs.length, 1);
  assert.equal(codex.sessions.length, 1);
  assert.equal(codex.pendingApprovals, 1, "the recommendation is attributed to codex via its source session");

  // Claude Code has nothing and is not connected.
  const claude = views.find((v) => v.key === "claude-code")!;
  assert.equal(claude.connected, false);
  assert.equal(claude.liveness, "none");
  assert.equal(claude.pendingApprovals, 0);
  assert.match(claude.setupCommand, /claude-code/);
});

test("buildAgentViews keeps two same-provider connections as distinct agents", () => {
  const connections: WsConnection[] = [
    { id: "conn-codex-a", workspace_id: "ws-1", agent_kind: "codex", repo_hint: "repo-a", last_seen_at: now, liveness: "active" },
    { id: "conn-codex-b", workspace_id: "ws-1", agent_kind: "codex", repo_hint: "repo-b", last_seen_at: now, liveness: "active" },
  ];
  const views = buildAgentViews({
    connections,
    runs: [
      run({ id: "run-a", connection_id: "conn-codex-a", agent_kind: "codex" }),
      run({ id: "run-b", connection_id: "conn-codex-b", agent_kind: "codex" }),
    ],
    sessions: [],
    reviewRules: [],
    activeRules: [],
  }).filter((view) => view.connected);
  assert.deepEqual(views.map((view) => view.id), ["connection:conn-codex-a", "connection:conn-codex-b"]);
  assert.deepEqual(views.map((view) => view.runs.map((runRecord) => runRecord.id)), [["run-a"], ["run-b"]]);
  assert.notEqual(views[0].label, views[1].label);
});

test("Run B readiness is blocked with no active rules", () => {
  const views = buildAgentViews({ connections: [], runs: [], sessions: [], reviewRules: [], activeRules: [] });
  const v = views[0];
  assert.equal(v.readiness.state, "blocked");
  assert.match(v.readiness.title, /Run B blocked/);
});

test("Run B readiness is ready when active rules exist and the last run loaded them", () => {
  const views = buildAgentViews({
    connections: [{ id: "conn-codex", workspace_id: "ws-codex", agent_kind: "codex", repo_hint: "r", last_seen_at: now, liveness: "active" }],
    runs: [run({ agent_kind: "codex", rules_loaded_count: 1 })],
    sessions: [],
    reviewRules: [],
    activeRules: [rule({ status: "active", workspaceId: "ws-codex" })],
  });
  const codex = views.find((v) => v.key === "codex")!;
  assert.equal(codex.readiness.state, "ready");
  assert.match(codex.readiness.title, /Ready for Run B/);
});

test("Codex is not ready when the active rule belongs to another workspace", () => {
  const views = buildAgentViews({
    connections: [{ id: "conn-codex", workspace_id: "ws-codex", agent_kind: "codex", repo_hint: "r", last_seen_at: now, liveness: "active" }],
    runs: [run({ agent_kind: "codex", rules_loaded_count: 1 })],
    sessions: [],
    reviewRules: [],
    activeRules: [rule({ status: "active", workspaceId: "ws-claude" })],
  });
  const codex = views.find((v) => v.key === "codex")!;
  assert.equal(codex.activeRulesCount, 0);
  assert.equal(codex.readiness.state, "blocked");
  assert.match(codex.readiness.detail, /No active rules are available/);
});

test("Run B readiness is mismatch when active rules exist but the last run loaded 0", () => {
  const views = buildAgentViews({
    connections: [{ id: "conn-codex", workspace_id: "ws-codex", agent_kind: "codex", repo_hint: "r", last_seen_at: now, liveness: "active" }],
    runs: [run({ agent_kind: "codex", rules_loaded_count: 0 })],
    sessions: [],
    reviewRules: [],
    activeRules: [
      rule({ status: "active", workspaceId: "ws-codex" }),
      rule({ id: "rule-other", status: "active", workspaceId: "ws-other" }),
    ],
  });
  const codex = views.find((v) => v.key === "codex")!;
  assert.equal(codex.readiness.state, "mismatch");
  assert.match(codex.readiness.detail, /did not load|loaded 0/i);
});

test("unassigned candidates remain attributed for audit but are excluded from normal approval counts", () => {
  // Codex is connected to ws-codex; two legacy candidates from ws-codex are
  // unlinked (no run-linked source session) but actionable for Codex.
  const connections: WsConnection[] = [
    { id: "conn-codex", workspace_id: "ws-codex", agent_kind: "codex", repo_hint: "runleak", last_seen_at: now, liveness: "active" },
  ];
  const unassigned = [
    rule({ id: "u1", title: "Stop retrying unchanged failing commands", workspaceId: "ws-codex", sourceReportId: null }),
    rule({ id: "u2", title: "Verify before the final response", workspaceId: "ws-codex", sourceReportId: null }),
  ];
  const views = buildAgentViews({
    connections,
    runs: [],
    sessions: [],
    reviewRules: [],
    activeRules: [],
    unassignedCandidates: unassigned,
  });
  const codex = views.find((v) => v.key === "codex")!;
  assert.equal(codex.unassignedCandidates.length, 2, "two unassigned candidates attributed to Codex by workspace");
  assert.equal(codex.rulesForReviewCount, 0);
  assert.equal(codex.approvalCount, 0);
  assert.equal(codex.pendingApprovals, 0, "hidden unassigned candidates must not create an unreachable rail badge");

  // Claude Code (not connected, different workspace) has none.
  const claude = views.find((v) => v.key === "claude-code")!;
  assert.equal(claude.unassignedCandidates.length, 0);
  assert.equal(claude.pendingApprovals, 0);
});

test("the top status strip excludes hidden unassigned candidates", () => {
  const unassigned = [rule({ id: "u1", workspaceId: "ws-codex", sourceReportId: null }), rule({ id: "u2", workspaceId: "ws-codex", sourceReportId: null })];
  const agents = buildAgentViews({ connections: [], runs: [], sessions: [], reviewRules: [], activeRules: [], unassignedCandidates: unassigned });
  const status = buildWorkspaceStatus({ agents, runs: [], reviewRules: [], activeRules: [], unassignedCandidates: unassigned });
  assert.equal(status.needsApproval, 0);
  assert.equal(status.rulesForReview, 0);
  assert.equal(status.activeRules, 0);
});

test("Run B blocked copy does not surface hidden unassigned candidate counts", () => {
  const connections: WsConnection[] = [
    { id: "conn-codex", workspace_id: "ws-codex", agent_kind: "codex", repo_hint: "r", last_seen_at: now, liveness: "active" },
  ];
  const unassigned = [rule({ id: "u1", workspaceId: "ws-codex", sourceReportId: null }), rule({ id: "u2", workspaceId: "ws-codex", sourceReportId: null })];
  const codex = buildAgentViews({ connections, runs: [], sessions: [], reviewRules: [], activeRules: [], unassignedCandidates: unassigned }).find((v) => v.key === "codex")!;
  assert.equal(codex.readiness.state, "blocked");
  assert.match(codex.readiness.detail, /No active rules are available/);
});

test("buildWorkspaceStatus counts connected agents, active runs, and approvals", () => {
  const connections: WsConnection[] = [
    { id: "conn-codex", workspace_id: "ws-codex", agent_kind: "codex", repo_hint: "r", last_seen_at: now, liveness: "active" },
    { id: "conn-claude", workspace_id: "ws-claude", agent_kind: "claude-code", repo_hint: "r", last_seen_at: now, liveness: "stale" },
  ];
  const runs = [
    run({ status: "working", latest_session_id: null }),
    run({ id: "r2", status: "completed" }),
  ];
  const reviewRules = [rule({}), rule({ id: "rec2" })];
  const activeRules = [
    rule({ id: "active-codex", status: "active", workspaceId: "ws-codex" }),
    rule({ id: "active-claude", status: "active", workspaceId: "ws-claude" }),
    rule({ id: "active-other", status: "active", workspaceId: "ws-other" }),
  ];
  const agents = buildAgentViews({ connections, runs, sessions: [session({})], reviewRules, activeRules });
  const status = buildWorkspaceStatus({ agents, runs, reviewRules, activeRules, nowMs: Date.parse(now) });
  assert.equal(status.connectedAgents, 1, "stale connection registrations are not online agents");
  assert.equal(status.activeRuns, 1, "only fresh started/working runs are live");
  assert.equal(status.needsApproval, 2);
  assert.equal(status.rulesForReview, 2);
  assert.equal(status.activeRules, 3);
});

test("waiting-for-human runs are not counted as live provider work", () => {
  const connections: WsConnection[] = [
    { id: "conn-codex", workspace_id: "ws-codex", agent_kind: "codex", repo_hint: "r", last_seen_at: now, liveness: "active" },
  ];
  const agents = buildAgentViews({
    connections,
    runs: [run({ status: "waiting_for_human", latest_session_id: null })],
    sessions: [],
    reviewRules: [],
    activeRules: [],
  });
  const status = buildWorkspaceStatus({ agents, runs: [], reviewRules: [], activeRules: [], nowMs: Date.parse(now) });
  assert.equal(status.activeRuns, 0);
});
