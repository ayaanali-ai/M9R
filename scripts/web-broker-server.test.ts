import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { createLocalStore } from "@/lib/native/local-store";
import { createM9rMcpServer } from "@/lib/native/mcp-server";
import { createWebBrokerClient } from "@/lib/native/web-broker-client";
import { brokerKeyPath } from "@/lib/native/web-broker-paths";
import { createWebAuthority } from "@/lib/native/web-authority-core";
import { createWebAuthorityStore } from "@/lib/native/web-authority-store";
import { loadOrCreateBrokerKey, startWebBroker } from "@/lib/native/web-broker-server";

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type ToolServer = { _registeredTools: Record<string, { handler: (args: unknown) => Promise<ToolResult> }> };

async function setup(options: { allowedExtensionIds?: string[]; allowAnyExtension?: boolean; authority?: ReturnType<typeof createWebAuthority>; approvalTimeoutMs?: number; extensionConnectTimeoutMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "m9r-web-broker-"));
  const key = loadOrCreateBrokerKey(brokerKeyPath(root));
  const authorityStore = options.authority ? createWebAuthorityStore(root) : undefined;
  if (authorityStore && options.authority) authorityStore.save(options.authority.snapshot());
  const broker = await startWebBroker({
    key,
    port: 0,
    allowedExtensionIds: options.allowedExtensionIds,
    allowAnyExtension: options.allowAnyExtension,
    extensionConnectTimeoutMs: options.extensionConnectTimeoutMs ?? 50,
    approvalTimeoutMs: options.approvalTimeoutMs,
    timeoutMs: 1_000,
    authority: options.authority,
    authorityStore,
  });
  const store = createLocalStore(root);
  const web = createWebBrokerClient({ keyPath: brokerKeyPath(root), port: broker.port });
  const server = createM9rMcpServer({ store, web });
  const call = (name: string, args: unknown) => (server as unknown as ToolServer)._registeredTools[name].handler(args);
  const sockets: WebSocket[] = [];
  return {
    root,
    key,
    authorityStore,
    broker,
    store,
    call,
    connectExtension(origin = "chrome-extension://abc") {
      return new Promise<{ ws: WebSocket; received: Array<Record<string, unknown>>; notices: Array<Record<string, unknown>>; brokerStates: boolean[] }>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${broker.port}/ext`, { origin });
        sockets.push(ws);
        const received: Array<Record<string, unknown>> = [];
        const notices: Array<Record<string, unknown>> = [];
        const brokerStates: boolean[] = [];
        ws.on("message", (data) => {
          const message = JSON.parse(data.toString());
          if (message.type === "notice") notices.push(message);
          else if (message.type === "broker-state") brokerStates.push(message.stopped === true);
          else received.push(message);
        });
        ws.once("open", () => {
          ws.send(JSON.stringify({ type: "ready" }));
          resolve({ ws, received, notices, brokerStates });
        });
        ws.once("error", reject);
        ws.once("unexpected-response", (_req, res) => reject(new Error(`status ${res.statusCode}`)));
      });
    },
    async done() {
      for (const ws of sockets) ws.terminate();
      await broker.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function ownerRequest(port: number, key: string | undefined, path: string, method = "GET", body?: unknown, origin?: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (key) headers["x-m9r-key"] = key;
    if (body !== undefined) headers["content-type"] = "application/json";
    if (origin !== undefined) headers.origin = origin;
    const req = httpRequest({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
        catch (error) { reject(error); }
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.end(JSON.stringify(body));
    else req.end();
  });
}

function post(port: number, headers: Record<string, string>, body: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: "/cmd", method: "POST", headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(check(), "condition was not met in time");
};

test("an MCP tool call travels through the broker to the extension and back", async () => {
  const t = await setup({ allowAnyExtension: true });
  const issued = t.store.issueIdentity("claude", "claude-code", "s1");
  const { ws, received } = await t.connectExtension();

  const pending = t.call("m9r_web_click", { token: issued.token, selector: "#save-button", tab: "shared" });
  await until(() => received.length === 1);
  assert.equal(received[0].action, "click");
  assert.deepEqual(received[0].presence, {
    id: received[0].id, agent: "claude", provider: "claude-code", sessionId: "s1", owner: "you", action: "clicking #save-button", message: "clicking #save-button",
    claimed: true, claimMs: 8_000, target: { selector: "#save-button" }, claimScope: { kind: "tab", key: "*" },
  });
  ws.send(JSON.stringify({ type: "result", id: received[0].id, ok: true, data: { clicked: true } }));

  const result = await pending;
  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, JSON.stringify({ clicked: true }));
  await t.done();
});

test("owner web feed is authenticated and m9r_send publishes only a bounded sender-session notice", async () => {
  const t = await setup({ allowAnyExtension: true });
  try {
    const identity = t.store.issueIdentity("claude", "claude-code", "web-feed-session");
    const { ws, received, notices, brokerStates } = await t.connectExtension();
    await until(() => brokerStates.length > 0);
    assert.deepEqual(brokerStates, [false]);
    const opening = t.call("m9r_web_open", { token: identity.token, url: "https://example.test/", tab: "research" });
    await until(() => received.some((message) => message.type === "command"));
    const command = received.find((message) => message.type === "command")!;
    ws.send(JSON.stringify({ type: "result", id: command.id, ok: true, origin: "https://example.test", url: "https://example.test/" }));
    assert.equal((await opening).isError, undefined);

    assert.equal((await ownerRequest(t.broker.port, undefined, "/web/feed")).status, 401);
    assert.equal((await ownerRequest(t.broker.port, t.key, "/web/feed", "GET", undefined, "https://attacker.test")).status, 403);
    const feed = await ownerRequest(t.broker.port, t.key, "/web/feed");
    assert.equal(feed.status, 200);
    assert.equal((feed.body as { schema: string }).schema, "m9r.web-feed.v1");
    assert.equal(((feed.body as { tabs: Array<{ agents: unknown[] }> }).tabs[0].agents).length, 1);

    ws.send(JSON.stringify({ type: "message-visibility", sessionId: "web-feed-session", show: false }));
    await until(() => received.some((message) => message.type === "message-visibility-result"));
    assert.equal((received.find((message) => message.type === "message-visibility-result") as { accepted: boolean }).accepted, true);

    await t.call("m9r_send", { token: identity.token, to: "codex", goal: "Found the exact rate." });
    await until(() => notices.length > 0);
    const notice = notices[0];
    assert.equal(notice.tab, "research");
    const presence = notice.presence as Record<string, unknown>;
    assert.equal(presence.messageKind, "agent_message");
    assert.equal(presence.to, "codex");
    assert.equal(presence.message, "claude sent a message to codex");
    assert.ok(Array.from(String(presence.message)).length <= 80);
  } finally {
    await t.done();
  }
});

test("authorized extension stop-all blocks subsequent agent actions and appears in the local feed", async () => {
  const t = await setup({ allowAnyExtension: true });
  try {
    const identity = t.store.issueIdentity("claude", "claude-code", "stop-session");
    const { ws, received } = await t.connectExtension();
    ws.send(JSON.stringify({ type: "stop-all" }));
    await until(() => received.some((message) => message.type === "stop-all"));
    const feed = await ownerRequest(t.broker.port, t.key, "/web/feed");
    assert.equal((feed.body as { stop: { state: string; stoppedBy: string } }).stop.state, "stopped");
    assert.equal((feed.body as { stop: { stoppedBy: string } }).stop.stoppedBy, "you");
    const blocked = await t.call("m9r_web_read", { token: identity.token, selector: "h1" });
    assert.equal(blocked.isError, true);
    assert.match(blocked.content[0].text, /stopped by the owner/);
  } finally {
    await t.done();
  }
});

test("through the whole stack, a second agent is refused on a tab the first one is using", async () => {
  const t = await setup({ allowAnyExtension: true });
  const claude = t.store.issueIdentity("claude", "claude-code", "s1");
  const codex = t.store.issueIdentity("codex", "codex", "s2");
  const { received } = await t.connectExtension();

  void t.call("m9r_web_click", { token: claude.token, selector: "#a", tab: "shared" });
  await until(() => received.length === 1);
  const refused = await t.call("m9r_web_type", { token: codex.token, selector: "#b", text: "hi", tab: "shared" });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /in use by @claude/);
  assert.equal(received.length, 1, "the refused command never reached the browser");
  await t.done();
});

test("the MCP surface permits concurrent field claims and rejects a duplicate field", async () => {
  const t = await setup({ allowAnyExtension: true });
  const claude = t.store.issueIdentity("claude", "claude-code", "field-1");
  const codex = t.store.issueIdentity("codex", "codex", "field-2");
  const gemini = t.store.issueIdentity("gemini", "gemini", "field-3");
  const { ws, received } = await t.connectExtension();
  const first = t.call("m9r_web_type", { token: claude.token, selector: "#email", text: "a", tab: "shared" });
  const second = t.call("m9r_web_type", { token: codex.token, selector: "#name", text: "b", tab: "shared" });
  await until(() => received.length === 2);
  assert.equal((received[0].presence as Record<string, unknown>).claimScope !== undefined, true);
  assert.equal((received[1].presence as Record<string, unknown>).claimScope !== undefined, true);
  const collision = await t.call("m9r_web_type", { token: gemini.token, selector: "#email", text: "c", tab: "shared" });
  assert.equal(collision.isError, true);
  ws.send(JSON.stringify({ type: "result", id: received[0].id, ok: true, data: { typed: 1 } }));
  ws.send(JSON.stringify({ type: "result", id: received[1].id, ok: true, data: { typed: 1 } }));
  assert.equal((await first).isError, undefined);
  assert.equal((await second).isError, undefined);
  await t.done();
});

test("risky actions wait for authenticated owner approval and audit requested/approved", async () => {
  const authority = createWebAuthority({ ownerId: "alice" });
  const t = await setup({ allowAnyExtension: true, authority });
  try {
    const issued = t.store.issueIdentity("claude", "claude-code", "risk-1");
    const { ws, received } = await t.connectExtension();
    const pendingAction = t.call("m9r_web_click", {
      token: issued.token, selector: "#action", targetLabel: "Buy now", tab: "shop",
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(received.length, 0, "a risky action is held before extension dispatch");
    assert.equal((await ownerRequest(t.broker.port, "wrong", "/web/actions/pending")).status, 401);
    const pending = await ownerRequest(t.broker.port, t.key, "/web/actions/pending");
    const action = (pending.body as { actions: Array<{ id: string; targetLabel: string }> }).actions[0];
    assert.equal(action.targetLabel, "Buy now");
    assert.ok(!JSON.stringify(pending.body).includes("page contents"));
    assert.equal((await ownerRequest(t.broker.port, t.key, "/web/actions/approve", "POST", { id: action.id }, "https://hostile.example")).status, 403);
    assert.equal((await ownerRequest(t.broker.port, t.key, "/web/actions/approve", "POST", { id: action.id })).status, 200);
    await until(() => received.length === 1);
    ws.send(JSON.stringify({ type: "result", id: received[0].id, ok: true, data: { clicked: true } }));
    const result = await pendingAction;
    assert.equal(result.isError, undefined);
    const audit = await ownerRequest(t.broker.port, t.key, "/web/audit?verify=1");
    const auditBody = audit.body as { entries: Array<{ kind: string }>; verification: { ok: boolean } };
    assert.equal(auditBody.verification.ok, true);
    assert.deepEqual(auditBody.entries.map((entry) => entry.kind).filter((kind) => kind.startsWith("action.")), ["action.requested", "action.approved"]);
    assert.ok(!JSON.stringify(auditBody).includes("Buy now"));
  } finally {
    await t.done();
  }
});

test("risky action denial and timeout are terminal and produce audit entries without dispatch", async () => {
  const authority = createWebAuthority({ ownerId: "alice" });
  const t = await setup({ allowAnyExtension: true, authority, approvalTimeoutMs: 100 });
  try {
    const issued = t.store.issueIdentity("claude", "claude-code", "risk-2");
    const { received } = await t.connectExtension();
    const deniedTask = t.call("m9r_web_click", { token: issued.token, selector: "#delete", targetLabel: "Delete account", tab: "profile" });
    let deniedId: string | undefined;
    for (let attempt = 0; attempt < 20 && !deniedId; attempt++) {
      const denyList = await ownerRequest(t.broker.port, t.key, "/web/actions/pending");
      deniedId = (denyList.body as { actions: Array<{ id: string }> }).actions[0]?.id;
      if (!deniedId) await new Promise((resolve) => setTimeout(resolve, 3));
    }
    assert.ok(deniedId);
    assert.equal((await ownerRequest(t.broker.port, t.key, "/web/actions/deny", "POST", { id: deniedId })).status, 200);
    assert.equal((await deniedTask).isError, true);
    const timeoutTask = t.call("m9r_web_click", { token: issued.token, selector: "#send", targetLabel: "Send message", tab: "messages" });
    assert.equal((await timeoutTask).isError, true);
    assert.equal(received.length, 0);
    const audit = await ownerRequest(t.broker.port, t.key, "/web/audit?verify=1");
    const auditBody = audit.body as { entries: Array<{ kind: string }>; verification: { ok: boolean } };
    assert.equal(auditBody.verification.ok, true);
    assert.deepEqual(auditBody.entries.map((entry) => entry.kind).filter((kind) => kind.startsWith("action.")), [
      "action.requested", "action.denied", "action.requested", "action.timed_out",
    ]);
  } finally {
    await t.done();
  }
});

test("with no extension connected the tool reports it instead of hanging", async () => {
  const t = await setup();
  const issued = t.store.issueIdentity("claude", "claude-code", "s1");
  const result = await t.call("m9r_web_read", { token: issued.token });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /extension/i);
  await t.done();
});

test("authenticated web status reports whether the extension completed its ready handshake", async () => {
  const t = await setup({ allowAnyExtension: true });
  try {
    const denied = await ownerRequest(t.broker.port, undefined, "/web/status");
    assert.equal(denied.status, 401);
    const before = await ownerRequest(t.broker.port, t.key, "/web/status");
    assert.equal((before.body as { extensionReady: boolean }).extensionReady, false);
    const { ws } = await t.connectExtension();
    const after = await ownerRequest(t.broker.port, t.key, "/web/status");
    assert.equal((after.body as { extensionConnected: boolean }).extensionConnected, true);
    assert.equal((after.body as { extensionReady: boolean }).extensionReady, true);
    ws.close();
  } finally {
    await t.done();
  }
});

test("authenticated owner shutdown closes the loopback broker", async () => {
  const t = await setup({ allowAnyExtension: true });
  try {
    const response = await ownerRequest(t.broker.port, t.key, "/web/shutdown", "POST", {});
    assert.equal(response.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await assert.rejects(fetch(`http://127.0.0.1:${t.broker.port}/health`));
  } finally {
    await t.done();
  }
});

