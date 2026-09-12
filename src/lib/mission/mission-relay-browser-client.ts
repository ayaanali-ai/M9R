import {
  MISSION_RELAY_FRAME_VERSION,
  parseRelayFrame,
  type MissionHuddleAnswerPayload,
  type MissionHuddleIcePayload,
  type MissionHuddleOfferPayload,
  type RelayFrame,
} from "./mission-relay-protocol";
import type { MissionPresenceState } from "./mission-relay-service";

export type BrowserMissionRelayStatus = "idle" | "connecting" | "authenticated" | "subscribed" | "reconnecting" | "closed" | "error";

export interface BrowserMissionRelaySnapshot {
  mission?: unknown;
  conversation?: { nextCursor?: string | null };
  activity?: unknown;
  deliveries?: unknown;
  assignments?: unknown;
  plan?: unknown;
  evidence?: unknown;
  executions?: unknown;
  cursor?: string | null;
}

export interface BrowserMissionRelayClientOptions {
  url: string;
  workspaceId: string;
  missionId: string;
  /** The token is intentionally short lived. Use getCredential when reconnects may outlive it. */
  credential?: string;
  getCredential?: () => Promise<string>;
  participantId?: string;
  cursor?: string | null;
  reconnect?: boolean;
  onStatus?: (status: BrowserMissionRelayStatus, detail?: string) => void;
  onSnapshot?: (snapshot: BrowserMissionRelaySnapshot, frame: RelayFrame) => void;
  onFrame?: (frame: RelayFrame) => void;
}

export interface BrowserMissionRelayPostResult {
  message?: unknown;
  deliveries?: unknown;
}

// 1011 is a server-only WebSocket close code. Browsers reject it when client
// code passes it to WebSocket.close(), which turns a recoverable relay error
// into the visible "The close code must be either 1000..." failure. Keep the
// client-originated error close in the application range and bound the reason
// to the browser's 123-byte limit.
const BROWSER_CLIENT_ERROR_CLOSE_CODE = 4000;

function closeAfterClientError(socket: WebSocket, reason: string): void {
  if (socket.readyState !== WebSocket.CLOSED) socket.close(BROWSER_CLIENT_ERROR_CLOSE_CODE, reason.slice(0, 123));
}

