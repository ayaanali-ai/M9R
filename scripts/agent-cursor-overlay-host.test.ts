import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createAgentCursorOverlayHost } from "../src/lib/native/agent-cursor-overlay-host";

class FakeOverlayChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 12345;
  readonly commands: Array<Record<string, unknown>> = [];
  exitCode: number | null = null;
  killed = false;

  constructor(acknowledge: (message: { requestId: number; cmd: string }) => boolean = () => true) {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) {
        const message = JSON.parse(line) as { requestId: number; cmd: string };
        this.commands.push(message);
        if (acknowledge(message)) queueMicrotask(() => this.stdout.write(`${JSON.stringify({ event: "ack", requestId: message.requestId, ok: true })}\n`));
      }
    });
    this.stdin.on("end", () => {
      this.exitCode = 0;
      queueMicrotask(() => this.emit("exit", 0, null));
    });
    setTimeout(() => this.stdout.write('{"event":"ready"}\n'), 0);
  }

  kill(): boolean {
    this.killed = true;
    this.exitCode = 1;
    queueMicrotask(() => this.emit("exit", 1, null));
    return true;
  }
}

test("serializes acknowledged cursor frames and closes the renderer process on shutdown", async () => {
  let child: FakeOverlayChild | undefined;
  const launch: unknown[][] = [];
  const spawnProcess = ((...args: unknown[]) => {
    launch.push(args);
    child = new FakeOverlayChild();
    return child;
  }) as never;
  const host = createAgentCursorOverlayHost({ executablePath: "C:\\M9R\\m9r-native-input-host.exe", spawnProcess, pathExists: () => true });

  assert.equal(await host.upsert({ id: "agent-test", label: "Codex", color: [40, 140, 230], x: -1200, y: 80 }), true);
  assert.equal(await host.upsert({ id: "agent-test", label: "Codex", color: [40, 140, 230], x: -1190, y: 95 }), true);
  await host.hide("agent-test");
  await host.close();

  assert.equal(launch.length, 1, "all agents share one renderer process");
  assert.deepEqual(launch[0]!.slice(0, 2), ["C:\\M9R\\m9r-native-input-host.exe", ["--spawn-cursor-overlay"]]);
  assert.equal((launch[0]![2] as { windowsHide?: boolean }).windowsHide, true);
  assert.equal(child?.exitCode, 0, "EOF closes the renderer normally");
  assert.equal(child?.killed, false, "normal shutdown does not require process termination");
});

test("a renderer that was missing at startup is picked up once it shows up, instead of staying off forever", async () => {
  // Regression for a real, recurring cursor-presentation failure: the exe's
  // presence used to be checked once, by the caller, before this host was
  // even built -- a broker that started slightly ahead of an in-progress
  // install got a permanently undefined host for the rest of its life, with
  // every later cursor action failing identically and silently (no spawn
  // attempt at all, so nothing in the overlay's own debug log either) even
  // after the exe was fully in place. Confirmed against the live
  // cursor-overlay-debug.log: several real tasks show many repeated
  // "did not acknowledge" failures in a row with zero matching spawn/
  // ready-timeout/exit entries for that whole window -- consistent with the
  // host never even attempting to start, not with a slow or crashing start.
  const launched: FakeOverlayChild[] = [];
  const spawnProcess = ((..._args: unknown[]) => {
    const child = new FakeOverlayChild();
    launched.push(child);
    return child;
  }) as never;
  let exists = false;
  const host = createAgentCursorOverlayHost({ executablePath: "M9R-host.exe", spawnProcess, pathExists: () => exists });

  assert.equal(await host.upsert({ id: "agent-test", label: "Codex", color: [40, 140, 230], x: 10, y: 10 }), false,
    "no renderer exists yet, so presentation fails without ever spawning one");
  assert.equal(launched.length, 0, "a missing exe is never attempted");

  exists = true;
  assert.equal(await host.upsert({ id: "agent-test", label: "Codex", color: [40, 140, 230], x: 10, y: 10 }), true,
    "the exact same host picks up the renderer once it exists, without needing a new broker session");
  assert.equal(launched.length, 1);
  await host.close();
});

