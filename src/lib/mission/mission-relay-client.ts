import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import type { BridgeRuntimeEventSinkInput } from "../bridge/acp-client";
import type { InteractiveProviderEvent } from "../bridge/interactive-provider-adapter";
import {
  MISSION_RELAY_FRAME_VERSION,
  parseRelayFrame,
  type MissionHuddleAnswerPayload,
  type MissionHuddleIcePayload,
  type MissionHuddleOfferPayload,
  type RelayFrame,
} from "./mission-relay-protocol";
import { PROVIDER_EVENT_TYPES, type ProviderEventPayload, type ProviderEventType } from "./mission-provider-adapter";
import type { MissionRuntimeActivity } from "./mission-runtime-activity";
import type { MissionPresenceState } from "./mission-relay-service";
import type { WorkspaceTurnTimingEvent } from "../bridge/workspace-turn-timing";

export interface MissionRelayRuntimeEventFrameInput {
  workspaceId: string;
  missionId: string;
  executionId: string;
  participantId: string;
  assignmentId: string | null;
  providerAdapterId: string;
  providerSessionRef: string | null;
  event: InteractiveProviderEvent;
}

export function workspaceSnapshotCursor(frame: RelayFrame): string | null {
  if (frame.type !== "workspace.snapshot" || !frame.channelId || !frame.payload || typeof frame.payload !== "object") return null;
  const payload = frame.payload as { cursor?: unknown; snapshot?: unknown };
  const snapshot = payload.snapshot && typeof payload.snapshot === "object" ? payload.snapshot as { cursor?: unknown } : null;
  const cursor = snapshot?.cursor ?? payload.cursor;
  return typeof cursor === "string" && cursor.length > 0 ? cursor : null;
}

export interface MissionRelayRuntimeActivityFrameInput {
  workspaceId: string;
  missionId: string;
  activity: MissionRuntimeActivity;
  providerAdapterId?: string;
}

export type MissionRelayHuddleIdentityInput = { workspaceId: string; missionId: string; huddleId: string; participantId: string };

function huddleFrame(type: string, workspaceId: string, missionId: string, payload: unknown): RelayFrame {
  return {
    version: MISSION_RELAY_FRAME_VERSION,
    frameId: `huddle-${randomUUID()}`,
    type,
    workspaceId,
    missionId,
    correlationId: `huddle-${randomUUID()}`,
    causationId: null,
    idempotencyKey: null,
    sentAt: new Date().toISOString(),
    payload,
  };
}

export function createMissionRelayHuddleJoinFrame(input: MissionRelayHuddleIdentityInput): RelayFrame {
  return huddleFrame("huddle.join", input.workspaceId, input.missionId, { huddleId: input.huddleId, participantId: input.participantId });
}

export function createMissionRelayHuddleLeaveFrame(input: MissionRelayHuddleIdentityInput): RelayFrame {
  return huddleFrame("huddle.leave", input.workspaceId, input.missionId, { huddleId: input.huddleId, participantId: input.participantId });
}

export function createMissionRelayHuddleMuteFrame(input: MissionRelayHuddleIdentityInput & { muted: boolean }): RelayFrame {
  return huddleFrame("huddle.mute", input.workspaceId, input.missionId, { huddleId: input.huddleId, participantId: input.participantId, muted: input.muted });
}

export function createMissionRelayHuddleOfferFrame(input: MissionRelayHuddleIdentityInput & Pick<MissionHuddleOfferPayload, "targetParticipantId" | "description">): RelayFrame {
  return huddleFrame("huddle.offer", input.workspaceId, input.missionId, { huddleId: input.huddleId, participantId: input.participantId, targetParticipantId: input.targetParticipantId, description: input.description });
}

export function createMissionRelayHuddleAnswerFrame(input: MissionRelayHuddleIdentityInput & Pick<MissionHuddleAnswerPayload, "targetParticipantId" | "description">): RelayFrame {
  return huddleFrame("huddle.answer", input.workspaceId, input.missionId, { huddleId: input.huddleId, participantId: input.participantId, targetParticipantId: input.targetParticipantId, description: input.description });
}

export function createMissionRelayHuddleIceFrame(input: MissionRelayHuddleIdentityInput & Pick<MissionHuddleIcePayload, "targetParticipantId" | "candidate">): RelayFrame {
  return huddleFrame("huddle.ice", input.workspaceId, input.missionId, { huddleId: input.huddleId, participantId: input.participantId, targetParticipantId: input.targetParticipantId, candidate: input.candidate });
}

function providerPayload(event: InteractiveProviderEvent): ProviderEventPayload {
  // acp-stdio-adapter.ts's sessionUpdate() emits "provider.reply_text" for
  // the model's own streamed prose (see its own doc comment -- this is the
  // fix for turns that answer normally instead of calling send_message).
  // That type doesn't exist at this layer and isn't in PROVIDER_EVENT_TYPES,
  // so every chunk hit the unsupported-event guard below and got dropped
  // with a "runtime event delivery deferred" warning, live-confirmed
  // tonight (harmless -- the chat message itself still posts through a
  // separate path -- but pure log noise on every reply). Its payload shape
  // ({text}) is exactly ProviderOutputPayload, so map it onto the relay's
  // existing "provider.output" type instead of inventing a second one only
  // this layer would need to learn about.
  if (event.type === "provider.reply_text") {
    return { type: "provider.output", text: typeof event.payload.text === "string" ? event.payload.text : "" };
  }
  // Same class of problem as provider.reply_text above: acp-stdio-adapter.ts
  // emits "provider.plan" for ACP's native plan update, which has no runtime
  // event type of its own. The entries themselves already travel on their own
  // dedicated paths (the durable todos route and the workspace.todos frame),
  // so repeating them here would be duplicate telemetry -- project a bounded
  // progress summary instead of tripping the unsupported-event throw below.
  if (event.type === "provider.plan") {
    const count = Array.isArray(event.payload.entries) ? event.payload.entries.length : 0;
    return { type: "provider.progress", summary: `Plan updated (${count} ${count === 1 ? "item" : "items"}).` };
  }
  if (!PROVIDER_EVENT_TYPES.includes(event.type as ProviderEventType)) throw new Error(`Unsupported provider event '${event.type}'.`);
  if (event.type === "provider.completed") {
    return { type: "provider.completed", summary: `Provider turn completed${typeof event.payload.stopReason === "string" ? ` (${event.payload.stopReason}).` : "."}` };
  }
  if (event.type === "provider.failed") {
    return { type: "provider.failed", reason: typeof event.payload.reason === "string" ? event.payload.reason : "Provider turn failed." };
  }
  if (event.type === "provider.usage_updated") {
    const payload: ProviderEventPayload = {
      type: "provider.usage_updated",
      inputTokens: typeof event.payload.inputTokens === "number" ? event.payload.inputTokens : null,
      outputTokens: typeof event.payload.outputTokens === "number" ? event.payload.outputTokens : null,
    };
    for (const key of ["totalTokens", "contextUsedTokens", "contextWindowTokens", "costUsd", "usageBasis"] as const) {
      if (key in event.payload) (payload as unknown as Record<string, unknown>)[key] = event.payload[key];
    }
    return payload;
  }
  return { type: event.type as ProviderEventPayload["type"], ...event.payload } as ProviderEventPayload;
}

