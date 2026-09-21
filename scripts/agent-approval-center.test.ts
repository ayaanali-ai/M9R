import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  DEFAULT_APPROVAL_LIMIT,
  buildAgentApprovalCenter,
  filterApprovalsForAgent,
} from "../src/lib/agent-approval-center.ts";
import type { AgentView, WsRule, WsRun } from "../src/lib/agent-workspace-data.ts";
import { buildRunPassport, type RunPassportInput } from "../src/lib/run-passport-service.ts";

const NOW = Date.parse("2026-07-08T18:00:00.000Z");
const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
// AgentWorkspaceClient.tsx was split into src/components/product/agent-workspace/*
// (approval-center.tsx, run-panels.tsx, preflight.tsx, strip-board.tsx,
// handoff.tsx, shared.tsx) with the orchestrator left in the original file.
// Assertions below check source text that may now live in any of these
// files, so read them all as one corpus -- same pattern as the multi-file
// reads in scripts/workspace-rules.test.ts.
const readWorkspace = () => [
  "src/components/product/AgentWorkspaceClient.tsx",
  "src/components/product/agent-workspace/shared.tsx",
  "src/components/product/agent-workspace/strip-board.tsx",
  "src/components/product/agent-workspace/run-panels.tsx",
  "src/components/product/agent-workspace/preflight.tsx",
  "src/components/product/agent-workspace/approval-center.tsx",
  "src/components/product/agent-workspace/handoff.tsx",
].map(read).join("\n");

function run(overrides: Partial<WsRun> = {}): WsRun {
  return {
    id: "run-codex-1",
    connection_id: "connection-codex",
    agent_kind: "codex",
    repo_hint: "oathlock",
    task_title: "Test OathLock agent instruction inbox",
    status: "working",
    current_phase: "verification",
    rules_loaded_count: 2,
    latest_session_id: null,
    started_at: "2026-07-08T17:00:00.000Z",
    last_seen_at: "2026-07-08T17:55:00.000Z",
    ...overrides,
  };
}

function rule(overrides: Partial<WsRule> = {}): WsRule {
  return {
    id: "rule-codex-1",
    workspaceId: "workspace-codex",
    title: "Verify before final response",
    body: "Run the relevant verification before the final response.",
    ruleType: "verification",
    status: "needs_review",
    sourceReportId: "session-codex-1",
    sourceSessionName: "Codex session",
    evidenceSummary: "Verification was missing from the session.",
    confidence: "high",
    promotedAt: null,
    createdAt: "2026-07-08T16:00:00.000Z",
    ...overrides,
  };
}

function agent(
  key: AgentView["key"],
  label: string,
  overrides: Partial<AgentView> = {},
): AgentView {
  return {
    id: `agent:${key}`,
    key,
    label,
    initial: label.slice(0, 2),
    connectionId: `connection-${key}`,
    workspaceId: `workspace-${key}`,
    setupCommand: `$env:OATHLOCK_AGENT_KIND="${key}"; npx oathlock init`,
    registered: true,
    connected: true,
    providerReadiness: "unverified",
    liveness: "active",
    repoHint: "oathlock",
    lastSeenAt: "2026-07-08T17:55:00.000Z",
    runs: [],
    sessions: [],
    reviewRules: [],
    unassignedCandidates: [],
    rulesForReviewCount: 0,
    approvalCount: 0,
    pendingApprovals: 0,
    activeRulesCount: 0,
    readiness: {
      state: "blocked",
      title: "Run B blocked",
      detail: "No active rules are available.",
    },
    ...overrides,
  };
}

function passportInput(
  runInput: WsRun,
  overrides: Partial<RunPassportInput> = {},
): RunPassportInput {
  return {
    run: {
      ...runInput,
      connection_id: runInput.connection_id ?? "connection-codex",
      workspace_id: "workspace-codex",
      completed_at: runInput.latest_session_id ? "2026-07-08T17:56:00.000Z" : null,
    },
    session: runInput.latest_session_id
      ? {
          id: runInput.latest_session_id,
          created_at: "2026-07-08T17:56:00.000Z",
          human_approved_submission: true,
          behavior: {
            verificationPresent: true,
            testsPassed: true,
            lintPassed: true,
            buildPassed: true,
          },
        }
      : null,
    activeRules: [],
    humanReview: {
      decision: null,
      reviewed_at: null,
      note_present: false,
    },
    ...overrides,
  };
}

