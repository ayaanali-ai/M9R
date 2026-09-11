import assert from "node:assert/strict";
import test from "node:test";
import {
  MISSION_RELAY_FRAME_VERSION,
  parseRelayFrame,
  type RelayFrame,
} from "@/lib/mission/mission-relay-protocol";
import {
  authorizeRelayWorkspace,
  type MissionRelayPrincipal,
} from "@/lib/mission/mission-relay-auth";
import {
  MissionRelaySubscriptionRegistry,
} from "@/lib/mission/mission-relay-subscriptions";
import {
  advanceDelivery,
  expandMessageDeliveries,
} from "@/lib/mission/mission-message-delivery";
import { MissionRelayService } from "@/lib/mission/mission-relay-service";
import { InMemoryMissionMessageDeliveryStore } from "@/lib/mission/mission-message-delivery-store";

const baseFrame: RelayFrame = {
  version: MISSION_RELAY_FRAME_VERSION,
  frameId: "frame-1",
  type: "mission.subscribe",
  workspaceId: "workspace-1",
  missionId: "mission-1",
  correlationId: "correlation-1",
  causationId: null,
  idempotencyKey: null,
  sentAt: "2026-08-01T00:00:00.000Z",
  payload: { cursor: null },
};

test("relay frame validation is versioned, bounded, and rejects unknown frame types", () => {
  const parsed = parseRelayFrame(baseFrame);
  assert.equal(parsed.ok, true);
  assert.equal(parseRelayFrame({ ...baseFrame, version: "old" }).ok, false);
  assert.equal(parseRelayFrame({ ...baseFrame, type: "unknown.frame" }).ok, false);
  assert.equal(parseRelayFrame({ ...baseFrame, payload: { body: "x".repeat(20_000) } }).ok, false);
});

test("workspace authorization rejects cross-tenant relay access", () => {
  const principal: MissionRelayPrincipal = { kind: "human", id: "human-1", workspaceIds: ["workspace-1"] };
  assert.equal(authorizeRelayWorkspace(principal, "workspace-1").ok, true);
  assert.equal(authorizeRelayWorkspace(principal, "workspace-2").ok, false);
});

test("subscriptions are isolated by workspace and mission", () => {
  const registry = new MissionRelaySubscriptionRegistry();
  const received: RelayFrame[] = [];
  registry.subscribe({ connectionId: "connection-1", workspaceId: "workspace-1", missionId: "mission-1", send: (frame) => { received.push(frame); } });
  registry.subscribe({ connectionId: "connection-2", workspaceId: "workspace-2", missionId: "mission-1", send: () => { throw new Error("cross-tenant delivery"); } });
  const frame = { ...baseFrame, type: "runtime.event", payload: { activity: "observed" } } as RelayFrame;
  assert.equal(registry.publish("workspace-1", "mission-1", frame), 1);
  assert.equal(received.length, 1);
});

test("recipient-aware workspace fan-out reaches the target and the posting socket only", () => {
  const registry = new MissionRelaySubscriptionRegistry();
  const target: RelayFrame[] = [];
  const sender: RelayFrame[] = [];
  const bystander: RelayFrame[] = [];
  for (const [connectionId, principalId, received] of [["target-socket", "agent-target", target], ["sender-socket", "agent-sender", sender], ["bystander-socket", "agent-other", bystander]] as const) {
    registry.subscribe({ connectionId, principalId, workspaceId: "workspace-1", missionId: "channel-1", scope: "workspace", send: (frame) => { received.push(frame); } });
  }
  registry.publish("workspace-1", "channel-1", { ...baseFrame, frameId: "direct-message" }, { recipientPrincipalId: "agent-target", senderConnectionId: "sender-socket" });
  assert.equal(target.length, 1);
  assert.equal(sender.length, 1);
  assert.equal(bystander.length, 0);
});

