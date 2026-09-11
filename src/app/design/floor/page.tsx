"use client";

/**
 * /design/floor — static ops-floor reference (mock data, no auth).
 * Exists so the WatchfloorOps visual language — every station state, both
 * watch modes, the sprites — can be reviewed on localhost without a signed-in
 * workspace. The real floor lives in the dashboard and renders only real
 * presence; this page is the design bench.
 */

import { useState } from "react";
import WatchfloorOps from "@/components/product/WatchfloorOps";
import type { AgentView } from "@/lib/agent-workspace-data";
import type { AgentUsageView } from "@/lib/agent-usage";

// Fixed anchor, not Date.now() — server and client must render the exact same
// "confirmed Ns ago" strings or React throws a hydration mismatch.
const now = Date.parse("2026-07-12T18:00:00Z");
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

function mockAgent(partial: Partial<AgentView> & Pick<AgentView, "key" | "label">): AgentView {
  return {
    initial: partial.label[0] ?? "A",
    connectionId: `mock-${partial.key}`,
    workspaceId: "mock-workspace",
    setupCommand: "npx m9r-cli init",
    connected: true,
    connectionStatus: "active",
    liveness: "active",
    repoHint: "runleak",
    lastSeenAt: iso(30_000),
    runs: [],
    sessions: [],
    reviewRules: [],
    unassignedCandidates: [],
    rulesForReviewCount: 0,
    approvalCount: 0,
    pendingApprovals: 0,
    activeRulesCount: 2,
    readiness: { state: "ready", title: "Ready", detail: "Mock data — no real Run B check performed." },
    ...partial,
  } as AgentView;
}

const run = (id: string, status: string, task: string, seenMsAgo: number, extra: Partial<AgentView["runs"][number]> = {}) => ({
  id,
  connection_id: `mock-${id}`,
  agent_kind: null,
  repo_hint: "runleak",
  task_title: task,
  status,
  current_phase: null,
  rules_loaded_count: 2,
  latest_session_id: null,
  started_at: iso(seenMsAgo + 60_000),
  last_seen_at: iso(seenMsAgo),
  ...extra,
});

const USAGE: AgentUsageView[] = [
  {
    agentKey: "claude-code",
    source: "recorded_run_tokens",
    isProviderAllowance: false,
    fiveHour: { available: true, usedTokens: 840_000, budgetTokens: 2_000_000, pct: 42, resetAtMs: now + 2 * 60 * 60 * 1000 + 6 * 60 * 1000 },
    sevenDay: { available: true, usedTokens: 3_600_000, budgetTokens: 20_000_000, pct: 18, resetAtMs: now + 3 * 24 * 60 * 60 * 1000 },
  },
  {
    agentKey: "codex",
    source: "recorded_run_tokens",
    isProviderAllowance: false,
    fiveHour: { available: true, usedTokens: 1_260_000, budgetTokens: 2_000_000, pct: 63, resetAtMs: now + 69 * 60 * 1000 },
    sevenDay: { available: true, usedTokens: 9_400_000, budgetTokens: 20_000_000, pct: 47, resetAtMs: now + 2 * 24 * 60 * 60 * 1000 },
  },
  {
    agentKey: "grok-build",
    source: "recorded_run_tokens",
    isProviderAllowance: false,
    fiveHour: { available: false, usedTokens: 0, budgetTokens: 2_000_000, pct: null, resetAtMs: null },
    sevenDay: { available: false, usedTokens: 0, budgetTokens: 20_000_000, pct: null, resetAtMs: null },
  },
];

const AGENTS: AgentView[] = [
  mockAgent({
    key: "claude-code",
    label: "Claude Code",
    runs: [run("r1", "working", "Fix the dashboard drawer focus trap", 4_000, {
      current_phase: "Reading db/schema.prisma",
      behavior: { inputTokens: 2_300_000, outputTokens: 180_000, toolCalls: 4, changedFiles: 27 },
    })],
  }),
  mockAgent({
    key: "codex",
    label: "Codex",
    runs: [run("r2", "submitted", "Controlled-run evidence template", 20_000, {
      current_phase: "Editing docs/api-reference.md",
      latest_session_id: "sess-2",
      behavior: { inputTokens: 506_700, outputTokens: 38_000, toolCalls: 3, changedFiles: 13 },
    })],
  }),
  mockAgent({
    key: "grok-build",
    label: "Grok Build",
    lastSeenAt: iso(41 * 60_000),
    liveness: "stale",
    runs: [],
  }),
  mockAgent({
    key: "other",
    label: "Other",
    connected: false,
    connectionStatus: "unavailable",
    liveness: "none",
    lastSeenAt: null,
    runs: [],
  }),
];

export default function FloorReference() {
  // Real state, not a hardcoded prop — the design bench is otherwise the only
  // place to exercise tab-switch focus behavior without a signed-in workspace.
  const [selectedKey, setSelectedKey] = useState("claude-code");
  return (
    <div className="wf-root" data-bs-mode="night" style={{ minHeight: "100vh", background: "#0a0b0d", padding: "48px 24px" }}>
      <div style={{ maxWidth: 1080, margin: "0 auto" }}>
        <div style={{ fontFamily: "var(--font-geist-mono), monospace", fontSize: 10, letterSpacing: "0.16em", textTransform: "uppercase", color: "#5f6975", marginBottom: 14 }}>
          Design bench · mock data · working / waiting / asleep / offline
        </div>
        <WatchfloorOps
          agents={AGENTS}
          usage={USAGE}
          runId="r2"
          pendingDecisions={3}
          selectedKey={selectedKey}
          onSelectAgent={setSelectedKey}
        />
      </div>
    </div>
  );
}
