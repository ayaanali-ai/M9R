/**
 * Agent usage presenter (pure, server-free)
 * ----------------------------------------------------------------------------
 * Rolling-window token usage per agent kind for the Live Sessions floor's
 * usage bars. Sums only tokens the runs actually reported (behavior snapshot);
 * runs without a token count contribute nothing — the bars never fabricate
 * consumption. Percentages are measured against a human-set budget, not a
 * provider quota (OathLock cannot see provider rate limits).
 */

import type { AgentKindKey, WsRun } from "@/lib/agent-workspace-data";

export const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export const DEFAULT_BUDGETS = {
  window5hTokens: 2_000_000,
  window7dTokens: 20_000_000,
} as const;

export interface AgentUsageBudget {
  agentKey: AgentKindKey;
  window5hTokens: number;
  window7dTokens: number;
}

export interface UsageWindowView {
  /** False means OathLock received no token telemetry. It must not be rendered as 0% provider usage. */
  available: boolean;
  usedTokens: number;
  budgetTokens: number;
  /** Whole-number percent of the operator-defined budget consumed. Null when telemetry is unavailable. */
  pct: number | null;
  /** Epoch ms when the oldest contributing run ages out of the window; null when the window is empty. */
  resetAtMs: number | null;
}

export interface AgentUsageView {
  agentKey: AgentKindKey;
  source: "recorded_run_tokens";
  /** This presenter never represents a provider subscription or account allowance. */
  isProviderAllowance: false;
  fiveHour: UsageWindowView;
  sevenDay: UsageWindowView;
}

function runUsageMs(run: WsRun): number {
  return Math.max(Date.parse(run.last_seen_at) || 0, Date.parse(run.started_at ?? "") || 0);
}

function windowUsage(runs: WsRun[], windowMs: number, budgetTokens: number, nowMs: number): UsageWindowView {
  let usedTokens = 0;
  let oldestMs: number | null = null;
  for (const run of runs) {
    const tokens = run.behavior?.totalTokens ?? 0;
    if (!tokens || tokens <= 0) continue;
    const activityMs = runUsageMs(run);
    if (activityMs <= 0 || nowMs - activityMs > windowMs) continue;
    usedTokens += tokens;
    if (oldestMs === null || activityMs < oldestMs) oldestMs = activityMs;
  }
  const budget = Math.max(1, budgetTokens);
  return {
    available: oldestMs !== null,
    usedTokens,
    budgetTokens: budget,
    pct: oldestMs === null ? null : Math.round((usedTokens / budget) * 100),
    resetAtMs: oldestMs === null ? null : oldestMs + windowMs,
  };
}

/** Build the per-agent 5H/7D usage views from that agent's runs. */
export function buildAgentUsage(
  agentKey: AgentKindKey,
  runs: WsRun[],
  budget: Pick<AgentUsageBudget, "window5hTokens" | "window7dTokens">,
  nowMs = Date.now(),
): AgentUsageView {
  return {
    agentKey,
    source: "recorded_run_tokens",
    isProviderAllowance: false,
    fiveHour: windowUsage(runs, FIVE_HOURS_MS, budget.window5hTokens, nowMs),
    sevenDay: windowUsage(runs, SEVEN_DAYS_MS, budget.window7dTokens, nowMs),
  };
}

/** 2300000 → "2.3M", 180000 → "180.0k", 950 → "950". */
export function formatTokens(value: number | null | undefined): string {
  const n = Math.max(0, value ?? 0);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

/** "resets in 2h 6m" for the short window. Null when nothing is in the window. */
export function formatResetIn(resetAtMs: number | null, nowMs = Date.now()): string | null {
  if (resetAtMs === null) return null;
  const remaining = Math.max(0, resetAtMs - nowMs);
  const totalMinutes = Math.ceil(remaining / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `resets in ${days}d ${hours % 24}h`;
  }
  if (hours > 0) return `resets in ${hours}h ${minutes}m`;
  return `resets in ${minutes}m`;
}

/** "refills Sat at 11:28 PM" for the week window. Null when nothing is in the window. */
export function formatRefillAt(resetAtMs: number | null, nowMs = Date.now()): string | null {
  if (resetAtMs === null) return null;
  const at = new Date(Math.max(resetAtMs, nowMs));
  const day = at.toLocaleDateString(undefined, { weekday: "short" });
  const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `refills ${day} at ${time}`;
}

/** Parse an operator-typed budget ("2M", "1.5m", "800k", "2000000") into tokens. */
export function parseBudgetInput(raw: string): number | null {
  const value = raw.trim().toLowerCase().replace(/,/g, "");
  const match = /^(\d+(?:\.\d+)?)\s*([km]?)$/.exec(value);
  if (!match) return null;
  const base = Number(match[1]);
  if (!Number.isFinite(base) || base <= 0) return null;
  const mult = match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1_000 : 1;
  return Math.round(base * mult);
}
