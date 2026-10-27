import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildQueueMessage, canQueue, findQueuedResult, interpretQueueExit, isM9rPushedPrompt, isThreadId, isWindowsSystemCwd, M9R_PUSHED_RESULT_PREFIX, pickSession, queueArgs, queueMarker, resolveCodexCommand, resultSummary } from "../src/lib/native/codex-delivery-core";
import { collectCodexResults, deliverToCodex, findRolloutFile, realDeps, scanCodexRolloutFiles, type DeliveryDeps } from "../src/lib/native/codex-delivery";
import { renderInboxInjection, renderResultsInjection } from "../src/lib/native/inbox-core";
import { handleHookEvent } from "../src/lib/native/hook-handler";
import { createLocalStore, RESULT_RECONCILIATION_MAX_AGE_MS } from "../src/lib/native/local-store";
import { createTaskDeliveryPump } from "../src/lib/native/task-delivery-pump";

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

test("a busy target defers the next plain task and the shared pump resumes it without a resend", async () => {
  const store = newStore();
  seedCodex(store);
  store.issueIdentity("codex", "codex", THREAD);
  const first = typed(store, "same task", "first"), second = typed(store, "same task", "second");
  const deps = fakeDeps({ requireTargetIdentity: true });
  assert.equal((await deliverToCodex(store, first.id, deps)).state, "queued");
  assert.equal((await deliverToCodex(store, second.id, deps)).state, "deferred");
  assert.equal(store.getTask(second.id)?.delivery?.threadId, THREAD);
  const pump = createTaskDeliveryPump(store, new Map([["codex", (id: string) => deliverToCodex(store, id, deps)]]));
  await pump.tick();
  assert.equal(deps.calls.length, 1);
  store.setResult(first.id, "completed");
  await Promise.all([pump.tick(), pump.tick()]);
  assert.equal(deps.calls.length, 2);
  assert.equal(store.getTask(second.id)?.delivery?.state, "queued");
  assert.equal(store.getTask(second.id)?.deliveredSession, THREAD);
});

test("a verbatim retry is not deferred forever behind a stale, never-finalized original attempt", async () => {
  // Confirmed live in production state (T248/T249, 2026-10-17): the owner resent a failed task
  // with the exact same wording; the retry was silently deferred with no bound at all, because
  // the original attempt's delivery record was never finalized (it failed over elsewhere and the
  // owner redirected it, so it never got a resultSummary). sessionHasUnfinishedDelivery now bounds
  // how long an unfinished original attempt can block an identical-text retry.
  let clock = Date.now() - 31 * 60_000; // older than the default 30-minute inbox staleness window
  const dir = mkdtempSync(join(tmpdir(), "m9r-n2-stale-"));
  const store = createLocalStore(dir, { now: () => new Date(clock) });
  seedCodex(store);
  store.issueIdentity("codex", "codex", THREAD);
  const first = typed(store, "open file explorer and type hello in the search bar", "first-attempt");
  clock = Date.now(); // the retry itself is sent now, in real time
  const second = typed(store, "open file explorer and type hello in the search bar", "second-attempt");
  const deps = fakeDeps({ requireTargetIdentity: true });
  assert.equal((await deliverToCodex(store, first.id, deps)).state, "skipped", "an old original attempt is history, not new provider work");
  // The first attempt never resolves (no setResult, no setDelivery to a terminal state) -- exactly
  // what happens when a task fails over to a different tool or the owner redirects it by hand.
  assert.equal((await deliverToCodex(store, second.id, deps)).state, "queued", "a retry must not be deferred behind an original attempt old enough to be stale");
});

test("a stale Codex task is never claimed by the direct push path", async () => {
  let clock = new Date(Date.now() - 31 * 60_000);
  const store = createLocalStore(mkdtempSync(join(tmpdir(), "m9r-n2-stale-codex-push-")), { now: () => new Date(clock) });
  seedCodex(store);
  const stale = typed(store, "an old task that must remain history", "stale-direct-push");
  clock = new Date();
  const deps = fakeDeps();

  assert.deepEqual(await deliverToCodex(store, stale.id, deps), {
    state: "skipped",
    reason: "not eligible or already claimed for delivery",
  });
  assert.equal(deps.calls.length, 0, "stale work must not reach codex queue");
  assert.equal(store.getTask(stale.id)?.delivery, undefined, "stale history is retained without becoming a live delivery");
});