function usageEventIdSuffix(event: InteractiveProviderEvent): string {
  if (event.type !== "provider.usage_updated") return "";
  const payload = event.payload;
  // ACP timestamps have millisecond precision. Two cumulative snapshots can
  // arrive in the same millisecond, so timestamp + type alone is not a safe
  // idempotency key. Include only the bounded, structured usage fields; this
  // keeps retries stable without putting provider text into an event id.
  return [
    payload.inputTokens,
    payload.outputTokens,
    payload.totalTokens,
    payload.contextUsedTokens,
    payload.contextWindowTokens,
    payload.costUsd,
    payload.usageBasis,
  ].map((value) => encodeURIComponent(String(value ?? "null"))).join(".");
}

export function createMissionRelayRuntimeEventFrame(input: MissionRelayRuntimeEventFrameInput): RelayFrame {
  const turnSegment = input.event.turnId ? `-${input.event.turnId}` : "";
  const usageSegment = usageEventIdSuffix(input.event);
  const eventId = `bridge-${input.event.sessionId}${turnSegment}-${input.event.occurredAt}-${input.event.type}${usageSegment ? `-u${usageSegment}` : ""}`.slice(0, 512);
  return {
    version: MISSION_RELAY_FRAME_VERSION,
    frameId: `runtime-${randomUUID()}`,
    type: "runtime.event",
    workspaceId: input.workspaceId,
    missionId: input.missionId,
    correlationId: `bridge-${input.event.sessionId}`,
    causationId: null,
    idempotencyKey: eventId,
    sentAt: new Date().toISOString(),
    payload: {
      executionId: input.executionId,
      participantId: input.participantId,
      assignmentId: input.assignmentId,
      event: {
        type: input.event.type,
        eventId,
        adapterId: input.providerAdapterId,
        providerSessionRef: input.providerSessionRef,
        timestamp: input.event.occurredAt,
        ...(input.event.turnId ? { turnId: input.event.turnId } : {}),
        payload: providerPayload(input.event),
      },
    },
  };
}

export function createMissionRelayRuntimeActivityFrame(input: MissionRelayRuntimeActivityFrameInput): RelayFrame {
  const eventId = input.activity.eventId || input.activity.activityId;
  return {
    version: MISSION_RELAY_FRAME_VERSION,
    frameId: `runtime-activity-${randomUUID()}`,
    type: "runtime.event",
    workspaceId: input.workspaceId,
    missionId: input.missionId,
    correlationId: `runtime-activity-${input.activity.executionId}`,
    causationId: input.activity.eventId,
    idempotencyKey: eventId,
    sentAt: new Date().toISOString(),
    payload: {
      executionId: input.activity.executionId,
      participantId: input.activity.participantId,
      assignmentId: input.activity.assignmentId,
      event: {
        type: "provider.activity",
        eventId,
        adapterId: input.providerAdapterId ?? "mission-runtime",
        providerSessionRef: null,
        timestamp: input.activity.occurredAt,
        payload: {
          type: "provider.activity",
          activityKind: input.activity.kind,
          status: input.activity.status,
          summary: input.activity.summary,
          filePath: input.activity.filePath,
          command: input.activity.command,
          testName: input.activity.testName,
          testPassed: input.activity.testPassed,
          testFailed: input.activity.testFailed,
          testSkipped: input.activity.testSkipped,
          reviewTarget: input.activity.reviewTarget,
          gitRef: input.activity.gitRef,
        },
      },
    },
  };
}

export interface MissionRelayClientOptions {
  url: string;
  workspaceId: string;
  credential: string;
  participantId?: string;
  connectTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  reconnectBackoffMs?: readonly number[];
  maxReconnectAttempts?: number;
  autoReconnect?: boolean;
  /** Maximum time to wait for a workspace post confirmation before one idempotent reconnect retry. */
  workspacePostTimeoutMs?: number;
  onConnectionState?: (state: MissionRelayConnectionState) => void;
  onFrame?: (frame: RelayFrame) => void | Promise<void>;
}

export interface MissionRelayConnectionState {
  state: "connecting" | "connected" | "disconnected" | "reconnecting" | "failed";
  attempt: number;
  lastPongAt: string | null;
  detail: string;
}

export interface MissionRelayWorkspacePostFrameInput {
  workspaceId: string;
  channelId: string;
  participantId: string | null;
  kind: "message" | "handoff" | "ack" | "result" | "notice";
  body: string;
  parentMessageId?: string | null;
  recipientConnectionId?: string | null;
  correlationId?: string | null;
  idempotencyKey?: string | null;
  /** Only meaningful for kind:"result" -- whether the turn actually
   * succeeded, so the UI can style it truthfully instead of a fixed
   * success-green tied to the message kind alone. Null means unknown, which
   * must render with no tint, never guessed as success. */
  outcome?: "ok" | "failed" | "incomplete" | null;
}

