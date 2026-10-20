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
import { handleHookEvent, type HookInput } from "@/lib/native/hook-handler";
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

test("inbox tools describe manual recovery, not a routine provider polling requirement", () => {
  const tools = (setup().server as unknown as ToolServer)._registeredTools;
  assert.match(tools["m9r_inbox"]?.description ?? "", /manual recovery|explicitly asked|delivery/i);
  assert.doesNotMatch(tools["m9r_inbox"]?.description ?? "", /Check your inbox for new messages/i);
  assert.match(tools["m9r_pending_work"]?.description ?? "", /recovery|explicitly asked/i);
  assert.doesNotMatch(tools["m9r_pending_work"]?.description ?? "", /Call this whenever you're unsure/i);
});

test("desktop stage input derives a private one-shot receipt ID from the MCP request identity", async () => {
  let receivedOperationId = "";
  const web: WebBrokerClient = {
    taskStageAction: async (_token, _taskId, _action, _mode, operationId) => {
      receivedOperationId = operationId ?? "";
      return { ok: true, result: { operationReceipt: { status: "applied" }, actionExecuted: true } };
    },
    run: async () => ({ ok: false, error: "unused" }),
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

test("an ambiguous pending-task backlog resolves to the newest one instead of refusing every later prompt (live bug, 2026-10-17)", async () => {
  // Reproduces exactly what the owner hit live: a session accumulates abandoned "pending" tasks
  // (origin human_typed, never finalized by m9r_result after a failure) and a brand-new typed
  // prompt with no explicit taskId used to get refused outright once two or more existed.
  const web: WebBrokerClient = {
    prepareTaskStage: async () => ({ ok: true }),
    taskStageApp: async (_token, taskId) => ({ ok: true, result: { name: `stage-${taskId}`, taskId, running: true } }),
    taskStageAction: async (_token, taskId) => ({ ok: true, result: { capture: { dataUrl: "data:image/png;base64,eA==", width: 1, height: 1, capturedAt: new Date().toISOString() }, taskIdEchoed: taskId } }),
    run: async () => ({ ok: false, error: "unused" }),
  };
  const t = setup({ web });
  try {
    const older = t.store.addTask({ from: "you", to: "codex", goal: "open chrome go on x", origin: "human_typed", idempotencyKey: "older" }).task;
    assert.ok(t.store.bindTaskToSession(older.id, t.codex));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = t.store.addTask({ from: "you", to: "codex", goal: "go on youtube now and find me a video on ferraris", origin: "human_typed", idempotencyKey: "newer" }).task;
    assert.ok(t.store.bindTaskToSession(newer.id, t.codex));

    const prepareReply = await t.call("m9r_stage_prepare", { token: t.codex, mode: "owner-preview" });
    assert.match(prepareReply, /"ok":true/, "two pending tasks must no longer refuse a taskId-less call");

    const appHandler = (t.server as unknown as ToolServer)._registeredTools["m9r_stage_app"]!.handler as (
      args: unknown, extra: { requestId: string | number },
    ) => Promise<{ content: Array<{ type: string; text: string }> }>;
    const appResult = await appHandler({ token: t.codex, operation: "launch", appId: "chrome" }, { requestId: 1 });
    const appReply = JSON.parse(appResult.content[0]!.text);
    assert.equal(appReply.result.taskId, newer.id, "the omitted taskId must resolve to the newest pending task, not refuse or pick an abandoned one");

    const actionHandler = (t.server as unknown as ToolServer)._registeredTools["m9r_stage_action"]!.handler as (
      args: unknown, extra: { requestId: string | number },
    ) => Promise<{ content: Array<{ type: string; text: string }> }>;
    const actionResult = await actionHandler({ token: t.codex, action: { kind: "capture" } }, { requestId: 2 });
    const actionReply = JSON.parse(actionResult.content[0]!.text);
    assert.equal(actionReply.result.taskIdEchoed, newer.id);
  } finally { t.done(); }
});

test("a task already in progress keeps being resolved to, even once a newer task is pending (Codex's turn-pinning catch, 2026-10-17)", async () => {
  // Codex's review of the newest-pending-task fix above: within one multi-call turn (observe,
  // then several actions, each free to omit taskId), a newer task arriving mid-turn must not
  // silently steal the turn away from the task actually being acted on.
  const web: WebBrokerClient = {
    taskStageAction: async (_token, taskId) => ({ ok: true, result: { capture: { dataUrl: "data:image/png;base64,eA==", width: 1, height: 1, capturedAt: new Date().toISOString() }, taskIdEchoed: taskId } }),
    run: async () => ({ ok: false, error: "unused" }),
  };
  const t = setup({ web });
  try {
    const inProgress = t.store.addTask({ from: "you", to: "codex", goal: "open the calculator and do 2+2", origin: "human_typed", idempotencyKey: "in-progress" }).task;
    assert.ok(t.store.bindTaskToSession(inProgress.id, t.codex));
    const identity = t.store.verifyIdentity(t.codex)!;
    // Simulate a real stage action already dispatched against the in-progress task this turn.
    t.store.claimStageOperation({ handle: identity.handle, sessionId: identity.sessionId, taskId: inProgress.id, operationId: "op-1", fingerprint: "a".repeat(64) });

    // A different task arrives mid-turn -- a real, separate thing the person asked for, but not
    // what this turn's in-flight action is about.
    const midTurnArrival = t.store.addTask({ from: "you", to: "codex", goal: "also check my email", origin: "human_typed", idempotencyKey: "mid-turn" }).task;
    assert.ok(t.store.bindTaskToSession(midTurnArrival.id, t.codex));

    const actionHandler = (t.server as unknown as ToolServer)._registeredTools["m9r_stage_action"]!.handler as (
      args: unknown, extra: { requestId: string | number },
    ) => Promise<{ content: Array<{ type: string; text: string }> }>;
    const result = await actionHandler({ token: t.codex, action: { kind: "capture" } }, { requestId: 1 });
    const reply = JSON.parse(result.content[0]!.text);
    assert.equal(reply.result.taskIdEchoed, inProgress.id,
      "an omitted taskId mid-turn must keep resolving to the task actually being acted on, not silently retarget onto a newer, untouched task");
  } finally { t.done(); }
});

test("stage activity older than the active-turn window must not hijack a brand-new task's first call (live bug, T236 vs T257, 2026-10-17)", async () => {
  // Reproduces the exact live failure: "go on chrome and search X for the new Tesla" (T257)
  // opened File Explorer instead, because a two-day-old orphaned "launch File Explorer" task
  // (T236) still had a stage operation on record and, with no staleness bound, unconditionally
  // outranked T257's brand-new, zero-history first call.
  let clock = Date.parse("2026-10-16T23:21:11.034Z");
  const now = () => new Date(clock);
  const web: WebBrokerClient = {
    taskStageApp: async (_token, taskId) => ({ ok: true, result: { taskId, running: true } }),
    run: async () => ({ ok: false, error: "unused" }),
  };
  const t = setup({ web, now });
  try {
    const stale = t.store.addTask({ from: "you", to: "codex", goal: "Call m9r_stage_app with taskId T236, operation launch, appId explorer.exe.", origin: "human_typed", idempotencyKey: "stale-explorer" }).task;
    assert.ok(t.store.bindTaskToSession(stale.id, t.codex));
    const identity = t.store.verifyIdentity(t.codex)!;
    t.store.claimStageOperation({ handle: identity.handle, sessionId: identity.sessionId, taskId: stale.id, operationId: "op-explorer", fingerprint: "b".repeat(64) });

    // Two days pass with no further activity on that task -- it was abandoned, not continued.
    clock += 2 * 24 * 60 * 60_000;
    const freshChromeTask = t.store.addTask({ from: "you", to: "codex", goal: "go on chrome and search X for the new Tesla", origin: "human_typed", idempotencyKey: "fresh-chrome" }).task;
    assert.ok(t.store.bindTaskToSession(freshChromeTask.id, t.codex));

    const appHandler = (t.server as unknown as ToolServer)._registeredTools["m9r_stage_app"]!.handler as (
      args: unknown, extra: { requestId: string | number },
    ) => Promise<{ content: Array<{ type: string; text: string }> }>;
    const result = await appHandler({ token: t.codex, operation: "launch", appId: "chrome" }, { requestId: 1 });
    const reply = JSON.parse(result.content[0]!.text);
    assert.equal(reply.result.taskId, freshChromeTask.id,
      "a brand-new task's first call must resolve to itself, not to a days-old orphan with stale activity");
  } finally { t.done(); }
});

test("a stale delivered task is not treated as the current task when a stage call omits taskId", async () => {
  let clock = Date.parse("2026-10-07T12:00:00.000Z");
  const web: WebBrokerClient = {
    taskStageApp: async (_token, taskId) => ({ ok: true, result: { taskId, running: true } }),
    run: async () => ({ ok: false, error: "unused" }),
  };
  const t = setup({ web, now: () => new Date(clock) });
  try {
    const stale = t.store.addTask({
      from: "you", to: "codex", goal: "old delivered task", origin: "human_typed", idempotencyKey: "old-delivered-task",
    }).task;
    assert.ok(t.store.bindTaskToSession(stale.id, t.codex));
    clock += 31 * 60_000;

    const appHandler = (t.server as unknown as ToolServer)._registeredTools["m9r_stage_app"]!.handler as (
      args: unknown, extra: { requestId: string | number },
    ) => Promise<{ content: Array<{ type: string; text: string }> }>;
    await assert.rejects(
      appHandler({ token: t.codex, operation: "launch", appId: "chrome" }, { requestId: 1 }),
      /no currently pending task/i,
      "a task-less stage call must not resurrect a delivered task outside the inbox freshness window",
    );
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
  assert.doesNotMatch(first, /T\d+|session token|get_task/i);
  const second = await t.call("m9r_inbox", { token: t.codex });
  assert.match(second, /second finding/);
  assert.doesNotMatch(second, /T\d+|session token|get_task/i);
  const alreadySeen = await t.call("m9r_inbox", { token: t.codex });
  assert.match(alreadySeen, /Inbox is empty for new messages/, "already-seen messages are not replayed as new");
  assert.match(alreadySeen, /first finding/);
  assert.match(alreadySeen, /second finding/);
  assert.doesNotMatch(alreadySeen, /T\d+|session token|get_task/i);

  await t.call("m9r_send", { token: t.claude, to: "codex", goal: "third finding" });
  const later = await t.call("m9r_inbox", { token: t.codex });
  assert.match(later, /third finding/);
  assert.doesNotMatch(later, /first finding|second finding/);
  t.done();
});

test("an ordinary direct MCP delegation inherits one active owner-approved turn, but protected work stays pending", async () => {
  const t = setup({ allowRule: false });
  try {
    const sender = t.store.verifyIdentity(t.claude);
    assert.ok(sender);
    const ownerTask = t.store.addTask({
      from: "you",
      to: "claude",
      goal: "Coordinate the harmless verification with the other agent.",
      origin: "human_typed",
      targetSession: sender.sessionId,
      idempotencyKey: "direct-owner-approval-parent",
    }).task;
    t.store.markDelivered([ownerTask.id], sender.sessionId);

    await t.call("m9r_send", { token: t.claude, to: "codex", goal: "Read the harmless verification and report the result." });
    const child = t.store.tasksFor("codex").find((task) => task.goal.includes("Read the harmless verification"));
    assert.equal(child?.approval, "approved");
    assert.equal(child?.parentTaskId, ownerTask.id);

    await t.call("m9r_send", { token: t.claude, to: "codex", goal: "Delete the build folder permanently." });
    const protectedChild = t.store.tasksFor("codex").find((task) => task.goal.includes("Delete the build folder"));
    assert.equal(protectedChild?.approval, "pending");
    assert.equal(protectedChild?.parentTaskId, undefined);
  } finally { t.done(); }
});

test("m9r_pending_work still surfaces a task after the inbox has already delivered it and moved on", async () => {
  // Confirmed live, 2026-10-17: an agent reported "inbox is empty" for a task that had, in fact,
  // already been delivered and was still open -- the inbox's one-shot replay fence (correct,
  // kept as-is) means a delivered task never reappears there, so an agent with no memory of
  // having seen it (a fresh session, a reconnect) has no way to discover it is still owed a
  // result. This proves the new lookup closes exactly that gap.
  const t = setup();
  try {
    await t.call("m9r_send", { token: t.claude, to: "codex", goal: "open file explorer and type hello" });
    const first = await t.call("m9r_inbox", { token: t.codex });
    assert.match(first, /open file explorer/);
    const alreadyDelivered = await t.call("m9r_inbox", { token: t.codex });
    assert.match(alreadyDelivered, /Inbox is empty for new messages/, "the task was already delivered once, not replayed as new");
    assert.match(alreadyDelivered, /open file explorer and type hello/);
    assert.doesNotMatch(alreadyDelivered, /T\d+|session token|get_task/i);

    const pending = await t.call("m9r_pending_work", { token: t.codex });
    assert.match(pending, /open file explorer/, "pending work must still list a delivered-but-unresolved task");

    assert.doesNotMatch(pending, /T\d+|session token|get_task/i);
    await t.call("m9r_result", { token: t.codex, summary: "done" });
    assert.equal(await t.call("m9r_pending_work", { token: t.codex }), "No open tasks owed a result right now.", "a reported result must no longer count as pending");
  } finally { t.done(); }
});

test("native inbox does not re-present already-delivered work after it becomes stale", async () => {
  let clock = Date.parse("2026-10-07T12:00:00.000Z");
  const t = setup({ now: () => new Date(clock) });
  try {
    await t.call("m9r_send", { token: t.claude, to: "codex", goal: "old provider task" });
    assert.match(await t.call("m9r_inbox", { token: t.codex }), /old provider task/);

    // The task was genuinely shown once, but it was never completed. A later
    // provider reconnect must not turn that historical receipt into fresh work.
    clock += 31 * 60_000;
    assert.equal(await t.call("m9r_inbox", { token: t.codex }), "Inbox is empty.");
    assert.equal(await t.call("m9r_pending_work", { token: t.codex }), "No open tasks owed a result right now.");
  } finally { t.done(); }
});

test("browser-room pending work ignores stale tasks instead of handing an old task to a replacement provider session", async () => {
  let clock = Date.parse("2026-10-07T12:00:00.000Z");
  const t = setup({
    now: () => new Date(clock),
    web: { authorizeRoomMessage: async () => ({ ok: true }) } as unknown as WebBrokerClient,
  });
  const roomToken = t.store.issueIdentity("codex", "codex", "web-codex-room").token;
  try {
    t.store.addTask({
      from: "you", to: "web-codex", goal: "historical room task", origin: "human_typed", idempotencyKey: "historical-room-task",
    });
    clock += 31 * 60_000;
    t.store.addTask({
      from: "you", to: "web-codex", goal: "current room task", origin: "human_typed", idempotencyKey: "current-room-task",
    });

    const pending = await t.call("m9r_pending_work", { token: roomToken });
    assert.doesNotMatch(pending, /historical room task/);
    assert.match(pending, /current room task/);
  } finally { t.done(); }
});

test("colorFor allocates one durable color per handle, never a collision between concurrently active agents", () => {
  // Findings I/AD: confirmed live that the pill's own hardcoded Codex color changed between two
  // audits the same night, with nothing keeping any surface in sync with any other. This proves
  // the actual fix: one persisted source of truth, stable across repeated calls, never a
  // duplicate among handles that are all assigned at once.
  const t = setup();
  try {
    const claude = t.store.colorFor("claude");
    assert.equal(claude, "#D97757", "Claude keeps its real brand color as the preferred first pick");
    assert.equal(t.store.colorFor("claude"), claude, "the same handle must always get the same answer");

    const codex = t.store.colorFor("codex");
    const opencode = t.store.colorFor("opencode");
    assert.notEqual(codex, claude);
    assert.notEqual(opencode, claude);
    assert.notEqual(codex, opencode, "two concurrently active agents must never be assigned the same color");

    // Case/prefix variance in how a handle is spelled must resolve to the same stored identity.
    assert.equal(t.store.colorFor("Codex"), codex);
  } finally { t.done(); }
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
  assert.match(await t.call("m9r_result", { token: t.codex, taskId: "T1", summary: "right session" }), /Result recorded/);
  assert.equal(t.store.getTask("T1")?.resultSummary, "right session");
  t.done();
});

test("a single delivered work item can be completed without exposing or requiring its internal task id", async () => {
  const t = setup();
  await t.call("m9r_send", { token: t.claude, to: "codex", goal: "report the one delivered finding" });
  const inbox = await t.call("m9r_inbox", { token: t.codex });
  assert.match(inbox, /report the one delivered finding/);
  assert.doesNotMatch(inbox, /T\d+|session token|get_task/i);
  const result = await t.call("m9r_result", { token: t.codex, summary: "The delivered finding was recorded." });
  assert.match(result, /Result recorded/i);
  assert.equal(t.store.tasksFor("codex")[0]?.resultSummary, "The delivered finding was recorded.");
  t.done();
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
  await assert.rejects(t.call("m9r_inbox", { token: "nope", waitSeconds: 0 }), /token is malformed/);
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
  const t = setup({ web: { run: async () => ({ ok: false, error: "unused" }), authorizeRoomMessage: async () => ({ ok: false, error: "active room membership required" }) } });
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
  const t = setup({ web: { run: async () => ({ ok: false, error: "unused" }), authorizeRoomMessage: async () => ({ ok: false, error: "must not be called" }) } });
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
  const hook = (provider: string, input: HookInput, lastAnswer?: string) =>
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
    assert.doesNotMatch(delivered?.hookSpecificOutput.additionalContext ?? "", new RegExp(task.id));
    assert.match(delivered?.hookSpecificOutput.additionalContext ?? "", /Read task\.txt with your scoped M9R tools/);
    assert.match(delivered?.hookSpecificOutput.additionalContext ?? "", /m9r_result/);
    assert.doesNotMatch(delivered?.hookSpecificOutput.additionalContext ?? "", /session token/i);
    assert.equal(t.store.getTask(task.id)?.deliveredSession, codexSession);
    assert.notEqual(t.store.getTask(task.id)?.delivery?.state, "queued", "this path is inbox delivery, not native codex queue");

    assert.match(await t.call("m9r_git_read", { token, operation: "status", limit: 10 }), /task\.txt/);
    assert.match(await t.call("m9r_read_file", { token, path: "task.txt" }), /plain inbox task evidence/);

    // With exactly one delivered task, the provider can report the result without
    // carrying an internal task id through its visible prompt or reply.
    hook("codex", { hook_event_name: "Stop", session_id: codexSession, cwd: project }, "ignored because no task id was supplied");
    assert.equal(t.store.getTask(task.id)?.resultSummary, "ignored because no task id was supplied");
    const second = t.store.addTask({ from: "claude", to: "codex", goal: "second independent task", origin: "human_typed", idempotencyKey: "second-stop-task" }).task;
    const third = t.store.addTask({ from: "claude", to: "codex", goal: "third independent task", origin: "human_typed", idempotencyKey: "third-stop-task" }).task;
    t.store.setDelivery(second.id, { state: "queued", threadId: codexSession });
    t.store.setDelivery(third.id, { state: "queued", threadId: codexSession });
    t.store.markDelivered([second.id, third.id], codexSession);
    const ambiguousStop = hook("codex", { hook_event_name: "Stop", session_id: codexSession, cwd: project }, "must not guess");
    assert.equal(ambiguousStop, null);
    assert.equal(t.store.getTask(second.id)?.resultSummary, undefined);
    assert.equal(t.store.getTask(third.id)?.resultSummary, undefined);
    const returned = hook("claude-code", { hook_event_name: "UserPromptSubmit", session_id: "c1", cwd: project, prompt: "Any update from Codex?" });
    assert.match(returned?.hookSpecificOutput.additionalContext ?? "", new RegExp(`finished by @codex.*ignored because no task id was supplied`));
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
  assert.match(mcpText(sendResult), /Message sent to @codex\./);
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
  assert.doesNotMatch(injectedTask, new RegExp(task.id));
  assert.match(injectedTask, /Read codex-only\.txt with your governed Git tool/);
  assert.match(injectedTask, /m9r_result/);
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