test("Codex result collection ignores stale and non-Codex queued deliveries", async () => {
  // Delivery selection uses the real wall clock because it represents the
  // liveness of an actual Codex session. Keep the fixture's initial session
  // fresh regardless of when the suite runs; the test advances this clock
  // explicitly below to exercise reconciliation aging.
  let clock = new Date();
  const store = createLocalStore(mkdtempSync(join(tmpdir(), "m9r-n2-result-age-")), { now: () => new Date(clock) });
  seedCodex(store);

  const stale = typed(store, "stale Codex delivery", "stale-codex");
  assert.equal((await deliverToCodex(store, stale.id, fakeDeps())).state, "queued");
  store.setDelivery(stale.id, { state: "queued", threadId: "stale-codex-session" });

  const otherProvider = store.addTask({ from: "claude", to: "opencode", goal: "queued for another provider", origin: "human_typed", idempotencyKey: "other-provider" }).task;
  store.setDelivery(otherProvider.id, { state: "queued", threadId: "opencode-session" });

  clock = new Date(clock.getTime() + RESULT_RECONCILIATION_MAX_AGE_MS + 1);
  const current = typed(store, "current Codex delivery", "current-codex");
  assert.equal((await deliverToCodex(store, current.id, fakeDeps())).state, "queued");

  const readThreads: string[] = [];
  assert.equal(collectCodexResults(store, {
    readRolloutTail: (threadId) => { readThreads.push(threadId); return null; },
  }), 0);
  assert.deepEqual(readThreads, [THREAD], "only the fresh Codex delivery may be polled for a result");
  assert.equal(store.getTask(stale.id)?.resultSummary, undefined, "stale history remains recorded but is not re-polled");
  assert.equal(store.getTask(otherProvider.id)?.resultSummary, undefined, "another provider's delivery is not handed to the Codex collector");
});

test("concurrent Codex dispatchers inject a task once", async () => {
  const store = newStore();
  seedCodex(store);
  const task = typed(store);
  let calls = 0;
  const deps = fakeDeps({ runCodex: async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { code: 0, stderr: "" };
  } });
  const results = await Promise.all([deliverToCodex(store, task.id, deps), deliverToCodex(store, task.id, deps)]);
  assert.equal(calls, 1);
  assert.deepEqual(results.map((result) => result.state).sort(), ["queued", "skipped"]);
  assert.equal(store.getTask(task.id)?.delivery?.attempts, 1);
});

test("an ambiguous Codex dispatch failure is not injected again", async () => {
  const store = newStore();
  seedCodex(store);
  const task = typed(store);
  let calls = 0;
  const deps = fakeDeps({ runCodex: async () => { calls += 1; throw new Error("response lost"); } });
  assert.equal((await deliverToCodex(store, task.id, deps)).state, "failed");
  assert.equal(store.getTask(task.id)?.delivery?.state, "uncertain");
  assert.deepEqual(store.claimInboxTasks("codex", THREAD, [task.id]), [], "inbox fallback must not replay an ambiguous push");
  assert.equal((await deliverToCodex(store, task.id, deps)).state, "skipped");
  assert.equal(calls, 1);
  const tail = [
    { type: "response_item", payload: { role: "user", content: [{ type: "input_text", text: queueMarker(task.id) }] } },
    { type: "event_msg", payload: { type: "task_complete", last_agent_message: "Finished once" } },
  ].map((item) => JSON.stringify(item)).join("\n");
  assert.equal(collectCodexResults(store, { readRolloutTail: () => tail }), 1);
  assert.equal(store.getTask(task.id)?.delivery?.state, "done", "observed rollout completion reconciles the lost response without replay");
});

test("only tasks a human typed or approved may be queued; everything else is never pushed", () => {
  assert.equal(canQueue({ origin: "human_typed", approval: "not_needed" }), true);
  assert.equal(canQueue({ origin: "agent_initiated", approval: "approved" }), true);
  assert.equal(canQueue({ origin: "agent_initiated", approval: "pending" }), false);
  assert.equal(canQueue({ origin: "human_typed", approval: "denied" }), false);
  assert.equal(canQueue({ origin: "agent_initiated", approval: "expired" }), false);
});

test("the visible queue message contains only the task, and the arguments are a plain array", () => {
  const msg = buildQueueMessage({ id: "T7", from: "claude", goal: "Review lease.ts" });
  assert.equal(msg, "Review lease.ts");
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
  assert.equal(resultSummary("T5", ""), "The assigned work ended without a final message.");
});

test("legacy result reconciliation never borrows a later prompt's answer", () => {
  const tail = [
    JSON.stringify({ type: "response_item", payload: { role: "user", content: [{ type: "input_text", text: "[M9R T9] original task" }] } }),
    JSON.stringify({ type: "response_item", payload: { role: "user", content: [{ type: "input_text", text: "a different question" }] } }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "answer to that different question" } }),
  ].join("\n");
  assert.deepEqual(findQueuedResult(tail, "T9"), { seen: true, done: false });
  const quoted = [
    JSON.stringify({ type: "response_item", payload: { role: "tool", content: [{ type: "output_text", text: "[M9R T9] quoted diagnostic" }] } }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "an unrelated answer" } }),
  ].join("\n");
  assert.deepEqual(findQueuedResult(quoted, "T9"), { seen: false, done: false });
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

