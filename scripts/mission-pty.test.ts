import assert from "node:assert/strict";
import test from "node:test";
import {
  MISSION_RELAY_FRAME_VERSION,
  MISSION_RELAY_MAX_PAYLOAD_BYTES,
  parseRelayFrame,
  type RelayFrame,
} from "@/lib/mission/mission-relay-protocol";
import {
  PTY_OUTPUT_MAX_CHUNK_BYTES,
  appendScrollback,
  chunkPtyBytes,
  decodePtyBytes,
  encodePtyBytes,
  parsePtyOutputPayload,
  parsePtyResizePayload,
  trimScrollback,
} from "@/lib/mission/mission-pty-protocol";
import {
  MissionPtyHost,
  PTY_MAX_CHUNKS_PER_FLUSH,
  PTY_MAX_PENDING_BYTES,
  type PtyProcess,
} from "@/lib/mission/mission-pty-host";
import { WorkspaceRoomReadiness, isAgentSessionEnvVar } from "@/lib/mission/mission-pty-runtime";
import { MissionRelayService } from "@/lib/mission/mission-relay-service";
import type { MissionRelayPrincipal } from "@/lib/mission/mission-relay-auth";

const bytes = (input: string): Uint8Array => new Uint8Array(Buffer.from(input, "utf8"));
const text = (input: Uint8Array): string => Buffer.from(input).toString("utf8");

test("terminal bytes survive a base64 round trip, including raw escapes and split UTF-8", () => {
  const ansi = new Uint8Array([0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x68, 0x69, 0x1b, 0x5b, 0x30, 0x6d]);
  assert.deepEqual(decodePtyBytes(encodePtyBytes(ansi)), ansi);

  // A multi-byte character split across two chunks must reassemble exactly;
  // xterm decodes statefully, so the transport only has to preserve order.
  const emoji = bytes("ok 🚀 done");
  const first = emoji.subarray(0, 4);
  const second = emoji.subarray(4);
  const rejoined = new Uint8Array([...decodePtyBytes(encodePtyBytes(first)), ...decodePtyBytes(encodePtyBytes(second))]);
  assert.equal(text(rejoined), "ok 🚀 done");
});

test("an output chunk always fits inside the relay's payload budget", () => {
  const full = new Uint8Array(PTY_OUTPUT_MAX_CHUNK_BYTES).fill(0x41);
  const chunks = chunkPtyBytes(full);
  assert.equal(chunks.length, 1);
  const payload = { sessionId: "pty-1", seq: 0, data: chunks[0] };
  assert.ok(Buffer.byteLength(JSON.stringify(payload), "utf8") < MISSION_RELAY_MAX_PAYLOAD_BYTES);

  // Oversized output is split rather than rejected.
  assert.equal(chunkPtyBytes(new Uint8Array(PTY_OUTPUT_MAX_CHUNK_BYTES * 2 + 10)).length, 3);
});

test("payload validators reject malformed terminal frames", () => {
  assert.equal(parsePtyOutputPayload({ sessionId: "s", seq: 0, data: "AAAA" })?.seq, 0);
  assert.equal(parsePtyOutputPayload({ sessionId: "s", seq: -1, data: "AAAA" }), null);
  assert.equal(parsePtyOutputPayload({ sessionId: "s", seq: 0, data: "not base64!" }), null);
  assert.equal(parsePtyOutputPayload({ sessionId: "s", seq: 0, data: "A".repeat(40_000) }), null);
  assert.equal(parsePtyResizePayload({ sessionId: "s", cols: 80, rows: 24 })?.cols, 80);
  assert.equal(parsePtyResizePayload({ sessionId: "s", cols: 0, rows: 24 }), null);
  assert.equal(parsePtyResizePayload({ sessionId: "s", cols: 80, rows: 100_000 }), null);
});

test("scrollback keeps the newest bytes within its budget", () => {
  const trimmed = trimScrollback(bytes("abcdefghij"), 4);
  assert.equal(text(trimmed), "ghij");
  assert.equal(text(appendScrollback(bytes("abc"), bytes("de"), 4)), "bcde");
});

