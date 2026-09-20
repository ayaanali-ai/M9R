import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalStore, defaultStoreRoot, handleForProvider } from "@/lib/native/local-store";
import { handleHookEvent } from "@/lib/native/hook-handler";

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
  assert.equal(defaultStoreRoot("/home/u", {}), join("/home/u", ".m9r"));
  assert.equal(defaultStoreRoot("/home/u", { M9R_HOME: "/tmp/x" }), "/tmp/x");
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

test("state survives a new store instance on the same folder, cursors are per agent and only move forward", () => {
  const { root, store, done } = tempStore();
  store.addTask(task());
  store.setCursor("claude", "s1", 5);
  store.setCursor("claude", "s1", 3);
  const again = createLocalStore(root);
  assert.equal(again.getTask("T1")?.goal, "look at the reconnect bug");
  assert.equal(again.cursorFor("claude", "s1"), 5);
  assert.equal(again.cursorFor("claude", "other"), 5, "delivery is once per agent, not per window");
  assert.equal(again.cursorFor("codex", "s1"), 0);
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
const ctxOf = (o: any) => o?.hookSpecificOutput?.additionalContext as string | undefined;

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

test("a pending inbox item is injected once per agent at the next prompt, then never again in any window", () => {
  const { store, done } = tempStore();
  store.addTask({ from: "codex", to: "claude", goal: "review lease.ts", origin: "human_typed", idempotencyKey: "a" });
  const first = handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: "/repo", prompt: "hi" }, ctx(store));
  assert.match(ctxOf(first)!, /M9R inbox \(1 new\)/);
  assert.match(ctxOf(first)!, /T1 from @codex, typed by the user\] review lease\.ts/);
  assert.equal(handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: "/repo", prompt: "and again" }, ctx(store)), null);
  const otherSession = handleHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "s2", cwd: "/repo", prompt: "new window" }, ctx(store));
  assert.equal(otherSession, null, "a new window of the same agent must not repeat a task that was already delivered");
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
