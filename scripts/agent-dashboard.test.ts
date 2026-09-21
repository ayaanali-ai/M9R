/**
 * Agent Dashboard + run lifecycle — wiring & policy tests
 * ----------------------------------------------------------------------------
 * The repo's test harness runs without a live Supabase, so DB-bound guarantees
 * (Bearer auth, owner-scoping, run-event redaction, promotion) are verified
 * structurally: the routes/services/SQL provably enforce the invariant. Pure
 * logic (redaction, conservative copy, proof shaping) is executed directly in
 * agent-run-core.test.ts. The Agent Workspace IA is asserted against the page,
 * the AgentWorkspaceClient, and the pure agent-workspace-data module.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { FORBIDDEN_PROOF_PHRASES } from "../src/lib/agent-run-core.ts";
import {
  buildPreflightDecision,
  classifyPreflightRisk,
  detectSensitiveAreas,
  matchActiveRules,
  type PreflightRule,
} from "../src/lib/agent-preflight-service.ts";
import {
  buildPassportReview,
  buildRunPassport,
  derivePassportStatus,
  extractVerificationSummary,
  summarizeRuleHealth,
  type RunPassportInput,
} from "../src/lib/run-passport-service.ts";
import {
  M9R_RULES_COMMAND,
  buildControlledRunPrompt,
  buildEvidenceTemplate,
  buildRunHandoff,
} from "../src/lib/run-handoff-service.ts";
import {
  deriveQualitySignals,
  extractQualitySignals,
  hasCommandTiedVerificationSignal,
} from "../src/lib/quality-signal-extraction.ts";
import {
  MAX_REVIEW_NOTE_LENGTH,
  REVIEW_DECISION_EVENT_TYPE,
  buildRunReviewEventPayload,
  containsActiveReviewNotePayload,
  humanReviewFromEvents,
  isRunReviewDecision,
  parseRunReviewEventMessage,
} from "../src/lib/run-review-decision-service.ts";

const root = process.cwd();
const WORKSPACE = "src/components/product/AgentWorkspaceClient.tsx";
// AgentWorkspaceClient.tsx was split into src/components/product/agent-workspace/*
// (approval-center.tsx, run-panels.tsx, preflight.tsx, strip-board.tsx,
// handoff.tsx, shared.tsx) with the orchestrator left in the original file.
// `read(WORKSPACE)` below transparently returns the concatenation of the
// orchestrator plus every split file, so every existing assertion keeps
// checking the same source text regardless of which file it now lives in --
// same multi-file-read pattern as scripts/workspace-rules.test.ts.
const WORKSPACE_SPLIT_FILES = [
  WORKSPACE,
  "src/components/product/agent-workspace/shared.tsx",
  "src/components/product/agent-workspace/strip-board.tsx",
  "src/components/product/agent-workspace/run-panels.tsx",
  "src/components/product/agent-workspace/preflight.tsx",
  "src/components/product/agent-workspace/approval-center.tsx",
  "src/components/product/agent-workspace/handoff.tsx",
];
const read = (p: string) =>
  p === WORKSPACE
    ? WORKSPACE_SPLIT_FILES.map((f) => readFileSync(resolve(root, f), "utf8")).join("\n")
    : readFileSync(resolve(root, p), "utf8");

const PAGE = "src/app/dashboard/agents/page.tsx";
const PASSPORT_LOADER = "src/lib/run-passport-loader.ts";
const HOME_PAGE = "src/app/page.tsx";
const MEMORY_VIEW = "src/components/product/MemoryView.tsx";

test("Herd-grade navigation preserves durable registrations while separating live leases", () => {
  const summary = read("src/lib/agent-status-summary.ts");
  assert.match(summary, /registered: boolean/);
  assert.match(summary, /liveness: ConnectionLiveness/);
  assert.match(summary, /connections\.map\(/, "all active registrations should remain visible in navigation");
  assert.match(summary, /const live = liveness === "active"/);
  assert.match(summary, /connected: live/);
  assert.match(summary, /live,/);
  assert.match(summary, /registered: true/);
});

test("Herd-grade connection banner distinguishes reconnecting registrations from first setup", () => {
  const banner = read("src/components/product/MachineConnectionBanner.tsx");
  assert.match(banner, /hasRegisteredConnection/);
  assert.match(banner, /Registered agents are offline/);
  assert.match(banner, /No new approval is required/);
  assert.match(banner, /No agent runtime is currently reaching this workspace/);
});
const DRAFT_TOOLS = "src/components/product/RuleDraftTools.tsx";
const WORKSPACE_UI = "src/components/product/WorkspaceUI.tsx";
const CONFIRM_DIALOG = "src/components/product/ProductConfirmDialog.tsx";
const RULES_MANAGER = "src/components/product/RuleDraftTools.tsx";
const DATA = "src/lib/agent-workspace-data.ts";
const APPROVAL_CENTER = "src/lib/agent-approval-center.ts";
const SHELL = "src/components/product/ProductShell.tsx";
const JOIN_SERVICE = "src/lib/agent-join-service.ts";
const DISCONNECT_ROUTE = "src/app/api/agent/connections/[id]/disconnect/route.ts";
const CLI_DISCONNECT_ROUTE = "src/app/api/agent/disconnect/route.ts";

const ACTIVE_PREFLIGHT_RULE: PreflightRule = {
  id: "rule-active-auth",
  title: "Auth route changes need approval",
  body: "Before changing login, session, or token handling, list target files and approval context.",
  status: "active",
  deleted_at: null,
};

const PASSPORT_RUN: RunPassportInput["run"] = {
  id: "run-passport-1",
  connection_id: "conn-1",
  workspace_id: "workspace-1",
  agent_kind: "codex",
  repo_hint: "oathlock",
  task_title: "Update dashboard docs",
  status: "completed",
  current_phase: "submitted",
  rules_loaded_count: 2,
  latest_session_id: "session-1",
  rule_health: null,
  behavior: null,
  started_at: "2026-07-02T12:00:00.000Z",
  last_seen_at: "2026-07-02T12:06:00.000Z",
  completed_at: "2026-07-02T12:07:00.000Z",
  error_message: null,
};

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

test("/dashboard routes to the agent command center", () => {
  assert.match(read("src/app/dashboard/page.tsx"), /redirect\(["']\/dashboard\/agents["']\)/);
});

test("CLI peer discovery uses active connection lifecycle state", () => {
  const route = read("src/app/api/agent/connections/route.ts");
  assert.match(route, /isRecentlySeenConnection/);
  assert.match(route, /select\("id, agent_kind, last_seen_at"\)/);
  assert.match(route, /\.eq\("status", "active"\)/);
  assert.match(route, /\.is\("revoked_at", null\)/);
  assert.doesNotMatch(route, /\.eq\("status", "approved"\)/);
});

// ---------------------------------------------------------------------------
// Agent Workspace — structure / IA
// ---------------------------------------------------------------------------

test("the masthead header and its live status counts were removed to give the chat panel back their vertical space", () => {
  const page = read(PAGE);
  // Removed entirely per direct user request -- the chat is a fixed-height,
  // non-scrolling shell, and every fixed-size sibling above it (masthead,
  // its stat row, StripBoard's "waiting on you" bar, page padding) was
  // coming straight out of the chat's own share of that height.
  assert.doesNotMatch(page, /wf-masthead/);
  assert.doesNotMatch(page, /agent\{status\.connectedAgents === 1 \? "" : "s"\} connected/);
  assert.doesNotMatch(page, /live run\{status\.activeRuns === 1 \? "" : "s"\}/);
  assert.doesNotMatch(page, /decision\{approvalCenter\.counts\.total === 1 \? "" : "s"\} waiting/);
  // The now-dead status/CountUp plumbing that only fed the removed masthead
  // was cleaned up too, not left as unreachable code.
  assert.doesNotMatch(page, /buildWorkspaceStatus/);
  assert.doesNotMatch(page, /CountUp/);
  // Hero-first: no full-height PageHeader block on the Watchfloor itself.
  assert.ok(!/<PageHeader\s[^>]*title="The Watchfloor"/.test(page), "the Watchfloor must not spend the first viewport on a static page header");
});

test("the redundant \"waiting on you\" strip (StripBoard) was removed from the Watchfloor -- Approval Center already covers the same runs", () => {
  const client = read("src/components/product/AgentWorkspaceClient.tsx");
  assert.doesNotMatch(client, /<StripBoard/);
  const center = read("src/lib/agent-approval-center.ts");
  // The condition StripBoard used to gate on (a run needing evidence or
  // passport review) is the same one already surfaced here -- removing the
  // strip loses no information, it removes a duplicate surface.
  assert.match(center, /function evidenceApproval/);
  assert.match(center, /function evidenceApproval/);
});

test("agent rail renders Claude Code, Codex, and Grok Build (+ All agents)", () => {
  const data = read(DATA);
  for (const label of ["Claude Code", "Codex", "Grok Build"]) {
    assert.match(data, new RegExp(label), `agent kind ${label} must exist`);
  }
  assert.doesNotMatch(data, /key: "other", label: "Other"/);
  const workspace = read(WORKSPACE);
  assert.match(workspace, /All agents/);
  assert.match(workspace, /MobileAgentRail/);
});

test("agent selection is URL state shared by the sidebar picker and the floor", () => {
  const workspace = read(WORKSPACE);
  const shell = read(SHELL);
  const workspaceUi = read(WORKSPACE_UI);
  // The floor derives selection from ?agent= and writes it back on select.
  assert.match(workspace, /useSearchParams\(\)/);
  assert.match(workspace, /searchParams\.get\("agent"\)/);
  assert.match(workspace, /searchParams\.get\("run"\)/);
  assert.match(workspace, /router\.replace\(watchfloorHref\(next, nextRunId\)/);
  // The sidebar picker links to the same URLs and marks the current agent.
  assert.match(shell, /function SidebarAgentPicker/);
  assert.match(shell, /\/dashboard\/agents\?agent=\$\{key\}/);
  assert.match(shell, /aria-current=\{selected \? "true" : undefined\}/);
  // A compact mobile rail keeps selection reachable off-desktop.
  assert.match(workspace, /function MobileAgentRail/);
  assert.match(workspace, /aria-label="Agent filters"/);
  // The rail scrolls horizontally on narrow screens when the pills overflow
  // -- it must keep a real, visible scroll affordance (no hidden-scrollbar
  // utilities) so overflowing pills stay reachable instead of clipped with
  // no indication more exist.
  assert.match(workspace, /overflow-x-auto/);
  assert.doesNotMatch(workspace, /\[scrollbar-width:none\]/);
  assert.match(workspaceUi, /export function AgentMark/);
  // Each provider's own wordless mark, inlined and drawn in currentColor, so
  // no vendor brand color is reproduced and nothing is fetched from a
  // /logos/ directory at runtime. AGENT_GLYPH survives as the text-only
  // fallback for surfaces that can render a character but not an SVG.
  assert.match(workspaceUi, /export const AGENT_GLYPH/);
  assert.doesNotMatch(workspaceUi, /\/logos\//);
  // All three agent kinds get a real mark — Grok used to fall through to a
  // plain "grok" text span while Claude and Codex had proper logos.
  for (const mark of [/aria-label="Codex"/, /aria-label="Grok"/, /function AgentMark/]) {
    assert.match(workspaceUi, mark);
  }
});

test("the Watchfloor hierarchy keeps the floor focused and routes history elsewhere", () => {
  const workspace = read(WORKSPACE);
  // "Active rules" was a fourth zone here until the control-strip popover was
  // removed; rules now live only on the Rules page.
  for (const section of ["Agent Activity", "Human Decision"]) {
    assert.match(workspace, new RegExp(section), `Watchfloor zone ${section} must exist`);
  }
  assert.ok(!/<RunLedgerPanel/.test(workspace), "Run Ledger should not render on the Watchfloor");
  assert.match(workspace, /selectedRunId/);
  assert.match(workspace, /setSelectedRunId/);
  assert.ok(!/type Tab =|const TABS|role="tab"/.test(workspace), "primary detail tabs must stay removed");
  assert.ok(!/<ApprovalSummaryCard|function ApprovalSummaryCard/.test(workspace), "Approval Center must not render as a main dashboard card");
});

test("the Watchfloor pipeline embodies the loop structurally: Working, Evidence, Approval, Record", () => {
  const workspace = read(WORKSPACE);
  assert.match(workspace, /function Pipeline/);
  for (const stage of ["working", "evidence", "approval", "record"]) {
    assert.match(workspace, new RegExp(`id: "${stage}"`), `pipeline stage ${stage} must exist`);
  }
  assert.match(workspace, /wf-stage--\$\{phase\}/);
  assert.match(workspace, /aria-label="Run pipeline"/);
});

test("the hero primary action follows run state", () => {
  const workspace = read(WORKSPACE);
  assert.match(workspace, /Start controlled run/);
  assert.match(workspace, /Open evidence review/);
  assert.match(workspace, /No current run/);
  // The Run Passport was cut: a decided or revoked run offers no action here
  // rather than linking to a surface that no longer exists.
  assert.match(workspace, /if \(decisionDone \|\| state === "Revoked"\) return null;/);
  assert.doesNotMatch(workspace, /Open Run Passport/);
});

test("the Watchfloor never implies remote control, forced compliance, or human-made proof", () => {
  const text = read(WORKSPACE).toLowerCase();
  for (const banned of ["remote control", "forced compliance", "submit your evidence", "upload proof", "later proof", "proof of correctness", "guaranteed safety"]) {
    assert.ok(!text.includes(banned), `Watchfloor copy must not contain "${banned}"`);
  }
});

test("the hero run consolidates agent activity", () => {
  const workspace = read(WORKSPACE);
  for (const zone of ["wf-evidence", "Instruction channel", "Agent Evidence"]) {
    assert.match(workspace, new RegExp(zone), `hero zone ${zone} must exist`);
  }
  // The "Manage rules" link lived inside the Active-rules popover on the
  // control strip, which was removed -- Rules is its own sidebar destination.
});

test("old horizontal workflow bar and Later proof wording are removed", () => {
  const workspace = read(WORKSPACE);
  assert.ok(!/function WorkflowSteps|<WorkflowSteps|Later proof/.test(workspace));
});

test("the hero run makes run status and the next human action obvious", () => {
  const workspace = read(WORKSPACE);
  const approvalCenter = read(APPROVAL_CENTER);
  assert.match(workspace, /workspaceRunState/);
  assert.match(workspace, /import\s*\{[\s\S]*workspaceRunState[\s\S]*\}\s*from\s*"@\/lib\/agent-workspace-data"/);
  assert.doesNotMatch(workspace, /function workspaceRunState/);
  const data = read(DATA);
  assert.match(data, /Waiting for agent evidence/);
  assert.match(data, /Evidence ready/);
  assert.match(data, /Review needed/);
  assert.match(workspace, /workspaceRunState\(run, owner,/);
  assert.match(workspace, /function ApprovalCenter/);
  assert.match(workspace + approvalCenter, /Open evidence review/);
  assert.match(workspace, /Ask the agent to prepare a redacted evidence summary/);
});

test("the hero run and the Approval Center share one derived run state", () => {
  const workspace = read(WORKSPACE);
  assert.match(workspace, /import\s*\{[\s\S]*workspaceRunState[\s\S]*\}\s*from\s*"@\/lib\/agent-workspace-data"/);
  assert.doesNotMatch(workspace, /function workspaceRunState/);
  assert.match(workspace, /const state = workspaceRunState\(run, agent, passport, isCurrentRun\)/);
  assert.match(workspace, /const runState = linkedRun[\s\S]*workspaceRunState\(linkedRun,/);
  assert.ok(!/function heroPipeline|function passportStatusForRun|runDisplayStatus/.test(workspace));
});

test("a selected run pinned by a stale ?run= URL is never treated as the current live run", () => {
  // Regression for the 2026-07-19 incident: a URL's ?run= param was accepted
  // as the selected run with no liveness check, so an old run's resolved
  // coordination history could render on the Watchfloor indistinguishably
  // from something happening right now. The banner that used to spell this
  // out in text is gone (explicit user direction), but the underlying safety
  // property -- isCurrentRun/hasLiveRun only ever true when the selected
  // run's id actually matches the agent's real current run -- still has to
  // hold everywhere the selected run is rendered.
  const workspace = read(WORKSPACE);
  const liveCheck = "Boolean\\(selectedRun && currentRun && selectedRun\\.id === currentRun\\.id\\)";
  // The control strip's `hasLiveRun` prop went away with the Run Detail
  // button. The safety property itself is unchanged and still guards the run
  // actually rendered, via isCurrentRun on HeroRun.
  assert.match(workspace, new RegExp(`isCurrentRun=\\{${liveCheck}\\}`));
});

test("a disconnected agent gets the connect ceremony, keyed off real state", () => {
  const workspace = read(WORKSPACE);
  assert.match(workspace, /function ConnectCeremony/);
  assert.match(workspace, /\{selectedAgent && !selectedAgent\.connected &&/);
  // Registration, online presence, and provider account readiness are distinct
  // state axes. A stale heartbeat never erases a human-approved registration.
  assert.match(workspace, /const approved = agent\.registered;/);
  assert.match(workspace, /const seen = approved && Boolean\(agent\.lastSeenAt\);/);
  assert.match(workspace, /Nothing connects until a human approves\./);
  assert.match(workspace, /Approve in the browser/);
  assert.match(workspace, /automatic M9R workflow was installed/);
});

test("registered offline connections remain on the Watchfloor but never enter relay membership", () => {
  const page = read("src/app/dashboard/agents/page.tsx");
  const workspace = read(WORKSPACE);
  assert.match(page, /const visibleConnectionGroups = connectionGroups/);
  assert.match(page, /const wsConnections: WsConnection\[\] = visibleConnectionGroups\.map/);
  assert.match(page, /status: g\.latest\.status/);
  assert.match(page, /ensureWorkspaceChannelsForDashboard\([\s\S]*liveConnectionGroups/);
  assert.match(workspace, /Provider session unverified/);
});

test("disconnected agent shows the setup command for the correct agent kind", () => {
  const data = read(DATA);
  assert.match(data, /\$env:OATHLOCK_AGENT_KIND="\$\{kind\}"; npx m9r-cli init/);
  const workspace = read(WORKSPACE);
  assert.match(workspace, /agent\.setupCommand/);
  assert.match(workspace, /Copy \$\{agent\.key\} setup command/);
});

// ---------------------------------------------------------------------------
// Rule clarity
// ---------------------------------------------------------------------------

test("rule lifecycle lives entirely on the Rules page, not on the Watchfloor", () => {
  // The Watchfloor used to carry an "Active rules: N" popover on the control
  // strip. It was removed as redundant -- Rules is its own sidebar
  // destination -- so the Watchfloor now carries no rules surface at all and
  // no longer even receives the activeRules prop.
  const workspace = read(WORKSPACE);
  assert.ok(!/Active rules:/.test(workspace), "Watchfloor must not re-add a rules strip");
  // `activeRulesCount` on the agent view is a different thing and is still
  // used; what must not come back is the activeRules rule-list prop itself.
  assert.ok(!/\bactiveRules\b(?!Count)/.test(workspace), "Watchfloor must not receive the activeRules prop");
  const memoryView = read(MEMORY_VIEW);
  assert.match(memoryView, /What the team remembers/);
  assert.match(memoryView, /Needs your review/);
});

test("Rules maintenance includes manual creation and import as review draft paths", () => {
  const tools = read(DRAFT_TOOLS);
  assert.match(tools, /Create rule/);
  assert.match(tools, /Human-written rules are saved as review drafts\./);
  assert.match(tools, /Promote a draft to make it available through <Cmd>npx m9r-cli rules<\/Cmd>\./);
  assert.match(tools, /Import rules/);
  assert.match(tools, /Paste AGENTS\.md, CLAUDE\.md, Cursor rules, or repo instructions\./);
  assert.match(tools, /Imports create review drafts only\./);
  // Authoring is reachable from the Memory page, not the Watchfloor.
  assert.match(read(MEMORY_VIEW), /RuleDraftTools/);
  assert.ok(!/RuleDraftTools/.test(read(WORKSPACE)), "rule authoring must not live on the Watchfloor");
});

test("starter workspace rule presets create review drafts, not live rules, and state their honest limits", () => {
  const presets = read("src/lib/workspace-rules-presets.ts");
  assert.match(presets, /no-hallucinated-claims/);
  assert.match(presets, /no-silent-assumptions/);
  assert.match(presets, /no-blind-retries/);
  assert.match(presets, /no-overclaiming/);

  const tools = read(DRAFT_TOOLS);
  assert.match(tools, /import \{ WORKSPACE_RULE_PRESETS \} from "@\/lib\/workspace-rules-presets"/);
  assert.match(tools, /Enable starter rules/);
  // Uses the exact same manual-draft route as hand-written rules -- no
  // separate "presets go live immediately" path.
  assert.match(tools, /async function enableStarterRules\(\)/);
  assert.match(tools, /fetch\("\/api\/agent\/rules\/manual"/);
  // States plainly that this is advisory text, not a code-level guarantee --
  // no rule's content can trigger a hard approval gate today.
  assert.match(tools, /no code-level guarantee an agent obeys them/);
});

test("manual and imported rule UI posts to the new draft routes", () => {
  const tools = read(DRAFT_TOOLS);
  const manualRoute = read("src/app/api/agent/rules/manual/route.ts");
  const importRoute = read("src/app/api/agent/rules/import/route.ts");
  assert.match(tools, /fetch\("\/api\/agent\/rules\/manual"/);
  assert.match(tools, /fetch\("\/api\/agent\/rules\/import"/);
  assert.match(tools, /path_patterns: manualScope/);
  assert.match(tools, /path_patterns: importScope/);
  assert.match(tools, /risk_level: manualRisk \|\| null/);
  assert.match(tools, /risk_level: importRisk \|\| null/);
  assert.ok(!/activate/.test(tools + manualRoute + importRoute), "manual/import UI and routes must not support activate input");
  assert.ok(!/create active|created active|auto-activate|automatically active/i.test(tools + manualRoute + importRoute));
});

test("rule approvals in the drawer surface source context without leaking elsewhere", () => {
  const workspace = read(WORKSPACE);
  assert.match(workspace, /rule\.body \|\| rule\.title/);
  assert.match(workspace, /rule\.evidenceSummary &&/);
});

test("the drawer promotes rules only when a connected target agent exists", () => {
  const workspace = read(WORKSPACE);
  assert.match(workspace, /<PromoteRuleButton/);
  assert.match(workspace, /targetConnectionId=\{agent\.connectionId\}/);
  assert.match(workspace, /Connect this agent to promote/);
  // The Watchfloor has no active-rule promote path — promotion targets review drafts.
  assert.ok(!/ActiveRuleCard/.test(workspace));
});

test("memory lifecycle CRUD stays off the Watchfloor and on the Memory page", () => {
  const workspace = read(WORKSPACE);
  assert.ok(!/ActiveRuleCard|ArchivedRuleCard|ReviewRuleCard|Delete archived rule|Archive this active rule/.test(workspace));
  const memoryView = read(MEMORY_VIEW);
  assert.match(memoryView, /Stop remembering this\? Agents will no longer load it before a run\./);
  assert.match(memoryView, /It returns to review and must be confirmed again before agents load it\./);
  assert.match(memoryView, /It will be removed from product views\. Its audit history remains stored\./);
});

test("Watchfloor destructive actions use the product confirmation dialog with the same copy", () => {
  const workspace = read(WORKSPACE);
  const dialog = read(CONFIRM_DIALOG);
  assert.match(workspace, /ProductConfirmDialog/);
  assert.ok(!/window\.confirm\(|\bconfirm\(/.test(workspace), "the Watchfloor must not use native confirm dialogs");
  assert.match(dialog, /role="dialog"/);
  assert.match(dialog, /aria-modal="true"/);
  assert.match(dialog, /onCancel/);
  assert.match(workspace, /The draft will be removed\./);
  // The second confirm copy belonged to the Disconnect / revoke button, which
  // was removed from the control strip along with Share resume and Run Detail.
});

test("Active rules copy says these are returned by npx m9r-cli rules", () => {
  const tools = read(DRAFT_TOOLS);
  assert.match(tools, /npx m9r-cli rules/);
  // Active rules shown are only status === active (built on the server).
  assert.match(read(PAGE), /const active = rules\.filter\(\(r\) => r\.status === "active"\)/);
});

// ---------------------------------------------------------------------------
// Preflight gate
// ---------------------------------------------------------------------------

test("preflight allows a clear low-risk docs/UI task when active rules exist", () => {
  const decision = buildPreflightDecision(
    {
      task: "Update docs copy and polish dashboard UI layout spacing",
      pathHints: ["docs/README.md", "src/components/product/AgentWorkspaceClient.tsx"],
    },
    [ACTIVE_PREFLIGHT_RULE],
  );

  assert.equal(decision.ok, true);
  assert.equal(decision.risk_level, "low");
  assert.equal(decision.status, "allowed");
  assert.equal(decision.active_rule_count, 1);
  assert.deepEqual(decision.missing_requirements, []);
});

test("preflight warns on low-risk tasks when no active repo rules are available", () => {
  const decision = buildPreflightDecision(
    {
      task: "Update docs copy for the setup page",
      pathHints: ["docs/setup.md"],
    },
    [],
  );

  assert.equal(decision.risk_level, "low");
  assert.equal(decision.status, "warned");
  assert.equal(decision.active_rule_count, 0);
  assert.ok(decision.missing_requirements.includes("No active repo rules are available for this agent."));
});

test("preflight classifies auth payment and migration tasks as approval-required high risk", () => {
  const decision = buildPreflightDecision(
    {
      task: "Update login session token handling, Stripe billing webhook, and Supabase migration",
      pathHints: ["src/app/api/auth/route.ts", "supabase/migrations/202607020001_billing.sql"],
    },
    [ACTIVE_PREFLIGHT_RULE],
  );

  assert.equal(decision.risk_level, "high");
  assert.equal(decision.status, "needs_approval");
  assert.equal(decision.approval_required, true);
  assert.ok(decision.sensitive_areas.includes("auth"));
  assert.ok(decision.sensitive_areas.includes("payments"));
  assert.ok(decision.sensitive_areas.includes("migrations"));
});

test("preflight blocks obviously destructive production deletion without enough detail", () => {
  const decision = buildPreflightDecision(
    {
      task: "Delete production user data from Supabase",
      pathHints: ["supabase/migrations/delete-users.sql"],
    },
    [ACTIVE_PREFLIGHT_RULE],
  );

  assert.equal(decision.risk_level, "high");
  assert.equal(decision.status, "blocked");
  assert.equal(decision.approval_required, true);
  assert.ok(decision.sensitive_areas.includes("destructive_action"));
  assert.ok(decision.sensitive_areas.includes("user_data"));
});

test("preflight detects normalized sensitive areas from task and path hints", () => {
  const areas = detectSensitiveAreas("Change middleware rate limits for the API", [
    "src/app/api/webhooks/stripe/route.ts",
    ".env.local",
  ]);

  assert.deepEqual([...new Set(areas)], areas);
  assert.ok(areas.includes("api"));
  assert.ok(areas.includes("payments"));
  assert.ok(areas.includes("config"));
  assert.ok(areas.includes("secrets"));
});

test("preflight matches only active non-deleted rules and never returns rule bodies", () => {
  const rules: PreflightRule[] = [
    ACTIVE_PREFLIGHT_RULE,
    {
      id: "retired-auth",
      title: "Auth retired",
      body: "token session",
      status: "retired",
      deleted_at: null,
    },
    {
      id: "draft-auth",
      title: "Auth draft",
      body: "login session",
      status: "needs_review",
      deleted_at: null,
    },
    {
      id: "deleted-auth",
      title: "Auth deleted",
      body: "login session",
      status: "active",
      deleted_at: "2026-07-02T00:00:00.000Z",
    },
  ];

  const matches = matchActiveRules("Change login session token handling", ["src/app/api/auth/route.ts"], rules);

  assert.deepEqual(matches.map((rule) => rule.id), ["rule-active-auth"]);
  assert.ok(!("body" in matches[0]), "matched rules must not expose private rule body");
  assert.match(matches[0].reason, /Matched active rule keywords:/);
});

test("preflight risk classifier is deterministic and local", () => {
  const low = classifyPreflightRisk({ task: "Polish styling for the docs card", pathHints: ["src/components/DocsCard.tsx"] });
  const medium = classifyPreflightRisk({ task: "Change API route caching and rate limits", pathHints: ["src/app/api/items/route.ts"] });
  const high = classifyPreflightRisk({ task: "Rotate production secrets", pathHints: [".env.production"] });

  assert.equal(low.risk_level, "low");
  assert.equal(medium.risk_level, "medium");
  assert.equal(high.risk_level, "high");
});

test("preflight does not tag bare 'session' as auth risk, and bare 'live' does not trigger deploy on its own -- confirmed live: a task mentioning ACP 'session pooling' and 'live sessions' got flagged auth risk for nothing", () => {
  const sessionOnly = classifyPreflightRisk({ task: "Investigate concurrent session pooling for live sessions" });
  assert.ok(!sessionOnly.sensitive_areas.includes("auth"), "bare 'session' must not trigger the auth area");
  assert.ok(!sessionOnly.sensitive_areas.includes("deploy"), "bare 'live' must not trigger the deploy area on its own");
  assert.notEqual(sessionOnly.risk_level, "high");
});

test("preflight still catches real auth and deploy phrases, not just the bare words", () => {
  const auth = classifyPreflightRisk({ task: "Fix a bug in the login session token refresh flow" });
  assert.ok(auth.sensitive_areas.includes("auth"));
  const deploy = classifyPreflightRisk({ task: "Ready to go live -- deploy this to production" });
  assert.ok(deploy.sensitive_areas.includes("deploy"));
});

test("preflight API route validates input, authorizes context, and reads active rules only", () => {
  const route = read("src/app/api/agent/preflight/route.ts");
  assert.match(route, /export async function POST/);
  assert.match(route, /Invalid JSON body\./);
  assert.match(route, /Task is required\./);
  assert.match(route, /MAX_TASK_LENGTH/);
  assert.match(route, /Task is too large\./);
  assert.match(route, /Path hint is too large\./);
  assert.match(route, /Too many path hints\./);
  assert.match(route, /authenticateAgent\(bearerFrom\(req\.headers\.get\("authorization"\)\)\)/);
  assert.match(route, /listActiveRulesForAgent\(agent\)/);
  assert.match(route, /listWorkspaceRules\(workspaceId\)/);
  assert.match(route, /rule\.status === "active"/);
  assert.match(route, /buildPreflightDecision/);
});

test("Agent Workspace renders a selected-agent Preflight panel", () => {
  const workspace = read(WORKSPACE);
  assert.match(workspace, /<PreflightPanel key=\{agent\.connectionId \?\? agent\.key\} agent=\{agent\} \/>/);
  assert.match(workspace, /function PreflightPanel/);
  assert.match(workspace, /Task description/);
  assert.match(workspace, /Path hints/);
  assert.match(workspace, /Run preflight/);
});

test("selected connected agents expose a bounded assignment form backed by the owner route", () => {
  const workspace = read(WORKSPACE);
  assert.match(workspace, /function AssignmentPanel/);
  assert.match(workspace, /fetch\("\/api\/assignments"/);
  assert.match(workspace, /target_connection_id: agent\.connectionId/);
  assert.match(workspace, /prohibitedScope/);
  assert.match(workspace, /maxDurationMs/);
  assert.match(workspace, /evidenceRequired: true/);
  assert.match(workspace, /human_before_start/);
});

test("Agent Workspace preflight posts task, parsed path hints, and selected connection id", () => {
  const workspace = read(WORKSPACE);
  assert.match(workspace, /fetch\("\/api\/agent\/preflight"/);
  assert.match(workspace, /method: "POST"/);
  assert.match(workspace, /task: taskDescription/);
  assert.match(workspace, /path_hints: parsePathHints\(pathHints\)/);
  assert.match(workspace, /connection_id: agent\.connectionId/);
});

test("Agent Workspace preflight displays conservative status labels and result fields", () => {
  const workspace = read(WORKSPACE);
  for (const label of ["Allowed to start", "Start with caution", "Human approval required", "Blocked by policy"]) {
    assert.match(workspace, new RegExp(label), `preflight label ${label} must render`);
  }
  for (const field of ["sensitive_areas", "matched_rules", "missing_requirements", "recommended_requirements", "next_step"]) {
    assert.match(workspace, new RegExp(field), `preflight field ${field} must render`);
  }
  assert.ok(!/guarantee|guaranteed|guarantees/.test(workspace.slice(workspace.indexOf("function PreflightPanel"))));
});

test("Agent Workspace preflight starts controlled runs with the required status policy", () => {
  const workspace = read(WORKSPACE);
  assert.match(workspace, /Start controlled run/);
  assert.match(workspace, /Start controlled run with caution/);
  assert.match(workspace, /Start approved run/);
  assert.match(workspace, /Blocked by policy/);
  assert.match(workspace, /const startDisabled =/);
  assert.match(workspace, /preflightDecision\.status === "blocked"/);
  assert.match(workspace, /preflightDecision\.status === "needs_approval" && !approvalConfirmed/);
  assert.match(workspace, /I approve starting this high-risk agent run\./);
});

test("Agent Workspace dashboard start posts selected connection, task, approval, and preflight summary", () => {
  const workspace = read(WORKSPACE);
  assert.match(workspace, /function startControlledRun/);
  assert.match(workspace, /fetch\("\/api\/agent\/run\/start"/);
  assert.match(workspace, /method: "POST"/);
  assert.match(workspace, /connection_id: agent\.connectionId/);
  assert.match(workspace, /task: taskDescription/);
  assert.match(workspace, /path_hints: parsePathHints\(pathHints\)/);
  assert.match(workspace, /approved_by_human: approvalConfirmed/);
  assert.match(workspace, /approval_note: approvalNote/);
  assert.match(workspace, /matched_rule_count: preflightDecision\.matched_rules\.length/);
  assert.match(workspace, /router\.refresh\(\)/);
  assert.match(workspace, /buildRunHandoff\(\{[\s\S]*runId: json\.run_id/);
  assert.match(workspace, /task: taskDescription/);
  assert.match(workspace, /preflightStatus: json\.preflight\?\.status/);
  assert.match(workspace, /preflightRisk: json\.preflight\?\.risk_level/);
});

test("preflight route does not start runs, mutate rules, or log task content", () => {
  const route = read("src/app/api/agent/preflight/route.ts");
  assert.ok(!/startAgentRun|recordAgentSession|promoteWorkspaceRule|updateWorkspaceRuleStatus/.test(route));
  assert.ok(!/\.insert\(|\.update\(|\.delete\(|\.upsert\(/.test(route));
  assert.ok(!/console\.(log|warn|error|info|debug)/.test(route));
});

test("preflight copy contains no overclaiming language", () => {
  const text = (read("src/lib/agent-preflight-service.ts") + read("src/app/api/agent/preflight/route.ts")).toLowerCase();
  for (const phrase of FORBIDDEN_PROOF_PHRASES) {
    assert.ok(!text.includes(phrase), `preflight must not contain overclaim: "${phrase}"`);
  }
});

// ---------------------------------------------------------------------------
// Controlled Run Handoff
// ---------------------------------------------------------------------------

test("controlled run handoff builds the rules command prompt and evidence template", () => {
  const handoff = buildRunHandoff({
    runId: "run-handoff-1",
    agentName: "Codex",
    agentKind: "codex",
    task: "Update dashboard docs",
    startedAt: "2026-07-02T12:00:00.000Z",
    preflightStatus: "allowed",
    preflightRisk: "low",
    hasEvidence: false,
  });

  assert.equal(handoff.rulesCommand, M9R_RULES_COMMAND);
  assert.equal(handoff.rulesCommand, "npx m9r-cli@latest rules");
  assert.equal(handoff.identity.runId, "run-handoff-1");
  assert.equal(handoff.identity.task, "Update dashboard docs");
  assert.equal(handoff.identity.agent, "Codex (codex)");
  assert.equal(handoff.identity.startedAt, "2026-07-02T12:00:00.000Z");
  assert.equal(handoff.identity.preflight, "allowed / low");
  assert.match(handoff.agentPrompt, /You are working under M9R-controlled repo rules\./);
  assert.match(handoff.agentPrompt, /Task:\nUpdate dashboard docs/);
  assert.match(handoff.agentPrompt, /Do not claim success without agent evidence for human approval\./);
  assert.match(handoff.evidenceTemplate, /Task:\nUpdate dashboard docs/);
  for (const label of [
    "Changed files:",
    "Verification commands:",
    "Results:",
    "Failed commands:",
    "Sensitive areas touched:",
    "Rule conflicts or uncertainty:",
    "Human review notes:",
  ]) {
    assert.match(handoff.evidenceTemplate, new RegExp(label));
  }
});

test("controlled run handoff redacts obvious secrets and does not carry raw evidence or rule bodies", () => {
  const prompt = buildControlledRunPrompt({
    task: "Fix token=oak_super_secret and C:\\Users\\kaina\\repo\\secret.ts",
  });
  const evidence = buildEvidenceTemplate({
    task: "Use Bearer abc123 and password=hunter2",
  });
  const handoff = buildRunHandoff({
    runId: "run-secret",
    task: "Use sk-test-secret in /Users/kaina/private/repo/file.ts",
    hasEvidence: false,
    rawSessionEvidence: "RAW_SESSION_EVIDENCE_SHOULD_NOT_RENDER",
    ruleBodies: ["PRIVATE_RULE_BODY_SHOULD_NOT_RENDER"],
  } as never);

  const serialized = [prompt, evidence, JSON.stringify(handoff)].join("\n");
  for (const forbidden of [
    "oak_super_secret",
    "C:\\Users\\kaina",
    "Bearer abc123",
    "hunter2",
    "sk-test-secret",
    "/Users/kaina",
    "RAW_SESSION_EVIDENCE_SHOULD_NOT_RENDER",
    "PRIVATE_RULE_BODY_SHOULD_NOT_RENDER",
  ]) {
    assert.ok(!serialized.includes(forbidden), `handoff must not expose ${forbidden}`);
  }
});

test("controlled run handoff states waiting or submitted evidence status", () => {
  const waiting = buildRunHandoff({ runId: "run-waiting", task: "Docs task", hasEvidence: false });
  const submitted = buildRunHandoff({ runId: "run-submitted", task: "Docs task", hasEvidence: true });

  assert.equal(waiting.evidenceState, "waiting");
  assert.equal(waiting.evidenceStatusLabel, "Waiting for approved evidence");
  assert.equal(submitted.evidenceState, "submitted");
  assert.equal(submitted.evidenceStatusLabel, "Approved evidence submitted");
  assert.equal(submitted.passportActionLabel, "View Run Passport");
});

test("Agent Workspace renders Controlled Run Handoff with copy buttons and evidence state", () => {
  const workspace = read(WORKSPACE);
  const service = read("src/lib/run-handoff-service.ts");
  assert.match(workspace, /Run Handoff/);
  assert.match(service, /npx m9r-cli@latest rules/);
  assert.match(service, /Run this in the same repo before asking your AI coding agent to work\. It returns only active M9R rules\./);
  assert.match(workspace, /handoff\.rulesCommand/);
  assert.match(workspace, /handoff\.rulesCommandHelp/);
  assert.match(workspace, /Copy rules command/);
  assert.match(workspace, /Copy agent instruction prompt/);
  assert.match(workspace, /Copy evidence template/);
  assert.match(service, /Waiting for approved evidence/);
  assert.match(service, /Approved evidence submitted/);
  assert.match(workspace, /handoff\.evidenceStatusLabel/);
});

test("Controlled Run Handoff dashboard copy avoids raw evidence private rule bodies and overclaims", () => {
  const workspace = read(WORKSPACE);
  const handoffStart = workspace.indexOf("function ControlledRunHandoffPanel");
  assert.ok(handoffStart > -1, "ControlledRunHandoffPanel must exist");
  const handoffEnd = workspace.indexOf("function SubmitEvidenceCard", handoffStart);
  const text = (read("src/lib/run-handoff-service.ts") + workspace.slice(handoffStart, handoffEnd)).toLowerCase();
  assert.ok(!/raw_session_content|session_text|private_rule_body|rule_bodies|rule\.body/.test(text));
  for (const phrase of ["guaranteed", "verified correct", "proof"]) {
    assert.ok(!text.includes(phrase), `handoff copy must not contain "${phrase}"`);
  }
});

// ---------------------------------------------------------------------------
// Run Passport
// ---------------------------------------------------------------------------

test("run passport with no approved agent evidence returns incomplete", () => {
  const passport = buildRunPassport({
    run: { ...PASSPORT_RUN, latest_session_id: null, completed_at: null },
    activeRules: [{ id: "active-1", title: "Active rule", status: "active", deleted_at: null }],
  });

  assert.equal(passport.passport_status, "incomplete");
  assert.equal(derivePassportStatus({ run: { ...PASSPORT_RUN, latest_session_id: null } }), "incomplete");
  assert.match(passport.summary, /No approved agent evidence recorded yet/);
  assert.match(passport.review.next_step, /Ask the agent to prepare a redacted evidence summary/);
});

test("run passport with verification and no violated rules returns review_ready", () => {
  const passport = buildRunPassport({
    run: {
      ...PASSPORT_RUN,
      rule_health: {
        evaluated: true,
        summary: { followed: 2 },
        items: [
          { id: "rule-1", title: "Run lint", status: "followed", evidence_count: 1 },
          { id: "rule-2", title: "Keep scope", status: "not_applicable", evidence_count: 0 },
        ],
      },
      behavior: {
        verificationPresent: true,
        testsPassed: true,
        lintPassed: true,
        buildPassed: true,
        failedCommands: 0,
        changedFiles: 2,
        humanApproval: true,
      },
    },
    activeRules: [{ id: "active-1", title: "Active rule", status: "active", deleted_at: null }],
  });

  assert.equal(passport.passport_status, "review_ready");
  assert.equal(passport.rules.active_rule_count, 1);
  assert.equal(passport.rules.health_counts.followed, 1);
  assert.equal(passport.rules.health_counts.not_applicable, 1);
  assert.deepEqual(passport.evidence.verification.tests, ["Tests passed"]);
  assert.deepEqual(passport.review.missing_requirements, []);
});

test("run passport with no verification returns missing_evidence", () => {
  const passport = buildRunPassport({
    run: {
      ...PASSPORT_RUN,
      rule_health: { evaluated: true, summary: { followed: 1 }, items: [{ title: "Rule", status: "followed" }] },
      behavior: { verificationPresent: false, failedCommands: 0, changedFiles: 1 },
    },
  });

  assert.equal(passport.passport_status, "missing_evidence");
  assert.match(passport.summary, /Verification signals are missing/);
  assert.ok(passport.review.missing_requirements.includes("Meaningful test, lint, build, or verification evidence is missing."));
});

test("run passport with a violated rule returns blocked_or_failed", () => {
  const passport = buildRunPassport({
    run: {
      ...PASSPORT_RUN,
      rule_health: { evaluated: true, items: [{ id: "rule-1", title: "No prod deletion", status: "violated" }] },
      behavior: { verificationPresent: true, testsPassed: true, failedCommands: 0 },
    },
  });

  assert.equal(passport.passport_status, "blocked_or_failed");
  assert.ok(passport.review.required_attention.some((item) => /violated/i.test(item)));
});

test("run passport treats failed commands and failed verification conservatively", () => {
  const clearlyFailed = buildRunPassport({
    run: {
      ...PASSPORT_RUN,
      rule_health: { evaluated: true, items: [{ title: "Rule", status: "followed" }] },
      behavior: { verificationPresent: true, testsPassed: false, failedCommands: 1 },
    },
  });
  const commandFailuresOnly = buildRunPassport({
    run: {
      ...PASSPORT_RUN,
      rule_health: { evaluated: true, items: [{ title: "Rule", status: "followed" }] },
      behavior: { verificationPresent: true, failedCommands: 2 },
    },
  });

  assert.equal(clearlyFailed.passport_status, "blocked_or_failed");
  assert.equal(commandFailuresOnly.passport_status, "needs_review");
  assert.deepEqual(commandFailuresOnly.evidence.verification.failed_commands, ["2 failed commands recorded"]);
});

test("run passport with needs_review or too_vague Rule Health returns needs_review", () => {
  const needsReview = buildRunPassport({
    run: {
      ...PASSPORT_RUN,
      rule_health: { evaluated: true, items: [{ title: "Scope rule", status: "too_vague" }] },
      behavior: { verificationPresent: true, lintPassed: true, failedCommands: 0 },
    },
  });

  assert.equal(needsReview.passport_status, "needs_review");
  assert.equal(needsReview.rules.health_counts.too_vague, 1);
  assert.ok(buildPassportReview(needsReview).required_attention.some((item) => /Rule Health needs review/i.test(item)));
});

test("run review decision helpers validate decisions and store only compact redacted note metadata", () => {
  assert.equal(isRunReviewDecision("reviewed"), true);
  assert.equal(isRunReviewDecision("needs_follow_up"), true);
  assert.equal(isRunReviewDecision("not_accepted"), true);
  assert.equal(isRunReviewDecision("approved"), false);
  assert.equal(containsActiveReviewNotePayload("<script>alert(1)</script>"), true);
  assert.equal(containsActiveReviewNotePayload("Please add a clearer test summary."), false);

  const payload = buildRunReviewEventPayload({
    decision: "needs_follow_up",
    note: "Please re-run tests. Bearer secret-token-123, token=oak_secret_token, password=hunter2, and C:\\Users\\kaina\\repo\\secret.ts should not persist.",
    createdAt: "2026-07-02T13:00:00.000Z",
  });

  assert.equal(payload.decision, "needs_follow_up");
  assert.equal(payload.note_present, true);
  assert.equal(payload.created_at, "2026-07-02T13:00:00.000Z");
  assert.ok(payload.note_preview);
  assert.ok(!payload.note_preview.includes("secret-token-123"));
  assert.ok(!payload.note_preview.includes("oak_secret_token"));
  assert.ok(!payload.note_preview.includes("hunter2"));
  assert.ok(!payload.note_preview.includes("C:\\Users\\kaina"));
  assert.ok(payload.note_preview.length <= 160);
  assert.throws(
    () => buildRunReviewEventPayload({ decision: "reviewed", note: "x".repeat(MAX_REVIEW_NOTE_LENGTH + 1) }),
    /Reviewer note is too large/,
  );
  assert.throws(
    () => buildRunReviewEventPayload({ decision: "reviewed", note: "<img src=x onerror=alert(1)>" }),
    /Active HTML or script content is not allowed/,
  );
});

test("run review decision event parser returns human_review without raw note preview", () => {
  const payload = buildRunReviewEventPayload({
    decision: "reviewed",
    note: "Looks ready for reviewer records.",
    createdAt: "2026-07-02T13:05:00.000Z",
  });
  const parsed = parseRunReviewEventMessage(JSON.stringify(payload), "2026-07-02T13:06:00.000Z");
  const latest = humanReviewFromEvents([
    { event_type: "status", message: "working", created_at: "2026-07-02T12:59:00.000Z" },
    { event_type: REVIEW_DECISION_EVENT_TYPE, message: JSON.stringify(payload), created_at: "2026-07-02T13:06:00.000Z" },
  ]);

  assert.deepEqual(parsed, {
    decision: "reviewed",
    reviewed_at: "2026-07-02T13:05:00.000Z",
    note_present: true,
  });
  assert.deepEqual(latest, parsed);
  assert.ok(!JSON.stringify(parsed).includes("Looks ready"));
});

test("run passport includes human_review decision and conservative review next steps", () => {
  const reviewed = buildRunPassport({
    run: {
      ...PASSPORT_RUN,
      rule_health: { evaluated: true, items: [{ title: "Rule", status: "followed" }] },
      behavior: { verificationPresent: true, testsPassed: true, failedCommands: 0 },
    },
    humanReview: { decision: "reviewed", reviewed_at: "2026-07-02T13:00:00.000Z", note_present: false },
  });
  const followUp = buildRunPassport({
    run: {
      ...PASSPORT_RUN,
      rule_health: { evaluated: true, items: [{ title: "Rule", status: "followed" }] },
      behavior: { verificationPresent: true, testsPassed: true, failedCommands: 0 },
    },
    humanReview: { decision: "needs_follow_up", reviewed_at: "2026-07-02T13:01:00.000Z", note_present: true },
  });
  const notAccepted = buildRunPassport({
    run: {
      ...PASSPORT_RUN,
      rule_health: { evaluated: true, items: [{ title: "Rule", status: "followed" }] },
      behavior: { verificationPresent: true, testsPassed: true, failedCommands: 0 },
    },
    humanReview: { decision: "not_accepted", reviewed_at: "2026-07-02T13:02:00.000Z", note_present: true },
  });

  assert.equal(reviewed.human_review.decision, "reviewed");
  assert.equal(reviewed.review.next_step, "Human review decision recorded.");
  assert.equal(followUp.human_review.note_present, true);
  assert.equal(followUp.review.next_step, "Address reviewer follow-up before relying on this run.");
  assert.ok(notAccepted.review.required_attention.some((item) => /not accepted/i.test(item)));
  assert.match(JSON.stringify(notAccepted), /not_accepted/);
});

test("run passport does not expose raw session content or private rule bodies", () => {
  const passport = buildRunPassport({
    run: {
      ...PASSPORT_RUN,
      rule_health: { evaluated: true, items: [{ title: "Rule", status: "followed" }] },
      behavior: { verificationPresent: true, testsPassed: true, failedCommands: 0 },
    },
    session: {
      id: "session-1",
      created_at: "2026-07-02T12:08:00.000Z",
      source_quality: "approved",
      human_approved_submission: true,
      summary: "content-free summary",
      raw_session_content: "SECRET_TOKEN_FROM_SESSION",
      rule_health: null,
      behavior: null,
    },
    activeRules: [
      { id: "rule-active", title: "Active title", body: "PRIVATE_RULE_BODY", status: "active", deleted_at: null },
    ],
  } as RunPassportInput);

  const serialized = JSON.stringify(passport);
  assert.ok(!serialized.includes("SECRET_TOKEN_FROM_SESSION"));
  assert.ok(!serialized.includes("PRIVATE_RULE_BODY"));
  assert.ok(!("body" in passport.rules.items[0]));
});

test("run passport surfaces smoke-template verification without raw evidence", () => {
  const smokeEvidence = `## Verification commands
- npm run lint: passed, 0 errors, 3 warnings
- npm test: passed, 568 passed, 0 failed
- npm run build: passed, with existing warning categories

## Failed commands
- None.
`;
  const extracted = extractQualitySignals(smokeEvidence);
  const quality = deriveQualitySignals(extracted);
  const passport = buildRunPassport({
    run: {
      ...PASSPORT_RUN,
      rule_health: { evaluated: true, items: [{ title: "Rule", status: "followed" }] },
      behavior: {
        verificationPresent: hasCommandTiedVerificationSignal(extracted),
        testsPassed: quality.testsPassed,
        lintPassed: quality.lintPassed,
        buildPassed: quality.buildPassed,
        failedCommands: extracted.failedCommandsExplicitNone ? 0 : extracted.failedCommandCount,
      },
    },
    session: {
      id: "session-smoke",
      human_approved_submission: true,
      summary: "content-free summary",
      raw_session_content: smokeEvidence,
    },
    activeRules: [{ id: "rule-active", title: "Active title", body: "PRIVATE_RULE_BODY", status: "active" }],
  } as RunPassportInput);

  assert.deepEqual(passport.evidence.verification.tests, ["Tests passed"]);
  assert.deepEqual(passport.evidence.verification.lint, ["Lint passed"]);
  assert.deepEqual(passport.evidence.verification.build, ["Build passed"]);
  assert.deepEqual(passport.evidence.verification.failed_commands, []);
  const serialized = JSON.stringify(passport);
  assert.ok(!serialized.includes("npm run lint"));
  assert.ok(!serialized.includes("PRIVATE_RULE_BODY"));
});

test("run passport active-rule count excludes draft retired and deleted rules", () => {
  const passport = buildRunPassport({
    run: { ...PASSPORT_RUN, behavior: { verificationPresent: true, testsPassed: true, failedCommands: 0 } },
    activeRules: [
      { id: "active", title: "Active", status: "active", deleted_at: null },
      { id: "draft", title: "Draft", status: "needs_review", deleted_at: null },
      { id: "retired", title: "Retired", status: "retired", deleted_at: null },
      { id: "deleted", title: "Deleted", status: "active", deleted_at: "2026-07-02T00:00:00.000Z" },
    ],
  });

  assert.equal(passport.rules.active_rule_count, 1);
});

test("run passport pure helpers summarize Rule Health and verification signals", () => {
  const health = summarizeRuleHealth({
    evaluated: true,
    items: [
      { title: "Follow", status: "followed", evidenceLevel: "specific" },
      { title: "Obsolete", status: "obsolete" },
    ],
  });
  const verificationWithoutReview = extractVerificationSummary({
    run: {
      ...PASSPORT_RUN,
      behavior: { testsPassed: true, lintPassed: false, buildPassed: true, failedCommands: 1, humanApproval: true },
    },
  });
  // Neither behavior.humanApproval nor session.human_approved_submission is
  // independent verification -- both are the agent's own self-report. Only a
  // real decision recorded through the cookie-authenticated /review endpoint
  // (input.humanReview) may mark human_review_present true.
  const verificationWithReview = extractVerificationSummary({
    run: PASSPORT_RUN,
    humanReview: { decision: "reviewed", reviewed_at: "2026-01-01T00:00:00Z", note_present: false },
  });

  assert.equal(health.evaluated_rule_count, 2);
  assert.equal(health.health_counts.followed, 1);
  assert.equal(health.health_counts.obsolete, 1);
  assert.deepEqual(verificationWithoutReview.lint, ["Lint failed"]);
  assert.equal(verificationWithoutReview.human_review_present, false);
  assert.equal(verificationWithReview.human_review_present, true);
});

test("run passport reads are cookie-scoped, read-only, and use active rules only", () => {
  const route = read("src/app/api/agent/runs/[id]/passport/route.ts");
  const loader = read(PASSPORT_LOADER);
  assert.match(route, /export async function GET/);
  assert.match(route, /loadRunPassportForUser\(id\)/);
  assert.match(loader, /getAgentRunForUser\(runId\)/);
  assert.match(loader, /buildRunPassport/);
  assert.match(loader, /humanReviewFromEvents/);
  assert.match(loader, /\.from\("agent_run_events"\)/);
  assert.match(loader, /\.eq\("event_type", REVIEW_DECISION_EVENT_TYPE\)/);
  assert.match(loader, /\.from\("workspace_rules"\)/);
  assert.match(loader, /\.select\("id, title, status, deleted_at"\)/);
  assert.match(loader, /\.eq\("status", "active"\)/);
  assert.match(loader, /\.is\("deleted_at", null\)/);
  assert.ok(!/authenticateAgent/.test(route + loader), "dashboard passport read must use signed-in human auth");
  assert.ok(!/\.insert\(|\.update\(|\.delete\(|\.upsert\(|promoteWorkspaceRule|updateWorkspaceRuleStatus/.test(route + loader));
});

test("public homepage does not claim an unimplemented tamper-evident or admissible record", () => {
  const home = read(HOME_PAGE).toLowerCase();
  for (const phrase of ["tamper-evident", "admissible", "sealed content is hashed", "run is bound by"]) {
    assert.ok(!home.includes(phrase), `homepage must not contain unsupported claim: "${phrase}"`);
  }
});

// The homepage markup is being redesigned, so these tests pin what must stay true regardless of layout: it is a single
// server page that renders the current home component, never the retired card strip, and never opens a socket to a
// visitor's own machine just to render.
test("public homepage renders one home component and none of the retired card-strip pieces", () => {
  const page = read("src/app/page.tsx");
  assert.match(page, /export default/);
  assert.match(page, /from "@\/components\/home\//, "the page composes a component from components/home");
  assert.doesNotMatch(page, /ProofStrip/);
  assert.doesNotMatch(page, /V2ProductReveal/);
  assert.doesNotMatch(page, /const CTA_PRIMARY = \{ href: "\/analyze", label: "Seal a session"/);
});

test("public homepage is never a live runtime socket", () => {
  const hero = read("src/app/page.tsx");
  // The page must not route through WatchfloorOps (which mounts the real bridge-connected terminal several layers
  // down): a public marketing page has no business opening a WebSocket to a visitor's own loopback runtime.
  assert.doesNotMatch(hero, /WatchfloorOps|LocalAgentTerminal|new WebSocket/);
});

test("top nav drops the vaporware Future Expansions dropdown; those concepts live on the honest roadmap ledger", () => {
  const nav = read("src/components/Nav.tsx");
  assert.doesNotMatch(nav, /Future Expansions/);
  assert.doesNotMatch(nav, /EXPANSIONS/);
  const roadmap = read("src/app/roadmap/page.tsx");
  for (const name of ["OathExchange", "OathLedger", "OathGuard"]) {
    assert.match(roadmap, new RegExp(name));
  }
});

test("top nav items share one row, baseline, and padding/radius scale — the Agents chip is not a mismatched pill", () => {
  const css = read("src/app/globals.css");
  assert.match(css, /\.lp-nav\s*\{[\s\S]*?align-items:\s*center/);
  // Plain links, the flagship chip, and the CTA button all use the same
  // height/radius so they align on one baseline instead of three shapes.
  assert.match(css, /\.lp-nav a\s*\{[\s\S]*?height:\s*34px/);
  assert.match(css, /\.lp-btn-sm\s*\{[\s\S]*?height:\s*34px/);
  // Scoped as ".lp-nav a.lp-nav-chip" (not bare ".lp-nav-chip") — matching
  // ".lp-nav a"'s specificity so the border-color override actually wins the
  // cascade instead of silently losing to the sibling rule.
  assert.match(css, /\.lp-nav a\.lp-nav-chip\s*\{/);
  const chipStart = css.indexOf(".lp-nav a.lp-nav-chip {");
  const chipBlock = css.slice(chipStart, chipStart + 200);
  assert.doesNotMatch(chipBlock, /text-transform:\s*uppercase/);
  assert.doesNotMatch(chipBlock, /font-family:\s*var\(--font-geist-mono\)/);
});

test("The Wire panel is removed from the Watchfloor dashboard, freeing the terminal's vertical room", () => {
  const page = read("src/app/dashboard/agents/page.tsx");
  assert.doesNotMatch(page, /WirePanel/);
  assert.doesNotMatch(page, /The Wire/);
  assert.doesNotMatch(page, /listWireForUser/);
});

test("the dashboard keeps the chat surface free of a fake terminal promise", () => {
  const workspace = read(WORKSPACE);
  assert.match(workspace, /ConversationPanel/);
  assert.doesNotMatch(workspace, /LocalAgentTerminal|new WebSocket/);
});

test("review decision route is dashboard-authenticated, owner-scoped, and stores compact event metadata only", () => {
  const route = read("src/app/api/agent/runs/[id]/review/route.ts");
  const service = read("src/lib/agent-run-service.ts");
  assert.match(route, /export async function POST/);
  assert.match(route, /createClient\(\)/);
  assert.match(route, /auth\.getUser\(\)/);
  assert.match(route, /Sign in to review this run\./);
  assert.match(route, /getAgentRunForUser\(id\)/);
  assert.match(route, /Run not found\./);
  assert.match(route, /Review decision is required\./);
  assert.match(route, /Reviewer note is too large\./);
  assert.match(route, /Active HTML or script content is not allowed\./);
  assert.match(route, /recordRunReviewDecision\(run\.id/);
  assert.match(service, /event_type: REVIEW_DECISION_EVENT_TYPE/);
  assert.match(service, /message: JSON\.stringify\(payload\)/);
  assert.match(service, /\.from\("agent_run_events"\)\.insert/);
  assert.ok(!/console\.(log|warn|error|info|debug)\([^)]*note/i.test(route + service), "note content must not be logged");
  assert.ok(!/workspace_rules|promoteWorkspaceRule|updateWorkspaceRuleStatus/.test(route), "review route must not mutate rules");
  assert.ok(!/agent_sessions"\)\.update|session_text/.test(route), "review route must not alter or expose submitted evidence");
});

test("dashboard submit evidence form appears for a run without evidence", () => {
  const workspace = read(WORKSPACE);
  assert.match(workspace, /agent prepares evidence\. You approve it\./);
  assert.match(workspace, /Evidence is a review aid; do not paste secrets, private keys, customer data, or raw \.env values\./);
  assert.match(workspace, /I approve this agent evidence for M9R to record\./);
  assert.match(workspace, /Record approved evidence/);
  assert.match(workspace, /!run\.latest_session_id/);
});

test("submit button stays disabled until evidence exists and approval checkbox is checked", () => {
  const workspace = read(WORKSPACE);
  assert.match(workspace, /const submitDisabled = !evidenceText\.trim\(\) \|\| !evidenceApproved \|\| submitBusy;/);
});

test("workspace rule PATCH still cannot directly activate rules", () => {
  const route = read("src/app/api/workspace-rules/[id]/route.ts");
  const svc = read("src/lib/workspace-rules-service.ts");
  assert.match(route, /body\.status === "active"/);
  assert.match(route, /Use the promote route to activate a rule\./);
  assert.match(svc, /if \(status === "active"\)/);
  assert.match(svc, /PROMOTE_REQUIRED/);
});

test("promotion remains the only explicit route path that activates rules", () => {
  const promoteRoute = read("src/app/api/agent/rules/promote/route.ts");
  const workspaceRoute = read("src/app/api/workspace-rules/[id]/route.ts");
  const preflightRoute = read("src/app/api/agent/preflight/route.ts");
  assert.match(promoteRoute, /promoteWorkspaceRuleForAgentConnection\(ruleId, targetConnectionId\)/);
  assert.match(promoteRoute, /promoteWorkspaceRule\(ruleId\)/);
  assert.ok(!/update\(\{ status: "active"|updateWorkspaceRuleStatus\([^)]*"active"/.test(workspaceRoute));
  assert.ok(!/status:\s*"active"|update\(\{ status: "active"/.test(preflightRoute));
});

test("Run B readiness has blocked, ready, and mismatch states with the required copy", () => {
  const data = read(DATA);
  assert.match(data, /Run B blocked/);
  assert.match(data, /No active rules are available\. Record approved agent evidence or promote a trusted candidate first\./);
  // Blocked-with-candidates copy names the candidate count and the agent.
  assert.match(data, /rule candidate\$\{rulesForReviewCount === 1 \? "" : "s"\} need review\. Promote one for \$\{label\} before starting Run B\./);
  assert.match(data, /Ready for Run B/);
  assert.match(data, /This agent should load active rules with npx m9r-cli rules\./);
  assert.match(data, /Rules mismatch/);
});

// ---------------------------------------------------------------------------
// Legacy / synthetic safety
// ---------------------------------------------------------------------------

test("unlinked session and synthetic labels stay out of the normal dashboard UI", () => {
  const workspace = read(WORKSPACE);
  assert.ok(!/Advanced \/ legacy data|legacy \/ unlinked|Show synthetic example|not real data/.test(workspace));
  assert.ok(!/legacyRecommendations\.map|legacySessions\.map|unassignedCandidates/.test(workspace));
});

test("the selected agent's main view is built from run-linked data only", () => {
  const page = read(PAGE);
  // Agents are built from run-linked sessions; unlinked history never reaches the floor.
  assert.match(page, /partitionSessionsByLink\(sessions, sessionLinks\)/);
  assert.match(page, /sessions: wsLinkedSessions/);
  assert.ok(!/wsLegacySessions/.test(page), "unlinked sessions must not reach the Watchfloor");
});

test("legacy recommendations are separated from current run-linked recommendations", () => {
  const page = read(PAGE);
  assert.match(page, /partitionRecommendationsByLink\(/);
  assert.match(page, /unassignedCandidates: legacyRules/);
  // Provenance link is stored on submit (source session id) so this split is real.
  assert.match(read("src/lib/agent-join-service.ts"), /source_report_id: sourceSessionId/);
});

test("synthetic two-run proof is omitted from the normal dashboard", () => {
  const workspace = read(WORKSPACE);
  assert.ok(!/demoProof|Show synthetic example|not real data/.test(workspace));
});

// ---------------------------------------------------------------------------
// Approval model — reviewable legacy drafts can enter the decision queue
// ---------------------------------------------------------------------------

test("the page sends reviewable legacy drafts to Approval Center without treating them as run evidence", () => {
  const page = read(PAGE);
  const approvalCenter = read(APPROVAL_CENTER);
  assert.match(page, /unassignedCandidates: legacyRules/);
  assert.match(page, /approvalRules=\{\[\.\.\.reviewRules, \.\.\.legacyRules\]\}/);
  assert.match(approvalCenter, /\[\.\.\.agent\.reviewRules, \.\.\.agent\.unassignedCandidates\]/);
  assert.ok(!/unassignedCandidates/.test(read(WORKSPACE)));
});

test("the Watchfloor never exposes unassigned or legacy rule candidates", () => {
  // The active-rules strip this used to also assert is gone (see the rule
  // lifecycle test above); what still matters is that no legacy/unlinked
  // candidate rules leak onto the Watchfloor.
  const workspace = read(WORKSPACE);
  assert.ok(!/Unassigned candidates|legacy \/ unlinked/.test(workspace));
});

test("unlinked sessions remain non-actionable while legacy rule drafts use only Approval Center actions", () => {
  const workspace = read(WORKSPACE);
  const page = read(PAGE);
  assert.match(page, /approvalRules=\{\[\.\.\.reviewRules, \.\.\.legacyRules\]\}/);
  assert.ok(!/legacySessions|legacyRecommendations|legacy \/ unlinked/.test(workspace));
});

test("promote request includes target_connection_id and disconnected agents get no promote action", () => {
  const button = read("src/components/product/PromoteRuleButton.tsx");
  assert.match(button, /target_connection_id: targetConnectionId/);
  const workspace = read(WORKSPACE);
  // The drawer only renders the promote button when a target connection exists.
  assert.match(workspace, /agent\?\.connectionId \?/);
  assert.match(workspace, /Connect this agent to promote/);
});

test("the promote route adopts into the selected agent's workspace when targeted", () => {
  const route = read("src/app/api/agent/rules/promote/route.ts");
  assert.match(route, /target_connection_id/);
  assert.match(route, /promoteWorkspaceRuleForAgentConnection\(ruleId, targetConnectionId\)/);
});

test("active rules shown are only the selected agent's fetchable workspace rules", () => {
  // Was asserted against a client-side filter in AgentWorkspaceClient that fed
  // the removed Active-rules chip. The scoping lives at the data layer now.
  const data = read("src/lib/agent-workspace-data.ts");
  assert.match(data, /rule\.workspaceId === conn\.workspace_id && rule\.status === "active"/);
});

test("no legacy/unlinked item is labeled as current run-linked evidence", () => {
  const workspace = read(WORKSPACE);
  assert.ok(!/legacy \/ unlinked|unassignedCandidates/.test(workspace));
  // The run-linked evidence list keys its run badge off a real runId.
  assert.match(workspace, /s\.runId && <StatusLozenge[^>]*>run \{short\(s\.runId\)\}/);
});

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

test("dashboard nav includes The Watchfloor and an active-state indicator", () => {
  const shell = read(SHELL);
  assert.match(shell, /\["\/dashboard\/agents", "Chat", "agent", "chat"\]/);
  for (const label of ["Memory", "Settings"]) {
    assert.match(shell, new RegExp(`"${label}"`));
  }
  // Callsigns, Approvals, and Workspaces were removed from the sidebar by
  // product direction. Their pages and deep links still exist (the CLI links
  // straight into /dashboard/approvals/<id>); they just are not nav items.
  for (const gone of ["Callsigns", "Approvals", "Workspaces"]) {
    assert.ok(!new RegExp(`"${gone}"`).test(shell), `${gone} must not return to the sidebar`);
  }
  assert.ok(!/\["\/dashboard\/traces", "Evidence"/.test(shell), "Evidence must not remain a primary navigation item");
  assert.match(shell, /aria-current=\{active \? "page" : undefined\}/);
});

test("Settings uses a gear icon and an accessible Settings label", () => {
  const shell = read(SHELL);
  assert.match(shell, /href="\/dashboard\/settings"/);
  assert.match(shell, /aria-label="Settings"/);
  assert.match(shell, /name="settings"/);
});

test("dashboard agent copy contains no overclaiming language", () => {
  const text = (read(PAGE) + read(WORKSPACE) + read(DATA)).toLowerCase();
  for (const phrase of FORBIDDEN_PROOF_PHRASES) {
    assert.ok(!text.includes(phrase), `dashboard must not contain overclaim: "${phrase}"`);
  }
});

// ---------------------------------------------------------------------------
// Run API auth model
// ---------------------------------------------------------------------------

test("run start keeps the Bearer-token CLI path and adds a cookie-scoped dashboard path", () => {
  const route = read("src/app/api/agent/run/start/route.ts");
  assert.match(route, /const token = bearerFrom\(req\.headers\.get\("authorization"\)\)/);
  assert.match(route, /authenticateAgent\(token\)/);
  assert.match(route, /Invalid or missing agent token/);
  assert.match(route, /session:submit/);
  assert.match(route, /dashboardRunStart/);
  assert.match(route, /createClient\(\)/);
  assert.match(route, /\.from\("agent_connections"\)/);
  assert.match(route, /\.eq\("id", connectionId\)/);
  assert.match(route, /\.eq\("status", "active"\)/);
  assert.match(route, /startAgentRun\(\{\s*connectionId:/);
});

test("disconnect route revokes a coding agent server-side without deleting audit history", () => {
  const route = read(DISCONNECT_ROUTE);
  const svc = read(JOIN_SERVICE);
  assert.match(route, /POST\(_req: Request, \{ params \}: \{ params: Promise<\{ id: string \}> \}\)/);
  assert.match(route, /disconnectAgentConnection\(id\)/);
  assert.match(svc, /export async function disconnectAgentConnection/);
  assert.match(svc, /createClient\(\)/, "human dashboard path must authenticate through the cookie client");
  assert.match(svc, /auth\.getUser\(\)/);
  assert.match(svc, /\.from\("agent_connections"\)[\s\S]*\.select\("id, workspace_id, status"\)[\s\S]*\.eq\("id", connectionId\)/);
  assert.match(svc, /\.from\("agent_connections"\)[\s\S]*\.update\(\{ status: "revoked", revoked_at: now \}\)[\s\S]*\.eq\("id", connectionId\)/);
  assert.match(svc, /\.from\("agent_tokens"\)[\s\S]*\.update\(\{ revoked_at: now \}\)[\s\S]*\.eq\("connection_id", connectionId\)/);
  assert.ok(!/from\("agent_runs"\)[\s\S]*\.delete\(/.test(svc), "disconnect must preserve historical runs");
  assert.ok(!/from\("agent_sessions"\)[\s\S]*\.delete\(/.test(svc), "disconnect must preserve submitted evidence metadata");
  assert.ok(!/from\("agent_run_events"\)[\s\S]*\.delete\(/.test(svc), "disconnect must preserve run events and review records");
});

test("revoked connections and tokens cannot use existing Bearer token paths", () => {
  const svc = read(JOIN_SERVICE);
  assert.match(svc, /\.select\("id, connection_id, workspace_id, scopes, expires_at, revoked_at"\)/);
  assert.match(svc, /if \(data\.revoked_at\) return null/);
  assert.match(svc, /\.from\("agent_connections"\)[\s\S]*\.select\("status, agent_kind, repo_hint"\)[\s\S]*\.eq\("id", data\.connection_id\)/);
  assert.match(svc, /if \(!conn \|\| conn\.status !== "active"\) return null/);
  for (const routePath of [
    "src/app/api/agent/rules/route.ts",
    "src/app/api/agent/run/start/route.ts",
    "src/app/api/agent/run/status/route.ts",
    "src/app/api/agent/session/route.ts",
  ]) {
    assert.match(read(routePath), /authenticateAgent/, `${routePath} must use server-side token authentication`);
  }
});

test("CLI disconnect route revokes the current bearer-token connection without deleting history", () => {
  const route = read(CLI_DISCONNECT_ROUTE);
  const svc = read(JOIN_SERVICE);
  assert.match(route, /bearerFrom\(req\.headers\.get\("authorization"\)\)/);
  assert.match(route, /authenticateAgent\(token\)/);
  assert.match(route, /Invalid or missing agent token/);
  assert.match(route, /disconnectAuthenticatedAgent\(agent\)/);
  assert.match(svc, /export async function disconnectAuthenticatedAgent\(agent: AuthedAgent\)/);
  assert.match(svc, /revokeAgentConnection\(connectionId/);
  assert.ok(!/from\("agent_runs"\)[\s\S]*\.delete\(/.test(route + svc), "CLI disconnect must preserve historical runs");
  assert.ok(!/from\("agent_sessions"\)[\s\S]*\.delete\(/.test(route + svc), "CLI disconnect must preserve submitted evidence metadata");
  assert.ok(!/from\("agent_run_events"\)[\s\S]*\.delete\(/.test(route + svc), "CLI disconnect must preserve run events and review records");
});

test("disconnect / revoke stays available and leaks no private fields", () => {
  // The Disconnect / revoke button was removed from the Watchfloor control
  // strip by product direction, along with Share resume and Run Detail. The
  // capability itself is unchanged: the route still exists and the CLI still
  // drives it (see oathlock-cli-core). Revoking from the web UI is currently
  // NOT possible -- that is a deliberate removal, not an oversight, but it
  // does mean revoke is CLI-only today.
  const workspace = read(WORKSPACE);
  const page = read(PAGE);
  const route = read(DISCONNECT_ROUTE);
  assert.ok(!/Disconnect \/ revoke/.test(workspace), "Watchfloor must not re-add the disconnect button");
  assert.match(route, /disconnect/i, "the disconnect route must still exist");
  assert.match(page, /\.eq\("status", "active"\)/, "revoked connections must not appear as connected agents");
  assert.ok(!/token_hash|one_time_token|setup_code|claim_url|Bearer/.test(workspace + route), "disconnect UI/route must not expose token or claim fields");
});

test("key dashboard rule actions do not use native browser confirmations", () => {
  const sources = [read(WORKSPACE), read(MEMORY_VIEW), read(RULES_MANAGER)].join("\n");
  assert.ok(!/window\.confirm\(|\bconfirm\(/.test(sources), "key dashboard product actions must use ProductConfirmDialog");
  assert.match(sources, /ProductConfirmDialog/);
});

test("dashboard run start reruns preflight server-side and rejects blocked tasks", () => {
  const route = read("src/app/api/agent/run/start/route.ts");
  assert.match(route, /buildPreflightDecision/);
  assert.match(route, /listActiveRulesForDashboardStart/);
  assert.match(route, /decision\.status === "blocked"/);
  assert.match(route, /Blocked by policy\./);
  const blockedIdx = route.indexOf('decision.status === "blocked"');
  const startIdx = route.indexOf("startAgentRun({", blockedIdx);
  assert.ok(blockedIdx > -1 && startIdx > blockedIdx, "blocked preflight must be checked before run creation");
});

test("dashboard run start rejects needs_approval without explicit approval", () => {
  const route = read("src/app/api/agent/run/start/route.ts");
  assert.match(route, /decision\.status === "needs_approval" && approvedByHuman !== true/);
  assert.match(route, /Human approval is required before starting this run\./);
  assert.match(route, /approved_by_human/);
});

test("dashboard run start returns compact preflight metadata without storing raw task, path hints, or rule bodies", () => {
  const route = read("src/app/api/agent/run/start/route.ts");
  const service = read("src/lib/agent-run-service.ts");
  assert.match(route, /PREFLIGHT_PERSISTENCE_SUPPORTED = false/);
  assert.match(route, /preflight_persistence: PREFLIGHT_PERSISTENCE_SUPPORTED \? "stored" : "skipped_no_safe_field"/);
  assert.match(route, /compactPreflightSnapshot/);
  assert.match(route, /matched_rule_count: decision\.matched_rules\.length/);
  assert.ok(!/approval_note: approvalNote/.test(route), "start route must not echo approval note body");
  assert.ok(!/path_hints: pathHints/.test(route), "start route must not echo raw path hints in metadata");
  const compactBlock = route.slice(route.indexOf("function compactPreflightSnapshot"), route.indexOf("async function listActiveRulesForDashboardStart"));
  const persistenceIdx = route.indexOf("preflight_persistence:");
  const responseBlock = route.slice(Math.max(0, persistenceIdx - 400), persistenceIdx + 200);
  assert.ok(!/rule_bodies|rawRuleBodies|rule\.body|body: rule/.test(compactBlock + responseBlock), "start route must not return rule bodies");
  assert.ok(!/preflight[\s\S]*(agent_runs"\)\.update|agent_run_events"\)\.insert)/.test(route), "preflight snapshot must not be persisted without a safe field");
  assert.ok(!/preflight[\s\S]*(agent_runs"\)\.update|agent_run_events"\)\.insert)/.test(service), "agent run service must not persist preflight metadata without a safe field");
});

test("dashboard evidence submission requires authenticated user and rejects wrong-user or wrong-connection runs", () => {
  const route = read("src/app/api/agent/session/route.ts");
  assert.match(route, /Sign in to submit evidence\./);
  assert.match(route, /run_id is required\./);
  assert.match(route, /human_approved_submission must be true\./);
  assert.match(route, /Provide session_text or session_summary\./);
  assert.match(route, /Session is too large\./);
  assert.match(route, /Prohibited content detected\./);
  assert.match(route, /Run not found\./);
  assert.match(route, /Run does not belong to that connection\./);
  assert.match(route, /connection_id/);
  assert.match(route, /listActiveRulesForWorkspace/);
});

test("successful dashboard evidence submission links evidence to run and refreshes the passport view", () => {
  const route = read("src/app/api/agent/session/route.ts");
  const workspace = read(WORKSPACE);
  assert.match(route, /linkSessionToRun\(agent, run\.id, submission\.sessionId/);
  assert.match(route, /run_linked:/);
  assert.match(route, /snapshots_persisted:/);
  assert.match(workspace, /router\.refresh\(\);/);
  assert.match(workspace, /Approved agent evidence recorded\. Run Passport is ready for review\./);
});

test("run status requires a Bearer token and a run_id", () => {
  const route = read("src/app/api/agent/run/status/route.ts");
  assert.match(route, /authenticateAgent/);
  assert.match(route, /run_id is required/);
});

test("GET /api/agent/runs is cookie-scoped to the signed-in user (not token)", () => {
  const route = read("src/app/api/agent/runs/route.ts");
  assert.match(route, /listAgentRunsForUser/);
  assert.ok(!/authenticateAgent/.test(route));
});

// ---------------------------------------------------------------------------
// Run service: scoping, last_seen_at, redaction
// ---------------------------------------------------------------------------

test("a token can only update a run started by its own connection", () => {
  const svc = read("src/lib/agent-run-service.ts");
  assert.match(svc, /connection_id !== agent\.connectionId/);
  assert.match(svc, /belongs to another connection/);
});

test("compare allows same-connection and same-workspace different-connection runs", () => {
  const svc = read("src/lib/agent-run-service.ts");
  assert.match(svc, /const sameConnection = runA\.connection_id === agent\.connectionId && runB\.connection_id === agent\.connectionId/);
  assert.match(svc, /const sameWorkspace = runA\.workspace_id === agent\.workspaceId && runB\.workspace_id === agent\.workspaceId/);
  assert.match(read("src/lib/agent-runs-read.ts"), /id, connection_id, workspace_id, agent_kind/);
});

test("compare allows different workspaces only with same-owner approved rule lineage", () => {
  const svc = read("src/lib/agent-run-service.ts");
  assert.match(svc, /sameOwnerWorkspaces\(runA\.workspace_id, runB\.workspace_id\)/);
  assert.match(svc, /hasRuleLineageFromBaselineToLater/);
  assert.match(svc, /\.from\("workspace_rules"\)[\s\S]*\.eq\("workspace_id", runB\.workspace_id\)[\s\S]*\.eq\("source_report_id", sourceSessionId\)[\s\S]*\.eq\("status", "active"\)/);
  assert.match(svc, /runB\.rule_health\?\.evaluated/);
});

test("compare denies unrelated cross-workspace runs without another-connection copy", () => {
  const svc = read("src/lib/agent-run-service.ts");
  assert.match(svc, /These runs are not in the same workspace or approved rule lineage\./);
  const compareFn = svc.slice(svc.indexOf("export async function compareAgentRuns"));
  assert.ok(!/another connection/.test(compareFn), "compare denial should explain workspace/lineage, not connection");
});

test("compare hydrates later-run Rule Health and behavior from the linked session when needed", () => {
  const svc = read("src/lib/agent-run-service.ts");
  assert.match(svc, /hydrateRunSnapshot/);
  assert.match(svc, /loadSessionSnapshot/);
  assert.match(svc, /\.from\("agent_sessions"\)[\s\S]*\.select\("rule_health, behavior"\)/);
  // Snapshot-availability is derived from the hydrated rows and threaded into the
  // conservative comparison so the verdict/limitations never disagree.
  assert.match(svc, /const ruleHealthSnapshotUnavailable =/);
  assert.match(svc, /const behaviorSnapshotUnavailable =/);
  assert.match(svc, /laterRulesLoadedCount: runB\.rules_loaded_count/);
});

test("updateAgentRunStatus bumps last_seen_at and sets the phase", () => {
  const svc = read("src/lib/agent-run-service.ts");
  assert.match(svc, /last_seen_at: now/);
  assert.match(svc, /current_phase: phase/);
});

test("run events are stored only through the redactor", () => {
  const svc = read("src/lib/agent-run-service.ts");
  assert.match(svc, /agent_run_events/);
  assert.match(svc, /message: message \? redactRunEvent\(message\) : null/);
});

// ---------------------------------------------------------------------------
// Owner-scoped reads via RLS
// ---------------------------------------------------------------------------

test("agent_runs RLS scopes reads to workspaces the user owns", () => {
  const sql = read("supabase-agent-runs.sql");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS agent_runs/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS agent_run_events/);
  assert.match(sql, /ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /Users read own agent runs/);
  assert.match(sql, /owner_id = auth\.uid\(\)/);
});

test("agent_runs migration stores no secret columns", () => {
  const sql = read("supabase-agent-runs.sql")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .replace(/'[^']*'/g, "''")
    .toLowerCase();
  for (const banned of ["token", "setup_code", "claim_url", "local.json", "session_text", "source_code"]) {
    assert.ok(!sql.includes(banned), `migration must not define a "${banned}" column`);
  }
});

// ---------------------------------------------------------------------------
// Promotion: recommended (needs_review) → active, and provenance
// ---------------------------------------------------------------------------

test("agent-session recommendations are stored as needs_review, never auto-active", () => {
  const svc = read("src/lib/agent-join-service.ts");
  assert.match(svc, /status:\s*"needs_review"/);
  assert.match(svc, /source_session_name/);
  assert.match(svc, /source_finding_id/);
  assert.match(svc, /evidence_summary/);
});

test("promote route promotes a recommended rule to active (human action only)", () => {
  const route = read("src/app/api/agent/rules/promote/route.ts");
  assert.match(route, /target_connection_id/);
  assert.match(route, /promoteWorkspaceRuleForAgentConnection\(ruleId, targetConnectionId\)/);
  assert.match(route, /promoteWorkspaceRule\(ruleId\)/);
  assert.match(route, /rule_id is required/);
});

test("the agent rules response returns only active rules — so a promoted rule appears", () => {
  const route = read("src/app/api/agent/rules/route.ts");
  const svc = read("src/lib/agent-join-service.ts");
  assert.match(route, /listActiveRulesForAgent\(agent\)/);
  assert.match(svc, /\.from\("workspace_rules"\)/);
  assert.match(svc, /\.eq\("status", "active"\)/);
  assert.match(route, /mode: "active"/);
});

test("agent rules baseline is used only when no active workspace rules are returned", () => {
  const route = read("src/app/api/agent/rules/route.ts");
  assert.match(route, /const rules = await listActiveRulesForAgent\(agent\)/);
  assert.match(route, /if \(rules\.length === 0\) \{\s*return NextResponse\.json\(baselineRulesResponse\(\)\);/);
  assert.match(route, /message: "Evidence-backed workspace rules are active for this workspace\."/);
});

test("agent rules endpoint stays strict to the token workspace and does not silently repair", () => {
  const svc = read("src/lib/agent-join-service.ts");
  assert.match(svc, /eq\("workspace_id", workspaceId\)/);
  assert.match(svc, /return listActiveRulesForWorkspace\(agent\.workspaceId\)/);
  assert.ok(!/repairAgentWorkspaceToOnlyActiveRulesWorkspace/.test(svc));
  assert.ok(!/agent_connections"\)\.update\(\{ workspace_id/.test(svc));
  assert.ok(!/agent_tokens"\)\.update\(\{ workspace_id/.test(svc));
});

test("explicit promotion resolves the selected agent connection workspace", () => {
  const svc = read("src/lib/workspace-rules-service.ts");
  assert.match(svc, /promoteWorkspaceRuleForAgentConnection/);
  assert.match(svc, /\.from\("agent_connections"\)[\s\S]*\.select\("id, workspace_id, agent_kind, status"\)[\s\S]*\.eq\("id", targetConnectionId\.trim\(\)\)/);
  assert.match(svc, /Target agent workspace was not found/);
  assert.match(svc, /targetWorkspaceId/);
});

test("same-workspace promotion updates the reviewed row to active", () => {
  const svc = read("src/lib/workspace-rules-service.ts");
  assert.match(svc, /if \(sourceRule\.workspace_id === targetWorkspaceId\)/);
  assert.match(svc, /\.update\(\{ status: "active", promoted_at: now, retired_at: null, updated_at: now \}\)/);
  assert.match(svc, /\.eq\("id", ruleId\)/);
});

test("same-owner reviewed rule can be adopted into the selected agent workspace explicitly", () => {
  const svc = read("src/lib/workspace-rules-service.ts");
  assert.match(svc, /\.insert\(\{\s*workspace_id: targetWorkspaceId/);
  assert.match(svc, /source_report_id: sourceRule\.source_report_id/);
  assert.match(svc, /status: "active"/);
  assert.match(svc, /Adopted from reviewed rule/);
});

test("explicit promotion blocks cross-owner adoption through authenticated RLS lookups", () => {
  const svc = read("src/lib/workspace-rules-service.ts");
  assert.match(svc, /requireUser\(\)/);
  assert.match(svc, /Target agent workspace was not found/);
  assert.match(svc, /Rule not found/);
  assert.ok(!/service_role|admin client|bypass/i.test(svc));
});

test("promoted rule remains workspace_rules data, not a parallel recommendation system", () => {
  const submit = read("src/app/api/agent/session/route.ts");
  const join = read("src/lib/agent-join-service.ts");
  const promote = read("src/app/api/agent/rules/promote/route.ts");
  assert.match(submit, /recordRecommendedRulesForAgent/);
  assert.match(join, /status:\s*"needs_review"/);
  assert.match(join, /source_report_id: sourceSessionId/);
  assert.match(promote, /promoteWorkspaceRuleForAgentConnection/);
  assert.match(promote, /promoteWorkspaceRule\(ruleId\)/);
  assert.match(read("src/lib/workspace-rules-service.ts"), /\.from\("workspace_rules"\)[\s\S]*\.update\(patch\)[\s\S]*\.eq\("id", ruleId\)/);
});

test("submit-session persists the later-run Rule Health and behavior snapshots on agent_sessions and agent_runs", () => {
  const route = read("src/app/api/agent/session/route.ts");
  const join = read("src/lib/agent-join-service.ts");
  assert.match(route, /ruleHealth: responseBody\.rule_health/);
  assert.match(route, /behavior: \{/);
  assert.match(join, /rule_health: meta\.ruleHealth \?\? null/);
  assert.match(join, /behavior: meta\.behavior \?\? null/);
  assert.match(join, /agent_sessions snapshot columns missing; retrying session insert without compare snapshots\./);
  assert.match(read("src/lib/agent-run-service.ts"), /const corePatch: Record<string, unknown> = \{/);
  assert.match(read("src/lib/agent-run-service.ts"), /const snapshotPatch: Record<string, unknown> = \{\}/);
  assert.match(read("src/lib/agent-run-service.ts"), /snapshot update failed/);
});

test("agent rules response shape exposes exact promoted rule title without secrets", () => {
  const svc = read("src/lib/agent-join-service.ts");
  const route = read("src/app/api/agent/rules/route.ts");
  assert.match(svc, /title: r\.title as string/);
  assert.match(svc, /body: r\.body as string/);
  assert.match(svc, /evidence_summary/);
  assert.match(route, /rules,/);
  assert.ok(!/setup_code|claim_url|one_time_token|token_hash/.test(route));
});

test("promote button calls the existing API route and shows a clear failure", () => {
  const button = read("src/components/product/PromoteRuleButton.tsx");
  assert.match(button, /fetch\("\/api\/agent\/rules\/promote"/);
  assert.match(button, /rule_id: ruleId/);
  assert.match(button, /target_connection_id: targetConnectionId/);
  assert.match(button, /role="alert"/);
  assert.match(button, /Could not promote this rule/);
  assert.match(button, /Promote for \$\{agentLabel\}/);
});

test("dashboard Codex active rules are scoped to the selected connection workspace", () => {
  const page = read("src/app/dashboard/agents/page.tsx");
  const data = read("src/lib/agent-workspace-data.ts");
  assert.match(page, /select\("id, workspace_id, agent_kind, repo_hint, status, created_at, last_seen_at, model, available_models, last_provider_session_ref, created_by"\)/);
  assert.match(page, /listWorkspaceRules\(workspaceId\)/);
  // The workspace scoping used to be asserted against a `visibleActiveRules`
  // filter in AgentWorkspaceClient, which existed only to feed the "Active
  // rules: N" chip on the control strip. That chip was removed (Rules has its
  // own sidebar destination), so the client no longer receives activeRules at
  // all. The scoping itself is unchanged and lives at the data layer, which
  // is where it actually belongs -- assert it there instead.
  assert.match(data, /rule\.workspaceId === conn\.workspace_id && rule\.status === "active"/);
});

test("selected agent promotion sends the selected connection id and label", () => {
  const workspace = read("src/components/product/AgentWorkspaceClient.tsx");
  assert.match(workspace, /targetConnectionId=\{agent\.connectionId\}/);
  assert.match(workspace, /agentLabel=\{agent\.label\}/);
});

// ---------------------------------------------------------------------------
// Session route wires recommendations + run link + rule health
// ---------------------------------------------------------------------------

test("session submit records recommendations, links the run, and stores Rule Health", () => {
  const route = read("src/app/api/agent/session/route.ts");
  assert.match(route, /recordRecommendedRulesForAgent/);
  assert.match(route, /linkSessionToRun/);
  assert.match(route, /rule_health/);
  assert.match(route, /human_approved_submission !== true/);
});

test("session submit surfaces run linkage status instead of swallowing failures", () => {
  const route = read("src/app/api/agent/session/route.ts");
  // The response exposes linkage + persistence facts when a run_id was supplied.
  assert.match(route, /run_linked:/);
  assert.match(route, /snapshots_persisted:/);
  assert.match(route, /linked_run_id:/);
  assert.match(route, /migration_required:/);
  assert.match(route, /warnings/);
  // A failed link is reported, not silently turned into ok:true with broken proof.
  assert.match(route, /NOT linked to a run/);
});

test("session submit computes the real three-state attestation server-side, never trusting the client's own approval claim", () => {
  const route = read("src/app/api/agent/session/route.ts");
  // origin is a literal per call site -- never derived from the request body.
  assert.match(route, /recordSubmission\(agent, body, sessionText, activeRules, true, "human"\)/);
  assert.match(route, /recordSubmission\(agent, body, sessionText, body\.rules_loaded, humanApproved, "agent"\)/);
  // humanConfirmed only ever comes from which auth path called this function --
  // an agent's own human_approved_submission claim can never produce it.
  assert.match(route, /humanConfirmed: origin === "human"/);
  assert.match(route, /import \{ classifySubmission, decideAttachment, computeSubmissionDigest, DEFAULT_EVIDENCE_SUBMISSION_POLICY \} from "@\/lib\/evidence-submission"/);
  // The real classification is recorded alongside (not instead of) the legacy boolean.
  assert.match(route, /submissionOrigin: attachment\.origin/);
  assert.match(route, /attachmentStatus: attachment\.status/);
  assert.match(route, /humanAttestation: attachment\.attestation/);
  assert.match(route, /submissionDigest: attachment\.digest/);
});

test("recordAgentSession persists the real attestation columns alongside the legacy boolean, never in place of it", () => {
  const svc = read("src/lib/agent-join-service.ts");
  assert.match(svc, /human_approved_submission: meta\.humanApproved/);
  assert.match(svc, /submission_origin: meta\.submissionOrigin \?\? null/);
  assert.match(svc, /attachment_status: meta\.attachmentStatus \?\? null/);
  assert.match(svc, /human_attestation: meta\.humanAttestation \?\? null/);
  assert.match(svc, /submission_digest: meta\.submissionDigest \?\? null/);
});

test("linkSessionToRun returns a structured result and never silently swallows a link failure", () => {
  const svc = read("src/lib/agent-run-service.ts");
  assert.match(svc, /export interface LinkSessionResult/);
  assert.match(svc, /runLinked: boolean/);
  assert.match(svc, /snapshotsPersisted: boolean/);
  assert.match(svc, /migrationRequired: boolean/);
  // Ownership failure → reported (runLinked:false), not thrown/swallowed.
  assert.match(svc, /Run could not be linked to this session/);
  // Missing optional columns → explicit migration-required signal.
  assert.match(svc, /isMissingColumnError\(snapshotError\)/);
  assert.match(svc, /migration required: apply supabase-agent-runs\.sql/);
});