test("strict production delivery refuses missing identity and keeps credentials out of provider context", async () => {
  const store = newStore();
  seedCodex(store);
  const task = typed(store, "Review only the changed files", "strict-identity");
  const strictDeps = fakeDeps({ requireTargetIdentity: true });
  const refused = await deliverToCodex(store, task.id, strictDeps);
  assert.equal(refused.state, "failed");
  assert.match(refused.state === "failed" ? refused.reason : "", /active M9R identity/i);
  assert.equal(strictDeps.calls.length, 0);

  const token = store.issueIdentity("codex", "codex", THREAD).token;
  const queued = await deliverToCodex(store, task.id, strictDeps);
  assert.deepEqual(queued, { state: "queued", threadId: THREAD });
  const message = strictDeps.calls[0]?.[strictDeps.calls[0].indexOf("--message") + 1] ?? "";
  assert.match(message, /Review only the changed files/);
  assert.ok(!message.includes(token), "the visible task must not expose credentials");
  const hidden = handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: THREAD, cwd: "C:/p", prompt: message },
    { provider: "codex", store, strictTargetIdentity: true, readIndex: () => null });
  const context = hidden?.hookSpecificOutput.additionalContext ?? "";
  assert.match(context, /approved work item/i, "the receiving session gets the internal execution guidance");
  assert.doesNotMatch(context, /T\d+|codex|session-one|session-token|token/i, "provider-visible context must not expose routing metadata or credentials");
  assert.equal(store.verifyIdentity(token)?.sessionId, THREAD, "delivery does not revoke the existing token");
  assert.doesNotMatch(message, /Task from @claude|surrounding chat/i);
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
  const tail = `${JSON.stringify({ type: "response_item", payload: { role: "user", content: [{ type: "input_text", text: `${queueMarker(t.id)} Task` }] } })}\n${JSON.stringify({ payload: { type: "task_complete", last_agent_message: "Reviewed: one race in renew()." } })}`;
  assert.equal(collectCodexResults(store, { readRolloutTail: () => tail }), 1);
  assert.equal(store.getTask(t.id)?.delivery?.state, "done");
  const shown = renderResultsInjection(store.tasksFrom("claude"), "claude");
  assert.match(shown.text, /finished by @codex\] Reviewed: one race in renew\(\)\./);
  store.markResultShown(shown.ids);
  assert.equal(renderResultsInjection(store.tasksFrom("claude"), "claude").text, "");
  assert.equal(collectCodexResults(store, { readRolloutTail: () => tail }), 0, "nothing left to collect");
});

test("new internal-context deliveries require an authenticated task result, not inferred conversation completion", async () => {
  const store = newStore(); seedCodex(store);
  const identity = store.issueIdentity("codex", "codex", THREAD);
  const task = typed(store);
  await deliverToCodex(store, task.id, fakeDeps({ requireTargetIdentity: true }));
  const tail = [
    JSON.stringify({ type: "response_item", payload: { role: "user", content: [{ type: "input_text", text: `${queueMarker(task.id)} quoted context` }] } }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "unrelated final answer" } }),
  ].join("\n");
  assert.equal(collectCodexResults(store, { readRolloutTail: () => tail }), 0);
  assert.equal(store.getTask(task.id)?.resultSummary, undefined);
  assert.equal(store.recordTaskResult(identity.token, task.id, "actual task outcome").ok, true);
  assert.equal(store.getTask(task.id)?.resultSummary, "actual task outcome");
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

test("a handle inside pasted text is not a mention, so nothing is sent to that agent", () => {
  const store = newStore(); seedCodex(store);
  const dispatched: string[] = [];
  const ctx = { provider: "claude-code", store, pathExists: () => false, readIndex: () => null, dispatch: (id: string) => dispatched.push(id) };
  const prompt = "fix the notch " + '<pasted_content id="a1">@codex do the following: old test chatter</pasted_content id="a1">';
  handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "cc-9", cwd: "C:/p", prompt }, ctx);
  assert.equal(dispatched.length, 0);
});

test("a report another agent sends into the session never routes tasks, even when it names @codex", () => {
  const store = newStore(); seedCodex(store);
  const dispatched: string[] = [];
  const ctx = { provider: "claude-code", store, pathExists: () => false, readIndex: () => null, dispatch: (id: string) => dispatched.push(id) };
  handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "cc-8", cwd: "C:/p", prompt: '<agent-message from="a1"> the pill routes @codex inside code fences </agent-message>' }, ctx);
  assert.equal(dispatched.length, 0);
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
  assert.doesNotMatch(pushed, /@claude/, "the pushed text contains only the task text, not surrounding chat");
  const dispatched: string[] = [];
  const out = handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: THREAD, cwd: "C:/p", prompt: pushed }, { provider: "codex", store, pathExists: () => false, readIndex: () => null, dispatch: (id) => dispatched.push(id) });
  assert.equal(store.tasksFor("claude").length, 0, "no task was created for the sender");
  assert.equal(dispatched.length, 0);
  assert.doesNotMatch(out?.hookSpecificOutput.additionalContext ?? "", /already sent your message/, "Codex is not told to skip the work");
  // A person's own prompt with a mention still routes, so the guard is only for M9R's own pushed prompts.
  // @claude has no live session here, so the ack must say the task is held -- not pretend it was pushed.
  const own = handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: THREAD, cwd: "C:/p", prompt: "@claude please look at this" }, { provider: "codex", store, pathExists: () => false, readIndex: () => null });
  assert.match(own?.hookSpecificOutput.additionalContext ?? "", /held your message to @claude/, "an unpushed mention must not promise immediate work");
  assert.match(own?.hookSpecificOutput.additionalContext ?? "", /no active session/, "the sender learns why it is waiting");
  assert.match(own?.hookSpecificOutput.additionalContext ?? "", /Do not do that work yourself/, "the held ack still stops the sender doing the work");
});

