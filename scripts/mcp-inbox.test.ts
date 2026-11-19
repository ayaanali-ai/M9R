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

test("managed agents discover broker teammates without legacy endpoint heartbeats", async () => {
  const t = setup({ web: { listRoomAgents: async () => ["claude", "codex"] } });
  try {
    const managed = t.store.issueIdentity("codex", "codex", "m9r-owner-codex-roster-test");
    assert.equal(t.store.listEndpoints().length, 0);
    const text = await t.call("m9r_agents", { token: managed.token, activeWindowMinutes: 10 });
    assert.match(text, /@claude/);
    assert.doesNotMatch(text, /@codex|No other agents active/);
  } finally { t.done(); }
});

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

test("working context is exposed over MCP, delivered once per change and recoverable after presentation state is lost", async () => {
  const t = setup();
  const checkpoint = { decisions: ["Blue house"], currentEditor: "codex", artifacts: [],
    observedState: [{ summary: "Save outcome unknown", outcome: "unknown", evidence: null }], unresolved: ["Verify save"], nextStep: "Inspect image" };
  try {
    const work = t.store.addTask({ from: "you", to: "codex", goal: "Draw and verify", origin: "human_typed", idempotencyKey: "working-mcp", broadcastId: "working-team" }).task;
    t.store.markDelivered([work.id], "x1");
    const args = { token: t.codex, taskId: work.id };
    assert.equal(JSON.parse(await t.call("m9r_working_context", { ...args, action: "read" })).revision, 0);
    assert.equal(JSON.parse(await t.call("m9r_working_context", { ...args, action: "save", expectedRevision: 0, checkpoint })).revision, 1);
    const handler = (t.server as unknown as ToolServer)._registeredTools.m9r_agents.handler;
    const first = await handler({ token: t.codex, activeWindowMinutes: 10 });
    assert.match(JSON.stringify(first), /Blue house/);
    assert.doesNotMatch(JSON.stringify(await handler({ token: t.codex, activeWindowMinutes: 10 })), /Blue house/, "unchanged context is not appended on every call");
    const peer = t.store.addTask({ from: "you", to: "claude", goal: "Draw and verify", origin: "human_typed", idempotencyKey: "working-peer", broadcastId: "working-team" }).task;
    t.store.markDelivered([peer.id], "c1");
    t.store.saveWorkingContext(t.claude, peer.id, 0, { ...checkpoint, nextStep: "Peer will check the roof" });
    assert.match(JSON.stringify(await handler({ token: t.codex, activeWindowMinutes: 10 })), /Peer will check the roof/, "peer changes reach the active agent at its next normal boundary");
    const replacement = createM9rMcpServer({ store: createLocalStore(t.store.root) });
    const recovered = await (replacement as unknown as ToolServer)._registeredTools.m9r_working_context.handler({ ...args, action: "read" });
    assert.match(recovered.content[0].text, /Save outcome unknown/);
    const evidence = JSON.parse(await t.call("m9r_working_context", { ...args, action: "evidence", evidenceTaskId: work.id }));
    assert.equal(evidence.evidence.goal, work.goal);
    await assert.rejects(t.call("m9r_working_context", { ...args, action: "save", expectedRevision: 0, checkpoint: { ...checkpoint, nextStep: "Overwrite" } }), /changed/);
    await assert.rejects(t.call("m9r_working_context", { token: t.claude, taskId: work.id, action: "read" }), /exact session/);
    const updated = { ...checkpoint, nextStep: "Ask for missing evidence" };
    await t.call("m9r_working_context", { ...args, action: "save", expectedRevision: 1, checkpoint: updated });
    assert.match(JSON.stringify(await handler({ token: t.codex, activeWindowMinutes: 10 })), /Ask for missing evidence/);
    assert.equal(t.store.getTask(work.id)?.resultSummary, undefined);
    const transport = await connectMcp(t.store, "working-context-schema");
    try {
      assert.ok((await transport.client.listTools()).tools.some(tool => tool.name === "m9r_working_context"));
      const saved = await transport.client.callTool({ name: "m9r_working_context", arguments: {
        ...args, action: "save", expectedRevision: 2, checkpoint: { ...checkpoint, nextStep: "Finish verification" } } });
      assert.equal(saved.isError, undefined);
      assert.match(mcpText(saved), /saved-agent-report/);
      const tooLarge = await transport.client.callTool({ name: "m9r_working_context", arguments: {
        ...args, action: "save", expectedRevision: 3, checkpoint: { ...checkpoint, nextStep: "x".repeat(241) } } });
      assert.equal(tooLarge.isError, true);
    } finally { await transport.client.close(); await transport.server.close(); }
  } finally { t.done(); }
});

test("a new handoff recovers bounded session-specific team history even when nobody saved a checkpoint", async () => {
  const t = setup();
  try {
    const owner = t.store.addTask({ from: "you", to: "codex", goal: "Work together on one document", origin: "human_typed",
      broadcastId: "checkpointless-team", idempotencyKey: "checkpointless-root" }).task;
    t.store.markDelivered([owner.id], "x1");
    const incoming = t.store.addTask({ from: "claude", to: "codex", goal: "I am preparing the document", origin: "agent_initiated",
      standingRuleApplies: true, fromSession: "c1", targetSession: "x1", replyToTaskId: owner.id, idempotencyKey: "checkpointless-incoming" }).task;
    t.store.markDelivered([incoming.id], "x1");
    const outgoing = t.store.addTask({ from: "codex", to: "claude", goal: "I will wait for your handoff", origin: "agent_initiated",
      standingRuleApplies: true, fromSession: "x1", targetSession: "c1", replyToTaskId: owner.id, idempotencyKey: "checkpointless-outgoing" }).task;
    t.store.addTask({ from: "claude", to: "codex", goal: "Undelivered message must stay in the inbox", origin: "agent_initiated",
      standingRuleApplies: true, fromSession: "c1", targetSession: "x1", replyToTaskId: owner.id, idempotencyKey: "checkpointless-pending" });
    t.store.addTask({ from: "claude", to: "codex", goal: "Other session must stay private", origin: "agent_initiated",
      standingRuleApplies: true, fromSession: "c1", targetSession: "another-session", replyToTaskId: owner.id, idempotencyKey: "checkpointless-foreign" });
    const current = t.store.addTask({ from: "claude", to: "codex", goal: "Current handoff is already in this turn", origin: "agent_initiated",
      standingRuleApplies: true, fromSession: "c1", targetSession: "x1", replyToTaskId: owner.id, idempotencyKey: "checkpointless-current" }).task;
    const prompt = t.store.renderWorkingContextForTask(current.id, "x1");
    assert.match(prompt, /I am preparing the document/);
    assert.match(prompt, /I will wait for your handoff/);
    assert.doesNotMatch(prompt, /Current handoff is already in this turn|Undelivered message must stay in the inbox|Other session must stay private/);
    assert.doesNotMatch(t.store.renderWorkingContextForTask(current.id, "another-session"), /I will wait for your handoff/);
    t.store.markDelivered([current.id], "x1");
    const recovered = JSON.parse(await t.call("m9r_working_context", { token: t.codex, taskId: current.id, action: "read" }));
    assert.deepEqual(recovered.recentMessages.map((message: { taskId: string }) => message.taskId), [incoming.id, outgoing.id]);
    assert.equal(recovered.recentMessages[1].recipientDeliveryRecorded, false, "a sent message is not claimed as delivered");
    for (let index = 0; index < 4; index++) t.store.addTask({ from: "codex", to: "claude", goal: `Update ${index}: ${"x".repeat(300)}`,
      origin: "agent_initiated", standingRuleApplies: true, fromSession: "x1", targetSession: "c1",
      replyToTaskId: owner.id, idempotencyKey: `bounded-history-${index}` });
    const bounded = JSON.parse(await t.call("m9r_working_context", { token: t.codex, taskId: current.id, action: "read" }));
    assert.equal(bounded.recentMessages.length, 3);
    assert.ok(bounded.recentMessages.every((message: { text: string; truncated: boolean }) => message.text.length <= 240 && message.truncated));
    t.store.saveWorkingContext(t.codex, current.id, 0, { decisions: [], currentEditor: "codex", artifacts: [], observedState: [],
      unresolved: [], nextStep: "Finish the document" });
    const boundary = (t.server as unknown as ToolServer)._registeredTools.m9r_agents.handler;
    assert.match(JSON.stringify(await boundary({ token: t.codex, activeWindowMinutes: 10 })), /Finish the document/);
    t.store.addTask({ from: "codex", to: "claude", goal: "One new sent note", origin: "agent_initiated",
      standingRuleApplies: true, fromSession: "x1", targetSession: "c1", replyToTaskId: owner.id, idempotencyKey: "boundary-note" });
    assert.doesNotMatch(JSON.stringify(await boundary({ token: t.codex, activeWindowMinutes: 10 })), /Updated durable working context|One new sent note/,
      "changing recent history alone does not repeat checkpoints or duplicate the sender's message at every tool boundary");
    assert.equal(t.store.getTask(owner.id)?.resultSummary, undefined, "reading history never changes completion");
  } finally { t.done(); }
});

