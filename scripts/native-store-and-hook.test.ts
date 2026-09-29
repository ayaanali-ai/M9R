import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalStore, defaultStoreRoot, handleForProvider } from "@/lib/native/local-store";
import { handleHookEvent } from "@/lib/native/hook-handler";
import { normalizeHandle, renderInboxInjection } from "@/lib/native/inbox-core";

function tempStore(now?: () => Date) {
  const root = mkdtempSync(join(tmpdir(), "m9r-store-"));
  return { root, store: createLocalStore(root, { now }), done: () => rmSync(root, { recursive: true, force: true }) };
}
const task = (over: Record<string, unknown> = {}) => ({ from: "codex", to: "claude", goal: "look at the reconnect bug", origin: "human_typed" as const, idempotencyKey: "k1", ...over });

test("provider names map to friendly handles", () => {
  assert.equal(handleForProvider("claude-code"), "claude");
  assert.equal(handleForProvider("Codex"), "codex");
  assert.equal(handleForProvider("My Tool!"), "my-tool");
  assert.equal(handleForProvider("!!!"), "agent");
  assert.equal(normalizeHandle("@CLAUDE"), "claude");
  assert.equal(normalizeHandle("@@CLAUDE"), "@claude", "normalization removes exactly one leading mention marker");
  assert.equal(defaultStoreRoot("/home/u", {}), join("/home/u", ".m9r"));
  assert.equal(defaultStoreRoot("/home/u", { M9R_HOME: "/tmp/x" }), "/tmp/x");
});

test("agent sessions are keyed by agent, normalized folder, and provider session id", () => {
  const { store, done } = tempStore();
  store.registerEndpoint({ provider: "claude-code", sessionId: "same-session", cwd: "C:\\Work\\One\\" });
  store.registerEndpoint({ provider: "claude-code", sessionId: "same-session", cwd: "c:/work/one" });
  store.registerEndpoint({ provider: "claude-code", sessionId: "same-session", cwd: "C:\\Work\\Two" });

  assert.equal(store.sessionsFor("claude").length, 2, "same id in two folders must remain two sessions; path spelling aliases within a folder should dedupe");
  assert.equal(store.sessionsFor("claude", "c:/work/one").length, 1);
  assert.equal(store.sessionsFor("claude", "C:\\Work\\Two")[0].cwd, "c:/work/two");
  done();
});

test("inbox cursors are folder scoped when the same agent session id is observed in distinct folders", () => {
  const { store, done } = tempStore();
  store.setCursor("claude", "shared-id", 4, "C:\\Work\\One");
  store.setCursor("claude", "shared-id", 2, "C:\\Work\\Two");
  assert.equal(store.cursorFor("claude", "shared-id", "c:/work/one"), 4);
  assert.equal(store.cursorFor("claude", "shared-id", "C:\\Work\\Two"), 2);
  assert.equal(store.cursorFor("claude", "shared-id"), 0, "scoped cursors must not leak into the legacy agent/session key");
  done();
});

test("hook inbox delivery does not let a same-id session in another folder inherit the first folder's cursor", () => {
  const { store, done } = tempStore();
  store.addTask(task({ idempotencyKey: "folder-scope-hook" }));
  const one = handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "same", cwd: "C:\\Work\\One", prompt: "hello" }, ctx(store));
  const two = handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "same", cwd: "C:\\Work\\Two", prompt: "hello" }, ctx(store));
  assert.match(ctxOf(one) ?? "", /look at the reconnect bug/);
  assert.match(ctxOf(two) ?? "", /look at the reconnect bug/);
  done();
});

test("tasks get sequential ids and per-inbox sequence numbers, and the same key never creates a second task", () => {
  const { store, done } = tempStore();
  const a = store.addTask(task());
  const b = store.addTask(task({ idempotencyKey: "k2" }));
  const dup = store.addTask(task());
  assert.equal(a.task.id, "T1"); assert.equal(a.task.seq, 1); assert.equal(a.created, true);
  assert.equal(b.task.id, "T2"); assert.equal(b.task.seq, 2);
  assert.equal(dup.created, false); assert.equal(dup.task.id, "T1");
  assert.equal(store.addTask(task({ to: "codex", idempotencyKey: "k3" })).task.seq, 1, "each inbox counts on its own");
  assert.equal(store.tasksFor("claude").length, 2);
  done();
});

test("recipient handles are normalized before task storage, inbox lookup and idempotency checks", () => {
  const { store, done } = tempStore();
  const created = store.addTask(task({ to: "@CLAUDE" }));
  assert.equal(created.task.to, "claude");
  assert.equal(store.tasksFor("claude").length, 1);
  assert.equal(store.tasksFor("@CLAUDE").length, 1);
  const duplicate = store.addTask(task({ to: "claude" }));
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.task.id, created.task.id);
  done();
});

