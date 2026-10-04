import assert from "node:assert/strict";
import test from "node:test";
import { handleAgentDoorRequest } from "../services/network-core/src/agent-door.ts";

const origin = "https://m9r-network-core.m9r.workers.dev";
const networkId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const agentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const peerId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const credential = `m9rn.${networkId}.${agentId}.${"x".repeat(43)}`;
const cookie = `__Host-m9r-network-agent=${encodeURIComponent(credential)}; __Host-m9r-network-cursor=0`;

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function rosterResponse(): Response {
  return jsonResponse({
    network_id: networkId,
    agents: [
      { agent_id: agentId, handle: "@alice/muse", provider: "muse", door: "web", status: "active" },
      { agent_id: peerId, handle: "@bob/dots", provider: "dots", door: "web", status: "active" },
    ],
  });
}

function baseDependencies(overrides: Partial<{
  registerAgent(request: Request, input: Record<string, unknown>): Promise<Response>;
  callAgentApi(request: Request, identity: { networkId: string; agentId: string; token: string }, path: string, init?: { method?: "GET" | "POST"; body?: unknown }): Promise<Response>;
}> = {}) {
  return {
    registerAgent: overrides.registerAgent ?? (async () => jsonResponse({ error: "unexpected register" }, 500)),
    callAgentApi: overrides.callAgentApi ?? (async () => jsonResponse({ error: "unexpected API call" }, 500)),
  };
}

test("join redeems the code through the web door and keeps the credential in a secure cookie", async () => {
  let registered: Record<string, unknown> | undefined;
  const response = await handleAgentDoorRequest(new Request(`${origin}/connect/join`, {
    method: "POST",
    headers: { origin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ provider: "muse", agent_name: "Muse", pairing_code: "ABCD-EFGH" }),
  }), baseDependencies({
    registerAgent: async (_request, input) => {
      registered = input;
      return jsonResponse({ credential, network_id: networkId, agent_id: agentId }, 201);
    },
  }));

  assert.equal(response?.status, 303);
  assert.equal(response?.headers.get("location"), "/connect");
  assert.equal(registered?.door, "web");
  assert.equal(registered?.provider, "muse");
  const cookies = response?.headers.get("set-cookie") ?? "";
  assert.match(cookies, /__Host-m9r-network-agent=.*HttpOnly; Secure; SameSite=Lax/);
  assert.doesNotMatch(await response?.text() ?? "", /m9rn\./);
});

test("join form accepts the server's Crockford Base32 code alphabet", async () => {
  const response = await handleAgentDoorRequest(new Request(`${origin}/connect`), baseDependencies());
  const html = await response?.text() ?? "";
  assert.ok(html.includes('pattern="[0-9A-HJKMNP-TV-Z]{4}-?[0-9A-HJKMNP-TV-Z]{4}"'));
});

test("cross-origin form submission cannot redeem a pairing code", async () => {
  let registerCalled = false;
  const response = await handleAgentDoorRequest(new Request(`${origin}/connect/join`, {
    method: "POST",
    headers: { origin: "https://attacker.example", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ provider: "muse", agent_name: "Muse", pairing_code: "ABCD-EFGH" }),
  }), baseDependencies({ registerAgent: async () => { registerCalled = true; return jsonResponse({}); } }));

  assert.equal(response?.status, 403);
  assert.equal(registerCalled, false);
});

test("agent inbox renders untrusted message content as text and does not expose its credential", async () => {
  const response = await handleAgentDoorRequest(new Request(`${origin}/connect`, { headers: { cookie } }), baseDependencies({
    callAgentApi: async (_request, _identity, path) => path.includes("/roster")
      ? rosterResponse()
      : jsonResponse({ events: [{ event_id: peerId, thread_id: null, type: "message", from: "@bob/dots", to: "@alice/muse", body: "<script>alert(1)</script>", attachments: [], ts: "2026-10-03T12:00:00.000Z" }], cursor: "1", has_more: false }),
  }));

  const html = await response?.text() ?? "";
  assert.equal(response?.status, 200);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /m9rn\./);
  assert.match(response?.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
});

test("send uses the paired agent identity, threads the message, and preserves idempotency", async () => {
  let sent: Record<string, unknown> | undefined;
  const idempotencyKey = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const threadId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const response = await handleAgentDoorRequest(new Request(`${origin}/connect/send`, {
    method: "POST",
    headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ to: "@bob/dots", body: "Dinner at five?", thread_id: threadId, idempotency_key: idempotencyKey }),
  }), baseDependencies({
    callAgentApi: async (_request, identity, path, input) => {
      assert.equal(identity.token, credential);
      assert.equal(path, "/v1/events");
      sent = input?.body as Record<string, unknown>;
      return jsonResponse({ event_id: peerId, duplicate: false }, 201);
    },
  }));

  assert.equal(response?.status, 303);
  assert.equal(sent?.to, "@bob/dots");
  assert.equal(sent?.body, "Dinner at five?");
  assert.equal(sent?.thread_id, threadId);
  assert.equal(sent?.idempotency_key, idempotencyKey);
  assert.equal(sent?.type, "message");
});

test("disconnect revokes the agent and clears both browser cookies", async () => {
  let revokePath = "";
  const response = await handleAgentDoorRequest(new Request(`${origin}/connect/logout`, {
    method: "POST",
    headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded" },
    body: "",
  }), baseDependencies({
    callAgentApi: async (_request, identity, path) => {
      revokePath = path;
      assert.equal(identity.token, credential);
      return jsonResponse({ ok: true });
    },
  }));

  assert.equal(response?.status, 303);
  assert.match(revokePath, new RegExp(`/v1/networks/${networkId}/agents/${agentId}/revoke`));
  assert.match(response?.headers.get("set-cookie") ?? "", /__Host-m9r-network-agent=; Path=\/; Max-Age=0; HttpOnly; Secure; SameSite=Lax/);
});
