/**
 * Live Sessions usage presenter — pure-logic tests
 * ----------------------------------------------------------------------------
 * The 5H/7D usage bars must never fabricate consumption: only runs that
 * actually reported behavior.totalTokens inside the rolling window count, the
 * percentage is measured against the human-set budget, and reset times come
 * from the oldest contributing run aging out.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAgentUsage,
  DEFAULT_BUDGETS,
  FIVE_HOURS_MS,
  formatResetIn,
  formatTokens,
  parseBudgetInput,
} from "../src/lib/agent-usage.ts";
import type { WsRun } from "../src/lib/agent-workspace-data.ts";

const NOW = Date.parse("2026-07-21T12:00:00Z");

function run(overrides: Partial<WsRun> & { last_seen_at: string }): WsRun {
  return {
    id: "r1",
    agent_kind: "claude-code",
    repo_hint: null,
    task_title: null,
    status: "completed",
    current_phase: null,
    rules_loaded_count: 0,
    latest_session_id: null,
    started_at: null,
    ...overrides,
  };
}

test("sums only reported tokens inside each window", () => {
  const runs: WsRun[] = [
    run({ id: "a", last_seen_at: new Date(NOW - 60 * 60 * 1000).toISOString(), behavior: { totalTokens: 500_000 } }),
    // Outside 5h, inside 7d.
    run({ id: "b", last_seen_at: new Date(NOW - 20 * 60 * 60 * 1000).toISOString(), behavior: { totalTokens: 1_000_000 } }),
    // Outside both windows.
    run({ id: "c", last_seen_at: new Date(NOW - 10 * 24 * 60 * 60 * 1000).toISOString(), behavior: { totalTokens: 9_999_999 } }),
    // No reported tokens: contributes nothing (never fabricated).
    run({ id: "d", last_seen_at: new Date(NOW - 5 * 60 * 1000).toISOString(), behavior: null }),
  ];
  const usage = buildAgentUsage("claude-code", runs, { window5hTokens: 2_000_000, window7dTokens: 20_000_000 }, NOW);
  assert.equal(usage.fiveHour.usedTokens, 500_000);
  assert.equal(usage.fiveHour.pct, 25);
  assert.equal(usage.sevenDay.usedTokens, 1_500_000);
  assert.equal(usage.sevenDay.pct, 8);
});

test("reset time comes from the oldest contributing run aging out", () => {
  const oldest = NOW - 2 * 60 * 60 * 1000;
  const runs: WsRun[] = [
    run({ id: "a", last_seen_at: new Date(oldest).toISOString(), behavior: { totalTokens: 100 } }),
    run({ id: "b", last_seen_at: new Date(NOW - 10 * 60 * 1000).toISOString(), behavior: { totalTokens: 100 } }),
  ];
  const usage = buildAgentUsage("codex", runs, DEFAULT_BUDGETS_INPUT, NOW);
  assert.equal(usage.fiveHour.resetAtMs, oldest + FIVE_HOURS_MS);
  assert.equal(formatResetIn(usage.fiveHour.resetAtMs, NOW), "resets in 3h 0m");
});

test("empty window is unavailable rather than claiming the provider used 0%", () => {
  const usage = buildAgentUsage("codex", [], DEFAULT_BUDGETS_INPUT, NOW);
  assert.equal(usage.fiveHour.available, false);
  assert.equal(usage.fiveHour.pct, null);
  assert.equal(usage.fiveHour.resetAtMs, null);
  assert.equal(formatResetIn(usage.fiveHour.resetAtMs, NOW), null);
});

test("reported run tokens are labeled as recorded telemetry, not provider allowance", () => {
  const usage = buildAgentUsage("codex", [
    run({
      last_seen_at: new Date(NOW - 60_000).toISOString(),
      behavior: { totalTokens: 1_000 },
    }),
  ], DEFAULT_BUDGETS_INPUT, NOW);

  assert.equal(usage.source, "recorded_run_tokens");
  assert.equal(usage.isProviderAllowance, false);
  assert.equal(usage.fiveHour.available, true);
  assert.equal(usage.fiveHour.pct, 0);
});

const DEFAULT_BUDGETS_INPUT = {
  window5hTokens: DEFAULT_BUDGETS.window5hTokens,
  window7dTokens: DEFAULT_BUDGETS.window7dTokens,
};

test("token formatting matches the notch style", () => {
  assert.equal(formatTokens(2_300_000), "2.3M");
  assert.equal(formatTokens(180_000), "180.0k");
  assert.equal(formatTokens(950), "950");
  assert.equal(formatTokens(null), "0");
});

test("budget input parses human forms and rejects garbage", () => {
  assert.equal(parseBudgetInput("2M"), 2_000_000);
  assert.equal(parseBudgetInput("1.5m"), 1_500_000);
  assert.equal(parseBudgetInput("800k"), 800_000);
  assert.equal(parseBudgetInput("2,000,000"), 2_000_000);
  assert.equal(parseBudgetInput("0"), null);
  assert.equal(parseBudgetInput("-5M"), null);
  assert.equal(parseBudgetInput("all of it"), null);
});