const A = "01a0bfd8-4e13-76d3-9077-fdef973a978c";
const B = "01a0bfd8-fb78-74a3-b665-56653655b87b";
const NOW = new Date("2026-09-20T12:00:00Z");
const sess = (sessionId: string, cwd: string, lastSeenAt: string) => ({ sessionId, cwd, lastSeenAt });

test("the session chooser never guesses between several: pinned, then the only one, then the only one in the sender's folder, else ambiguous", () => {
  const recent = "2026-09-20T11:50:00Z";
  assert.deepEqual(pickSession([], { now: NOW }), { kind: "none" });
  assert.equal(pickSession([sess(A, "C:/p", recent)], { now: NOW }).kind, "one");
  assert.equal(pickSession([sess(A, "C:/p", "2026-09-18T00:00:00Z")], { now: NOW }).kind, "none", "a session not seen for over a day is not a target");
  const two = [sess(A, "C:/proj/a", recent), sess(B, "C:/proj/b", recent)];
  assert.equal(pickSession(two, { now: NOW }).kind, "ambiguous");
  assert.deepEqual(pickSession(two, { now: NOW, senderCwd: "c:\\proj\\a\\" }), { kind: "one", session: two[0] }, "same folder wins, slashes and case ignored");
  assert.equal(pickSession(two, { now: NOW, senderCwd: "C:/elsewhere" }).kind, "ambiguous");
  assert.equal(pickSession([sess(A, "C:/p", recent), sess(B, "C:/p", recent)], { now: NOW, senderCwd: "C:/p" }).kind, "ambiguous", "two in the same folder is still a guess");
  assert.deepEqual(pickSession(two, { now: NOW, pinned: "01a0bfd8-fb" }), { kind: "one", session: two[1] }, "a pinned id prefix wins");
  assert.equal(pickSession(two, { now: NOW, pinned: "01a0bfd8" }).kind, "ambiguous", "a prefix that matches both is not enough");
  assert.equal(pickSession(two, { now: NOW, pinned: "zzz" }).kind, "none");
});

test("a task from a folder with no Codex session is never pushed into another folder's session; it falls back to the inbox and says how to aim it", async () => {
  const store = newStore();
  store.registerEndpoint({ provider: "codex", sessionId: A, cwd: "C:/proj/a" });
  store.registerEndpoint({ provider: "codex", sessionId: B, cwd: "C:/proj/b" });
  assert.equal(store.sessionsFor("codex").length, 2, "both sessions are remembered, the newer no longer hides the older");
  const deps = fakeDeps();
  const t = store.addTask({ from: "claude", to: "codex", goal: "Review lease.ts", origin: "human_typed", idempotencyKey: "amb", cwd: "C:/elsewhere" }).task;
  const r = await deliverToCodex(store, t.id, deps);
  assert.equal(r.state, "failed");
  assert.match(r.state === "failed" ? r.reason : "", /No Codex session is open in C:\/elsewhere.*m9r-cli send @codex --session/);
  assert.equal(deps.calls.length, 0, "nothing was queued anywhere");
  assert.match(renderInboxInjection(store.tasksFor("codex"), 0).text, /Review lease\.ts/, "it shows at the next prompt in whichever session the user uses");
});

test("the sender's own folder aims the push, and --session pins it exactly", async () => {
  const store = newStore();
  store.registerEndpoint({ provider: "codex", sessionId: A, cwd: "C:/proj/a" });
  store.registerEndpoint({ provider: "codex", sessionId: B, cwd: "C:/proj/b" });
  const deps = fakeDeps();
  const inA = store.addTask({ from: "claude", to: "codex", goal: "one", origin: "human_typed", idempotencyKey: "a", cwd: "C:/proj/a" }).task;
  assert.deepEqual(await deliverToCodex(store, inA.id, deps), { state: "queued", threadId: A });
  const pinned = store.addTask({ from: "claude", to: "codex", goal: "two", origin: "human_typed", idempotencyKey: "b", cwd: "C:/nowhere", targetSession: B.slice(0, 12) }).task;
  assert.deepEqual(await deliverToCodex(store, pinned.id, deps), { state: "queued", threadId: B });
  assert.deepEqual(deps.calls.map((c) => c[2]), [A, B]);
});

test("the M9R install directory is not treated as a Codex project folder", async () => {
  const store = newStore();
  store.registerEndpoint({ provider: "codex", sessionId: THREAD, cwd: "C:/runleak/runleak" });
  const deps = fakeDeps();
  const t = store.addTask({
    from: "you",
    to: "codex",
    goal: "Show one labeled M9R ghost cursor",
    origin: "human_typed",
    idempotencyKey: "install-cwd",
    cwd: join(store.root, "bin"),
  }).task;

  assert.deepEqual(await deliverToCodex(store, t.id, deps), { state: "queued", threadId: THREAD });
  assert.equal(deps.calls.length, 1, "a task created from the runtime install folder still reaches the live project session");
});

