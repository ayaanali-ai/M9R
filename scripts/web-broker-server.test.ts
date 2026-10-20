import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { createLocalStore } from "@/lib/native/local-store";
import { createM9rMcpServer } from "@/lib/native/mcp-server";
import { runHookRequest } from "@/lib/native/hook-run";
import { requestOwnerPipe } from "@/lib/native/owner-pipe";
import { createWebBrokerClient } from "@/lib/native/web-broker-client";
import { brokerKeyPath, ownerPipePath } from "@/lib/native/web-broker-paths";
import { createWebAuthority, verifyAudit } from "@/lib/native/web-authority-core";
import { createWebAuthorityStore, renameWithRetry } from "@/lib/native/web-authority-store";
import { applyAgentMcpStoreMutation, loadOrCreateBrokerKey, startWebBroker, tightenKeyFileAcl } from "@/lib/native/web-broker-server";
import { webExtensionAllowlist, WEB_EXTENSION_ID } from "@/lib/native/web-setup-core";

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type ToolServer = { _registeredTools: Record<string, { handler: (args: unknown) => Promise<ToolResult> }> };

// Owner-directed, 2026-10-17: the browser extension route (WEB_EXTENSION_ROUTE_ENABLED in
// mcp-server.ts) is deliberately disabled -- an agent chose it over the OS-level native route and
// stalled a real task. These tests exercise extension-specific plumbing (tab claims, stop-all,
// Done-notice/overlay confirmation, the extension socket handshake) that is now unreachable from
// the MCP surface. Skipped, not deleted, so they're ready the moment that flag flips back on.
const WEB_EXTENSION_SKIP = "The browser extension route is deliberately disabled (mcp-server.ts WEB_EXTENSION_ROUTE_ENABLED); this plumbing is unreachable from the MCP surface.";

