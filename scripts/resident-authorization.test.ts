import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { scopeResidentAuthorizationData } from "../src/lib/resident-authorization-data.ts";

test("owner resident authorization API uses signed-in human auth and derives target identity", async () => {
  const route = await readFile(new URL("../src/app/api/residents/authorizations/route.ts", import.meta.url), "utf8");
  const service = await readFile(new URL("../src/lib/resident-authorization-service.ts", import.meta.url), "utf8");
  assert.doesNotMatch(route, /authenticateAgent/);
  assert.match(service, /createClient/);
  assert.match(service, /auth\.getUser/);
  assert.match(service, /resident_instances/);
  assert.match(service, /agent_connections/);
  assert.match(service, /target_connection_id:\s*resident\.connection_id/);
  assert.doesNotMatch(service, /input\.targetConnectionId/);
});

test("authorization validates capability and budget bounds and can be revoked", async () => {
  const service = await readFile(new URL("../src/lib/resident-authorization-service.ts", import.meta.url), "utf8");
  assert.match(service, /maxDurationMs/);
  assert.match(service, /maxEstimatedTokens/);
  assert.match(service, /maxDelegationDepth/);
  assert.match(service, /capabilities/);
  assert.match(service, /revoked_at/);
  const revoke = await readFile(new URL("../src/app/api/residents/authorizations/[id]/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(revoke, /authenticateAgent/);
  assert.match(revoke, /revokeResidentAuthorization/);
});

test("Settings exposes a real owner control for bounded resident authorization, off the default Watchfloor view", async () => {
  const floor = await readFile(new URL("../src/components/product/ResidentAuthorizationPanel.tsx", import.meta.url), "utf8");
  // AgentWorkspaceClient.tsx was split into src/components/product/agent-workspace/*
  // with the orchestrator left in the original file; check the doesNotMatch
  // below across the whole split corpus so a relocated import can't hide it.
  const workspaceFiles = [
    "../src/components/product/AgentWorkspaceClient.tsx",
    "../src/components/product/agent-workspace/shared.tsx",
    "../src/components/product/agent-workspace/strip-board.tsx",
    "../src/components/product/agent-workspace/run-panels.tsx",
    "../src/components/product/agent-workspace/preflight.tsx",
    "../src/components/product/agent-workspace/approval-center.tsx",
    "../src/components/product/agent-workspace/handoff.tsx",
  ];
  const workspace = (await Promise.all(
    workspaceFiles.map((f) => readFile(new URL(f, import.meta.url), "utf8")),
  )).join("\n");
  const settings = await readFile(new URL("../src/components/product/SettingsView.tsx", import.meta.url), "utf8");
  assert.match(floor, /\/api\/residents\/authorizations/);
  assert.match(floor, /human_before_start/);
  assert.match(floor, /maxDelegationDepth:\s*1/);
  assert.match(floor, /Authorize .* for review/);
  assert.match(floor, /method: "DELETE"/);
  assert.match(floor, /Revoke active/);
  assert.match(floor, /Remove stale/);
  assert.doesNotMatch(floor, /useState\("binding-gate11-readonly"\)/);
  assert.match(floor, /residentAuthorizations\.find/);
  assert.match(floor, /Needs authorization/);
  assert.match(floor, /Online/);
  assert.match(floor, /Authorize Claude Code for review|Authorize .* for review/);
  assert.match(floor, /aria-label="Authorization required"/);
  assert.match(floor, /Previous authorization/);
  assert.match(floor, /bg-\[color:var\(--ol-accent\)\]/);

  // Resident authorization is maintenance for the opt-in autonomous/ACP-bridge
  // mode, not something every visit to the default Watchfloor should carry --
  // it moved to Settings so the primary view stays chat-first.
  assert.doesNotMatch(workspace, /<ResidentAuthorizationPanel/);
  assert.match(settings, /<ResidentAuthorizationPanel/);
  assert.match(settings, /\/api\/residents\/authorizations/);
});

test("resident authorization state is scoped to the selected canonical provider", () => {
  const scoped = scopeResidentAuthorizationData({
    selectedAgentKind: "grok-build",
    residentActivity: [
      { id: "resident-claude", provider: "claude-code", lease_expires_at: null, revoked_at: null },
      { id: "resident-grok", provider: "grok-build", lease_expires_at: null, revoked_at: null },
    ],
    residentAuthorizations: [
      { id: "auth-claude", resident_instance_id: "resident-claude", repository_binding_id: "binding-claude", revoked_at: null },
      { id: "auth-grok", resident_instance_id: "resident-grok", repository_binding_id: "binding-grok", revoked_at: null },
    ],
  });

  assert.deepEqual(scoped.residentActivity.map((resident) => resident.id), ["resident-grok"]);
  assert.deepEqual(scoped.residentAuthorizations.map((authorization) => authorization.id), ["auth-grok"]);
});
