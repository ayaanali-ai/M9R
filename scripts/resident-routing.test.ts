import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { decideAssistanceApproval, routeAssistanceRequest } from "@/lib/resident-routing";

const NOW = Date.parse("2026-07-13T21:00:00.000Z");

const baseRequest = {
  requestingConnectionId: "codex-primary",
  explicitTargetConnectionId: null,
  preferredProvider: null,
  repositoryBindingId: "repo-runleak",
  requiredCapabilities: ["security-review"],
  delegationDepth: 1,
};

const candidates = [
  {
    connectionId: "claude-b",
    residentInstanceId: "resident-claude-b",
    provider: "claude-code" as const,
    repositoryBindingId: "repo-runleak",
    capabilities: ["security-review", "code-review"],
    leaseExpiresAt: "2026-07-13T21:02:00.000Z",
    authorizationActive: true,
    maxDelegationDepth: 1,
    activeLaunches: 1,
  },
  {
    connectionId: "claude-a",
    residentInstanceId: "resident-claude-a",
    provider: "claude-code" as const,
    repositoryBindingId: "repo-runleak",
    capabilities: ["security-review"],
    leaseExpiresAt: "2026-07-13T21:02:00.000Z",
    authorizationActive: true,
    maxDelegationDepth: 1,
    activeLaunches: 0,
  },
];

test("deterministically selects the least-busy eligible resident", () => {
  const result = routeAssistanceRequest(baseRequest, candidates, NOW);
  assert.equal(result.ok, true);
  assert.equal(result.selected?.connectionId, "claude-a");
  assert.equal(result.reason, "eligible_resident_with_least_active_work");
});

test("an explicit target is selected only when it remains eligible", () => {
  const selected = routeAssistanceRequest({ ...baseRequest, explicitTargetConnectionId: "claude-b" }, candidates, NOW);
  assert.equal(selected.selected?.connectionId, "claude-b");

  const unavailable = routeAssistanceRequest(
    { ...baseRequest, explicitTargetConnectionId: "claude-offline" },
    [...candidates, { ...candidates[0], connectionId: "claude-offline", residentInstanceId: "resident-offline", leaseExpiresAt: "2026-07-13T20:59:59.000Z" }],
    NOW,
  );
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.reason, "explicit_target_ineligible");
  assert.equal(unavailable.exclusions.find((item) => item.connectionId === "claude-offline")?.reason, "resident_offline");
});

test("filters wrong repository, missing capability, revoked authorization, requester, and excessive depth", () => {
  const result = routeAssistanceRequest(baseRequest, [
    { ...candidates[0], connectionId: "wrong-repo", repositoryBindingId: "repo-other" },
    { ...candidates[0], connectionId: "missing-cap", capabilities: ["documentation"] },
    { ...candidates[0], connectionId: "revoked", authorizationActive: false },
    { ...candidates[0], connectionId: "codex-primary" },
    { ...candidates[0], connectionId: "depth-zero", maxDelegationDepth: 0 },
  ], NOW);
  assert.equal(result.ok, false);
  assert.deepEqual(
    Object.fromEntries(result.exclusions.map((item) => [item.connectionId, item.reason])),
    {
      "wrong-repo": "repository_not_authorized",
      "missing-cap": "capability_missing",
      revoked: "authorization_revoked",
      "codex-primary": "requester_cannot_support_itself",
      "depth-zero": "delegation_depth_exceeded",
    },
  );
});

test("provider preference filters candidates and tie-breaking is stable", () => {
  const codex = { ...candidates[0], connectionId: "codex-helper", residentInstanceId: "resident-codex", provider: "codex" as const, activeLaunches: 0 };
  const preferred = routeAssistanceRequest({ ...baseRequest, preferredProvider: "codex" }, [...candidates, codex], NOW);
  assert.equal(preferred.selected?.connectionId, "codex-helper");

  const tied = routeAssistanceRequest(baseRequest, [
    { ...candidates[1], connectionId: "helper-z" },
    { ...candidates[1], connectionId: "helper-a" },
  ], NOW);
  assert.equal(tied.selected?.connectionId, "helper-a");
});