test("groups pending approvals by agent and filters all versus selected agent", () => {
  const codex = agent("codex", "Codex", { reviewRules: [rule()] });
  const claude = agent("claude-code", "Claude Code", {
    reviewRules: [
      rule({
        id: "rule-claude-1",
        workspaceId: "workspace-claude-code",
        sourceReportId: "session-claude-1",
      }),
    ],
  });

  const center = buildAgentApprovalCenter({
    agents: [codex, claude],
    passports: [],
    nowMs: NOW,
  });

  assert.equal(center.counts.total, 2);
  assert.equal(center.counts.rules, 2);
  assert.equal(center.by_agent.codex, 1);
  assert.equal(center.by_agent["claude-code"], 1);
  assert.equal(filterApprovalsForAgent(center.approvals, "all").length, 2);
  assert.deepEqual(
    filterApprovalsForAgent(center.approvals, "codex").map((item) => item.agent_id),
    ["codex"],
  );
});

test("returns the empty state model when no decisions are pending", () => {
  const center = buildAgentApprovalCenter({
    agents: [agent("codex", "Codex")],
    passports: [],
    nowMs: NOW,
  });

  assert.equal(center.counts.total, 0);
  assert.deepEqual(center.approvals, []);
});

test("creates rule approvals only for review drafts and recommendations", () => {
  const codex = agent("codex", "Codex", {
    reviewRules: [
      rule(),
      rule({ id: "rule-active", status: "active" }),
      rule({ id: "rule-archived", status: "retired" }),
    ],
    unassignedCandidates: [
      rule({ id: "rule-import", sourceReportId: null, sourceSessionName: "import:AGENTS.md" }),
    ],
  });

  const center = buildAgentApprovalCenter({
    agents: [codex],
    passports: [],
    nowMs: NOW,
  });

  assert.deepEqual(
    center.approvals.filter((item) => item.type === "rule").map((item) => item.metadata.rule_id).sort(),
    ["rule-codex-1", "rule-import"],
  );
  assert.ok(center.approvals.every((item) => item.primary_action.kind === "promote_rule"));
});

test("approved agent evidence without a human review creates an evidence approval", () => {
  const submittedRun = run({
    latest_session_id: "session-codex-1",
    status: "completed",
  });
  const passport = buildRunPassport(passportInput(submittedRun));

  const center = buildAgentApprovalCenter({
    agents: [agent("codex", "Codex", { runs: [submittedRun] })],
    passports: [passport],
    nowMs: NOW,
  });

  const approval = center.approvals.find((item) => item.type === "evidence");
  assert.ok(approval);
  assert.equal(approval.run_id, submittedRun.id);
  assert.match(approval.title, /^Agent evidence ready for approval:/);
  assert.match(approval.description, /Review what the agent prepared and decide what M9R records\./);
  assert.equal(approval.primary_action.kind, "review_run_passport");
});

test("review-ready evidence with a recorded human review creates no approval", () => {
  const reviewedRun = run({
    id: "run-reviewed",
    latest_session_id: "session-reviewed",
    status: "completed",
  });
  const passport = buildRunPassport(
    passportInput(reviewedRun, {
      humanReview: {
        decision: "reviewed",
        reviewed_at: "2026-07-08T17:59:00.000Z",
        note_present: false,
      },
    }),
  );

  const center = buildAgentApprovalCenter({
    agents: [agent("codex", "Codex", { runs: [reviewedRun] })],
    passports: [passport],
    nowMs: NOW,
  });

  assert.deepEqual(center.approvals, []);
});

