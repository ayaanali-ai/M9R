import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { codexWorkerArgs, createWebLiveSessions, loadAgentsConfig, parseCodexLine, webAgentPrompt, type WorkerProcess } from "@/lib/native/web-live-sessions";
import type { SessionEvent } from "@/lib/native/web-ui-bridge";

const line = (v: unknown) => `${JSON.stringify(v)}\n`;

function fakeClaude() {
  const spawned: Array<{ args: string[]; cwd: string; written: string[]; out: (t: string) => void; exit: (c: number | null) => void; killed: () => boolean }> = [];
  const spawn = (_command: string, args: string[], cwd: string) => {
    const emitter = new EventEmitter();
    const stdout = new EventEmitter();
    const written: string[] = [];
    let killed = false;
    spawned.push({ args, cwd, written, out: (t) => stdout.emit("data", Buffer.from(t)), exit: (c) => emitter.emit("exit", c), killed: () => killed });
    return {
      stdin: { write: (c: string) => { written.push(c); return true; }, end: () => undefined },
      stdout: stdout as never,
      on: (event: string, listener: (...a: any[]) => void) => emitter.on(event, listener),
      kill: () => { killed = true; emitter.emit("exit", null); },
    } as never;
  };
  return { spawn, spawned };
}

function setup(extra: Partial<Parameters<typeof createWebLiveSessions>[0]> = {}) {
  const root = mkdtempSync(join(tmpdir(), "m9r-live-"));
  const identities: Array<{ handle: string; provider: string; sessionId: string }> = [];
  const revoked: string[] = [];
  const events: SessionEvent[] = [];
  const claude = fakeClaude();
  const sessions = createWebLiveSessions({
    agents: [{ handle: "claude", provider: "claude-code", folder: root }, { handle: "codex", provider: "codex", folder: root }],
    storeRoot: root, repoRoot: process.cwd(), brokerPort: 47999,
    store: { issueIdentity: (handle, provider, sessionId) => { identities.push({ handle, provider, sessionId }); return { token: `tok-${identities.length}-abcdef` }; }, revokeIdentity: (id) => { revoked.push(id); } },
    env: {}, onEvent: (e) => events.push(e), spawnClaude: claude.spawn, ...extra,
  });
  return { root, sessions, identities, revoked, events, claude, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("claude starts lazily on the first message with only M9R tools, its own identity, and the token in the system prompt", () => {
  const t = setup();
  try {
    assert.equal(t.claude.spawned.length, 0, "nothing starts before the first message");
    assert.deepEqual(t.sessions.snapshot().map((s) => s.status), ["idle", "idle"]);
    const r = t.sessions.deliver("claude", "read the pricing page");
    assert.deepEqual(r, { ok: true, mode: "started" });
    assert.equal(t.claude.spawned.length, 1);
    const args = t.claude.spawned[0].args;
    assert.equal(args[args.indexOf("--tools") + 1], "", "web-only profile: no built-in tools");
    assert.ok(args.includes("--strict-mcp-config") && args.includes("--input-format"));
    const prompt = args[args.indexOf("--append-system-prompt") + 1];
    assert.match(prompt, /You are @claude/);
    assert.match(prompt, /tok-1-abcdef/);
    assert.deepEqual(t.identities.map((i) => [i.handle, i.provider]), [["claude", "claude-code"]]);
    assert.match(t.identities[0].sessionId, /^web-claude-[0-9a-f]{12}$/);
    assert.equal(t.sessions.snapshot()[0].status, "starting");
    t.claude.spawned[0].out(line({ type: "system", subtype: "init", session_id: "cs-1" }));
    assert.equal(t.sessions.snapshot()[0].status, "working");
    assert.ok(t.sessions.secrets().includes("tok-1-abcdef"), "the token is known to the bridge so it can be redacted");
  } finally { t.done(); }
});

test("a message while working interrupts and redirects; says and results stream as events; idle after the answer", () => {
  const t = setup();
  try {
    t.sessions.deliver("claude", "read all three sections");
    const proc = t.claude.spawned[0];
    proc.out(line({ type: "system", subtype: "init", session_id: "cs-1" }));
    proc.out(line({ type: "assistant", message: { content: [{ type: "text", text: "Opening the page." }, { type: "tool_use", name: "mcp__m9r__m9r_web_open", input: { url: "https://x.test/" } }] } }));
    const r = t.sessions.deliver("claude", "stop, only read shipping");
    assert.deepEqual(r, { ok: true, mode: "interrupted" });
    const control = JSON.parse(proc.written[1]);
    assert.deepEqual([control.type, control.request.subtype], ["control_request", "interrupt"]);
    assert.match(JSON.parse(proc.written[2]).message.content[0].text, /\] stop, only read shipping$/);
    proc.out(line({ type: "result", is_error: true, result: "", num_turns: 1, total_cost_usd: 0.01, session_id: "cs-1" }));
    assert.ok(!t.events.some((e) => e.kind === "result"), "the interrupted turn is neither an answer nor an error");
    assert.equal(t.sessions.snapshot()[0].status, "working", "the aborted turn's result does not end the new instruction");
    proc.out(line({ type: "result", result: "Shipping is free over $50.", num_turns: 1, total_cost_usd: 0.01, session_id: "cs-1" }));
    assert.equal(t.sessions.snapshot()[0].status, "idle");
    assert.ok(t.events.some((e) => e.kind === "say" && e.text === "Opening the page."));
    assert.ok(t.events.some((e) => e.kind === "tool" && e.name === "mcp__m9r__m9r_web_open"));
    assert.ok(t.events.some((e) => e.kind === "result" && e.text === "Shipping is free over $50."));
  } finally { t.done(); }
});

test("a crash is reported and the next message restarts the session with --resume; stop is not a crash", () => {
  const t = setup();
  try {
    t.sessions.deliver("claude", "go");
    t.claude.spawned[0].out(line({ type: "system", subtype: "init", session_id: "cs-9" }));
    t.claude.spawned[0].exit(1);
    assert.equal(t.sessions.snapshot()[0].status, "failed");
    assert.ok(t.events.some((e) => e.kind === "system" && /ended unexpectedly/.test(e.text)));
    assert.equal(t.revoked.length, 1, "the dead session's identity is revoked");
    assert.deepEqual(t.sessions.deliver("claude", "again"), { ok: true, mode: "started" });
    const args = t.claude.spawned[1].args;
    assert.equal(args[args.indexOf("--resume") + 1], "cs-9");
    assert.equal(t.identities.length, 2, "each session gets a distinct identity");
    assert.notEqual(t.identities[0].sessionId, t.identities[1].sessionId);
    t.sessions.stop("claude");
    assert.equal(t.claude.spawned[1].killed(), true);
    assert.equal(t.sessions.snapshot()[0].status, "stopped");
    assert.ok(!t.events.some((e, i) => i > 0 && e.kind === "system" && /ended unexpectedly/.test(e.text) && t.events.indexOf(e) > t.events.findIndex((x) => x.kind === "system")));
  } finally { t.done(); }
});

test("nothing starts while an API key is set", () => {
  const t = setup({ env: { ANTHROPIC_API_KEY: "sk-test" } });
  try {
    const r = t.sessions.deliver("claude", "hi");
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /ANTHROPIC_API_KEY/);
    assert.equal(t.claude.spawned.length, 0);
  } finally { t.done(); }
});