test("workspace.post preserves direct recipient routing through the relay service", async () => {
  const frames = new Map<string, RelayFrame[]>();
  const service = new MissionRelayService({
    authenticator: {
      async authenticate({ credential }) { return { kind: "human", id: credential, workspaceIds: ["workspace-1"] }; },
    },
    loadMissionSnapshot: async () => ({ mission: "snapshot" }),
    loadWorkspaceSnapshot: async () => ({ conversation: "snapshot" }),
    postWorkspaceMessage: async () => ({ message: { id: "message-1", recipient_connection_id: "agent-target" } }),
  });
  for (const [connectionId, principalId] of [["target-socket", "agent-target"], ["sender-socket", "agent-sender"], ["bystander-socket", "agent-other"]] as const) {
    frames.set(connectionId, []);
    service.connect({ connectionId, send: (frame) => { frames.get(connectionId)!.push(frame); } });
    await service.receive(connectionId, { ...baseFrame, type: "auth.browser", frameId: `auth-${connectionId}`, payload: { credential: principalId } });
    await service.receive(connectionId, { ...baseFrame, type: "workspace.subscribe", frameId: `subscribe-${connectionId}`, channelId: "channel-1", payload: { cursor: null } });
  }
  await service.receive("sender-socket", { ...baseFrame, type: "workspace.post", frameId: "post-direct", channelId: "channel-1", payload: { body: "direct handoff", recipientConnectionId: "agent-target" } });
  assert.equal(frames.get("target-socket")!.some((frame) => frame.type === "workspace.event"), true);
  assert.equal(frames.get("sender-socket")!.some((frame) => frame.type === "workspace.event"), true);
  assert.equal(frames.get("bystander-socket")!.some((frame) => frame.type === "workspace.event"), false);
});

test("production workspace snapshots apply the same recipient visibility rule to bridge principals", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../src/lib/mission/mission-relay-production.ts", import.meta.url), "utf8"));
  assert.match(source, /input\.principal\.kind === "bridge"/);
  assert.match(source, /recipient_connection_id\.is\.null,recipient_connection_id\.eq\.\$\{input\.principal\.id\},sender_connection_id\.eq\.\$\{input\.principal\.id\}/);
});

test("subscription delivery preserves order behind an async transport", async () => {
  const registry = new MissionRelaySubscriptionRegistry();
  const received: string[] = [];
  let releaseFirst!: () => void;
  const firstSend = new Promise<void>((resolve) => { releaseFirst = resolve; });
  registry.subscribe({
    connectionId: "ordered-connection",
    workspaceId: "workspace-1",
    missionId: "mission-1",
    send: (frame) => {
      received.push(frame.frameId);
      return frame.frameId === "ordered-1" ? firstSend : undefined;
    },
  });
  registry.publish("workspace-1", "mission-1", { ...baseFrame, frameId: "ordered-1" });
  registry.publish("workspace-1", "mission-1", { ...baseFrame, frameId: "ordered-2" });
  assert.deepEqual(received, ["ordered-1"]);
  releaseFirst();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(received, ["ordered-1", "ordered-2"]);
});

test("a slow subscriber gets an explicit resync error instead of an unbounded backlog", async () => {
  const registry = new MissionRelaySubscriptionRegistry();
  const received: RelayFrame[] = [];
  let releaseFirst!: () => void;
  const firstSend = new Promise<void>((resolve) => { releaseFirst = resolve; });
  registry.subscribe({
    connectionId: "overflow-connection",
    workspaceId: "workspace-1",
    missionId: "mission-1",
    send: (frame) => {
      received.push(frame);
      return frame.frameId === "overflow-1" ? firstSend : undefined;
    },
  });
  registry.publish("workspace-1", "mission-1", { ...baseFrame, frameId: "overflow-1" });
  for (let index = 2; index <= 129; index += 1) {
    registry.publish("workspace-1", "mission-1", { ...baseFrame, frameId: `overflow-${index}` });
  }
  // The 129 queued frames are bounded; the next one trips the explicit
  // resync path and removes the permanently slow subscriber.
  registry.publish("workspace-1", "mission-1", { ...baseFrame, frameId: "overflow-trigger" });
  assert.equal(registry.count("workspace-1", "mission-1"), 0);
  releaseFirst();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const overflow = received.at(-1);
  assert.equal(overflow?.type, "relay.error");
  assert.equal((overflow?.payload as { code?: string })?.code, "subscriber_backpressure");
});

