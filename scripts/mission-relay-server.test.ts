import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { createMissionRelayServer } from "../services/mission-relay/src/server";
import { MISSION_RELAY_FRAME_VERSION, type RelayFrame } from "@/lib/mission/mission-relay-protocol";

function frame(type: string, payload: unknown, overrides: Partial<RelayFrame> = {}): RelayFrame {
  return {
    version: MISSION_RELAY_FRAME_VERSION,
    frameId: `${type}-${Math.random().toString(36).slice(2)}`,
    type,
    workspaceId: "workspace-1",
    missionId: "mission-1",
    correlationId: "correlation-1",
    causationId: null,
    idempotencyKey: null,
    sentAt: new Date().toISOString(),
    payload,
    ...overrides,
  };
}

function nextFrame(socket: WebSocket, predicate: (frame: RelayFrame) => boolean): Promise<RelayFrame> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.removeListener("message", onMessage); reject(new Error("Timed out waiting for Relay frame.")); }, 5_000);
    const onMessage = (raw: WebSocket.RawData) => {
      const received = JSON.parse(raw.toString()) as RelayFrame;
      if (!predicate(received)) return;
      clearTimeout(timeout);
      socket.removeListener("message", onMessage);
      resolve(received);
    };
    socket.on("message", onMessage);
  });
}

test("Mission Relay WebSocket transport authenticates and fans out normalized runtime activity", async () => {
  const { server, webSocketServer } = createMissionRelayServer({
    port: 0,
    host: "127.0.0.1",
    authenticator: { authenticate: async ({ kind, workspaceId }) => ({ kind: kind === "bridge" ? "bridge" : "human", id: kind, workspaceIds: [workspaceId] }) },
    loadMissionSnapshot: async () => ({ missionId: "mission-1", activity: [] }),
    receiveRuntimeEvent: async () => ({ eventId: "event-1", eventType: "provider.activity", summary: "Changed src/app.ts", activity: { kind: "file.changed", status: "succeeded" } }),
  });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  assert.equal(typeof address, "object");
  if (!address || typeof address === "string") throw new Error("Relay did not expose a bound address.");
  const health = await fetch(`http://127.0.0.1:${address.port}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });
  const bridge = new WebSocket(`ws://127.0.0.1:${address.port}`);
  const browser = new WebSocket(`ws://127.0.0.1:${address.port}`);
  try {
    await Promise.all([
      new Promise<void>((resolve, reject) => { bridge.once("open", () => resolve()); bridge.once("error", reject); }),
      new Promise<void>((resolve, reject) => { browser.once("open", () => resolve()); browser.once("error", reject); }),
    ]);
    bridge.send(JSON.stringify(frame("auth.bridge", { credential: "bridge-credential" })));
    browser.send(JSON.stringify(frame("auth.browser", { credential: "browser-credential" })));
    await Promise.all([nextFrame(bridge, (received) => received.type === "relay.ready"), nextFrame(browser, (received) => received.type === "relay.ready")]);
    browser.send(JSON.stringify(frame("mission.subscribe", { cursor: null })));
    await nextFrame(browser, (received) => received.type === "mission.snapshot");
    bridge.send(JSON.stringify(frame("runtime.event", {
      executionId: "execution-1",
      participantId: "agent-a",
      assignmentId: "assignment-1",
      event: {
        type: "provider.activity",
        eventId: "event-1",
        adapterId: "codex-acp",
        providerSessionRef: "provider-session-1",
        timestamp: "2026-08-01T00:00:00.000Z",
        payload: { type: "provider.activity", activityKind: "file.changed", status: "succeeded", summary: "Changed src/app.ts", filePath: "src/app.ts" },
      },
    })));
    const published = await nextFrame(browser, (received) => received.type === "runtime.event");
    assert.deepEqual(published.payload, { eventId: "event-1", eventType: "provider.activity", summary: "Changed src/app.ts", activity: { kind: "file.changed", status: "succeeded" } });
  } finally {
    bridge.close();
    browser.close();
    await new Promise<void>((resolve) => webSocketServer.close(() => server.close(() => resolve())));
  }
});

test("Mission Relay serializes subscribe then post so the first message cannot outrun its subscription", async () => {
  let snapshotFinished = false;
  const { server, webSocketServer } = createMissionRelayServer({
    port: 0,
    host: "127.0.0.1",
    authenticator: { authenticate: async ({ workspaceId }) => ({ kind: "human", id: "human-1", workspaceIds: [workspaceId] }) },
    loadMissionSnapshot: async () => ({ missionId: "mission-1" }),
    loadWorkspaceSnapshot: async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      snapshotFinished = true;
      return { cursor: null, messages: [] };
    },
    postWorkspaceMessage: async () => {
      assert.equal(snapshotFinished, true, "workspace.post must wait for the earlier workspace.subscribe on this socket");
      return { message: { id: "message-1", recipient_connection_id: null } };
    },
  });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  assert.equal(typeof address, "object");
  if (!address || typeof address === "string") throw new Error("Relay did not expose a bound address.");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
  try {
    await new Promise<void>((resolve, reject) => { socket.once("open", () => resolve()); socket.once("error", reject); });
    socket.send(JSON.stringify(frame("auth.browser", { credential: "human-1" })));
    await nextFrame(socket, (received) => received.type === "relay.ready");
    const snapshotPromise = nextFrame(socket, (received) => received.type === "workspace.snapshot");
    const postedPromise = nextFrame(socket, (received) => received.type === "workspace.event");
    socket.send(JSON.stringify(frame("workspace.subscribe", { cursor: null }, { channelId: "channel-1", frameId: "subscribe-first" })));
    socket.send(JSON.stringify(frame("workspace.post", { kind: "message", body: "@codex hello" }, { channelId: "channel-1", frameId: "post-second", idempotencyKey: "post-key-1" })));
    await snapshotPromise;
    const posted = await postedPromise;
    assert.equal((posted.payload as { message?: { id?: string } }).message?.id, "message-1");
  } finally {
    socket.close();
    await new Promise<void>((resolve) => webSocketServer.close(() => server.close(() => resolve())));
  }
});