/** Minimal fake so the host is testable without spawning a real shell. */
function fakePty(): PtyProcess & { written: string[]; resized: Array<[number, number]>; killed: boolean; emit(data: string): void; exit(code: number): void } {
  let onData: (data: string) => void = () => {};
  let onExit: (event: { exitCode: number }) => void = () => {};
  return {
    written: [],
    resized: [],
    killed: false,
    write(data: string) { this.written.push(data); },
    resize(cols: number, rows: number) { this.resized.push([cols, rows]); },
    kill() { this.killed = true; },
    onData(listener) { onData = listener; },
    onExit(listener) { onExit = listener; },
    emit(data: string) { onData(data); },
    exit(code: number) { onExit({ exitCode: code }); },
  };
}

function startHost(): { host: MissionPtyHost; pty: ReturnType<typeof fakePty>; outputs: Array<{ seq: number; data: string }>; exits: number[] } {
  const pty = fakePty();
  const outputs: Array<{ seq: number; data: string }> = [];
  const exits: number[] = [];
  const host = new MissionPtyHost({
    sessionId: "pty-1",
    spawn: () => pty,
    publishOutput: (output) => outputs.push({ seq: output.seq, data: output.data }),
    publishExit: (event) => exits.push(event.exitCode),
    // No real timer: the test drives every flush explicitly.
    setInterval: () => null,
    clearInterval: () => {},
  });
  host.start({ shell: "bash", args: [], cwd: "/tmp", cols: 80, rows: 24, env: {} });
  return { host, pty, outputs, exits };
}

test("host coalesces bursty output instead of emitting a frame per write", () => {
  const { host, pty, outputs } = startHost();
  for (let index = 0; index < 500; index += 1) pty.emit("x");
  // 500 separate PTY writes, still nothing sent until the tick fires.
  assert.equal(outputs.length, 0);
  host.flushNow();
  // 500 bytes coalesce into a single frame rather than 500 of them.
  assert.equal(outputs.length, 1);
  assert.equal(text(decodePtyBytes(outputs[0].data)), "x".repeat(500));
});

test("host caps frames per flush so a fast process cannot overrun the relay mailbox", () => {
  const { host, pty, outputs } = startHost();
  pty.emit("y".repeat(PTY_OUTPUT_MAX_CHUNK_BYTES * 10));
  host.flushNow();
  assert.equal(outputs.length, PTY_MAX_CHUNKS_PER_FLUSH);
  // The rest is retained and drains on later ticks, not dropped.
  assert.equal(host.pendingBytes, PTY_OUTPUT_MAX_CHUNK_BYTES * 7);
  host.flushNow();
  assert.equal(outputs.length, PTY_MAX_CHUNKS_PER_FLUSH * 2);
  // Sequence numbers stay strictly monotonic across flushes.
  assert.deepEqual(outputs.map((entry) => entry.seq), [0, 1, 2, 3, 4, 5]);
});

test("host bounds pending output rather than growing memory without limit", () => {
  const { host, pty } = startHost();
  pty.emit("z".repeat(PTY_MAX_PENDING_BYTES + 5_000));
  assert.equal(host.pendingBytes, PTY_MAX_PENDING_BYTES);
  assert.ok(host.droppedByteCount >= 5_000);
});

test("host flushes the final output before reporting an exit", () => {
  const { host, pty, outputs, exits } = startHost();
  pty.emit("fatal: something broke");
  pty.exit(1);
  assert.deepEqual(exits, [1]);
  assert.equal(outputs.length, 1);
  assert.equal(text(decodePtyBytes(outputs[0].data)), "fatal: something broke");
  assert.equal(host.isRunning, false);
});

test("host forwards viewer input and resize to the real process", () => {
  const { host, pty } = startHost();
  host.applyInput({ data: encodePtyBytes(bytes("ls -la\r")) });
  host.applyResize({ cols: 120, rows: 40 });
  assert.deepEqual(pty.written, ["ls -la\r"]);
  assert.deepEqual(pty.resized, [[120, 40]]);
});