test("a Claude-targeted request never resolves to Grok Build or any other non-matching provider", () => {
  // Regression for the 2026-07-19 demo incident: a request meant for Claude
  // Code landed on Grok Build because preferred_provider was never sent by
  // the CLI at the time. Now that the CLI always sends it, prove the routing
  // primitive itself can never substitute a different provider when one is
  // explicitly requested -- even when Grok is the only, or the least-busy,
  // eligible candidate by every other criterion.
  const grok = { ...candidates[1], connectionId: "grok-helper", residentInstanceId: "resident-grok", provider: "grok-build" as const, activeLaunches: 0 };
  const claudeTargeted = routeAssistanceRequest({ ...baseRequest, preferredProvider: "claude-code" }, [grok], NOW);
  assert.equal(claudeTargeted.ok, false);
  assert.equal(claudeTargeted.selected, null);

  const withBothEligible = routeAssistanceRequest({ ...baseRequest, preferredProvider: "claude-code" }, [grok, ...candidates], NOW);
  assert.equal(withBothEligible.selected?.provider, "claude-code");
  assert.notEqual(withBothEligible.selected?.connectionId, "grok-helper");
});

test("routing reports no candidates without fabricating an agent", () => {
  assert.deepEqual(routeAssistanceRequest(baseRequest, [], NOW), {
    ok: false,
    selected: null,
    reason: "no_eligible_resident",
    exclusions: [],
  });
});

test("a root run can explicitly opt into bounded coordination without changing identity", async () => {
  const route = await readFile(new URL("../src/app/api/agent/run/start/route.ts", import.meta.url), "utf8");
  const service = await readFile(new URL("../src/lib/agent-run-service.ts", import.meta.url), "utf8");
  const cli = await readFile(new URL("../src/lib/oathlock-cli-core.ts", import.meta.url), "utf8");
  assert.match(route, /isRunMode\(body\.run_mode\)/);
  assert.match(service, /run_mode:\s*input\.runMode \?\? "solo"/);
  assert.match(cli, /--mode must be solo, coordinated, assurance, or collaborative/);
});

test("auto-assignment occurs only inside an explicit preauthorized boundary", () => {
  const request = { maxDurationMs: 300_000, maxEstimatedTokens: 5_000, delegationDepth: 1 };
  assert.deepEqual(decideAssistanceApproval(request, {
    approvalPolicy: "preauthorized_bounded",
    maxDurationMs: 600_000,
    maxEstimatedTokens: 10_000,
    maxDelegationDepth: 1,
  }), { decision: "preauthorized", reasons: [] });
  assert.equal(decideAssistanceApproval(request, {
    approvalPolicy: "human_before_start",
    maxDurationMs: 600_000,
    maxEstimatedTokens: 10_000,
    maxDelegationDepth: 1,
  }).decision, "human_approval_required");
  assert.deepEqual(decideAssistanceApproval(request, {
    approvalPolicy: "preauthorized_bounded",
    maxDurationMs: 60_000,
    maxEstimatedTokens: null,
    maxDelegationDepth: 0,
  }), {
    decision: "human_approval_required",
    reasons: ["duration_exceeds_authorization", "token_budget_not_authorized", "delegation_depth_exceeds_authorization"],
  });
});

test("agent request-help keeps coordination budgets and adds bounded targeted routing", async () => {
  const route = await readFile(new URL("../src/app/api/agent/runs/[id]/request-help/route.ts", import.meta.url), "utf8");
  assert.match(route, /canIssueRequest/);
  assert.match(route, /routeAssistanceForAgent/);
  assert.match(route, /repository_binding_id/);
  assert.match(route, /target_connection_id/);
  assert.match(route, /required_capabilities/);
  assert.match(route, /allowed_paths/);
  assert.match(route, /prohibited_paths/);
  assert.match(route, /currentDelegationDepth \+ 1/);
  assert.match(route, /routing_status: "unrouted"/);
  assert.ok(route.indexOf("Targeted assistance requires repository_binding_id") < route.indexOf("publishDispatch({"));
  assert.ok(route.indexOf("Targeted assistance requires bounded capabilities") < route.indexOf("publishDispatch({"));
});

