import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalStore } from "@/lib/native/local-store";
import { issueIdentity, verifyToken, newToken } from "@/lib/native/identity-core";
import { createM9rMcpServer } from "@/lib/native/mcp-server";
import { readM9rMcpConnectionConfig } from "@/lib/native/mcp-connection-env";

function tempStore() {
  const root = mkdtempSync(join(tmpdir(), "m9r-identity-"));
  return { store: createLocalStore(root), done: () => rmSync(root, { recursive: true, force: true }) };
}

test("newToken makes distinct, sufficiently long tokens", () => {
  const a = newToken();
  const b = newToken();
  assert.notEqual(a, b);
  assert.equal(a.length, 32);
});

test("issueIdentity/verifyToken: a fresh token verifies, a wrong or revoked one does not", () => {
  const now = "2026-01-01T00:00:00.000Z";
  const issued = issueIdentity("claude", "claude-code", "s1", now);
  const ok = verifyToken([issued], issued.token);
  assert.deepEqual(ok, { handle: "claude", provider: "claude-code", sessionId: "s1" });

  assert.equal(verifyToken([issued], "not-a-real-token"), null);

  const revoked = { ...issued, revokedAt: now };
  assert.equal(verifyToken([revoked], issued.token), null);
});

test("verifyToken rejects a token presented with the wrong claimed session id", () => {
  const issued = issueIdentity("codex", "codex", "s1", "2026-01-01T00:00:00.000Z");
  assert.equal(verifyToken([issued], issued.token, "s2"), null);
  assert.notEqual(verifyToken([issued], issued.token, "s1"), null);
});

test("sessionsWithIdentity drops an un-revoked identity once its session has gone quiet, so delivery stops guessing among ghosts", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-identity-"));
  let clock = new Date("2026-01-01T00:00:00.000Z");
  const store = createLocalStore(root, { now: () => clock });
  store.registerEndpoint({ provider: "codex", sessionId: "s1", cwd: "C:/repo" });
  store.issueIdentity("codex", "codex", "s1");
  assert.deepEqual(store.sessionsWithIdentity("codex").map((s) => s.sessionId), ["s1"],
    "a session just seen, with a live token, is a routing candidate");

  // A process that dies abruptly never revokes its token (only a clean shutdown does), so the
  // only thing that can retire it from routing is its session having gone quiet for a while.
  clock = new Date(clock.getTime() + 3 * 60 * 60_000);
  assert.deepEqual(store.sessionsWithIdentity("codex"), [],
    "a token nobody revoked but whose session has been silent for hours is no longer a routing candidate");
  rmSync(root, { recursive: true, force: true });
});

test("store.issueIdentity revokes any earlier live token for the same session before issuing a new one", () => {
  const { store, done } = tempStore();
  const first = store.issueIdentity("claude", "claude-code", "s1");
  const second = store.issueIdentity("claude", "claude-code", "s1");
  assert.notEqual(first.token, second.token);
  assert.equal(store.verifyIdentity(first.token), null, "the old token for this session must no longer verify");
  assert.notEqual(store.verifyIdentity(second.token), null);
  done();
});

test("store.revokeIdentity invalidates the live token for a session", () => {
  const { store, done } = tempStore();
  const issued = store.issueIdentity("codex", "codex", "s1");
  assert.notEqual(store.verifyIdentity(issued.token), null);
  store.revokeIdentity("s1");
  assert.equal(store.verifyIdentity(issued.token), null);
  done();
});

type ToolServer = { _registeredTools: Record<string, { handler: (args: unknown, extra?: unknown) => Promise<{ content: Array<{ type: string; text: string }> }> }> };

async function callTool(server: ReturnType<typeof createM9rMcpServer>, name: string, args: unknown = {}, extra?: unknown) {
  const tool = (server as unknown as ToolServer)._registeredTools[name];
  assert.ok(tool, `tool ${name} was not registered`);
  return tool.handler(args, extra);
}

test("m9r_whoami refuses an invalid token and answers with the verified identity for a valid one, from one shared server", async () => {
  const { store, done } = tempStore();
  const issued = store.issueIdentity("claude", "claude-code", "s1");
  const server = createM9rMcpServer({ store });

  const ok = await callTool(server, "m9r_whoami", { token: issued.token });
  assert.match(ok.content[0].text, /@claude/);

  await assert.rejects(() => callTool(server, "m9r_whoami", { token: "garbage" }), /could not verify this agent connection/);
  const unknownToken = newToken();
  await assert.rejects(() => callTool(server, "m9r_whoami", { token: unknownToken }), (error: unknown) => {
    assert.match(String(error), /could not verify this agent connection/);
    assert.doesNotMatch(String(error), /session token|M9R_HOME|synchronize/i);
    assert.ok(!String(error).includes(unknownToken), "the rejected token must not be echoed");
    return true;
  });
  done();
});

