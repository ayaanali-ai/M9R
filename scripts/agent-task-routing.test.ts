import assert from "node:assert/strict";
import test from "node:test";

import { routeAgentTask } from "@/lib/agent-task-routing";

test("mechanical work starts on the economy tier with a small bounded budget", () => {
  const route = routeAgentTask({ task: "Rename the settings label and run formatting" });

  assert.equal(route.taskClass, "mechanical");
  assert.equal(route.modelTier, "economy");
  assert.equal(route.providerPreference, null);
  assert.equal(route.maxEstimatedTokens, 4_000);
  assert.equal(route.requiresHumanApproval, false);
});

test("visual design work routes to Claude on a balanced tier without claiming a concrete model", () => {
  const route = routeAgentTask({ task: "Redesign the Watchfloor agent card interactions", paths: ["src/components/product/WatchfloorOps.tsx"] });

  assert.equal(route.taskClass, "design");
  assert.equal(route.modelTier, "balanced");
  assert.equal(route.providerPreference, "claude-code");
  assert.equal(route.maxEstimatedTokens, 60_000);
  assert.equal(route.requiresHumanApproval, false);
});

test("ordinary implementation stays provider-neutral on the balanced tier", () => {
  const route = routeAgentTask({ task: "Implement pagination for the run ledger", paths: ["src/lib/run-ledger.ts"] });

  assert.equal(route.taskClass, "implementation");
  assert.equal(route.modelTier, "balanced");
  assert.equal(route.providerPreference, null);
});

test("security migrations always use the frontier tier and require human approval", () => {
  const route = routeAgentTask({ task: "Change the authentication RLS migration", paths: ["supabase/migrations/20260716_auth.sql"] });

  assert.equal(route.taskClass, "high_risk");
  assert.equal(route.modelTier, "frontier");
  assert.equal(route.requiresHumanApproval, true);
  assert.equal(route.maxEstimatedTokens, 60_000);
});

test("a failed cheap attempt escalates exactly one tier instead of repeating unchanged", () => {
  const route = routeAgentTask({ task: "Fix a formatting failure", failedAttempts: 1 });

  assert.equal(route.baseModelTier, "economy");
  assert.equal(route.modelTier, "balanced");
  assert.equal(route.escalated, true);
});

test("two failed attempts escalate to frontier and stop further automatic retries", () => {
  const route = routeAgentTask({ task: "Implement pagination for the run ledger", failedAttempts: 2 });

  assert.equal(route.modelTier, "frontier");
  assert.equal(route.escalated, true);
  assert.equal(route.automaticRetryAllowed, false);
  assert.equal(route.requiresHumanApproval, true);
});

test("an explicit minimum tier is never silently downgraded", () => {
  const route = routeAgentTask({ task: "Rename one label", minimumTier: "frontier" });

  assert.equal(route.baseModelTier, "economy");
  assert.equal(route.modelTier, "frontier");
});

test("empty or ambiguous work is treated conservatively instead of routed cheaply", () => {
  const route = routeAgentTask({ task: "Do the thing" });

  assert.equal(route.taskClass, "ambiguous");
  assert.equal(route.modelTier, "balanced");
  assert.equal(route.requiresHumanApproval, true);
});
