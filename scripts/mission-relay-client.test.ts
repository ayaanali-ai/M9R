import assert from "node:assert/strict";
import test from "node:test";
import {
  createMissionRelayHuddleAnswerFrame,
  createMissionRelayHuddleIceFrame,
  createMissionRelayHuddleJoinFrame,
  createMissionRelayHuddleLeaveFrame,
  createMissionRelayHuddleMuteFrame,
  createMissionRelayHuddleOfferFrame,
  createMissionRelayRuntimeEventFrame,
  createMissionRelayWorkspacePostFrame,
  MissionRelayClient,
  workspaceSnapshotCursor,
} from "@/lib/mission/mission-relay-client";
import { parseRelayFrame } from "@/lib/mission/mission-relay-protocol";
import { buildBoundedWorkspaceSnapshot } from "@/lib/mission/workspace-relay-snapshot";
import { createMissionRelayServer } from "../services/mission-relay/src/server";

test("Bridge runtime event frames preserve structured ACP activity and Mission identity", () => {
  const frame = createMissionRelayRuntimeEventFrame({
    workspaceId: "workspace-1",
    missionId: "mission-1",
    executionId: "execution-1",
    participantId: "agent-a",
    assignmentId: "assignment-1",
    providerAdapterId: "codex-acp",
    providerSessionRef: "provider-session-1",
    event: {
      type: "provider.activity",
      sessionId: "bridge-session-1",
      occurredAt: "2026-08-01T00:00:00.000Z",
      payload: { type: "provider.activity", activityKind: "file.changed", status: "succeeded", summary: "Changed src/app.ts", filePath: "src/app.ts" },
    },
  });
  const parsed = parseRelayFrame(frame);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.frame.type, "runtime.event");
  assert.deepEqual(parsed.frame.payload, {
    executionId: "execution-1",
    participantId: "agent-a",
    assignmentId: "assignment-1",
    event: {
      type: "provider.activity",
      eventId: "bridge-bridge-session-1-2026-08-01T00:00:00.000Z-provider.activity",
      adapterId: "codex-acp",
      providerSessionRef: "provider-session-1",
      timestamp: "2026-08-01T00:00:00.000Z",
      payload: { type: "provider.activity", activityKind: "file.changed", status: "succeeded", summary: "Changed src/app.ts", filePath: "src/app.ts" },
    },
  });
});

test("Bridge runtime usage frames preserve turn identity and provider-reported fields", () => {
  const frame = createMissionRelayRuntimeEventFrame({
    workspaceId: "workspace-1",
    missionId: "mission-1",
    executionId: "execution-1",
    participantId: "agent-a",
    assignmentId: null,
    providerAdapterId: "claude-code-acp",
    providerSessionRef: "provider-session-1",
    event: {
      type: "provider.usage_updated",
      sessionId: "bridge-session-1",
      turnId: "turn-1",
      occurredAt: "2026-08-01T00:00:00.000Z",
      payload: {
        type: "provider.usage_updated",
        inputTokens: 1_000,
        outputTokens: 500,
        totalTokens: 1_500,
        usageBasis: "prompt_turn",
      },
    },
  });
  const parsed = parseRelayFrame(frame);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const payload = parsed.frame.payload as { event?: { turnId?: string; payload?: Record<string, unknown> } };
  assert.equal(payload.event?.turnId, "turn-1");
  assert.equal(payload.event?.payload?.totalTokens, 1_500);
  assert.equal(payload.event?.payload?.usageBasis, "prompt_turn");
});

