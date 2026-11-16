import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { createLocalStore } from "@/lib/native/local-store";
import { createM9rMcpServer } from "@/lib/native/mcp-server";
import { runHookRequest } from "@/lib/native/hook-run";
import { requestOwnerPipe } from "@/lib/native/owner-pipe";
import { createWebBrokerClient } from "@/lib/native/web-broker-client";
import { brokerKeyPath, ownerPipePath } from "@/lib/native/web-broker-paths";
import { createWebAuthority, verifyAudit } from "@/lib/native/web-authority-core";
import { createWebAuthorityStore, renameWithRetry } from "@/lib/native/web-authority-store";
import { applyAgentMcpStoreMutation, loadOrCreateBrokerKey, startWebBroker, tightenKeyFileAcl } from "@/lib/native/web-broker-server";
import { createTestFixtureRoot, removeTestFixtureRoot } from "./test-fixture-temp.ts";

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type ToolServer = { _registeredTools: Record<string, { handler: (args: unknown) => Promise<ToolResult> }> };

test("agent message receipts distinguish full goals and results respect the receiving session", () => {
  const root = createTestFixtureRoot("m9r-message-scope-");
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
  } finally { removeTestFixtureRoot(root); }
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
      ["launch", { token: "session-token", taskId: "T1", appId: "MSI Center", operationId: "launch-friendly" }],
      ["launch", { token: "session-token", taskId: "T1", appId: "C:\\Windows\\System32\\cmd.exe", operationId: "launch-path" }],
      ["close", { token: "session-token", taskId: "T1" }]] as const) {
      const request = (headers: Record<string, string>, payload: unknown = body) => fetch(`http://127.0.0.1:${broker.port}/web/stage/${path}`, {
        method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(payload),
      });
      assert.equal((await request({})).status, 401);
      assert.equal((await request({ "x-m9r-key": key, origin: "https://untrusted.example" })).status, 403);
      assert.equal((await request({ "x-m9r-key": key }, { ...body, executable: "unapproved.exe" })).status, 403);
      assert.equal((await request({ "x-m9r-key": key })).status, 200);
    }
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

    const peer = ctx.store.addTask({ from: "alice", to: "bob", goal: "Check the second file too", origin: "agent_initiated",
      standingRuleApplies: true, targetSession: "session-bob", fromSession: "session-alice", idempotencyKey: "handled-peer-wire",
      replyToTaskId: sent.taskId! }).task;
    const foreign = ctx.store.addTask({ from: "alice", to: "bob", goal: "Other session's request", origin: "agent_initiated",
      standingRuleApplies: true, targetSession: "other-bob", fromSession: "session-alice", idempotencyKey: "foreign-peer-wire",
      replyToTaskId: sent.taskId! }).task;
    const wrongPeer = await web.recordAgentTaskResult!(bob.token, sent.taskId!, "Reviewed the diff.", { status: "completed", remainingWork: [] }, [foreign.id]);
    assert.equal(wrongPeer.ok, false);
    assert.equal(ctx.store.getTask(sent.taskId!)?.resultSummary, undefined, "invalid peer resolution cannot partially complete the main task");
    const recorded = await web.recordAgentTaskResult!(bob.token, sent.taskId!, "Reviewed the diff.", { status: "completed", remainingWork: [] }, [peer.id]);
    assert.equal(recorded.ok, true);
    assert.equal(ctx.store.getTask(sent.taskId!)?.resultSummary, "Reviewed the diff.");
    assert.equal(ctx.store.getTask(peer.id)?.receipt?.state, "completed", "handled peer IDs survive client/owner-pipe transport");
    assert.equal(ctx.store.getTask(foreign.id)?.resultSummary, undefined);
    const duplicateResult = await web.recordAgentTaskResult!(bob.token, sent.taskId!, "Reviewed the diff.", { status: "completed", remainingWork: [] });
    assert.equal(duplicateResult.ok, true, "retrying the same successful result is idempotent");
    assert.equal(ctx.store.getTask(sent.taskId!)?.resultSummary, "Reviewed the diff.");

    const extraFieldRejected = await requestOwnerPipe<{ ok: boolean; error?: string }>(ownerPipePath(ctx.root), {
      method: "POST", path: "/web/mcp/store",
      body: { action: "send", token: alice.token, to: "bob", goal: "invalid request", executable: "anything.exe" },
    });
    assert.equal(extraFieldRejected?.ok, false);
    assert.match(extraFieldRejected?.error ?? "", /Invalid M9R task message/);
    assert.equal(ctx.store.tasksFrom("alice").length, 3, "invalid requests must not add to the original task and two peer messages");

    const malformed = await web.submitAgentTask!("not-a-session-token", "bob", "not accepted");
    assert.equal(malformed.ok, false);
    assert.match(malformed.error ?? "", /malformed/);
    assert.doesNotMatch(malformed.error ?? "", /not-a-session-token/);

    ctx.store.revokeIdentity("session-alice");
    const revoked = await web.submitAgentTask!(alice.token, "bob", "revoked identity task");
    assert.equal(revoked.ok, false);
    assert.match(revoked.error ?? "", /not active/);
    assert.equal(ctx.store.tasksFrom("alice").length, 3);
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
    const right = await web.recordAgentTaskResult!(first.token, sent.taskId!, "diagnosis complete", { status: "completed", remainingWork: [] });
    assert.equal(right.ok, true);
    assert.equal(ctx.store.getTask(sent.taskId!)?.resultSummary, "diagnosis complete");
  } finally { await ctx.done(); }
});