test("warming starts the transparent renderer once before the first task marker", async () => {
  const launched: FakeOverlayChild[] = [];
  const spawnProcess = ((..._args: unknown[]) => {
    const child = new FakeOverlayChild();
    launched.push(child);
    return child;
  }) as never;
  const host = createAgentCursorOverlayHost({ executablePath: "M9R-host.exe", spawnProcess, pathExists: () => true });

  assert.equal(await host.warm?.(), true);
  assert.equal(launched.length, 1);
  assert.deepEqual(launched[0]?.commands, [], "warming does not make a marker visible");
  assert.equal(await host.upsert({ id: "agent-test", label: "Codex", color: [40, 140, 230], x: 25, y: 35 }), true);
  assert.equal(launched.length, 1, "the first task reuses the warmed process");
  await host.close();
});

test("A2A bubbles require an acknowledged visible sender and sanitize bounded text", async () => {
  const launched: FakeOverlayChild[] = [];
  const spawnProcess = ((..._args: unknown[]) => {
    const child = new FakeOverlayChild();
    launched.push(child);
    return child;
  }) as never;
  const host = createAgentCursorOverlayHost({ executablePath: "M9R-host.exe", spawnProcess, pathExists: () => true });

  assert.equal(await host.say({ id: "agent-codex", text: "hello" }), false,
    "an invisible sender cannot produce a free-floating bubble");
  assert.equal(launched.length, 0, "a rejected bubble does not start the renderer");
  assert.equal(await host.upsert({ id: "agent-codex", label: "Codex", color: [40, 140, 230], x: 20, y: 30 }), true);
  assert.equal(await host.say({ id: "agent-codex", text: "  review\nthis\tfirst  " }), true);
  assert.deepEqual(launched[0]?.commands.at(-1), {
    cmd: "say", id: "agent-codex", text: "review this first", requestId: 2,
  });
  launched[0]!.kill();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(await host.say({ id: "agent-codex", text: "after renderer exit" }), false,
    "a dead renderer cannot acknowledge a bubble for a marker it no longer owns");
  await host.hide("agent-codex");
  assert.equal(await host.say({ id: "agent-codex", text: "after hide" }), false);
  await host.close();
});

test("a timed-out upsert still sends a real hide and cannot speak as a confirmed marker", async () => {
  const child = new FakeOverlayChild(message => message.cmd !== "upsert");
  const host = createAgentCursorOverlayHost({ executablePath: "fixture.exe", pathExists: () => true, spawnProcess: (() => child) as never });
  try {
    assert.equal(await host.upsert({ id: "uncertain", label: "Codex", x: 10, y: 10, color: [1, 2, 3] }), false);
    assert.equal(await host.say({ id: "uncertain", text: "hello" }), false);
    assert.equal(await host.hide("uncertain"), true);
    assert.deepEqual(child.commands.map(command => command.cmd), ["upsert", "hide"],
      "lost acknowledgement does not prove the renderer never displayed the marker");
  } finally { await host.close(); }
});

test("hide during initial startup follows its upsert instead of preceding it", async () => {
  const child = new FakeOverlayChild();
  const host = createAgentCursorOverlayHost({ executablePath: "fixture.exe", pathExists: () => true, spawnProcess: (() => child) as never });
  try {
    const placing = host.upsert({ id: "startup", label: "Codex", x: 10, y: 10, color: [1, 2, 3] });
    const hiding = host.hide("startup");
    assert.equal(await placing, true);
    assert.equal(await hiding, true);
    assert.deepEqual(child.commands.map(command => command.cmd), ["upsert", "hide"]);
  } finally { await host.close(); }
});

test("shutdown while an initial marker is queued finishes without respawning it", async () => {
  const launched: FakeOverlayChild[] = [];
  const host = createAgentCursorOverlayHost({ executablePath: "fixture.exe", pathExists: () => true,
    spawnProcess: (() => { const child = new FakeOverlayChild(); launched.push(child); return child; }) as never });
  const placing = host.upsert({ id: "shutdown", label: "Codex", x: 10, y: 10, color: [1, 2, 3] });
  await host.close();
  await placing;
  assert.ok(launched.every(child => child.exitCode !== null));
});