test("a command waits for the extension ready handshake before dispatching", async () => {
  const t = await setup({ allowAnyExtension: true, extensionConnectTimeoutMs: 500 });
  try {
    const issued = t.store.issueIdentity("claude", "claude-code", "startup");
    const pending = t.call("m9r_web_open", { token: issued.token, url: "https://example.com/", tab: "startup-page" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const { ws, received } = await t.connectExtension();
    await until(() => received.length === 1);
    assert.equal(received[0].action, "open");
    assert.equal(received[0].tab, "startup-page");
    ws.send(JSON.stringify({ type: "result", id: received[0].id, ok: true, origin: "https://example.com", url: "https://example.com/" }));
    assert.equal((await pending).isError, undefined);
  } finally {
    await t.done();
  }
});

test("a bad token is refused before anything reaches the broker", async () => {
  const t = await setup();
  await assert.rejects(t.call("m9r_web_read", { token: "not-a-token" }), /invalid or has been revoked/);
  await t.done();
});

test("the command port needs the key and refuses browser-originated requests", async () => {
  const t = await setup();
  const body = { agent: "x", provider: "x", sessionId: "s", action: "read" };
  assert.equal(await post(t.broker.port, { "content-type": "application/json" }, body), 401);
  assert.equal(await post(t.broker.port, { "content-type": "application/json", "x-m9r-key": "wrong" }, body), 401);
  assert.equal(await post(t.broker.port, { "content-type": "application/json", "x-m9r-key": t.key, origin: "https://evil.example" }, body), 403);
  await t.done();
});

test("only a browser extension origin may open the extension socket, and an allow-list narrows it further", async () => {
  const open = await setup({ allowAnyExtension: true });
  await assert.rejects(open.connectExtension("https://evil.example"), /403/);
  await assert.rejects(open.connectExtension(""), /403/);
  await open.connectExtension("chrome-extension://abc");
  await open.done();

  const strict = await setup({ allowedExtensionIds: ["good"] });
  await assert.rejects(strict.connectExtension("chrome-extension://bad"), /403/);
  await strict.connectExtension("chrome-extension://good");
  await strict.done();
});

test("a new extension connection replaces the old one, and commands go to the new one", async () => {
  const t = await setup({ allowAnyExtension: true });
  const issued = t.store.issueIdentity("claude", "claude-code", "s1");
  const first = await t.connectExtension();
  const second = await t.connectExtension();
  await until(() => first.ws.readyState === WebSocket.CLOSED);

  void t.call("m9r_web_read", { token: issued.token });
  await until(() => second.received.length === 1);
  assert.equal(first.received.length, 0);
  await t.done();
});

test("an empty extension allow-list denies connections unless explicit development access is enabled", async () => {
  const secure = await setup();
  try {
    await assert.rejects(secure.connectExtension("chrome-extension://unlisted"), /403/);
  } finally {
    await secure.done();
  }

  const development = await setup({ allowAnyExtension: true });
  await development.connectExtension("chrome-extension://dev-extension");
  await development.done();
});

test("an unlisted extension cannot connect or replace an authorized socket", async () => {
  const t = await setup({ allowedExtensionIds: ["trusted"] });
  const authorized = await t.connectExtension("chrome-extension://trusted");
  await assert.rejects(t.connectExtension("chrome-extension://unlisted"), /403/);
  assert.equal(authorized.ws.readyState, WebSocket.OPEN);
  await t.done();
});

test("owner grant endpoints require the broker key, refuse Origin, and persist decisions", async () => {
  const authority = createWebAuthority({ ownerId: "alice", newId: (() => { let id = 0; return () => `grant-${++id}`; })() });
  const requested = authority.requestGrant({ grantee: { owner: "bob", agent: "codex" }, origin: "https://shop.example/cart", actions: ["read", "click"], reason: "Review the cart" });
  assert.equal(requested.ok, true);
  const t = await setup({ authority });
  try {
    assert.equal((await ownerRequest(t.broker.port, undefined, "/web/pending")).status, 401);
    assert.equal((await ownerRequest(t.broker.port, t.key, "/web/pending", "GET", undefined, "https://evil.example")).status, 403);
    const pending = await ownerRequest(t.broker.port, t.key, "/web/pending");
    assert.equal(pending.status, 200);
    assert.equal((pending.body as { requests: Array<{ id: string }> }).requests[0].id, requested.ok ? requested.request.id : "");

    const approval = await ownerRequest(t.broker.port, t.key, "/web/approve", "POST", { id: requested.ok ? requested.request.id : "", actions: ["read"], ttlMs: 60_000, maxUses: 3 });
    assert.equal(approval.status, 200);
    const stored = t.authorityStore!.load();
    assert.equal(stored.grants.length, 1);
    assert.deepEqual(stored.grants[0].actions, ["read"]);

    const grantId = stored.grants[0].id;
    assert.equal((await ownerRequest(t.broker.port, t.key, "/web/revoke", "POST", { id: grantId })).status, 200);
    assert.ok(t.authorityStore!.load().grants[0].revokedAt);
    const audit = await ownerRequest(t.broker.port, t.key, "/web/audit?verify=1");
    assert.equal((audit.body as { verification: { ok: boolean } }).verification.ok, true);
  } finally {
    await t.done();
  }
});

test("an approved grant prompts the extension for site access and a denial revokes it", async () => {
  const authority = createWebAuthority({ ownerId: "alice", newId: (() => { let id = 0; return () => `permission-${++id}`; })() });
  const requested = authority.requestGrant({ grantee: { owner: "bob", agent: "claude" }, origin: "https://shop.example/cart", actions: ["read"] });
  assert.equal(requested.ok, true);
  const t = await setup({ authority, allowedExtensionIds: ["test-extension"] });
  try {
    const { ws, received } = await t.connectExtension("chrome-extension://test-extension");
    const result = await ownerRequest(t.broker.port, t.key, "/web/approve", "POST", { id: requested.ok ? requested.request.id : "" });
    assert.equal(result.status, 200);
    await until(() => received.length === 1);
    assert.deepEqual(received[0], {
      type: "grant-approved",
      grant: { grantId: "permission-2", origin: "https://shop.example", pathPrefix: "/cart", actions: ["read"] },
    });
    ws.send(JSON.stringify({ type: "permission-result", grantId: "permission-2", origin: "https://shop.example", granted: false }));
    await until(() => Boolean(t.authorityStore!.load().grants[0]?.revokedAt));
  } finally {
    await t.done();
  }
});