test("owner broker acknowledges only teammate results for the exact sending session", async () => {
  const ctx = await setup();
  try {
    const sender = ctx.store.issueIdentity("alice", "codex", "result-sender-session");
    const otherSession = ctx.store.issueIdentity("alice", "codex", "other-sender-session");
    const recipient = ctx.store.issueIdentity("bob", "claude", "result-recipient-session");
    const web = createWebBrokerClient({
      keyPath: brokerKeyPath(ctx.root), ownerPipePath: ownerPipePath(ctx.root), port: ctx.broker.port,
      fetchImpl: async () => { throw new Error("task-state mutations must stay on the owner pipe"); },
    });
    const task = ctx.store.addTask({ from: "alice", to: "bob", goal: "Return the result.", origin: "agent_initiated",
      fromSession: "result-sender-session", targetSession: "result-recipient-session", standingRuleApplies: true,
      idempotencyKey: "result-shown-session-fence" }).task;
    ctx.store.markDelivered([task.id], "result-recipient-session");
    assert.equal((await web.recordAgentTaskResult!(recipient.token, task.id, "verified answer")).ok, true);

    const denied = await web.markAgentResultsShown!(otherSession.token, [task.id]);
    assert.equal(denied.ok, false);
    assert.equal(ctx.store.getTask(task.id)?.resultShownAt, undefined);
    const acknowledged = await web.markAgentResultsShown!(sender.token, [task.id]);
    assert.deepEqual(acknowledged, { ok: true, taskIds: [task.id] });
    assert.ok(ctx.store.getTask(task.id)?.resultShownAt);
  } finally { await ctx.done(); }
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
  const root = createTestFixtureRoot("m9r-audit-migration-");
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
    removeTestFixtureRoot(root);
  }
});