test("Windows System32 is never treated as a Codex project folder", async () => {
  const store = newStore();
  store.registerEndpoint({ provider: "codex", sessionId: THREAD, cwd: "C:/runleak/runleak" });
  assert.equal(isWindowsSystemCwd("C:\\WINDOWS\\System32"), true);
  const deps = fakeDeps();
  const task = store.addTask({
    from: "you",
    to: "codex",
    goal: "Show one labeled M9R ghost cursor",
    origin: "human_typed",
    idempotencyKey: "system32-cwd",
    cwd: "C:\\WINDOWS\\System32",
  }).task;
  assert.deepEqual(await deliverToCodex(store, task.id, deps), { state: "queued", threadId: THREAD });
  assert.equal(deps.calls.length, 1);
});

test("`sessions` lists what was seen and how to aim a task", async () => {
  const { runNativeCommand, nativePaths } = await import("../src/lib/native/native-commands");
  const home = mkdtempSync(join(tmpdir(), "m9r-sess-"));
  const out: string[] = [];
  const io = { homeDir: home, env: { M9R_HOME: join(home, ".m9r") }, out: (l: string) => out.push(l), err: (l: string) => out.push(l) };
  const s = createLocalStore(nativePaths(io).m9r);
  s.registerEndpoint({ provider: "codex", sessionId: A, cwd: "C:/proj/a" });
  s.registerEndpoint({ provider: "codex", sessionId: B, cwd: "C:/proj/b" });
  assert.equal(await runNativeCommand("sessions", ["@codex"], io), 0);
  const text = out.join("\n");
  assert.match(text, new RegExp(A));
  assert.match(text, new RegExp(B));
  assert.match(text, /send @codex --session/);
});

test("open sessions are preferred when the machine can say which are open; otherwise recency decides as before", () => {
  const recent = "2026-09-20T11:50:00Z";
  const two = [sess(A, "C:/proj/a", recent), sess(B, "C:/proj/b", recent)];
  assert.deepEqual(pickSession(two, { now: NOW, liveness: { [A]: "live", [B]: "free" } }), { kind: "one", session: two[0] }, "the finished one is not a candidate");
  assert.deepEqual(pickSession(two, { now: NOW, liveness: { [A]: "free", [B]: "live" } }), { kind: "one", session: two[1] });
  assert.equal(pickSession(two, { now: NOW, liveness: { [A]: "live", [B]: "live" } }).kind, "ambiguous", "two open sessions is still a real choice");
  assert.deepEqual(pickSession(two, { now: NOW, senderCwd: "C:/proj/b", liveness: { [A]: "live", [B]: "live" } }), { kind: "one", session: two[1] }, "two open: the sender's folder decides");
  assert.equal(pickSession(two, { now: NOW, liveness: { [A]: "free", [B]: "free" } }).kind, "ambiguous", "none reported open: no one is ruled out on a hunch");
  assert.equal(pickSession(two, { now: NOW, liveness: { [A]: "unknown", [B]: "unknown" } }).kind, "ambiguous", "unknown is no information, not closed");
  assert.deepEqual(pickSession([two[0]], { now: NOW, liveness: { [A]: "free" } }), { kind: "one", session: two[0] }, "a lone session that does not hold its file (a Desktop thread, say) is still used");
});

test("with two sessions the push goes to the one that is open, and the machine is asked only when there is a choice", async () => {
  const store = newStore();
  store.registerEndpoint({ provider: "codex", sessionId: A, cwd: "C:/proj" });
  store.registerEndpoint({ provider: "codex", sessionId: B, cwd: "C:/proj" });
  const asked: string[][] = [];
  const deps = fakeDeps({ sessionLiveness: async (ids) => { asked.push(ids); return { [A]: "live", [B]: "free" }; } });
  const t = store.addTask({ from: "claude", to: "codex", goal: "Review lease.ts", origin: "human_typed", idempotencyKey: "live1", cwd: "C:/proj" }).task;
  assert.deepEqual(await deliverToCodex(store, t.id, deps), { state: "queued", threadId: A });
  assert.equal(asked.length, 1);
  const pinned = store.addTask({ from: "claude", to: "codex", goal: "two", origin: "human_typed", idempotencyKey: "live2", targetSession: B.slice(0, 12) }).task;
  assert.deepEqual(await deliverToCodex(store, pinned.id, deps), { state: "queued", threadId: B });
  assert.equal(asked.length, 1, "a pinned push never asks");
  const solo = newStore(); seedCodex(solo);
  const t3 = typed(solo);
  let soloAsked = 0;
  await deliverToCodex(solo, t3.id, fakeDeps({ sessionLiveness: async () => { soloAsked += 1; return {}; } }));
  assert.equal(soloAsked, 0, "one session: nothing to choose, so no check");
  const failing = newStore();
  failing.registerEndpoint({ provider: "codex", sessionId: A, cwd: "C:/a" });
  failing.registerEndpoint({ provider: "codex", sessionId: B, cwd: "C:/b" });
  const t4 = failing.addTask({ from: "claude", to: "codex", goal: "x", origin: "human_typed", idempotencyKey: "f" }).task;
  const r = await deliverToCodex(failing, t4.id, fakeDeps({ sessionLiveness: async () => { throw new Error("powershell missing"); } }));
  assert.equal(r.state, "failed", "a failing liveness check falls back to the safe ambiguous path");
});

