import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { consumeRollout, newWatchFile } from "@/lib/native/codex-watch-core";
import { createCodexWatcher } from "@/lib/native/codex-watch";
import { createLocalStore } from "@/lib/native/local-store";
import { standingInstructionBlock } from "@/lib/native/install-core";
import { nodeForCodex } from "@/lib/native/codex-delivery-core";

const line = (o: unknown) => JSON.stringify(o) + "\n";
const meta = (source: unknown = "vscode") => line({ type: "session_meta", payload: { id: "019f-test", cwd: "C:/proj", source } });
const turn = () => line({ type: "turn_context", payload: {} });
const user = (...texts: string[]) => line({ type: "response_item", payload: { type: "message", role: "user", content: texts.map((text) => ({ type: "input_text", text })) } });
const tool = () => line({ type: "response_item", payload: { type: "function_call" } });
const done = () => line({ type: "event_msg", payload: { type: "task_complete" } });

test("only a person's typed prompt counts: injected context, several-part messages and sub-agents never do", () => {
  const f = newWatchFile(0);
  const { events } = consumeRollout(meta() + user("# AGENTS.md instructions for x") + turn() + user("\n<environment_context>x</environment_context>") + turn() + user("part one", "part two") + turn() + user("@claude summarize a.txt") + turn() + user("[M9R T3] Task from @claude do it"), f);
  assert.deepEqual(events, [{ kind: "prompt", text: "@claude summarize a.txt" }]);
  const sub = newWatchFile(0);
  assert.deepEqual(consumeRollout(meta({ subagent: { other: "guardian" } }) + turn() + user("@claude hi"), sub).events, []);
});

test("a half-written last line waits for the next read", () => {
  const f = newWatchFile(0);
  const whole = meta() + turn() + user("@claude hello there");
  const cut = whole.slice(0, whole.length - 8);
  const first = consumeRollout(cut, f);
  assert.equal(first.events.length, 0);
  assert.ok(first.consumedChars < cut.length);
  const second = consumeRollout(whole.slice(first.consumedChars), f);
  assert.deepEqual(second.events, [{ kind: "prompt", text: "@claude hello there" }]);
});

function watchSetup() {
  const home = mkdtempSync(join(tmpdir(), "m9r-cw-"));
  const codex = join(home, "codex");
  const day = join(codex, "sessions", "2026", "09", "21");
  mkdirSync(day, { recursive: true });
  const store = createLocalStore(join(home, "m9r"));
  store.registerEndpoint({ provider: "claude-code", sessionId: "c1", cwd: "C:/proj" });
  return { day, store, start: () => createCodexWatcher(store, { codexHome: codex }) };
}

test("a mention typed in a Codex session becomes a task; history is not replayed; the same prompt is never routed twice", async () => {
  const { day, store, start } = watchSetup();
  const file = join(day, "rollout-2026-09-21T10-00-00-019f-test.jsonl");
  writeFileSync(file, meta() + turn() + user("@claude old mention from before we started"));
  await new Promise((r) => setTimeout(r, 60)); // file clocks and Date.now() differ by a few ms; a session that pre-dates the watcher must look older
  const watcher = start();
  watcher.refresh();
  assert.equal(watcher.tick(), 0, "history that was already there is skipped");
  appendFileSync(file, turn() + user("what is 2+2?") + turn() + user("@claude please summarize a.txt"));
  assert.equal(watcher.tick(), 1);
  const [task] = store.snapshot().tasks;
  assert.equal(task.from, "codex");
  assert.equal(task.to, "claude");
  assert.equal(task.approval, "not_needed");
  assert.equal(watcher.tick(), 0, "nothing new, nothing routed");
});

test("if Codex starts working on a forwarded mention, the pill's recent list says so once", () => {
  const { day, store, start } = watchSetup();
  const file = join(day, "rollout-2026-09-21T10-00-00-019f-test.jsonl");
  const watcher = start();
  writeFileSync(file, meta());
  watcher.refresh();
  appendFileSync(file, turn() + user("@claude count the lines in a.txt") + tool() + tool());
  watcher.tick();
  const doubles = store.snapshot().events.filter((e) => e.kind === "mention.double");
  assert.equal(doubles.length, 1);
  appendFileSync(file, done() + turn() + user("plain question") + tool());
  watcher.tick();
  assert.equal(store.snapshot().events.filter((e) => e.kind === "mention.double").length, 1, "a normal turn is never flagged");
});

test("Codex's copy of the standing note stands down for mentions but still does M9R's own tasks; Claude's copy has neither", () => {
  const codex = standingInstructionBlock("codex");
  assert.match(codex, /Reply only: M9R will pass that on\./);
  assert.match(codex, /\[M9R T and a number is a task M9R delivered to you: do it/);
  assert.doesNotMatch(standingInstructionBlock("claude"), /M9R will pass that on/);
});

test("inside the engine, codex.js is run with the node on PATH, never with the engine itself", () => {
  const b = String.fromCharCode(92);
  const w = (...parts: string[]) => parts.join(b);
  const tools = w("C:", "tools");
  const exists = (p: string) => p === w(tools, "node.exe");
  const engine = w("C:", "Users", "a", ".m9r", "bin", "m9r-engine.exe");
  assert.equal(nodeForCodex(engine, [w("C:", "x"), tools], exists), w(tools, "node.exe"));
  assert.equal(nodeForCodex(engine, [w("C:", "x")], exists), "node");
  const real = w("C:", "Program Files", "nodejs", "node.exe");
  assert.equal(nodeForCodex(real, [tools], exists), real);
});