async function setup(options: { authority?: ReturnType<typeof createWebAuthority>; approvalTimeoutMs?: number; ownerId?: string; requestTimeoutMs?: number; onShutdownRequested?: () => void | Promise<void> } = {}) {
  // Broker fixtures live in a managed OS-temp root, never in the repository.
  // The helper also sweeps only its own marked roots after an interrupted run.
  const root = createTestFixtureRoot();
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
  const call = async (name: string, args: unknown): Promise<ToolResult> =>
    (server as unknown as ToolServer)._registeredTools[name].handler(args);
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
      await broker.close();
      broker = await startBroker();
      web = createWebBrokerClient({ keyPath: brokerKeyPath(root), ownerPipePath: ownerPipePath(root), port: broker.port });
      server = createM9rMcpServer({ store, web });
      return broker;
    },
    async done() {
      await broker.close();
      removeTestFixtureRoot(root);
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

test("retired /cmd and /batch routes identify the native desktop replacement immediately", async () => {
  const t = await setup({ ownerId: "local-machine" });
  try {
    const headers = { "x-m9r-key": t.key, "content-type": "application/json" };
    for (const path of ["/cmd", "/batch"]) {
      const started = Date.now();
      const response = await fetch(`http://127.0.0.1:${t.broker.port}${path}`, {
        method: "POST", headers, body: JSON.stringify({ agent: "claude", provider: "claude-code", sessionId: "retired-route", action: "snapshot" }),
      });
      const body = await response.json() as { ok?: boolean; error?: string };
      assert.equal(response.status, 410);
      assert.equal(body.ok, false);
      assert.match(body.error ?? "", /retired; use m9r_stage_action instead/i);
      assert.ok(Date.now() - started < 500, `${path} must not wait for a browser connection`);
    }
  } finally {
    await t.done();
  }
});

test("room m9r_send works for local agents with no admission step, and the authorize endpoint stays reachable", async () => {
  // AWARE membership enforcement is disabled by owner decision (2026-09-30): it blocked every local
  // agent with no owner-facing way to admit them, and it was never on the requested work list.
  const t = await setup({ ownerId: "local-machine" });
  try {
    const sender = t.store.issueIdentity("claude", "claude-code", "web-room-claude");
    t.store.issueIdentity("codex", "codex", "web-room-codex");
    const send = () => t.call("m9r_send", { token: sender.token, to: "codex", goal: "Coordinate the shared browser task." });

    assert.equal((await ownerRequest(t.broker.port, undefined, "/web/aware/messages/authorize", "POST", { sender: "claude", recipient: "codex" })).status, 401);
    assert.equal((await ownerRequest(t.broker.port, t.key, "/web/aware/messages/authorize", "POST", { sender: "claude", recipient: "codex" }, "https://attacker.test")).status, 403);
    assert.equal((await ownerRequest(t.broker.port, t.key, "/web/aware/messages/authorize", "POST", { sender: "claude", recipient: "codex" })).status, 200);

    assert.match((await send()).content[0]?.text ?? "", /Sent to @codex/);
    assert.equal(t.store.tasksFor("web-codex").filter((task) => task.goal === "Coordinate the shared browser task.").length, 1);
  } finally {
    await t.done();
  }
});

test("native owner brokers report the native route as ready without an extension handshake", async () => {
  const key = randomBytes(32).toString("hex");
  const broker = await startWebBroker({ key, port: 0, nativeDesktopRoute: true });
  try {
    const response = await ownerRequest(broker.port, key, "/web/status");
    assert.equal(response.status, 200);
    const status = response.body as Record<string, unknown>;
    assert.deepEqual(status, {
      ok: true,
      broker: "ready",
      browserTransport: "native-desktop",
      browserReady: true,
    });
    assert.equal("extensionConnected" in status, false);
    assert.equal("extensionReady" in status, false);
  } finally {
    await broker.close();
  }
});

test("authenticated owner shutdown closes the loopback broker", async () => {
  const t = await setup();
  try {
    const response = await ownerRequest(t.broker.port, t.key, "/web/shutdown", "POST", {});
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ok: true, stopping: true, stopped: false });
    await new Promise((resolve) => setTimeout(resolve, 25));
    await assert.rejects(fetch(`http://127.0.0.1:${t.broker.port}/health`));
  } finally {
    await t.done();
  }
});

test("authenticated shutdown keeps health available until owned cleanup finishes", async () => {
  let finishCleanup!: () => void;
  const cleanup = new Promise<void>((resolve) => { finishCleanup = resolve; });
  const t = await setup({ onShutdownRequested: () => cleanup });
  try {
    const response = await ownerRequest(t.broker.port, t.key, "/web/shutdown", "POST", {});
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ok: true, stopping: true, stopped: false });
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
    onShutdownRequested: () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary drain failure");
    },
  });
  try {
    const first = await ownerRequest(t.broker.port, t.key, "/web/shutdown", "POST", {});
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { ok: true, stopping: true, stopped: false });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal((await fetch(`http://127.0.0.1:${t.broker.port}/health`)).status, 200,
      "a failed resource drain must not make a still-running broker look stopped");

    const second = await ownerRequest(t.broker.port, t.key, "/web/shutdown", "POST", {});
    assert.equal(second.status, 200);
    assert.deepEqual(second.body, { ok: true, stopping: true, stopped: false });
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

test("the broker key file's ACL is narrowed to the current user on Windows, since its 0o600 mode does nothing there", { skip: process.platform !== "win32" }, () => {
  const root = createTestFixtureRoot("m9r-key-acl-");
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
    removeTestFixtureRoot(root);
  }
});

test("Windows key ACL failures fail closed, without rotating an existing key or leaving a new one behind", () => {
  const missingUsername = () => tightenKeyFileAcl("broker.key", { platform: "win32", username: "", run: () => {} });
  assert.throws(missingUsername, /username is unavailable/);
  assert.throws(() => tightenKeyFileAcl("broker.key", {
    platform: "win32", username: "owner", run: () => { throw new Error("simulated icacls failure"); },
  }), /cannot secure the M9R broker key ACL/);

  const root = createTestFixtureRoot("m9r-key-acl-fail-");
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
    removeTestFixtureRoot(root);
  }
});