test("message delivery expands broadcasts to actual recipients and excludes the sender", () => {
  const deliveries = expandMessageDeliveries({
    idPrefix: "delivery",
    workspaceId: "workspace-1",
    missionId: "mission-1",
    messageId: "message-1",
    senderParticipantId: "agent-a",
    recipientParticipantIds: "mission_broadcast",
    activeRecipientIds: ["agent-a", "agent-b", "agent-c"],
    createdAt: "2026-08-01T00:00:00.000Z",
  });
  assert.deepEqual(deliveries.map((delivery) => delivery.recipientParticipantId), ["agent-b", "agent-c"]);
  const dispatched = advanceDelivery(deliveries[0], "dispatched", "2026-08-01T00:00:01.000Z");
  assert.equal(dispatched.ok, true);
  if (dispatched.ok) assert.equal(dispatched.status, "dispatched");
  assert.equal(advanceDelivery(deliveries[0], "acknowledged", "2026-08-01T00:00:01.000Z").ok, false);
});

test("relay authenticates before subscription and streams bridge activity to subscribed browsers", async () => {
  const browserFrames: RelayFrame[] = [];
  const bridgeFrames: RelayFrame[] = [];
  const service = new MissionRelayService({
    authenticator: {
      async authenticate({ kind }) {
        return { kind: kind === "bridge" ? "bridge" : "human", id: kind, workspaceIds: ["workspace-1"] };
      },
    },
    loadMissionSnapshot: async () => ({ mission: "snapshot" }),
    receiveRuntimeEvent: async () => ({ activity: "file.changed" }),
  });
  service.connect({ connectionId: "browser-1", send: (frame) => { browserFrames.push(frame); } });
  await service.receive("browser-1", { ...baseFrame, type: "auth.browser", payload: { credential: "opaque" } });
  await service.receive("browser-1", baseFrame);
  assert.deepEqual(browserFrames.map((frame) => frame.type), ["relay.ready", "mission.snapshot"]);

  service.connect({ connectionId: "bridge-1", send: (frame) => { bridgeFrames.push(frame); } });
  await service.receive("bridge-1", { ...baseFrame, frameId: "auth-bridge", type: "auth.bridge", payload: { credential: "opaque" } });
  await service.receive("bridge-1", { ...baseFrame, frameId: "runtime-1", type: "runtime.event", payload: { activity: "file.changed" } });
  assert.equal(browserFrames.at(-1)?.type, "runtime.event");
  assert.equal(bridgeFrames[0].type, "relay.ready");

  await service.receive("browser-1", { ...baseFrame, frameId: "cross-tenant", workspaceId: "workspace-2", type: "mission.subscribe" });
  assert.equal(browserFrames.at(-1)?.type, "relay.error");
});

test("workspace timing is accepted only from a bridge and never fan-outs as user content", async () => {
  let received = 0;
  const browserFrames: RelayFrame[] = [];
  const bridgeFrames: RelayFrame[] = [];
  const service = new MissionRelayService({
    authenticator: {
      async authenticate({ kind }) {
        return { kind: kind === "bridge" ? "bridge" : "human", id: kind, workspaceIds: ["workspace-1"] };
      },
    },
    loadMissionSnapshot: async () => ({ mission: "snapshot" }),
    receiveWorkspaceTiming: async ({ frame }) => {
      received += 1;
      assert.equal(frame.type, "workspace.timing");
    },
  });
  service.connect({ connectionId: "timing-browser", send: (frame) => { browserFrames.push(frame); } });
  service.connect({ connectionId: "timing-bridge", send: (frame) => { bridgeFrames.push(frame); } });
  await service.receive("timing-browser", { ...baseFrame, frameId: "auth-timing-browser", type: "auth.browser", payload: { credential: "opaque" } });
  await service.receive("timing-bridge", { ...baseFrame, frameId: "auth-timing-bridge", type: "auth.bridge", payload: { credential: "opaque" } });

  const timingEvent = {
    schema: "oathlock.workspace_timing.v1",
    timingId: "timing-1",
    eventId: "timing-event-1",
    correlationId: "workspace-turn:timing-1",
    causationId: null,
    workspaceId: "workspace-1",
    conversationId: "conversation-1",
    messageId: "message-1",
    bridgeInstanceId: "bridge-1",
    sessionId: "session-1",
    stage: "message.received",
    atMs: 1_000,
    elapsedMs: 0,
    source: "relay",
    provider: "codex",
  } as const;
  await service.receive("timing-bridge", {
    ...baseFrame,
    frameId: "timing-frame-1",
    channelId: "conversation-1",
    type: "workspace.timing",
    correlationId: timingEvent.correlationId,
    payload: timingEvent,
  });
  assert.equal(received, 1);
  assert.equal(bridgeFrames.some((frame) => frame.type === "relay.error"), false);

  await service.receive("timing-browser", {
    ...baseFrame,
    frameId: "timing-forged",
    channelId: "conversation-1",
    type: "workspace.timing",
    correlationId: timingEvent.correlationId,
    payload: timingEvent,
  });
  assert.equal((browserFrames.at(-1)?.payload as { code?: string })?.code, "bridge_required");
});