test("owner-managed MCP sessions authenticate from M9R's exact session identity and ignore stale credentials", async () => {
  const { store, done } = tempStore();
  const issued = store.issueIdentity("claude", "claude-code", "m9r-owner-claude-test");
  const stale = newToken();
  let dispatchedToken: string | undefined;
  const server = createM9rMcpServer({
    store,
    connectionProvider: "claude-code",
    connectionSessionId: issued.sessionId,
    web: {
      prepareTaskStage: async (token) => {
        dispatchedToken = token;
        return { ok: true, stage: { name: "auth-smoke" } };
      },
    },
  });

  const whoami = await callTool(server, "m9r_whoami");
  assert.match(whoami.content[0]!.text, /You are @claude \(claude-code\)/,
    "the owner-managed M9R session needs no model-visible token argument");
  const registered = (server as unknown as { _registeredTools: Record<string, { inputSchema?: { shape?: Record<string, unknown> } }> })
    ._registeredTools["m9r_whoami"];
  assert.ok(registered?.inputSchema?.shape);
  assert.equal(registered.inputSchema.shape.token, undefined,
    "the managed MCP tool schema must not ask the provider for a credential");

  await callTool(server, "m9r_stage_prepare", { token: stale, taskId: "T1", mode: "owner-preview" });
  assert.equal(dispatchedToken, issued.token,
    "a stale optional argument must not override the active credential for the authenticated identity");
  assert.ok(!whoami.content[0]!.text.includes(issued.token));
  done();
});

test("M9R restores a missing managed-session credential internally without a token field", async () => {
  const { store, done } = tempStore();
  const sessionId = "m9r-managed-session-after-store-recovery";
  const server = createM9rMcpServer({ store, connectionProvider: "claude-code", connectionSessionId: sessionId });
  const whoamiTool = (server as unknown as { _registeredTools: Record<string, { inputSchema?: { shape?: Record<string, unknown> } }> })
    ._registeredTools["m9r_whoami"];
  assert.equal(whoamiTool?.inputSchema?.shape?.token, undefined,
    "M9R-owned processes must not expose a credential argument");
  assert.equal(store.identityTokenFor("claude", sessionId), null, "the test begins with the same missing-identity state as an interrupted local store write");

  const whoami = await callTool(server, "m9r_whoami");
  assert.match(whoami.content[0]!.text, /You are @claude \(claude-code\)/);
  assert.ok(store.identityTokenFor("claude", sessionId), "M9R repairs the private credential without asking the agent or user");
  done();
});

test("M9R never restores a managed credential after explicit session revocation", async () => {
  const { store, done } = tempStore();
  const issued = store.issueIdentity("claude", "claude-code", "m9r-managed-session-revoked");
  store.revokeIdentity(issued.sessionId);
  const server = createM9rMcpServer({ store, connectionProvider: "claude-code", connectionSessionId: issued.sessionId });

  await assert.rejects(() => callTool(server, "m9r_whoami"), (error: unknown) => {
    assert.match(String(error), /could not authorize this connected agent/);
    assert.match(String(error), /No action was sent/);
    assert.doesNotMatch(String(error), /token|reconnect|restart|synchroniz/i);
    return true;
  });
  assert.equal(store.identityCredentialForSession("claude-code", issued.sessionId), null,
    "an ended session must not be revived by automatic recovery");
  done();
});

test("M9R provider-process bindings authenticate without exposing a token argument", async () => {
  const { store, done } = tempStore();
  const issued = store.issueIdentity("codex", "codex", "m9r-process-bound-codex");
  assert.ok(store.issueConnectionClaim({
    handle: "codex",
    provider: "codex",
    sessionId: issued.sessionId,
    cwd: "C:/repo",
    ownerProcessId: 4321,
  }));
  assert.equal(store.beginProviderTurn({
    provider: "codex",
    sessionId: issued.sessionId,
    cwd: "C:/repo",
    processId: 4321,
  }), true);

  const server = createM9rMcpServer({
    store,
    connectionProvider: "codex",
    connectionProcessId: 4321,
    connectionCwd: "C:/repo",
    connectionWaitMs: 0,
  });
  const whoami = await callTool(server, "m9r_whoami");
  assert.match(whoami.content[0]!.text, /You are @codex \(codex\)/,
    "a trusted provider-process claim resolves the active session without a token");
  const registered = (server as unknown as { _registeredTools: Record<string, { inputSchema?: { shape?: Record<string, unknown> } }> })
    ._registeredTools["m9r_whoami"];
  assert.equal(registered?.inputSchema?.shape?.token, undefined,
    "automatically bound processes must not advertise the legacy token field");
  done();
});