export function createMissionRelayWorkspacePostFrame(input: MissionRelayWorkspacePostFrameInput): RelayFrame {
  const requestId = randomUUID();
  // Deliberately NOT derived from correlationId: bridge-runtime.ts threads
  // one correlationId across an entire turn's ack, real reply, AND fallback
  // post, purely for tracing. Deriving idempotency from it meant the ack and
  // the fallback shared one idempotency_key -- the relay's idempotent-replay
  // path then silently returned the ack's own already-inserted row for the
  // fallback post instead of inserting it, so postWorkspaceResult reported
  // "posted: ok" every time while no new row was ever created. Confirmed
  // live: 100% reproducible, not flaky -- every fallback vanished this way
  // whenever it shared a correlationId with an earlier post in the same
  // turn. requestId is fresh per call, so idempotency now only protects a
  // single post against its own reconnect-retry (the client resends the
  // same already-built frame object, requestId and all), never collides
  // across two different logical posts.
  const idempotencyKey = input.idempotencyKey?.trim() || `workspace-post:${input.participantId ?? "bridge"}:${requestId}`;
  return {
    version: MISSION_RELAY_FRAME_VERSION,
    frameId: `workspace-post-${requestId}`,
    type: "workspace.post",
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    correlationId: input.correlationId?.trim() || `workspace-post-${requestId}`,
    causationId: input.parentMessageId ?? null,
    idempotencyKey,
    sentAt: new Date().toISOString(),
    payload: {
      kind: input.kind,
      body: input.body,
      parentMessageId: input.parentMessageId ?? null,
      ...(input.recipientConnectionId ? { recipientConnectionId: input.recipientConnectionId } : {}),
      ...(input.outcome ? { outcome: input.outcome } : {}),
    },
  };
}

export function createMissionRelayWorkspaceTimingFrame(event: WorkspaceTurnTimingEvent): RelayFrame {
  return {
    version: MISSION_RELAY_FRAME_VERSION,
    frameId: `workspace-timing-${event.eventId}`,
    type: "workspace.timing",
    workspaceId: event.workspaceId,
    channelId: event.conversationId,
    correlationId: event.correlationId,
    causationId: event.causationId,
    idempotencyKey: event.eventId,
    sentAt: new Date().toISOString(),
    payload: event,
  };
}

