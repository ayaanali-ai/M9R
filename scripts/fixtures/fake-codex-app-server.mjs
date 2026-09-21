// Fake `codex app-server` (JSONL over stdio) for adapter tests. Scenario is chosen by the prompt text.
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const threads = new Map();
let nextServerRequestId = 9000;
const waitingServerRequests = new Map();
let activeTurn = null;

function serverRequest(method, params) {
  const id = nextServerRequestId++;
  return new Promise((resolve) => { waitingServerRequests.set(id, resolve); send({ id, method, params }); });
}
const delta = (threadId, turnId, text) => send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "msg-1", delta: text } });
const complete = (threadId, turn, status, error = null) => send({ method: "turn/completed", params: { threadId, turn: { id: turn, items: [], itemsView: "notLoaded", status, error, startedAt: null, completedAt: null, durationMs: null } } });

async function runTurn(threadId, turnId, text) {
  send({ method: "turn/started", params: { threadId, turn: { id: turnId, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: null, completedAt: null, durationMs: null } } });
  if (text.includes("fail-usage")) {
    send({ method: "error", params: { message: "transient", threadId, turnId } });
    return complete(threadId, turnId, "failed", { message: "You've hit your usage limit. Try again later.", codexErrorInfo: null, additionalDetails: null, misalignment: null });
  }
  if (text.includes("crash")) process.exit(3);
  if (text.includes("approval-command")) {
    send({ method: "item/started", params: { threadId, turnId, startedAtMs: 1, item: { type: "commandExecution", id: "cmd-1", command: "echo hi", cwd: process.cwd(), status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null } } });
    const answer = await serverRequest("item/commandExecution/requestApproval", { kind: "command", threadId, turnId, itemId: "cmd-1", startedAtMs: 1, environmentId: null, command: "echo hi" });
    delta(threadId, turnId, "decision:" + answer.decision);
    send({ method: "item/completed", params: { threadId, turnId, completedAtMs: 2, item: { type: "commandExecution", id: "cmd-1", command: "echo hi", cwd: process.cwd(), status: "completed", commandActions: [], aggregatedOutput: "hi", exitCode: 0 } } });
    return complete(threadId, turnId, "completed");
  }
  if (text.includes("approval-file")) {
    const item = { type: "fileChange", id: "file-1", changes: [{ path: process.cwd() + "/secret/keys.txt", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@" }], status: "inProgress" };
    send({ method: "item/started", params: { threadId, turnId, startedAtMs: 1, item } });
    const answer = await serverRequest("item/fileChange/requestApproval", { threadId, turnId, itemId: "file-1", startedAtMs: 1 });
    delta(threadId, turnId, "decision:" + answer.decision);
    return complete(threadId, turnId, "completed");
  }
  if (text.includes("unknown-request")) {
    await new Promise((resolve) => { waitingServerRequests.set(nextServerRequestId, resolve); send({ id: nextServerRequestId++, method: "item/tool/call", params: {} }); });
    delta(threadId, turnId, "survived");
    return complete(threadId, turnId, "completed");
  }
  if (text.includes("slow")) {
    activeTurn = { threadId, turnId, finish: (status) => complete(threadId, turnId, status) };
    return; // finished by turn/interrupt or steer
  }
  send({ method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: { total: { totalTokens: 30, inputTokens: 20, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0 }, last: { totalTokens: 30, inputTokens: 20, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0 }, modelContextWindow: 1000 } } });
  delta(threadId, turnId, "o");
  delta(threadId, turnId, "k");
  complete(threadId, turnId, "completed");
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined && message.id !== undefined) {
    const resolve = waitingServerRequests.get(message.id);
    if (resolve) { waitingServerRequests.delete(message.id); resolve(message.error ? { decision: "error:" + message.error.message } : message.result); }
    return;
  }
  const { id, method, params } = message;
  const reply = (result) => send({ id, result });
  if (method === "initialize") return reply({ userAgent: "fake-codex/0.0.0", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "linux" });
  if (method === "thread/start") {
    const threadId = "thread-" + (threads.size + 1);
    threads.set(threadId, { cwd: params.cwd, params });
    return reply({ thread: { id: threadId }, model: params.model ?? "fake-model", modelProvider: "fake", cwd: params.cwd });
  }
  if (method === "thread/resume") {
    if (!threads.has(params.threadId)) threads.set(params.threadId, { cwd: params.cwd, params });
    return reply({ thread: { id: params.threadId }, model: "fake-model", modelProvider: "fake", cwd: params.cwd ?? "" });
  }
  if (method === "thread/unsubscribe") { threads.delete(params.threadId); return reply({}); }
  if (method === "turn/start") {
    const turnId = "turn-" + Math.random().toString(16).slice(2, 8);
    reply({ turn: { id: turnId, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: null, completedAt: null, durationMs: null } });
    const text = params.input.map((part) => part.text ?? "").join(" ");
    setImmediate(() => { void runTurn(params.threadId, turnId, text); });
    return;
  }
  if (method === "turn/steer") {
    if (!activeTurn || activeTurn.turnId !== params.expectedTurnId) return send({ id, error: { code: -32000, message: "expectedTurnId does not match the active turn" } });
    reply({ turnId: activeTurn.turnId });
    delta(activeTurn.threadId, activeTurn.turnId, "steered:" + params.input.map((part) => part.text).join(" "));
    const turn = activeTurn; activeTurn = null;
    return turn.finish("completed");
  }
  if (method === "turn/interrupt") {
    reply({});
    if (activeTurn) { const turn = activeTurn; activeTurn = null; turn.finish("interrupted"); }
    return;
  }
  send({ id, error: { code: -32601, message: "fake server: unknown method " + method } });
});