function id(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.();
  return `${prefix}-${random ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

function relayFrame(input: { type: string; workspaceId: string; missionId?: string; payload: unknown; idempotencyKey?: string | null; correlationId?: string }): RelayFrame {
  return {
    version: MISSION_RELAY_FRAME_VERSION,
    frameId: id("browser"),
    type: input.type,
    workspaceId: input.workspaceId,
    missionId: input.missionId,
    correlationId: input.correlationId ?? id("correlation"),
    causationId: null,
    idempotencyKey: input.idempotencyKey ?? null,
    sentAt: new Date().toISOString(),
    payload: input.payload,
  };
}

/**
 * Browser transport for one Mission room. It only reports a message as live
 * after the Relay has authenticated/subscribed; callers can keep API polling
 * as a truthful fallback when the Relay is unavailable.
 */
export class MissionRelayBrowserClient {
  private readonly options: BrowserMissionRelayClientOptions;
  private socket: WebSocket | null = null;
  private connectTask: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private closed = false;
  private cursor: string | null;
  private authenticated = false;
  private participantId: string | null;
  private desiredPresence: MissionPresenceState | null = null;
  private desiredTyping = false;
  private readonly huddleMemberships = new Map<string, { muted: boolean }>();
  private readonly pendingPosts = new Map<string, { resolve: (result: BrowserMissionRelayPostResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(options: BrowserMissionRelayClientOptions) {
    this.options = options;
    this.cursor = options.cursor ?? null;
    this.participantId = options.participantId ?? null;
  }

  get lastCursor(): string | null {
    return this.cursor;
  }

  get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN && this.authenticated;
  }

  async connect(): Promise<void> {
    if (this.closed) return;
    if (this.isOpen) return;
    if (this.connectTask) return this.connectTask;
    this.options.onStatus?.(this.reconnectAttempt > 0 ? "reconnecting" : "connecting");
    this.connectTask = new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };
      const socket = new WebSocket(this.options.url);
      this.socket = socket;
      socket.addEventListener("open", () => {
        void this.authenticate(socket).catch((error) => finish(error instanceof Error ? error : new Error("Relay authentication failed.")));
      });
      socket.addEventListener("message", (event) => {
        try {
          const parsed = parseRelayFrame(JSON.parse(String(event.data)));
          if (!parsed.ok) throw new Error(parsed.error);
          const frame = parsed.frame;
          if (frame.type === "relay.ready") {
            this.authenticated = true;
            this.reconnectAttempt = 0;
            this.options.onStatus?.("authenticated");
            this.sendFrame(socket, relayFrame({
              type: "mission.subscribe",
              workspaceId: this.options.workspaceId,
              missionId: this.options.missionId,
              payload: { cursor: this.cursor },
            }));
            this.syncEphemeralState(socket);
            this.syncHuddleState(socket);
            finish();
            return;
          }
          if (frame.type === "mission.snapshot") {
            const payload = frame.payload && typeof frame.payload === "object" ? frame.payload as { cursor?: unknown; snapshot?: unknown } : {};
            const snapshot = payload.snapshot && typeof payload.snapshot === "object" ? payload.snapshot as BrowserMissionRelaySnapshot : {};
            const nextCursor = snapshot.conversation && typeof snapshot.conversation.nextCursor === "string" ? snapshot.conversation.nextCursor : null;
            if (nextCursor) this.cursor = nextCursor;
            this.options.onStatus?.("subscribed");
            this.options.onSnapshot?.(snapshot, frame);
            return;
          }
          if (frame.type === "mission.event") {
            const pending = this.pendingPosts.get(frame.correlationId);
            if (pending) {
              clearTimeout(pending.timer);
              this.pendingPosts.delete(frame.correlationId);
              const payload = frame.payload && typeof frame.payload === "object" ? frame.payload as BrowserMissionRelayPostResult : {};
              pending.resolve(payload);
            }
            this.options.onFrame?.(frame);
            return;
          }
          if (frame.type === "relay.error") {
            const message = frame.payload && typeof frame.payload === "object" && typeof (frame.payload as { message?: unknown }).message === "string"
              ? String((frame.payload as { message: string }).message)
              : "Mission Relay rejected the request.";
            this.options.onStatus?.("error", message);
            const error = new Error(message);
            const pending = frame.correlationId ? this.pendingPosts.get(frame.correlationId) : undefined;
            if (pending) {
              clearTimeout(pending.timer);
              this.pendingPosts.delete(frame.correlationId);
              pending.reject(error);
            }
            finish(error);
            // A relay error is terminal for this socket. Closing it is what
            // lets the close handler clear transport state and schedule the
            // bounded reconnect path; leaving it open strands the browser in
            // a permanent "connection issue" state.
            closeAfterClientError(socket, "Mission Relay rejected the request.");
            return;
          }
          this.options.onFrame?.(frame);
        } catch (error) {
          this.options.onStatus?.("error", error instanceof Error ? error.message : "Invalid Mission Relay frame.");
        }
      });
      socket.addEventListener("error", () => {
        const error = new Error("Mission Relay connection failed.");
        this.options.onStatus?.("error", error.message);
        finish(error);
        closeAfterClientError(socket, "Mission Relay connection failed.");
      });
      socket.addEventListener("close", () => {
        this.socket = null;
        this.authenticated = false;
        if (!settled) finish(new Error("Mission Relay connection closed before authentication."));
        if (!this.closed && this.options.reconnect !== false) this.scheduleReconnect();
      });
    }).finally(() => { this.connectTask = null; });
    return this.connectTask;
  }

  async postMessage(payload: Record<string, unknown>): Promise<BrowserMissionRelayPostResult> {
    await this.connect();
    const frame = relayFrame({
      type: "message.post",
      workspaceId: this.options.workspaceId,
      missionId: this.options.missionId,
      idempotencyKey: typeof payload.clientRequestId === "string" ? payload.clientRequestId : id("message"),
      payload,
    });
    return new Promise<BrowserMissionRelayPostResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingPosts.delete(frame.correlationId);
        reject(new Error("Mission Relay did not confirm the message post in time."));
      }, 15_000);
      this.pendingPosts.set(frame.correlationId, { resolve, reject, timer });
      try {
        this.sendFrame(this.socket!, frame);
      } catch (error) {
        clearTimeout(timer);
        this.pendingPosts.delete(frame.correlationId);
        reject(error instanceof Error ? error : new Error("Mission Relay message post failed."));
      }
    });
  }

  setParticipantId(participantId: string | null): void {
    this.participantId = participantId?.trim() || null;
  }

  async setPresence(state: MissionPresenceState): Promise<void> {
    this.desiredPresence = state;
    if (!this.isOpen || !this.participantId) return;
    this.sendFrame(this.socket!, relayFrame({
      type: "participant.presence",
      workspaceId: this.options.workspaceId,
      missionId: this.options.missionId,
      payload: { participantId: this.participantId, state },
    }));
  }

  async setTyping(typing: boolean): Promise<void> {
    this.desiredTyping = typing;
    if (!this.isOpen || !this.participantId) return;
    this.sendFrame(this.socket!, relayFrame({
      type: "participant.typing",
      workspaceId: this.options.workspaceId,
      missionId: this.options.missionId,
      payload: { participantId: this.participantId, typing },
    }));
  }

  async joinHuddle(huddleId: string): Promise<void> {
    const participantId = this.participantId;
    if (!participantId) throw new Error("Mission Relay huddle participant identity is unavailable.");
    const wasOpen = this.isOpen;
    this.huddleMemberships.set(huddleId, { muted: false });
    await this.connect();
    if (wasOpen) this.sendFrame(this.socket!, relayFrame({ type: "huddle.join", workspaceId: this.options.workspaceId, missionId: this.options.missionId, payload: { huddleId, participantId } }));
  }

  async leaveHuddle(huddleId: string): Promise<void> {
    const participantId = this.participantId;
    if (!participantId) throw new Error("Mission Relay huddle participant identity is unavailable.");
    const wasOpen = this.isOpen;
    this.huddleMemberships.delete(huddleId);
    await this.connect();
    if (wasOpen) this.sendFrame(this.socket!, relayFrame({ type: "huddle.leave", workspaceId: this.options.workspaceId, missionId: this.options.missionId, payload: { huddleId, participantId } }));
  }

  async setHuddleMuted(huddleId: string, muted: boolean): Promise<void> {
    const participantId = this.participantId;
    if (!participantId) throw new Error("Mission Relay huddle participant identity is unavailable.");
    const membership = this.huddleMemberships.get(huddleId);
    if (!membership) throw new Error("Join the Mission Relay huddle before changing mute state.");
    membership.muted = muted;
    await this.connect();
    this.sendFrame(this.socket!, relayFrame({ type: "huddle.mute", workspaceId: this.options.workspaceId, missionId: this.options.missionId, payload: { huddleId, participantId, muted } }));
  }

  async sendHuddleOffer(input: Pick<MissionHuddleOfferPayload, "targetParticipantId" | "description"> & { huddleId: string }): Promise<void> {
    await this.sendHuddleSignal("huddle.offer", input);
  }

  async sendHuddleAnswer(input: Pick<MissionHuddleAnswerPayload, "targetParticipantId" | "description"> & { huddleId: string }): Promise<void> {
    await this.sendHuddleSignal("huddle.answer", input);
  }

  async sendHuddleIce(input: Pick<MissionHuddleIcePayload, "targetParticipantId" | "candidate"> & { huddleId: string }): Promise<void> {
    await this.sendHuddleSignal("huddle.ice", input);
  }

  acknowledgeDelivery(deliveryId: string): void {
    if (!this.isOpen) return;
    this.sendFrame(this.socket!, relayFrame({
      type: "message.acknowledge",
      workspaceId: this.options.workspaceId,
      missionId: this.options.missionId,
      payload: { deliveryId },
    }));
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close(1000, "Mission Workspace closed");
    this.socket = null;
    this.authenticated = false;
    for (const pending of this.pendingPosts.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Mission Relay connection closed."));
    }
    this.pendingPosts.clear();
    this.options.onStatus?.("closed");
  }

  private async authenticate(socket: WebSocket): Promise<void> {
    const credential = this.options.getCredential ? await this.options.getCredential() : this.options.credential;
    if (!credential) throw new Error("Mission Relay browser credential is unavailable.");
    this.sendFrame(socket, relayFrame({
      type: "auth.browser",
      workspaceId: this.options.workspaceId,
      missionId: this.options.missionId,
      payload: { credential },
    }));
  }

  private sendFrame(socket: WebSocket, frame: RelayFrame): void {
    if (socket.readyState !== WebSocket.OPEN) throw new Error("Mission Relay is not connected.");
    socket.send(JSON.stringify(frame));
  }

  private syncEphemeralState(socket: WebSocket): void {
    if (!this.participantId) return;
    if (this.desiredPresence) {
      this.sendFrame(socket, relayFrame({
        type: "participant.presence",
        workspaceId: this.options.workspaceId,
        missionId: this.options.missionId,
        payload: { participantId: this.participantId, state: this.desiredPresence },
      }));
    }
    if (this.desiredTyping) {
      this.sendFrame(socket, relayFrame({
        type: "participant.typing",
        workspaceId: this.options.workspaceId,
        missionId: this.options.missionId,
        payload: { participantId: this.participantId, typing: true },
      }));
    }
  }

  private syncHuddleState(socket: WebSocket): void {
    if (!this.participantId) return;
    for (const [huddleId, membership] of this.huddleMemberships) {
      this.sendFrame(socket, relayFrame({ type: "huddle.join", workspaceId: this.options.workspaceId, missionId: this.options.missionId, payload: { huddleId, participantId: this.participantId } }));
      if (membership.muted) this.sendFrame(socket, relayFrame({ type: "huddle.mute", workspaceId: this.options.workspaceId, missionId: this.options.missionId, payload: { huddleId, participantId: this.participantId, muted: true } }));
    }
  }

  private async sendHuddleSignal(type: "huddle.offer" | "huddle.answer" | "huddle.ice", input: { huddleId: string; targetParticipantId: string; description?: MissionHuddleOfferPayload["description"] | MissionHuddleAnswerPayload["description"]; candidate?: MissionHuddleIcePayload["candidate"] }): Promise<void> {
    if (!this.participantId) throw new Error("Mission Relay huddle participant identity is unavailable.");
    if (!this.huddleMemberships.has(input.huddleId)) throw new Error("Join the Mission Relay huddle before sending signaling.");
    await this.connect();
    this.sendFrame(this.socket!, relayFrame({ type, workspaceId: this.options.workspaceId, missionId: this.options.missionId, payload: { huddleId: input.huddleId, participantId: this.participantId, targetParticipantId: input.targetParticipantId, ...(input.description ? { description: input.description } : {}), ...(input.candidate ? { candidate: input.candidate } : {}) } }));
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closed) return;
    const delay = Math.min(30_000, 500 * 2 ** Math.min(this.reconnectAttempt, 6));
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => { /* close handler schedules the next attempt */ });
    }, delay);
  }
}

export interface BrowserWorkspaceRelayOptions {
  url: string;
  workspaceId: string;
  channelId: string;
  credential?: string;
  getCredential?: () => Promise<string>;
  participantId?: string;
  cursor?: string | null;
  reconnect?: boolean;
  onStatus?: (status: BrowserMissionRelayStatus, detail?: string) => void;
  onSnapshot?: (snapshot: Record<string, unknown>, frame: RelayFrame) => void;
  onFrame?: (frame: RelayFrame) => void;
}

/** Live transport for the workspace-first Watchfloor. Durable HTTP remains the fallback. */
export class WorkspaceRelayBrowserClient {
  private readonly options: BrowserWorkspaceRelayOptions;
  private socket: WebSocket | null = null;
  private closed = false;
  private authenticated = false;
  private connectTask: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private cursor: string | null;
  private desiredPresence: MissionPresenceState | null = null;
  private desiredTyping = false;
  private readonly pendingPosts = new Map<string, { frame: RelayFrame; resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(options: BrowserWorkspaceRelayOptions) {
    this.options = options;
    this.cursor = options.cursor ?? null;
  }

  get isOpen(): boolean { return this.socket?.readyState === WebSocket.OPEN && this.authenticated; }
  get lastCursor(): string | null { return this.cursor; }

  async connect(): Promise<void> {
    if (this.closed || this.isOpen) return;
    if (this.connectTask) return this.connectTask;
    this.options.onStatus?.(this.reconnectAttempt > 0 ? "reconnecting" : "connecting");
    this.connectTask = new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };
      let socket: WebSocket;
      try {
        socket = new WebSocket(this.options.url);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Workspace relay WebSocket could not be created.";
        this.options.onStatus?.("error", detail);
        finish(new Error(detail));
        return;
      }
      this.socket = socket;
      socket.addEventListener("open", () => {
        void (async () => {
          const credential = this.options.getCredential ? await this.options.getCredential() : this.options.credential;
          if (!credential) throw new Error("Workspace relay credential is unavailable.");
          this.send(socket, this.frame("auth.browser", { credential }));
        })().catch((error) => {
          const detail = error instanceof Error ? error.message : "Workspace relay authentication failed.";
          this.options.onStatus?.("error", detail);
          finish(new Error(detail));
        });
      });
      socket.addEventListener("message", (event) => {
        try {
          const parsed = parseRelayFrame(JSON.parse(String(event.data)));
          if (!parsed.ok) throw new Error(parsed.error);
          const frame = parsed.frame;
          if (frame.type === "relay.ready") {
            this.authenticated = true;
            this.reconnectAttempt = 0;
            this.options.onStatus?.("authenticated");
            this.send(socket, this.frame("workspace.subscribe", { cursor: this.cursor }));
            this.syncState(socket);
            for (const pending of this.pendingPosts.values()) this.send(socket, pending.frame);
            finish();
            return;
          }
          if (frame.type === "workspace.snapshot") {
            const payload = frame.payload && typeof frame.payload === "object" ? frame.payload as { snapshot?: unknown } : {};
            const snapshot = payload.snapshot && typeof payload.snapshot === "object" ? payload.snapshot as Record<string, unknown> : {};
            if (typeof snapshot.cursor === "string") this.cursor = snapshot.cursor;
            this.options.onStatus?.("subscribed");
            this.options.onSnapshot?.(snapshot, frame);
            return;
          }
          if (frame.type === "workspace.event") {
            const pending = this.pendingPosts.get(frame.correlationId);
            if (pending) {
              clearTimeout(pending.timer);
              this.pendingPosts.delete(frame.correlationId);
              pending.resolve(frame.payload && typeof frame.payload === "object" ? frame.payload as Record<string, unknown> : {});
            }
            const payload = frame.payload && typeof frame.payload === "object" ? frame.payload as { cursor?: unknown } : {};
            if (typeof payload.cursor === "string") this.cursor = payload.cursor;
            this.options.onFrame?.(frame);
            return;
          }
          if (frame.type === "relay.error") {
            const message = frame.payload && typeof frame.payload === "object" && typeof (frame.payload as { message?: unknown }).message === "string" ? String((frame.payload as { message: string }).message) : "Workspace relay rejected the request.";
            this.options.onStatus?.("error", message);
            // A relay error is definitive for the queued post. Reject it now
            // so the caller can use the durable HTTP fallback; waiting for the
            // 15-second timeout made the composer look stuck. The shared
            // idempotency key makes that fallback safe if the relay persisted
            // the post before returning its error.
            this.rejectPendingPosts(message);
            finish(new Error(message));
            // Force the close handler to run so transient relay failures can
            // reconnect instead of leaving the browser socket half-alive.
            closeAfterClientError(socket, "Workspace relay rejected the request.");
            return;
          }
          this.options.onFrame?.(frame);
        } catch (error) { this.options.onStatus?.("error", error instanceof Error ? error.message : "Invalid workspace relay frame."); }
      });
      socket.addEventListener("error", () => {
        const error = new Error("Workspace relay connection failed.");
        this.options.onStatus?.("error", error.message);
        finish(error);
        closeAfterClientError(socket, error.message);
      });
      socket.addEventListener("close", () => {
        this.socket = null;
        this.authenticated = false;
        if (this.options.reconnect === false) this.rejectPendingPosts("Workspace relay connection closed.");
        if (!settled) finish(new Error("Workspace relay closed before authentication."));
        if (!this.closed && this.options.reconnect !== false) this.scheduleReconnect();
      });
    }).finally(() => { this.connectTask = null; });
    return this.connectTask;
  }

  async postMessage(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.connect();
    const frame = this.frame("workspace.post", payload, typeof payload.clientRequestId === "string" ? payload.clientRequestId : id("workspace-message"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pendingPosts.delete(frame.correlationId); reject(new Error("Workspace relay did not confirm the message post in time.")); }, 15_000);
      const pending = { frame, resolve, reject, timer };
      this.pendingPosts.set(frame.correlationId, pending);
      try {
        this.send(this.socket!, frame);
      } catch (error) {
        if (this.options.reconnect === false) {
          clearTimeout(timer);
          this.pendingPosts.delete(frame.correlationId);
          reject(error instanceof Error ? error : new Error("Workspace relay message post failed."));
        }
      }
    });
  }

  async setPresence(state: MissionPresenceState): Promise<void> {
    this.desiredPresence = state;
    if (!this.isOpen || !this.options.participantId) return;
    this.send(this.socket!, this.frame("participant.presence", { participantId: this.options.participantId, state }));
  }

  async setTyping(typing: boolean): Promise<void> {
    this.desiredTyping = typing;
    if (!this.isOpen || !this.options.participantId) return;
    this.send(this.socket!, this.frame("participant.typing", { participantId: this.options.participantId, typing }));
  }

  /**
   * Terminal frames are fire-and-forget: keystrokes and resizes have no useful
   * reply, and a dropped one while reconnecting is better than a queue that
   * replays a burst of stale input into a live shell later.
   */
  sendTerminalFrame(type: "pty.input" | "pty.resize" | "pty.close" | "pty.share" | "pty.request" | "pty.link" | "pty.unlink" | "fs.tree.request" | "fs.read.request" | "presence.cursor" | "participant.typing", payload: Record<string, unknown>): boolean {
    if (!this.isOpen) return false;
    this.send(this.socket!, this.frame(type, payload));
    return true;
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close(1000, "Workspace closed");
    this.socket = null;
    this.authenticated = false;
    for (const pending of this.pendingPosts.values()) { clearTimeout(pending.timer); pending.reject(new Error("Workspace relay connection closed.")); }
    this.pendingPosts.clear();
    this.options.onStatus?.("closed");
  }

  private frame(type: string, payload: unknown, idempotencyKey?: string | null): RelayFrame {
    return { version: MISSION_RELAY_FRAME_VERSION, frameId: id("workspace"), type, workspaceId: this.options.workspaceId, ...(type === "auth.browser" ? {} : { channelId: this.options.channelId }), correlationId: id("correlation"), causationId: null, idempotencyKey: idempotencyKey ?? null, sentAt: new Date().toISOString(), payload };
  }

  private send(socket: WebSocket, frame: RelayFrame): void { if (socket.readyState !== WebSocket.OPEN) throw new Error("Workspace relay is not connected."); socket.send(JSON.stringify(frame)); }

  private rejectPendingPosts(message: string): void {
    for (const pending of this.pendingPosts.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pendingPosts.clear();
  }

  private syncState(socket: WebSocket): void {
    if (!this.options.participantId) return;
    if (this.desiredPresence) this.send(socket, this.frame("participant.presence", { participantId: this.options.participantId, state: this.desiredPresence }));
    if (this.desiredTyping) this.send(socket, this.frame("participant.typing", { participantId: this.options.participantId, typing: true }));
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closed) return;
    const delay = Math.min(30_000, 500 * 2 ** Math.min(this.reconnectAttempt, 6));
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; void this.connect().catch(() => undefined); }, delay);
  }
}