/** Node-side transport used by a Bridge runtime event sink. */
export class MissionRelayClient {
  private socket: WebSocket | null = null;
  private ready: Promise<void> | null = null;
  private readonly connectTimeoutMs: number;
  private readonly options: MissionRelayClientOptions;
  private readonly subscriptions = new Map<string, string | null>();
  private readonly workspaceSubscriptions = new Map<string, string | null>();
  private readonly participantPresence = new Map<string, { participantId: string; state: MissionPresenceState }>();
  private readonly participantTyping = new Map<string, { participantId: string; typing: boolean }>();
  private readonly workspacePresence = new Map<string, { participantId: string; state: MissionPresenceState }>();
  private readonly workspaceTyping = new Map<string, { participantId: string; typing: boolean }>();
  private readonly huddleMemberships = new Map<string, { muted: boolean }>();
  // Keyed by correlationId, but the value is a QUEUE, not a single entry --
  // bridge-runtime.ts intentionally threads one correlationId across an
  // entire turn's ack, real reply, and fallback post (see
  // createMissionRelayWorkspacePostFrame's comment). A single-entry Map here
  // meant the second post with the same correlationId silently evicted the
  // first via `.set()`, and the evicted entry's own resolve/reject were never
  // called by anything -- its promise hung forever, and every caller that
  // awaited it (e.g. a bridge's turn-completion `finally` block) hung with
  // it, permanently, with no timeout and no error anywhere. Confirmed live:
  // a bridge process stayed alive and kept heartbeating normally while its
  // message-processing was silently wedged for 13+ minutes this way. FIFO
  // queueing matches how confirmations actually arrive -- sent and
  // acknowledged in order on one ordered WebSocket connection.
  private readonly pendingWorkspacePosts = new Map<string, Array<{
    frame: RelayFrame;
    resolve: (value: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    attempts: number;
  }>>();
  private readonly participantId: string | null;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly reconnectBackoffMs: readonly number[];
  private readonly maxReconnectAttempts: number;
  private readonly autoReconnect: boolean;
  private readonly workspacePostTimeoutMs: number;
  private readonly heartbeatTimers = new Map<WebSocket, ReturnType<typeof setInterval>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private lastPongAt: number | null = null;
  private lastPingAt: number | null = null;
  private explicitlyClosed = false;
  private connectionState: MissionRelayConnectionState["state"] = "disconnected";

  constructor(options: MissionRelayClientOptions) {
    this.options = options;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.participantId = options.participantId?.trim() || null;
    this.heartbeatIntervalMs = Math.max(100, options.heartbeatIntervalMs ?? 30_000);
    this.heartbeatTimeoutMs = Math.max(50, options.heartbeatTimeoutMs ?? 10_000);
    this.reconnectBackoffMs = options.reconnectBackoffMs?.length ? options.reconnectBackoffMs.map((delay) => Math.max(0, delay)) : [250, 1_000, 3_000, 10_000, 30_000];
    this.maxReconnectAttempts = Math.max(1, options.maxReconnectAttempts ?? 12);
    this.autoReconnect = options.autoReconnect ?? true;
    this.workspacePostTimeoutMs = Math.max(50, options.workspacePostTimeoutMs ?? 15_000);
  }

  async connect(): Promise<void> {
    if (this.ready) return this.ready;
    this.explicitlyClosed = false;
    this.emitConnectionState("connecting", "Opening Mission Relay connection.");
    this.ready = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.options.url);
      this.socket = socket;
      const timeout = setTimeout(() => { socket.terminate(); reject(new Error("Mission Relay connection timed out.")); }, this.connectTimeoutMs);
      const fail = (error: unknown) => { clearTimeout(timeout); reject(error instanceof Error ? error : new Error("Mission Relay connection failed.")); };
      socket.once("error", fail);
      socket.once("open", () => {
        const frame: RelayFrame = {
          version: MISSION_RELAY_FRAME_VERSION,
          frameId: `auth-${randomUUID()}`,
          type: "auth.bridge",
          workspaceId: this.options.workspaceId,
          correlationId: `bridge-auth-${randomUUID()}`,
          causationId: null,
          idempotencyKey: null,
          sentAt: new Date().toISOString(),
          payload: { credential: this.options.credential },
        };
        socket.send(JSON.stringify(frame));
      });
      socket.on("message", (raw) => {
        try {
          const parsed = parseRelayFrame(JSON.parse(raw.toString()));
          if (!parsed.ok) return fail(new Error(parsed.error));
          if (parsed.frame.type === "relay.error") return fail(new Error("Mission Relay rejected Bridge authentication."));
          if (parsed.frame.type === "relay.ready") {
            clearTimeout(timeout);
            this.reconnectAttempt = 0;
            this.lastPongAt = Date.now();
            this.lastPingAt = null;
            this.startHeartbeat(socket);
            socket.removeListener("error", fail);
            for (const [missionId, cursor] of this.subscriptions) this.sendMissionSubscription(socket, missionId, cursor);
            for (const [channelId, cursor] of this.workspaceSubscriptions) this.sendWorkspaceSubscription(socket, channelId, cursor);
            for (const [missionId, presence] of this.participantPresence) this.sendParticipantPresence(socket, { missionId, ...presence }, this.options.workspaceId);
            for (const [missionId, typing] of this.participantTyping) this.sendParticipantTyping(socket, { missionId, ...typing }, this.options.workspaceId);
            for (const [channelId, presence] of this.workspacePresence) this.sendWorkspacePresence(socket, { channelId, ...presence });
            for (const [channelId, typing] of this.workspaceTyping) this.sendWorkspaceTyping(socket, { channelId, ...typing });
            for (const queue of this.pendingWorkspacePosts.values()) for (const pending of queue) this.sendWorkspacePost(socket, pending);
            for (const [huddleId, state] of this.huddleMemberships) {
              const [missionId, scopedHuddleId] = huddleId.split("\u0000");
              if (this.participantId && missionId && scopedHuddleId) socket.send(JSON.stringify(createMissionRelayHuddleJoinFrame({ workspaceId: this.options.workspaceId, missionId, huddleId: scopedHuddleId, participantId: this.participantId })));
              if (this.participantId && state.muted && missionId && scopedHuddleId) socket.send(JSON.stringify(createMissionRelayHuddleMuteFrame({ workspaceId: this.options.workspaceId, missionId, huddleId: scopedHuddleId, participantId: this.participantId, muted: true })));
            }
            this.emitConnectionState("connected", "Mission Relay authentication completed.");
            resolve();
            return;
          }
          if (parsed.frame.type === "workspace.snapshot" && parsed.frame.channelId) {
            const cursor = workspaceSnapshotCursor(parsed.frame);
            if (cursor) this.workspaceSubscriptions.set(parsed.frame.channelId, cursor);
          }
          if (parsed.frame.type === "workspace.event") {
            // FIFO: the oldest still-pending post sharing this correlationId is
            // the one this confirmation belongs to -- posts sharing a
            // correlationId are sent, and confirmed, in send order on this one
            // ordered connection.
            const queue = this.pendingWorkspacePosts.get(parsed.frame.correlationId);
            const pending = queue?.shift();
            if (pending) {
              if (queue && queue.length === 0) this.pendingWorkspacePosts.delete(parsed.frame.correlationId);
              clearTimeout(pending.timer);
              pending.resolve(parsed.frame.payload && typeof parsed.frame.payload === "object" ? parsed.frame.payload as Record<string, unknown> : {});
            }
          }
          // A throw here used to vanish with zero trace -- a message could be
          // silently dropped on the wake-up path with nothing in any log to
          // say so. This callback runs on every inbound frame, so a thrown
          // error is the caller's own bug surfacing, not an expected
          // condition to swallow quietly.
          void Promise.resolve(this.options.onFrame?.(parsed.frame)).catch((error) => {
            console.error(`Mission Relay onFrame handler threw for frame type '${parsed.frame.type}':`, error instanceof Error ? error.message : error);
          });
        } catch {
          fail(new Error("Mission Relay returned an invalid authentication response."));
        }
      });
      socket.once("close", () => {
        this.stopHeartbeat(socket);
        if (this.ready) this.ready = null;
        if (this.socket === socket) this.socket = null;
        // Keep unconfirmed posts in memory. The exact same frame is resent
        // after authentication on the next socket, and the server's
        // idempotency key makes a lost response safe to replay.
        if (!this.explicitlyClosed) this.scheduleReconnect("Mission Relay socket closed.");
      });
    }).catch((error) => {
      this.ready = null;
      if (!this.explicitlyClosed) this.scheduleReconnect(error instanceof Error ? error.message : "Mission Relay connection failed.");
      throw error;
    });
    return this.ready;
  }

  async publishRuntimeEvent(input: BridgeRuntimeEventSinkInput): Promise<void> {
    await this.connect();
    const frame = createMissionRelayRuntimeEventFrame({
      workspaceId: input.session.workspaceId,
      missionId: input.session.missionId,
      executionId: input.executionId,
      participantId: input.session.participantId,
      assignmentId: input.assignmentId,
      providerAdapterId: input.session.providerAdapterId,
      providerSessionRef: input.session.providerSessionRef,
      event: input.event,
    });
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Mission Relay connection is not open.");
    await new Promise<void>((resolve, reject) => socket.send(JSON.stringify(frame), (error) => error ? reject(error) : resolve()));
  }

  async subscribeMission(missionId: string, cursor: string | null = null): Promise<void> {
    const wasOpen = this.isConnected;
    this.subscriptions.set(missionId, cursor);
    await this.connect();
    if (wasOpen) this.sendMissionSubscription(this.socket!, missionId, cursor);
  }

  /** Subscribe the authenticated agent to a workspace channel for live chat events. */
  async subscribeWorkspace(channelId: string, cursor: string | null = null): Promise<void> {
    const wasOpen = this.isConnected;
    this.workspaceSubscriptions.set(channelId, cursor);
    await this.connect();
    if (wasOpen) this.sendWorkspaceSubscription(this.socket!, channelId, cursor);
  }

  async unsubscribeWorkspace(channelId: string): Promise<void> {
    this.workspaceSubscriptions.delete(channelId);
    if (!this.isConnected) return;
    this.socket!.send(JSON.stringify({
      version: MISSION_RELAY_FRAME_VERSION,
      frameId: `unsubscribe-workspace-${randomUUID()}`,
      type: "workspace.unsubscribe",
      workspaceId: this.options.workspaceId,
      channelId,
      correlationId: `unsubscribe-workspace-${channelId}`,
      causationId: null,
      idempotencyKey: null,
      sentAt: new Date().toISOString(),
      payload: {},
    } satisfies RelayFrame));
  }

  /** Post an agent-owned workspace message through the live relay subscription. */
  async postWorkspaceMessage(input: { channelId: string; kind: "message" | "handoff" | "ack" | "result" | "notice"; body: string; parentMessageId?: string | null; recipientConnectionId?: string | null; correlationId?: string | null; idempotencyKey?: string | null; outcome?: "ok" | "failed" | "incomplete" | null }): Promise<Record<string, unknown>> {
    await this.connect();
    const frame = createMissionRelayWorkspacePostFrame({ ...input, workspaceId: this.options.workspaceId, participantId: this.participantId });
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Mission Relay connection is not open.");
    return new Promise((resolve, reject) => {
      const pending = { frame, resolve, reject, timer: setTimeout(() => undefined, 0), attempts: 0 };
      const queue = this.pendingWorkspacePosts.get(frame.correlationId) ?? [];
      queue.push(pending);
      this.pendingWorkspacePosts.set(frame.correlationId, queue);
      this.armWorkspacePostTimeout(pending);
      this.sendWorkspacePost(socket, pending);
    });
  }

  /** Fire-and-forget redacted timing persistence; never blocks a provider turn. */
  async publishWorkspaceTurnTiming(event: WorkspaceTurnTimingEvent): Promise<void> {
    await this.connect();
    const frame = createMissionRelayWorkspaceTimingFrame(event);
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Mission Relay connection is not open.");
    await new Promise<void>((resolve, reject) => socket.send(JSON.stringify(frame), (error) => error ? reject(error) : resolve()));
  }

  async acknowledgeDelivery(missionId: string, deliveryId: string): Promise<void> {
    await this.connect();
    const frame: RelayFrame = {
      version: MISSION_RELAY_FRAME_VERSION,
      frameId: `ack-${randomUUID()}`,
      type: "message.acknowledge",
      workspaceId: this.options.workspaceId,
      missionId,
      correlationId: `ack-${deliveryId}`,
      causationId: null,
      idempotencyKey: null,
      sentAt: new Date().toISOString(),
      payload: { deliveryId },
    };
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Mission Relay connection is not open.");
    socket.send(JSON.stringify(frame));
  }

  async setParticipantPresence(input: { missionId: string; participantId: string; state: MissionPresenceState }): Promise<void> {
    const wasOpen = this.isConnected;
    const key = input.missionId;
    if (input.state === "offline") this.participantPresence.delete(key);
    else this.participantPresence.set(key, { participantId: input.participantId, state: input.state });
    await this.connect();
    if (wasOpen) await this.sendParticipantPresence(this.socket!, input, this.options.workspaceId);
  }

  async setParticipantTyping(input: { missionId: string; participantId: string; typing: boolean }): Promise<void> {
    const wasOpen = this.isConnected;
    const key = input.missionId;
    if (input.typing) this.participantTyping.set(key, { participantId: input.participantId, typing: true });
    else this.participantTyping.delete(key);
    await this.connect();
    if (wasOpen) await this.sendParticipantTyping(this.socket!, input, this.options.workspaceId);
  }

  async setWorkspacePresence(input: { channelId: string; participantId: string; state: MissionPresenceState }): Promise<void> {
    const wasOpen = this.isConnected;
    if (input.state === "offline") this.workspacePresence.delete(input.channelId);
    else this.workspacePresence.set(input.channelId, { participantId: input.participantId, state: input.state });
    await this.connect();
    if (wasOpen) await this.sendWorkspacePresence(this.socket!, input);
  }

  async setWorkspaceTyping(input: { channelId: string; participantId: string; typing: boolean }): Promise<void> {
    const wasOpen = this.isConnected;
    if (input.typing) this.workspaceTyping.set(input.channelId, { participantId: input.participantId, typing: true });
    else this.workspaceTyping.delete(input.channelId);
    await this.connect();
    if (wasOpen) await this.sendWorkspaceTyping(this.socket!, input);
  }

  /**
   * A-6: a single step of real provider activity (a file read, a command,
   * a tool call) attached to the specific message/turn that produced it.
   * Point-in-time, not ongoing state like presence/typing above -- no
   * replay-on-reconnect cache, a missed step during a brief disconnect is
   * an acceptable gap the same way a missed typing pulse already is.
   * Best-effort: a socket that isn't open right now silently drops this
   * rather than queuing or throwing, matching every other live-only signal
   * in this class.
   */
  async postWorkspaceStep(input: { channelId: string; messageId: string; connectionId: string | null; stepId: string; kind: string; status: "started" | "succeeded" | "failed" | "waiting"; summary: string; filePath?: string | null; command?: string | null; activityId?: string | null; additions?: number | null; deletions?: number | null }): Promise<void> {
    if (!this.isConnected) return;
    await this.connect();
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({
      version: MISSION_RELAY_FRAME_VERSION,
      frameId: `workspace-step-${randomUUID()}`,
      type: "workspace.step",
      workspaceId: this.options.workspaceId,
      channelId: input.channelId,
      correlationId: `workspace-step-${input.stepId}`,
      causationId: null,
      idempotencyKey: input.stepId,
      sentAt: new Date().toISOString(),
      // filePath/command are the provider's own real tool-call fields (see
      // acp-stdio-adapter.ts's ActivityPayload) -- carried so the live
      // indicator can say "Running npm test" / "Editing src/foo.ts" from
      // actual data instead of paraphrasing the title. activityId is the
      // workspace_file_activity row this event was ALSO durably written to
      // (see bridge-runtime.ts's provider.activity handling) -- carried so
      // a live listener (the Files panel) can fetch the real diff by id
      // instead of re-broadcasting redacted repo content on every frame.
      // additions/deletions ride along too since they're cheap and let the
      // panel show change magnitude without a second round trip.
      payload: { messageId: input.messageId, connectionId: input.connectionId, stepId: input.stepId, kind: input.kind, status: input.status, summary: input.summary, filePath: input.filePath ?? null, command: input.command ?? null, activityId: input.activityId ?? null, additions: input.additions ?? null, deletions: input.deletions ?? null },
    }));
  }

  /**
   * Shared Live Sessions: the honest half of "anyone can queue a message
   * while a turn is running" -- WorkspacePromptQueue.enqueue already
   * batches a message behind an in-progress turn (bridge-runtime.ts), but
   * nothing ever told the browser that happened, so a second human's
   * message looked identical whether it was about to run immediately or
   * sit behind another one. Fired only when the enqueue result's depth > 1
   * (this message is not the next one up). Same best-effort, point-in-time,
   * no-replay-on-reconnect posture as postWorkspaceStep above.
   */
  async postQueuedNotice(input: { channelId: string; messageId: string; connectionId: string | null; position: number }): Promise<void> {
    if (!this.isConnected) return;
    await this.connect();
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({
      version: MISSION_RELAY_FRAME_VERSION,
      frameId: `workspace-queued-${randomUUID()}`,
      type: "workspace.queued",
      workspaceId: this.options.workspaceId,
      channelId: input.channelId,
      correlationId: `workspace-queued-${input.messageId}`,
      causationId: null,
      idempotencyKey: `workspace-queued-${input.messageId}`,
      sentAt: new Date().toISOString(),
      payload: { messageId: input.messageId, connectionId: input.connectionId, position: input.position },
    }));
  }

  /**
   * The turn's own start and end, keyed by the agent connection that owns it.
   * The dashboard's "agent is working" indicator used to be started by a
   * client-side regex on the message the human just sent and stopped by a
   * 5-minute timeout -- live tonight that left "Claude Code is working…"
   * running for 15+ minutes in a channel where agent replies were paused and
   * nothing had ever started. This is the real confirmation: only a bridge
   * that actually entered (or left) its provider turn emits it. Same
   * best-effort, live-only delivery as postWorkspaceStep above -- a turn
   * whose "started" is dropped still surfaces through its first step, and a
   * dropped "ended" is bounded client-side by the reply that lands anyway.
   */
  async postWorkspaceTurnState(input: { channelId: string; messageId: string; connectionId: string; state: "started" | "ended"; outcome?: "ok" | "failed" | "cancelled" | "incomplete"; detail?: string | null }): Promise<void> {
    if (!this.isConnected) return;
    await this.connect();
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({
      version: MISSION_RELAY_FRAME_VERSION,
      frameId: `workspace-turn-${randomUUID()}`,
      type: "workspace.turn",
      workspaceId: this.options.workspaceId,
      channelId: input.channelId,
      correlationId: `workspace-turn-${input.messageId}`,
      causationId: null,
      idempotencyKey: `${input.messageId}:${input.connectionId}:${input.state}`,
      sentAt: new Date().toISOString(),
      payload: {
        messageId: input.messageId,
        connectionId: input.connectionId,
        state: input.state,
        outcome: input.outcome ?? null,
        detail: input.detail ? input.detail.slice(0, 240) : null,
      },
    }));
  }

  /**
   * The live half of the message checklist (ACP's native `plan` update, see
   * acp-stdio-adapter.ts). Same best-effort, live-only delivery as
   * postWorkspaceStep/postWorkspaceTurnState above -- but unlike those two,
   * a dropped frame here is not the end of the story: the same entries are
   * also written durably through the agent todos route, so a reload always
   * recovers the last known checklist.
   */
  async postWorkspaceTodos(input: { channelId: string; messageId: string; connectionId: string; entries: Array<{ content: string; status: string; priority: string }>; updatedAt: string }): Promise<void> {
    if (!this.isConnected) return;
    await this.connect();
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({
      version: MISSION_RELAY_FRAME_VERSION,
      frameId: `workspace-todos-${randomUUID()}`,
      type: "workspace.todos",
      workspaceId: this.options.workspaceId,
      channelId: input.channelId,
      correlationId: `workspace-todos-${input.messageId}`,
      causationId: null,
      // The checklist is replace-wholesale state, so the useful idempotency
      // unit is "this revision of this message's list", not the message.
      idempotencyKey: `${input.messageId}:${input.updatedAt}`,
      sentAt: new Date().toISOString(),
      payload: {
        messageId: input.messageId,
        connectionId: input.connectionId,
        entries: input.entries,
        updatedAt: input.updatedAt,
      },
    }));
  }

  async joinHuddle(missionId: string, huddleId: string): Promise<void> {
    if (!this.participantId) throw new Error("Mission Relay huddle participant identity is unavailable.");
    const wasOpen = this.isConnected;
    this.huddleMemberships.set(`${missionId}\u0000${huddleId}`, { muted: false });
    await this.connect();
    if (wasOpen) await this.sendHuddleFrame(createMissionRelayHuddleJoinFrame({ workspaceId: this.options.workspaceId, missionId, huddleId, participantId: this.participantId }));
  }

  async leaveHuddle(missionId: string, huddleId: string): Promise<void> {
    if (!this.participantId) throw new Error("Mission Relay huddle participant identity is unavailable.");
    const wasOpen = this.isConnected;
    this.huddleMemberships.delete(`${missionId}\u0000${huddleId}`);
    await this.connect();
    if (wasOpen) await this.sendHuddleFrame(createMissionRelayHuddleLeaveFrame({ workspaceId: this.options.workspaceId, missionId, huddleId, participantId: this.participantId }));
  }

  async setHuddleMuted(missionId: string, huddleId: string, muted: boolean): Promise<void> {
    if (!this.participantId) throw new Error("Mission Relay huddle participant identity is unavailable.");
    const state = this.huddleMemberships.get(`${missionId}\u0000${huddleId}`);
    if (!state) throw new Error("Join the Mission Relay huddle before changing mute state.");
    state.muted = muted;
    await this.connect();
    await this.sendHuddleFrame(createMissionRelayHuddleMuteFrame({ workspaceId: this.options.workspaceId, missionId, huddleId, participantId: this.participantId, muted }));
  }

  async sendHuddleOffer(input: Omit<MissionRelayHuddleIdentityInput, "workspaceId" | "participantId"> & Pick<MissionHuddleOfferPayload, "targetParticipantId" | "description">): Promise<void> {
    await this.sendHuddleSignal(createMissionRelayHuddleOfferFrame({ ...input, workspaceId: this.options.workspaceId, participantId: this.participantId ?? "" }));
  }

  async sendHuddleAnswer(input: Omit<MissionRelayHuddleIdentityInput, "workspaceId" | "participantId"> & Pick<MissionHuddleAnswerPayload, "targetParticipantId" | "description">): Promise<void> {
    await this.sendHuddleSignal(createMissionRelayHuddleAnswerFrame({ ...input, workspaceId: this.options.workspaceId, participantId: this.participantId ?? "" }));
  }

  async sendHuddleIce(input: Omit<MissionRelayHuddleIdentityInput, "workspaceId" | "participantId"> & Pick<MissionHuddleIcePayload, "targetParticipantId" | "candidate">): Promise<void> {
    await this.sendHuddleSignal(createMissionRelayHuddleIceFrame({ ...input, workspaceId: this.options.workspaceId, participantId: this.participantId ?? "" }));
  }

  async publishRuntimeActivity(input: MissionRelayRuntimeActivityFrameInput): Promise<void> {
    await this.connect();
    const frame = createMissionRelayRuntimeActivityFrame(input);
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Mission Relay connection is not open.");
    await new Promise<void>((resolve, reject) => socket.send(JSON.stringify(frame), (error) => error ? reject(error) : resolve()));
  }

  /**
   * Publishes this host's terminal frames into a workspace channel. Output is
   * high-frequency, so this deliberately does not await a socket callback per
   * frame -- MissionPtyHost already bounds the rate upstream.
   */
  async sendTerminalFrame(input: { channelId: string; type: "pty.open" | "pty.output" | "pty.close"; payload: Record<string, unknown> }): Promise<void> {
    await this.connect();
    const frame: RelayFrame = {
      version: MISSION_RELAY_FRAME_VERSION,
      frameId: `pty-${randomUUID()}`,
      type: input.type,
      workspaceId: this.options.workspaceId,
      channelId: input.channelId,
      correlationId: `pty-${String(input.payload.sessionId ?? "session")}`.slice(0, 256),
      causationId: null,
      idempotencyKey: null,
      sentAt: new Date().toISOString(),
      payload: input.payload,
    };
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Mission Relay connection is not open.");
    socket.send(JSON.stringify(frame));
  }

  /** Item #9 Phase 1a: the resident's own
   * file-tree/content/error responses, published into the room. */
  async sendFsFrame(input: { channelId: string; type: "fs.tree" | "fs.content.chunk" | "fs.error"; payload: Record<string, unknown> }): Promise<void> {
    await this.connect();
    const frame: RelayFrame = {
      version: MISSION_RELAY_FRAME_VERSION,
      frameId: `fs-${randomUUID()}`,
      type: input.type,
      workspaceId: this.options.workspaceId,
      channelId: input.channelId,
      correlationId: `fs-${String(input.payload.requestId ?? "request")}`.slice(0, 256),
      causationId: null,
      idempotencyKey: null,
      sentAt: new Date().toISOString(),
      payload: input.payload,
    };
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Mission Relay connection is not open.");
    socket.send(JSON.stringify(frame));
  }

  async sendBridgeHeartbeat(input: { bridgeInstanceId: string; protocolVersion: string; activeSessionIds: string[] }): Promise<void> {
    await this.connect();
    const frame: RelayFrame = {
      version: MISSION_RELAY_FRAME_VERSION,
      frameId: `heartbeat-${randomUUID()}`,
      type: "bridge.heartbeat",
      workspaceId: this.options.workspaceId,
      correlationId: `heartbeat-${input.bridgeInstanceId}`,
      causationId: null,
      idempotencyKey: null,
      sentAt: new Date().toISOString(),
      payload: {
        protocolVersion: input.protocolVersion,
        bridgeInstanceId: input.bridgeInstanceId,
        activeSessionIds: input.activeSessionIds.slice(0, 8),
      },
    };
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Mission Relay connection is not open.");
    await new Promise<void>((resolve, reject) => socket.send(JSON.stringify(frame), (error) => error ? reject(error) : resolve()));
  }

  async close(): Promise<void> {
    this.explicitlyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.ready = null;
    this.socket = null;
    for (const queue of this.pendingWorkspacePosts.values()) {
      for (const pending of queue) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Mission Relay connection closed before the workspace message was confirmed."));
      }
    }
    this.pendingWorkspacePosts.clear();
    if (socket) this.stopHeartbeat(socket);
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => { socket.once("close", () => resolve()); socket.close(); });
    this.emitConnectionState("disconnected", "Mission Relay connection closed by the bridge.");
  }

  get isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN && this.ready !== null;
  }

  get liveness(): MissionRelayConnectionState {
    return {
      state: this.connectionState,
      attempt: this.reconnectAttempt,
      lastPongAt: this.lastPongAt === null ? null : new Date(this.lastPongAt).toISOString(),
      detail: this.connectionState === "connected" ? "Mission Relay is connected and receiving pong responses." : "Mission Relay is not currently connected.",
    };
  }

  private emitConnectionState(state: MissionRelayConnectionState["state"], detail: string): void {
    this.connectionState = state;
    try {
      this.options.onConnectionState?.({
        state,
        attempt: this.reconnectAttempt,
        lastPongAt: this.lastPongAt === null ? null : new Date(this.lastPongAt).toISOString(),
        detail,
      });
    } catch {
      // Connection telemetry must never affect the relay transport.
    }
  }

  private startHeartbeat(socket: WebSocket): void {
    this.stopHeartbeat(socket);
    const timer = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      const now = Date.now();
      if (this.lastPingAt !== null && (this.lastPongAt === null || this.lastPongAt < this.lastPingAt) && now - this.lastPingAt > this.heartbeatTimeoutMs) {
        this.emitConnectionState("reconnecting", "Mission Relay heartbeat timed out; forcing reconnect.");
        socket.terminate();
        return;
      }
      this.lastPingAt = now;
      socket.ping();
    }, this.heartbeatIntervalMs);
    this.heartbeatTimers.set(socket, timer);
    socket.on("pong", () => {
      if (this.socket !== socket) return;
      this.lastPongAt = Date.now();
    });
  }

  private stopHeartbeat(socket: WebSocket): void {
    const timer = this.heartbeatTimers.get(socket);
    if (timer) clearInterval(timer);
    this.heartbeatTimers.delete(socket);
  }

  private scheduleReconnect(detail: string): void {
    if (!this.autoReconnect || this.explicitlyClosed || this.reconnectTimer) return;
    if (this.reconnectAttempt >= this.maxReconnectAttempts) {
      this.emitConnectionState("failed", `Mission Relay reconnect circuit opened after ${this.maxReconnectAttempts} attempts.`);
      return;
    }
    const delay = this.reconnectBackoffMs[Math.min(this.reconnectAttempt, this.reconnectBackoffMs.length - 1)] ?? 0;
    this.reconnectAttempt += 1;
    this.emitConnectionState("reconnecting", `${detail} Retrying in ${delay}ms.`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => undefined);
    }, delay);
  }

  private sendMissionSubscription(socket: WebSocket, missionId: string, cursor: string | null): void {
    socket.send(JSON.stringify({
      version: MISSION_RELAY_FRAME_VERSION,
      frameId: `subscribe-${randomUUID()}`,
      type: "mission.subscribe",
      workspaceId: this.options.workspaceId,
      missionId,
      correlationId: `subscribe-${missionId}`,
      causationId: null,
      idempotencyKey: null,
      sentAt: new Date().toISOString(),
      payload: { cursor },
    } satisfies RelayFrame));
  }

  private sendWorkspaceSubscription(socket: WebSocket, channelId: string, cursor: string | null): void {
    socket.send(JSON.stringify({
      version: MISSION_RELAY_FRAME_VERSION,
      frameId: `subscribe-workspace-${randomUUID()}`,
      type: "workspace.subscribe",
      workspaceId: this.options.workspaceId,
      channelId,
      correlationId: `subscribe-workspace-${channelId}`,
      causationId: null,
      idempotencyKey: null,
      sentAt: new Date().toISOString(),
      payload: { cursor },
    } satisfies RelayFrame));
  }

  /**
   * A relay can accept a post and lose the confirmation when its socket dies.
   * Preserve the exact idempotent frame through one reconnect retry instead of
   * deleting it at the first timeout; after the bounded retry, fail clearly.
   */
  private armWorkspacePostTimeout(pending: { frame: RelayFrame; resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; attempts: number }): void {
    clearTimeout(pending.timer);
    // The first confirmation deadline is intentionally short so a dead
    // socket is detected quickly. Once we have spent that deadline on the
    // reconnect retry, give the new authenticated socket up to the normal
    // connection timeout to complete its handshake. A fixed 50ms retry
    // window made a legitimate reconnect look like a lost post whenever the
    // host was under load, even though the exact idempotent frame was already
    // queued for resend.
    const timeoutMs = pending.attempts === 0
      ? this.workspacePostTimeoutMs
      : Math.max(this.workspacePostTimeoutMs, this.connectTimeoutMs);
    pending.timer = setTimeout(() => {
      const queue = this.pendingWorkspacePosts.get(pending.frame.correlationId);
      const index = queue ? queue.indexOf(pending) : -1;
      if (index === -1) return; // already resolved by a confirmation, or already rejected
      if (pending.attempts >= 1) {
        queue!.splice(index, 1);
        if (queue!.length === 0) this.pendingWorkspacePosts.delete(pending.frame.correlationId);
        pending.reject(new Error("Mission Relay did not confirm the workspace message post after one reconnect retry."));
        return;
      }
      pending.attempts += 1;
      const socket = this.socket;
      if (socket?.readyState === WebSocket.OPEN) socket.terminate();
      else this.scheduleReconnect("Workspace post confirmation timed out; reconnecting to retry the idempotent post.");
      this.armWorkspacePostTimeout(pending);
    }, timeoutMs);
  }

  private sendWorkspacePost(socket: WebSocket, pending: { frame: RelayFrame }): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(pending.frame), () => {
      // A send callback error is followed by the socket close path in ws.
      // Leave the pending frame intact so the reconnect can retry it.
    });
  }

  private async sendParticipantPresence(socket: WebSocket, input: { missionId: string; participantId: string; state: MissionPresenceState }, workspaceId: string): Promise<void> {
    await new Promise<void>((resolve, reject) => socket.send(JSON.stringify({
      version: MISSION_RELAY_FRAME_VERSION,
      frameId: `presence-${randomUUID()}`,
      type: "participant.presence",
      workspaceId,
      missionId: input.missionId,
      correlationId: `presence-${input.participantId}`,
      causationId: null,
      idempotencyKey: null,
      sentAt: new Date().toISOString(),
      payload: { participantId: input.participantId, state: input.state },
    } satisfies RelayFrame), (error) => error ? reject(error) : resolve()));
  }

  private async sendParticipantTyping(socket: WebSocket, input: { missionId: string; participantId: string; typing: boolean }, workspaceId: string): Promise<void> {
    await new Promise<void>((resolve, reject) => socket.send(JSON.stringify({
      version: MISSION_RELAY_FRAME_VERSION,
      frameId: `typing-${randomUUID()}`,
      type: "participant.typing",
      workspaceId,
      missionId: input.missionId,
      correlationId: `typing-${input.participantId}`,
      causationId: null,
      idempotencyKey: null,
      sentAt: new Date().toISOString(),
      payload: { participantId: input.participantId, typing: input.typing },
    } satisfies RelayFrame), (error) => error ? reject(error) : resolve()));
  }

  private async sendWorkspacePresence(socket: WebSocket, input: { channelId: string; participantId: string; state: MissionPresenceState }): Promise<void> {
    socket.send(JSON.stringify({ version: MISSION_RELAY_FRAME_VERSION, frameId: `workspace-presence-${randomUUID()}`, type: "participant.presence", workspaceId: this.options.workspaceId, channelId: input.channelId, correlationId: `workspace-presence-${randomUUID()}`, causationId: null, idempotencyKey: null, sentAt: new Date().toISOString(), payload: { participantId: input.participantId, state: input.state } }));
  }

  private async sendWorkspaceTyping(socket: WebSocket, input: { channelId: string; participantId: string; typing: boolean }): Promise<void> {
    socket.send(JSON.stringify({ version: MISSION_RELAY_FRAME_VERSION, frameId: `workspace-typing-${randomUUID()}`, type: "participant.typing", workspaceId: this.options.workspaceId, channelId: input.channelId, correlationId: `workspace-typing-${randomUUID()}`, causationId: null, idempotencyKey: null, sentAt: new Date().toISOString(), payload: { participantId: input.participantId, typing: input.typing } }));
  }

  private async sendHuddleFrame(frame: RelayFrame): Promise<void> {
    await this.connect();
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Mission Relay connection is not open.");
    await new Promise<void>((resolve, reject) => socket.send(JSON.stringify(frame), (error) => error ? reject(error) : resolve()));
  }

  private async sendHuddleSignal(frame: RelayFrame): Promise<void> {
    if (!this.participantId) throw new Error("Mission Relay huddle participant identity is unavailable.");
    if (!this.huddleMemberships.has(`${frame.missionId}\u0000${(frame.payload as { huddleId: string }).huddleId}`)) throw new Error("Join the Mission Relay huddle before sending signaling.");
    await this.sendHuddleFrame(frame);
  }
}