test("state survives a new store instance on the same folder, cursors are per session and only move forward", () => {
  const { root, store, done } = tempStore();
  store.addTask(task());
  store.setCursor("claude", "s1", 5);
  store.setCursor("claude", "s1", 3);
  const again = createLocalStore(root);
  assert.equal(again.getTask("T1")?.goal, "look at the reconnect bug");
  assert.equal(again.cursorFor("claude", "s1"), 5);
  assert.equal(again.cursorFor("claude", "other"), 0, "a different Claude session must not have its own notification silently eaten by another session's cursor");
  assert.equal(again.cursorFor("codex", "s1"), 0);
  done();
});

test("a task addressed to @claude shows in every open Claude session, not just whichever one prompts first", () => {
  const { store, done } = tempStore();
  store.addTask({ from: "codex", to: "claude", goal: "check the build", origin: "human_typed", idempotencyKey: "k1" });
  // Session A prompts first and gets shown the task.
  const a = renderInboxInjection(store.tasksFor("claude"), store.cursorFor("claude", "session-a"));
  assert.match(a.text, /check the build/);
  store.setCursor("claude", "session-a", a.newCursor);
  // Session B, a second open Claude session in a different folder, prompts afterward -- it must still see it.
  const b = renderInboxInjection(store.tasksFor("claude"), store.cursorFor("claude", "session-b"));
  assert.match(b.text, /check the build/, "session B's own cursor was never advanced, so it must not have been starved by session A's");
  done();
});

test("approvals and results are stored, results are capped and redacted", () => {
  const { store, done } = tempStore();
  store.addTask(task({ origin: "agent_initiated" }));
  assert.equal(store.getTask("T1")?.approval, "pending");
  store.setApproval("T1", "approved");
  assert.equal(store.getTask("T1")?.approval, "approved");
  store.setResult("T1", "done, used token=abcdef123456 " + "z".repeat(600));
  const r = store.getTask("T1")?.resultSummary ?? "";
  assert.equal(r.length <= 400, true);
  assert.doesNotMatch(r, /abcdef123456/);
  done();
});

test("a corrupt state file is set aside and the store starts clean instead of breaking prompts", () => {
  const { root, store, done } = tempStore();
  store.addTask(task());
  writeFileSync(join(root, "state.json"), "{ not json", "utf8");
  assert.equal(store.tasksFor("claude").length, 0);
  assert.equal(store.addTask(task()).task.id, "T1");
  assert.equal(readdirSync(root).some((f) => f.startsWith("state.json.corrupt-")), true);
  done();
});

test("a stale lock left by a crashed process does not block the store", () => {
  const { root, store, done } = tempStore();
  mkdirSync(join(root, "state.lock"));
  const old = new Date(Date.now() - 60_000);
  utimesSync(join(root, "state.lock"), old, old);
  assert.equal(store.addTask(task()).created, true);
  done();
});

// ---- hook handler ----------------------------------------------------------------------------------------------

const ctx = (store: ReturnType<typeof createLocalStore>, provider = "claude-code", pathExists: (p: string) => boolean = () => false) => ({ provider, store, pathExists, now: () => new Date("2026-09-20T12:00:00Z") });
const ctxOf = (value: unknown): string | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const hookSpecificOutput = (value as { hookSpecificOutput?: unknown }).hookSpecificOutput;
  if (!hookSpecificOutput || typeof hookSpecificOutput !== "object") return undefined;
  const additionalContext = (hookSpecificOutput as { additionalContext?: unknown }).additionalContext;
  return typeof additionalContext === "string" ? additionalContext : undefined;
};

test("SessionStart registers the endpoint and prints a short card that lists recently active others", () => {
  const { store, done } = tempStore(() => new Date("2026-09-20T11:58:00Z"));
  store.registerEndpoint({ provider: "codex", sessionId: "c1" });
  const out = handleHookEvent({ hook_event_name: "SessionStart", session_id: "s1", cwd: "/repo" }, ctx(store));
  assert.equal(out?.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(ctxOf(out)!, /M9R connected as @claude\./);
  assert.match(ctxOf(out)!, /Active now: @codex/);
  assert.equal(store.listEndpoints().some((e) => e.handle === "claude"), true);
  done();
});

test("a typed mention creates a task for the target and tells the sender not to do the work", () => {
  const { store, done } = tempStore();
  store.registerEndpoint({ provider: "codex" });
  const out = handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: "/repo", prompt: "@codex investigate the relay reconnect bug" }, ctx(store));
  const t = store.tasksFor("codex");
  assert.equal(t.length, 1);
  assert.equal(t[0].goal, "investigate the relay reconnect bug");
  assert.equal(t[0].from, "claude");
  assert.equal(t[0].origin, "human_typed");
  assert.match(ctxOf(out)!, /sent your message to @codex as task T1/);
  assert.match(ctxOf(out)!, /do not do that work yourself/i);
  done();
});