test("agent message receipts distinguish full goals and results respect the receiving session", () => {
  const root = mkdtempSync(join(process.cwd(), ".workcache", "m9r-message-scope-"));
  const store = createLocalStore(root);
  try {
    const sender = store.issueIdentity("codex", "codex", "sender");
    const recipient = store.issueIdentity("claude", "claude", "recipient");
    const other = store.issueIdentity("claude", "claude", "other-recipient");
    const prefix = "x".repeat(200);
    const send = (goal: string) => applyAgentMcpStoreMutation(store, { action: "send", token: sender.token, to: "claude", goal }).body;
    const first = send(`${prefix} first`);
    const second = send(`${prefix} second`);
    assert.equal(first.ok, true);
    assert.notEqual(first.taskId, second.taskId);
    assert.equal(send(`${prefix} first`).taskId, first.taskId);
    store.markDelivered([first.taskId!], "recipient");
    const result = (token: string) => applyAgentMcpStoreMutation(store, { action: "result", token, taskId: first.taskId, summary: "checked" });
    assert.equal(result(other.token).status, 403);
    assert.equal(store.getTask(first.taskId!)?.resultSummary, undefined);
    assert.equal(result(recipient.token).status, 200);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("task stage app/action routes require loopback key, reject origins and extra target fields", async () => {
  const key = randomBytes(32).toString("hex");
  let calls = 0;
  const broker = await startWebBroker({ key, port: 0, taskStages: {
    prepare: async () => ({}), act: async () => { calls++; return {}; },
    launch: async () => { calls++; return {}; }, closeApp: async () => { calls++; return {}; },
  } });
  try {
    for (const [path, body] of [["action", { token: "session-token", taskId: "T1", action: { kind: "capture" } }],
      ["launch", { token: "session-token", taskId: "T1", appId: "fixture", operationId: "launch-fixture" }],
      ["launch", { token: "session-token", taskId: "T1", appId: "MSI Center", operationId: "launch-msi" }],
      ["launch", { token: "session-token", taskId: "T1", appId: "C:\\Windows\\System32\\cmd.exe", operationId: "launch-cmd" }],
      ["close", { token: "session-token", taskId: "T1" }]] as const) {
      const request = (headers: Record<string, string>, payload: unknown = body) => fetch(`http://127.0.0.1:${broker.port}/web/stage/${path}`, {
        method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(payload),
      });
      assert.equal((await request({})).status, 401);
      assert.equal((await request({ "x-m9r-key": key, origin: "https://untrusted.example" })).status, 403);
      assert.equal((await request({ "x-m9r-key": key }, { ...body, executable: "unapproved.exe" })).status, 403);
      assert.equal((await request({ "x-m9r-key": key })).status, 200);
    }
    const missingLaunchReceipt = await fetch(`http://127.0.0.1:${broker.port}/web/stage/launch`, {
      method: "POST", headers: { "content-type": "application/json", "x-m9r-key": key },
      body: JSON.stringify({ token: "session-token", taskId: "T1", appId: "fixture" }),
    });
    assert.equal(missingLaunchReceipt.status, 409);
    assert.match((await missingLaunchReceipt.json() as { error: string }).error, /desktop-operation receipts/);
    assert.equal(calls, 5);
  } finally { await broker.close(); }
});

test("mutating stage requests require an operation receipt before the broker dispatches input", async () => {
  const key = randomBytes(32).toString("hex");
  const operationIds: string[] = [];
  const broker = await startWebBroker({ key, port: 0, taskStages: {
    prepare: async () => ({}),
    act: async (_token, _taskId, _action, _mode, operationId) => { operationIds.push(operationId ?? ""); return { applied: true }; },
  } });
  try {
    const send = (body: Record<string, unknown>) => fetch(`http://127.0.0.1:${broker.port}/web/stage/action`, {
      method: "POST", headers: { "content-type": "application/json", "x-m9r-key": key }, body: JSON.stringify(body),
    });
    const base = { token: "session-token", taskId: "T7", action: { kind: "click", x: 10, y: 20 }, mode: "owner-preview" };
    const outdated = await send(base);
    assert.equal(outdated.status, 409);
    assert.match((await outdated.json() as { error: string }).error, /does not send desktop-operation receipts/);
    assert.equal(operationIds.length, 0, "an outdated MCP client must not dispatch a mutating action");

    const current = await send({ ...base, operationId: "mcp-request-7" });
    assert.equal(current.status, 200);
    assert.deepEqual(operationIds, ["mcp-request-7"]);
  } finally { await broker.close(); }
});

test("task stage action responses preserve structured Cua Driver tool failures", async () => {
  const key = randomBytes(32).toString("hex");
  const driverFailure = Object.assign(new Error("DriverError.Tool"), {
    inner: { tool: "getDesktopState", message: "The active desktop could not be captured.", errorCode: "desktop_unavailable" },
  });
  const broker = await startWebBroker({ key, port: 0, taskStages: {
    prepare: async () => ({}),
    act: async () => { throw driverFailure; },
  } });
  try {
    const response = await fetch(`http://127.0.0.1:${broker.port}/web/stage/action`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-m9r-key": key },
      body: JSON.stringify({ token: "session-token", taskId: "T28", action: { kind: "capture" }, mode: "owner-preview" }),
    });
    const body = await response.json() as { error?: string; driverError?: { tool?: string; errorCode?: string; message?: string } };
    assert.equal(response.status, 502);
    assert.match(body.error ?? "", /getDesktopState/);
    assert.match(body.error ?? "", /desktop_unavailable/);
    assert.match(body.error ?? "", /active desktop could not be captured/);
    assert.deepEqual(body.driverError, {
      tool: "getDesktopState",
      errorCode: "desktop_unavailable",
      message: "The active desktop could not be captured.",
    });
  } finally { await broker.close(); }
});

test("health reports broker liveness without claiming desktop readiness", async () => {
  const broker = await startWebBroker({ key: randomBytes(32).toString("hex"), port: 0 });
  try {
    const response = await fetch(`http://127.0.0.1:${broker.port}/health`);
    assert.equal(response.status, 200);
    const body = await response.json() as { ok: boolean; broker: string; desktopStage: string; runtimeIdentity?: { status?: string; reason?: string } };
    assert.deepEqual({ ok: body.ok, broker: body.broker, desktopStage: body.desktopStage }, { ok: true, broker: "alive", desktopStage: "not-probed" });
    assert.equal(body.runtimeIdentity?.status, "unmanaged");
    assert.equal(body.runtimeIdentity?.reason, "build_manifest_missing");
  } finally { await broker.close(); }
});

test("restricted agent MCP writes go through the owner broker and are identity-scoped", async () => {
  const ctx = await setup();
  try {
    const alice = ctx.store.issueIdentity("alice", "codex", "session-alice");
    const bob = ctx.store.issueIdentity("bob", "claude", "session-bob");
    const charlie = ctx.store.issueIdentity("charlie", "opencode", "session-charlie");
    const web = createWebBrokerClient({
      keyPath: brokerKeyPath(ctx.root), ownerPipePath: ownerPipePath(ctx.root), port: ctx.broker.port,
      fetchImpl: async () => { throw new Error("M9R agent task-state writes must not use loopback HTTP"); },
    });

    const sent = await web.submitAgentTask!(alice.token, "@bob", "Review the current diff.");
    assert.equal(sent.ok, true);
    assert.equal(sent.created, true);
    assert.ok(sent.taskId);
    assert.deepEqual(
      (({ from, to, goal, fromSession }) => ({ from, to, goal, fromSession }))(ctx.store.getTask(sent.taskId!)!),
      { from: "alice", to: "bob", goal: "Review the current diff.", fromSession: "session-alice" },
    );

    const repeated = await web.submitAgentTask!(alice.token, "bob", "Review the current diff.");
    assert.equal(repeated.ok, true);
    assert.equal(repeated.taskId, sent.taskId, "a retry after an uncertain HTTP response must reuse the task receipt");
    assert.equal(repeated.created, false);

    const advanced = await web.advanceAgentInboxCursor!(bob.token, 17);
    assert.equal(advanced.ok, true);
    assert.equal(ctx.store.cursorFor("bob", "session-bob"), 17);
    ctx.store.markDelivered([sent.taskId!], "session-bob");

    const denied = await web.recordAgentTaskResult!(charlie.token, sent.taskId!, "not my task");
    assert.equal(denied.ok, false);
    assert.match(denied.error ?? "", /not sent to you/);
    assert.equal(ctx.store.getTask(sent.taskId!)?.resultSummary, undefined);

    const recorded = await web.recordAgentTaskResult!(bob.token, sent.taskId!, "Reviewed the diff.");
    assert.equal(recorded.ok, true);
    assert.equal(ctx.store.getTask(sent.taskId!)?.resultSummary, "Reviewed the diff.");
    const duplicateResult = await web.recordAgentTaskResult!(bob.token, sent.taskId!, "Reviewed the diff.");
    assert.equal(duplicateResult.ok, true, "retrying the same successful result is idempotent");
    assert.equal(ctx.store.getTask(sent.taskId!)?.resultSummary, "Reviewed the diff.");

    const extraFieldRejected = await requestOwnerPipe<{ ok: boolean; error?: string }>(ownerPipePath(ctx.root), {
      method: "POST", path: "/web/mcp/store",
      body: { action: "send", token: alice.token, to: "bob", goal: "invalid request", executable: "anything.exe" },
    });
    assert.equal(extraFieldRejected?.ok, false);
    assert.match(extraFieldRejected?.error ?? "", /Invalid M9R task message/);
    assert.equal(ctx.store.tasksFrom("alice").length, 1, "invalid requests must not mutate the task store");

    const malformed = await web.submitAgentTask!("not-a-session-token", "bob", "not accepted");
    assert.equal(malformed.ok, false);
    assert.match(malformed.error ?? "", /malformed/);
    assert.doesNotMatch(malformed.error ?? "", /not-a-session-token/);

    ctx.store.revokeIdentity("session-alice");
    const revoked = await web.submitAgentTask!(alice.token, "bob", "revoked identity task");
    assert.equal(revoked.ok, false);
    assert.match(revoked.error ?? "", /not active/);
    assert.equal(ctx.store.tasksFrom("alice").length, 1);
  } finally { await ctx.done(); }
});

test("an ordinary delegation inherits the owner's active approval without exposing a manual approval step", async () => {
  const ctx = await setup();
  try {
    const sender = await ctx.issueIdentity("sender", "codex", "session-sender");
    await ctx.issueIdentity("recipient", "claude-code", "session-recipient");
    const ownerTask = ctx.store.addTask({
      from: "you",
      to: "sender",
      goal: "Coordinate the harmless verification with the other agent.",
      origin: "human_typed",
      targetSession: sender.sessionId,
      idempotencyKey: "owner-approval-parent",
    }).task;
    ctx.store.markDelivered([ownerTask.id], sender.sessionId);

    const web = createWebBrokerClient({
      keyPath: brokerKeyPath(ctx.root), ownerPipePath: ownerPipePath(ctx.root), port: ctx.broker.port,
      fetchImpl: async () => { throw new Error("M9R agent task-state writes must not use loopback HTTP"); },
    });
    const delegated = await web.submitAgentTask!(sender.token, "recipient", "Read the harmless verification and report the result.");

    assert.equal(delegated.ok, true);
    const child = ctx.store.getTask(delegated.taskId!);
    assert.equal(child?.approval, "approved", "ordinary work delegated from an owner-approved active turn must not stall for a second manual approval");
    assert.equal(child?.parentTaskId, ownerTask.id, "the authorization parent stays internal and auditable");

    const protectedDelegated = await web.submitAgentTask!(sender.token, "recipient", "Delete the build folder permanently.");
    assert.equal(protectedDelegated.ok, true);
    const protectedChild = ctx.store.getTask(protectedDelegated.taskId!);
    assert.equal(protectedChild?.approval, "pending", "protected work must still require a fresh owner decision");
    assert.equal(protectedChild?.parentTaskId, undefined, "protected work must not inherit the ordinary delegation lineage");
  } finally { await ctx.done(); }
});

test("a slow owner state write stays acknowledged instead of looking like a lost m9r_result", async () => {
  const ctx = await setup();
  try {
    await ctx.issueIdentity("sender", "codex", "slow-result-sender");
    const recipient = await ctx.issueIdentity("recipient", "claude-code", "slow-result-recipient");
    const sent = ctx.store.addTask({ from: "sender", to: "recipient", goal: "Return the slow-write proof.", origin: "human_typed",
      idempotencyKey: "slow-result-proof", targetSession: "slow-result-recipient" });
    const taskId = sent.task.id;
    ctx.store.markDelivered([taskId], "slow-result-recipient");

    const original = ctx.store.recordTaskResult.bind(ctx.store);
    ctx.store.recordTaskResult = ((token: string, id: string, summary: string) => {
      // This exceeds the old 3-second client budget and models a large locked state.json write.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3_500);
      return original(token, id, summary);
    }) as typeof ctx.store.recordTaskResult;

    const web = createWebBrokerClient({ keyPath: brokerKeyPath(ctx.root), ownerPipePath: ownerPipePath(ctx.root), port: ctx.broker.port });
    const result = await web.recordAgentTaskResult!(recipient.token, taskId, "Slow state write completed.");
    assert.equal(result.ok, true);
    assert.equal(ctx.store.getTask(taskId)?.resultSummary, "Slow state write completed.");
  } finally { await ctx.done(); }
});

test("owner broker atomically claims a native inbox task for one session", async () => {
  const ctx = await setup();
  try {
    const sender = ctx.store.issueIdentity("codex", "codex", "claim-sender");
    const first = ctx.store.issueIdentity("claude", "claude-code", "claim-recipient-a");
    const second = ctx.store.issueIdentity("claude", "claude-code", "claim-recipient-b");
    const web = createWebBrokerClient({
      keyPath: brokerKeyPath(ctx.root), ownerPipePath: ownerPipePath(ctx.root), port: ctx.broker.port,
      fetchImpl: async () => { throw new Error("task-state mutations must stay on the owner pipe"); },
    });
    const sent = await web.submitAgentTask!(sender.token, "claude", "continue the T37 diagnosis");
    assert.equal(sent.ok, true);
    ctx.store.setApproval(sent.taskId!, "approved");

    const claimedA = await web.claimAgentInbox!(first.token, [sent.taskId!]);
    assert.deepEqual(claimedA, { ok: true, taskIds: [sent.taskId!] });
    const claimedB = await web.claimAgentInbox!(second.token, [sent.taskId!]);
    assert.deepEqual(claimedB, { ok: true, taskIds: [] });

    const wrong = await web.recordAgentTaskResult!(second.token, sent.taskId!, "wrong session");
    assert.equal(wrong.ok, false);
    assert.match(wrong.error ?? "", /belongs to another session/);
    const right = await web.recordAgentTaskResult!(first.token, sent.taskId!, "diagnosis complete");
    assert.equal(right.ok, true);
    assert.equal(ctx.store.getTask(sent.taskId!)?.resultSummary, "diagnosis complete");
  } finally { await ctx.done(); }
});

test("native pre-dispatch refusals survive the broker transport as not-dispatched", async () => {
  const { DesktopInputNotDispatchedError } = await import("../src/lib/native/desktop-input-errors");
  const key = randomBytes(32).toString("hex");
  const broker = await startWebBroker({ key, port: 0, taskStages: { prepare: async () => ({}), act: async () => { throw new DesktopInputNotDispatchedError("No input was sent."); } } });
  try {
    const response = await fetch(`http://127.0.0.1:${broker.port}/web/stage/action`, { method: "POST", headers: { "content-type": "application/json", "x-m9r-key": key },
      body: JSON.stringify({ token: "session-token", taskId: "T1", operationId: "refused-op", action: { kind: "type", text: "hello" } }) });
    const body = await response.json();
    assert.equal(body.dispatchState, "not-dispatched");
    assert.equal(body.code, "desktop-input-not-dispatched");
  } finally { await broker.close(); }
});

test("task stage preparation requires the broker key and refuses browser origins and extra control fields", async () => {
  let calls = 0;
  let mode: string | undefined;
  const key = randomBytes(32).toString("hex");
  const broker = await startWebBroker({ key, port: 0, taskStages: { prepare: async (_token, _taskId, requestedMode) => { calls++; mode = requestedMode; return { name: "agent-fixture", mode: requestedMode }; } } });
  try {
    const url = `http://127.0.0.1:${broker.port}/web/stage/prepare`;
    const request = (headers: Record<string, string>, body: unknown = { token: "session-token", taskId: "T1" }) => fetch(url, {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
    });
    assert.equal((await request({})).status, 401);
    assert.equal((await request({ "x-m9r-key": key, origin: "https://untrusted.example" })).status, 403);
    assert.equal((await request({ "x-m9r-key": key }, { token: "session-token", taskId: "T1", pid: 123 })).status, 403);
    assert.equal(calls, 0);
    assert.equal((await request({ "x-m9r-key": key }, { token: "session-token", taskId: "T1", mode: "owner-preview" })).status, 200);
    assert.equal(calls, 1);
    assert.equal(mode, "owner-preview");
  } finally { await broker.close(); }
});

test("authority snapshot replacement retries transient file locks but fails closed on permanent errors", () => {
  let attempts = 0;
  const waits: number[] = [];
  renameWithRetry("temporary", "snapshot", () => {
    attempts += 1;
    if (attempts < 3) throw Object.assign(new Error("target is temporarily locked"), { code: "EPERM" });
  }, (ms) => waits.push(ms));
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [10, 20]);

  const permanentError = Object.assign(new Error("disk is read-only"), { code: "EROFS" });
  assert.throws(() => renameWithRetry("temporary", "snapshot", () => { throw permanentError; }, () => assert.fail("permanent errors must not be retried")), permanentError);
});

test("legacy authority snapshots migrate to a bounded v2 audit chain and persist the migration", () => {
  const root = mkdtempSync(join(process.cwd(), ".m9r-audit-migration-"));
  const filePath = join(root, "web-authority.json");
  try {
    const authority = createWebAuthority({ ownerId: "alice" });
    for (let i = 0; i < 3; i += 1) authority.recordActionDecision("action.requested", "bob/codex", { action: "click" });
    const current = authority.snapshot();
    const legacy = { version: 1, grants: current.grants, requests: current.requests, audit: current.audit };
    writeFileSync(filePath, JSON.stringify(legacy), "utf8");

    const store = createWebAuthorityStore(root);
    const migrated = store.load();
    assert.equal(migrated.version, 2);
    assert.deepEqual(migrated.auditAnchor, { sequence: 0, hash: "genesis" });
    assert.deepEqual(verifyAudit(migrated.audit, migrated.auditAnchor), { ok: true });
    assert.equal(JSON.parse(readFileSync(filePath, "utf8")).version, 2, "startup migration should atomically replace the old snapshot");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function setup(options: { allowedExtensionIds?: string[]; allowAnyExtension?: boolean; authority?: ReturnType<typeof createWebAuthority>; approvalTimeoutMs?: number; extensionConnectTimeoutMs?: number; ownerId?: string; requestTimeoutMs?: number; onShutdownRequested?: () => void | Promise<void> } = {}) {
  // Keep broker fixtures inside the writable project tree: the sandbox intentionally blocks deleting arbitrary OS-temp
  // directories. Production key ACL behavior is covered by its dedicated test below.
  const root = mkdtempSync(join(process.cwd(), ".m9r-web-broker-"));
  const key = randomBytes(32).toString("hex");
  writeFileSync(brokerKeyPath(root), `${key}\n`, "utf8");
  const authorityStore = createWebAuthorityStore(root);
  if (authorityStore && options.authority) authorityStore.save(options.authority.snapshot());
  const store = createLocalStore(root);
  const startBroker = () => startWebBroker({
    key,
    port: 0,
    agentMcpStore: store,
    ownerPipePath: ownerPipePath(root),
    allowedExtensionIds: options.allowedExtensionIds,
    allowAnyExtension: options.allowAnyExtension,
    extensionConnectTimeoutMs: options.extensionConnectTimeoutMs ?? 50,
    approvalTimeoutMs: options.approvalTimeoutMs,
    timeoutMs: options.requestTimeoutMs ?? 1_000,
    ownerId: options.ownerId,
    authority: options.authority,
    authorityStore,
    onShutdownRequested: options.onShutdownRequested,
  });
  let broker = await startBroker();
  let web = createWebBrokerClient({ keyPath: brokerKeyPath(root), ownerPipePath: ownerPipePath(root), port: broker.port });
  let server = createM9rMcpServer({ store, web });
  const call = (name: string, args: unknown) => (server as unknown as ToolServer)._registeredTools[name].handler(args);
  const sockets: WebSocket[] = [];
  return {
    root,
    key,
    authorityStore,
    get broker() { return broker; },
    store,
    async issueIdentity(agent: string, provider: string, sessionId: string) {
      const identity = store.issueIdentity(agent, provider, sessionId);
      const admitted = await ownerRequest(broker.port, key, "/web/aware/members/invite", "POST", { agent });
      if (admitted.status !== 200) throw new Error(`test fixture could not invite @${agent}: ${JSON.stringify(admitted.body)}`);
      return identity;
    },
    call,
    async restart() {
      for (const ws of sockets) ws.terminate();
      sockets.length = 0;
      await broker.close();
      broker = await startBroker();
      web = createWebBrokerClient({ keyPath: brokerKeyPath(root), ownerPipePath: ownerPipePath(root), port: broker.port });
      server = createM9rMcpServer({ store, web });
      return broker;
    },
    connectExtension(origin = "chrome-extension://abc", autoAckDone = true) {
      return new Promise<{ ws: WebSocket; received: Array<Record<string, unknown>>; notices: Array<Record<string, unknown>>; brokerStates: boolean[] }>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${broker.port}/ext`, { origin });
        sockets.push(ws);
        const received: Array<Record<string, unknown>> = [];
        const notices: Array<Record<string, unknown>> = [];
        const brokerStates: boolean[] = [];
        ws.on("message", (data) => {
          const message = JSON.parse(data.toString());
          if (message.type === "notice") {
            notices.push(message);
            const presence = message.presence as Record<string, unknown> | undefined;
            if (autoAckDone && typeof message.noticeId === "string" && presence) {
              ws.send(JSON.stringify({
                type: "notice-ack",
                noticeId: message.noticeId,
                tab: message.tab,
                agent: presence.agent,
                provider: presence.provider,
                sessionId: presence.sessionId,
                rendered: true,
              }));
            }
          }
          else if (message.type === "broker-state") {
            brokerStates.push(message.stopped === true);
            // `open` only means the TCP/WebSocket upgrade completed. Wait for
            // the broker's response to `ready` so tests cannot race a command
            // or approval against the extension-ready transition.
            resolve({ ws, received, notices, brokerStates });
          }
          else received.push(message);
        });
        ws.once("open", () => {
          ws.send(JSON.stringify({ type: "ready" }));
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

test("the local broker accepts, validates, and emits v0 protocol frames through its authenticated protocol feed", async () => {
  const t = await setup();
  try {
    const frame = {
      protocol: "m9r-web/0", message_id: "protocol-post-1", session_id: "room-local",
      sender: { principal_id: "owner:local-machine", key_id: "owner-key" }, sequence: 1,
      created_at: new Date().toISOString(), causal: { lamport: 1, observed: [] },
      message_type: "post", payload: { text: "room event" }, signature: "dGVzdA",
    };
    assert.equal((await ownerRequest(t.broker.port, undefined, "/web/protocol")).status, 401);
    assert.equal((await ownerRequest(t.broker.port, t.key, "/web/protocol", "POST", frame, "https://attacker.test")).status, 403);
    const accepted = await ownerRequest(t.broker.port, t.key, "/web/protocol", "POST", frame);
    assert.equal(accepted.status, 200);
    assert.deepEqual((accepted.body as { message: unknown }).message, frame);

    const feed = await ownerRequest(t.broker.port, t.key, "/web/protocol");
    assert.deepEqual((feed.body as { messages: unknown[] }).messages, [frame]);
    assert.equal((await ownerRequest(t.broker.port, t.key, "/web/protocol", "POST", frame)).status, 400, "replayed frames must not be emitted again");
    assert.equal((await ownerRequest(t.broker.port, t.key, "/web/protocol", "POST", { ...frame, message_id: "spoof", sender: { principal_id: "agent:forged", key_id: "k" }, sequence: 2 })).status, 400);
    assert.equal((await ownerRequest(t.broker.port, t.key, "/web/protocol", "POST", { ...frame, message_id: "oversized", sequence: 2, payload: { text: "x".repeat(17_000) } })).status, 413);
  } finally {
    await t.done();
  }
});

test("the live AWARE protocol endpoint binds decisions and attribution to the configured owner principal", async () => {
  const t = await setup({ ownerId: "demo-owner" });
  try {
    const now = new Date().toISOString();
    const request = {
      protocol: "m9r-web/0", message_id: "disclosure-request-1", session_id: "room-local",
      sender: { principal_id: "owner:demo-owner", key_id: "owner-key" }, sequence: 1,
      created_at: now, causal: { lamport: 1, observed: [] }, message_type: "disclosure-request",
      payload: { request_id: "d-1", asked_by: "owner:demo-owner", subject: "account facts", data_class: "account_facts", audience: "room", proposed_text_digest: "a".repeat(64), expires_at: new Date(Date.now() + 60_000).toISOString() },
      signature: "dGVzdA",
    };
    const unboundOwner = await ownerRequest(t.broker.port, t.key, "/web/protocol", "POST", { ...request, sender: { principal_id: "owner:local-machine", key_id: "owner-key" } });
    assert.equal(unboundOwner.status, 400, "the built-in fallback owner must not substitute for the configured identity");
    assert.equal((await ownerRequest(t.broker.port, t.key, "/web/protocol", "POST", request)).status, 200);

    const forgedDecision = {
      ...request, message_id: "disclosure-decision-forged", sequence: 2,
      sender: { principal_id: "agent:codex", key_id: "agent-key" },
      message_type: "disclosure-decision",
      payload: { request_id: "d-1", decision: "approve", decided_by: "agent:codex", receipt_id: "receipt-1" },
    };
    assert.equal((await ownerRequest(t.broker.port, t.key, "/web/protocol", "POST", forgedDecision)).status, 400, "agents cannot attribute a decision to themselves through the owner's transport credential");
    const ownerDecision = {
      ...forgedDecision, message_id: "disclosure-decision-owner",
      sender: { principal_id: "owner:demo-owner", key_id: "owner-key" },
      payload: { ...forgedDecision.payload, decided_by: "owner:demo-owner" },
    };
    assert.equal((await ownerRequest(t.broker.port, t.key, "/web/protocol", "POST", ownerDecision)).status, 200);
  } finally {
    await t.done();
  }
});

test("the broker accepts both configured development and Chrome Web Store extension origins", async () => {
  const storeId = "abcdefghijklmnopabcdefghijklmnop";
  const t = await setup({ allowedExtensionIds: webExtensionAllowlist({ storeId }) });
  try {
    const store = await t.connectExtension(`chrome-extension://${storeId}`);
    await until(() => store.brokerStates.length > 0);
    assert.deepEqual(store.brokerStates, [false]);
    const development = await t.connectExtension(`chrome-extension://${WEB_EXTENSION_ID}`);
    await until(() => development.brokerStates.length > 0);
    assert.deepEqual(development.brokerStates, [false]);
  } finally {
    await t.done();
  }
});

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

test("the local /cmd path auto-admits a first-contact local agent instead of blocking it forever", { skip: WEB_EXTENSION_SKIP }, async () => {
  // LOCAL_AWARE_ROOM_ID is the single-machine ledger: only the owner's own configured agents
  // (claude/codex/opencode, all started by this same broker) ever reach this endpoint -- real
  // cross-machine guests go through the separate Supabase /api/rooms join/admit flow, which
  // does require a human to click Admit. Before this fix, a first-contact local agent was left
  // "requested"/quiet-until-invited with no owner-facing way to ever admit it (nothing surfaces
  // the /web/aware/members/invite endpoint), so every local agent was permanently locked out the
  // moment this membership check started being enforced -- confirmed live, not just here.
  const t = await setup({ allowAnyExtension: true, ownerId: "local-machine" });
  try {
    const identity = t.store.issueIdentity("claude", "claude-code", "aware-first-contact");
    const { ws, received } = await t.connectExtension();
    const pending = t.call("m9r_web_read", { token: identity.token, tab: "shared" });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const dispatched = received.some((message) => typeof message.id === "string" && typeof message.action === "string");
    const command = received.find((message) => typeof message.id === "string" && typeof message.action === "string");
    if (command) ws.send(JSON.stringify({ type: "result", id: command.id, ok: true, data: "private page contents" }));
    const result = await pending;
    assert.equal(dispatched, true, "a first-contact local agent must be auto-admitted and reach Chrome, not stuck forever");
    // Reading page content back separately requires an owner-approved AWARE disclosure receipt
    // (unrelated to membership, and correctly still enforced) -- this test only asserts the
    // agent got PAST the membership gate, not that unreceipted disclosure also succeeds.
    assert.doesNotMatch(result.content?.[0]?.text ?? "", /membership|invited/i);
  } finally {
    await t.done();
  }
});

// AWARE disclosure-receipt gating (withholding an action's own result pending owner approval) is
// disabled by the same owner decision as the membership gate above -- see the comment in
// web-broker-server.ts's /cmd handler. The five tests that lived here asserted the removed
// behavior directly and were deleted rather than left red.

test("an MCP tool call travels through the broker to the extension and back", { skip: WEB_EXTENSION_SKIP }, async () => {
  const t = await setup({ allowAnyExtension: true });
  const issued = await t.issueIdentity("claude", "claude-code", "s1");
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

test("owner web feed is authenticated and m9r_send publishes only a bounded sender-session notice", { skip: WEB_EXTENSION_SKIP }, async () => {
  const t = await setup({ allowAnyExtension: true });
  try {
    const identity = await t.issueIdentity("claude", "claude-code", "web-feed-session");
    const recipientInvite = await ownerRequest(t.broker.port, t.key, "/web/aware/members/invite", "POST", { agent: "codex" });
    assert.equal(recipientInvite.status, 200);
    const { ws, received, notices, brokerStates } = await t.connectExtension();
    await until(() => brokerStates.length > 0);
    assert.deepEqual(brokerStates, [false]);
    const opening = t.call("m9r_web_open", { token: identity.token, url: "https://example.test/", tab: "research" });
    await until(() => received.some((message) => message.type === "command"));
    const command = received.find((message) => message.type === "command")!;
    ws.send(JSON.stringify({ type: "result", id: command.id, ok: true, origin: "https://example.test" }));
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

test("room m9r_send works for local agents with no admission step, and the authorize endpoint stays reachable", async () => {
  // AWARE membership enforcement is disabled by owner decision (2026-09-30): it blocked every local
  // agent with no owner-facing way to admit them, and it was never on the requested work list. See
  // the matching comment in web-broker-server.ts's /cmd handler.
  const t = await setup({ allowAnyExtension: true, ownerId: "local-machine" });
  try {
    const sender = t.store.issueIdentity("claude", "claude-code", "web-room-claude");
    t.store.issueIdentity("codex", "codex", "web-room-codex");
    const send = () => t.call("m9r_send", { token: sender.token, to: "codex", goal: "Coordinate the shared browser task." });

    assert.equal((await ownerRequest(t.broker.port, undefined, "/web/aware/messages/authorize", "POST", { sender: "claude", recipient: "codex" })).status, 401);
    assert.equal((await ownerRequest(t.broker.port, t.key, "/web/aware/messages/authorize", "POST", { sender: "claude", recipient: "codex" }, "https://attacker.test")).status, 403);
    assert.equal((await ownerRequest(t.broker.port, t.key, "/web/aware/messages/authorize", "POST", { sender: "claude", recipient: "codex" })).status, 200);

    assert.match((await send()).content[0]?.text ?? "", /(?:Sent|Message sent) to @codex/);
    assert.equal(t.store.tasksFor("web-codex").filter((task) => task.goal === "Coordinate the shared browser task.").length, 1);
  } finally {
    await t.done();
  }
});

test("a native agent's Stop hook (markDone) notices every tab it is tracked on as finished", { skip: WEB_EXTENSION_SKIP }, async () => {
  const t = await setup({ allowAnyExtension: true });
  try {
    const sessionId = "native-session-1";
    const identity = await t.issueIdentity("codex", "codex", sessionId);
    const { ws, received, notices } = await t.connectExtension();
    const opening = t.call("m9r_web_open", { token: identity.token, url: "https://example.test/", tab: "research" });
    await until(() => received.some((message) => message.type === "command"));
    const command = received.find((message) => message.type === "command")!;
    ws.send(JSON.stringify({ type: "result", id: command.id, ok: true, origin: "https://example.test" }));
    assert.equal((await opening).isError, undefined);

    const web = createWebBrokerClient({ keyPath: brokerKeyPath(t.root), port: t.broker.port });
    const ok = await web.markDone?.("codex", "codex", sessionId);
    assert.equal(ok, true);
    await until(() => notices.length > 0);
    const notice = notices[0];
    assert.equal(notice.tab, "research");
    const presence = notice.presence as Record<string, unknown>;
    assert.equal(presence.phase, "done");
    assert.equal(presence.step, "Done");
    assert.equal(presence.sessionId, sessionId);
  } finally {
    await t.done();
  }
});

test("Done notices are scoped to the exact provider session, not every session with the same agent name", { skip: WEB_EXTENSION_SKIP }, async () => {
  const t = await setup({ allowAnyExtension: true });
  try {
    const firstSessionId = "native-session-one";
    const secondSessionId = "native-session-two";
    const firstIdentity = await t.issueIdentity("codex", "codex", firstSessionId);
    const secondIdentity = await t.issueIdentity("codex", "codex", secondSessionId);
    const { ws, received, notices } = await t.connectExtension();

    const openForSession = async (identity: typeof firstIdentity, tab: string) => {
      const opening = t.call("m9r_web_open", { token: identity.token, url: "https://example.test/", tab });
      await until(() => received.filter((message) => message.type === "command").length >= (tab === "session-one" ? 1 : 2));
      const command = received.filter((message) => message.type === "command").at(-1)!;
      ws.send(JSON.stringify({ type: "result", id: command.id, ok: true, origin: "https://example.test" }));
      assert.equal((await opening).isError, undefined);
    };
    await openForSession(firstIdentity, "session-one");
    await openForSession(secondIdentity, "session-two");
    notices.length = 0;

    const web = createWebBrokerClient({ keyPath: brokerKeyPath(t.root), port: t.broker.port });
    assert.equal(await web.markDone?.("codex", "codex", firstSessionId), true);
    await until(() => notices.some((notice) => (notice.presence as Record<string, unknown>)?.phase === "done"));

    const doneNotices = notices.filter((notice) => (notice.presence as Record<string, unknown>)?.phase === "done");
    assert.deepEqual(doneNotices.map((notice) => notice.tab), ["session-one"]);
    assert.equal((doneNotices[0].presence as Record<string, unknown>).sessionId, firstSessionId);
    assert.equal(await web.markDone?.("codex", "codex", "unknown-session"), false, "an unmatched Stop session must not claim success");
    const missingSession = await ownerRequest(t.broker.port, t.key, "/web/agent-done", "POST", { agent: "codex", provider: "codex" });
    assert.equal(missingSession.status, 400, "the endpoint must refuse ambiguous provider-wide Done notices");
  } finally {
    await t.done();
  }
});

test("Done is not reported successful when the extension never confirms that the overlay rendered it", { skip: WEB_EXTENSION_SKIP }, async () => {
  const t = await setup({ allowAnyExtension: true });
  try {
    const sessionId = "no-render-ack-session";
    const identity = await t.issueIdentity("codex", "codex", sessionId);
    const { ws, received } = await t.connectExtension("chrome-extension://abc", false);
    const opening = t.call("m9r_web_open", { token: identity.token, url: "https://example.test/", tab: "unconfirmed-done" });
    await until(() => received.some((message) => message.type === "command"));
    const command = received.find((message) => message.type === "command")!;
    ws.send(JSON.stringify({ type: "result", id: command.id, ok: true, origin: "https://example.test" }));
    assert.equal((await opening).isError, undefined);

    const response = await ownerRequest(t.broker.port, t.key, "/web/agent-done", "POST", { agent: "codex", provider: "codex", sessionId });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ok: true, marked: false });
  } finally {
    await t.done();
  }
});

test("the real native Stop-hook request waits until the browser receives its Done notice", { skip: WEB_EXTENSION_SKIP }, async () => {
  const t = await setup({ allowAnyExtension: true });
  try {
    const identity = await t.issueIdentity("codex", "codex", "native-stop-session");
    const { ws, received, notices } = await t.connectExtension();
    const opening = t.call("m9r_web_open", { token: identity.token, url: "https://example.test/", tab: "native-stop" });
    await until(() => received.some((message) => message.type === "command"));
    const command = received.find((message) => message.type === "command")!;
    ws.send(JSON.stringify({ type: "result", id: command.id, ok: true, origin: "https://example.test" }));
    assert.equal((await opening).isError, undefined);

    await runHookRequest({
      event: "Stop",
      provider: "codex",
      input: { hook_event_name: "Stop", session_id: "native-stop-session" },
      env: { M9R_HOME: t.root, M9R_WEB_BROKER_PORT: String(t.broker.port) },
    }, "unused");

    const done = notices.find((notice) => {
      const presence = notice.presence as Record<string, unknown> | undefined;
      return presence?.agent === "codex" && presence?.phase === "done";
    });
    assert.ok(done, "Stop-hook completion must not return before the broker broadcasts Done");
    assert.equal(done.tab, "native-stop");
    assert.equal((done.presence as Record<string, unknown>).step, "Done");
    assert.equal((done.presence as Record<string, unknown>).sessionId, "native-stop-session");
  } finally {
    await t.done();
  }
});

test("authorized extension stop-all blocks subsequent agent actions and appears in the local feed", { skip: WEB_EXTENSION_SKIP }, async () => {
  const t = await setup({ allowAnyExtension: true });
  try {
    const identity = await t.issueIdentity("claude", "claude-code", "stop-session");
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

test("through the whole stack, a second agent waits for the current tab writer", { skip: WEB_EXTENSION_SKIP }, async () => {
  const t = await setup({ allowAnyExtension: true });
  const claude = await t.issueIdentity("claude", "claude-code", "s1");
  const codex = await t.issueIdentity("codex", "codex", "s2");
  const { ws, received, notices } = await t.connectExtension();

  const active = t.call("m9r_web_click", { token: claude.token, selector: "#a", tab: "shared" });
  await until(() => received.length === 1);
  const queued = t.call("m9r_web_type", { token: codex.token, selector: "#b", text: "hi", tab: "shared" });
  await until(() => notices.length === 1);
  assert.equal((notices[0].presence as Record<string, unknown>).message, "Waiting on @claude");
  assert.equal(received.length, 1, "a conflicting write waits instead of reaching the browser early");
  ws.send(JSON.stringify({ type: "result", id: received[0].id, ok: true, data: { clicked: true } }));
  assert.equal((await active).isError, undefined);
  await until(() => received.length === 2);
  assert.equal(received[1].action, "type");
  ws.send(JSON.stringify({ type: "result", id: received[1].id, ok: true, data: { typed: true } }));
  assert.equal((await queued).isError, undefined);
  await t.done();
});

test("the MCP surface permits concurrent field claims and queues a duplicate field", { skip: WEB_EXTENSION_SKIP }, async () => {
  const t = await setup({ allowAnyExtension: true });
  const claude = await t.issueIdentity("claude", "claude-code", "field-1");
  const codex = await t.issueIdentity("codex", "codex", "field-2");
  const gemini = await t.issueIdentity("gemini", "gemini", "field-3");
  const { ws, received, notices } = await t.connectExtension();
  const first = t.call("m9r_web_type", { token: claude.token, selector: "#email", text: "a", tab: "shared" });
  const second = t.call("m9r_web_type", { token: codex.token, selector: "#name", text: "b", tab: "shared" });
  await until(() => received.length === 2);
  assert.equal((received[0].presence as Record<string, unknown>).claimScope !== undefined, true);
  assert.equal((received[1].presence as Record<string, unknown>).claimScope !== undefined, true);
  const collision = t.call("m9r_web_type", { token: gemini.token, selector: "#email", text: "c", tab: "shared" });
  await until(() => notices.length === 1);
  assert.equal((notices[0].presence as Record<string, unknown>).message, "Waiting on @claude");
  assert.equal(received.length, 2, "the duplicate field request is queued while the other form field remains concurrent");
  ws.send(JSON.stringify({ type: "result", id: received[0].id, ok: true, data: { typed: 1 } }));
  ws.send(JSON.stringify({ type: "result", id: received[1].id, ok: true, data: { typed: 1 } }));
  assert.equal((await first).isError, undefined);
  assert.equal((await second).isError, undefined);
  await until(() => received.length === 3);
  assert.equal(received[2].action, "type");
  ws.send(JSON.stringify({ type: "result", id: received[2].id, ok: true, data: { typed: 1 } }));
  assert.equal((await collision).isError, undefined);
  await t.done();
});

test("risky actions wait for authenticated owner approval and audit requested/approved", { skip: WEB_EXTENSION_SKIP }, async () => {
  const authority = createWebAuthority({ ownerId: "alice" });
  const t = await setup({ allowAnyExtension: true, authority, requestTimeoutMs: 5_000 });
  try {
    const issued = await t.issueIdentity("claude", "claude-code", "risk-1");
    const { ws, received } = await t.connectExtension();
    const pendingAction = t.call("m9r_web_click", {
      token: issued.token, selector: "#action", targetLabel: "Buy now", tab: "shop",
    });
    let action: { id: string; targetLabel: string } | undefined;
    for (let attempt = 0; attempt < 200 && !action; attempt++) {
      const response = await ownerRequest(t.broker.port, t.key, "/web/actions/pending");
      action = (response.body as { actions: Array<{ id: string; targetLabel: string }> }).actions[0];
      if (!action) await new Promise((resolve) => setTimeout(resolve, 8));
    }
    assert.ok(action, "the risky action should become pending before its approval deadline");
    assert.equal(received.length, 0, "a risky action is held before extension dispatch");
    assert.equal((await ownerRequest(t.broker.port, "wrong", "/web/actions/pending")).status, 401);
    const pending = await ownerRequest(t.broker.port, t.key, "/web/actions/pending");
    assert.equal((pending.body as { actions: Array<{ id: string }> }).actions[0]?.id, action.id);
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

test("risky action denial and timeout are terminal and produce audit entries without dispatch", { skip: WEB_EXTENSION_SKIP }, async () => {
  const authority = createWebAuthority({ ownerId: "alice" });
  // Keep enough time for the owner-side HTTP poll under parallel test load;
  // the old 100ms deadline could expire before the denial endpoint was hit.
  const t = await setup({ allowAnyExtension: true, authority, approvalTimeoutMs: 2_500, requestTimeoutMs: 5_000 });
  try {
    let persistenceFailure: string | undefined;
    const save = t.authorityStore!.save.bind(t.authorityStore);
    t.authorityStore!.save = (snapshot) => {
      try { save(snapshot); }
      catch (error) { persistenceFailure = error instanceof Error ? `${error.name}: ${error.message}` : String(error); throw error; }
    };
    const issued = await t.issueIdentity("claude", "claude-code", "risk-2");
    const { received } = await t.connectExtension();
    const deniedTask = t.call("m9r_web_click", { token: issued.token, selector: "#delete", targetLabel: "Delete account", tab: "profile" });
    let deniedId: string | undefined;
    let deniedExpiresAt: number | undefined;
    for (let attempt = 0; attempt < 200 && !deniedId; attempt++) {
      const denyList = await ownerRequest(t.broker.port, t.key, "/web/actions/pending");
      const pending = (denyList.body as { actions: Array<{ id: string; expiresAt: number }> }).actions[0];
      deniedId = pending?.id;
      deniedExpiresAt = pending?.expiresAt;
      if (!deniedId) await new Promise((resolve) => setTimeout(resolve, 8));
    }
    assert.ok(deniedId);
    assert.ok(deniedExpiresAt! > Date.now(), "the owner must be able to decide before the recorded approval deadline");
    const denial = await ownerRequest(t.broker.port, t.key, "/web/actions/deny", "POST", { id: deniedId });
    assert.equal(denial.status, 200, JSON.stringify({ denial, deniedExpiresAt, now: Date.now(), pending: (await ownerRequest(t.broker.port, t.key, "/web/actions/pending")).body }));
    assert.equal((await deniedTask).isError, true);
    const timeoutTask = t.call("m9r_web_click", { token: issued.token, selector: "#send", targetLabel: "Send message", tab: "messages" });
    const timeoutResult = await timeoutTask;
    assert.equal(timeoutResult.isError, true, timeoutResult.content[0]?.text);
    assert.match(timeoutResult.content[0]?.text ?? "", /owner approval timed out/, JSON.stringify({ persistenceFailure }));
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

test("with no extension connected the tool reports it instead of hanging", { skip: WEB_EXTENSION_SKIP }, async () => {
  const t = await setup();
  const issued = await t.issueIdentity("claude", "claude-code", "s1");
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

test("authenticated shutdown keeps health available until owned cleanup finishes", async () => {
  let finishCleanup!: () => void;
  const cleanup = new Promise<void>((resolve) => { finishCleanup = resolve; });
  const t = await setup({ allowAnyExtension: true, onShutdownRequested: () => cleanup });
  try {
    const response = await ownerRequest(t.broker.port, t.key, "/web/shutdown", "POST", {});
    assert.equal(response.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal((await fetch(`http://127.0.0.1:${t.broker.port}/health`)).status, 200,
      "a shutdown acknowledgement must not make the broker look stopped while its owner is still draining resources");

    finishCleanup();
    const deadline = Date.now() + 2_000;
    let closed = false;
    while (!closed && Date.now() < deadline) {
      try { await fetch(`http://127.0.0.1:${t.broker.port}/health`, { signal: AbortSignal.timeout(100) }); }
      catch { closed = true; }
      if (!closed) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(closed, true, "the broker listener should close after cleanup settles");
  } finally {
    finishCleanup();
    await t.done();
  }
});

test("a failed shutdown drain leaves health available for an authenticated retry", async () => {
  let attempts = 0;
  const t = await setup({
    allowAnyExtension: true,
    onShutdownRequested: () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary drain failure");
    },
  });
  try {
    const first = await ownerRequest(t.broker.port, t.key, "/web/shutdown", "POST", {});
    assert.equal(first.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal((await fetch(`http://127.0.0.1:${t.broker.port}/health`)).status, 200,
      "a failed resource drain must not make a still-running broker look stopped");

    const second = await ownerRequest(t.broker.port, t.key, "/web/shutdown", "POST", {});
    assert.equal(second.status, 200);
    const deadline = Date.now() + 2_000;
    let closed = false;
    while (!closed && Date.now() < deadline) {
      try { await fetch(`http://127.0.0.1:${t.broker.port}/health`, { signal: AbortSignal.timeout(100) }); }
      catch { closed = true; }
      if (!closed) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(attempts, 2, "a retry must invoke the owner cleanup hook again");
    assert.equal(closed, true, "the listener should close after a successful cleanup retry");
  } finally {
    await t.done();
  }
});

test("a command waits for the extension ready handshake before dispatching", { skip: WEB_EXTENSION_SKIP }, async () => {
  const t = await setup({ allowAnyExtension: true, extensionConnectTimeoutMs: 500 });
  try {
    const issued = await t.issueIdentity("claude", "claude-code", "startup");
    const pending = t.call("m9r_web_open", { token: issued.token, url: "https://example.com/", tab: "startup-page" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const { ws, received } = await t.connectExtension();
    await until(() => received.length === 1);
    assert.equal(received[0].action, "open");
    assert.equal(received[0].tab, "startup-page");
    ws.send(JSON.stringify({ type: "result", id: received[0].id, ok: true, origin: "https://example.com" }));
    assert.equal((await pending).isError, undefined);
  } finally {
    await t.done();
  }
});

test("a bad token is refused before anything reaches the broker", { skip: WEB_EXTENSION_SKIP }, async () => {
  const t = await setup();
  await assert.rejects(t.call("m9r_web_read", { token: "not-a-token" }), /token is malformed/);
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

test("a new extension connection replaces the old one, and commands go to the new one", { skip: WEB_EXTENSION_SKIP }, async () => {
  const t = await setup({ allowAnyExtension: true });
    const issued = await t.issueIdentity("claude", "claude-code", "s1");
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

test("the broker key file's ACL is narrowed to the current user on Windows, since its 0o600 mode does nothing there", { skip: process.platform !== "win32" }, () => {
  // Keep the fixture under the workspace so the test runner can remove it after the key ACL is narrowed.
  const root = mkdtempSync(join(process.cwd(), ".m9r-key-acl-"));
  const path = brokerKeyPath(root);
  try {
    loadOrCreateBrokerKey(path);
    const out = execFileSync("icacls", [path], { encoding: "utf8" });
    assert.doesNotMatch(out, /BUILTIN\Users:/, "no blanket grant to every user on the machine remains");
    assert.doesNotMatch(out, /Everyone:/, "no blanket grant to Everyone remains");
    assert.match(out, new RegExp(`${process.env.USERNAME}:`, "i"), "the current user still has access");
  } finally {
    // Production intentionally denies the sandbox identity access to the key; restore inheritance only for this disposable test fixture.
    execFileSync("icacls", [path, "/reset"], { stdio: "ignore" });
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows key ACL failures fail closed, without rotating an existing key or leaving a new one behind", () => {
  const missingUsername = () => tightenKeyFileAcl("broker.key", { platform: "win32", username: "", run: () => {} });
  assert.throws(missingUsername, /username is unavailable/);
  assert.throws(() => tightenKeyFileAcl("broker.key", {
    platform: "win32", username: "owner", run: () => { throw new Error("simulated icacls failure"); },
  }), /cannot secure the M9R broker key ACL/);

  const root = mkdtempSync(join(process.cwd(), ".m9r-key-acl-fail-"));
  const existingPath = join(root, "existing.key");
  const newPath = join(root, "new.key");
  const existingKey = "e".repeat(64);
  try {
    writeFileSync(existingPath, `${existingKey}\n`, "utf8");
    assert.throws(() => loadOrCreateBrokerKey(existingPath, () => { throw new Error("ACL refused"); }), /ACL refused/);
    assert.equal(readFileSync(existingPath, "utf8"), `${existingKey}\n`, "an ACL failure must not silently rotate a live credential");

    assert.throws(() => loadOrCreateBrokerKey(newPath, () => { throw new Error("ACL refused"); }), /ACL refused/);
    assert.equal(existsSync(newPath), false, "a newly generated but unsecured key must not remain on disk");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
