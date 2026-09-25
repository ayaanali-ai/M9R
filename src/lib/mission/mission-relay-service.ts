import { authorizeRelayWorkspace, type MissionRelayAuthenticator, type MissionRelayPrincipal } from "./mission-relay-auth";
import {
  parseRelayFrame,
  MISSION_RELAY_FRAME_VERSION,
  RELAY_SERVER_FRAME_TYPES,
  type MissionHuddleAnswerPayload,
  type MissionHuddleIcePayload,
  type MissionHuddleOfferPayload,
  type RelayFrame,
  type RelayServerFrameType,
  type WebPresenceAction,
  type WebPresencePayload,
} from "./mission-relay-protocol";
import { MissionRelaySubscriptionRegistry } from "./mission-relay-subscriptions";
import {
  appendScrollback,
  chunkPtyBytes,
  decodePtyBytes,
  parsePtyClosePayload,
  parsePtyInputPayload,
  parsePtyLinkPayload,
  parsePtyOpenPayload,
  parsePtyOutputPayload,
  parsePtyResizePayload,
  parsePtySharePayload,
  type PtySessionStatus,
} from "./mission-pty-protocol";
import { parseFsTreeRequestPayload, parseFsReadRequestPayload } from "./mission-fs-protocol";

export type MissionPresenceState = "online" | "working" | "idle" | "offline";

interface PresenceRecord {
  participantId: string;
  state: MissionPresenceState;
  connectionId: string;
  updatedAt: string;
}

interface TypingRecord {
  participantId: string;
  connectionId: string;
  expiresAt: number;
  /** Item #21 Phase 5a: which terminal pane this tag belongs to, so it renders above that pane's input row rather than the chat composer. Undefined = the chat composer, same as before this field existed. */
  sessionId?: string;
}

interface HuddleMember {
  participantId: string;
  connectionId: string;
  muted: boolean;
}

/**
 * Item #21 Phase 5b's mandatory server-side cap: a token bucket per
 * connection, capped at ~20 Hz (the spec's own named ceiling) with a small
 * burst allowance so a momentary frame batch doesn't get needlessly
 * dropped. Deliberately not a sliding-window log -- a cursor's exact
 * historical rate doesn't matter, only whether it's currently within
 * budget, so a fixed-size bucket is the cheapest correct structure and
 * never grows unbounded per connection.
 */
class CursorRateLimiter {
  private static readonly MAX_TOKENS = 20;
  private static readonly REFILL_PER_MS = 20 / 1000;
  private readonly buckets = new Map<string, { tokens: number; lastRefillAt: number }>();

  allow(connectionId: string): boolean {
    const now = Date.now();
    const bucket = this.buckets.get(connectionId) ?? { tokens: CursorRateLimiter.MAX_TOKENS, lastRefillAt: now };
    const elapsed = now - bucket.lastRefillAt;
    bucket.tokens = Math.min(CursorRateLimiter.MAX_TOKENS, bucket.tokens + elapsed * CursorRateLimiter.REFILL_PER_MS);
    bucket.lastRefillAt = now;
    if (bucket.tokens < 1) {
      this.buckets.set(connectionId, bucket);
      return false;
    }
    bucket.tokens -= 1;
    this.buckets.set(connectionId, bucket);
    return true;
  }

  /** Called on disconnect so a churned-through connection id never lingers. */
  clear(connectionId: string): void {
    this.buckets.delete(connectionId);
  }
}

/**
 * One live terminal pane. The PTY is a process on the owner's machine, so this
 * record is only routing metadata plus enough recent output to paint a pane
 * for someone who subscribes (or refreshes) mid-session. Nothing here is
 * persisted -- terminal bytes stay in memory on the loopback Relay.
 */
interface PtySessionRecord {
  sessionId: string;
  workspaceId: string;
  /** The room (channelId) this session was opened in -- stashed on the record
   * itself, rather than only implied by the ptySessions map key, so a linked
   * peer in a different room can be found and re-published to without
   * parsing the length-prefixed key back apart. */
  channelId: string;
  ownerConnectionId: string;
  ownerParticipantId: string;
  cols: number;
  rows: number;
  title?: string;
  status: PtySessionStatus;
  scrollback: Uint8Array;
  lastSeq: number;
  /** Default true. The owner-controlled Sharing toggle -- see PtySharePayload. */
  shared: boolean;
  /**
   * Item #28 Part B: sessionIds this pane has been linked into a shared Room
   * with, by dragging its link handle onto another pane (see PtyLinkPayload).
   * Symmetric by construction -- linking A to B always adds B to A's set and
   * A to B's set together, so this never needs its own reconciliation pass.
   */
  linkedSessionIds: Set<string>;
}

export interface MissionRelayConnection {
  connectionId: string;
  send(frame: RelayFrame): void | Promise<void>;
}

export interface MissionRelayServiceOptions {
  authenticator: MissionRelayAuthenticator;
  loadMissionSnapshot(input: { principal: MissionRelayPrincipal; workspaceId: string; missionId: string; cursor: string | null }): Promise<unknown>;
  loadWorkspaceSnapshot?(input: { principal: MissionRelayPrincipal; workspaceId: string; channelId: string; cursor: string | null }): Promise<unknown>;
  postMessage?(input: { principal: MissionRelayPrincipal; frame: RelayFrame }): Promise<unknown>;
  postWorkspaceMessage?(input: { principal: MissionRelayPrincipal; frame: RelayFrame }): Promise<unknown>;
  receiveWorkspaceTiming?(input: { principal: MissionRelayPrincipal; frame: RelayFrame }): Promise<void>;
  acknowledgeDelivery?(input: { principal: MissionRelayPrincipal; frame: RelayFrame }): Promise<void>;
  /** Returns a normalized/redacted payload. Returning null refuses fan-out. */
  receiveRuntimeEvent?(input: { principal: MissionRelayPrincipal; frame: RelayFrame }): Promise<unknown | null>;
  receiveBridgeHeartbeat?(input: { principal: MissionRelayPrincipal; frame: RelayFrame }): Promise<void>;
  receivePermissionResponse?(input: { principal: MissionRelayPrincipal; frame: RelayFrame }): Promise<void>;
  /**
   * Resolves the human user id that owns a given agent connection
   * (agent_connections.created_by), looked up by that agent's real,
   * DB-stable connection id -- NOT the relay's own transient per-socket
   * connection id. The human who owns an agent connection never holds that
   * connection's own live socket -- their browser is a separate connection
   * entirely. Without this, "only the owner may type while sharing is off"
   * and "only the owner may toggle Sharing" both silently reduce to "only
   * the bridge process itself," which no human viewer can ever be.
   */
  resolvePtyOwnerHuman?(agentConnectionId: string): Promise<string | null>;
}

interface ConnectionState {
  connection: MissionRelayConnection;
  principal: MissionRelayPrincipal | null;
  subscriptions: Set<string>;
}

function channelKey(workspaceId: string, missionId: string): string {
  return `${workspaceId}\u0000${missionId}`;
}

function roomId(frame: RelayFrame): string | null {
  return frame.channelId ?? frame.missionId ?? null;
}

/** Length-prefixed so no id's contents can forge a key boundary. */
function ptyKey(workspaceId: string, room: string, sessionId: string): string {
  return `${workspaceId.length}:${workspaceId}:${room.length}:${room}:${sessionId}`;
}

function huddleKey(workspaceId: string, missionId: string, huddleId: string): string {
  return `${workspaceId}\u0000${missionId}\u0000${huddleId}`;
}

function isBoundedIdentifier(value: unknown, maxLength = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && !value.includes("\u0000");
}