test("mention diagnostics receives the unmodified hook input only for routed mentions", () => {
  const { store, done } = tempStore();
  const captured: Array<{ prompt?: string; targets: readonly string[]; rawPayload?: string }> = [];
  const captureMentionInput = (input: { prompt?: string }, targets: readonly string[], rawPayload?: string) => captured.push({ prompt: input.prompt, targets, rawPayload });
  const input = { hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: "/repo", prompt: "@codex inspect this exact prompt" };
  const rawPayload = '{  "hook_event_name":"UserPromptSubmit", "session_id":"s1", "cwd":"/repo", "prompt":"@codex inspect this exact prompt"  }\n';
  handleHookEvent(input, { ...ctx(store), rawPayload, captureMentionInput });
  handleHookEvent({ ...input, prompt: "plain prompt" }, { ...ctx(store), captureMentionInput });
  assert.deepEqual(captured, [{ prompt: input.prompt, targets: ["codex"], rawPayload }]);
  assert.equal(store.tasksFor("codex").length, 1);
  done();
});

test("the same prompt submitted twice does not create a second task", () => {
  const { store, done } = tempStore();
  const input = { hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: "/repo", prompt: "@codex do the thing" };
  handleHookEvent(input, ctx(store));
  handleHookEvent(input, ctx(store));
  assert.equal(store.tasksFor("codex").length, 1);
  done();
});

test("a mention of yourself, of a file or folder with that name, or inside code is ignored", () => {
  const { store, done } = tempStore();
  const run = (prompt: string, exists?: (p: string) => boolean) => handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "s", cwd: "/repo", prompt }, ctx(store, "claude-code", exists));
  assert.equal(run("@claude do it"), null);
  assert.equal(run("look at @codex", (p) => p.endsWith("codex")), null);
  assert.equal(run("run `@codex` as written"), null);
  assert.equal(store.tasksFor("codex").length, 0);
  done();
});

test("a plain prompt with nothing in the inbox prints nothing, which costs zero tokens", () => {
  const { store, done } = tempStore();
  assert.equal(handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "s", cwd: "/repo", prompt: "what is 2+2" }, ctx(store)), null);
  done();
});

test("a pending inbox item is injected once per session at the next prompt, then never again in that same session -- but a different open session of the same agent still sees it", () => {
  const { store, done } = tempStore();
  store.addTask({ from: "codex", to: "claude", goal: "review lease.ts", origin: "human_typed", idempotencyKey: "a" });
  const first = handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: "/repo", prompt: "hi" }, ctx(store));
  assert.match(ctxOf(first)!, /M9R inbox \(1 new\)/);
  assert.match(ctxOf(first)!, /T1 from @codex, typed by the user\] review lease\.ts/);
  assert.equal(handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: "/repo", prompt: "and again" }, ctx(store)), null);
  // A second open Claude session must not be starved just because session s1 already saw it -- confirmed live
  // 2026-09-22: with several Claude sessions open, whichever one prompted first silently ate the notification
  // for every other one, and the person had to manually ask a different session to check its inbox.
  const otherSession = handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "s2", cwd: "/repo", prompt: "new window" }, ctx(store));
  assert.match(ctxOf(otherSession)!, /T1 from @codex, typed by the user\] review lease\.ts/, "a different open session must still see a task it has not itself been shown yet");
  // But s2 itself must not repeat it a second time either.
  assert.equal(handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "s2", cwd: "/repo", prompt: "and again" }, ctx(store)), null);
  done();
});

