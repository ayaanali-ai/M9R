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
