import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildQueueMessage, canQueue, findQueuedResult, interpretQueueExit, isThreadId, queueArgs, queueMarker, resolveCodexCommand, resultSummary } from "../src/lib/native/codex-delivery-core";
import { collectCodexResults, deliverToCodex, type DeliveryDeps } from "../src/lib/native/codex-delivery";
import { renderInboxInjection, renderResultsInjection } from "../src/lib/native/inbox-core";
import { handleHookEvent } from "../src/lib/native/hook-handler";
import { createLocalStore } from "../src/lib/native/local-store";

const THREAD = "01a0bf78-e44a-7801-8e67-681a53f0ab68";
const newStore = () => createLocalStore(mkdtempSync(join(tmpdir(), "m9r-n2-")));

function fakeDeps(over: Partial<DeliveryDeps> = {}): DeliveryDeps & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    resolveCodex: () => ({ command: "node", args: ["codex.js"] }),
    runCodex: async (_c, args) => { calls.push(args); return { code: 0, stderr: "" }; },
    readRolloutTail: () => null,
    ...over,
  };
}

function seedCodex(store: ReturnType<typeof newStore>) {
  store.registerEndpoint({ provider: "codex", sessionId: THREAD, cwd: "C:/p" });
}
const typed = (store: ReturnType<typeof newStore>, goal = "Review lease.ts", key = "k1") =>
  store.addTask({ from: "claude", to: "codex", goal, origin: "human_typed", idempotencyKey: key }).task;

test("only tasks a human typed or approved may be queued; everything else is never pushed", () => {
  assert.equal(canQueue({ origin: "human_typed", approval: "not_needed" }), true);
  assert.equal(canQueue({ origin: "agent_initiated", approval: "approved" }), true);
  assert.equal(canQueue({ origin: "agent_initiated", approval: "pending" }), false);
  assert.equal(canQueue({ origin: "human_typed", approval: "denied" }), false);
  assert.equal(canQueue({ origin: "agent_initiated", approval: "expired" }), false);
});

test("the queue message carries the marker and the goal, and the arguments are a plain array", () => {
  const msg = buildQueueMessage({ id: "T7", from: "claude", goal: "Review lease.ts" });
  assert.ok(msg.startsWith(queueMarker("T7")));
  assert.match(msg, /Review lease\.ts/);
  assert.deepEqual(queueArgs(THREAD, "a \"quoted\" message"), ["queue", "--thread", THREAD, "--message", "a \"quoted\" message"]);
  assert.equal(isThreadId(THREAD), true);
  assert.equal(isThreadId("--evil"), false);
  assert.equal(isThreadId(undefined), false);
});

test("Windows runs the JS entry behind codex.cmd with node instead of a shell; POSIX runs the binary", () => {
  const win = resolveCodexCommand({ platform: "win32", pathDirs: ["C:\\other", "C:\\npm"], nodePath: "C:\\node.exe", exists: (p) => p.endsWith("codex.cmd") && p.includes("npm") || p.endsWith("codex.js") });
  assert.equal(win?.command, "C:\\node.exe");
  assert.match(win?.args[0] ?? "", /@openai.codex.bin.codex\.js$/);
  const posix = resolveCodexCommand({ platform: "linux", pathDirs: ["/usr/bin", "/opt/bin"], nodePath: "node", exists: (p) => p === "/opt/bin/codex" });
  assert.deepEqual(posix, { command: "/opt/bin/codex", args: [] });
  assert.equal(resolveCodexCommand({ platform: "linux", pathDirs: ["/x"], nodePath: "node", exists: () => false }), null);
});