test("old completed runs do not appear unless they have a genuine pending decision", () => {
  const oldRun = run({
    id: "run-old",
    status: "completed",
    latest_session_id: null,
    started_at: "2026-06-29T12:00:00.000Z",
    last_seen_at: "2026-06-29T13:00:00.000Z",
  });

  const center = buildAgentApprovalCenter({
    agents: [agent("codex", "Codex", { runs: [oldRun] })],
    passports: [],
    nowMs: NOW,
  });

  assert.deepEqual(center.approvals, []);
});

test("Ready for Review opens inline in the shared side panel, defaults to five rows, and exposes safe actions", () => {
  const workspace = readWorkspace();
  const approvalHelper = read("src/lib/agent-approval-center.ts");
  // The header icon toggles themselves live in ConversationPanel.tsx (the
  // chat shell), not the AgentWorkspaceClient.tsx family readWorkspace()
  // covers -- read it separately for the header-side assertions below.
  const conversationPanel = read("src/components/product/ConversationPanel.tsx");

  assert.equal(DEFAULT_APPROVAL_LIMIT, 5);
  // WorkspaceDrawer (kicker/title/description/onClose/children) still exists
  // and is still a real full-screen modal -- just for Run Detail now, not
  // Ready for Review. Ready for Review and Files moved into one shared
  // side-panel slot (sidePanelMode: "files" | "review" | null), opened from
  // header icon toggles instead of a buried "more actions" menu or a modal,
  // per explicit product direction: both should open "in the side panel
  // properly," and Files/Review are mutually exclusive in that one slot.
  assert.match(workspace, /function WorkspaceDrawer/);
  assert.match(workspace, /function ApprovalCenter/);
  // Files and Activity tabs were removed outright (items #24/#25) -- the
  // shared side-panel slot now covers Review/Whispers/Drafts/People/Live.
  assert.match(workspace, /type SidePanelMode = "review" \| "whispers" \| "drafts" \| "people" \| "live" \| "handoffs" \| null/);
  assert.match(workspace, /function toggleSidePanel\(mode: "review" \| "whispers" \| "drafts" \| "people" \| "live" \| "handoffs"\)/);
  assert.match(workspace, /sidePanelMode === "review"/);
  assert.match(workspace, /<span>Ready for Review<\/span>/);
  assert.match(workspace, /onOpenReview=\{\(\) => toggleSidePanel\("review"\)\}/);
  assert.match(workspace, /pendingReviewCount=\{approvalCenter\.counts\.total\}/);
  assert.match(workspace, /wf-review-panel-body/);
  assert.match(conversationPanel, /m9r-channel-dock__item/); // the header toggle class after the channel dock redesign
  assert.match(conversationPanel, /onOpenReview && \(/);
  assert.match(workspace, /overflow-y-auto/);
  assert.match(workspace, /Approval type filters/);
  assert.match(workspace, /Agent evidence/);
  assert.match(workspace, /No human decisions pending\. Current run records and audit history are preserved\./);
  assert.match(workspace, /Show all \(/);
  assert.match(workspace, /Show fewer/);
  // Pending decisions are not hidden behind a time window: the list and badge
  // now describe the same actionable set, including older unresolved items.
  assert.doesNotMatch(workspace, /Show older \(/);
  assert.match(workspace, /PromoteRuleButton/);
  assert.match(workspace, /Delete draft/);
  assert.doesNotMatch(workspace, />Reject<\/Button>/);
  assert.doesNotMatch(workspace, />\s*Discard\s*</);
  // Review-decision labels ("Mark reviewed" / "Needs follow-up" / "Not
  // accepted") do NOT appear here: they belonged to the Run Passport, which
  // was cut. Deciding from a queue row means approving evidence you cannot
  // see, so this queue still grows no decision control of its own.
  assert.doesNotMatch(workspace, /Mark reviewed/);
  // StripBoard's own render was removed: the "runs waiting on you" condition
  // it showed is the same one already covered by Approval Center's
  // evidenceApproval, so it was a redundant surface.
  assert.doesNotMatch(workspace, /<StripBoard/);
  // The Run Passport document was cut along with its page -- the run drawer
  // shows the live run process only.
  assert.doesNotMatch(workspace, /<RunPassportDocument/);
  assert.ok(!/<ApprovalSummaryCard|function ApprovalSummaryCard/.test(workspace), "Approval Center must remain drawer-only by default");
  assert.ok(!/window\.confirm\(|\bconfirm\(/.test(workspace), "Approval Center must not use native confirm");
  for (const forbidden of ["proof of correctness", "guaranteed", "remote control", "force compliance"]) {
    assert.ok(!approvalHelper.toLowerCase().includes(forbidden), `presenter must not contain ${forbidden}`);
  }
});

test("dashboard loads only owner-scoped approval metadata and preserves the server-client boundary", () => {
  const page = read("src/app/dashboard/agents/page.tsx");
  const loader = read("src/lib/agent-approval-center-data.ts");

  assert.match(loader, /import "server-only"/);
  assert.match(loader, /createClient/);
  assert.match(loader, /human_approved_submission, rule_health, behavior/);
  assert.match(loader, /\.eq\("event_type", REVIEW_DECISION_EVENT_TYPE\)/);
  assert.match(loader, /if \(error\) return null/);
  assert.match(loader, /const passports = reviewEventsByRun \? submittedRuns\.map/);
  assert.ok(!/session_text|raw_content|token_hash|claim_url|one_time_token/.test(loader));
  assert.match(page, /loadAgentApprovalData/);
  assert.match(page, /buildAgentApprovalCenter/);
  assert.match(page, /approvalCount: approvalCenter\.by_agent\[agent\.key\]/);
  // The needsApproval/status computation this used to feed only existed for
  // the masthead's live stat row, removed this session -- approvalCenter's
  // own counts (still used above and passed straight into
  // AgentWorkspaceClient) remain the real source of truth for pending work.
  assert.doesNotMatch(page, /needsApproval: approvalCenter\.counts\.total/);
});

test("agent rail badges, selected-agent filtering, and run-record focus use the approval presenter", () => {
  const workspace = readWorkspace();

  assert.match(workspace, /approvalCenter\.approvals/);
  // The pending-decisions badge moved off a "more actions" dropdown trigger
  // (wf-decisions-btn, now deleted along with that menu) onto the Ready for
  // Review header icon itself -- see wf-chat-panel-toggle's own badge.
  assert.match(workspace, /pendingReviewCount=\{approvalCenter\.counts\.total\}/);
  assert.match(workspace, /id="wf-evidence"/);
  // D0: focusing a run's evidence/review zone no longer scrolls an in-page
  // anchor into view -- it opens the run detail drawer instead
  // (focusRun -> setFocusRequest + openDrawer("run")).
  assert.match(workspace, /function focusRun\(runId: string, zone: RunZone\)/);
  assert.match(workspace, /setFocusRequest\(\{ runId, zone, nonce: focusNonceRef\.current \}\)/);
  assert.match(workspace, /openDrawer\("run"\)/);
  // The queue renders no review-decision buttons of its own -- deciding from
  // a queue row means approving evidence you cannot see.
  assert.doesNotMatch(workspace, /saveApprovalReviewDecision/);
  assert.match(workspace, /router\.refresh\(\);/);
});

test("unsupported preflight and delivered-instruction inferences are not fabricated", () => {
  const approvalHelper = read("src/lib/agent-approval-center.ts");

  assert.ok(!/preflight/i.test(approvalHelper));
  assert.ok(!/delivered.*evidence|evidence.*delivered/i.test(approvalHelper));
});

test("an expanded approval card shows its full description instead of staying clamped to one line", () => {
  // Confirmed live: a card's description was permanently line-clamp-1'd
  // even after clicking "View details" -- the expanded panel only ever
  // showed supplementary rule-body/instruction text, so a plain
  // description-only approval (or a description not backed by one of
  // those) had no path to being read in full at all.
  const source = read("src/components/product/agent-workspace/approval-center.tsx");
  assert.match(source, /className=\{`mt-0\.5 text-\[length:var\(--ol-text-2xs\)\] text-\[color:var\(--ol-text-muted\)\] \$\{expanded \? "whitespace-pre-wrap" : "line-clamp-1"\}`\}/);
});