test("Codex inbox work stays held until that session has an active M9R identity", () => {
  const { store, done } = tempStore();
  store.addTask({ from: "claude", to: "codex", goal: "review the governed bridge", origin: "human_typed", idempotencyKey: "codex-identity-gate" });
  const input = { hook_event_name: "UserPromptSubmit", session_id: "c1", cwd: "/repo", prompt: "hi" };

  const held = handleHookEvent(input, ctx(store, "codex"));
  const heldText = ctxOf(held) ?? "";
  assert.match(heldText, /reconnect.*M9R identity|M9R identity.*reconnect/i, "the session should get a safe explanation instead of silently losing delegated work");
  assert.doesNotMatch(heldText, /review the governed bridge|M9R inbox/i, "task contents must not enter an ungoverned session");
  assert.equal(store.cursorFor("codex", "c1", "/repo"), 0, "holding the task must not advance the session inbox cursor");
  assert.equal(store.tasksFor("codex")[0].deliveredAt, undefined, "holding the task must not mark it delivered");

  handleHookEvent({ ...input, hook_event_name: "SessionStart" }, ctx(store, "codex"));
  const delivered = handleHookEvent(input, ctx(store, "codex"));
  assert.match(ctxOf(delivered) ?? "", /review the governed bridge/, "a session with an issued identity should receive the pending task normally");
  assert.equal(store.tasksFor("codex")[0].deliveredSession, "c1");
  done();
});

test("an agent-initiated task that is still pending is labelled so the receiver does not act on it", () => {
  const { store, done } = tempStore();
  store.addTask({ from: "codex", to: "claude", goal: "delete the old branch", origin: "agent_initiated", idempotencyKey: "b" });
  const out = handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: "/repo", prompt: "hi" }, ctx(store));
  assert.match(ctxOf(out)!, /AWAITING THE USER'S APPROVAL, do not act on it yet/);
  done();
});

test("secrets typed into a mention are redacted before the task is stored", () => {
  const { store, done } = tempStore();
  handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "s", cwd: "/repo", prompt: "@codex use api_key=sk-abcdefghijklmnopqrstuvwxyz123456 to test" }, ctx(store));
  assert.doesNotMatch(store.tasksFor("codex")[0].goal, /sk-abcdefghijklmnopqrstuvwxyz123456/);
  done();
});

test("hook failures are silent: a broken store or unknown event prints nothing and never throws", () => {
  const { store, done } = tempStore();
  const broken = { ...store, registerEndpoint: () => { throw new Error("disk on fire"); } } as unknown as typeof store;
  assert.equal(handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt: "@codex hi" }, ctx(broken)), null);
  assert.equal(handleHookEvent({ hook_event_name: "PostToolUse" }, ctx(store)), null);
  assert.equal(handleHookEvent({}, ctx(store)), null);
  done();
});

test("text pasted into Claude Code arrives wrapped in <pasted_content> tags; the task keeps only what was asked", () => {
  const store = createLocalStore(mkdtempSync(join(tmpdir(), "m9r-paste-")));
  store.registerEndpoint({ provider: "codex", sessionId: "01a0aaaa-0000-7000-8000-000000000009", cwd: "C:/p" });
  handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "cc-1", cwd: "C:/p", prompt: '@codex <pasted_content id="6b01"> reply with only the word: ok </pasted_content>' }, { provider: "claude-code", store, pathExists: () => false, readIndex: () => null });
  assert.equal(store.getTask("T1")?.goal, "reply with only the word: ok");
});

test("mentions found only inside Claude Code pasted content do not dispatch phantom tasks", () => {
  const { store, done } = tempStore();
  store.registerEndpoint({ provider: "codex", sessionId: "codex-session", cwd: "C:/p" });
  const result = handleHookEvent({
    hook_event_name: "UserPromptSubmit",
    session_id: "claude-session",
    cwd: "C:/p",
    prompt: '<pasted_content id="6b01">@codex reply with only the word: ok</pasted_content>',
  }, ctx(store));

  assert.equal(store.tasksFor("codex").length, 0);
  assert.equal(result, null);
  done();
});

test("local state refuses an over-budget update and preserves its previous snapshot", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-store-capacity-"));
  try {
    const store = createLocalStore(root, { maxStateBytes: 512 });
    store.noteEvent("agent.connected", "baseline");
    const path = join(root, "state.json");
    const before = readFileSync(path, "utf8");
    assert.throws(() => store.addRule({ from: "codex", to: "claude", ttlMs: 60_000, note: "x".repeat(2_000) }), /capacity|byte limit/i);
    assert.equal(readFileSync(path, "utf8"), before, "the last complete state file survives the rejected update");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local state refuses to read a file beyond its configured byte ceiling", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-store-oversized-"));
  try {
    const path = join(root, "state.json");
    const oversized = " ".repeat(513);
    writeFileSync(path, oversized, "utf8");
    const store = createLocalStore(root, { maxStateBytes: 512 });
    assert.throws(() => store.listEndpoints(), /capacity|byte limit/i);
    assert.equal(readFileSync(path, "utf8"), oversized, "oversized state is not quarantined or overwritten automatically");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