test("the rollout reader finds the answer to a marked task, not an earlier or later turn", () => {
  const line = (o: unknown) => JSON.stringify(o);
  const tail = [
    "cut-off first line {",
    line({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "OLD ANSWER" } }),
    line({ type: "response_item", payload: { role: "user", content: [{ type: "input_text", text: `${queueMarker("T5")} Task from @claude. Do X` }] } }),
    line({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "Did X: 3 files changed." } }),
    line({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "LATER ANSWER" } }),
  ].join("\n");
  assert.deepEqual(findQueuedResult(tail, "T5"), { seen: true, done: true, message: "Did X: 3 files changed." });
  assert.deepEqual(findQueuedResult(tail, "T9"), { seen: false, done: false });
  const running = tail.split("\n").slice(0, 3).join("\n");
  assert.deepEqual(findQueuedResult(running, "T5"), { seen: true, done: false });
  assert.match(resultSummary("T5", ""), /without a final message/);
});

test("a typed task is pushed once with the real thread id, and marked delivered", async () => {
  const store = newStore(); seedCodex(store);
  const t = typed(store);
  const deps = fakeDeps();
  const first = await deliverToCodex(store, t.id, deps);
  assert.deepEqual(first, { state: "queued", threadId: THREAD });
  assert.equal(deps.calls.length, 1);
  assert.deepEqual(deps.calls[0].slice(0, 4), ["queue", "--thread", THREAD, "--message"]);
  assert.equal(store.getTask(t.id)?.delivery?.state, "queued");
  assert.ok(store.getTask(t.id)?.deliveredAt);
  const again = await deliverToCodex(store, t.id, deps);
  assert.equal(again.state, "skipped");
  assert.equal(deps.calls.length, 1, "a duplicate dispatch never queues a second prompt");
});

test("an unapproved agent-initiated task is never queued", async () => {
  const store = newStore(); seedCodex(store);
  const t = store.addTask({ from: "claude", to: "codex", goal: "Delete the build folder", origin: "agent_initiated", idempotencyKey: "a1" }).task;
  assert.equal(t.approval, "pending");
  const deps = fakeDeps();
  assert.deepEqual(await deliverToCodex(store, t.id, deps), { state: "skipped", reason: "waiting for approval" });
  assert.equal(deps.calls.length, 0);
  store.setApproval(t.id, "approved");
  assert.equal((await deliverToCodex(store, t.id, deps)).state, "queued");
});

test("failures fall back to the inbox: no session known, codex missing, queue error", async () => {
  const noSession = newStore();
  const a = typed(noSession);
  assert.equal((await deliverToCodex(noSession, a.id, fakeDeps())).state, "failed");
  assert.equal(noSession.getTask(a.id)?.delivery?.state, "failed");
  assert.match(renderInboxInjection(noSession.tasksFor("codex"), 0).text, /Review lease\.ts/, "a failed push still shows at Codex's next prompt");

  const missing = newStore(); seedCodex(missing);
  const b = typed(missing);
  const r = await deliverToCodex(missing, b.id, fakeDeps({ resolveCodex: () => null }));
  assert.match(r.state === "failed" ? r.reason : "", /not found/);

  const broken = newStore(); seedCodex(broken);
  const c = typed(broken);
  const r2 = await deliverToCodex(broken, c.id, fakeDeps({ runCodex: async () => ({ code: 1, stderr: "thread not found\n" }) }));
  assert.match(r2.state === "failed" ? r2.reason : "", /thread not found/);
  assert.equal(interpretQueueExit({ code: null, stderr: "", spawnError: "ENOENT" }).ok, false);
  assert.equal(broken.getTask(c.id)?.delivery?.attempts, 1);
});

test("a pushed task is not injected again by Codex's own hook, and its answer reaches the sender once", async () => {
  const store = newStore(); seedCodex(store);
  const t = typed(store);
  await deliverToCodex(store, t.id, fakeDeps());
  assert.equal(renderInboxInjection(store.tasksFor("codex"), 0).text, "", "the pushed prompt is the delivery; no second copy");

  assert.equal(collectCodexResults(store, { readRolloutTail: () => "no marker here" }), 0);
  const tail = `${queueMarker(t.id)} Task\n${JSON.stringify({ payload: { type: "task_complete", last_agent_message: "Reviewed: one race in renew()." } })}`;
  assert.equal(collectCodexResults(store, { readRolloutTail: () => tail }), 1);
  assert.equal(store.getTask(t.id)?.delivery?.state, "done");
  const shown = renderResultsInjection(store.tasksFrom("claude"), "claude");
  assert.match(shown.text, /finished by @codex\] Reviewed: one race in renew\(\)\./);
  store.markResultShown(shown.ids);
  assert.equal(renderResultsInjection(store.tasksFrom("claude"), "claude").text, "");
  assert.equal(collectCodexResults(store, { readRolloutTail: () => tail }), 0, "nothing left to collect");
});

