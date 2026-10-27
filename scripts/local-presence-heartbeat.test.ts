import assert from "node:assert/strict";
import test from "node:test";

import { startLocalPresenceHeartbeat } from "@/lib/native/local-presence-heartbeat";

test("local MCP presence immediately posts an authenticated lease and advances its sequence", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const heartbeat = startLocalPresenceHeartbeat({
    appUrl: "https://m9r.example/",
    agentToken: "agent-token-fixture",
    provider: "claude-code",
    adapterInstanceId: "adapter-fixture-1234",
    intervalMs: 60_000,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({
        ok: true,
        state: "awake",
        lease_expires_at: "2026-07-12T12:01:30.000Z",
      }), { status: 200 });
    },
  });

  assert.equal(await heartbeat.ready, true);
  assert.equal(await heartbeat.sendNow(), true);
  heartbeat.stop();

  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url, "https://m9r.example/api/agent/presence/heartbeat");
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, "Bearer agent-token-fixture");
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
    protocolVersion: "m9r.presence.v1",
    adapterInstanceId: "adapter-fixture-1234",
    sequence: 1,
    executionOrigin: "linked",
    provider: "claude-code",
    idempotencyKey: "adapter-fixture-1234:1",
  });
  assert.equal(JSON.parse(String(calls[1]!.init.body)).sequence, 2);
});

test("stopping local MCP presence cancels future renewals and reports a failed request without throwing", async () => {
  let calls = 0;
  const errors: unknown[] = [];
  const heartbeat = startLocalPresenceHeartbeat({
    appUrl: "https://m9r.example",
    agentToken: "agent-token-fixture",
    provider: "codex",
    adapterInstanceId: "adapter-fixture-5678",
    intervalMs: 1,
    fetchImpl: async () => {
      calls += 1;
      return new Response("no", { status: 503 });
    },
    onError: (error) => errors.push(error),
  });
  assert.equal(await heartbeat.ready, false);
  heartbeat.stop();
  const stoppedCalls = calls;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, stoppedCalls);
  assert.equal(errors.length, 1);
  assert.equal(await heartbeat.sendNow(), false);
});

test("a successful HTTP response without an accepted presence lease is not treated as online", async () => {
  const errors: unknown[] = [];
  const heartbeat = startLocalPresenceHeartbeat({
    appUrl: "https://m9r.example",
    agentToken: "agent-token-fixture",
    provider: "opencode",
    adapterInstanceId: "adapter-fixture-invalid-response",
    intervalMs: 60_000,
    fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    onError: (error) => errors.push(error),
  });

  assert.equal(await heartbeat.ready, false);
  heartbeat.stop();
  assert.equal(errors.length, 1);
  assert.match(String((errors[0] as Error).message), /accepted presence lease/i);
});