test("relay streams authenticated presence and typing, then clears both on disconnect", async () => {
  const firstBrowserFrames: RelayFrame[] = [];
  const secondBrowserFrames: RelayFrame[] = [];
  const service = new MissionRelayService({
    authenticator: {
      async authenticate({ kind }) {
        return { kind: kind === "bridge" ? "bridge" : "human", id: "human-1", workspaceIds: ["workspace-1"] };
      },
    },
    loadMissionSnapshot: async () => ({ mission: "snapshot" }),
  });
  service.connect({ connectionId: "browser-presence-1", send: (frame) => { firstBrowserFrames.push(frame); } });
  await service.receive("browser-presence-1", { ...baseFrame, frameId: "auth-presence-1", type: "auth.browser", payload: { credential: "opaque" } });
  await service.receive("browser-presence-1", baseFrame);
  await service.receive("browser-presence-1", { ...baseFrame, frameId: "presence-online", type: "participant.presence", payload: { participantId: "human-1", state: "online" } });
  await service.receive("browser-presence-1", { ...baseFrame, frameId: "typing-start", type: "participant.typing", payload: { participantId: "human-1", typing: true } });
  assert.equal(firstBrowserFrames.at(-1)?.type, "participant.typing");

  service.connect({ connectionId: "browser-presence-2", send: (frame) => { secondBrowserFrames.push(frame); } });
  await service.receive("browser-presence-2", { ...baseFrame, frameId: "auth-presence-2", type: "auth.browser", payload: { credential: "opaque" } });
  await service.receive("browser-presence-2", { ...baseFrame, frameId: "subscribe-presence-2" });
  assert.equal(secondBrowserFrames.some((frame) => frame.type === "participant.presence" && (frame.payload as { state?: string }).state === "online"), true);
  assert.equal(secondBrowserFrames.some((frame) => frame.type === "participant.typing" && (frame.payload as { typing?: boolean }).typing === true), true);

  service.disconnect("browser-presence-1");
  assert.equal(secondBrowserFrames.some((frame) => frame.type === "participant.presence" && (frame.payload as { state?: string }).state === "offline"), true);
  assert.equal(secondBrowserFrames.some((frame) => frame.type === "participant.typing" && (frame.payload as { typing?: boolean }).typing === false), true);
});

test("relay refuses presence or typing claims for another participant", async () => {
  const frames: RelayFrame[] = [];
  const service = new MissionRelayService({
    authenticator: { async authenticate() { return { kind: "human", id: "human-1", workspaceIds: ["workspace-1"] }; } },
    loadMissionSnapshot: async () => ({ mission: "snapshot" }),
  });
  service.connect({ connectionId: "browser-presence-auth", send: (frame) => { frames.push(frame); } });
  await service.receive("browser-presence-auth", { ...baseFrame, frameId: "auth-presence-auth", type: "auth.browser", payload: { credential: "opaque" } });
  await service.receive("browser-presence-auth", { ...baseFrame, frameId: "presence-forged", type: "participant.presence", payload: { participantId: "other", state: "online" } });
  assert.equal((frames.at(-1)?.payload as { code?: string })?.code, "presence_identity_mismatch");
});

