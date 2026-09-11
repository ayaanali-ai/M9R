import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { acceptHeartbeat, HEARTBEAT_LEASE_MS } from "@/lib/agent-heartbeat";

const RECEIVED_AT = "2026-07-12T12:00:00.000Z";

function heartbeat(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: "m9r.presence.v1",
    adapterInstanceId: "adapter-12345678",
    sequence: 1,
    executionOrigin: "linked",
    provider: "codex",
    idempotencyKey: "hb-1234567890abcdef",
    ...overrides,
  };
}

test("accepts a valid linked heartbeat and assigns a server lease", () => {
  const result = acceptHeartbeat(heartbeat(), { receivedAt: RECEIVED_AT, previousSequence: null });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.observation.sequence, 1);
  assert.equal(result.observation.receivedAt, RECEIVED_AT);
  assert.equal(result.observation.leaseExpiresAt, new Date(Date.parse(RECEIVED_AT) + HEARTBEAT_LEASE_MS).toISOString());
});

test("rejects duplicate and out-of-order adapter sequences", () => {
  assert.deepEqual(acceptHeartbeat(heartbeat({ sequence: 4 }), { receivedAt: RECEIVED_AT, previousSequence: 4 }), {
    ok: false,
    reason: "sequence_not_newer",
  });
  assert.deepEqual(acceptHeartbeat(heartbeat({ sequence: 3 }), { receivedAt: RECEIVED_AT, previousSequence: 4 }), {
    ok: false,
    reason: "sequence_not_newer",
  });
});

test("rejects unknown protocol versions and execution origins", () => {
  assert.equal(acceptHeartbeat(heartbeat({ protocolVersion: "v2" }), { receivedAt: RECEIVED_AT, previousSequence: null }).ok, false);
  assert.equal(acceptHeartbeat(heartbeat({ executionOrigin: "magic" }), { receivedAt: RECEIVED_AT, previousSequence: null }).ok, false);
});

test("rejects malformed identity and idempotency fields", () => {
  assert.equal(acceptHeartbeat(heartbeat({ adapterInstanceId: "x" }), { receivedAt: RECEIVED_AT, previousSequence: null }).ok, false);
  assert.equal(acceptHeartbeat(heartbeat({ idempotencyKey: "short" }), { receivedAt: RECEIVED_AT, previousSequence: null }).ok, false);
});

test("rejects invalid server receipt timestamps instead of issuing a lease", () => {
  assert.deepEqual(acceptHeartbeat(heartbeat(), { receivedAt: "not-a-date", previousSequence: null }), {
    ok: false,
    reason: "invalid_server_time",
  });
});

test("heartbeat API authenticates the connection and never accepts workspace identity from the body", async () => {
  const route = await readFile(new URL("../src/app/api/agent/presence/heartbeat/route.ts", import.meta.url), "utf8");
  assert.match(route, /authenticateAgent\(bearerFrom/);
  assert.match(route, /recordAgentHeartbeat\(agent, body/);
  assert.doesNotMatch(route, /body\.workspace/);
});

test("heartbeat persistence scopes every lookup and write to token-bound connection and workspace", async () => {
  const service = await readFile(new URL("../src/lib/agent-presence-service.ts", import.meta.url), "utf8");
  assert.match(service, /\.rpc\("record_agent_heartbeat_atomic"/);
  assert.match(service, /p_workspace_id: agent\.workspaceId/);
  assert.match(service, /p_connection_id: agent\.connectionId/);
  assert.doesNotMatch(service, /service_role|SUPABASE_SERVICE_ROLE/);
});