test("an older inbox item is not mixed into a prompt M9R pushed; SessionStart delivers it once", () => {
  const store = newStore(); seedCodex(store);
  const waiting = store.addTask({ from: "claude", to: "codex", goal: "Older item that fell back to the inbox", origin: "human_typed", idempotencyKey: "old" }).task;
  store.setDelivery(waiting.id, { state: "failed", error: "ambiguous" });
  const pushedTask = store.addTask({ from: "claude", to: "codex", goal: "Reply with only: pushed-one", origin: "human_typed", idempotencyKey: "new" }).task;
  store.setDelivery(pushedTask.id, { state: "queued", threadId: THREAD });
  const ctx = { provider: "codex", store, pathExists: () => false, readIndex: () => null };
  const started = handleHookEvent({ hook_event_name: "SessionStart", session_id: THREAD, cwd: "C:/p" }, ctx);
  assert.match(started?.hookSpecificOutput.additionalContext ?? "", /Older item that fell back to the inbox/, "reconnecting sessions receive fallback work automatically");
  const pushed = handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: THREAD, cwd: "C:/p", prompt: buildQueueMessage(pushedTask) }, ctx);
  const pushedContext = pushed?.hookSpecificOutput.additionalContext ?? "";
  assert.match(pushedContext, /approved work item/i, "the pushed task receives internal execution guidance");
  assert.doesNotMatch(pushedContext, new RegExp(queueMarker(pushedTask.id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the provider-visible context does not expose the task id");
  assert.ok(!pushedContext.includes(waiting.goal), "older inbox work is not mixed into the pushed task");
  const real = handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: THREAD, cwd: "C:/p", prompt: "what next?" }, ctx);
  assert.equal(real, null, "the fallback was already delivered at SessionStart and is not replayed");
});

test("a task is only ever pushed into a Codex session in the sender's own folder: not a parent, not a child, not another project", async () => {
  const store = newStore();
  store.registerEndpoint({ provider: "codex", sessionId: A, cwd: "C:/proj" });
  store.registerEndpoint({ provider: "codex", sessionId: B, cwd: "C:/proj/term" });
  const deps = fakeDeps();
  const inTerm = store.addTask({ from: "claude", to: "codex", goal: "one", origin: "human_typed", idempotencyKey: "t1", cwd: "C:/proj/term" }).task;
  assert.deepEqual(await deliverToCodex(store, inTerm.id, deps), { state: "queued", threadId: B });
  const fresh = store.addTask({ from: "claude", to: "codex", goal: "two", origin: "human_typed", idempotencyKey: "t2", cwd: "C:/proj/demo" }).task;
  const r = await deliverToCodex(store, fresh.id, deps);
  assert.equal(r.state, "failed", "a clean folder with no Codex session yet does not fall back to the parent's old thread");
  assert.match(r.state === "failed" ? r.reason : "", /No Codex session is open in C:\/proj\/demo.*one message/);
  assert.equal(deps.calls.length, 1, "nothing else was queued");
});

test("Claude's finished turn answers the task it was shown, and the answer is pushed back into the Codex session that asked (once)", async () => {
  const { handleHookEvent } = await import("../src/lib/native/hook-handler");
  const { pushAnswerToCodex } = await import("../src/lib/native/codex-delivery");
  const store = newStore();
  store.registerEndpoint({ provider: "codex", sessionId: A, cwd: "C:/p" });
  store.issueIdentity("claude", "claude-code", "cc-1");
  const asked = store.addTask({ from: "codex", to: "claude", goal: "Summarise a.txt", origin: "human_typed", idempotencyKey: "rev1", cwd: "C:/p", fromSession: A }).task;
  const answered: string[] = [];
  const ctx = { provider: "claude-code", store, pathExists: () => false, readIndex: () => null, lastAnswer: () => "It says: PURPLE-ELEPHANT-42.", answerBack: (id: string) => answered.push(id) };
  // Before Claude has seen the task, a finished turn answers nothing.
  handleHookEvent({ hook_event_name: "Stop", session_id: "cc-1" }, ctx);
  assert.equal(answered.length, 0);
  // Claude sees it at its next prompt...
  handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "cc-1", cwd: "C:/p", prompt: "go" }, ctx);
  assert.equal(store.getTask(asked.id)?.deliveredSession, "cc-1");
  // ...and its adapter's explicit task reference binds the final answer.
  handleHookEvent({ hook_event_name: "Stop", session_id: "cc-1", task_id: asked.id }, ctx);
  assert.deepEqual(answered, [asked.id]);
  assert.equal(store.getTask(asked.id)?.resultSummary, "It says: PURPLE-ELEPHANT-42.");
  // A different Claude session's finished turn is not its answer.
  const other = newStore();
  other.issueIdentity("claude", "claude-code", "cc-OTHER");
  const t2 = other.addTask({ from: "codex", to: "claude", goal: "x", origin: "human_typed", idempotencyKey: "rev2", fromSession: A }).task;
  handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "cc-1", prompt: "go" }, { ...ctx, store: other });
  handleHookEvent({ hook_event_name: "Stop", session_id: "cc-OTHER", task_id: t2.id }, { ...ctx, store: other, answerBack: (id: string) => answered.push("WRONG" + id) });
  assert.equal(other.getTask(t2.id)?.resultSummary, undefined);

  const deps = fakeDeps();
  assert.deepEqual(await pushAnswerToCodex(store, asked.id, deps), { state: "queued", threadId: A });
  assert.equal(deps.calls.length, 1);
  assert.equal(deps.calls[0][2], A, "the answer goes back into the session that asked");
  assert.equal(deps.calls[0][4].startsWith(M9R_PUSHED_RESULT_PREFIX), true);
  assert.match(deps.calls[0][4], /PURPLE-ELEPHANT-42/);
  assert.doesNotMatch(deps.calls[0][4], /T1|@claude|Summarise a\.txt/,
    "task, sender, and goal metadata must stay in the ledger, not in Codex's visible conversation");
  assert.equal(isM9rPushedPrompt(deps.calls[0][4]), true,
    "the natural result envelope still suppresses mention routing");
  assert.equal((await pushAnswerToCodex(store, asked.id, deps)).state, "skipped", "never sent twice");
});

