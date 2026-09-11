/**
 * Free-plan workspace limits.
 * ----------------------------------------------------------------------------
 * Pure entitlement tests plus structural checks for the server/UI wiring. The
 * live Supabase behavior is covered by the central service queries and RLS.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  FREE_PLAN_LIMIT_MESSAGE,
  FREE_PLAN_AGENT_LIMIT_MESSAGE,
  FREE_PLAN_RULE_LIMIT_MESSAGE,
  resolveUserPlan,
  workspaceUsageFor,
  getPlanLimits,
} from "../src/lib/plan-limits-service.ts";

const root = process.cwd();
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

test("no subscription or plan row is treated as free", () => {
  assert.equal(resolveUserPlan({ subscription: null, userMetadata: null }), "free");
});

test("a missing optional subscription table in the PostgREST schema cache is treated as free", () => {
  const service = read("src/lib/plan-limits-service.ts");
  const missingSurface = service.slice(
    service.indexOf("function missingOptionalPlanSurface"),
    service.indexOf("export function normalizeUserPlan"),
  );

  assert.match(missingSurface, /PGRST205/);
});

test("free user with 0 workspaces can create a workspace", () => {
  const usage = workspaceUsageFor("free", 0);
  assert.equal(usage.maxWorkspaces, 2);
  assert.equal(usage.limitReached, false);
});

test("free user with 1 workspace can create a second workspace", () => {
  const usage = workspaceUsageFor("free", 1);
  assert.equal(usage.maxWorkspaces, 2);
  assert.equal(usage.limitReached, false);
});

test("free user with 2 workspaces cannot create a third workspace", () => {
  const usage = workspaceUsageFor("free", 2);
  assert.equal(usage.limitReached, true);
  assert.equal(usage.message, FREE_PLAN_LIMIT_MESSAGE);
});

test("paid user is not blocked by the free cap", () => {
  const usage = workspaceUsageFor("paid", 12);
  assert.equal(usage.maxWorkspaces, null);
  assert.equal(usage.limitReached, false);
});

test("wrong-user and deleted workspaces are not counted", () => {
  const svc = read("src/lib/plan-limits-service.ts");
  const countFn = svc.slice(svc.indexOf("export async function countUserWorkspaces"));
  assert.match(countFn, /fromTable\(db, "projects"\)/);
  assert.match(countFn, /\.eq\("owner_id", userId\)/);
  assert.match(countFn, /\.is\("deleted_at", null\)/);
});

test("workspace creation is server-enforced before inserts", () => {
  const svc = read("src/lib/projects-service.ts");
  const createProject = svc.slice(svc.indexOf("export async function createProject"));
  const createDefault = svc.slice(svc.indexOf("async function createDefaultWorkspace"), svc.indexOf("/**\n * Resolve the workspace"));
  assert.match(createProject, /await assertCanCreateWorkspace\(db, userId\)/);
  assert.match(createDefault, /await assertCanCreateWorkspace\(db, userId\)/);

  const route = read("src/app/api/projects/route.ts");
  assert.match(route, /err instanceof PlanLimitError/);
  assert.match(route, /code: err\.code/);
});

test("dashboard create UI shows usage and disables creation at the free cap", () => {
  const projects = read("src/components/product/ProjectsView.tsx");
  const switcher = read("src/components/product/WorkspaceSwitcher.tsx");
  assert.match(projects, /workspaceUsage/);
  assert.match(projects, /createLimitReached/);
  assert.match(projects, /workspaceUsage\.workspaceCount/);
  assert.match(projects, /workspaceUsage\.maxWorkspaces/);
  assert.match(projects, /workspaceUsage\?\.message/);
  assert.match(switcher, /workspaceUsage/);
  assert.match(switcher, /createLimitReached/);
  assert.match(switcher, /workspaceUsage\?\.message/);
});

// --- Real billing: agent, rule, and retention limits ------------------------

test("free plan limits match the advertised numbers; paid plan has none", () => {
  const free = getPlanLimits("free");
  assert.equal(free.maxWorkspaces, 2);
  assert.equal(free.maxAgents, 2);
  assert.equal(free.maxRules, 10);
  assert.equal(free.auditRetentionDays, 30);

  const paid = getPlanLimits("paid");
  assert.equal(paid.maxWorkspaces, null);
  assert.equal(paid.maxAgents, null);
  assert.equal(paid.maxRules, null);
  assert.equal(paid.auditRetentionDays, null);
});

test("unknown plan is treated the same as free for limits", () => {
  assert.deepEqual(getPlanLimits("unknown"), getPlanLimits("free"));
});

test("claim approval enforces the agent limit before the atomic approval RPC runs", () => {
  const svc = read("src/lib/agent-join-service.ts");
  const approveClaim = svc.slice(svc.indexOf("export async function approveClaim"), svc.indexOf("export async function approveClaim") + 1800);
  const rpcIndex = approveClaim.indexOf("approve_agent_claim_atomic");
  const checkIndex = approveClaim.indexOf("assertCanConnectAgent");
  assert.ok(checkIndex > -1, "approveClaim must call assertCanConnectAgent");
  assert.ok(checkIndex < rpcIndex, "the plan check must run before the approval RPC, never after");
});

test("an agent kind already connected to the workspace never trips the limit on reconnect", () => {
  const svc = read("src/lib/plan-limits-service.ts");
  const fn = svc.slice(svc.indexOf("export async function assertCanConnectAgent"), svc.indexOf("async function workspaceHasAgentKind"));
  assert.match(fn, /workspaceHasAgentKind/);
  assert.match(fn, /if \(alreadyCounted\) return;/);
});

test("agent limit error carries the free-plan agent message and a distinct code", () => {
  const svc = read("src/lib/plan-limits-service.ts");
  const fn = svc.slice(svc.indexOf("export async function assertCanConnectAgent"));
  assert.match(fn, /FREE_PLAN_AGENT_LIMIT_MESSAGE/);
  assert.match(fn, /FREE_AGENT_LIMIT_REACHED/);
  assert.equal(FREE_PLAN_AGENT_LIMIT_MESSAGE.includes("2 agents"), true);
});

test("both rule-promotion paths enforce the active-rule limit before flipping status to active", () => {
  const svc = read("src/lib/workspace-rules-service.ts");
  const direct = svc.slice(svc.indexOf("export async function promoteWorkspaceRule("), svc.indexOf("export async function promoteWorkspaceRuleForAgentConnection"));
  assert.match(direct, /assertCanActivateRule\(db, user\.id, sourceRule\.workspace_id\)/);

  const forConnection = svc.slice(svc.indexOf("export async function promoteWorkspaceRuleForAgentConnection"));
  assert.match(forConnection, /assertCanActivateRule\(db, user\.id, targetWorkspaceId\)/);
});

test("rule limit error carries the free-plan rule message and a distinct code", () => {
  const svc = read("src/lib/plan-limits-service.ts");
  const fn = svc.slice(svc.indexOf("export async function assertCanActivateRule"));
  assert.match(fn, /FREE_PLAN_RULE_LIMIT_MESSAGE/);
  assert.match(fn, /FREE_RULE_LIMIT_REACHED/);
  assert.equal(FREE_PLAN_RULE_LIMIT_MESSAGE.includes("10"), true);
});

test("the promote route surfaces PlanLimitError with its status and usage, not a generic 500", () => {
  const route = read("src/app/api/agent/rules/promote/route.ts");
  assert.match(route, /err instanceof PlanLimitError/);
  assert.match(route, /status: err\.status/);
  assert.match(route, /usage: err\.usage/);
});

test("only active workspace rules (never drafts/retired) count toward the free-plan rule cap", () => {
  const svc = read("src/lib/plan-limits-service.ts");
  const fn = svc.slice(svc.indexOf("export async function countActiveWorkspaceRules"), svc.indexOf("export async function assertCanActivateRule"));
  assert.match(fn, /\.eq\("status", "active"\)/);
  assert.match(fn, /\.is\("deleted_at", null\)/);
});

test("audit log retention filters what a free workspace sees but never re-verifies a truncated chain", () => {
  const route = read("src/app/api/dashboard/audit-log/route.ts");
  assert.match(route, /auditRetentionDays/);
  assert.match(route, /entries\.filter/);
  // verifyAuditLogChain must still run over the full stored chain (it takes
  // only workspaceId, no date range) -- retention limits display, not proof.
  assert.match(route, /verifyAuditLogChain\(workspaceId\)/);
  assert.doesNotMatch(route, /verifyAuditLogChain\(workspaceId, *cutoff/);
});
