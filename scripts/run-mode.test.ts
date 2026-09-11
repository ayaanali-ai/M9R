import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkBudget,
  briefFitsPolicy,
  checkRunDurationBudget,
  defaultPolicyForMode,
  isRunMode,
  SOLO_POLICY,
  COORDINATED_POLICY,
  ASSURANCE_POLICY,
  COLLABORATIVE_POLICY,
} from "../src/lib/run-mode.ts";

test("solo is a zero-coordination policy", () => {
  assert.equal(SOLO_POLICY.maxSupportingAgents, 0);
  assert.equal(SOLO_POLICY.maxRequests, 0);
  assert.equal(SOLO_POLICY.maxDelegationDepth, 0);
});

test("solo policy rejects any coordination request immediately", () => {
  const result = checkBudget(SOLO_POLICY, { supportingAgentsUsed: 0, requestsUsed: 0, currentDelegationDepth: 0 });
  assert.equal(result.allowed, false);
});

test("coordinated policy allows the first request, then blocks after the limit", () => {
  const usage = { supportingAgentsUsed: 0, requestsUsed: 0, currentDelegationDepth: 0 };
  const first = checkBudget(COORDINATED_POLICY, usage);
  assert.equal(first.allowed, true);

  const atLimit = checkBudget(COORDINATED_POLICY, { ...usage, requestsUsed: 1 });
  assert.equal(atLimit.allowed, false);
  assert.match(atLimit.reason!, /Request count/);
});

test("assurance policy allows exactly one request", () => {
  const usage = { supportingAgentsUsed: 0, requestsUsed: 0, currentDelegationDepth: 0 };
  assert.equal(checkBudget(ASSURANCE_POLICY, usage).allowed, true);
  assert.equal(checkBudget(ASSURANCE_POLICY, { ...usage, requestsUsed: 1 }).allowed, false);
});

test("delegation depth is checked before request count", () => {
  const result = checkBudget(COORDINATED_POLICY, { supportingAgentsUsed: 0, requestsUsed: 0, currentDelegationDepth: 1 });
  assert.equal(result.allowed, false);
  assert.match(result.reason!, /Delegation depth/);
});

test("defaultPolicyForMode returns the matching named policy", () => {
  assert.equal(defaultPolicyForMode("solo"), SOLO_POLICY);
  assert.equal(defaultPolicyForMode("coordinated"), COORDINATED_POLICY);
  assert.equal(defaultPolicyForMode("assurance"), ASSURANCE_POLICY);
  assert.equal(defaultPolicyForMode("collaborative"), COLLABORATIVE_POLICY);
});

test("isRunMode validates every canonical mode only", () => {
  assert.ok(isRunMode("solo"));
  assert.ok(isRunMode("assurance"));
  assert.ok(isRunMode("collaborative"));
  assert.ok(!isRunMode("chaos"));
});

test("briefFitsPolicy enforces the character cap", () => {
  assert.equal(briefFitsPolicy(SOLO_POLICY, 100), true);
  assert.equal(briefFitsPolicy(SOLO_POLICY, 999_999), false);
});

// ---------------------------------------------------------------------------
// Gate 8: wall-clock run duration budget
// ---------------------------------------------------------------------------

test("a run well within its policy's ceiling is not over budget", () => {
  const startedAt = new Date("2026-07-12T00:00:00Z").toISOString();
  const now = new Date("2026-07-12T01:00:00Z").getTime();
  const result = checkRunDurationBudget(startedAt, now, SOLO_POLICY);
  assert.equal(result.overBudget, false);
  assert.equal(result.exceededByMs, 0);
});

test("a run past its policy's ceiling is reported over budget by the exact overage", () => {
  const startedAt = new Date("2026-07-12T00:00:00Z").toISOString();
  const now = new Date("2026-07-12T00:00:00Z").getTime() + SOLO_POLICY.maxRunDurationMs + 5 * 60_000;
  const result = checkRunDurationBudget(startedAt, now, SOLO_POLICY);
  assert.equal(result.overBudget, true);
  assert.equal(result.exceededByMs, 5 * 60_000);
});

test("a run exactly at the ceiling is not yet over budget (ceiling is inclusive)", () => {
  const startedAt = new Date("2026-07-12T00:00:00Z").toISOString();
  const now = new Date("2026-07-12T00:00:00Z").getTime() + SOLO_POLICY.maxRunDurationMs;
  assert.equal(checkRunDurationBudget(startedAt, now, SOLO_POLICY).overBudget, false);
});

test("an invalid or future startedAt is never treated as over budget", () => {
  assert.equal(checkRunDurationBudget("not-a-date", Date.now(), SOLO_POLICY).overBudget, false);
  const future = new Date(Date.now() + 60_000).toISOString();
  assert.equal(checkRunDurationBudget(future, Date.now(), SOLO_POLICY).overBudget, false);
});

test("every named policy carries a positive maxRunDurationMs", () => {
  for (const policy of [SOLO_POLICY, COORDINATED_POLICY, ASSURANCE_POLICY, COLLABORATIVE_POLICY]) {
    assert.ok(policy.maxRunDurationMs > 0, `${policy.mode} must have a positive run duration ceiling`);
  }
});

test("collaborative mode is bounded rather than an unbounded swarm", () => {
  assert.equal(COLLABORATIVE_POLICY.maxSupportingAgents, 2);
  assert.equal(COLLABORATIVE_POLICY.maxRequests, 6);
  assert.equal(COLLABORATIVE_POLICY.maxDelegationDepth, 1);
  assert.equal(checkBudget(COLLABORATIVE_POLICY, { supportingAgentsUsed: 2, requestsUsed: 5, currentDelegationDepth: 0 }).allowed, true);
  assert.equal(checkBudget(COLLABORATIVE_POLICY, { supportingAgentsUsed: 2, requestsUsed: 6, currentDelegationDepth: 0 }).allowed, false);
});

// ---------------------------------------------------------------------------
// Enforcement wiring — agent-run-service.ts transitively imports next/headers
// (via @/lib/supabase/server), so it's verified by source, matching this
// repo's existing convention for that constraint (see work-signal-service.ts,
// agent-run-service.ts's own presence-attachment tests).
// ---------------------------------------------------------------------------

test("updateAgentRunStatus expires overdue runs visibly rather than misclassifying them as agent failures", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../src/lib/agent-run-service.ts", import.meta.url), "utf8");
  assert.match(src, /import \{ defaultPolicyForMode, checkRunDurationBudget, isRunMode \} from "@\/lib\/run-mode"/);
  assert.match(src, /checkRunDurationBudget\(run\.started_at, Date\.now\(\), policy\)/);
  assert.match(src, /status = "expired"/);
  assert.match(src, /exceeded its \$\{policy\.mode\} time budget/);
  assert.match(src, /evidence and history are preserved/);
  // Never enforced against an already-terminal status — a completed/failed/submitted/expired run isn't re-judged.
  assert.match(src, /TERMINAL_RUN_STATUSES\.has\(status\)/);
});