test("distinct same-millisecond usage snapshots keep distinct idempotency event ids", () => {
  const base = {
    workspaceId: "workspace-1",
    missionId: "mission-1",
    executionId: "execution-1",
    participantId: "agent-a",
    assignmentId: null,
    providerAdapterId: "codex-acp",
    providerSessionRef: "provider-session-1",
  } as const;
  const first = createMissionRelayRuntimeEventFrame({
    ...base,
    event: {
      type: "provider.usage_updated",
      sessionId: "bridge-session-1",
      turnId: "turn-1",
      occurredAt: "2026-08-01T00:00:00.000Z",
      payload: { type: "provider.usage_updated", inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    },
  });
  const second = createMissionRelayRuntimeEventFrame({
    ...base,
    event: {
      type: "provider.usage_updated",
      sessionId: "bridge-session-1",
      turnId: "turn-1",
      occurredAt: "2026-08-01T00:00:00.000Z",
      payload: { type: "provider.usage_updated", inputTokens: 140, outputTokens: 30, totalTokens: 170 },
    },
  });
  const firstEventId = (first.payload as { event: { eventId: string } }).event.eventId;
  const secondEventId = (second.payload as { event: { eventId: string } }).event.eventId;
  assert.notEqual(firstEventId, secondEventId);
});

test("Bridge runtime event frames reject unrecognized provider event types", () => {
  assert.throws(() => createMissionRelayRuntimeEventFrame({
    workspaceId: "workspace-1",
    missionId: "mission-1",
    executionId: "execution-1",
    participantId: "agent-a",
    assignmentId: null,
    providerAdapterId: "codex-acp",
    providerSessionRef: null,
    event: { type: "provider.prose", sessionId: "bridge-session-1", occurredAt: "2026-08-01T00:00:00.000Z", payload: {} },
  }), /Unsupported provider event/);
});

test("workspace snapshot cursor extraction keeps node relay reconnects on the latest high-water mark", () => {
  assert.equal(workspaceSnapshotCursor({
    version: "oathlock.relay.v1",
    frameId: "snapshot-1",
    type: "workspace.snapshot",
    workspaceId: "workspace-1",
    channelId: "channel-1",
    correlationId: "c",
    causationId: null,
    idempotencyKey: null,
    sentAt: "2026-08-01T00:00:00.000Z",
    payload: { cursor: null, snapshot: { cursor: "2026-08-01T00:00:01.000Z", messages: [] } },
  }), "2026-08-01T00:00:01.000Z");
});

test("workspace snapshots stay below the relay payload budget while preserving chronological pages", () => {
  const messages = Array.from({ length: 100 }, (_, index) => ({
    id: `message-${index}`,
    created_at: `2026-08-09T00:00:${String(index).padStart(2, "0")}Z`,
    body: "A detailed workspace result that is large enough to exercise the byte budget.",
    reactions: Array.from({ length: 30 }, (_, reactionIndex) => ({ id: `reaction-${index}-${reactionIndex}`, emoji: "👍" })),
  }));
  const snapshot = buildBoundedWorkspaceSnapshot({
    conversation: { id: "channel-1", topic: "general" },
    messages,
    participants: ["agent-1", "agent-2"],
    activity: Array.from({ length: 80 }, (_, index) => ({ id: `activity-${index}`, summary: "Observed provider activity" })),
    cursor: "cursor-before",
    incremental: true,
  });

  assert.ok(Buffer.byteLength(JSON.stringify(snapshot), "utf8") <= 8_192);
  assert.ok(snapshot.messages.length > 0);
  assert.deepEqual(snapshot.messages.map((message) => message.id), messages.slice(0, snapshot.messages.length).map((message) => message.id));
  assert.equal((snapshot.messages[0].reactions as unknown[]).length, 20);
});

test("workspace agent posts preserve channel, parent, and relay correlation identity", () => {
  const frame = createMissionRelayWorkspacePostFrame({
    workspaceId: "workspace-1",
    channelId: "channel-1",
    participantId: "connection-1",
    kind: "ack",
    body: "Received and starting.",
    parentMessageId: "message-1",
  });
  assert.equal(frame.type, "workspace.post");
  assert.equal(frame.workspaceId, "workspace-1");
  assert.equal(frame.channelId, "channel-1");
  assert.equal(frame.causationId, "message-1");
  assert.equal(frame.correlationId.startsWith("workspace-post-"), true);
  assert.deepEqual(frame.payload, { kind: "ack", body: "Received and starting.", parentMessageId: "message-1" });
});

test("workspace agent posts can carry a stable idempotency key across reconnect retries", () => {
  const frame = createMissionRelayWorkspacePostFrame({
    workspaceId: "workspace-1",
    channelId: "channel-1",
    participantId: "connection-1",
    kind: "result",
    body: "The result is ready.",
    correlationId: "turn-1",
    idempotencyKey: "workspace-post:connection-1:turn-1",
  });
  assert.equal(frame.correlationId, "turn-1");
  assert.equal(frame.idempotencyKey, "workspace-post:connection-1:turn-1");
});

test("two distinct posts that share one correlationId (e.g. a turn's ack and its later fallback) never collide on idempotency key", () => {
  // Regression for a real, 100%-reproducible bug confirmed live: bridge-
  // runtime.ts threads a single correlationId across a whole turn's ack and
  // fallback posts purely for tracing. When idempotencyKey used to derive
  // from correlationId, the relay's idempotent-replay path treated the
  // fallback as a duplicate of the earlier ack and silently returned the
  // ack's own row instead of inserting a new one -- every fallback message
  // "succeeded" but never actually appeared.
  const ack = createMissionRelayWorkspacePostFrame({
    workspaceId: "workspace-1",
    channelId: "channel-1",
    participantId: "connection-1",
    kind: "ack",
    body: "Received and starting.",
    correlationId: "shared-turn-correlation-id",
  });
  const fallback = createMissionRelayWorkspacePostFrame({
    workspaceId: "workspace-1",
    channelId: "channel-1",
    participantId: "connection-1",
    kind: "result",
    body: "Turn completed, but no message was posted.",
    correlationId: "shared-turn-correlation-id",
  });
  assert.equal(ack.correlationId, fallback.correlationId, "both posts legitimately share one correlationId for tracing");
  assert.notEqual(ack.idempotencyKey, fallback.idempotencyKey, "but must never share an idempotency key, or the second post silently replays the first instead of inserting");
});

test("Mission huddle frame builders keep participant, huddle, and WebRTC signaling scope explicit", () => {
  const identity = { workspaceId: "workspace-1", missionId: "mission-1", huddleId: "huddle-1", participantId: "alice" };
  const frames = [
    createMissionRelayHuddleJoinFrame(identity),
    createMissionRelayHuddleLeaveFrame(identity),
    createMissionRelayHuddleMuteFrame({ ...identity, muted: true }),
    createMissionRelayHuddleOfferFrame({ ...identity, targetParticipantId: "bob", description: { type: "offer", sdp: "v=0" } }),
    createMissionRelayHuddleAnswerFrame({ ...identity, targetParticipantId: "bob", description: { type: "answer", sdp: "v=0" } }),
    createMissionRelayHuddleIceFrame({ ...identity, targetParticipantId: "bob", candidate: { candidate: "candidate:1 1 UDP 1 127.0.0.1 9 typ host" } }),
  ];
  assert.deepEqual(frames.map((frame) => frame.type), ["huddle.join", "huddle.leave", "huddle.mute", "huddle.offer", "huddle.answer", "huddle.ice"]);
  for (const frame of frames) {
    const parsed = parseRelayFrame(frame);
    assert.equal(parsed.ok, true);
    assert.equal(frame.workspaceId, "workspace-1");
    assert.equal(frame.missionId, "mission-1");
    assert.equal((frame.payload as { huddleId?: string }).huddleId, "huddle-1");
    assert.equal((frame.payload as { participantId?: string }).participantId, "alice");
  }
});

test("Mission Relay exposes explicit disconnected liveness before any connection is opened", async () => {
  const client = new MissionRelayClient({ url: "ws://127.0.0.1:9", workspaceId: "workspace-1", credential: "redacted", autoReconnect: false });
  assert.deepEqual(client.liveness, {
    state: "disconnected",
    attempt: 0,
    lastPongAt: null,
    detail: "Mission Relay is not currently connected.",
  });
  await client.close();
});

test("Mission Relay client keeps a live authenticated socket healthy with ping/pong telemetry", async () => {
  const { server, webSocketServer } = createMissionRelayServer({
    port: 0,
    host: "127.0.0.1",
    authenticator: { authenticate: async ({ workspaceId }) => ({ kind: "bridge", id: "bridge-1", workspaceIds: [workspaceId] }) },
    loadMissionSnapshot: async () => ({ missionId: "mission-1", activity: [] }),
    receiveRuntimeEvent: async () => ({ eventId: "event-1", eventType: "provider.activity", summary: "activity" }),
  });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Relay did not expose a bound address.");
  const states: string[] = [];
  const client = new MissionRelayClient({
    url: `ws://127.0.0.1:${address.port}`,
    workspaceId: "workspace-1",
    credential: "bridge-credential",
    heartbeatIntervalMs: 100,
    heartbeatTimeoutMs: 150,
    autoReconnect: false,
    onConnectionState: (state) => states.push(state.state),
  });
  try {
    await client.connect();
    await new Promise((resolve) => setTimeout(resolve, 260));
    assert.equal(client.liveness.state, "connected");
    assert.ok(client.liveness.lastPongAt);
    assert.deepEqual(states.slice(0, 2), ["connecting", "connected"]);
  } finally {
    await client.close();
    await new Promise<void>((resolve) => webSocketServer.close(() => server.close(() => resolve())));
  }
});

test("Mission Relay retries one unconfirmed workspace post over a reconnect with the same idempotent frame", async () => {
  let postCalls = 0;
  const { server, webSocketServer } = createMissionRelayServer({
    port: 0,
    host: "127.0.0.1",
    authenticator: { authenticate: async ({ workspaceId }) => ({ kind: "bridge", id: "bridge-1", workspaceIds: [workspaceId] }) },
    loadMissionSnapshot: async () => ({ missionId: "mission-1", activity: [] }),
    loadWorkspaceSnapshot: async () => ({ cursor: null, messages: [] }),
    postWorkspaceMessage: async ({ frame }) => {
      postCalls += 1;
      if (postCalls === 1) await new Promise((resolve) => setTimeout(resolve, 100));
      return { message: { id: "message-1", recipient_connection_id: null }, frameId: frame.frameId };
    },
  });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Relay did not expose a bound address.");
  const client = new MissionRelayClient({
    url: `ws://127.0.0.1:${address.port}`,
    workspaceId: "workspace-1",
    credential: "bridge-credential",
    workspacePostTimeoutMs: 50,
    reconnectBackoffMs: [0],
    maxReconnectAttempts: 2,
  });
  try {
    await client.subscribeWorkspace("channel-1");
    const result = await client.postWorkspaceMessage({ channelId: "channel-1", kind: "result", body: "retry me", correlationId: "post-correlation" });
    assert.equal((result.message as { id?: string } | undefined)?.id, "message-1");
    assert.equal(postCalls, 2);
  } finally {
    await client.close();
    await new Promise<void>((resolve) => webSocketServer.close(() => server.close(() => resolve())));
  }
});

test("Mission Relay rejects a request-scoped workspace error without disconnecting the authenticated bridge", async () => {
  let postCalls = 0;
  const { server, webSocketServer } = createMissionRelayServer({
    port: 0,
    host: "127.0.0.1",
    authenticator: { authenticate: async ({ workspaceId }) => ({ kind: "bridge", id: "bridge-1", workspaceIds: [workspaceId] }) },
    loadMissionSnapshot: async () => ({ missionId: "mission-1", activity: [] }),
    loadWorkspaceSnapshot: async () => ({ cursor: null, messages: [] }),
    postWorkspaceMessage: async ({ frame }) => {
      postCalls += 1;
      const payload = frame.payload as { body?: unknown };
      if (payload.body === "reject this") throw new Error("workspace message was rejected");
      return { message: { id: "message-good", recipient_connection_id: null }, frameId: frame.frameId };
    },
  });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Relay did not expose a bound address.");
  const client = new MissionRelayClient({
    url: `ws://127.0.0.1:${address.port}`,
    workspaceId: "workspace-1",
    credential: "bridge-credential",
    autoReconnect: false,
    workspacePostTimeoutMs: 100,
    connectTimeoutMs: 200,
  });
  try {
    await client.subscribeWorkspace("channel-1");
    await assert.rejects(
      client.postWorkspaceMessage({ channelId: "channel-1", kind: "message", body: "reject this", correlationId: "reject-correlation" }),
      /workspace message was rejected/,
    );
    assert.equal(client.isConnected, true, "a request error must not tear down the authenticated bridge socket");
    const result = await client.postWorkspaceMessage({ channelId: "channel-1", kind: "message", body: "accept this", correlationId: "accept-correlation" });
    assert.equal((result.message as { id?: string } | undefined)?.id, "message-good");
    assert.equal(postCalls, 2);
  } finally {
    await client.close();
    await new Promise<void>((resolve) => webSocketServer.close(() => server.close(() => resolve())));
  }
});

test("two posts that share one correlationId (bridge-runtime.ts's ack + real reply, by design) both resolve -- neither silently hangs forever", async () => {
  // Regression test for a real production incident: bridge-runtime.ts
  // intentionally threads one correlationId across an entire turn's ack and
  // its real reply/fallback post, purely for tracing. postWorkspaceMessage
  // used to key its pending-confirmation bookkeeping by that same
  // correlationId in a plain Map, so the second post's `.set()` silently
  // evicted the first post's still-pending entry. Nothing ever settled the
  // evicted entry's promise -- not a resolve, not a reject, not a timeout
  // (its own timeout handler compared itself against the map's current
  // holder and no-opped when it wasn't). Confirmed live: a bridge process
  // stayed alive and kept heartbeating normally for 13+ minutes while
  // completely unable to process any further messages, because something
  // upstream was awaiting that first, permanently orphaned promise.
  let received = 0;
  const { server, webSocketServer } = createMissionRelayServer({
    port: 0,
    host: "127.0.0.1",
    authenticator: { authenticate: async ({ workspaceId }) => ({ kind: "bridge", id: "bridge-1", workspaceIds: [workspaceId] }) },
    loadMissionSnapshot: async () => ({ missionId: "mission-1", activity: [] }),
    loadWorkspaceSnapshot: async () => ({ cursor: null, messages: [] }),
    postWorkspaceMessage: async ({ frame }) => {
      received += 1;
      return { message: { id: `message-${received}`, recipient_connection_id: null }, frameId: frame.frameId };
    },
  });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Relay did not expose a bound address.");
  const client = new MissionRelayClient({
    url: `ws://127.0.0.1:${address.port}`,
    workspaceId: "workspace-1",
    credential: "bridge-credential",
    workspacePostTimeoutMs: 2_000,
  });
  try {
    await client.subscribeWorkspace("channel-1");
    const sharedCorrelationId = "shared-turn-correlation-id";
    const [ack, reply] = await Promise.all([
      client.postWorkspaceMessage({ channelId: "channel-1", kind: "ack", body: "received, starting now", correlationId: sharedCorrelationId }),
      client.postWorkspaceMessage({ channelId: "channel-1", kind: "result", body: "the real reply", correlationId: sharedCorrelationId }),
    ]);
    assert.equal(received, 2);
    const ackId = (ack.message as { id?: string } | undefined)?.id;
    const replyId = (reply.message as { id?: string } | undefined)?.id;
    assert.ok(ackId, "the first post (evicted under the old single-entry Map) must still resolve");
    assert.ok(replyId, "the second post must resolve");
    assert.notEqual(ackId, replyId, "each post must resolve with its own distinct confirmation, not one clobbering the other");
  } finally {
    await client.close();
    await new Promise<void>((resolve) => webSocketServer.close(() => server.close(() => resolve())));
  }
});
