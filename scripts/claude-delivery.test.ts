import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createClaudeDeliveryAdapter } from "../src/lib/native/claude-delivery.ts";
import { createLocalStore } from "../src/lib/native/local-store.ts";
import type { LiveProcess } from "../src/lib/native/live-session-core.ts";

class FakeClaudeProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly writes: string[] = [];
  killed = false;
  readonly stdin = {
    write: (chunk: string): void => { this.writes.push(chunk); },
    end: (): void => undefined,
  };

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    this.emit("exit", null);
  }
}

function fixture(withIdentity = true) {
  const root = mkdtempSync(join(tmpdir(), "m9r-claude-delivery-"));
  const homeDir = join(root, "home");
  const claudeDir = join(homeDir, ".claude");
  const sessionsDir = join(claudeDir, "sessions");
  const project = join(root, "project");
  const mcpConfig = join(claudeDir, "m9r.mcp.json");
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(mcpConfig, "{}\n", "utf8");

  const sessionId = "claude-session-1";
  writeFileSync(join(sessionsDir, `${process.pid}.json`), JSON.stringify({
    pid: process.pid,
    sessionId,
    cwd: project,
    status: "idle",
    updatedAt: Date.now(),
  }), "utf8");

  const store = createLocalStore(root);
  store.registerEndpoint({ provider: "claude-code", sessionId, cwd: project });
  if (withIdentity) store.issueIdentity("claude", "claude-code", sessionId);
  const task = store.addTask({
    from: "codex",
    to: "claude",
    goal: "perform the harmless delivery check",
    origin: "human_typed",
    idempotencyKey: "claude-delivery-check",
    cwd: project,
    targetSession: sessionId,
  }).task;

  return {
    root,
    homeDir,
    claudeDir,
    sessionsDir,
    project,
    mcpConfig,
    sessionId,
    store,
    task,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function adapterFor(
  f: ReturnType<typeof fixture>,
  child: FakeClaudeProcess,
  capture?: { command?: string; args?: string[]; cwd?: string },
) {
  return createClaudeDeliveryAdapter({
    root: f.root,
    homeDir: f.homeDir,
    env: { CLAUDE_CONFIG_DIR: f.claudeDir, M9R_HOME: f.root },
    mcpConfigPaths: [f.mcpConfig],
    spawnClaude: (command, args, cwd) => {
      if (capture) Object.assign(capture, { command, args, cwd });
      return child as unknown as LiveProcess;
    },
  }, f.store);
}

test("Claude delivery resumes the one exact idle session and writes a real user turn", async () => {
  const f = fixture();
  try {
    const child = new FakeClaudeProcess();
    const capture: { command?: string; args?: string[]; cwd?: string } = {};
    await adapterFor(f, child, capture)(f.task.id);

    assert.equal(capture.command, "claude");
    assert.equal(capture.cwd, f.project);
    const resumeAt = capture.args?.indexOf("--resume") ?? -1;
    assert.equal(resumeAt >= 0 ? capture.args?.[resumeAt + 1] : undefined, f.sessionId);
    assert.ok(capture.args?.includes(f.mcpConfig));
    assert.equal(child.writes.length, 1);
    const message = JSON.parse(child.writes[0]) as { type?: string; message?: { content?: Array<{ text?: string }> } };
    assert.equal(message.type, "user");
    assert.match(message.message?.content?.[0]?.text ?? "", /perform the harmless delivery check/);
    assert.equal(f.store.getTask(f.task.id)?.delivery?.state, "queued");
    assert.equal(f.store.getTask(f.task.id)?.deliveredSession, f.sessionId);

    child.stdout.emit("data", `${JSON.stringify({ type: "system", subtype: "init", session_id: f.sessionId })}\n`);
    child.stdout.emit("data", `${JSON.stringify({ type: "result", is_error: false, result: "accepted", num_turns: 1, total_cost_usd: 0, session_id: f.sessionId })}\n`);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(child.killed, true, "a completed resumed transport is closed without killing the user's conversation");
  } finally { f.cleanup(); }
});

test("Claude delivery recovers a missing identity from one exact live registry session", async () => {
  const f = fixture(false);
  try {
    const child = new FakeClaudeProcess();
    await adapterFor(f, child)(f.task.id);
    assert.equal(child.writes.length, 1);
    assert.ok(f.store.identityTokenFor("claude", f.sessionId), "the exact live session is rebound without opening a new conversation");
    assert.equal(f.store.getTask(f.task.id)?.delivery?.state, "queued");
  } finally { f.cleanup(); }
});

test("Claude delivery refuses to guess when more than one idle authenticated session matches", async () => {
  const f = fixture();
  try {
    const secondSession = "claude-session-2";
    writeFileSync(join(f.sessionsDir, "second.json"), JSON.stringify({
      pid: process.pid,
      sessionId: secondSession,
      cwd: f.project,
      status: "idle",
      updatedAt: Date.now(),
    }), "utf8");
    f.store.registerEndpoint({ provider: "claude-code", sessionId: secondSession, cwd: f.project });
    f.store.issueIdentity("claude", "claude-code", secondSession);
    const unpinned = f.store.addTask({
      from: "codex", to: "claude", goal: "do not guess this session", origin: "human_typed",
      idempotencyKey: "claude-ambiguous", cwd: f.project,
    }).task;
    const child = new FakeClaudeProcess();
    await adapterFor(f, child)(unpinned.id);
    assert.equal(child.writes.length, 0);
    assert.equal(f.store.getTask(unpinned.id)?.delivery, undefined, "ambiguous work remains available to a trusted hook boundary");
  } finally { f.cleanup(); }
});

test("Claude delivery records uncertainty when the resumed process exits before a result", async () => {
  const f = fixture();
  try {
    const child = new FakeClaudeProcess();
    await adapterFor(f, child)(f.task.id);
    child.kill();
    const delivery = f.store.getTask(f.task.id)?.delivery;
    assert.equal(delivery?.state, "uncertain");
    assert.match(delivery?.error ?? "", /exited before M9R confirmed/i);
  } finally { f.cleanup(); }
});

test("Claude delivery fails closed if --resume reports a different conversation", async () => {
  const f = fixture();
  try {
    const child = new FakeClaudeProcess();
    await adapterFor(f, child)(f.task.id);
    child.stdout.emit("data", `${JSON.stringify({ type: "system", subtype: "init", session_id: "unexpected-session" })}\n`);
    const delivery = f.store.getTask(f.task.id)?.delivery;
    assert.equal(delivery?.state, "uncertain");
    assert.match(delivery?.error ?? "", /different session/i);
  } finally { f.cleanup(); }
});
