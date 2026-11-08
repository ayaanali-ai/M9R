import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createAgentCursorOverlayHost } from "../src/lib/native/agent-cursor-overlay-host";

class FakeOverlayChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = null;
  readonly pid = 12345;
  exitCode: number | null = null;
  killed = false;

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) {
        const message = JSON.parse(line) as { requestId: number; cmd: string };
        queueMicrotask(() => this.stdout.write(`${JSON.stringify({ event: "ack", requestId: message.requestId, ok: true })}\n`));
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
  const host = createAgentCursorOverlayHost({ executablePath: "C:\\M9R\\m9r-native-input-host.exe", spawnProcess });

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
