import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { WebSocket } from "ws";
import { createMissionRelayServer } from "../services/mission-relay/src/server.ts";
import {
  MISSION_RELAY_FRAME_VERSION,
  parseRelayFrame,
  type RelayFrame,
} from "@/lib/mission/mission-relay-protocol";
import { decodePtyBytes, encodePtyBytes } from "@/lib/mission/mission-pty-protocol";
import { MissionPtyRuntime, createNodePtySpawner } from "@/lib/mission/mission-pty-runtime";

/**
 * End-to-end proof for the terminal foundation: a real shell process, the real
 * Relay over real WebSockets, and a viewer that only ever speaks relay frames.
 * Nothing here is stubbed except the authenticator.
 */

const WORKSPACE = "workspace-1";
const CHANNEL = "channel-1";

function frame(type: string, payload: unknown): RelayFrame {
  return {
    version: MISSION_RELAY_FRAME_VERSION,
    frameId: `frame-${Math.random().toString(36).slice(2)}`,
    type,
    workspaceId: WORKSPACE,
    channelId: CHANNEL,
    correlationId: "correlation-1",
    causationId: null,
    idempotencyKey: null,
    sentAt: new Date().toISOString(),
    payload,
  };
}

async function openSocket(port: number, authType: "auth.browser" | "auth.bridge") {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(socket, "open");
  const frames: RelayFrame[] = [];
  socket.on("message", (data) => {
    const parsed = parseRelayFrame(JSON.parse(String(data)));
    if (parsed.ok) frames.push(parsed.frame);
  });
  socket.send(JSON.stringify(frame(authType, { credential: authType === "auth.bridge" ? "bridge" : "viewer" })));
  // The relay handles each inbound message fire-and-forget, so subscribing
  // before relay.ready arrives can be processed while auth is still pending.
  await waitFor(() => frames.some((f) => f.type === "relay.ready"));
  socket.send(JSON.stringify(frame("workspace.subscribe", { cursor: null })));
  return { socket, frames };
}

/** Polls until a predicate holds, so the test never depends on a fixed sleep. */
async function waitFor<T>(probe: () => T | null | undefined, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== null && value !== undefined && value !== false) return value as T;
    if (Date.now() > deadline) throw new Error("Timed out waiting for the expected relay state.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("a viewer drives a real shell end to end through the relay", async (t) => {
  const { server, service } = createMissionRelayServer({
    port: 0,
    host: "127.0.0.1",
    authenticator: {
      async authenticate({ kind }) {
        return { kind: kind === "bridge" ? "bridge" : "human", id: kind === "bridge" ? "bridge-1" : "viewer-1", workspaceIds: [WORKSPACE] };
      },
    },
    loadMissionSnapshot: async () => ({}),
    loadWorkspaceSnapshot: async () => ({}),
  });
  // createMissionRelayServer calls listen() itself, so the event may already
  // have fired by the time we get here -- awaiting it unconditionally hangs.
  if (!server.listening) await once(server, "listening");
  const port = (server.address() as { port: number }).port;

  const host = await openSocket(port, "auth.bridge");
  const viewer = await openSocket(port, "auth.browser");
  await waitFor(() => host.frames.some((f) => f.type === "workspace.snapshot") && viewer.frames.some((f) => f.type === "workspace.snapshot"));

  // The host side is the real runtime driving a real node-pty process.
  const runtime = new MissionPtyRuntime({
    spawn: await createNodePtySpawner(),
    transport: {
      async sendTerminalFrame({ type, payload }) {
        host.socket.send(JSON.stringify(frame(type, payload)));
      },
    },
  });
  host.socket.on("message", (data) => {
    const parsed = parseRelayFrame(JSON.parse(String(data)));
    if (parsed.ok) runtime.handleFrame(parsed.frame);
  });

  t.after(() => {
    runtime.closeAll();
    host.socket.close();
    viewer.socket.close();
    server.close();
    void service;
  });

  const sessionId = await runtime.open({ channelId: CHANNEL, cols: 80, rows: 24, title: "Ayaan's terminal" });

  // The viewer learns about the pane without ever touching the host machine.
  const state = await waitFor(() => viewer.frames.find((f) => f.type === "pty.state" && (f.payload as { sessionId: string }).sessionId === sessionId));
  assert.equal((state.payload as { status: string }).status, "running");

  const outputSoFar = () => viewer.frames
    .filter((f) => f.type === "pty.output" && (f.payload as { sessionId: string }).sessionId === sessionId)
    .map((f) => Buffer.from(decodePtyBytes((f.payload as { data: string }).data)).toString("utf8"))
    .join("");

  // Wait for the shell's own prompt before typing, so input isn't swallowed
  // by a shell that hasn't finished starting.
  await waitFor(() => outputSoFar().length > 0);

  // Typed by the viewer, over the relay, into a shell on the "host" machine.
  viewer.socket.send(JSON.stringify(frame("pty.input", { sessionId, data: encodePtyBytes(new Uint8Array(Buffer.from("echo RELAY_PTY_OK\r", "utf8"))) })));

  await waitFor(() => outputSoFar().includes("RELAY_PTY_OK"));
  assert.ok(outputSoFar().includes("RELAY_PTY_OK"), "viewer should see the command's real output");

  // Sequence numbers must be strictly increasing, or a viewer cannot tell a
  // reordered stream from a correct one.
  const seqs = viewer.frames
    .filter((f) => f.type === "pty.output" && (f.payload as { sessionId: string }).sessionId === sessionId)
    .map((f) => (f.payload as { seq: number }).seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
});

test("a spawned terminal does not inherit this process's own Claude Code session identity", async (t) => {
  // The real bug found live: this test process is itself a Claude Code
  // session, so process.env genuinely carries CLAUDE_CODE_CHILD_SESSION --
  // if createNodePtySpawner ever stops filtering it, this must fail, not a
  // hand-picked fixture value that could drift from reality.
  const contaminatingVar = "CLAUDE_CODE_CHILD_SESSION";
  process.env[contaminatingVar] = "1";
  t.after(() => { delete process.env[contaminatingVar]; });

  const spawn = await createNodePtySpawner();
  const shell = process.platform === "win32" ? (process.env.COMSPEC ?? "cmd.exe") : "/bin/sh";
  const child = spawn({ shell, args: [], cwd: process.cwd(), cols: 80, rows: 24, env: {} });
  t.after(() => child.kill());

  let output = "";
  child.onData((data) => { output += data; });
  const printEnvCommand = process.platform === "win32" ? `echo VAR_IS:%${contaminatingVar}%\r` : `echo VAR_IS:$${contaminatingVar}\r`;
  child.write(printEnvCommand);

  await waitFor(() => output.includes("VAR_IS:"));
  // cmd.exe echoes an unset %VAR% back literally; sh's $VAR expands to empty.
  const leaked = output.includes("VAR_IS:1");
  assert.equal(leaked, false, `spawned shell inherited ${contaminatingVar} from this process`);
});