function recordPayload(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export class MissionRelayService {
  readonly subscriptions = new MissionRelaySubscriptionRegistry();
  private readonly connections = new Map<string, ConnectionState>();
  private readonly presence = new Map<string, Map<string, PresenceRecord>>();
  private readonly typing = new Map<string, Map<string, TypingRecord>>();
  /** Item #21 Phase 5b's mandatory rate limit: per-connection, not per-room, so one noisy pane can't starve every other pane's cursor traffic in the same room. */
  private readonly cursorRateLimiter = new CursorRateLimiter();
  private readonly huddles = new Map<string, Map<string, HuddleMember>>();
  private readonly ptySessions = new Map<string, PtySessionRecord>();
  private readonly options: MissionRelayServiceOptions;

  constructor(options: MissionRelayServiceOptions) {
    this.options = options;
  }

  connect(connection: MissionRelayConnection): void {
    this.connections.set(connection.connectionId, { connection, principal: null, subscriptions: new Set() });
  }

  disconnect(connectionId: string): void {
    const state = this.connections.get(connectionId);
    if (!state) return;
    for (const channel of state.subscriptions) {
      const [workspaceId, missionId] = channel.split("\u0000");
      this.clearEphemeralState(connectionId, workspaceId, missionId);
      this.clearHuddleState(connectionId, workspaceId, missionId);
      this.clearPtyState(connectionId, workspaceId, missionId);
      this.subscriptions.unsubscribe(connectionId, workspaceId, missionId);
    }
    this.cursorRateLimiter.clear(connectionId);
    this.connections.delete(connectionId);
  }

  /**
   * Item #21 Phase 6's resolved relay-ingest gap: the Next.js app is a
   * stateless HTTP surface with no persistent relay connection of its own,
   * so a server-originated action (an MCP tool call landing as a plain
   * HTTP request) cannot publish through the normal client-socket path at
   * all. This is the one, narrow way in: an internal-only HTTP layer (see
   * services/mission-relay/src/server.ts's `/internal/*` routes) calls
   * straight into this in-process service instead of round-tripping
   * through its own WebSocket client, since the HTTP process and this
   * service already share one Node process/memory space.
   *
   * `type` is restricted to RELAY_SERVER_FRAME_TYPES and re-checked here
   * (not just trusted from the HTTP layer's own allowlist) so this method
   * can never be used to smuggle an unvalidated frame type into a room
   * even if a future caller forgets that check.
   */
  publishServerFrame(input: { workspaceId: string; channelId: string; type: RelayServerFrameType; payload: unknown }): boolean {
    if (!RELAY_SERVER_FRAME_TYPES.includes(input.type)) return false;
    const stamp = `internal-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const frame: RelayFrame = {
      version: MISSION_RELAY_FRAME_VERSION,
      frameId: stamp,
      type: input.type,
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      correlationId: stamp,
      causationId: null,
      idempotencyKey: null,
      sentAt: new Date().toISOString(),
      payload: input.payload,
    };
    this.subscriptions.publish(input.workspaceId, input.channelId, frame);
    return true;
  }

  /**
   * Same internal-ingest use case as publishServerFrame -- lets an HTTP
   * route resolve a live PTY session's own room before publishing into it,
   * which is the actual security boundary item #21 Phase 6 depends on
   * ("verifies the sending connection and the target session are in the
   * same room/conversation, and refuses otherwise"). Read-only, exposes
   * only what a caller needs to make that check -- never the session's
   * scrollback or any other internal state.
   */
  lookupPtySessionRoom(workspaceId: string, sessionId: string): { channelId: string; ownerConnectionId: string; status: PtySessionStatus } | null {
    const record = this.findPtySessionById(workspaceId, sessionId);
    if (!record) return null;
    return { channelId: record.channelId, ownerConnectionId: record.ownerConnectionId, status: record.status };
  }

  async receive(connectionId: string, input: unknown): Promise<void> {
    const state = this.connections.get(connectionId);
    if (!state) return;
    const parsed = parseRelayFrame(input);
    if (!parsed.ok) {
      await this.sendError(state, "invalid_frame", parsed.error);
      return;
    }
    const frame = parsed.frame;
    try {
      if (frame.type === "auth.browser" || frame.type === "auth.bridge") {
        await this.authenticate(state, frame);
        return;
      }
      if (!state.principal) {
        await this.sendError(state, "unauthenticated", "Authenticate before using the Mission Relay.");
        return;
      }
      const authorization = authorizeRelayWorkspace(state.principal, frame.workspaceId);
      if (!authorization.ok) {
        await this.sendError(state, authorization.code, authorization.message, frame);
        return;
      }
      await this.handleAuthenticated(state, frame);
    } catch (error) {
      await this.sendError(state, "request_failed", error instanceof Error ? error.message : "Relay request failed.", frame);
    }
  }

  private async authenticate(state: ConnectionState, frame: RelayFrame): Promise<void> {
    if (state.principal) {
      await this.sendError(state, "already_authenticated", "This relay connection is already authenticated.", frame);
      return;
    }
    const payload = frame.payload && typeof frame.payload === "object" ? frame.payload as Record<string, unknown> : {};
    const credential = typeof payload.credential === "string" ? payload.credential : "";
    const kind = frame.type === "auth.bridge" ? "bridge" : "browser";
    const principal = await this.options.authenticator.authenticate({ kind, credential, workspaceId: frame.workspaceId });
    const authorization = authorizeRelayWorkspace(principal, frame.workspaceId);
    if (!authorization.ok) {
      await this.sendError(state, authorization.code, authorization.message, frame);
      return;
    }
    state.principal = principal;
    await state.connection.send(this.serverFrame(frame, "relay.ready", { principalKind: principal.kind, principalId: principal.id }));
  }

  private async handleAuthenticated(state: ConnectionState, frame: RelayFrame): Promise<void> {
    const principal = state.principal!;
    switch (frame.type) {
      case "workspace.subscribe": {
        if (!frame.channelId) return this.sendError(state, "channel_required", "channelId is required to subscribe.", frame);
        if (!this.options.loadWorkspaceSnapshot) return this.sendError(state, "workspace_unavailable", "Workspace rooms are not configured for this relay.", frame);
        const payload = recordPayload(frame.payload) ?? {};
        const cursor = typeof payload.cursor === "string" ? payload.cursor : null;
        const snapshot = await this.options.loadWorkspaceSnapshot({ principal, workspaceId: frame.workspaceId, channelId: frame.channelId, cursor });
        this.subscriptions.subscribe({ connectionId: state.connection.connectionId, principalId: principal.id, workspaceId: frame.workspaceId, missionId: frame.channelId, scope: "workspace", send: (next) => state.connection.send(next) });
        state.subscriptions.add(channelKey(frame.workspaceId, frame.channelId));
        await state.connection.send(this.serverFrame(frame, "workspace.snapshot", { cursor, snapshot }));
        await this.sendEphemeralSnapshot(state, { ...frame, missionId: frame.channelId });
        return;
      }
      case "workspace.unsubscribe": {
        if (!frame.channelId) return this.sendError(state, "channel_required", "channelId is required to unsubscribe.", frame);
        this.subscriptions.unsubscribe(state.connection.connectionId, frame.workspaceId, frame.channelId);
        state.subscriptions.delete(channelKey(frame.workspaceId, frame.channelId));
        this.clearEphemeralState(state.connection.connectionId, frame.workspaceId, frame.channelId);
        this.clearPtyState(state.connection.connectionId, frame.workspaceId, frame.channelId);
        return;
      }
      case "workspace.post": {
        if (!frame.channelId || !this.options.postWorkspaceMessage) return this.sendError(state, "workspace_unavailable", "Workspace message posting is not configured for this relay.", frame);
        const result = await this.options.postWorkspaceMessage({ principal, frame });
        const resultRecord = result && typeof result === "object" && !Array.isArray(result)
          ? result as { message?: unknown; messages?: unknown[] }
          : null;
        const resultMessage = resultRecord?.message ?? null;
        const recipientPrincipalId = resultMessage && typeof resultMessage === "object" && !Array.isArray(resultMessage)
          ? typeof (resultMessage as { recipient_connection_id?: unknown }).recipient_connection_id === "string"
            ? (resultMessage as { recipient_connection_id: string }).recipient_connection_id
            : null
          : null;
        this.subscriptions.publish(frame.workspaceId, frame.channelId, this.serverFrame(frame, "workspace.event", result), {
          recipientPrincipalId,
          senderConnectionId: state.connection.connectionId,
        });
        // Some durable side effects need to become visible immediately on the
        // same live socket as the original post (for example, the M9R notice
        // explaining that an explicitly named provider is offline). Keep
        // these as separate message events so existing post confirmations and
        // cursor handling remain unchanged. The rows are already persisted;
        // reconnect snapshots still recover them if a socket drops here.
        let additionalIndex = 0;
        for (const additionalMessage of resultRecord?.messages ?? []) {
          if (!additionalMessage || typeof additionalMessage !== "object" || Array.isArray(additionalMessage)) continue;
          const extra = additionalMessage as { recipient_connection_id?: unknown };
          const extraRecipient = typeof extra.recipient_connection_id === "string" ? extra.recipient_connection_id : null;
          // A side-effect event is not the confirmation for the original
          // workspace.post. Give it its own correlation id so a bridge that
          // has another post in flight with the same tracing correlation
          // cannot resolve that other promise from this diagnostic event.
          const sideEffectSource = {
            ...frame,
            correlationId: `workspace-side-effect:${frame.frameId}:${additionalIndex}`.slice(0, 256),
          };
          additionalIndex += 1;
          this.subscriptions.publish(frame.workspaceId, frame.channelId, this.serverFrame(sideEffectSource, "workspace.event", {
            message: additionalMessage,
            activity: [],
            cursor: null,
          }), {
            recipientPrincipalId: extraRecipient,
            senderConnectionId: state.connection.connectionId,
          });
        }
        return;
      }
      case "workspace.timing": {
        if (principal.kind !== "bridge") return this.sendError(state, "bridge_required", "Only an authenticated Bridge may publish workspace timing.", frame);
        if (!this.options.receiveWorkspaceTiming) return this.sendError(state, "workspace_timing_unavailable", "Workspace timing persistence is not configured for this relay.", frame);
        await this.options.receiveWorkspaceTiming({ principal, frame });
        return;
      }
      case "mission.subscribe": {
        if (!frame.missionId) return this.sendError(state, "mission_required", "missionId is required to subscribe.", frame);
        const payload = frame.payload && typeof frame.payload === "object" ? frame.payload as Record<string, unknown> : {};
        const cursor = typeof payload.cursor === "string" ? payload.cursor : null;
        const snapshot = await this.options.loadMissionSnapshot({ principal, workspaceId: frame.workspaceId, missionId: frame.missionId, cursor });
        this.subscriptions.subscribe({ connectionId: state.connection.connectionId, principalId: principal.id, workspaceId: frame.workspaceId, missionId: frame.missionId, scope: "mission", send: (next) => state.connection.send(next) });
        state.subscriptions.add(channelKey(frame.workspaceId, frame.missionId));
        await state.connection.send(this.serverFrame(frame, "mission.snapshot", { cursor, snapshot }));
        await this.sendEphemeralSnapshot(state, frame);
        return;
      }
      case "mission.unsubscribe": {
        if (!frame.missionId) return this.sendError(state, "mission_required", "missionId is required to unsubscribe.", frame);
        this.subscriptions.unsubscribe(state.connection.connectionId, frame.workspaceId, frame.missionId);
        state.subscriptions.delete(channelKey(frame.workspaceId, frame.missionId));
        this.clearEphemeralState(state.connection.connectionId, frame.workspaceId, frame.missionId);
        this.clearPtyState(state.connection.connectionId, frame.workspaceId, frame.missionId);
        return;
      }
      case "participant.presence":
        await this.handlePresence(state, frame);
        return;
        case "participant.typing":
        await this.handleTyping(state, frame);
        return;
      case "presence.cursor":
        this.handlePresenceCursor(state, frame);
        return;
      case "web.presence":
        await this.handleWebPresence(state, frame);
        return;
      case "workspace.step":
      case "workspace.turn":
      case "workspace.todos":
      case "workspace.queued": {
        // A-6: point-in-time, unlike presence/typing above -- plain
        // broadcast to the channel's current subscribers, no cached state
        // to replay for a late joiner (a step that already happened before
        // they connected has nothing to replay). workspace.turn is the same
        // shape for the turn's own start/end, so it rides the same path: a
        // dashboard that connects mid-turn learns the turn is live from its
        // next step, not from a replayed "started".
        // Turn state is only worth anything if it cannot be asserted by the
        // surface that displays it -- that was the whole defect it replaces.
        // A browser client may still publish steps (unchanged behavior), but
        // "a turn started/ended" is a Bridge-only claim.
        // workspace.todos is the same kind of claim as workspace.turn: the
        // checklist inside an agent's own message bubble is that agent's
        // reported plan, and a browser client asserting one would be
        // fabricating it. Bridge-only, for the same reason.
        if (frame.type !== "workspace.step" && principal.kind !== "bridge") {
          return this.sendError(state, "bridge_required", frame.type === "workspace.turn" ? "Only an authenticated Bridge may publish workspace turn state." : frame.type === "workspace.queued" ? "Only an authenticated Bridge may publish a queued-prompt notice." : "Only an authenticated Bridge may publish a message checklist.", frame);
        }
        const targetRoom = roomId(frame);
        if (!targetRoom) return this.sendError(state, "room_required", `channelId is required for a ${frame.type === "workspace.turn" ? "workspace turn state" : frame.type === "workspace.todos" ? "message checklist" : frame.type === "workspace.queued" ? "queued-prompt notice" : "workspace step"}.`, frame);
        const payload = frame.payload && typeof frame.payload === "object" ? frame.payload as Record<string, unknown> : {};
        this.subscriptions.publish(frame.workspaceId, targetRoom, this.serverFrame(frame, frame.type, payload));
        return;
      }
      case "pty.open":
        await this.handlePtyOpen(state, frame);
        return;
      case "pty.output":
        await this.handlePtyOutput(state, frame);
        return;
      case "pty.input":
      case "pty.resize":
        await this.handlePtyToOwner(state, frame);
        return;
      case "pty.close":
        await this.handlePtyClose(state, frame);
        return;
      case "pty.share":
        await this.handlePtyShare(state, frame);
        return;
      case "pty.request":
        await this.handlePtyRequest(state, frame);
        return;
      case "pty.link":
        await this.handlePtyLink(state, frame);
        return;
      case "pty.unlink":
        await this.handlePtyUnlink(state, frame);
        return;
      case "fs.tree.request":
        await this.handleFsTreeRequest(state, frame);
        return;
      case "fs.read.request":
        await this.handleFsReadRequest(state, frame);
        return;
      case "fs.tree":
      case "fs.content.chunk":
      case "fs.error":
        await this.handleFsFromOwner(state, frame);
        return;
      case "huddle.join":
        await this.handleHuddleJoin(state, frame);
        return;
      case "huddle.leave":
        await this.handleHuddleLeave(state, frame);
        return;
      case "huddle.mute":
        await this.handleHuddleMute(state, frame);
        return;
      case "huddle.offer":
      case "huddle.answer":
      case "huddle.ice":
        await this.handleHuddleSignal(state, frame);
        return;
      case "message.post": {
        if (!this.options.postMessage || !frame.missionId) return this.sendError(state, "message_unavailable", "Message posting is not configured for this relay.", frame);
        const result = await this.options.postMessage({ principal, frame });
        this.subscriptions.publish(frame.workspaceId, frame.missionId, this.serverFrame(frame, "mission.event", result));
        return;
      }
      case "message.acknowledge":
        if (this.options.acknowledgeDelivery) await this.options.acknowledgeDelivery({ principal, frame });
        return;
      case "runtime.event": {
        if (principal.kind !== "bridge") return this.sendError(state, "bridge_required", "Only an authenticated Bridge may publish runtime events.", frame);
        if (!this.options.receiveRuntimeEvent) return this.sendError(state, "runtime_sink_unavailable", "Runtime events cannot be streamed until a normalized persistence sink is configured.", frame);
        const safePayload = await this.options.receiveRuntimeEvent({ principal, frame });
        if (safePayload === null) return this.sendError(state, "runtime_event_rejected", "Runtime event was rejected by the normalized persistence sink.", frame);
        const safeFrame = { ...frame, payload: safePayload };
        const valid = parseRelayFrame(safeFrame);
        if (!valid.ok) return this.sendError(state, "runtime_event_rejected", valid.error, frame);
        if (frame.missionId) this.subscriptions.publish(frame.workspaceId, frame.missionId, valid.frame);
        this.subscriptions.publishWorkspace(frame.workspaceId, this.serverFrame(frame, "workspace.event", { activity: safePayload && typeof safePayload === "object" ? (safePayload as Record<string, unknown>).activity ?? null : null }));
        return;
      }
      case "runtime.permission_response":
        if (this.options.receivePermissionResponse) await this.options.receivePermissionResponse({ principal, frame });
        return;
      case "bridge.heartbeat":
        if (principal.kind !== "bridge") return this.sendError(state, "bridge_required", "Only an authenticated Bridge may send heartbeats.", frame);
        if (this.options.receiveBridgeHeartbeat) await this.options.receiveBridgeHeartbeat({ principal, frame });
        return;
      case "cursor.resume":
        if (!frame.missionId) return this.sendError(state, "mission_required", "missionId is required to resume a cursor.", frame);
        await state.connection.send(this.serverFrame(frame, "mission.snapshot", { cursor: (frame.payload as { cursor?: string | null })?.cursor ?? null, snapshot: await this.options.loadMissionSnapshot({ principal, workspaceId: frame.workspaceId, missionId: frame.missionId, cursor: (frame.payload as { cursor?: string | null })?.cursor ?? null }) }));
        return;
      case "runtime.session_state":
      case "git.operation_result":
        if (frame.missionId) this.subscriptions.publish(frame.workspaceId, frame.missionId, frame);
        return;
      default:
        await this.sendError(state, "unsupported_frame", `Frame type '${frame.type}' is not accepted from a client.`, frame);
    }
  }

  private async handlePresence(state: ConnectionState, frame: RelayFrame): Promise<void> {
    const targetRoom = roomId(frame);
    if (!targetRoom) return this.sendError(state, "room_required", "missionId or channelId is required for presence.", frame);
    const payload = frame.payload && typeof frame.payload === "object" ? frame.payload as Record<string, unknown> : {};
    const participantId = typeof payload.participantId === "string" ? payload.participantId.trim() : "";
    const presenceState = payload.state;
    if (!participantId || participantId !== state.principal?.id) return this.sendError(state, "presence_identity_mismatch", "Presence must be published for the authenticated participant.", frame);
    if (presenceState !== "online" && presenceState !== "working" && presenceState !== "idle" && presenceState !== "offline") {
      return this.sendError(state, "presence_state_invalid", "Presence state is invalid.", frame);
    }
    const key = channelKey(frame.workspaceId, targetRoom);
    const channel = this.presence.get(key) ?? new Map<string, PresenceRecord>();
    const updatedAt = new Date().toISOString();
    if (presenceState === "offline") channel.delete(participantId);
    else channel.set(participantId, { participantId, state: presenceState, connectionId: state.connection.connectionId, updatedAt });
    if (channel.size > 0) this.presence.set(key, channel);
    else this.presence.delete(key);
    this.subscriptions.publish(frame.workspaceId, targetRoom, this.serverFrame(frame, "participant.presence", { participantId, state: presenceState, updatedAt }));
  }

  private async handleTyping(state: ConnectionState, frame: RelayFrame): Promise<void> {
    const targetRoom = roomId(frame);
    if (!targetRoom) return this.sendError(state, "room_required", "missionId or channelId is required for typing state.", frame);
    const payload = frame.payload && typeof frame.payload === "object" ? frame.payload as Record<string, unknown> : {};
    const participantId = typeof payload.participantId === "string" ? payload.participantId.trim() : "";
    const typing = payload.typing === true;
    // Item #21 Phase 5a: optional discriminator so a tag renders above a
    // terminal pane's own input row instead of the chat composer. Omitted =
    // today's behaviour (chat composer), so an older client degrades
    // cleanly rather than breaking.
    const sessionId = typeof payload.sessionId === "string" && payload.sessionId.length > 0 && payload.sessionId.length <= 128 ? payload.sessionId : undefined;
    if (!participantId || participantId !== state.principal?.id) return this.sendError(state, "typing_identity_mismatch", "Typing state must be published for the authenticated participant.", frame);
    const key = channelKey(frame.workspaceId, targetRoom);
    const channel = this.typing.get(key) ?? new Map<string, TypingRecord>();
    const expiresAt = Date.now() + 2_500;
    if (typing) channel.set(participantId, { participantId, connectionId: state.connection.connectionId, expiresAt, ...(sessionId ? { sessionId } : {}) });
    else channel.delete(participantId);
    if (channel.size > 0) this.typing.set(key, channel);
    else this.typing.delete(key);
    this.subscriptions.publish(frame.workspaceId, targetRoom, this.serverFrame(frame, "participant.typing", { participantId, typing, expiresAt, ...(sessionId ? { sessionId } : {}) }));
  }

  /**
   * Item #21 Phase 5b: live cursor overlays on a shared terminal pane. Pure
   * fan-out -- no map entry survives this call, so there is nothing to
   * replay to a late joiner (matches the spec's explicit "a cursor position
   * from 4 seconds ago is not meaningful state" call) and the relay's per-
   * room memory for this feature stays flat regardless of how long a room
   * runs.
   *
   * The named risk this exists to cover: cursor movement is naturally a
   * 60+ Hz event, sent over the same socket carrying PTY bytes, chat, and
   * step events. `cursorRateLimiter` enforces the mandatory server-side cap
   * -- a buggy or hostile client cannot flood a room just because a
   * well-behaved one throttles itself client-side. Frames over the limit
   * are dropped silently (this is cosmetic presence, not something worth
   * erroring a session over).
   */
  private handlePresenceCursor(state: ConnectionState, frame: RelayFrame): void {
    const targetRoom = roomId(frame);
    if (!targetRoom) return;
    const payload = frame.payload && typeof frame.payload === "object" ? frame.payload as Record<string, unknown> : {};
    const participantId = typeof payload.participantId === "string" ? payload.participantId.trim() : "";
    if (!participantId || participantId !== state.principal?.id) return;
    const sessionId = payload.sessionId;
    if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 128) return;
    const x = payload.x;
    const y = payload.y;
    if (typeof x !== "number" || typeof y !== "number" || x < 0 || x > 1 || y < 0 || y > 1) return;

    if (!this.cursorRateLimiter.allow(state.connection.connectionId)) return;

    this.subscriptions.publish(frame.workspaceId, targetRoom, this.serverFrame(frame, "presence.cursor", { participantId, sessionId, x, y }));
  }

  private async handleWebPresence(state: ConnectionState, frame: RelayFrame): Promise<void> {
    const targetRoom = roomId(frame);
    if (!targetRoom) return this.sendError(state, "room_required", "missionId or channelId is required for web presence.", frame);
    const payload = frame.payload && typeof frame.payload === "object" && !Array.isArray(frame.payload)
      ? frame.payload as Record<string, unknown>
      : {};
    const agent = typeof payload.agent === "string" ? payload.agent.trim() : "";
    const provider = typeof payload.provider === "string" ? payload.provider.trim() : "";
    const rawUrl = typeof payload.url === "string" ? payload.url : "";
    const action = payload.action;
    const seq = payload.seq;
    const rawTarget = payload.target;
    if (!agent || agent.length > 80 || !provider || provider.length > 80 || !Number.isSafeInteger(seq) || (seq as number) < 0 ||
        (action !== "open" && action !== "read" && action !== "click" && action !== "type") ||
        typeof rawTarget !== "object" || rawTarget === null || Array.isArray(rawTarget)) {
      return this.sendError(state, "web_presence_invalid", "Web presence fields are invalid.", frame);
    }

    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return this.sendError(state, "web_presence_invalid", "Web presence URL must be an absolute HTTP or HTTPS URL.", frame);
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || rawUrl.length > 2_048) {
      return this.sendError(state, "web_presence_invalid", "Web presence URL must be a safe HTTP or HTTPS URL.", frame);
    }

    const targetRecord = rawTarget as Record<string, unknown>;
    let target: WebPresencePayload["target"];
    if (typeof targetRecord.selector === "string" && targetRecord.selector.trim().length > 0 && targetRecord.selector.length <= 500 &&
        Object.keys(targetRecord).length === 1) {
      target = { selector: targetRecord.selector };
    } else if (typeof targetRecord.x === "number" && typeof targetRecord.y === "number" &&
        Number.isFinite(targetRecord.x) && Number.isFinite(targetRecord.y) && targetRecord.x >= 0 && targetRecord.x <= 1 &&
        targetRecord.y >= 0 && targetRecord.y <= 1 && Object.keys(targetRecord).length === 2) {
      target = { x: targetRecord.x, y: targetRecord.y };
    } else {
      return this.sendError(state, "web_presence_invalid", "Web presence target must be a selector or normalized x/y coordinates.", frame);
    }

    if (!this.cursorRateLimiter.allow(state.connection.connectionId)) return;
    // Query strings and fragments often contain search terms, invite tokens, or session identifiers.
    // Presence needs the visible site/path, not those incidental secrets.
    url.search = "";
    url.hash = "";
    const safePayload: WebPresencePayload = {
      agent,
      provider,
      url: url.toString(),
      target,
      action: action as WebPresenceAction,
      seq: seq as number,
    };
    this.subscriptions.publish(frame.workspaceId, targetRoom, this.serverFrame(frame, "web.presence", safePayload));
  }

  private async huddleIdentity(state: ConnectionState, frame: RelayFrame): Promise<{ huddleId: string; participantId: string } | null> {
    if (!frame.missionId) {
      await this.sendError(state, "mission_required", "missionId is required for huddle state.", frame);
      return null;
    }
    if (!state.subscriptions.has(channelKey(frame.workspaceId, frame.missionId))) {
      await this.sendError(state, "mission_subscription_required", "Subscribe to the mission before using its huddle.", frame);
      return null;
    }
    const payload = recordPayload(frame.payload);
    if (!payload) {
      await this.sendError(state, "huddle_signal_invalid", "Only WebRTC offer, answer, or ICE signaling metadata may be relayed.", frame);
      return null;
    }
    const huddleId = payload?.huddleId;
    const participantId = payload?.participantId;
    if (!isBoundedIdentifier(huddleId, 128) || !isBoundedIdentifier(participantId) || participantId !== state.principal?.id) {
      await this.sendError(state, "huddle_identity_mismatch", "Huddle participant must match the authenticated participant.", frame);
      return null;
    }
    return { huddleId, participantId };
  }

  private async handleHuddleJoin(state: ConnectionState, frame: RelayFrame): Promise<void> {
    const identity = await this.huddleIdentity(state, frame);
    if (!identity || !frame.missionId) return;
    const key = huddleKey(frame.workspaceId, frame.missionId, identity.huddleId);
    const members = this.huddles.get(key) ?? new Map<string, HuddleMember>();
    const existing = members.get(identity.participantId);
    const member = existing ?? { participantId: identity.participantId, connectionId: state.connection.connectionId, muted: false };
    member.connectionId = state.connection.connectionId;
    members.set(identity.participantId, member);
    this.huddles.set(key, members);
    for (const current of members.values()) {
      if (current.participantId !== identity.participantId) {
        this.sendHuddleFrame(state.connection.connectionId, this.serverFrame(frame, "huddle.join", { huddleId: identity.huddleId, participantId: current.participantId, muted: current.muted }));
      }
    }
    this.broadcastHuddle(frame.workspaceId, frame.missionId, identity.huddleId, this.serverFrame(frame, "huddle.join", { huddleId: identity.huddleId, participantId: identity.participantId, muted: member.muted }));
  }

  private async handleHuddleLeave(state: ConnectionState, frame: RelayFrame): Promise<void> {
    const identity = await this.huddleIdentity(state, frame);
    if (!identity || !frame.missionId) return;
    const key = huddleKey(frame.workspaceId, frame.missionId, identity.huddleId);
    const members = this.huddles.get(key);
    const member = members?.get(identity.participantId);
    if (!member || member.connectionId !== state.connection.connectionId) {
      await this.sendError(state, "huddle_membership_required", "Join the huddle before leaving it.", frame);
      return;
    }
    members!.delete(identity.participantId);
    if (members!.size === 0) this.huddles.delete(key);
    this.broadcastHuddle(frame.workspaceId, frame.missionId, identity.huddleId, this.serverFrame(frame, "huddle.leave", { huddleId: identity.huddleId, participantId: identity.participantId }));
  }

  private async handleHuddleMute(state: ConnectionState, frame: RelayFrame): Promise<void> {
    const identity = await this.huddleIdentity(state, frame);
    if (!identity || !frame.missionId) return;
    const payload = recordPayload(frame.payload);
    if (typeof payload?.muted !== "boolean") {
      await this.sendError(state, "huddle_mute_invalid", "Huddle mute state must be boolean.", frame);
      return;
    }
    const member = this.huddles.get(huddleKey(frame.workspaceId, frame.missionId, identity.huddleId))?.get(identity.participantId);
    if (!member || member.connectionId !== state.connection.connectionId) {
      await this.sendError(state, "huddle_membership_required", "Join the huddle before changing mute state.", frame);
      return;
    }
    member.muted = payload.muted;
    this.broadcastHuddle(frame.workspaceId, frame.missionId, identity.huddleId, this.serverFrame(frame, "huddle.mute", { huddleId: identity.huddleId, participantId: identity.participantId, muted: member.muted }));
  }

  private async handleHuddleSignal(state: ConnectionState, frame: RelayFrame): Promise<void> {
    const identity = await this.huddleIdentity(state, frame);
    if (!identity || !frame.missionId) return;
    const payload = recordPayload(frame.payload);
    if (!payload) {
      await this.sendError(state, "huddle_signal_invalid", "Only WebRTC offer, answer, or ICE signaling metadata may be relayed.", frame);
      return;
    }
    const targetParticipantId = payload?.targetParticipantId;
    if (!isBoundedIdentifier(targetParticipantId)) {
      await this.sendError(state, "huddle_signal_invalid", "Only WebRTC offer, answer, or ICE signaling metadata may be relayed.", frame);
      return;
    }
    const safePayload = this.sanitizeHuddleSignal(frame.type, payload, identity.huddleId, identity.participantId, targetParticipantId);
    if (!safePayload) {
      await this.sendError(state, "huddle_signal_invalid", "Only WebRTC offer, answer, or ICE signaling metadata may be relayed.", frame);
      return;
    }
    const members = this.huddles.get(huddleKey(frame.workspaceId, frame.missionId, identity.huddleId));
    const member = members?.get(identity.participantId);
    const target = typeof targetParticipantId === "string" ? members?.get(targetParticipantId) : undefined;
    if (!member || member.connectionId !== state.connection.connectionId) {
      await this.sendError(state, "huddle_membership_required", "Join the huddle before sending signaling.", frame);
      return;
    }
    if (targetParticipantId === identity.participantId || !target) {
      await this.sendError(state, "huddle_target_not_found", "The signaling target is not a member of this huddle.", frame);
      return;
    }
    this.sendHuddleFrame(target.connectionId, this.serverFrame(frame, frame.type, safePayload));
  }

  private sanitizeHuddleSignal(type: string, payload: Record<string, unknown>, huddleId: string, participantId: string, targetParticipantId: string): MissionHuddleOfferPayload | MissionHuddleAnswerPayload | MissionHuddleIcePayload | null {
    const allowed = type === "huddle.ice"
      ? new Set(["huddleId", "participantId", "targetParticipantId", "candidate"])
      : new Set(["huddleId", "participantId", "targetParticipantId", "description"]);
    if (Object.keys(payload).some((key) => !allowed.has(key))) return null;
    if (type === "huddle.offer" || type === "huddle.answer") {
      const description = recordPayload(payload.description);
      const expectedType = type === "huddle.offer" ? "offer" : "answer";
      if (!description || description.type !== expectedType || !isBoundedIdentifier(description.sdp, 16_000)) return null;
      return { huddleId, participantId, targetParticipantId, description: { type: expectedType, sdp: description.sdp } } as MissionHuddleOfferPayload | MissionHuddleAnswerPayload;
    }
    const candidate = recordPayload(payload.candidate);
    if (!candidate || !isBoundedIdentifier(candidate.candidate, 4_096)) return null;
    if (candidate.sdpMid !== undefined && candidate.sdpMid !== null && !isBoundedIdentifier(candidate.sdpMid, 256)) return null;
    const sdpMLineIndex = candidate.sdpMLineIndex;
    if (sdpMLineIndex !== undefined && sdpMLineIndex !== null && (typeof sdpMLineIndex !== "number" || !Number.isInteger(sdpMLineIndex) || sdpMLineIndex < 0)) return null;
    if (candidate.usernameFragment !== undefined && candidate.usernameFragment !== null && !isBoundedIdentifier(candidate.usernameFragment, 256)) return null;
    return {
      huddleId,
      participantId,
      targetParticipantId,
      candidate: {
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid === undefined ? undefined : candidate.sdpMid,
        sdpMLineIndex: sdpMLineIndex === undefined || sdpMLineIndex === null ? sdpMLineIndex : Number(sdpMLineIndex),
        usernameFragment: candidate.usernameFragment === undefined ? undefined : candidate.usernameFragment,
      },
    };
  }

  private sendHuddleFrame(connectionId: string, frame: RelayFrame): void {
    const state = this.connections.get(connectionId);
    if (!state) return;
    void Promise.resolve(state.connection.send(frame)).catch(() => {});
  }

  private broadcastHuddle(workspaceId: string, missionId: string, huddleId: string, frame: RelayFrame): void {
    const members = this.huddles.get(huddleKey(workspaceId, missionId, huddleId));
    if (!members) return;
    for (const member of members.values()) this.sendHuddleFrame(member.connectionId, frame);
  }

  private clearHuddleState(connectionId: string, workspaceId: string, missionId: string): void {
    const prefix = `${workspaceId}\u0000${missionId}\u0000`;
    for (const [key, members] of this.huddles) {
      if (!key.startsWith(prefix)) continue;
      const huddleId = key.slice(prefix.length);
      const removed = [...members.values()].filter((member) => member.connectionId === connectionId);
      for (const member of removed) members.delete(member.participantId);
      if (members.size === 0) this.huddles.delete(key);
      for (const member of removed) {
        this.broadcastHuddle(workspaceId, missionId, huddleId, {
          version: MISSION_RELAY_FRAME_VERSION,
          frameId: `huddle-disconnect-${member.participantId}-${Date.now()}`,
          type: "huddle.leave",
          workspaceId,
          missionId,
          correlationId: `huddle-disconnect-${member.participantId}`,
          causationId: null,
          idempotencyKey: null,
          sentAt: new Date().toISOString(),
          payload: { huddleId, participantId: member.participantId },
        });
      }
    }
  }

  private sendToConnection(connectionId: string, frame: RelayFrame): void {
    const state = this.connections.get(connectionId);
    if (!state) return;
    void Promise.resolve(state.connection.send(frame)).catch(() => {});
  }

  /**
   * Being a workspace member is not enough to reach into someone's shell --
   * the sender has to actually be subscribed to the room the pane lives in.
   */
  private async ptyRoom(state: ConnectionState, frame: RelayFrame): Promise<string | null> {
    const room = roomId(frame);
    if (!room) {
      await this.sendError(state, "room_required", "channelId or missionId is required for a terminal frame.", frame);
      return null;
    }
    if (!state.subscriptions.has(channelKey(frame.workspaceId, room))) {
      await this.sendError(state, "pty_subscription_required", "Subscribe to the room before using its terminal.", frame);
      return null;
    }
    return room;
  }

  /**
   * Item #28's Part A: a human's own browser cannot open a pty directly
   * (handlePtyOpen below requires a "bridge" principal -- only a real host
   * process may claim to run a shell), so this is the request half of that
   * gap. Broadcast-and-self-filter rather than the relay picking one
   * specific target connection: the relay has no durable concept of "this
   * human's one machine-owner process" to address directly, but every
   * bridge-kind connection subscribed to this room already receives this,
   * and the owner-pty-runtime (the one that should actually act) checks the
   * included requestedByUserId against its own already-resolved owner
   * identity before doing anything. Every other bridge ignores it silently.
   */
  private async handlePtyRequest(state: ConnectionState, frame: RelayFrame): Promise<void> {
    if (state.principal?.kind !== "human") {
      return this.sendError(state, "human_required", "Only a signed-in person may request a terminal.", frame);
    }
    const room = await this.ptyRoom(state, frame);
    if (!room) return;
    this.subscriptions.publish(frame.workspaceId, room, this.serverFrame(frame, "pty.requested", { requestedByUserId: state.principal.id }));
  }

  /** Sessions carry their own workspaceId/channelId (see PtySessionRecord), so
   * a link target can be found by sessionId alone even when it lives in a
   * different room than the request's own. */
  private findPtySessionById(workspaceId: string, sessionId: string): PtySessionRecord | null {
    for (const record of this.ptySessions.values()) {
      if (record.workspaceId === workspaceId && record.sessionId === sessionId) return record;
    }
    return null;
  }

  /**
   * Item #28 Part B: the real reference drag never asked the target pane's
   * owner for consent -- dropping the dragger's own link handle onto a
   * teammate's pane just linked the two Rooms immediately -- so this only
   * requires the dragger to own the FROM session. The dragger does still
   * need to actually be subscribed to the target's room (ptyRoom's normal
   * "you can only touch rooms you're in" rule), same as every other pty
   * frame that names a room to act in.
   */
  private async handlePtyLink(state: ConnectionState, frame: RelayFrame): Promise<void> {
    const room = await this.ptyRoom(state, frame);
    if (!room) return;
    const payload = parsePtyLinkPayload(frame.payload);
    if (!payload) return this.sendError(state, "pty_link_invalid", "Terminal link frame is invalid.", frame);
    const own = this.ptySessions.get(ptyKey(frame.workspaceId, room, payload.sessionId));
    if (!own || own.status !== "running") return this.sendError(state, "pty_session_not_found", "No live terminal session for that id.", frame);
    if (!(await this.isPtyOwnerRequest(state, own))) {
      return this.sendError(state, "pty_not_owner", "Only this terminal's owner may link it to another session.", frame);
    }
    const target = this.findPtySessionById(frame.workspaceId, payload.targetSessionId);
    if (!target || target.status !== "running") return this.sendError(state, "pty_session_not_found", "No live terminal session for that id.", frame);
    if (!state.subscriptions.has(channelKey(frame.workspaceId, target.channelId))) {
      return this.sendError(state, "pty_subscription_required", "Subscribe to the target room before linking a terminal into it.", frame);
    }
    own.linkedSessionIds.add(target.sessionId);
    target.linkedSessionIds.add(own.sessionId);
    this.subscriptions.publish(frame.workspaceId, own.channelId, this.serverFrame(frame, "pty.state", this.ptyStatePayload(own)));
    this.subscriptions.publish(frame.workspaceId, target.channelId, this.serverFrame(frame, "pty.state", this.ptyStatePayload(target)));
  }

  /** Either linked session's owner may break the link -- not only whoever dragged it. */
  private async handlePtyUnlink(state: ConnectionState, frame: RelayFrame): Promise<void> {
    const room = await this.ptyRoom(state, frame);
    if (!room) return;
    const payload = parsePtyLinkPayload(frame.payload);
    if (!payload) return this.sendError(state, "pty_link_invalid", "Terminal link frame is invalid.", frame);
    const own = this.ptySessions.get(ptyKey(frame.workspaceId, room, payload.sessionId));
    if (!own) return this.sendError(state, "pty_session_not_found", "No live terminal session for that id.", frame);
    if (!(await this.isPtyOwnerRequest(state, own))) {
      return this.sendError(state, "pty_not_owner", "Only this terminal's owner may unlink it.", frame);
    }
    const target = this.findPtySessionById(frame.workspaceId, payload.targetSessionId);
    own.linkedSessionIds.delete(payload.targetSessionId);
    target?.linkedSessionIds.delete(own.sessionId);
    this.subscriptions.publish(frame.workspaceId, own.channelId, this.serverFrame(frame, "pty.state", this.ptyStatePayload(own)));
    if (target) this.subscriptions.publish(frame.workspaceId, target.channelId, this.serverFrame(frame, "pty.state", this.ptyStatePayload(target)));
  }

  /**
   * Item #9 Phase 1a -- a viewer's browser asks the room's resident for a
   * directory listing. Same shape as terminal requests: a human-only
   * request, targeted by connectionId, broadcast to the room rather than
   * delivered point-to-point (no in-memory fs session registry, matching
   * codex's own explicit "not needed yet" call for its Phase 1).
   */
  private async handleFsTreeRequest(state: ConnectionState, frame: RelayFrame): Promise<void> {
    if (state.principal?.kind !== "human") {
      return this.sendError(state, "human_required", "Only a signed-in person may browse files.", frame);
    }
    const room = await this.ptyRoom(state, frame);
    if (!room) return;
    const payload = parseFsTreeRequestPayload(frame.payload);
    if (!payload) return this.sendError(state, "fs_tree_request_invalid", "File tree request is invalid.", frame);
    this.subscriptions.publish(frame.workspaceId, room, this.serverFrame(frame, "fs.tree.request", payload));
  }

  /** Same shape as handleFsTreeRequest, for reading one file's content. */
  private async handleFsReadRequest(state: ConnectionState, frame: RelayFrame): Promise<void> {
    if (state.principal?.kind !== "human") {
      return this.sendError(state, "human_required", "Only a signed-in person may read a file.", frame);
    }
    const room = await this.ptyRoom(state, frame);
    if (!room) return;
    const payload = parseFsReadRequestPayload(frame.payload);
    if (!payload) return this.sendError(state, "fs_read_request_invalid", "File read request is invalid.", frame);
    this.subscriptions.publish(frame.workspaceId, room, this.serverFrame(frame, "fs.read.request", payload));
  }

  /**
   * The resident's own tree/content/error responses -- only an authenticated
   * bridge may claim to speak for real disk access on someone's machine,
   * same rule handlePtyOpen already enforces.
   */
  private async handleFsFromOwner(state: ConnectionState, frame: RelayFrame): Promise<void> {
    if (state.principal?.kind !== "bridge") {
      return this.sendError(state, "bridge_required", "Only an authenticated Bridge may publish file data.", frame);
    }
    const room = await this.ptyRoom(state, frame);
    if (!room) return;
    this.subscriptions.publish(frame.workspaceId, room, this.serverFrame(frame, frame.type, frame.payload));
  }

  /** Drops a closed/disconnected session out of every peer it was linked to,
   * so a stale link chip never lingers on a Room whose other half is gone. */
  private unlinkFromPeers(record: PtySessionRecord): void {
    for (const peerId of record.linkedSessionIds) {
      const peer = this.findPtySessionById(record.workspaceId, peerId);
      if (!peer) continue;
      peer.linkedSessionIds.delete(record.sessionId);
      this.subscriptions.publish(peer.workspaceId, peer.channelId, this.serverFrame(
        { version: MISSION_RELAY_FRAME_VERSION, frameId: `pty-unlink-${record.sessionId}-${Date.now()}`, type: "pty.state", workspaceId: peer.workspaceId, missionId: undefined, channelId: peer.channelId, correlationId: `pty-unlink-${record.sessionId}`, causationId: null, idempotencyKey: null, sentAt: new Date().toISOString(), payload: null },
        "pty.state",
        this.ptyStatePayload(peer),
      ));
    }
  }

  private async handlePtyOpen(state: ConnectionState, frame: RelayFrame): Promise<void> {
    // The PTY is a real process on the host's machine; only that host's
    // authenticated Bridge may claim to own one.
    if (state.principal?.kind !== "bridge") {
      return this.sendError(state, "bridge_required", "Only an authenticated Bridge may host a terminal session.", frame);
    }
    const room = await this.ptyRoom(state, frame);
    if (!room) return;
    const payload = parsePtyOpenPayload(frame.payload);
    if (!payload) return this.sendError(state, "pty_open_invalid", "Terminal session metadata is invalid.", frame);
    const key = ptyKey(frame.workspaceId, room, payload.sessionId);
    const existing = this.ptySessions.get(key);
    if (existing && existing.ownerConnectionId !== state.connection.connectionId && existing.status === "running") {
      return this.sendError(state, "pty_session_taken", "Another host already owns this terminal session.", frame);
    }
    const record: PtySessionRecord = {
      sessionId: payload.sessionId,
      workspaceId: frame.workspaceId,
      channelId: room,
      ownerConnectionId: state.connection.connectionId,
      ownerParticipantId: state.principal.id,
      cols: payload.cols,
      rows: payload.rows,
      status: "running",
      // A re-opened session starts a fresh screen rather than replaying a
      // dead process's output underneath a live one.
      scrollback: new Uint8Array(0),
      lastSeq: -1,
      shared: true,
      linkedSessionIds: existing?.linkedSessionIds ?? new Set(),
      ...(payload.title === undefined ? {} : { title: payload.title }),
    };
    this.ptySessions.set(key, record);
    this.subscriptions.publish(frame.workspaceId, room, this.serverFrame(frame, "pty.state", this.ptyStatePayload(record)));
  }

  private async handlePtyOutput(state: ConnectionState, frame: RelayFrame): Promise<void> {
    if (state.principal?.kind !== "bridge") {
      return this.sendError(state, "bridge_required", "Only an authenticated Bridge may publish terminal output.", frame);
    }
    const room = await this.ptyRoom(state, frame);
    if (!room) return;
    const payload = parsePtyOutputPayload(frame.payload);
    if (!payload) return this.sendError(state, "pty_output_invalid", "Terminal output frame is invalid.", frame);
    const record = this.ptySessions.get(ptyKey(frame.workspaceId, room, payload.sessionId));
    if (!record || record.status !== "running") {
      return this.sendError(state, "pty_session_not_found", "No live terminal session for that id.", frame);
    }
    if (record.ownerConnectionId !== state.connection.connectionId) {
      return this.sendError(state, "pty_not_owner", "Only the hosting Bridge may publish this terminal's output.", frame);
    }
    record.scrollback = appendScrollback(record.scrollback, decodePtyBytes(payload.data));
    record.lastSeq = payload.seq;
    this.subscriptions.publish(frame.workspaceId, room, this.serverFrame(frame, "pty.output", payload));
  }

  /**
   * True for the connection that literally hosts the pty (the bridge's own
   * socket), OR for the human viewer whose own account owns that agent
   * connection (agent_connections.created_by) -- a human's browser is never
   * the same live socket as the bridge process, so socket identity alone
   * would make "the owner" mean only the bridge, unreachable by any person.
   *
   * Resolved via ownerParticipantId (the authenticated bridge principal's
   * real, stable identity -- agent_connections.id), never ownerConnectionId
   * (a transient `ws-<uuid>` assigned per socket at connect time, unrelated
   * to any database row -- passing that to a lookup can never match).
   */
  private async isPtyOwnerRequest(state: ConnectionState, record: PtySessionRecord): Promise<boolean> {
    if (record.ownerConnectionId === state.connection.connectionId) return true;
    if (state.principal?.kind !== "human" || !this.options.resolvePtyOwnerHuman) return false;
    const ownerUserId = await this.options.resolvePtyOwnerHuman(record.ownerParticipantId);
    return ownerUserId !== null && ownerUserId === state.principal.id;
  }

  /**
   * Input and resize travel to exactly one place: the connection hosting that
   * PTY. Fanning either out to the room would let every viewer's terminal
   * echo keystrokes it never received from the real process.
   */
  private async handlePtyToOwner(state: ConnectionState, frame: RelayFrame): Promise<void> {
    const room = await this.ptyRoom(state, frame);
    if (!room) return;
    const parsed = frame.type === "pty.input" ? parsePtyInputPayload(frame.payload) : parsePtyResizePayload(frame.payload);
    if (!parsed) {
      return this.sendError(state, frame.type === "pty.input" ? "pty_input_invalid" : "pty_resize_invalid", "Terminal frame is invalid.", frame);
    }
    const record = this.ptySessions.get(ptyKey(frame.workspaceId, room, parsed.sessionId));
    if (!record || record.status !== "running") {
      return this.sendError(state, "pty_session_not_found", "No live terminal session for that id.", frame);
    }
    const isOwner = await this.isPtyOwnerRequest(state, record);
    // The Sharing toggle only gates typing -- a viewer can still watch a
    // pane the owner has switched to private/solo, per the locked decision
    // (default on, owner opts out; never read-only-by-default for everyone).
    if (frame.type === "pty.input" && !record.shared && !isOwner) {
      return this.sendError(state, "pty_not_shared", "The owner has turned sharing off for this terminal.", frame);
    }
    if (frame.type === "pty.resize") {
      const resize = parsed as { cols: number; rows: number };
      record.cols = resize.cols;
      record.rows = resize.rows;
    }
    // participantId comes from the authenticated principal, never from the
    // sender's payload -- attribution the sender could forge is worthless.
    const payload = { ...parsed, participantId: state.principal!.id };
    this.sendToConnection(record.ownerConnectionId, this.serverFrame(frame, frame.type, payload));
  }

  private async handlePtyShare(state: ConnectionState, frame: RelayFrame): Promise<void> {
    const room = await this.ptyRoom(state, frame);
    if (!room) return;
    const payload = parsePtySharePayload(frame.payload);
    if (!payload) return this.sendError(state, "pty_share_invalid", "Terminal sharing frame is invalid.", frame);
    const record = this.ptySessions.get(ptyKey(frame.workspaceId, room, payload.sessionId));
    if (!record || record.status !== "running") {
      return this.sendError(state, "pty_session_not_found", "No live terminal session for that id.", frame);
    }
    if (!(await this.isPtyOwnerRequest(state, record))) {
      return this.sendError(state, "pty_not_owner", "Only this terminal's owner may change its sharing state.", frame);
    }
    record.shared = payload.shared;
    this.subscriptions.publish(frame.workspaceId, room, this.serverFrame(frame, "pty.state", this.ptyStatePayload(record)));
  }

  private async handlePtyClose(state: ConnectionState, frame: RelayFrame): Promise<void> {
    const room = await this.ptyRoom(state, frame);
    if (!room) return;
    const payload = parsePtyClosePayload(frame.payload);
    if (!payload) return this.sendError(state, "pty_close_invalid", "Terminal close frame is invalid.", frame);
    const key = ptyKey(frame.workspaceId, room, payload.sessionId);
    const record = this.ptySessions.get(key);
    if (!record) return this.sendError(state, "pty_session_not_found", "No terminal session for that id.", frame);
    if (record.ownerConnectionId === state.connection.connectionId) {
      // The host is reporting the process actually ended.
      record.status = "exited";
      this.ptySessions.delete(key);
      this.unlinkFromPeers(record);
      this.subscriptions.publish(frame.workspaceId, room, this.serverFrame(frame, "pty.state", { ...this.ptyStatePayload(record), ...(payload.reason === undefined ? {} : { reason: payload.reason }) }));
      return;
    }
    // A viewer asking to end it is a request; the host still owns the process.
    this.sendToConnection(record.ownerConnectionId, this.serverFrame(frame, "pty.state", { ...this.ptyStatePayload(record), reason: "close_requested" }));
  }

  private ptyStatePayload(record: PtySessionRecord): Record<string, unknown> {
    return {
      sessionId: record.sessionId,
      status: record.status,
      ownerParticipantId: record.ownerParticipantId,
      shared: record.shared,
      cols: record.cols,
      rows: record.rows,
      ...(record.title === undefined ? {} : { title: record.title }),
      linkedSessionIds: [...record.linkedSessionIds],
    };
  }

  /**
   * A viewer joining (or refreshing) mid-session gets the pane's recent output
   * replayed, so it paints immediately instead of sitting blank until the next
   * keystroke produces output.
   */
  private async replayPtySessions(state: ConnectionState, source: RelayFrame, room: string): Promise<void> {
    for (const [key, record] of this.ptySessions) {
      if (key !== ptyKey(source.workspaceId, room, record.sessionId)) continue;
      await state.connection.send(this.serverFrame(source, "pty.state", this.ptyStatePayload(record)));
      const chunks = chunkPtyBytes(record.scrollback);
      for (let index = 0; index < chunks.length; index += 1) {
        await state.connection.send(this.serverFrame(source, "pty.output", { sessionId: record.sessionId, seq: record.lastSeq - chunks.length + 1 + index, data: chunks[index] }));
      }
    }
  }

  private clearPtyState(connectionId: string, workspaceId: string, room: string): void {
    for (const [key, record] of this.ptySessions) {
      if (record.ownerConnectionId !== connectionId) continue;
      if (key !== ptyKey(workspaceId, room, record.sessionId)) continue;
      this.ptySessions.delete(key);
      this.unlinkFromPeers(record);
      // The host is gone, so the pane is dead -- say so rather than leaving
      // viewers staring at a terminal that will never respond again.
      this.subscriptions.publish(workspaceId, room, {
        version: MISSION_RELAY_FRAME_VERSION,
        frameId: `pty-host-gone-${record.sessionId}-${Date.now()}`.slice(0, 128),
        type: "pty.state",
        workspaceId,
        channelId: room,
        correlationId: `pty-host-gone-${record.sessionId}`.slice(0, 256),
        causationId: null,
        idempotencyKey: null,
        sentAt: new Date().toISOString(),
        payload: { ...this.ptyStatePayload(record), status: "exited", reason: "host_disconnected" },
      });
    }
  }

  private async sendEphemeralSnapshot(state: ConnectionState, source: RelayFrame): Promise<void> {
    if (!source.missionId) return;
    const key = channelKey(source.workspaceId, source.missionId);
    const presence = this.presence.get(key);
    if (presence) {
      for (const record of presence.values()) await state.connection.send(this.serverFrame(source, "participant.presence", { participantId: record.participantId, state: record.state, updatedAt: record.updatedAt }));
    }
    const typing = this.typing.get(key);
    if (typing) {
      const now = Date.now();
      for (const record of typing.values()) {
        if (record.expiresAt <= now) typing.delete(record.participantId);
        else await state.connection.send(this.serverFrame(source, "participant.typing", { participantId: record.participantId, typing: true, expiresAt: record.expiresAt, ...(record.sessionId ? { sessionId: record.sessionId } : {}) }));
      }
      if (typing.size === 0) this.typing.delete(key);
    }
    await this.replayPtySessions(state, source, source.missionId);
  }

  private clearEphemeralState(connectionId: string, workspaceId: string, missionId: string): void {
    const key = channelKey(workspaceId, missionId);
    const presence = this.presence.get(key);
    const removedPresence = presence ? [...presence.values()].filter((record) => record.connectionId === connectionId) : [];
    for (const record of removedPresence) presence?.delete(record.participantId);
    if (presence && presence.size === 0) this.presence.delete(key);
    const typing = this.typing.get(key);
    const removedTyping = typing ? [...typing.values()].filter((record) => record.connectionId === connectionId) : [];
    for (const record of removedTyping) typing?.delete(record.participantId);
    if (typing && typing.size === 0) this.typing.delete(key);
    for (const record of removedPresence) this.subscriptions.publish(workspaceId, missionId, {
      version: MISSION_RELAY_FRAME_VERSION,
      frameId: `presence-offline-${record.participantId}-${Date.now()}`,
      type: "participant.presence",
      workspaceId,
      missionId,
      correlationId: `presence-offline-${record.participantId}`,
      causationId: null,
      idempotencyKey: null,
      sentAt: new Date().toISOString(),
      payload: { participantId: record.participantId, state: "offline", updatedAt: new Date().toISOString() },
    });
    for (const record of removedTyping) this.subscriptions.publish(workspaceId, missionId, {
      version: MISSION_RELAY_FRAME_VERSION,
      frameId: `typing-stop-${record.participantId}-${Date.now()}`,
      type: "participant.typing",
      workspaceId,
      missionId,
      correlationId: `typing-stop-${record.participantId}`,
      causationId: null,
      idempotencyKey: null,
      sentAt: new Date().toISOString(),
      payload: { participantId: record.participantId, typing: false, expiresAt: Date.now() },
    });
  }

  private serverFrame(source: RelayFrame, type: string, payload: unknown): RelayFrame {
    return {
      version: MISSION_RELAY_FRAME_VERSION,
      frameId: `relay-${source.frameId}`,
      type,
      workspaceId: source.workspaceId,
      missionId: source.missionId,
      channelId: source.channelId,
      correlationId: source.correlationId,
      causationId: source.frameId,
      idempotencyKey: null,
      sentAt: new Date().toISOString(),
      payload,
    };
  }

  private async sendError(state: ConnectionState, code: string, message: string, source?: RelayFrame): Promise<void> {
    if (process.env.OATHLOCK_RELAY_DEBUG === "1") console.warn(`[relay.error] ${code} for ${source?.type ?? "unknown"}: ${message}`);
    await state.connection.send({
      version: MISSION_RELAY_FRAME_VERSION,
      frameId: `error-${source?.frameId ?? Date.now()}`,
      type: "relay.error",
      workspaceId: source?.workspaceId ?? "unknown",
      missionId: source?.missionId,
      channelId: source?.channelId,
      correlationId: source?.correlationId ?? `relay-error-${Date.now()}`,
      causationId: source?.frameId ?? null,
      idempotencyKey: null,
      sentAt: new Date().toISOString(),
      payload: { code, message },
    });
  }
}