test("coordination usage does not charge provider budget for an undelivered request", async () => {
  const service = await readFile(new URL("../src/lib/bounded-assistance-service.ts", import.meta.url), "utf8");
  assert.match(service, /select\("id, routing_reason"\)/);
  assert.match(service, /routing_reason !== "no_eligible_resident"/);
});

test("routing service scopes reads and writes to the authenticated workspace and gates delivery on preauthorization", async () => {
  const service = await readFile(new URL("../src/lib/resident-routing-service.ts", import.meta.url), "utf8");
  assert.match(service, /resident_provider_authorizations/);
  assert.match(service, /resident_instances/);
  assert.match(service, /launch_grants/);
  assert.ok((service.match(/\.eq\("workspace_id", agent\.workspaceId\)/g) ?? []).length >= 4);
  assert.match(service, /decideAssistanceApproval/);
  assert.match(service, /resident\.connection_id !== authorization\.target_connection_id/);
  assert.match(service, /resident\.provider !== authorization\.provider/);
  assert.match(service, /Could not read resident workload/);
  assert.match(service, /human_approval_required/);
  assert.match(service, /createRoutedAssignment/);
  assert.match(service, /routing_reason/);
  assert.match(service, /routing_request/);
  assert.match(service, /approveRoutedAssistanceForDashboard/);
  assert.match(service, /rejectRoutedAssistanceForDashboard/);
  assert.match(service, /authorization\.created_by !== user\.id/);
  assert.match(service, /AUTHORIZATION_BOUNDARY_EXCEEDED/);
});

test("routed assignments preserve requesting agent, Dispatch, capabilities, resident, and human owner attribution", async () => {
  const service = await readFile(new URL("../src/lib/assignment-service.ts", import.meta.url), "utf8");
  const routed = service.slice(service.indexOf("export async function createRoutedAssignment"), service.indexOf("export async function listAssignmentsForDashboard"));
  assert.match(routed, /requesting_connection_id/);
  assert.match(routed, /target_connection_id/);
  assert.match(routed, /resident_instance_id/);
  assert.match(routed, /dispatch_id/);
  assert.match(routed, /required_capabilities/);
  assert.match(routed, /created_by: input\.createdBy/);
  assert.match(routed, /agent_instructions/);
  assert.match(routed, /\.eq\("dispatch_id", input\.dispatchId\)/);
  assert.match(routed, /if \(existing\) return existing/);
  assert.match(routed, /error\?\.code === "23505"/);
});

test("Gate 11 migration retains routing and approval state on the Dispatch", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20260713210000_gate11a_resident_launch.sql", import.meta.url), "utf8");
  assert.match(sql, /alter table public\.dispatches/i);
  assert.match(sql, /target_connection_id/i);
  assert.match(sql, /resident_instance_id/i);
  assert.match(sql, /assignment_id/i);
  assert.match(sql, /routing_reason/i);
  assert.match(sql, /routing_request/i);
  assert.match(sql, /approval_state/i);
  assert.match(sql, /agent_assignments_dispatch_unique/i);
});

test("owner-only routing decision API exposes approve and reject without bearer-agent authentication", async () => {
  const route = await readFile(new URL("../src/app/api/assignments/routing/[id]/route.ts", import.meta.url), "utf8");
  assert.match(route, /approveRoutedAssistanceForDashboard/);
  assert.match(route, /rejectRoutedAssistanceForDashboard/);
  assert.doesNotMatch(route, /authenticateAgent/);
  assert.match(route, /decision.*approve/);
  assert.match(route, /decision.*reject/);
});

// The Run Room UI (RunRoomThread.tsx) and its BoundedAssistanceList rendered
// on the cut /dashboard/runs/[id] page and were removed with it. The routing
// state they displayed is still projected by run-thread/dispatch-service, so
// that projection stays under test here.
test("routed bounded assistance retains its approval state and routing reason", async () => {
  const thread = await readFile(new URL("../src/lib/run-thread.ts", import.meta.url), "utf8");
  const dispatchService = await readFile(new URL("../src/lib/dispatch-service.ts", import.meta.url), "utf8");
  assert.match(thread, /approvalState: d\.approvalState/);
  assert.match(thread, /routingReason: d\.routingReason/);
  assert.match(dispatchService, /target_connection_id[\s\S]+routing_reason[\s\S]+approval_state/);
});