test("delivery store keeps retries and acknowledgement transitions idempotent", async () => {
  const [delivery] = expandMessageDeliveries({
    idPrefix: "delivery",
    workspaceId: "workspace-1",
    missionId: "mission-1",
    messageId: "message-2",
    senderParticipantId: "agent-a",
    recipientParticipantIds: ["agent-b"],
    activeRecipientIds: ["agent-b"],
    createdAt: "2026-08-01T00:00:00.000Z",
  });
  const store = new InMemoryMissionMessageDeliveryStore();
  assert.deepEqual(await store.insert([delivery, delivery]), { stored: 1, duplicates: 1 });
  const dispatched = await store.transition({ id: delivery.id, expectedStatus: "queued", nextStatus: "dispatched", now: "2026-08-01T00:00:01.000Z" });
  assert.equal(dispatched?.attemptCount, 1);
  assert.equal(await store.transition({ id: delivery.id, expectedStatus: "queued", nextStatus: "dispatched", now: "2026-08-01T00:00:02.000Z" }), null);
  const delivered = await store.transition({ id: delivery.id, expectedStatus: "dispatched", nextStatus: "delivered", now: "2026-08-01T00:00:02.000Z" });
  assert.equal(delivered?.status, "delivered");
});

function huddleFrame(overrides: Partial<RelayFrame> & { type: string; payload: unknown }): RelayFrame {
  return {
    ...baseFrame,
    frameId: `${overrides.type}-${Math.random()}`,
    ...overrides,
  };
}

test("relay scopes authenticated huddle membership, mute state, and targeted WebRTC signaling", async () => {
  const aliceFrames: RelayFrame[] = [];
  const bobFrames: RelayFrame[] = [];
  const otherMissionFrames: RelayFrame[] = [];
  const service = new MissionRelayService({
    authenticator: {
      async authenticate({ credential }) {
        return { kind: "human", id: credential, workspaceIds: ["workspace-1"] };
      },
    },
    loadMissionSnapshot: async () => ({ mission: "snapshot" }),
  });
  service.connect({ connectionId: "alice", send: (frame) => { aliceFrames.push(frame); } });
  service.connect({ connectionId: "bob", send: (frame) => { bobFrames.push(frame); } });
  service.connect({ connectionId: "other-mission", send: (frame) => { otherMissionFrames.push(frame); } });

  for (const [connectionId, participantId, missionId] of [
    ["alice", "alice", "mission-1"],
    ["bob", "bob", "mission-1"],
    ["other-mission", "other", "mission-2"],
  ] as const) {
    await service.receive(connectionId, huddleFrame({
      type: "auth.browser",
      workspaceId: "workspace-1",
      missionId,
      payload: { credential: participantId },
    }));
    await service.receive(connectionId, huddleFrame({ type: "mission.subscribe", workspaceId: "workspace-1", missionId, payload: { cursor: null } }));
  }

  await service.receive("alice", huddleFrame({
    type: "huddle.join",
    payload: { huddleId: "huddle-1", participantId: "alice" },
  }));
  await service.receive("bob", huddleFrame({
    type: "huddle.join",
    payload: { huddleId: "huddle-1", participantId: "bob" },
  }));
  await service.receive("alice", huddleFrame({
    type: "huddle.mute",
    payload: { huddleId: "huddle-1", participantId: "alice", muted: true },
  }));
  await service.receive("alice", huddleFrame({
    type: "huddle.offer",
    payload: {
      huddleId: "huddle-1",
      participantId: "alice",
      targetParticipantId: "bob",
      description: { type: "offer", sdp: "v=0\r\no=- secure-offer" },
    },
  }));

  assert.equal(bobFrames.some((frame) => frame.type === "huddle.join" && (frame.payload as { participantId?: string }).participantId === "alice"), true);
  assert.equal(bobFrames.some((frame) => frame.type === "huddle.mute" && (frame.payload as { participantId?: string; muted?: boolean }).participantId === "alice" && (frame.payload as { muted?: boolean }).muted === true), true);
  assert.equal(bobFrames.some((frame) => frame.type === "huddle.offer" && (frame.payload as { targetParticipantId?: string }).targetParticipantId === "bob"), true);
  assert.equal(otherMissionFrames.some((frame) => frame.type.startsWith("huddle.")), false);

  await service.receive("alice", huddleFrame({ type: "huddle.leave", payload: { huddleId: "huddle-1", participantId: "alice" } }));
  assert.equal(bobFrames.some((frame) => frame.type === "huddle.leave" && (frame.payload as { participantId?: string }).participantId === "alice"), true);
});

