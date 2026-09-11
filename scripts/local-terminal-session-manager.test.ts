import assert from "node:assert/strict";
import test from "node:test";
import { createTerminalSessionManager, type PtyFactory, type PtyHandle } from "../src/lib/local-terminal-session-manager.ts";

interface FakePtyHandle extends PtyHandle { emitData(data: string): void }

function fakeFactory(log: string[]): PtyFactory {
  return {
    spawn(command, args, options) {
      log.push(`spawn:${command}:${args.join(",")}:${options.cwd}:${options.cols}x${options.rows}`);
      let onData: (data: string) => void = () => {};
      let onExit: (event: { exitCode: number; signal?: number }) => void = () => {};
      return {
        pid: 42,
        onData(listener) { onData = listener; return { dispose() {} }; },
        onExit(listener) { onExit = listener; return { dispose() {} }; },
        write(data) { log.push(`write:${data}`); },
        resize(cols, rows) { log.push(`resize:${cols}x${rows}`); },
        kill() { log.push("kill"); onExit({ exitCode: 0 }); },
        emitData(data: string) { onData(data); },
      } as FakePtyHandle;
    },
  };
}

test("sessions survive client detach and retain bounded replay output", () => {
  const log: string[] = [];
  const manager = createTerminalSessionManager({ repositoryRoot: process.cwd(), ptyFactory: fakeFactory(log), maxReplayBytes: 32 });
  const session = manager.spawn({ provider: "codex", cwd: ".", cols: 100, rows: 30 });
  const output: string[] = [];
  const detach = manager.attach(session.id, (event) => output.push(event.data));
  (session.pty as FakePtyHandle).emitData("first output");
  detach();
  (session.pty as FakePtyHandle).emitData(" survives detach ");
  const replayed: string[] = [];
  manager.attach(session.id, (event) => replayed.push(event.data));
  assert.match(replayed.join(""), /survives detach/);
  assert.equal(manager.list()[0].status, "running");
});

test("input, resize, and close are routed only to an existing session", () => {
  const log: string[] = [];
  const manager = createTerminalSessionManager({ repositoryRoot: process.cwd(), ptyFactory: fakeFactory(log) });
  const session = manager.spawn({ provider: "claude-code", cwd: ".", cols: 80, rows: 24 });
  manager.write(session.id, "hello\r");
  manager.resize(session.id, 120, 40);
  manager.close(session.id);
  assert.ok(log.includes("write:hello\r"));
  assert.ok(log.includes("resize:120x40"));
  assert.ok(log.includes("kill"));
  assert.throws(() => manager.write("missing", "x"), /not found/i);
});

test("environment secrets owned by OathLock are not inherited by provider terminals", () => {
  const log: string[] = [];
  let capturedEnv: Record<string, string> = {};
  const factory: PtyFactory = {
    spawn(_command, _args, options) {
      capturedEnv = options.env;
      return fakeFactory(log).spawn(_command, _args, options);
    },
  };
  const manager = createTerminalSessionManager({
    repositoryRoot: process.cwd(),
    ptyFactory: factory,
    env: { PATH: "safe", OATHLOCK_AGENT_TOKEN: "secret", OATHLOCK_BRIDGE_TOKEN: "secret", HOME: "home" },
  });
  manager.spawn({ provider: "grok-build", cwd: ".", cols: 80, rows: 24 });
  assert.equal(capturedEnv.PATH, "safe");
  assert.equal(capturedEnv.HOME, "home");
  assert.equal(capturedEnv.OATHLOCK_AGENT_TOKEN, undefined);
  assert.equal(capturedEnv.OATHLOCK_BRIDGE_TOKEN, undefined);
  assert.match(capturedEnv.OATHLOCK_TERMINAL_SESSION_ID, /^[0-9a-f-]{36}$/);
});

test("local integration state updates are session-scoped and require no model call", () => {
  const manager = createTerminalSessionManager({ repositoryRoot: process.cwd(), ptyFactory: fakeFactory([]) });
  const session = manager.spawn({ provider: "claude-code", cwd: ".", cols: 80, rows: 24 });
  assert.equal(manager.list()[0].agentState, "idle");
  manager.reportState(session.id, "working");
  assert.equal(manager.list()[0].agentState, "working");
  manager.reportState(session.id, "blocked");
  assert.equal(manager.list()[0].agentState, "blocked");
  assert.throws(() => manager.reportState("missing", "idle"), /not found/i);
});

test("session lifecycle changes notify runtime observers", () => {
  const changes: string[] = [];
  const manager = createTerminalSessionManager({
    repositoryRoot: process.cwd(),
    ptyFactory: fakeFactory([]),
    onSessionsChanged: (sessions) => changes.push(sessions.map((session) => `${session.status}:${session.agentState}`).join(",")),
  });
  const session = manager.spawn({ provider: "codex", cwd: ".", cols: 80, rows: 24 });
  manager.reportState(session.id, "working");
  manager.close(session.id);

  assert.deepEqual(changes, ["running:idle", "running:working", "exited:exited"]);
});

test("runtime shutdown terminates every live PTY and is idempotent", () => {
  const log: string[] = [];
  const manager = createTerminalSessionManager({ repositoryRoot: process.cwd(), ptyFactory: fakeFactory(log) });
  manager.spawn({ provider: "codex", cwd: ".", cols: 80, rows: 24 });
  manager.spawn({ provider: "claude-code", cwd: ".", cols: 80, rows: 24 });

  manager.shutdown();
  manager.shutdown();

  assert.equal(log.filter((entry) => entry === "kill").length, 2);
  assert.deepEqual(manager.list().map((session) => session.status), ["exited", "exited"]);
});

test("resident activity is visible as a provider-scoped read-only session", () => {
  const manager = createTerminalSessionManager({ repositoryRoot: process.cwd(), ptyFactory: fakeFactory([]) });
  manager.observe({
    protocolVersion: "oathlock.resident-activity.v1",
    grantId: "grant-visible-1234",
    provider: "claude-code",
    kind: "started",
    occurredAt: new Date().toISOString(),
    sequence: 1,
    stream: "system",
    data: "Bounded assignment started.\r\n",
  });
  const session = manager.listFor("claude-code")[0];
  assert.equal(session.source, "resident");
  assert.equal(session.interactive, false);
  assert.equal(session.grantId, "grant-visible-1234");
  assert.equal(manager.listFor("codex").length, 0);
  assert.throws(() => manager.write(session.id, "inject"), /read-only/i);
  assert.throws(() => manager.close(session.id), /read-only/i);
});
