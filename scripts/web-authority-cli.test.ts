import assert from "node:assert/strict";
import test from "node:test";
import { buildWebAuthorityCliRequest, runWebAuthorityCli } from "@/lib/native/web-authority-cli";

test("web authority CLI builds bounded owner requests and parses duration options", () => {
  assert.deepEqual(buildWebAuthorityCliRequest(["pending"]), { ok: true, request: { method: "GET", path: "/web/pending" } });
  assert.deepEqual(buildWebAuthorityCliRequest(["audit", "--verify"]), { ok: true, request: { method: "GET", path: "/web/audit?verify=1" } });
  assert.deepEqual(buildWebAuthorityCliRequest(["approve", "req-1", "--actions", "read,click", "--ttl", "30m", "--max-uses", "4"]), {
    ok: true,
    request: { method: "POST", path: "/web/approve", body: { id: "req-1", actions: ["read", "click"], ttlMs: 1_800_000, maxUses: 4 }, confirmation: "Approve web access request req-1?" },
  });
  assert.equal(buildWebAuthorityCliRequest(["approve", "req-1", "--actions", "delete"]).ok, false);
  assert.equal(buildWebAuthorityCliRequest(["approve", "req-1", "--ttl", "9h"]).ok, false);
  assert.equal(buildWebAuthorityCliRequest(["approve", "req-1", "--max-uses", "0"]).ok, false);
});

test("AWARE membership and disclosure mutations require explicit owner confirmation", () => {
  assert.deepEqual(buildWebAuthorityCliRequest(["members"]), { ok: true, request: { method: "GET", path: "/web/aware/members" } });
  assert.deepEqual(buildWebAuthorityCliRequest(["disclosures"]), { ok: true, request: { method: "GET", path: "/web/aware/disclosures" } });
  assert.deepEqual(buildWebAuthorityCliRequest(["invite", "codex"]), {
    ok: true,
    request: { method: "POST", path: "/web/aware/members/invite", body: { agent: "codex" }, confirmation: "Invite @codex to act in this browser room?" },
  });
  assert.deepEqual(buildWebAuthorityCliRequest(["remove", "claude", "--owner", "alice"]), {
    ok: true,
    request: { method: "POST", path: "/web/aware/members/remove", body: { agent: "claude", owner: "alice" }, confirmation: "Remove @claude from alice from this browser room?" },
  });
  assert.deepEqual(buildWebAuthorityCliRequest(["disclosure", "approve", "disclosure-1"]), {
    ok: true,
    request: { method: "POST", path: "/web/aware/disclosures/decision", body: { requestId: "disclosure-1", decision: "approve" }, confirmation: "Approve AWARE disclosure request disclosure-1?" },
  });
  assert.equal(buildWebAuthorityCliRequest(["invite", "bad/name"]).ok, false);
  assert.equal(buildWebAuthorityCliRequest(["disclosure", "approve"]).ok, false);
});

test("grant approval refuses agent or non-terminal contexts before contacting the broker", async () => {
  let calls = 0;
  const errors: string[] = [];
  const result = await runWebAuthorityCli(["approve", "req-1"], {
    port: 47821, key: "local-key", fetch: async () => { calls += 1; return new Response("{}", { status: 200 }); },
    out: () => {}, err: (line) => errors.push(line), canApprove: false,
  });
  assert.equal(result, 1);
  assert.equal(calls, 0);
  assert.match(errors.join("\n"), /interactive human terminal/);
});

test("grant approval requires confirmation and sends only the requested narrowed options", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const out: string[] = [];
  let confirmed = false;
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ ok: true, grant: { id: "grant-1" } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await runWebAuthorityCli(["approve", "req-1", "--actions", "read"], {
    port: 47821, key: "local-key", fetch: fetcher, out: (line) => out.push(line), err: () => {}, canApprove: true,
    confirm: async (question) => { confirmed = question.includes("req-1"); return confirmed; },
  });
  assert.equal(result, 0);
  assert.equal(confirmed, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:47821/web/approve");
  assert.equal((calls[0].init?.headers as Record<string, string>)["x-m9r-key"], "local-key");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { id: "req-1", actions: ["read"] });
  assert.match(out.join("\n"), /grant-1/);
});

test("owner-only approval always uses the authenticated broker API after confirmation", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const out: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ ok: true, grant: { id: "grant-2" } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await runWebAuthorityCli(["approve", "req-2"], {
    port: 47821, key: "owner-only-key", fetch: fetcher,
    out: (line) => out.push(line), err: () => {}, canApprove: true, confirm: async () => true,
  });
  assert.equal(result, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:47821/web/approve");
  assert.equal((calls[0].init?.headers as Record<string, string>)["x-m9r-key"], "owner-only-key");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { id: "req-2" });
  assert.match(out.join("\n"), /grant-2/);
});

test("AWARE membership invitation uses the authenticated broker channel only after confirmation", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ ok: true, member: { state: "active" } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await runWebAuthorityCli(["invite", "codex"], {
    port: 47821, key: "owner-only-key", fetch: fetcher,
    out: () => {}, err: () => {}, canApprove: true, confirm: async (question) => question.includes("codex"),
  });
  assert.equal(result, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:47821/web/aware/members/invite");
  assert.equal((calls[0].init?.headers as Record<string, string>)["x-m9r-key"], "owner-only-key");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { agent: "codex" });
});