test("codex is a per-message worker that resumes its thread; a new message mid-run restarts the worker", () => {
  const workers: Array<{ args: string[]; out: (t: string) => void; exit: (c: number) => void; killed: boolean }> = [];
  const spawnWorker = (_c: string, args: string[]): WorkerProcess => {
    const emitter = new EventEmitter();
    const stdout = new EventEmitter();
    const w = { args, out: (t: string) => stdout.emit("data", Buffer.from(t)), exit: (c: number) => emitter.emit("exit", c), killed: false };
    workers.push(w);
    return { stdout: stdout as never, on: (e: string, l: (...a: any[]) => void) => emitter.on(e, l), kill: () => { w.killed = true; }, pid: undefined } as never;
  };
  const t = setup({ spawnWorker, codexCli: () => "C:/codex.js" });
  try {
    assert.deepEqual(t.sessions.deliver("codex", "check the repo"), { ok: true, mode: "started" });
    assert.equal(workers[0].args[1], "exec");
    workers[0].out(line({ type: "thread.started", thread_id: "th-1" }));
    workers[0].out(line({ type: "item.completed", item: { type: "agent_message", text: "Looking at the repo." } }));
    assert.deepEqual(t.sessions.deliver("codex", "only the stars"), { ok: true, mode: "restarted-worker" });
    assert.deepEqual(workers[1].args.slice(1, 4), ["exec", "resume", "th-1"]);
    workers[0].exit(1);
    assert.equal(t.sessions.snapshot()[1].status, "working", "the killed worker's exit does not touch the new one");
    workers[1].out(line({ type: "item.completed", item: { type: "agent_message", text: "12k stars." } }));
    workers[1].exit(0);
    assert.equal(t.sessions.snapshot()[1].status, "idle");
    assert.ok(t.events.some((e) => e.kind === "result" && e.text === "12k stars."));
    assert.match(t.sessions.snapshot()[1].doing, /one run per message/);
  } finally { t.done(); }
});