test("an M9R-owned Codex session takes precedence over the provider's unrelated thread selector", async () => {
  const { store, done } = tempStore();
  const m9rSession = store.issueIdentity("codex", "codex", "m9r-owner-codex-test");
  const providerThread = store.issueIdentity("codex", "codex", "provider-thread-not-m9r-session");
  const server = createM9rMcpServer({
    store,
    connectionProvider: "codex",
    connectionSessionId: m9rSession.sessionId,
  });
  const result = await callTool(server, "m9r_whoami", {}, { _meta: { threadId: providerThread.sessionId } });
  assert.match(result.content[0]!.text, /You are @codex \(codex\)/);
  assert.equal(store.bindConnectionForProcess({ provider: "codex", sessionId: providerThread.sessionId }), null,
    "M9R must not bind its internal session to a different Codex transport thread");
  done();
});

test("production MCP connection config carries M9R's provider session and project scope", () => {
  assert.deepEqual(readM9rMcpConnectionConfig({
    M9R_PROVIDER: "claude-code",
    M9R_SESSION_ID: "m9r-owner-claude-test",
    M9R_PROJECT_ROOT: "C:/repo",
  }, 4321), {
    provider: "claude-code",
    processId: 4321,
    sessionId: "m9r-owner-claude-test",
    cwd: "C:/repo",
  });
});

test("issuing new sessions never silently evicts an active identity", () => {
  const { store, done } = tempStore();
  const first = store.issueIdentity("codex", "codex", "active-0");
  for (let index = 1; index <= 220; index += 1) store.issueIdentity("codex", "codex", `active-${index}`);
  assert.deepEqual(store.verifyIdentity(first.token), {
    handle: "codex", provider: "codex", sessionId: "active-0",
  });
  done();
});

test("desktop stage rejects an invalid legacy credential without exposing internals or dispatching", async () => {
  const { store, done } = tempStore();
  const issued = store.issueIdentity("codex", "codex", "s1");
  let brokerCalls = 0;
  const server = createM9rMcpServer({
    store,
    web: {
      prepareTaskStage: async () => { brokerCalls += 1; return { ok: true, stage: { name: "preview-agent-test" } }; },
    },
  });

  await assert.rejects(
    () => callTool(server, "m9r_stage_prepare", { token: issued.token.slice(1), taskId: "T1", mode: "owner-preview" }),
    (error: unknown) => {
      assert.match(String(error), /could not verify this agent connection/);
      assert.doesNotMatch(String(error), /session token|M9R_HOME|synchronize/i);
      return true;
    },
  );
  assert.equal(brokerCalls, 0, "malformed credentials must be rejected before broker dispatch");

  const accepted = await callTool(server, "m9r_stage_prepare", { token: issued.token, taskId: "T1", mode: "owner-preview" });
  assert.match(accepted.content[0].text, /"ok":true/);
  assert.equal(brokerCalls, 1);
  done();
});

test("m9r_send creates a real inbox task the recipient can see, m9r_result records it and refuses a mismatched owner -- two callers, one shared server", async () => {
  const { store, done } = tempStore();
  const codex = store.issueIdentity("codex", "codex", "s-codex");
  const claude = store.issueIdentity("claude", "claude-code", "s-claude");
  const server = createM9rMcpServer({ store });

  const sent = await callTool(server, "m9r_send", { token: codex.token, to: "claude", goal: "check the build" });
  assert.match(sent.content[0].text, /Sent to @claude as task T1/);
  assert.equal(store.getTask("T1")?.from, "codex");

  await assert.rejects(() => callTool(server, "m9r_result", { token: codex.token, taskId: "T1", summary: "done" }), /not sent to you/);
  const inbox = await callTool(server, "m9r_inbox", { token: claude.token });
  assert.match(inbox.content[0].text, /check the build/);

  const result = await callTool(server, "m9r_result", { token: claude.token, taskId: "T1", summary: "build is green" });
  assert.match(result.content[0].text, /Recorded result for T1/);
  assert.equal(store.getTask("T1")?.resultSummary, "build is green");
  done();
});