test("agent-session env vars are recognized for stripping so a spawned CLI starts a normal top-level session", () => {
  // Confirmed present on the process hosting a terminal pane by direct
  // `env |` inspection, not assumed -- without filtering these, `claude`
  // typed inside a pane inherits the hosting process's own session identity
  // and comes up as a child session instead of a normal, resumable one.
  for (const real of ["CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_HOST_SESSION_ID", "CLAUDE_PID", "CLAUDECODE", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_EFFORT"]) {
    assert.equal(isAgentSessionEnvVar(real), true, `${real} should be stripped`);
  }
  // Ordinary environment a shell needs to function must survive untouched.
  for (const ordinary of ["PATH", "HOME", "SHELL", "TERM", "ANTHROPIC_API_KEY", "USERPROFILE"]) {
    assert.equal(isAgentSessionEnvVar(ordinary), false, `${ordinary} must not be stripped`);
  }
});

// --- Relay routing -------------------------------------------------------

const principals: Record<string, MissionRelayPrincipal> = {
  "bridge-token": { kind: "bridge", id: "bridge-1", workspaceIds: ["workspace-1"] },
  "viewer-token": { kind: "human", id: "viewer-1", workspaceIds: ["workspace-1"] },
  "other-token": { kind: "human", id: "viewer-2", workspaceIds: ["workspace-1"] },
  // The human who actually owns the "bridge-1" agent connection -- a
  // separate live socket from that bridge, the same way a real person's
  // browser never shares a connection with their own agent's process.
  "owner-human-token": { kind: "human", id: "owner-human-1", workspaceIds: ["workspace-1"] },
};

/** agent_connections.created_by, keyed by connection id -- the real lookup resolvePtyOwnerHuman performs. */
const connectionOwners: Record<string, string> = { "bridge-1": "owner-human-1" };

function relayFrame(type: string, payload: unknown, overrides: Partial<RelayFrame> = {}): RelayFrame {
  return {
    version: MISSION_RELAY_FRAME_VERSION,
    frameId: `frame-${Math.random().toString(36).slice(2)}`,
    type,
    workspaceId: "workspace-1",
    channelId: "channel-1",
    correlationId: "correlation-1",
    causationId: null,
    idempotencyKey: null,
    sentAt: "2026-09-02T00:00:00.000Z",
    payload,
    ...overrides,
  };
}

async function relayHarness() {
  const sent = new Map<string, RelayFrame[]>();
  const service = new MissionRelayService({
    authenticator: {
      authenticate: async ({ credential }) => {
        const principal = principals[credential];
        if (!principal) throw new Error("unauthorized");
        return principal;
      },
    },
    loadMissionSnapshot: async () => ({}),
    loadWorkspaceSnapshot: async () => ({}),
    resolvePtyOwnerHuman: async (ownerConnectionId) => connectionOwners[ownerConnectionId] ?? null,
  });

  const connect = async (connectionId: string, credential: string) => {
    sent.set(connectionId, []);
    service.connect({ connectionId, send: (frame) => { sent.get(connectionId)!.push(frame); } });
    const authType = principals[credential]?.kind === "bridge" ? "auth.bridge" : "auth.browser";
    await service.receive(connectionId, relayFrame(authType, { credential }));
    await service.receive(connectionId, relayFrame("workspace.subscribe", { cursor: null }));
  };

  return { service, sent, connect, framesFor: (id: string) => sent.get(id) ?? [] };
}

test("relay fans terminal output to the room but routes input only to the host", async () => {
  const { service, connect, framesFor } = await relayHarness();
  await connect("host", "bridge-token");
  await connect("viewer", "viewer-token");

  await service.receive("host", relayFrame("pty.open", { sessionId: "pty-1", cols: 80, rows: 24, title: "Ayaan's terminal" }));
  const opened = framesFor("viewer").filter((frame) => frame.type === "pty.state");
  assert.equal(opened.length, 1);
  assert.equal((opened[0].payload as { status: string }).status, "running");

  await service.receive("host", relayFrame("pty.output", { sessionId: "pty-1", seq: 0, data: encodePtyBytes(bytes("hello\r\n")) }));
  const output = framesFor("viewer").filter((frame) => frame.type === "pty.output");
  assert.equal(output.length, 1);
  assert.equal(text(decodePtyBytes((output[0].payload as { data: string }).data)), "hello\r\n");

  // Input goes to the host only -- never echoed back to the room, or every
  // viewer would render keystrokes the real process never acknowledged.
  await service.receive("viewer", relayFrame("pty.input", { sessionId: "pty-1", data: encodePtyBytes(bytes("ls\r")) }));
  const hostInput = framesFor("host").filter((frame) => frame.type === "pty.input");
  assert.equal(hostInput.length, 1);
  assert.equal(framesFor("viewer").filter((frame) => frame.type === "pty.input").length, 0);
});

test("relay stamps input attribution from the authenticated principal, not the payload", async () => {
  const { service, connect, framesFor } = await relayHarness();
  await connect("host", "bridge-token");
  await connect("viewer", "viewer-token");
  await service.receive("host", relayFrame("pty.open", { sessionId: "pty-1", cols: 80, rows: 24 }));

  // A viewer claiming to be someone else must not be believed.
  await service.receive("viewer", relayFrame("pty.input", { sessionId: "pty-1", data: encodePtyBytes(bytes("x")), participantId: "someone-else" }));
  const input = framesFor("host").find((frame) => frame.type === "pty.input");
  assert.equal((input?.payload as { participantId: string }).participantId, "viewer-1");
});

test("only the hosting bridge may open or publish output for a session", async () => {
  const { service, connect, framesFor } = await relayHarness();
  await connect("host", "bridge-token");
  await connect("viewer", "viewer-token");

  // A browser cannot claim to host a terminal.
  await service.receive("viewer", relayFrame("pty.open", { sessionId: "pty-x", cols: 80, rows: 24 }));
  assert.equal(framesFor("viewer").filter((frame) => frame.type === "relay.error").at(-1)?.payload && (framesFor("viewer").filter((frame) => frame.type === "relay.error").at(-1)!.payload as { code: string }).code, "bridge_required");

  await service.receive("host", relayFrame("pty.open", { sessionId: "pty-1", cols: 80, rows: 24 }));
  // Nor publish output into someone else's session.
  await service.receive("viewer", relayFrame("pty.output", { sessionId: "pty-1", seq: 1, data: encodePtyBytes(bytes("spoof")) }));
  assert.equal(framesFor("viewer").filter((frame) => frame.type === "relay.error").some((frame) => (frame.payload as { code: string }).code === "bridge_required"), true);
});

test("a viewer must be subscribed to the room before touching its terminal", async () => {
  const { service, sent, connect, framesFor } = await relayHarness();
  await connect("host", "bridge-token");
  await service.receive("host", relayFrame("pty.open", { sessionId: "pty-1", cols: 80, rows: 24 }));

  // Authenticated into the workspace, but never subscribed to the room.
  sent.set("lurker", []);
  service.connect({ connectionId: "lurker", send: (frame) => { sent.get("lurker")!.push(frame); } });
  await service.receive("lurker", relayFrame("auth.browser", { credential: "other-token" }));
  await service.receive("lurker", relayFrame("pty.input", { sessionId: "pty-1", data: encodePtyBytes(bytes("rm -rf /\r")) }));

  assert.equal(framesFor("host").filter((frame) => frame.type === "pty.input").length, 0);
  assert.equal((framesFor("lurker").at(-1)!.payload as { code: string }).code, "pty_subscription_required");
});

test("a viewer joining mid-session gets the pane's recent output replayed", async () => {
  const { service, connect, framesFor } = await relayHarness();
  await connect("host", "bridge-token");
  await service.receive("host", relayFrame("pty.open", { sessionId: "pty-1", cols: 80, rows: 24 }));
  await service.receive("host", relayFrame("pty.output", { sessionId: "pty-1", seq: 0, data: encodePtyBytes(bytes("earlier output\r\n")) }));

  // Late joiner should not land on a blank terminal.
  await connect("latecomer", "other-token");
  const replayed = framesFor("latecomer").filter((frame) => frame.type === "pty.output");
  assert.equal(replayed.length, 1);
  assert.equal(text(decodePtyBytes((replayed[0].payload as { data: string }).data)), "earlier output\r\n");
  assert.equal(framesFor("latecomer").filter((frame) => frame.type === "pty.state").length, 1);
});

test("viewers are told the pane died when its host disconnects", async () => {
  const { service, connect, framesFor } = await relayHarness();
  await connect("host", "bridge-token");
  await connect("viewer", "viewer-token");
  await service.receive("host", relayFrame("pty.open", { sessionId: "pty-1", cols: 80, rows: 24 }));

  service.disconnect("host");

  const state = framesFor("viewer").filter((frame) => frame.type === "pty.state").at(-1);
  assert.equal((state?.payload as { status: string }).status, "exited");
  assert.equal((state?.payload as { reason: string }).reason, "host_disconnected");

  // The session is gone, so further input has nothing to reach.
  await service.receive("viewer", relayFrame("pty.input", { sessionId: "pty-1", data: encodePtyBytes(bytes("x")) }));
  assert.equal((framesFor("viewer").at(-1)!.payload as { code: string }).code, "pty_session_not_found");
});

test("a host that announces before its subscription lands is refused, and waiting fixes it", async () => {
  // Found live, not theorised: the relay handles frames fire-and-forget and
  // workspace.subscribe does a database round-trip first, so a host that
  // announces immediately after subscribing loses the race. The earlier
  // harness missed it only because its snapshot loader returned instantly.
  const sent = new Map<string, RelayFrame[]>();
  let releaseSnapshot = () => {};
  const snapshotGate = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
  const service = new MissionRelayService({
    authenticator: { authenticate: async ({ credential }) => principals[credential] },
    loadMissionSnapshot: async () => ({}),
    loadWorkspaceSnapshot: async () => { await snapshotGate; return {}; },
  });

  sent.set("host", []);
  service.connect({ connectionId: "host", send: (f) => { sent.get("host")!.push(f); } });
  await service.receive("host", relayFrame("auth.bridge", { credential: "bridge-token" }));
  void service.receive("host", relayFrame("workspace.subscribe", { cursor: null }));

  // Announcing while the subscription is still in flight must be refused --
  // an unsubscribed connection has no business reaching a room's shell.
  await service.receive("host", relayFrame("pty.open", { sessionId: "pty-race", cols: 80, rows: 24 }));
  assert.equal((sent.get("host")!.at(-1)!.payload as { code: string }).code, "pty_subscription_required");

  releaseSnapshot();
  await waitForSnapshot(() => sent.get("host")!.some((f) => f.type === "workspace.snapshot"));

  // Once the room is confirmed, the same announcement is accepted.
  await service.receive("host", relayFrame("pty.open", { sessionId: "pty-race", cols: 80, rows: 24 }));
  assert.equal(sent.get("host")!.at(-1)!.type, "pty.state");
});

test("room readiness resolves only once the relay confirms the subscription", async () => {
  const readiness = new WorkspaceRoomReadiness();
  let resolved = false;
  const waiting = readiness.wait("channel-1", 5_000).then(() => { resolved = true; });

  readiness.observe({ type: "workspace.event", channelId: "channel-1" });
  await waitForSnapshot(() => true);
  assert.equal(resolved, false, "an unrelated frame must not count as confirmation");

  readiness.observe({ type: "workspace.snapshot", channelId: "channel-1" });
  await waiting;
  assert.equal(resolved, true);

  // Already-confirmed rooms resolve immediately rather than waiting again.
  await readiness.wait("channel-1", 50);
});

/** Lets pending microtasks/timers run without depending on a fixed sleep. */
async function waitForSnapshot(probe: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await new Promise((resolve) => setTimeout(resolve, 5));
}

// --- Phase 4: ownership + Sharing toggle ----------------------------------

test("a pty.state announces shared:true by default", async () => {
  const { service, connect, framesFor } = await relayHarness();
  await connect("host", "bridge-token");
  await service.receive("host", relayFrame("pty.open", { sessionId: "pty-1", cols: 80, rows: 24 }));
  const opened = framesFor("host").find((frame) => frame.type === "pty.state");
  assert.equal((opened?.payload as { shared: boolean }).shared, true);
});

test("only the owner may toggle sharing, and everyone in the room learns the new state", async () => {
  const { service, connect, framesFor } = await relayHarness();
  await connect("host", "bridge-token");
  await connect("viewer", "viewer-token");
  await service.receive("host", relayFrame("pty.open", { sessionId: "pty-1", cols: 80, rows: 24 }));

  // A non-owner cannot flip someone else's sharing state.
  await service.receive("viewer", relayFrame("pty.share", { sessionId: "pty-1", shared: false }));
  assert.equal((framesFor("viewer").at(-1)!.payload as { code: string }).code, "pty_not_owner");

  await service.receive("host", relayFrame("pty.share", { sessionId: "pty-1", shared: false }));
  for (const viewerId of ["host", "viewer"]) {
    const state = framesFor(viewerId).filter((frame) => frame.type === "pty.state").at(-1);
    assert.equal((state?.payload as { shared: boolean }).shared, false);
  }
});

test("sharing off blocks a non-owner's keystrokes but never blocks watching", async () => {
  const { service, connect, framesFor } = await relayHarness();
  await connect("host", "bridge-token");
  await connect("viewer", "viewer-token");
  await service.receive("host", relayFrame("pty.open", { sessionId: "pty-1", cols: 80, rows: 24 }));
  await service.receive("host", relayFrame("pty.share", { sessionId: "pty-1", shared: false }));

  // Typing is refused...
  await service.receive("viewer", relayFrame("pty.input", { sessionId: "pty-1", data: encodePtyBytes(bytes("x")) }));
  assert.equal((framesFor("viewer").at(-1)!.payload as { code: string }).code, "pty_not_shared");
  assert.equal(framesFor("host").filter((frame) => frame.type === "pty.input").length, 0);

  // ...but the owner's own output still reaches every watcher -- sharing off
  // is "no one else can type," never "no one else can see."
  await service.receive("host", relayFrame("pty.output", { sessionId: "pty-1", seq: 0, data: encodePtyBytes(bytes("still visible\r\n")) }));
  const output = framesFor("viewer").filter((frame) => frame.type === "pty.output");
  assert.equal(text(decodePtyBytes((output.at(-1)!.payload as { data: string }).data)), "still visible\r\n");
});

test("the owner can still type while sharing is off", async () => {
  const { service, connect, framesFor } = await relayHarness();
  await connect("host", "bridge-token");
  await service.receive("host", relayFrame("pty.open", { sessionId: "pty-1", cols: 80, rows: 24 }));
  await service.receive("host", relayFrame("pty.share", { sessionId: "pty-1", shared: false }));

  await service.receive("host", relayFrame("pty.input", { sessionId: "pty-1", data: encodePtyBytes(bytes("solo")) }));
  const hostInput = framesFor("host").filter((frame) => frame.type === "pty.input");
  assert.equal(hostInput.length, 1);
  assert.equal(text(decodePtyBytes((hostInput[0].payload as { data: string }).data)), "solo");
});

test("re-sharing restores a viewer's ability to type", async () => {
  const { service, connect, framesFor } = await relayHarness();
  await connect("host", "bridge-token");
  await connect("viewer", "viewer-token");
  await service.receive("host", relayFrame("pty.open", { sessionId: "pty-1", cols: 80, rows: 24 }));
  await service.receive("host", relayFrame("pty.share", { sessionId: "pty-1", shared: false }));
  await service.receive("host", relayFrame("pty.share", { sessionId: "pty-1", shared: true }));

  await service.receive("viewer", relayFrame("pty.input", { sessionId: "pty-1", data: encodePtyBytes(bytes("y")) }));
  assert.equal(framesFor("host").filter((frame) => frame.type === "pty.input").length, 1);
});

test("the human who owns the agent connection can toggle Sharing, even though their browser is a different socket than the bridge", async () => {
  // The real bug found live: ownerConnectionId is the *bridge's* connection
  // id, and a human's browser is never that same socket. Without resolving
  // agent_connections.created_by, "the owner" silently meant "only the
  // bridge process," which no human viewer could ever be.
  const { service, connect, framesFor } = await relayHarness();
  await connect("host", "bridge-token");
  await connect("owner-browser", "owner-human-token");
  await service.receive("host", relayFrame("pty.open", { sessionId: "pty-1", cols: 80, rows: 24 }));

  await service.receive("owner-browser", relayFrame("pty.share", { sessionId: "pty-1", shared: false }));
  assert.equal(framesFor("owner-browser").filter((frame) => frame.type === "relay.error").length, 0);
  assert.equal((framesFor("owner-browser").at(-1)!.payload as { shared: boolean }).shared, false);
});

test("a human who does not own the connection still cannot toggle Sharing", async () => {
  const { service, connect, framesFor } = await relayHarness();
  await connect("host", "bridge-token");
  await connect("stranger", "viewer-token");
  await service.receive("host", relayFrame("pty.open", { sessionId: "pty-1", cols: 80, rows: 24 }));

  await service.receive("stranger", relayFrame("pty.share", { sessionId: "pty-1", shared: false }));
  assert.equal((framesFor("stranger").at(-1)!.payload as { code: string }).code, "pty_not_owner");
});

test("the human owner can type from their own browser even while sharing is off", async () => {
  const { service, connect, framesFor } = await relayHarness();
  await connect("host", "bridge-token");
  await connect("owner-browser", "owner-human-token");
  await service.receive("host", relayFrame("pty.open", { sessionId: "pty-1", cols: 80, rows: 24 }));
  await service.receive("owner-browser", relayFrame("pty.share", { sessionId: "pty-1", shared: false }));

  await service.receive("owner-browser", relayFrame("pty.input", { sessionId: "pty-1", data: encodePtyBytes(bytes("owner still typing")) }));
  const hostInput = framesFor("host").filter((frame) => frame.type === "pty.input");
  assert.equal(hostInput.length, 1);
  assert.equal(text(decodePtyBytes((hostInput[0].payload as { data: string }).data)), "owner still typing");
});

// --- Phase 2: multiplayer core -------------------------------------------

test("two simultaneous viewers both watch the same live terminal", async () => {
  const { service, connect, framesFor } = await relayHarness();
  await connect("host", "bridge-token");
  await connect("viewer-a", "viewer-token");
  await connect("viewer-b", "other-token");
  await service.receive("host", relayFrame("pty.open", { sessionId: "pty-1", cols: 80, rows: 24 }));

  await service.receive("host", relayFrame("pty.output", { sessionId: "pty-1", seq: 0, data: encodePtyBytes(bytes("shared output\r\n")) }));

  for (const viewerId of ["viewer-a", "viewer-b"]) {
    const output = framesFor(viewerId).filter((frame) => frame.type === "pty.output");
    assert.equal(output.length, 1, `${viewerId} should see the output`);
    assert.equal(text(decodePtyBytes((output[0].payload as { data: string }).data)), "shared output\r\n");
  }
});

test("both viewers can type into the same pane; input never echoes to the other viewer, only to the host", async () => {
  const { service, connect, framesFor } = await relayHarness();
  await connect("host", "bridge-token");
  await connect("viewer-a", "viewer-token");
  await connect("viewer-b", "other-token");
  await service.receive("host", relayFrame("pty.open", { sessionId: "pty-1", cols: 80, rows: 24 }));

  await service.receive("viewer-a", relayFrame("pty.input", { sessionId: "pty-1", data: encodePtyBytes(bytes("a")) }));
  await service.receive("viewer-b", relayFrame("pty.input", { sessionId: "pty-1", data: encodePtyBytes(bytes("b")) }));

  const hostInput = framesFor("host").filter((frame) => frame.type === "pty.input");
  assert.equal(hostInput.length, 2);
  // Real arbitration: whichever viewer's frame the relay actually received
  // first is forwarded first -- the same rule as two people sharing one
  // tmux session, not an artificial per-viewer lock.
  assert.deepEqual(hostInput.map((frame) => (frame.payload as { participantId: string }).participantId), ["viewer-1", "viewer-2"]);
  assert.deepEqual(hostInput.map((frame) => text(decodePtyBytes((frame.payload as { data: string }).data))), ["a", "b"]);

  // Neither viewer ever sees the other's keystrokes -- only the real process
  // (via its own output) is the source of truth for what actually happened.
  assert.equal(framesFor("viewer-a").filter((frame) => frame.type === "pty.input").length, 0);
  assert.equal(framesFor("viewer-b").filter((frame) => frame.type === "pty.input").length, 0);
});

test("a third viewer joining mid-session does not disrupt the two already watching", async () => {
  const { service, connect, framesFor } = await relayHarness();
  await connect("host", "bridge-token");
  await connect("viewer-a", "viewer-token");
  await service.receive("host", relayFrame("pty.open", { sessionId: "pty-1", cols: 80, rows: 24 }));
  await service.receive("host", relayFrame("pty.output", { sessionId: "pty-1", seq: 0, data: encodePtyBytes(bytes("before third joined\r\n")) }));

  const viewerAOutputBefore = framesFor("viewer-a").filter((frame) => frame.type === "pty.output").length;

  await connect("viewer-c", "other-token");
  const replayed = framesFor("viewer-c").filter((frame) => frame.type === "pty.output");
  assert.equal(replayed.length, 1);
  assert.equal(text(decodePtyBytes((replayed[0].payload as { data: string }).data)), "before third joined\r\n");

  // The replay a late joiner gets must not duplicate frames for someone
  // already watching -- it is scoped to the connecting viewer's own mailbox.
  assert.equal(framesFor("viewer-a").filter((frame) => frame.type === "pty.output").length, viewerAOutputBefore);

  await service.receive("host", relayFrame("pty.output", { sessionId: "pty-1", seq: 1, data: encodePtyBytes(bytes("after\r\n")) }));
  for (const viewerId of ["viewer-a", "viewer-c"]) {
    const output = framesFor(viewerId).filter((frame) => frame.type === "pty.output");
    assert.equal(text(decodePtyBytes((output.at(-1)!.payload as { data: string }).data)), "after\r\n");
  }
});

test("a viewer that reconnects mid-session resumes without disturbing the still-connected viewer", async () => {
  const { service, connect, framesFor } = await relayHarness();
  await connect("host", "bridge-token");
  await connect("viewer-a", "viewer-token");
  await connect("viewer-b", "other-token");
  await service.receive("host", relayFrame("pty.open", { sessionId: "pty-1", cols: 80, rows: 24 }));
  await service.receive("host", relayFrame("pty.output", { sessionId: "pty-1", seq: 0, data: encodePtyBytes(bytes("line one\r\n")) }));

  // viewer-b drops (a real socket close) and reconnects as a fresh connection.
  service.disconnect("viewer-b");
  await connect("viewer-b-reconnected", "other-token");

  const replay = framesFor("viewer-b-reconnected").filter((frame) => frame.type === "pty.output");
  assert.equal(text(decodePtyBytes((replay.at(-1)!.payload as { data: string }).data)), "line one\r\n");

  await service.receive("host", relayFrame("pty.output", { sessionId: "pty-1", seq: 1, data: encodePtyBytes(bytes("line two\r\n")) }));
  for (const viewerId of ["viewer-a", "viewer-b-reconnected"]) {
    const output = framesFor(viewerId).filter((frame) => frame.type === "pty.output");
    assert.equal(text(decodePtyBytes((output.at(-1)!.payload as { data: string }).data)), "line two\r\n");
  }
});

test("every terminal frame the relay emits still validates as a relay frame", async () => {
  const { service, connect, sent } = await relayHarness();
  await connect("host", "bridge-token");
  await connect("viewer", "viewer-token");
  await service.receive("host", relayFrame("pty.open", { sessionId: "pty-1", cols: 80, rows: 24 }));
  await service.receive("host", relayFrame("pty.output", { sessionId: "pty-1", seq: 0, data: chunkPtyBytes(new Uint8Array(PTY_OUTPUT_MAX_CHUNK_BYTES).fill(0x42))[0] }));
  await service.receive("viewer", relayFrame("pty.resize", { sessionId: "pty-1", cols: 120, rows: 40 }));

  for (const frames of sent.values()) {
    for (const frame of frames) {
      assert.equal(parseRelayFrame(frame).ok, true, `frame ${frame.type} failed validation`);
    }
  }
});