test("desktop stage MCP tools default to the current owner desktop", () => {
  const t = setup();
  try {
    const tools = (t.server as unknown as ToolServer)._registeredTools;
    for (const name of ["m9r_stage_prepare", "m9r_stage_action", "m9r_stage_app"]) {
      const shape = (tools[name]?.inputSchema as { shape?: Record<string, { parse(value: unknown): unknown }> } | undefined)?.shape;
      assert.equal(shape?.mode?.parse(undefined), name === "m9r_stage_action" ? undefined : "owner-preview");
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

test("stage press_key with modifiers dispatches the same exact-window hotkey contract", async () => {
  const actions: unknown[] = [];
  const t = setup({ web: { taskStageAction: async (_token, _taskId, action) => { actions.push(action); return { ok: true }; } } });
  try {
    const work = t.store.addTask({ from: "you", to: "codex", goal: "Open file", origin: "human_typed", idempotencyKey: "key-alias" }).task;
    t.store.markDelivered([work.id], "x1");
    const args = { token: t.codex, taskId: work.id, operationId: "open-key", action: { kind: "press_key", key: "o", modifiers: ["Control"], view: "app" } };
    const schema = (t.server as unknown as ToolServer)._registeredTools.m9r_stage_action.inputSchema as { safeParse(value: unknown): { success: boolean } };
    assert.equal(schema.safeParse(args).success, true, "the public schema accepts the rehearsal's modifier syntax");
    await t.call("m9r_stage_action", args);
    assert.deepEqual(actions, [{ kind: "hotkey", keys: ["Ctrl", "o"], view: "app" }]);
  } finally { t.done(); }
});

test("legacy stage images are optional without suppressing error recovery evidence", async () => {
  let ok = true;
  const t = setup({ web: { taskStageAction: async () => ({ ok, result: { capture: { dataUrl: "data:image/png;base64,eA==", width: 10, height: 10,
    ownedPopups: [{ dataUrl: "data:image/png;base64,eQ==" }] } } }) } });
  try {
    const work = t.store.addTask({ from: "you", to: "codex", goal: "Inspect controls", origin: "human_typed", idempotencyKey: "image-choice" }).task;
    t.store.markDelivered([work.id], "x1");
    const handler = (t.server as unknown as ToolServer)._registeredTools.m9r_stage_action.handler;
    const args = { token: t.codex, taskId: work.id, action: { kind: "read_structure", view: "app" }, operationId: "image-choice" };
    assert.equal((await handler(args)).content.filter(block => block.type === "image").length, 2);
    const compact = await handler({ ...args, includeScreenshot: false });
    assert.equal(compact.content.some(block => block.type === "image"), false);
    assert.match(compact.content[0].text, /not-requested/);
    ok = false;
    assert.equal((await handler({ ...args, includeScreenshot: false })).content.filter(block => block.type === "image").length, 2);
  } finally { t.done(); }
});

test("native stage actions leave surface-scoped revision tracking to the owner broker", async () => {
  const receivedRevisions: Array<number | undefined> = [];
  let nextRevision = 0;
  const web: WebBrokerClient = {
    taskStageAction: async (_token, _taskId, _action, _mode, _operationId, expectedMutationRevision) => {
      receivedRevisions.push(expectedMutationRevision);
      nextRevision += 1;
      return { ok: true, result: { actionExecuted: true, mutationRevision: nextRevision } };
    },
  };
  const t = setup({ web });
  try {
    const work = t.store.addTask({ from: "you", to: "codex", goal: "Click the button", origin: "human_typed", idempotencyKey: "stage-revision" }).task;
    t.store.markDelivered([work.id], "x1");
    const handler = (t.server as unknown as ToolServer)._registeredTools["m9r_stage_action"]!.handler as (
      args: unknown, extra: { requestId: string | number }) => Promise<{ content: Array<{ type: string; text: string }> }>;
    // A first action on a session's stage has nothing to compare against yet.
    await handler({ token: t.codex, taskId: work.id, operationId: "stage-rev-1", action: { kind: "capture", view: "app" } }, { requestId: 1 });
    assert.equal(receivedRevisions[0], undefined, "the first action on a fresh stage has no prior observation to carry forward");
    // The owner broker keys observations by the actual mutation surface. This
    // MCP session must not assign one surface's revision to another surface.
    await handler({ token: t.codex, taskId: work.id, operationId: "stage-rev-2", action: { kind: "capture", view: "desktop" } }, { requestId: 2 });
    assert.equal(receivedRevisions[1], undefined, "a prior app revision must not be sent as a desktop revision");
    await handler({ token: t.codex, taskId: work.id, operationId: "stage-rev-3", action: { kind: "cursor", x: 3, y: 3 } }, { requestId: 3 });
    assert.equal(receivedRevisions[2], undefined, "the broker owns the native surface ledger");
  } finally { t.done(); }
});

test("structured observation refs work in stage actions without losing native identity or the observed mutation fence", async () => {
  const sent: Array<{ action: unknown; revision: number | undefined }> = [];
  const t = setup({ web: {
    prepareTaskStage: async () => ({ ok: true }),
    taskStageAction: async (_token, _taskId, action, _mode, _operationId, revision) => {
      if ((action as { kind: string }).kind === "read_structure") return { ok: true, result: { status: "complete", capturedAt: new Date().toISOString(), mutationRevision: 7,
        elements: [{ ref: "uia:note-editor", role: "edit", label: "Note Editor", enabled: true,
          actions: ["click"], rect: { x: 1, y: 2, width: 100, height: 100 } }] } };
      sent.push({ action, revision });
      return { ok: true, result: { mutationRevision: 8 } };
    },
  } });
  try {
    const work = t.store.addTask({ from: "you", to: "codex", goal: "Edit the note", origin: "human_typed", idempotencyKey: "mapped-ref" }).task;
    t.store.markDelivered([work.id], "x1");
    const observe = async () => JSON.parse(await t.call("m9r_computer_observe", { token: t.codex, taskId: work.id, target: "app-window" }));
    const first = await observe();
    assert.ok(first.observation, JSON.stringify(first));
    const ref = first.observation.structure.elements[0].ref;
    assert.match(ref, /^control_/);
    const act = (token = t.codex, controlRef = ref, taskId = work.id, mode = "owner-preview") => t.call("m9r_stage_action", {
      token, taskId, mode, operationId: `mapped-${sent.length}`, action: {
        kind: "click_element", view: "app", ref: controlRef, expectedRole: "edit", expectedLabel: "Note Editor",
      },
    });
    await act();
    assert.deepEqual(sent[0], { action: { kind: "click_element", view: "app", ref: "uia:note-editor",
      expectedRole: "edit", expectedLabel: "Note Editor" }, revision: 7 });
    // A stage response must not silently upgrade an older observation's fence.
    await act();
    assert.equal(sent[1].revision, 7);
    await assert.rejects(act(t.claude), /structured control reference/);
    await assert.rejects(act(t.codex, ref, work.id, "background"), /structured control reference/);
    const refreshed = await observe();
    await assert.rejects(act(), /structured control reference/);
    assert.equal(sent.length, 2, "foreign, wrong-mode, and superseded refs never reach dispatch");
    await act(t.codex, "uia:legacy-control");
    assert.equal((sent[2].action as { ref: string }).ref, "uia:legacy-control", "native stage refs remain supported");
    const freshRef = refreshed.observation.structure.elements[0].ref;
    for (const action of [
      { kind: "replace_element", text: "Updated note" },
      { kind: "scroll_element", direction: "down" },
    ]) {
      await t.call("m9r_stage_action", { token: t.codex, taskId: work.id, mode: "owner-preview",
        operationId: `mapped-${sent.length}`, action: { ...action, view: "app", ref: freshRef } });
      assert.equal((sent.at(-1)!.action as { ref: string }).ref, "uia:note-editor");
      assert.equal(sent.at(-1)!.revision, 7);
    }
    const next = t.store.addTask({ from: "you", to: "codex", goal: "Different work", origin: "human_typed", idempotencyKey: "other-ref-task" }).task;
    t.store.markDelivered([next.id], "x1");
    await assert.rejects(act(t.codex, freshRef, next.id), /structured control reference/);
    assert.equal(sent.length, 5, "a control from another task must not dispatch");
  } finally { t.done(); }
});

test("fresh visual control references click their observed bounds without inventing a native token", async () => {
  const sent: unknown[] = [];
  const t = setup({ web: { prepareTaskStage: async () => ({ ok: true }), taskStageAction: async (_token, _taskId, action) => {
    if ((action as { kind: string }).kind === "capture") return { ok: true, result: { mutationRevision: 4, capture: { dataUrl: "data:image/png;base64,eA==",
      capturedAt: new Date().toISOString(), width: 300, height: 200, controls: [{ label: "Resize and skew", role: "button", rect: { x: 20, y: 30, width: 40, height: 20 } }] } } };
    sent.push(action); return { ok: true };
  } } });
  try {
    const work = t.store.addTask({ from: "you", to: "codex", goal: "Resize canvas", origin: "human_typed", idempotencyKey: "visual-ref" }).task;
    t.store.markDelivered([work.id], "x1");
    const observed = JSON.parse(await t.call("m9r_computer_observe", { token: t.codex, taskId: work.id, target: "app-window", representation: "visual" }));
    const ref = observed.observation.controls[0].ref;
    const args = { token: t.codex, taskId: work.id, mode: "owner-preview", action: { kind: "click_element", view: "app", ref,
      expectedRole: "button", expectedLabel: "Resize and skew", confirmFocusForeground: true }, operationId: "resize-visual" };
    await t.call("m9r_stage_action", args);
    assert.deepEqual(sent, [{ kind: "click", view: "app", x: 40, y: 40, confirmFocusForeground: true }]);
    await assert.rejects(t.call("m9r_stage_action", { ...args, action: { ...args.action, expectedLabel: "Different control" } }), /structured control reference/);
    await assert.rejects(t.call("m9r_stage_action", { ...args, action: { kind: "replace_element", view: "app", ref, text: "No native field" } }), /structured control reference/);
    assert.equal(sent.length, 1);
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

test("an exact task wait receives a structured reply without waiting for formal completion or claiming unrelated work", async () => {
  const t = setup();
  const link = { conversationId: "economical-plan", senderAgentId: "agent-claude", recipientAgentId: "agent-codex", replyDepth: 0,
    kind: "delegate" as const, summary: "Choose the door color", messageId: "plan-request" };
  try {
    const sent = t.store.addTask({ from: "claude", to: "codex", goal: link.summary, origin: "agent_initiated", standingRuleApplies: true,
      fromSession: "c1", targetSession: "x1", idempotencyKey: "plan-request", a2a: link }).task;
    const reply = t.store.addTask({ from: "codex", to: "claude", goal: "I suggest a green door.", origin: "agent_initiated", standingRuleApplies: true,
      fromSession: "x1", targetSession: "c1", idempotencyKey: "plan-answer", a2a: { ...link, messageId: "plan-answer", replyToMessageId: link.messageId,
        senderAgentId: "agent-codex", recipientAgentId: "agent-claude", replyDepth: 1, summary: "I suggest a green door." } }).task;
    const unrelated = t.store.addTask({ from: "codex", to: "claude", goal: "Unrelated work must stay queued", origin: "agent_initiated", standingRuleApplies: true,
      fromSession: "x1", targetSession: "c1", idempotencyKey: "other-answer", a2a: { ...link, messageId: "other-answer", replyToMessageId: "some-other-message" } }).task;
    t.store.setCursor("claude", "c1", 99);
    const answer = await t.call("m9r_inbox", { token: t.claude, taskId: sent.id, waitSeconds: 0 });
    assert.match(answer, /green door/);
    assert.doesNotMatch(answer, /Unrelated work/);
    assert.equal(t.store.getTask(reply.id)?.deliveredSession, "c1");
    assert.equal(t.store.getTask(unrelated.id)?.deliveredAt, undefined);
    assert.equal(t.store.getTask(sent.id)?.resultSummary, undefined, "a conversational answer does not fabricate task completion");
    assert.doesNotMatch(await t.call("m9r_inbox", { token: t.claude, taskId: sent.id, waitSeconds: 0 }), /green door/, "the exact reply is not redelivered");
  } finally { t.done(); }
});

test("a structured reply wakes an exact wait during an unfinished teammate task", async () => {
  const t = setup();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const request = t.store.addTask({ from: "claude", to: "codex", goal: "Choose a color", origin: "agent_initiated", standingRuleApplies: true,
      fromSession: "c1", targetSession: "x1", idempotencyKey: "waiting-plan", a2a: { conversationId: "waiting-plan", messageId: "waiting-question",
        senderAgentId: "agent-claude", recipientAgentId: "agent-codex", kind: "delegate", replyDepth: 0, summary: "Choose a color" } }).task;
    const started = Date.now();
    const waiting = t.call("m9r_inbox", { token: t.claude, taskId: request.id, waitSeconds: 10 });
    timer = setTimeout(() => t.store.addTask({ from: "codex", to: "claude", goal: "Let's use blue", origin: "agent_initiated", standingRuleApplies: true,
      fromSession: "x1", targetSession: "c1", idempotencyKey: "waiting-answer", a2a: { conversationId: "waiting-plan", messageId: "waiting-answer", replyToMessageId: "waiting-question",
        senderAgentId: "agent-codex", recipientAgentId: "agent-claude", kind: "edit-confirmation", replyDepth: 1, summary: "Let's use blue" } }), 300);
    assert.match(await waiting, /Let's use blue/);
    assert.ok(Date.now() - started < 3000, "returns on the answer instead of spending the full wait budget");
    assert.equal(t.store.getTask(request.id)?.resultSummary, undefined);
  } finally { if (timer) clearTimeout(timer); t.done(); }
});

test("an explicitly selected structured answer prevents a duplicate result reply and survives retry", async () => {
  let forwarded: string | undefined;
  let resultStore: ReturnType<typeof createLocalStore>;
  const t = setup({ web: { recordAgentTaskResult: async (token, id, summary, completion, handled, replyMessageId) => {
    forwarded = replyMessageId; return resultStore.recordTaskResult(token, id, summary, completion, handled, replyMessageId);
  } } });
  resultStore = t.store;
  try {
    const request = t.store.addTask({ from: "claude", to: "codex", goal: "Verify the value", origin: "agent_initiated", standingRuleApplies: true,
      fromSession: "c1", targetSession: "x1", idempotencyKey: "explicit-question", a2a: { conversationId: "explicit-answer", messageId: "explicit-question",
        senderAgentId: "agent-claude", recipientAgentId: "agent-codex", kind: "verification-request", replyDepth: 0, summary: "Verify the value" } }).task;
    t.store.markDelivered([request.id], "x1");
    const reply = t.store.addTask({ from: "codex", to: "claude", goal: "The independently checked value is 42", origin: "agent_initiated", standingRuleApplies: true,
      fromSession: "x1", targetSession: "c1", idempotencyKey: "explicit-answer", a2a: { conversationId: "explicit-answer", messageId: "explicit-answer",
        replyToMessageId: "explicit-question", senderAgentId: "agent-codex", recipientAgentId: "agent-claude", kind: "edit-confirmation", replyDepth: 1, summary: "The independently checked value is 42" } }).task;
    const args = { token: t.codex, taskId: request.id, summary: "The check is complete", completion: { status: "completed", remainingWork: [] } };
    await assert.rejects(t.call("m9r_result", { ...args, replyMessageId: "wrong-message" }), /replyMessageId/);
    assert.equal(t.store.getTask(request.id)?.resultSummary, undefined, "invalid suppression cannot partially complete the request");
    assert.match(await t.call("m9r_result", { ...args, replyMessageId: "explicit-answer" }), new RegExp(`already sent a structured reply.*${reply.id}`));
    assert.equal(forwarded, "explicit-answer");
    await t.call("m9r_result", args);
    assert.equal(t.store.tasksFrom("codex").length, 1, "an omitted field on a same-result retry does not generate an automatic answer");
    assert.equal(t.store.getTask(request.id)?.resultReplyMessageId, "explicit-answer");
  } finally { t.done(); }
});

test("with nothing to deliver, waitSeconds waits about that long and then says the inbox is empty", async () => {
  const t = setup();
  const started = Date.now();
  assert.equal(await t.call("m9r_inbox", { token: t.codex, waitSeconds: 1 }), "Inbox is empty.");
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 900 && elapsed < 3_000, `waited ${elapsed}ms`);
  t.done();
});

test("conversation delivery does not repeat the desktop guide needed by a new assignment", async () => {
  const t = setup({ web: { prepareTaskStage: async () => ({ ok: true }) } });
  try {
    writeFileSync(join(t.store.root, "task-stage-policy.json"), JSON.stringify({ version: 1, handles: ["codex"] }));
    t.store.addTask({ from: "claude", to: "codex", goal: "Inspect the artifact", origin: "agent_initiated", standingRuleApplies: true,
      fromSession: "c1", targetSession: "x1", idempotencyKey: "new-assignment" });
    assert.match(await t.call("m9r_inbox", { token: t.codex, waitSeconds: 0 }), /M9R desktop tools are available/);
    t.store.addTask({ from: "claude", to: "codex", goal: "The artifact is ready for your check", origin: "agent_initiated", standingRuleApplies: true,
      fromSession: "c1", targetSession: "x1", idempotencyKey: "review-ready", a2a: { conversationId: "review", messageId: "review-ready",
        senderAgentId: "agent-claude", recipientAgentId: "agent-codex", kind: "verification-request", replyDepth: 0, summary: "The artifact is ready for your check" } });
    const context = await t.call("m9r_inbox", { token: t.codex, waitSeconds: 0 });
    assert.match(context, /artifact is ready/);
    assert.doesNotMatch(context, /M9R desktop tools are available|The normal mode is/);
  } finally { t.done(); }
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

test("delegationParentFor authorizes from the most recent assignment instead of refusing when a session has leftover open work", async () => {
  // Requiring exactly one qualifying candidate meant a single leftover stale task (one the
  // session never explicitly closed out) silently blocked every new delegation from that
  // session, even with a fresh, clearly-current task also in flight. Confirmed live: Codex
  // had two open tasks (a stale one plus the fresh one from the exact turn in progress) and
  // its own teammate message sat pending with nothing to authorize it.
  const t = setup();
  try {
    const stale = t.store.addTask({
      from: "claude", to: "codex", goal: "An earlier request codex never explicitly closed out.", origin: "agent_initiated",
      fromSession: "c1", standingRuleApplies: true, idempotencyKey: "delegation-parent-stale",
    }).task;
    t.store.markDelivered([stale.id], "x1");

    const fresh = t.store.addTask({
      from: "claude", to: "codex", goal: "The current turn codex is actually working on.", origin: "agent_initiated",
      fromSession: "c1", standingRuleApplies: true, idempotencyKey: "delegation-parent-fresh",
    }).task;
    t.store.markDelivered([fresh.id], "x1");

    assert.equal(t.store.tasksFor("codex").filter((task) => !task.resultSummary).length, 2,
      "this fixture must reproduce two simultaneously open tasks for the same session");
    const parent = t.store.delegationParentFor("codex", "x1", "Report back on the current turn.");
    assert.ok(parent, "a session with more than one open task must still resolve a delegation parent");
    assert.equal(parent.id, fresh.id, "the most recently delivered task is treated as the actual current assignment");

    const sendResult = await t.call("m9r_send", { token: t.codex, to: "claude", goal: "Report back on the current turn." });
    assert.match(sendResult, /Sent to @claude as task T\d+\./, "delegation inherits approval instead of landing pending");
  } finally { t.done(); }
});

test("m9r_send never claims a message was sent when it actually landed pending", async () => {
  // M9R told the sending agent "Sent to @X as task T..." even when the task's own
  // approval was still "pending" and no delivery had happened -- confirmed live, Codex
  // was told its message was sent while it silently sat withheld for owner approval.
  const t = setup({ allowRule: false });
  try {
    const sendResult = await t.call("m9r_send", { token: t.codex, to: "claude", goal: "No standing rule covers this pair." });
    const taskId = sendResult.match(/as (T\d+)/)?.[1];
    assert.ok(taskId, "the reply must still name the created task");
    assert.equal(t.store.getTask(taskId!)?.approval, "pending", "this fixture must reproduce the exact pending shape");
    assert.doesNotMatch(sendResult, /Sent to @claude/, "must not claim delivery for a task that is actually still pending");
    assert.match(sendResult, /awaiting owner approval/);
  } finally { t.done(); }
});

test("a completed informational update does not generate an acknowledgement, while an incomplete outcome is returned", async () => {
  const t = setup();
  try {
    const makeUpdate = (key: string) => t.store.addTask({ from: "claude", to: "codex", goal: "I'm preparing the document.",
      origin: "agent_initiated", fromSession: "c1", targetSession: "x1", standingRuleApplies: true, idempotencyKey: key,
      a2a: { taskId: "T90", conversationId: "update-room", messageId: key, senderAgentId: "agent-claude", recipientAgentId: "agent-codex",
        replyDepth: 0, kind: "update", summary: "I'm preparing the document." } }).task;
    const update = makeUpdate("informational-message");
    t.store.markDelivered([update.id], "x1");
    const response = await t.call("m9r_result", { token: t.codex, taskId: update.id, summary: "Noted the update.",
      completion: { status: "completed", remainingWork: [] } });
    assert.match(response, /No automatic reply was queued/);
    assert.equal(t.store.getTask(update.id)?.receipt?.state, "completed");
    assert.equal(t.store.tasksFor("claude").filter(task => task.replyToTaskId === update.id).length, 0);
    const blocked = makeUpdate("informational-blocker");
    t.store.markDelivered([blocked.id], "x1");
    await t.call("m9r_result", { token: t.codex, taskId: blocked.id, summary: "I need clarification before proceeding.",
      completion: { status: "incomplete", remainingWork: ["Clarify which document"] } });
    assert.ok(t.store.tasksFor("claude").some(task => task.replyToTaskId === blocked.id && task.goal.includes("Clarify which document")),
      "a genuine blocker is still returned to the sender");
    const conversational = makeUpdate("update-with-question");
    t.store.markDelivered([conversational.id], "x1");
    const reply = t.store.addTask({ from: "codex", to: "claude", goal: "Which document format should I use?", origin: "agent_initiated",
      standingRuleApplies: true, fromSession: "x1", targetSession: "c1", idempotencyKey: "meaningful-question",
      a2a: { taskId: "T90", conversationId: "update-room", messageId: "meaningful-question", senderAgentId: "agent-codex",
        recipientAgentId: "agent-claude", replyDepth: 1, replyToMessageId: conversational.a2a!.messageId,
        kind: "help-request", summary: "Which document format should I use?" } }).task;
    t.store.setDelivery(reply.id, { state: "deferred" });
    const explicit = await t.call("m9r_result", { token: t.codex, taskId: conversational.id, summary: "Asked about the format.",
      completion: { status: "completed", remainingWork: [] }, replyMessageId: "meaningful-question" });
    assert.match(explicit, /already sent a structured reply/);
    assert.equal(t.store.tasksFor("claude").filter(task => task.id === reply.id || task.replyToTaskId === conversational.id).length, 1,
      "a real question survives and no duplicate result is sent");
    const request = t.store.addTask({ from: "claude", to: "codex", goal: "Please check the file.", origin: "agent_initiated",
      standingRuleApplies: true, fromSession: "c1", targetSession: "x1", idempotencyKey: "real-request",
      a2a: { taskId: "T90", conversationId: "request-room", messageId: "request-message", senderAgentId: "agent-claude",
        recipientAgentId: "agent-codex", replyDepth: 0, kind: "verification-request", summary: "Please check the file." } }).task;
    t.store.markDelivered([request.id], "x1");
    await t.call("m9r_result", { token: t.codex, taskId: request.id, summary: "The file is correct.",
      completion: { status: "completed", remainingWork: [] } });
    assert.ok(t.store.tasksFor("claude").some(task => task.replyToTaskId === request.id && task.goal.includes("The file is correct")),
      "a genuine request still returns its result");
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
    // "uncertain", not "paused" -- a self-reported incomplete result must stay
    // a non-terminal state so a later real completion for this same task is
    // still accepted (recordTaskResult refuses any further call once a task
    // is actually "paused", which is reserved for an owner-initiated pause).
    assert.equal(t.store.getTask(incomplete.id)?.receipt?.state, "uncertain");
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

test("an uncertain receipt stops acting as the pending task, matching the desktop stage's taskActive() exclusion", async () => {
  const dispatched: string[] = [];
  const t = setup({ web: { taskStageAction: async (_token, taskId) => {
    dispatched.push(taskId); return { ok: true, result: { actionExecuted: true } };
  } } });
  try {
    const stale = t.store.addTask({ from: "you", to: "codex", goal: "Start work", origin: "human_typed", idempotencyKey: "uncertain-stale" }).task;
    t.store.markDelivered([stale.id], "x1");
    // An incomplete self-reported result leaves the receipt "uncertain" (see the
    // assertion above), not "paused" or "canceled" -- before this fix, pendingTasksFor
    // still offered this task to a caller that omitted taskId, letting a later
    // unrelated action silently dispatch against stale, already-abandoned work.
    t.store.recordTaskResult(t.codex, stale.id, "Partial check.", { status: "incomplete", remainingWork: ["Finish."] });
    assert.equal(t.store.getTask(stale.id)?.receipt?.state, "uncertain");
    await assert.rejects(
      t.call("m9r_stage_action", { token: t.codex, operationId: "uncertain-op-1", action: { kind: "cursor", x: 2, y: 3 } }),
      /no currently pending task/,
    );
    assert.equal(dispatched.length, 0, "the uncertain task must never be the implicit dispatch target");

    const fresh = t.store.addTask({ from: "you", to: "codex", goal: "New owner instruction", origin: "human_typed", idempotencyKey: "uncertain-fresh" }).task;
    t.store.markDelivered([fresh.id], "x1");
    await t.call("m9r_stage_action", { token: t.codex, operationId: "uncertain-op-2", action: { kind: "cursor", x: 2, y: 3 } });
    assert.equal(dispatched[0], fresh.id, "a fresh task is still selectable once it exists");
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

test("a teammate's plain result reply surfaces mid-turn even though it carries no a2a link", async () => {
  // queueAgentReply (local-store.ts) answers an agent-initiated task with a
  // plain agent-initiated task tagged only with replyToTaskId -- it never
  // sets `a2a`. afterTool's piggyback used to require `task.a2a`, so this
  // exact reply shape was invisible to the sender until its own turn ended
  // on its own. Confirmed live: Claude's 7-minute turn never surfaced
  // Codex's reply even though it existed in the inbox the whole time.
  const storeRoot = mkdtempSync(join(tmpdir(), "m9r-mcp-inbox-reply-"));
  const store = createLocalStore(storeRoot);
  store.addRule({ from: "claude", to: "codex", ttlMs: 3_600_000 });
  const claudeConn = await connectMcp(store, "m9r-inbox-reply-claude");
  const codexConn = await connectMcp(store, "m9r-inbox-reply-codex");
  try {
    const claudeToken = store.issueIdentity("claude", "claude-code", "claude-reply-session").token;
    const codexToken = store.issueIdentity("codex", "codex", "codex-reply-session").token;

    const sendResult = await claudeConn.client.callTool({
      name: "m9r_send",
      arguments: { token: claudeToken, to: "codex", goal: "Write the first half, then reply with your result." },
    });
    assert.match(mcpText(sendResult), /Sent to @codex as task T\d+\./);
    const delegated = store.tasksFor("codex").find((item) => item.goal.includes("first half"));
    assert.ok(delegated, "the delegated task was created");
    store.markDelivered([delegated.id], "codex-reply-session");

    const resultResult = await codexConn.client.callTool({
      name: "m9r_result",
      arguments: { token: codexToken, taskId: delegated.id, summary: "Wrote the first half.", completion: { status: "completed", remainingWork: [] } },
    });
    assert.match(mcpText(resultResult), /Recorded result/);
    const reply = store.tasksFor("claude").find((item) => item.replyToTaskId === delegated.id);
    assert.ok(reply, "queueAgentReply created the auto-reply task");
    assert.equal(reply.a2a, undefined, "this reply shape genuinely carries no a2a link");
    assert.ok(reply.approval === "approved" || reply.approval === "not_needed", "the reply is pre-approved, so it is eligible for piggyback delivery");

    // Claude's own turn is still "running" (no Stop, no new m9r_inbox poll) --
    // the only way it can hear this is the mid-turn afterTool piggyback.
    const noteDuringTurn = await claudeConn.client.callTool({
      name: "m9r_note",
      arguments: { token: claudeToken, action: "list", room: "coordination-test-room" },
    });
    const noteText = mcpText(noteDuringTurn);
    assert.match(noteText, /New teammate conversation context/);
    assert.match(noteText, new RegExp(`@codex.*${delegated.id}`));
    assert.match(noteText, /Wrote the first half/);
  } finally {
    await Promise.all([claudeConn.client.close(), claudeConn.server.close(), codexConn.client.close(), codexConn.server.close()]);
    rmSync(storeRoot, { recursive: true, force: true });
  }
});

test("team-message schema exposes informational updates without normalizing them into work requests", async () => {
  let received: Record<string, unknown> | undefined;
  const t = setup({ web: { sendA2A: async (_token, input) => { received = input as unknown as Record<string, unknown>;
    return { ok: true, message: { messageId: "update-message", conversationId: "update-thread" },
      delivery: { state: "queued", taskId: "T99" }, recipientAgentIds: ["codex"] } as never; } } });
  try {
    const args = { token: t.claude, to: "codex", taskId: "T1", summary: "I'm preparing the document.",
      kind: "update", progressKind: "observation", progressFingerprint: "preparing" };
    const schema = (t.server as unknown as ToolServer)._registeredTools.m9r_team_message.inputSchema as { safeParse(input: unknown): { success: boolean } };
    assert.equal(schema.safeParse(args).success, true);
    await t.call("m9r_team_message", args);
    assert.equal(received?.kind, "update");
    assert.equal(received?.summary, args.summary);
    await assert.rejects(t.call("m9r_team_message", { ...args, progressFingerprint: undefined }), /progressFingerprint/);
  } finally { t.done(); }
});

test("long progress messages preserve their text and normalize progress routing before broker delivery", async () => {
  let received: Record<string, unknown> | undefined;
  const t = setup({ web: { sendA2A: async (_token, input) => { received = input as unknown as Record<string, unknown>;
    return { ok: true, message: { messageId: "long-progress", conversationId: "progress-thread" }, delivery: { state: "queued", taskId: "T99" }, recipientAgentIds: ["codex"] } as never; } } });
  try {
    const summary = "The saved file was checked and the next step is ready. ".repeat(8);
    const args = { token: t.claude, to: "codex", taskId: "T1", summary, kind: "operation-completed", progressFingerprint: "save-checked" };
    const schema = (t.server as unknown as ToolServer)._registeredTools.m9r_team_message.inputSchema as { safeParse(input: unknown): { success: boolean } };
    assert.equal(schema.safeParse(args).success, true);
    await t.call("m9r_team_message", args);
    assert.equal(received?.kind, "delegate");
    assert.equal(received?.progressKind, "operation-completed");
    assert.equal((received?.summary as string).length, 280);
    assert.equal((received?.details as Record<string, string>).messageText, summary, "long messages are not silently truncated");
  } finally { t.done(); }
});

test("structured teammate messages publish participant-labelled pill activity once", async () => {
  let duplicate = false;
  const notices: Array<{ agent: string; to: string; text: string }> = [];
  const t = setup({ web: {
    sendA2A: async (_token, input) => ({ ok: true, duplicate,
      message: { messageId: "message-visible", conversationId: "conversation-visible" },
      delivery: { state: "queued", taskId: "T100", created: !duplicate }, recipientAgentIds: ["codex"] }) as never,
    notifyMessage: async message => { notices.push(message); return true; },
  } });
  try {
    const args = { token: t.claude, to: "codex", summary: "I'll write the checklist.\nPlease verify the saved result.",
      kind: "delegate", priority: "normal", taskId: "T1", progressFingerprint: "plan-1", progressKind: "observation" };
    await t.call("m9r_team_message", args);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].agent, "claude");
    assert.equal(notices[0].to, "codex");
    assert.equal(notices[0].text, args.summary);
    duplicate = true;
    await t.call("m9r_team_message", args);
    assert.equal(notices.length, 1, "idempotent replay must not add a second conversation bubble");
  } finally { t.done(); }
});

test("native action boundaries include new peer context once without claiming another turn", async () => {
  const dispatched: string[] = [];
  const t = setup({ web: { taskStageAction: async (_token, taskId) => {
    dispatched.push(taskId); return { ok: true, result: { actionExecuted: true } };
  } } });
  try {
    const work = t.store.addTask({ from: "you", to: "codex", goal: "Write the checklist", origin: "human_typed", idempotencyKey: "peer-work" }).task;
    t.store.markDelivered([work.id], "x1");
    const peer = t.store.addTask({ from: "claude", to: "codex", goal: "I'll verify the file after you save.",
      origin: "agent_initiated", standingRuleApplies: true, fromSession: "c1", idempotencyKey: "peer-context",
      a2a: { conversationId: "conversation-checklist", messageId: "message-checklist", senderAgentId: "agent-claude",
        recipientAgentId: "agent-codex", replyDepth: 0, kind: "help-result", summary: "I'll verify the file after you save." } }).task;
    const handler = (t.server as unknown as ToolServer)._registeredTools.m9r_stage_action.handler as
      (args: unknown, extra: { requestId: number }) => Promise<{ content: Array<{ type: string; text: string }> }>;
    const args = { token: t.codex, taskId: work.id, action: { kind: "cursor", x: 2, y: 3 } };
    const first = await handler(args, { requestId: 501 });
    assert.ok(first.content.some(block => block.text.includes("@claude → @codex")));
    assert.ok(first.content.some(block => block.text.includes("not owner authorization")));
    assert.equal(t.store.getTask(peer.id)?.deliveredAt, undefined, "context does not claim the queued peer task");
    assert.equal(dispatched[0], work.id);
    const second = await handler(args, { requestId: 502 });
    assert.equal(second.content.some(block => block.text.includes("@claude → @codex")), false);
    assert.equal(dispatched[1], work.id);
  } finally { t.done(); }
});

test("a result durably resolves only explicitly handled peer context without acknowledgement tasks", async () => {
  const t = setup({ web: { taskStageAction: async () => ({ ok: true, result: { actionExecuted: true } }) } });
  try {
    const work = t.store.addTask({ from: "you", to: "codex", goal: "Finish the checklist", origin: "human_typed", idempotencyKey: "resolve-work" }).task;
    t.store.markDelivered([work.id], "x1");
    const addPeer = (key: string) => t.store.addTask({ from: "claude", to: "codex", goal: key,
      origin: "agent_initiated", targetSession: "x1", fromSession: "c1", standingRuleApplies: true, idempotencyKey: key,
      a2a: { conversationId: "conversation-resolve", messageId: key, senderAgentId: "agent-claude", recipientAgentId: "agent-codex",
        replyDepth: 0, kind: "help-request", summary: key } }).task;
    const handled = addPeer("handled-message");
    const unanswered = addPeer("unanswered-question");
    const handler = (t.server as unknown as ToolServer)._registeredTools.m9r_stage_action.handler as
      (args: unknown, extra: { requestId: number }) => Promise<{ content: Array<{ text: string }> }>;
    const response = await handler({ token: t.codex, taskId: work.id, action: { kind: "cursor", x: 1, y: 1 } }, { requestId: 601 });
    assert.ok(response.content.some(block => block.text.includes(`Task: ${handled.id}`)));
    const unseen = addPeer("new-blocker-after-presentation");
    await assert.rejects(t.call("m9r_result", { token: t.codex, taskId: work.id, summary: "Done", completion: { status: "completed", remainingWork: [] },
      handledPeerTaskIds: [unseen.id] }), /Only peer messages shown/);
    const count = t.store.snapshot().tasks.length;
    const args = { token: t.codex, taskId: work.id, summary: "Finished checklist and answered the first request", completion: { status: "completed", remainingWork: [] }, handledPeerTaskIds: [handled.id] };
    await t.call("m9r_result", args);
    const reopened = createLocalStore(t.store.root);
    assert.equal(reopened.getTask(handled.id)?.receipt?.state, "completed");
    assert.match(reopened.getTask(handled.id)!.resultSummary!, /Handled during/);
    for (const task of [unanswered, unseen]) {
      assert.equal(reopened.getTask(task.id)?.resultSummary, undefined);
      assert.equal(reopened.getTask(task.id)?.deliveredAt, undefined, "unresolved/new messages remain eligible for their own turn");
    }
    assert.equal(reopened.snapshot().tasks.length, count, "resolving context creates no acknowledgement task");
    await t.call("m9r_result", args);
    assert.equal(t.store.snapshot().tasks.length, count, "repeating the result is idempotent");
    const denied = t.store.recordTaskResult(t.codex, work.id, args.summary, { status: "completed", remainingWork: [] }, [work.id]);
    assert.equal(denied.ok, false, "the broker independently refuses arbitrary owner tasks as peer acknowledgements");
  } finally { t.done(); }
});

test("prompt-delivered peer messages can be reconciled after reconnect and current-task acknowledgement is redundant", async () => {
  const t = setup();
  try {
    const work = t.store.addTask({ from: "you", to: "codex", goal: "Finish work", origin: "human_typed", idempotencyKey: "prompt-root" }).task;
    t.store.markDelivered([work.id], "x1");
    const peer = t.store.addTask({ from: "claude", to: "codex", goal: "Verification complete", origin: "agent_initiated",
      standingRuleApplies: true, targetSession: "x1", replyToTaskId: work.id, idempotencyKey: "prompt-peer" }).task;
    t.store.markDelivered([peer.id], "x1");
    await t.call("m9r_result", { token: t.codex, taskId: work.id, summary: "Verified and finished",
      completion: { status: "completed", remainingWork: [] }, handledPeerTaskIds: [work.id, peer.id] });
    assert.equal(t.store.getTask(work.id)?.receipt?.state, "completed");
    assert.equal(t.store.getTask(peer.id)?.receipt?.state, "completed");
  } finally { t.done(); }
});

test("root completion survives reconstructed MCP context without inferring completion from a child or accepting foreign acknowledgements", async () => {
  const t = setup();
  try {
    const root = t.store.addTask({ from: "you", to: "codex", goal: "Draw, save, and verify", origin: "human_typed", broadcastId: "closure-broadcast", idempotencyKey: "closure-root" }).task;
    const otherRoot = t.store.addTask({ from: "you", to: "claude", goal: "Draw, save, and verify", origin: "human_typed", broadcastId: "closure-broadcast", idempotencyKey: "closure-other-root" }).task;
    t.store.markDelivered([root.id], "x1");
    await t.call("m9r_result", { token: t.codex, taskId: root.id, summary: "Drawing remains unfinished",
      completion: { status: "incomplete", remainingWork: ["Save and verify"] } });
    const child = t.store.addTask({ from: "claude", to: "codex", goal: "Verify saved drawing", origin: "agent_initiated",
      standingRuleApplies: true, fromSession: "c1", targetSession: "x1", replyToTaskId: root.id, idempotencyKey: "closure-child",
      a2a: { taskId: otherRoot.id, conversationId: "closure-conversation", messageId: "closure-message", senderAgentId: "agent-claude",
        recipientAgentId: "agent-codex", replyDepth: 0, kind: "verification-request", summary: "Verify the saved drawing" } }).task;
    t.store.markDelivered([child.id], "x1");
    const reopened = createLocalStore(t.store.root);
    const freshServer = createM9rMcpServer({ store: reopened });
    try {
      const report = (args: unknown) => (freshServer as unknown as ToolServer)._registeredTools.m9r_result.handler(args);
      // No task id means the current child, not the older owner objective.
      const childResult = await report({ token: t.codex, summary: "Verified saved drawing", completion: { status: "completed", remainingWork: [] }, handledPeerTaskIds: [child.id] });
      assert.match(childResult.content[0].text, new RegExp(`not owner task ${root.id}`));
      assert.equal(reopened.getTask(child.id)?.receipt?.state, "completed");
      assert.equal(reopened.getTask(root.id)?.receipt?.state, "uncertain", "a child's success cannot silently close its parent");
      const foreign = reopened.addTask({ from: "claude", to: "codex", goal: "Other session", origin: "agent_initiated",
        standingRuleApplies: true, targetSession: "another-session", replyToTaskId: root.id, idempotencyKey: "closure-foreign" }).task;
      reopened.markDelivered([foreign.id], "another-session");
      await assert.rejects(report({ token: t.codex, taskId: root.id, summary: "Everything complete",
        completion: { status: "completed", remainingWork: [] }, handledPeerTaskIds: [foreign.id] }), /Only peer messages shown/);
      assert.equal(reopened.getTask(root.id)?.receipt?.state, "uncertain", "a rejected report must not partially complete the root");
      await report({ token: t.codex, taskId: root.id, summary: "Drawing saved and independently verified",
        completion: { status: "completed", remainingWork: [] }, handledPeerTaskIds: [root.id, child.id] });
      assert.equal(reopened.getTask(root.id)?.receipt?.state, "completed");
      assert.equal(reopened.getTask(otherRoot.id)?.resultSummary, undefined, "one agent cannot complete another agent's owner assignment");
      assert.equal(reopened.getTask(foreign.id)?.resultSummary, undefined);
      assert.deepEqual(reopened.getTask(root.id)?.completion?.remainingWork, []);
    } finally { await freshServer.close(); }
  } finally { t.done(); }
});

test("a verified peer handoff can explicitly complete its linked owner assignment in the same result call", async () => {
  const t = setup();
  try {
    const owner = t.store.addTask({ from: "you", to: "codex", goal: "Append, verify, and save", origin: "human_typed", broadcastId: "handoff", idempotencyKey: "owner-codex" }).task;
    const peerOwner = t.store.addTask({ from: "you", to: "claude", goal: "Append, verify, and save", origin: "human_typed", broadcastId: "handoff", idempotencyKey: "owner-claude" }).task;
    t.store.markDelivered([owner.id], "x1");
    await t.call("m9r_result", { token: t.codex, taskId: owner.id, summary: "Waiting for the handoff",
      completion: { status: "incomplete", remainingWork: ["Append, verify, and save"] } });
    const child = t.store.addTask({ from: "claude", to: "codex", goal: "Ready for you to append", origin: "agent_initiated",
      standingRuleApplies: true, fromSession: "c1", targetSession: "x1", idempotencyKey: "handoff-child",
      a2a: { taskId: peerOwner.id, conversationId: "handoff-conversation", messageId: "handoff-message", senderAgentId: "agent-claude",
        recipientAgentId: "agent-codex", replyDepth: 0, kind: "surface-handoff", summary: "Ready for you to append" } }).task;
    t.store.markDelivered([child.id], "x1");
    const report = (t.server as unknown as ToolServer)._registeredTools.m9r_result.handler;
    const result = { token: t.codex, taskId: child.id, summary: "Appended the second activity and saved",
      completion: { status: "completed", remainingWork: [] },
      ownerTaskResult: { taskId: owner.id, summary: "Both activities verified in the saved file", completion: { status: "completed", remainingWork: [] } } };
    await assert.rejects(report({ ...result, ownerTaskResult: { ...result.ownerTaskResult, taskId: peerOwner.id } }), /linked owner task/);
    assert.equal(t.store.getTask(child.id)?.receipt?.state, "provider_received", "invalid owner routing records neither result");
    assert.equal(t.store.getTask(owner.id)?.receipt?.state, "uncertain");
    const response = await report(result);
    assert.match(response.content[0].text, new RegExp(`Explicitly recorded the linked owner result for ${owner.id}`));
    assert.equal(t.store.getTask(child.id)?.receipt?.state, "completed");
    assert.equal(t.store.getTask(owner.id)?.receipt?.state, "completed");
    assert.notEqual(t.store.getTask(peerOwner.id)?.receipt?.state, "completed", "one agent cannot complete a teammate's owner task");
    const repeated = await report(result);
    assert.match(repeated.content[0].text, new RegExp(`Explicitly recorded the linked owner result for ${owner.id}`),
      "a retry after a lost response reuses the same recorded outcomes");
  } finally { t.done(); }
});

test("a broker refusal of the linked owner result is reported without undoing or inventing the peer result", async () => {
  const t = setup();
  try {
    const owner = t.store.addTask({ from: "you", to: "codex", goal: "Save the file", origin: "human_typed", idempotencyKey: "partial-owner" }).task;
    t.store.markDelivered([owner.id], "x1");
    await t.call("m9r_result", { token: t.codex, taskId: owner.id, summary: "Waiting for review",
      completion: { status: "incomplete", remainingWork: ["Verify the file"] } });
    const child = t.store.addTask({ from: "claude", to: "codex", goal: "Review the file", origin: "agent_initiated",
      standingRuleApplies: true, targetSession: "x1", fromSession: "c1", replyToTaskId: owner.id, idempotencyKey: "partial-child" }).task;
    t.store.markDelivered([child.id], "x1");
    const remote = createM9rMcpServer({ store: t.store, web: { recordAgentTaskResult: async (token, taskId, summary, completion, handled, reply) =>
      taskId === owner.id ? { ok: false, error: "temporary store refusal" } : t.store.recordTaskResult(token, taskId, summary, completion, handled, reply) } });
    try {
      const report = (remote as unknown as ToolServer)._registeredTools.m9r_result.handler;
      const response = await report({ token: t.codex, taskId: child.id, summary: "File verified", completion: { status: "completed", remainingWork: [] },
        ownerTaskResult: { taskId: owner.id, summary: "Saved file verified", completion: { status: "completed", remainingWork: [] } } });
      assert.match(response.content[0].text, /peer result was recorded, but the linked owner result was not: temporary store refusal/);
      assert.equal(t.store.getTask(child.id)?.receipt?.state, "completed");
      assert.equal(t.store.getTask(owner.id)?.receipt?.state, "uncertain");
    } finally { await remote.close(); }
  } finally { t.done(); }
});

test("explicit task selection survives older operation activity and is invalidated by pause", async () => {
  const dispatched: string[] = [];
  const t = setup({ web: { taskStageAction: async (_token, taskId) => {
    dispatched.push(taskId); return { ok: true, result: { actionExecuted: true } };
  } } });
  try {
    const older = t.store.addTask({ from: "you", to: "codex", goal: "Start work", origin: "human_typed", idempotencyKey: "selection-old" }).task;
    t.store.markDelivered([older.id], "x1");
    t.store.claimStageOperation({ handle: "codex", sessionId: "x1", taskId: older.id, operationId: "prior-action", fingerprint: "a".repeat(64) });
    const current = t.store.addTask({ from: "you", to: "codex", goal: "Continue handoff", origin: "human_typed", idempotencyKey: "selection-current" }).task;
    t.store.markDelivered([current.id], "x1");
    const args = { token: t.codex, operationId: "selection-cursor", action: { kind: "cursor", x: 2, y: 3 } };
    await t.call("m9r_stage_action", { ...args, taskId: current.id });
    await t.call("m9r_stage_action", args);
    assert.deepEqual(dispatched, [current.id, current.id]);
    t.store.pauseTask(current.id);
    t.store.pauseTask(older.id);
    const next = t.store.addTask({ from: "you", to: "codex", goal: "New owner instruction", origin: "human_typed", idempotencyKey: "selection-next" }).task;
    t.store.markDelivered([next.id], "x1");
    await t.call("m9r_stage_action", args);
    assert.equal(dispatched[2], next.id, "a paused selection cannot retain control");
  } finally { t.done(); }
});

test("a fresh explicitly selected observation can act despite an older task's operation receipt", async () => {
  const dispatched: string[] = [];
  const t = setup({ web: {
    prepareTaskStage: async () => ({ ok: true }),
    taskStageAction: async (_token, taskId, rawAction) => {
      const action = rawAction as { kind: string };
      if (action.kind === "read_structure") return { ok: true, result: {
        status: "partial", elements: [{ ref: "uia:1", label: "Action", role: "Button", enabled: true,
          actions: ["invoke"], rect: { x: 1, y: 2, width: 50, height: 20 } }],
        fallbackCapture: { dataUrl: "data:image/png;base64,eA==", width: 300, height: 200, capturedAt: new Date().toISOString() }
      } };
      dispatched.push(taskId);
      return { ok: true, result: { outcome: { status: "confirmed" }, operationReceipt: { status: "applied" }, actionExecuted: true } };
    }
  } });
  try {
    const older = t.store.addTask({ from: "you", to: "codex", goal: "Original work", origin: "human_typed", idempotencyKey: "observe-old" }).task;
    t.store.markDelivered([older.id], "x1");
    t.store.claimStageOperation({ handle: "codex", sessionId: "x1", taskId: older.id, operationId: "old-operation", fingerprint: "b".repeat(64) });
    const current = t.store.addTask({ from: "you", to: "codex", goal: "Handoff", origin: "human_typed", idempotencyKey: "observe-current" }).task;
    t.store.markDelivered([current.id], "x1");
    const observed = JSON.parse(await t.call("m9r_computer_observe", { token: t.codex, taskId: current.id, target: "app-window" }));
    const target = observed.target;
    const result = JSON.parse(await t.call("m9r_computer_action", { token: t.codex, action: {
      kind: "click", operationId: "handoff-click", targetId: target.targetId, targetRevision: target.revision,
      locator: { kind: "element", ref: observed.observation.controls[0].ref, snapshotId: target.revision },
      postcondition: { kind: "accessible-control-present", label: "Action" }
    } }));
    assert.notEqual(result.result?.error?.code, "task-context-changed");
    assert.deepEqual(dispatched, [current.id]);
  } finally { t.done(); }
});