test("answer push refuses a same-id Codex session that is ambiguous across folders", async () => {
  const { pushAnswerToCodex } = await import("../src/lib/native/codex-delivery");
  const store = newStore();
  store.registerEndpoint({ provider: "codex", sessionId: A, cwd: "C:/one" });
  store.registerEndpoint({ provider: "codex", sessionId: A, cwd: "C:/two" });
  const task = store.addTask({ from: "codex", to: "claude", goal: "review", origin: "human_typed", idempotencyKey: "same-id-answer", fromSession: A }).task;
  store.setResult(task.id, "done");
  const deps = fakeDeps();
  assert.deepEqual(await pushAnswerToCodex(store, task.id, deps), { state: "failed", reason: "the originating Codex session is ambiguous; no answer was pushed" });
  assert.equal(deps.calls.length, 0);
});

test("two threads in the same folder: the one in use right now wins only when it is clearly the one in use; otherwise M9R does not guess", () => {
  const now = new Date("2026-09-21T23:20:00Z");
  const at = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
  const s = (id: string, min: number) => ({ sessionId: id, cwd: "C:/p", lastSeenAt: at(min) });
  assert.deepEqual(pickSession([s(A, 240), s(B, 4)], { now, senderCwd: "C:/p" }), { kind: "one", session: s(B, 4) }, "one thread used 4 minutes ago, the other 4 hours ago");
  assert.equal(pickSession([s(A, 6), s(B, 4)], { now, senderCwd: "C:/p" }).kind, "ambiguous", "both in use lately: it is not clear");
  assert.equal(pickSession([s(A, 900), s(B, 800)], { now, senderCwd: "C:/p" }).kind, "ambiguous", "neither used in the last 12 hours: it does not pick the least stale");
  assert.deepEqual(pickSession([s(A, 240), s(B, 60)], { now, senderCwd: "C:/p" }), { kind: "one", session: s(B, 60) }, "the thread used an hour ago beats the one used four hours ago");
});

test("an explicit link always wins over folder and recency, and a resolved one-candidate push auto-links for next time", async () => {
  const store = newStore();
  store.registerEndpoint({ provider: "codex", sessionId: A, cwd: "C:/proj" });
  store.registerEndpoint({ provider: "codex", sessionId: B, cwd: "C:/elsewhere" });
  store.setLink({ handle: "claude", sessionId: "cc-1" }, { handle: "codex", sessionId: B }, "picked");
  const deps = fakeDeps();
  // The sender's folder matches A, but the link to B wins.
  const linked = store.addTask({ from: "claude", to: "codex", goal: "one", origin: "human_typed", idempotencyKey: "l1", cwd: "C:/proj", fromSession: "cc-1" }).task;
  assert.deepEqual(await deliverToCodex(store, linked.id, deps), { state: "queued", threadId: B });

  // A different, unlinked Claude session resolves normally and then gets remembered.
  const solo = newStore(); seedCodex(solo);
  const t = solo.addTask({ from: "claude", to: "codex", goal: "two", origin: "human_typed", idempotencyKey: "l2", fromSession: "cc-2" }).task;
  const outcome = await deliverToCodex(solo, t.id, fakeDeps());
  assert.equal(outcome.state, "queued");
  assert.deepEqual(solo.linkedSession("claude", "cc-2", "codex"), { sessionId: THREAD, cwd: "c:/p" });
});

test("a link store entry is symmetric and replacing it removes the old one", () => {
  const store = newStore();
  const l1 = store.setLink({ handle: "claude", sessionId: "cc-1" }, { handle: "codex", sessionId: A }, "auto");
  assert.deepEqual(store.linkedSession("claude", "cc-1", "codex"), { sessionId: A });
  assert.deepEqual(store.linkedSession("codex", A, "claude"), { sessionId: "cc-1" }, "the link works from either side");
  const l2 = store.setLink({ handle: "claude", sessionId: "cc-1" }, { handle: "codex", sessionId: B }, "picked");
  assert.notEqual(l1.id, l2.id);
  assert.deepEqual(store.linkedSession("claude", "cc-1", "codex"), { sessionId: B }, "the new link replaces the old one for this pair");
  assert.equal(store.allLinks().length, 1);
  store.removeLink(l2.id);
  assert.equal(store.linkedSession("claude", "cc-1", "codex"), undefined);
});