test("agents.json: valid entries load, bad ones are skipped with a reason; defaults when absent", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-agents-"));
  try {
    const d = loadAgentsConfig(root, { env: {}, cwd: root, detect: { codex: () => true, opencode: () => false } });
    assert.deepEqual(d.agents.map((a) => [a.handle, a.provider, a.folder]), [["claude", "claude-code", root], ["codex", "codex", root]]);
    assert.equal(loadAgentsConfig(root, { env: { M9R_AGENT_FOLDER: "C:/proj" }, cwd: root, detect: { codex: () => false, opencode: () => false } }).agents[0].folder, "C:/proj");
    mkdirSync(join(root, "proj"));
    writeFileSync(join(root, "agents.json"), JSON.stringify({ agents: [
      { handle: "@Claude", provider: "claude-code", folder: "proj", profile: "hands" },
      { handle: "all", provider: "codex" },
      { handle: "gem", provider: "gemini" },
      { handle: "codex", provider: "codex", folder: join(root, "missing") },
    ] }));
    const c = loadAgentsConfig(root, { env: {}, cwd: root });
    assert.deepEqual(c.agents.map((a) => [a.handle, a.folder, a.profile]), [["claude", join(root, "proj"), "hands"]]);
    assert.equal(c.problems.length, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("helpers: codex JSONL parsing, resume args, and the agent prompt", () => {
  assert.deepEqual(parseCodexLine(JSON.stringify({ type: "thread.started", thread_id: "a" })), [{ kind: "thread", id: "a" }]);
  assert.deepEqual(parseCodexLine("nope"), []);
  const fresh = codexWorkerArgs({ prompt: "p", folder: "C:/f", launcher: "L", storeRoot: "R", brokerPort: 1 });
  assert.deepEqual(fresh.slice(0, 4), ["exec", "p", "--cd", "C:/f"]);
  assert.ok(fresh.includes('sandbox_mode="read-only"'));
  assert.match(webAgentPrompt("claude", "T", ["codex"]), /@codex/);
});

test("agents in the room message each other directly: the ask reaches the teammate's session, the answer goes back, and a loop is capped", async () => {
  const tasks: any[] = [];
  const approvals: string[] = [];
  const store = {
    issueIdentity: (handle: string, _p: string, sessionId: string) => ({ token: `tok-${handle}-${sessionId.slice(-4)}` }),
    revokeIdentity: () => undefined,
    tasksFor: (handle: string) => tasks.filter((t) => t.to === handle),
    tasksFrom: (handle: string) => tasks.filter((t) => t.from === handle),
    setApproval: (id: string, approval: string) => { approvals.push(`${id}:${approval}`); const t = tasks.find((x) => x.id === id); if (t) t.approval = approval; },
    markDelivered: (ids: string[]) => { for (const id of ids) tasks.find((t) => t.id === id).deliveredAt = "now"; },
    setAnswerPushed: (id: string) => { tasks.find((t) => t.id === id).answerPushedAt = "now"; },
    markResultShown: (ids: string[]) => { for (const id of ids) tasks.find((t) => t.id === id).resultShownAt = "now"; },
  };
  const root = mkdtempSync(join(tmpdir(), "m9r-bridge-"));
  const claude = fakeClaude();
  const sessions = createWebLiveSessions({
    agents: [{ handle: "claude", provider: "claude-code", folder: root }, { handle: "opencode", provider: "claude-code", folder: root }],
    storeRoot: root, repoRoot: process.cwd(), brokerPort: 47999, store, env: {}, spawnClaude: claude.spawn,
  } as never);
  try {
    tasks.push({ id: "T1", from: "claude", to: "opencode", goal: "Which plan has the API tier?", origin: "agent_initiated", approval: "pending" });
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(claude.spawned.length, 1, "the teammate's session was started for the ask");
    assert.match(claude.spawned[0].written.join(""), /@claude messaged you \(T1\)/);
    assert.deepEqual(approvals, ["T1:approved"], "an ask between two of the owner's own agents in the room needs no approval");
    assert.ok(tasks[0].deliveredAt);
    tasks[0].resultSummary = "Pro and Team.";
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(claude.spawned.length, 2, "the answer started the asker's session");
    assert.match(claude.spawned[1].written.join(""), /@opencode answered T1: Pro and Team\./);
    assert.ok(tasks[0].answerPushedAt);
  } finally {
    sessions.close();
    rmSync(root, { recursive: true, force: true });
  }
});