test("relay rejects forged huddle identity, unsubscribed missions, and media-bearing signaling payloads", async () => {
  const aliceFrames: RelayFrame[] = [];
  const bobFrames: RelayFrame[] = [];
  const service = new MissionRelayService({
    authenticator: {
      async authenticate() {
        return { kind: "human", id: "alice", workspaceIds: ["workspace-1"] };
      },
    },
    loadMissionSnapshot: async () => ({ mission: "snapshot" }),
  });
  service.connect({ connectionId: "alice-auth", send: (frame) => { aliceFrames.push(frame); } });
  service.connect({ connectionId: "bob-auth", send: (frame) => { bobFrames.push(frame); } });
  await service.receive("alice-auth", huddleFrame({ type: "auth.browser", payload: { credential: "opaque" } }));
  await service.receive("alice-auth", huddleFrame({ type: "mission.subscribe", payload: { cursor: null } }));
  await service.receive("bob-auth", huddleFrame({ type: "auth.browser", payload: { credential: "opaque" } }));
  await service.receive("bob-auth", huddleFrame({ type: "mission.subscribe", payload: { cursor: null } }));
  await service.receive("alice-auth", huddleFrame({ type: "huddle.join", payload: { huddleId: "huddle-1", participantId: "alice" } }));
  await service.receive("bob-auth", huddleFrame({ type: "huddle.join", payload: { huddleId: "huddle-1", participantId: "alice" } }));

  await service.receive("alice-auth", huddleFrame({ type: "huddle.mute", payload: { huddleId: "huddle-1", participantId: "forged", muted: true } }));
  assert.equal((aliceFrames.at(-1)?.payload as { code?: string })?.code, "huddle_identity_mismatch");

  await service.receive("alice-auth", huddleFrame({
    missionId: "mission-2",
    type: "huddle.offer",
    payload: { huddleId: "huddle-1", participantId: "alice", targetParticipantId: "alice", description: { type: "offer", sdp: "cross-mission" } },
  }));
  assert.equal((aliceFrames.at(-1)?.payload as { code?: string })?.code, "mission_subscription_required");

  await service.receive("alice-auth", huddleFrame({
    type: "huddle.offer",
    payload: { huddleId: "huddle-1", participantId: "alice", targetParticipantId: "bob", description: { type: "offer", sdp: "safe" }, audioBytes: "must-not-relay" },
  }));
  assert.equal((aliceFrames.at(-1)?.payload as { code?: string })?.code, "huddle_signal_invalid");
  assert.equal(bobFrames.some((frame) => frame.type === "huddle.offer"), false);
});

test("relay removes huddle membership on disconnect and notifies remaining members", async () => {
  const remainingFrames: RelayFrame[] = [];
  const disconnectedFrames: RelayFrame[] = [];
  const service = new MissionRelayService({
    authenticator: { async authenticate({ credential }) { return { kind: "human", id: credential, workspaceIds: ["workspace-1"] }; } },
    loadMissionSnapshot: async () => ({ mission: "snapshot" }),
  });
  service.connect({ connectionId: "disconnected", send: (frame) => { disconnectedFrames.push(frame); } });
  service.connect({ connectionId: "remaining", send: (frame) => { remainingFrames.push(frame); } });
  for (const [connectionId, participantId] of [["disconnected", "alice"], ["remaining", "bob"]] as const) {
    await service.receive(connectionId, huddleFrame({ type: "auth.browser", payload: { credential: participantId } }));
    await service.receive(connectionId, huddleFrame({ type: "mission.subscribe", payload: { cursor: null } }));
    await service.receive(connectionId, huddleFrame({ type: "huddle.join", payload: { huddleId: "huddle-1", participantId } }));
  }
  service.disconnect("disconnected");
  assert.equal(remainingFrames.some((frame) => frame.type === "huddle.leave" && (frame.payload as { participantId?: string }).participantId === "alice"), true);
  assert.equal(disconnectedFrames.some((frame) => frame.type === "huddle.leave"), false);
});