test("links distinguish same provider session ids by folder and return no result when an unscoped lookup is ambiguous", () => {
  const store = newStore();
  store.registerEndpoint({ provider: "codex", sessionId: A, cwd: "C:/proj/one" });
  store.registerEndpoint({ provider: "codex", sessionId: B, cwd: "C:/proj/two" });
  store.setLink({ handle: "claude", sessionId: "same", cwd: "C:/sender/one" }, { handle: "codex", sessionId: A, cwd: "C:/proj/one" }, "picked");
  store.setLink({ handle: "claude", sessionId: "same", cwd: "C:/sender/two" }, { handle: "codex", sessionId: B, cwd: "C:/proj/two" }, "picked");

  assert.equal(store.allLinks().length, 2);
  assert.deepEqual(store.linkedSession("claude", "same", "codex", "C:/sender/one"), { sessionId: A, cwd: "c:/proj/one" });
  assert.equal(store.linkedSession("claude", "same", "codex"), undefined, "without a folder there are two possible source sessions; do not guess");
});

test("a link whose stored session id is not a real Codex thread id is never used for the queue call; it falls through to the normal folder rules", async () => {
  const store = newStore();
  store.registerEndpoint({ provider: "codex", sessionId: THREAD, cwd: "C:/p" });
  store.setLink({ handle: "claude", sessionId: "cc-1" }, { handle: "codex", sessionId: "not-a-uuid" }, "picked");
  const deps = fakeDeps();
  const t = store.addTask({ from: "claude", to: "codex", goal: "x", origin: "human_typed", idempotencyKey: "bad-link", cwd: "C:/p", fromSession: "cc-1" }).task;
  assert.deepEqual(await deliverToCodex(store, t.id, deps), { state: "queued", threadId: THREAD }, "falls back to the folder match instead of calling codex queue with a bad id");
  assert.equal(deps.calls.length, 1);
  assert.equal(deps.calls[0][2], THREAD);
});

test("findRolloutFile follows a thread across Codex's rotated/resumed rollout files, not just its original one", () => {
  const home = mkdtempSync(join(tmpdir(), "m9r-codex-home-"));
  try {
    const day1 = join(home, "sessions", "2026", "09", "19");
    const day2 = join(home, "sessions", "2026", "09", "21");
    mkdirSync(day1, { recursive: true });
    mkdirSync(day2, { recursive: true });
    const id = "01a0bc65-5d09-71a1-89f1-1f15cf4bc79a";
    // The original file (no second id) plus two later rotations Codex creates for the same thread as it compacts/resumes.
    writeFileSync(join(day1, `rollout-2026-09-19T20-19-14-${id}.jsonl`), "");
    writeFileSync(join(day2, `rollout-2026-09-21T21-56-07-${id}_01a0c70a-c5c7-7c22-8bd4-0f5ab237cdbd.jsonl`), "");
    writeFileSync(join(day2, `rollout-2026-09-21T23-45-31-${id}_01a0c76e-f010-7f21-9e41-e4a61bd9fcab.jsonl`), "");
    const found = findRolloutFile(home, id);
    assert.equal(found, join(day2, `rollout-2026-09-21T23-45-31-${id}_01a0c76e-f010-7f21-9e41-e4a61bd9fcab.jsonl`), "must resolve to the latest rotation, not the closed original file");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Codex rollout scan distinguishes a complete missing-session record from an unreadable session tree", () => {
  const home = mkdtempSync(join(tmpdir(), "m9r-codex-index-"));
  try {
    mkdirSync(join(home, "sessions", "2026", "10", "23"), { recursive: true });
    const complete = scanCodexRolloutFiles(home, ["missing-session"]);
    assert.equal(complete.complete, true, "a fully traversed tree proves that this stale record has no local rollout");
    assert.equal(complete.paths.has("missing-session"), false);

    const unavailable = scanCodexRolloutFiles(join(home, "missing-home"), ["unverifiable-session"]);
    assert.equal(unavailable.complete, false, "a missing sessions root is not proof that a session is closed");
    assert.equal(unavailable.paths.has("unverifiable-session"), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("real Codex liveness treats an absent old rollout as free only after a complete scan", async () => {
  const home = mkdtempSync(join(tmpdir(), "m9r-codex-liveness-"));
  const staleSession = `stale-${Date.now()}-${Math.random()}`;
  const unverifiableSession = `unverifiable-${Date.now()}-${Math.random()}`;
  try {
    mkdirSync(join(home, "sessions", "2026", "10", "23"), { recursive: true });
    const completeTree = await realDeps({ CODEX_HOME: home }).sessionLiveness!([staleSession]);
    assert.equal(completeTree[staleSession], "free", "a fully readable tree with no matching rollout proves this retained record is not live here");

    const missingRoot = await realDeps({ CODEX_HOME: join(home, "not-created") }).sessionLiveness!([unverifiableSession]);
    assert.equal(missingRoot[unverifiableSession], "unknown", "a missing session root must never be treated as closure");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
