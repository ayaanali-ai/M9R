import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { renderInboxInjection } from "@/lib/native/inbox-core";
import { createLocalStore } from "@/lib/native/local-store";
import { createM9rMcpServer } from "@/lib/native/mcp-server";
import { handleHookEvent } from "@/lib/native/hook-handler";
import type { WebBrokerClient } from "@/lib/native/web-broker-client";

type ToolServer = { _registeredTools: Record<string, { handler: (args: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>; inputSchema: unknown; description?: string }> };

function setup(options: { allowRule?: boolean; web?: WebBrokerClient; roomStartedAt?: number; now?: () => Date } = {}) {
  const root = mkdtempSync(join(tmpdir(), "m9r-inbox-"));
  const store = createLocalStore(root, { now: options.now });
  if (options.allowRule !== false) store.addRule({ from: "claude", to: "codex", ttlMs: 3_600_000 });
  const server = createM9rMcpServer({ store, web: options.web, roomStartedAt: options.roomStartedAt, now: options.now });
  const call = async (name: string, args: unknown) => (await (server as unknown as ToolServer)._registeredTools[name].handler(args)).content[0].text;
  return {
    store,
    server,
    call,
    claude: store.issueIdentity("claude", "claude-code", "c1").token,
    codex: store.issueIdentity("codex", "codex", "x1").token,
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("desktop stage MCP tools default to the current owner desktop", () => {
  const t = setup();
  try {
    const tools = (t.server as unknown as ToolServer)._registeredTools;
    for (const name of ["m9r_stage_prepare", "m9r_stage_action", "m9r_stage_app"]) {
      const shape = (tools[name]?.inputSchema as { shape?: Record<string, { parse(value: unknown): unknown }> } | undefined)?.shape;
      assert.equal(shape?.mode?.parse(undefined), "owner-preview", `${name} must not silently select a background desktop`);
      assert.match(tools[name]?.description ?? "", /owner-preview/);
    }
  } finally { t.done(); }
});

test("public stage-action schema exposes popup capture and native filename editing without enabling popup structure routing", () => {
  const t = setup();
  try {
    const tools = (t.server as unknown as ToolServer)._registeredTools;
    const action = (tools["m9r_stage_action"]?.inputSchema as { shape?: { action?: { parse(value: unknown): unknown } } } | undefined)?.shape?.action;
    assert.ok(action);
    assert.deepEqual(action.parse({ kind: "capture", view: "popup" }), { kind: "capture", view: "popup" });
    assert.deepEqual(action.parse({ kind: "click", view: "popup", x: 45, y: 20 }), { kind: "click", view: "popup", x: 45, y: 20 });
    assert.deepEqual(action.parse({ kind: "type", view: "popup", mode: "replace", x: 70, y: 22, text: "M9R-demo-smoke.txt" }),
      { kind: "type", view: "popup", mode: "replace", x: 70, y: 22, text: "M9R-demo-smoke.txt" });
    assert.deepEqual(action.parse({ kind: "press_key", view: "popup", key: "Enter" }), { kind: "press_key", view: "popup", key: "Enter" });
    assert.throws(() => action.parse({ kind: "read_structure", view: "popup" }));
    assert.match(tools["m9r_stage_action"]?.description ?? "", /view=popup[\s\S]*modal dialog[\s\S]*popup-local coordinates/);
    assert.match(tools["m9r_stage_action"]?.description ?? "", /prefer current tree actions[\s\S]*semantic UIA and WM_CHAR routes run in the background first/);
    assert.match(tools["m9r_stage_action"]?.description ?? "", /approval applies to the same task and target until owner input, mode, task, or session changes/);
    assert.match(tools["m9r_stage_action"]?.description ?? "", /Explicit background mode never falls back to physical input or activates a window/);
  } finally { t.done(); }
});

test("desktop stage input derives a private one-shot receipt ID from the MCP request identity", async () => {
  let receivedOperationId = "";
  const web: WebBrokerClient = {
    taskStageAction: async (_token, _taskId, _action, _mode, operationId) => {
      receivedOperationId = operationId ?? "";
      return { ok: true, result: { operationReceipt: { status: "applied" }, actionExecuted: true } };
    },
  };
  const t = setup({ web });
  try {
    const handler = (t.server as unknown as ToolServer)._registeredTools["m9r_stage_action"]!.handler as (
      args: unknown,
      extra: { requestId: string | number },
    ) => Promise<{ content: Array<{ type: string; text: string }> }>;
    const result = await handler({ token: t.codex, taskId: "T1", action: { kind: "cursor", x: 2, y: 3 } }, { requestId: 17 });
    assert.match(receivedOperationId, /^[a-f0-9]{64}$/);
    assert.match(result.content[0]?.text ?? "", /"status":"applied"/);
    await handler({ token: t.codex, taskId: "T1", operationId: "task1-click1", action: { kind: "cursor", x: 2, y: 3 } }, { requestId: 18 });
    assert.equal(receivedOperationId, "task1-click1", "an explicit operation identity survives a new MCP request");
  } finally { t.done(); }
});

test("an agent naming a task the owner's new message paused acts under the owner's latest task", async () => {
  let receivedTaskId = "";
  const web: WebBrokerClient = {
    taskStageAction: async (_token, taskId) => { receivedTaskId = taskId; return { ok: true, result: { actionExecuted: true } }; },
  };
  const t = setup({ web });
  try {
    const first = t.store.addTask({ from: "you", to: "codex", goal: "Click Send", origin: "human_typed", idempotencyKey: "paused-a" }).task;
    t.store.markDelivered([first.id], "x1");
    t.store.pauseTask(first.id);
    const next = t.store.addTask({ from: "you", to: "codex", goal: "Do the send task now", origin: "human_typed", idempotencyKey: "paused-b" }).task;
    t.store.markDelivered([next.id], "x1");
    const handler = (t.server as unknown as ToolServer)._registeredTools["m9r_stage_action"]!.handler as (
      args: unknown, extra: { requestId: string | number }) => Promise<unknown>;
    await handler({ token: t.codex, taskId: first.id, action: { kind: "cursor", x: 2, y: 3 } }, { requestId: 1 });
    assert.equal(receivedTaskId, next.id, "the stale paused id would be refused with 'this task is paused'");
  } finally { t.done(); }
});

test("a serial provider session reports the newest delivered result when an older turn was abandoned", async () => {
  const t = setup();
  try {
    const first = t.store.addTask({ from: "you", to: "codex", goal: "Old turn", origin: "human_typed", idempotencyKey: "abandoned-turn", targetSession: "x1" }).task;
    t.store.markDelivered([first.id], "x1");
    const latest = t.store.addTask({ from: "you", to: "codex", goal: "Current turn", origin: "human_typed", idempotencyKey: "current-turn", targetSession: "x1" }).task;
    t.store.markDelivered([latest.id], "x1");
    assert.match(await t.call("m9r_result", { token: t.codex, summary: "Current work is complete", completion: { status: "completed", remainingWork: [] } }), /Recorded result/);
    assert.equal(t.store.getTask(latest.id)?.resultSummary, "Current work is complete");
    assert.equal(t.store.getTask(first.id)?.resultSummary, undefined);
  } finally { t.done(); }
});

async function connectMcp(store: ReturnType<typeof createLocalStore>, name: string) {
  const server = createM9rMcpServer({ store });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name, version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

function mcpText(result: unknown): string {
  if (typeof result !== "object" || result === null || !("content" in result) || !Array.isArray(result.content)) return "";
  return result.content.flatMap((item: unknown) => {
    if (typeof item !== "object" || item === null || !("type" in item) || item.type !== "text" || !("text" in item) || typeof item.text !== "string") return [];
    return [item.text];
  }).join("\n");
}

test("each inbox check shows only messages not seen before, then reports empty", async () => {
  const t = setup();
  await t.call("m9r_send", { token: t.claude, to: "codex", goal: "first finding" });
  await t.call("m9r_send", { token: t.claude, to: "codex", goal: "second finding" });

  const first = await t.call("m9r_inbox", { token: t.codex });
  assert.match(first, /first finding/);
  assert.match(first, /second finding/);
  const continued = await t.call("m9r_inbox", { token: t.codex });
  assert.match(continued, /Inbox is empty for new messages/);
  assert.match(continued, /first finding/);
  assert.match(continued, /second finding/);

  await t.call("m9r_send", { token: t.claude, to: "codex", goal: "third finding" });
  const later = await t.call("m9r_inbox", { token: t.codex });
  assert.match(later, /third finding/);
  assert.doesNotMatch(later, /first finding|second finding/);
  t.done();
});

test("waitSeconds returns as soon as a message arrives instead of running out the clock", async () => {
  const t = setup();
  const started = Date.now();
  const waiting = t.call("m9r_inbox", { token: t.codex, waitSeconds: 10 });
  setTimeout(() => void t.call("m9r_send", { token: t.claude, to: "codex", goal: "late finding" }), 300);
  const text = await waiting;
  assert.match(text, /late finding/);
  assert.ok(Date.now() - started < 3_000, "it did not wait the full ten seconds");
  t.done();
});

test("with nothing to deliver, waitSeconds waits about that long and then says the inbox is empty", async () => {
  const t = setup();
  const started = Date.now();
  assert.equal(await t.call("m9r_inbox", { token: t.codex, waitSeconds: 1 }), "Inbox is empty.");
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 900 && elapsed < 3_000, `waited ${elapsed}ms`);
  t.done();
});

test("an explicit inbox check shows a long message in full, while the automatic injection still clips it", async () => {
  const t = setup();
  const long = `dates ${"x".repeat(1_500)} END`;
  await t.call("m9r_send", { token: t.claude, to: "codex", goal: long });

  const explicit = await t.call("m9r_inbox", { token: t.codex });
  assert.ok(explicit.includes("END"), "the whole message reached the agent");

  const automatic = renderInboxInjection(t.store.tasksFor("codex"), 0);
  assert.ok(!automatic.text.includes("END"), "the hook's own injection keeps its short cap");
  t.done();
});

test("one task is claimed by one provider session and another session cannot take or answer it", async () => {
  const t = setup();
  const second = t.store.issueIdentity("codex", "codex", "x2").token;
  await t.call("m9r_send", { token: t.claude, to: "codex", goal: "shared finding" });
  assert.match(await t.call("m9r_inbox", { token: t.codex }), /shared finding/);
  assert.equal(await t.call("m9r_inbox", { token: second }), "Inbox is empty.");
  await assert.rejects(t.call("m9r_result", { token: second, taskId: "T1", summary: "wrong session" }), /belongs to another session/);
  assert.match(await t.call("m9r_result", { token: t.codex, taskId: "T1", summary: "right session", completion: { status: "completed", remainingWork: [] } }), /Recorded result/);
  assert.equal(t.store.getTask("T1")?.resultSummary, "right session");
  t.done();
});

test("native reply wait is scoped to the sent task, rejects another session, and shows its result once", async () => {
  const t = setup();
  try {
    const requested = t.store.addTask({
      from: "codex", to: "claude", goal: "Check the requested value.", origin: "agent_initiated",
      fromSession: "x1", targetSession: "c1", standingRuleApplies: true, idempotencyKey: "native-exact-reply-wait",
    }).task;
    const unrelated = t.store.addTask({
      from: "codex", to: "claude", goal: "Unrelated request.", origin: "agent_initiated",
      fromSession: "x1", targetSession: "c1", standingRuleApplies: true, idempotencyKey: "native-unrelated-reply-wait",
    }).task;
    t.store.markDelivered([requested.id, unrelated.id], "c1");
    assert.equal(t.store.recordTaskResult(t.claude, unrelated.id, "unrelated result", {
      status: "completed", remainingWork: [],
    }).ok, true);

    const pending = await t.call("m9r_inbox", { token: t.codex, taskId: requested.id });
    assert.match(pending, new RegExp(`${requested.id} to @claude: received; awaiting the teammate's reply`));
    assert.doesNotMatch(pending, /unrelated result/, "a task-scoped wait must not return another task's answer");

    const otherSession = t.store.issueIdentity("codex", "codex", "x2").token;
    await assert.rejects(t.call("m9r_inbox", { token: otherSession, taskId: requested.id }), /not a teammate message sent by this exact session/);

    assert.equal(t.store.recordTaskResult(t.claude, requested.id, "exact reply", {
      status: "completed", remainingWork: [],
    }).ok, true);
    const answer = await t.call("m9r_inbox", { token: t.codex, taskId: requested.id });
    assert.match(answer, /exact reply/);
    assert.doesNotMatch(answer, /unrelated result/);
    assert.ok(t.store.getTask(requested.id)?.resultShownAt, "the exact result is acknowledged only after retrieval");
    assert.equal(await t.call("m9r_inbox", { token: t.codex, taskId: requested.id }), "Inbox is empty.");
  } finally { t.done(); }
});
test("an agent result queues one reply for the exact requesting session and never loops", async () => {
  const t = setup();
  try {
    const sent = t.store.addTask({
      from: "claude", to: "codex", goal: "Check the requested value.", origin: "agent_initiated",
      fromSession: "c1", standingRuleApplies: true, idempotencyKey: "a2a-result-roundtrip",
    }).task;
    t.store.markDelivered([sent.id], "x1");

    const first = await t.call("m9r_result", {
      token: t.codex, taskId: sent.id, summary: "The displayed value is 42.",
      completion: { status: "completed", remainingWork: [] },
    });
    const reply = t.store.tasksFor("claude").find((task) => task.replyToTaskId === sent.id);
    assert.ok(reply, "recording a teammate result must create a durable reply task");
    assert.match(first, new RegExp(`queued reply ${reply.id}`));
    assert.equal(reply.from, "codex");
    assert.equal(reply.to, "claude");
    assert.equal(reply.fromSession, "x1");
    assert.equal(reply.targetSession, "c1", "reply must target the exact session that sent the request");
    assert.equal(reply.replyDepth, sent.replyDepth + 1);
    assert.equal(reply.approval, "approved");
    assert.match(reply.goal, /The displayed value is 42/);
    assert.equal(t.store.getTask(sent.id)?.answerPushedAt, undefined, "queueing is not proof the sender received the answer");

    const repeated = await t.call("m9r_result", {
      token: t.codex, taskId: sent.id, summary: "The displayed value is 42.",
      completion: { status: "completed", remainingWork: [] },
    });
    assert.match(repeated, new RegExp(`queued reply ${reply.id}`));
    assert.equal(t.store.tasksFor("claude").filter((task) => task.replyToTaskId === sent.id).length, 1,
      "an idempotent result retry must not create a duplicate reply");

    t.store.markDelivered([reply.id], "c2");
    t.store.markDelivered([reply.id]);
    assert.equal(t.store.getTask(reply.id)?.deliveredAt, undefined, "a pinned reply cannot be consumed without its exact receiving session");
    t.store.markDelivered([reply.id], "c1");
    assert.ok(t.store.getTask(sent.id)?.answerPushedAt, "the original request records answer presentation only after target-session delivery");
    assert.equal(t.store.getTask(reply.id)?.deliveredSession, "c1");

    t.store.markDelivered([reply.id], "c2");
    assert.equal(t.store.getTask(reply.id)?.deliveredSession, "c1", "another session cannot take the pinned reply");
    await t.call("m9r_result", {
      token: t.claude, taskId: reply.id, summary: "Received the teammate result.",
      completion: { status: "completed", remainingWork: [] },
    });
    assert.equal(t.store.tasksFor("codex").filter((task) => task.replyToTaskId === reply.id).length, 0,
      "a result task cannot recursively create another result task");
  } finally { t.done(); }
});

test("a structured A2A reply suppresses the duplicate automatic task-result reply", async () => {
  const t = setup();
  try {
    const request = t.store.addTask({
      from: "claude", to: "codex", goal: "Check the requested value.", origin: "agent_initiated",
      fromSession: "c1", standingRuleApplies: true, idempotencyKey: "a2a-explicit-answer-request",
    }).task;
    t.store.markDelivered([request.id], "x1");
    const explicitReply = t.store.addTask({
      from: "codex", to: "claude", goal: "Structured teammate reply: the value is 42.", origin: "agent_initiated",
      fromSession: "x1", targetSession: "c1", standingRuleApplies: true, parentTaskId: request.id,
      replyToTaskId: request.id, replyDepth: request.replyDepth + 1, idempotencyKey: "a2a-explicit-answer-reply",
    }).task;
    t.store.setDelivery(explicitReply.id, { state: "deferred" });

    const result = await t.call("m9r_result", {
      token: t.codex, taskId: request.id, summary: "The value is 42.",
      completion: { status: "completed", remainingWork: [] },
    });
    assert.match(result, new RegExp(`already sent a structured reply.*${explicitReply.id}`));
    assert.equal(t.store.tasksFor("claude").filter((task) => task.replyToTaskId === request.id).length, 1,
      "the explicit message is the single return path; completion must not enqueue a duplicate");
    assert.equal(t.store.getTask(request.id)?.answerPushedAt, undefined,
      "the explicit reply is not counted as presented until the exact sender session receives it");
  } finally { t.done(); }
});

test("incomplete teammate results are returned, while depth limits and missing sender sessions fail closed", () => {
  const t = setup();
  try {
    const incomplete = t.store.addTask({ from: "claude", to: "codex", goal: "Inspect the form.", origin: "agent_initiated",
      fromSession: "c1", replyDepth: 2, standingRuleApplies: true, idempotencyKey: "a2a-incomplete" }).task;
    t.store.markDelivered([incomplete.id], "x1");
    const partial = t.store.recordTaskResult(t.codex, incomplete.id, "Two fields were checked.", {
      status: "incomplete", remainingWork: ["Confirm the third field."],
    });
    assert.equal(partial.ok, true);
    const partialReply = t.store.tasksFor("claude").find((task) => task.replyToTaskId === incomplete.id);
    assert.ok(partialReply);
    assert.match(partialReply.goal, /incomplete/);
    assert.match(partialReply.goal, /Confirm the third field/);
    assert.equal(t.store.getTask(incomplete.id)?.receipt?.state, "paused");
    assert.equal(t.store.getTask(incomplete.id)?.resultSummary, undefined);

    const capped = t.store.addTask({ from: "claude", to: "codex", goal: "One last request.", origin: "agent_initiated",
      fromSession: "c1", replyDepth: 8, standingRuleApplies: true, idempotencyKey: "a2a-depth-limit" }).task;
    t.store.markDelivered([capped.id], "x1");
    const cappedResult = t.store.recordTaskResult(t.codex, capped.id, "Finished.", { status: "completed", remainingWork: [] });
    assert.equal(cappedResult.answerDelivery, "depth-limit");
    assert.equal(t.store.tasksFor("claude").some((task) => task.replyToTaskId === capped.id), false);

    const unpinned = t.store.addTask({ from: "claude", to: "codex", goal: "No known sender session.", origin: "agent_initiated",
      standingRuleApplies: true, idempotencyKey: "a2a-no-session" }).task;
    t.store.markDelivered([unpinned.id], "x1");
    const unpinnedResult = t.store.recordTaskResult(t.codex, unpinned.id, "Finished.", { status: "completed", remainingWork: [] });
    assert.equal(unpinnedResult.answerDelivery, "missing-sender-session");
    assert.equal(t.store.tasksFor("claude").some((task) => task.replyToTaskId === unpinned.id), false);
  } finally { t.done(); }
});

test("a new browser room inbox ignores pre-start work but still shows tasks created during this broker lifetime", async () => {
  const roomStartedAt = Date.parse("2026-09-30T12:00:00.000Z");
  let now = new Date(roomStartedAt - 1_000);
  const t = setup({
    roomStartedAt,
    now: () => new Date(now),
    web: { authorizeRoomMessage: async () => ({ ok: true }) } as unknown as WebBrokerClient,
  });
  const sender = t.store.issueIdentity("claude", "claude-code", "web-claude-room").token;
  const receiver = t.store.issueIdentity("codex", "codex", "web-codex-room").token;
  try {
    await t.call("m9r_send", { token: sender, to: "codex", goal: "old project work" });
    assert.equal(await t.call("m9r_inbox", { token: receiver }), "Inbox is empty.", "work from before broker startup is not replayed into a fresh room");

    now = new Date(roomStartedAt + 1_000);
    await t.call("m9r_send", { token: sender, to: "codex", goal: "current project work" });
    const fresh = await t.call("m9r_inbox", { token: receiver });
    assert.match(fresh, /current project work/);
    assert.doesNotMatch(fresh, /old project work/);
  } finally { t.done(); }
});

test("a bad token is refused", async () => {
  const t = setup();
  await assert.rejects(t.call("m9r_inbox", { token: "nope", waitSeconds: 0 }), /could not verify this agent connection/);
  t.done();
});

test("delegated Codex can read its registered repository through its session token", async () => {
  const t = setup();
  const project = mkdtempSync(join(tmpdir(), "m9r-governed-repo-"));
  try {
    execFileSync("git", ["init", "-q", project]);
    writeFileSync(join(project, "task.txt"), "delegated task evidence", "utf8");
    t.store.registerEndpoint({ provider: "codex", sessionId: "x1", cwd: project });
    assert.match(await t.call("m9r_read_file", { token: t.codex, path: "task.txt" }), /delegated task evidence/);
    assert.match(await t.call("m9r_git_read", { token: t.codex, operation: "status", limit: 10 }), /task\.txt/);
    await assert.rejects(t.call("m9r_read_file", { token: t.codex, path: "../outside.txt" }), /outside the working directory/);
    await assert.rejects(t.call("m9r_git_read", { token: t.claude, operation: "status", limit: 10 }), /no unambiguous registered working directory/);
  } finally {
    rmSync(project, { recursive: true, force: true });
    t.done();
  }
});

test("room identities cannot use governed file tools when AWARE membership is unavailable", async () => {
  const t = setup({ web: { authorizeRoomMessage: async () => ({ ok: false, error: "active room membership required" }) } });
  const project = mkdtempSync(join(tmpdir(), "m9r-room-file-gate-"));
  try {
    execFileSync("git", ["init", "-q", project]);
    writeFileSync(join(project, "room.txt"), "room-private", "utf8");
    const roomToken = t.store.issueIdentity("codex", "codex", "web-room-codex").token;
    t.store.registerEndpoint({ provider: "codex", sessionId: "web-room-codex", cwd: project });
    await assert.rejects(t.call("m9r_read_file", { token: roomToken, path: "room.txt" }), /active room membership required/);
    await assert.rejects(t.call("m9r_git_read", { token: roomToken, operation: "status", limit: 10 }), /active room membership required/);
  } finally {
    rmSync(project, { recursive: true, force: true });
    t.done();
  }
});

test("ordinary native sessions retain governed file access", async () => {
  const t = setup({ web: { authorizeRoomMessage: async () => ({ ok: false, error: "must not be called" }) } });
  const project = mkdtempSync(join(tmpdir(), "m9r-native-file-gate-"));
  try {
    execFileSync("git", ["init", "-q", project]);
    writeFileSync(join(project, "native.txt"), "native-private", "utf8");
    t.store.registerEndpoint({ provider: "codex", sessionId: "x1", cwd: project });
    assert.match(await t.call("m9r_read_file", { token: t.codex, path: "native.txt" }), /native-private/);
  } finally {
    rmSync(project, { recursive: true, force: true });
    t.done();
  }
});

test("plain inbox task reaches Codex with its SessionStart identity, scoped git_read, and returned result", async () => {
  const t = setup({ allowRule: false });
  const project = mkdtempSync(join(tmpdir(), "m9r-plain-inbox-codex-"));
  const codexSession = "x1";
  const hook = (provider: string, input: { hook_event_name: string; session_id: string; cwd: string; prompt?: string }, lastAnswer?: string) =>
    handleHookEvent(input, {
      provider,
      store: t.store,
      pathExists: () => false,
      readIndex: () => null,
      ...(lastAnswer ? { lastAnswer: () => lastAnswer } : {}),
    });
  try {
    execFileSync("git", ["init", "-q", project]);
    writeFileSync(join(project, "task.txt"), "plain inbox task evidence", "utf8");

    const sessionStart = hook("codex", { hook_event_name: "SessionStart", session_id: codexSession, cwd: project });
    const sessionCard = sessionStart?.hookSpecificOutput.additionalContext ?? "";
    const token = sessionCard.match(/M9R session token[^:]*:\s*([A-Za-z0-9_-]+)/i)?.[1];
    assert.ok(token, "Codex SessionStart must receive its M9R session token");
    assert.equal(t.store.verifyIdentity(token)?.sessionId, codexSession, "the SessionStart token must identify this exact Codex session");

    await t.call("m9r_send", { token: t.claude, to: "codex", goal: "Read task.txt with your scoped M9R tools and report its contents." });
    const task = t.store.tasksFor("codex").find((item) => item.goal.includes("scoped M9R tools"));
    assert.ok(task, "the sender's task must be present in the Codex inbox");
    assert.equal(task.approval, "pending", "agent-originated work stays governed until approved");
    t.store.setApproval(task.id, "approved");

    const delivered = hook("codex", {
      hook_event_name: "UserPromptSubmit",
      session_id: codexSession,
      cwd: project,
      prompt: "Please check the task that arrived in my M9R inbox.",
    });
    assert.match(delivered?.hookSpecificOutput.additionalContext ?? "", new RegExp(task.id));
    assert.match(delivered?.hookSpecificOutput.additionalContext ?? "", /Read task\.txt with your scoped M9R tools/);
    assert.equal(t.store.getTask(task.id)?.deliveredSession, codexSession);
    assert.notEqual(t.store.getTask(task.id)?.delivery?.state, "queued", "this path is inbox delivery, not native codex queue");

    assert.match(await t.call("m9r_git_read", { token, operation: "status", limit: 10 }), /task\.txt/);
    assert.match(await t.call("m9r_read_file", { token, path: "task.txt" }), /plain inbox task evidence/);

    await t.call("m9r_result", { token, taskId: task.id, summary: "I read task.txt; it contains plain inbox task evidence.", completion: { status: "completed", remainingWork: [] } });
    hook("codex", { hook_event_name: "Stop", session_id: codexSession, cwd: project }, "I read task.txt; it contains plain inbox task evidence.");
    assert.equal(t.store.getTask(task.id)?.resultSummary, "I read task.txt; it contains plain inbox task evidence.");
    const returned = hook("claude-code", { hook_event_name: "UserPromptSubmit", session_id: "c1", cwd: project, prompt: "Any update from Codex?" });
    assert.match(returned?.hookSpecificOutput.additionalContext ?? "", new RegExp(`finished by @codex.*plain inbox task evidence`));
  } finally {
    rmSync(project, { recursive: true, force: true });
    t.done();
  }
});

test("MCP-delivered Codex task reads only its own repository through the governed Git tool", async (tctx) => {
  const storeRoot = mkdtempSync(join(tmpdir(), "m9r-mcp-inbox-root-"));
  const project = mkdtempSync(join(tmpdir(), "m9r-mcp-inbox-project-"));
  const otherProject = mkdtempSync(join(tmpdir(), "m9r-mcp-inbox-other-project-"));
  const store = createLocalStore(storeRoot);
  const codexSession = "codex-session-governed-read";
  // eslint-disable-next-line prefer-const -- declared here so tctx.after's cleanup closure can read them even if assignment below throws; each assigned exactly once.
  let sender: Awaited<ReturnType<typeof connectMcp>> | undefined;
  // eslint-disable-next-line prefer-const
  let receiver: Awaited<ReturnType<typeof connectMcp>> | undefined;

  tctx.after(async () => {
    await Promise.all([
      sender ? sender.client.close() : Promise.resolve(),
      sender ? sender.server.close() : Promise.resolve(),
      receiver ? receiver.client.close() : Promise.resolve(),
      receiver ? receiver.server.close() : Promise.resolve(),
    ]);
    rmSync(project, { recursive: true, force: true });
    rmSync(otherProject, { recursive: true, force: true });
    rmSync(storeRoot, { recursive: true, force: true });
  });

  execFileSync("git", ["init", "-q", project]);
  execFileSync("git", ["init", "-q", otherProject]);
  writeFileSync(join(project, "codex-only.txt"), "scoped repository", "utf8");
  writeFileSync(join(otherProject, "other-session-only.txt"), "different repository", "utf8");
  store.addRule({ from: "claude", to: "codex", ttlMs: 3_600_000 });

  sender = await connectMcp(store, "m9r-inbox-sender-test");
  receiver = await connectMcp(store, "m9r-inbox-codex-test");

  const hookContext = (input: { hook_event_name: string; session_id: string; cwd: string; prompt?: string }) =>
    handleHookEvent(input, {
      provider: "codex",
      store,
      pathExists: () => false,
      readIndex: () => null,
    });
  const sessionStart = hookContext({ hook_event_name: "SessionStart", session_id: codexSession, cwd: project });
  const sessionCard = sessionStart?.hookSpecificOutput.additionalContext ?? "";
  const sessionToken = sessionCard.match(/M9R session token[^:]*:\s*([A-Za-z0-9_-]+)/i)?.[1];
  assert.ok(sessionToken, "SessionStart gives this Codex session its existing M9R identity");
  assert.deepEqual(store.verifyIdentity(sessionToken), {
    handle: "codex",
    provider: "codex",
    sessionId: codexSession,
  });

  const senderToken = store.issueIdentity("claude", "claude-code", "claude-sender-session").token;
  const sendResult = await sender.client.callTool({
    name: "m9r_send",
    arguments: {
      token: senderToken,
      to: "codex",
      goal: "Read codex-only.txt with your governed Git tool and report the finding.",
    },
  });
  assert.match(mcpText(sendResult), /Sent to @codex as task T\d+\./);
  const task = store.tasksFor("codex").find((item) => item.goal.includes("governed Git tool"));
  assert.ok(task);
  assert.equal(task.approval, "approved", "the standing rule authorizes this delivered task");

  const delivered = hookContext({
    hook_event_name: "UserPromptSubmit",
    session_id: codexSession,
    cwd: project,
    prompt: "Check the task that arrived in my M9R inbox.",
  });
  const injectedTask = delivered?.hookSpecificOutput.additionalContext ?? "";
  assert.match(injectedTask, new RegExp(task.id));
  assert.match(injectedTask, /Read codex-only\.txt with your governed Git tool/);
  assert.equal(injectedTask.includes(sessionToken), false, "the session token stays in the SessionStart identity context, not the task text");
  assert.equal(injectedTask.includes(senderToken), false, "the sender's token is never copied into the recipient task");
  assert.equal(store.getTask(task.id)?.deliveredSession, codexSession);

  const listedTools = await receiver.client.listTools();
  assert.ok(listedTools.tools.some((tool) => tool.name === "m9r_git_read"));
  const gitReadResult = await receiver.client.callTool({
    name: "m9r_git_read",
    arguments: { token: sessionToken, operation: "status", limit: 10 },
  });
  const gitOutput = mcpText(gitReadResult);
  assert.match(gitOutput, /codex-only\.txt/);
  assert.doesNotMatch(gitOutput, /other-session-only\.txt/);
  assert.equal(gitOutput.includes(sessionToken), false, "the governed tool result never returns the session token");
  assert.equal(gitOutput.includes(senderToken), false, "the governed tool result never returns the sender's token");

  store.registerEndpoint({ provider: "codex", sessionId: "mismatched-provider-session", cwd: otherProject });
  const mismatchedProviderToken = store.issueIdentity("codex", "different-provider", "mismatched-provider-session").token;
  const mismatchedResult = await receiver.client.callTool({
    name: "m9r_git_read",
    arguments: { token: mismatchedProviderToken, operation: "status", limit: 10 },
  });
  assert.equal(mismatchedResult.isError, true, "a token for another provider cannot borrow this handle's session root");
  assert.match(mcpText(mismatchedResult), /no unambiguous registered working directory/i);
  assert.equal(mcpText(mismatchedResult).includes(mismatchedProviderToken), false, "the identity error does not echo its token");
});

test("governed Git child environment omits provider and M9R credentials", async () => {
  const { gitReadEnvironment } = await import("../src/lib/bridge/governed-agent-tools.ts");
  const env = gitReadEnvironment({
    PATH: "C:/tools",
    SystemRoot: "C:/Windows",
    TEMP: "C:/temp",
    OPENAI_API_KEY: "provider-key-fixture",
    ANTHROPIC_API_KEY: "provider-key-fixture",
    CODEX_API_KEY: "provider-key-fixture",
    GITHUB_TOKEN: "provider-key-fixture",
    M9R_SESSION_TOKEN: "session-token-fixture",
    M9R_AGENT_TOKEN: "agent-token-fixture",
  });

  assert.deepEqual({ ...env }, { PATH: "C:/tools", SystemRoot: "C:/Windows", TEMP: "C:/temp" });
  assert.equal(Object.values(env).some((value) => value?.includes("fixture")), false);
});