test("typing @codex in Claude dispatches the push exactly once, and the result comes back at Claude's next prompt", () => {
  const store = newStore(); seedCodex(store);
  const dispatched: string[] = [];
  const ctx = { provider: "claude-code", store, pathExists: () => false, readIndex: () => null, dispatch: (id: string) => dispatched.push(id) };
  const input = { hook_event_name: "UserPromptSubmit", session_id: "cc-1", cwd: "C:/p", prompt: "@codex please review relay/lease.ts" };
  const first = handleHookEvent(input, ctx);
  assert.match(first?.hookSpecificOutput.additionalContext ?? "", /already sent your message to @codex/);
  assert.equal(dispatched.length, 1);
  handleHookEvent(input, ctx);
  assert.equal(dispatched.length, 1, "the same prompt does not push twice");

  const id = dispatched[0];
  store.setDelivery(id, { state: "queued", threadId: THREAD });
  store.setResult(id, "Codex reviewed it: one race.");
  const next = handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "cc-1", cwd: "C:/p", prompt: "thanks" }, ctx);
  assert.match(next?.hookSpecificOutput.additionalContext ?? "", /M9R results \(1\)[\s\S]*Codex reviewed it: one race\./);
  assert.equal(handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "cc-1", cwd: "C:/p", prompt: "thanks again" }, ctx), null);
});

test("when Codex folds the queued task and the next prompt into one turn, the task still gets its own answer", () => {
  const line = (o: unknown) => JSON.stringify(o);
  const user = (text: string) => line({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
  const assistant = (text: string) => line({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }], phase: "final_answer" } });
  const echo = (text: string) => line({ type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", text } } });
  const tail = [
    user(`${queueMarker("T1")} Task from @claude. Reply with only the word: mango-pineapple`),
    echo(`${queueMarker("T1")} Task from @claude. Reply with only the word: mango-pineapple`),
    assistant("mango-pineapple"),
    user("Reply with only: resumed"),
    assistant("resumed"),
    line({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "resumed" } }),
  ].join("\n");
  assert.deepEqual(findQueuedResult(tail, "T1"), { seen: true, done: true, message: "mango-pineapple" });
  const noNextPrompt = tail.split("\n").slice(0, 3).join("\n");
  assert.deepEqual(findQueuedResult(noNextPrompt, "T1"), { seen: true, done: false }, "still working: no answer yet is not a result");
});

test("a prompt M9R pushed into Codex is not routed as a new mention (it names its sender), so Codex does the work instead of bouncing it back", () => {
  const store = newStore(); seedCodex(store);
  const task = typed(store, "Reply with only the word: live-ok");
  const pushed = buildQueueMessage(task);
  assert.match(pushed, /@claude/, "the pushed text does name @claude");
  const dispatched: string[] = [];
  const out = handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: THREAD, cwd: "C:/p", prompt: pushed }, { provider: "codex", store, pathExists: () => false, readIndex: () => null, dispatch: (id) => dispatched.push(id) });
  assert.equal(store.tasksFor("claude").length, 0, "no task was created for the sender");
  assert.equal(dispatched.length, 0);
  assert.doesNotMatch(out?.hookSpecificOutput.additionalContext ?? "", /already sent your message/, "Codex is not told to skip the work");
  // A person's own prompt with a mention still routes, so the guard is only for M9R's own pushed prompts.
  const own = handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: THREAD, cwd: "C:/p", prompt: "@claude please look at this" }, { provider: "codex", store, pathExists: () => false, readIndex: () => null });
  assert.match(own?.hookSpecificOutput.additionalContext ?? "", /already sent your message to @claude/);
});
