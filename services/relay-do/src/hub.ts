import { DurableObject } from "cloudflare:workers";
import { MissionRelayService } from "../../../src/lib/mission/mission-relay-service";
import type { RelayFrame, RelayServerFrameType } from "../../../src/lib/mission/mission-relay-protocol";
import type { Env } from "./env";
import { webRpcOptions } from "./rpc";
import { HEARTBEAT_FRAME_TYPE, LEASE_SWEEP_INTERVAL_MS, PRESENCE_LEASE_MS, anyHeartbeating, expiredHeartbeatingConnections } from "./lease";

/** Policy the container Relay never had. All are per workspace Hub. */
export const AUTH_DEADLINE_MS = 5_000;
export const SESSION_MAX_MS = 60 * 60 * 1000;
export const MAX_SOCKETS_PER_HUB = 2_000;
/** Raw text cap before JSON.parse; protocol frames are <=16 KiB, so this only stops abuse. */
export const MAX_RAW_MESSAGE_CHARS = 64 * 1024;
/** Runaway guard, deliberately far above real use (a coalescing bridge sends tens of frames/s). */
export const MAX_FRAMES_PER_SECOND = 5_000;

interface HubConnection {
  id: string;
  ws: WebSocket;
  authed: boolean;
  principalId: string | null;
  chain: Promise<void>;
  windowStartedAt: number;
  windowCount: number;
  authTimer: ReturnType<typeof setTimeout> | null;
  expiryTimer: ReturnType<typeof setTimeout> | null;
  /** Set once the socket has sent a bridge.heartbeat; from then on silence for a full lease closes it. */
  heartbeating: boolean;
  lastInboundAt: number;
}

function errorFrame(code: string, message: string): string {
  const now = new Date().toISOString();
  return JSON.stringify({
    version: "oathlock.relay.v1",
    frameId: `hub-error-${crypto.randomUUID()}`,
    type: "relay.error",
    workspaceId: "unknown",
    correlationId: `hub-${code}`,
    causationId: null,
    idempotencyKey: null,
    sentAt: now,
    payload: { code, message },
  });
}

/**
 * One Durable Object per workspace. It hosts the existing, tested `MissionRelayService` unchanged
 * (rooms, fan-out, presence, typing, terminals, huddles), with every database call redirected to the
 * web app. Sockets are standard (non-hibernating) WebSockets, so the service's in-memory state has
 * the same lifetime it had in the container: it lives while sockets are connected, and a restart makes
 * clients reconnect and resume from their cursors, exactly as before.
 */
export class WorkspaceHub extends DurableObject<Env> {
  private readonly service: MissionRelayService;
  private readonly connections = new Map<string, HubConnection>();
  private leaseSweeper: ReturnType<typeof setInterval> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.service = new MissionRelayService(webRpcOptions(env));
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket upgrade.", { status: 426 });
    if (this.connections.size >= MAX_SOCKETS_PER_HUB) return new Response("This workspace has too many open connections.", { status: 503 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    server.accept();
    this.attach(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  private attach(ws: WebSocket): void {
    const id = `ws-${crypto.randomUUID()}`;
    const conn: HubConnection = { id, ws, authed: false, principalId: null, chain: Promise.resolve(), windowStartedAt: Date.now(), windowCount: 0, authTimer: null, expiryTimer: null, heartbeating: false, lastInboundAt: Date.now() };
    this.connections.set(id, conn);

    this.service.connect({
      connectionId: id,
      send: (frame: RelayFrame) => {
        if (frame.type === "relay.ready") {
          conn.authed = true;
          const principalId = (frame.payload as { principalId?: unknown } | null)?.principalId;
          conn.principalId = typeof principalId === "string" ? principalId : null;
          if (conn.authTimer) { clearTimeout(conn.authTimer); conn.authTimer = null; }
        }
        try { ws.send(JSON.stringify(frame)); } catch { /* socket already closing; disconnect() runs from the close handler */ }
      },
    });

    conn.authTimer = setTimeout(() => {
      if (conn.authed) return;
      try { ws.send(errorFrame("auth_timeout", "No credential was received in time.")); } catch { /* closing */ }
      this.closeSocket(conn, 4001, "auth_timeout");
    }, AUTH_DEADLINE_MS);
    conn.expiryTimer = setTimeout(() => {
      try { ws.send(errorFrame("session_expired", "This relay session expired; reconnect with a fresh credential.")); } catch { /* closing */ }
      this.closeSocket(conn, 4002, "session_expired");
    }, SESSION_MAX_MS);

    ws.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer);
      if (raw.length > MAX_RAW_MESSAGE_CHARS) { this.closeSocket(conn, 1009, "message_too_large"); return; }
      const now = Date.now();
      if (now - conn.windowStartedAt >= 1_000) { conn.windowStartedAt = now; conn.windowCount = 0; }
      if (++conn.windowCount > MAX_FRAMES_PER_SECOND) { this.closeSocket(conn, 4008, "rate_limited"); return; }
      let parsed: unknown = null;
      try { parsed = JSON.parse(raw); } catch { /* the service answers invalid_frame */ }
      conn.lastInboundAt = now;
      if (conn.authed && (parsed as { type?: unknown } | null)?.type === HEARTBEAT_FRAME_TYPE) {
        conn.heartbeating = true;
        this.ensureLeaseSweeper();
      }
      // One frame at a time per socket: `subscribe` must finish before a following `post` is looked at.
      conn.chain = conn.chain
        .then(() => this.service.receive(id, parsed))
        .catch((error) => { console.error("relay frame handling failed", error instanceof Error ? error.message : error); });
    });
    ws.addEventListener("close", () => this.drop(id));
    ws.addEventListener("error", () => this.drop(id));
  }

  private closeSocket(conn: HubConnection, code: number, reason: string): void {
    try { conn.ws.close(code, reason); } catch { /* already closed */ }
    this.drop(conn.id);
  }

  /** One interval per Hub, running only while a heartbeating Bridge is connected, so an empty Hub holds no timer. */
  private ensureLeaseSweeper(): void {
    if (this.leaseSweeper) return;
    this.leaseSweeper = setInterval(() => {
      const now = Date.now();
      for (const conn of expiredHeartbeatingConnections(this.connections.values(), now, PRESENCE_LEASE_MS)) {
        try { conn.ws.send(errorFrame("presence_lease_expired", "No heartbeat within the presence lease; reconnect.")); } catch { /* closing */ }
        this.closeSocket(conn, 4009, "presence_lease_expired");
      }
      if (!anyHeartbeating(this.connections.values()) && this.leaseSweeper) {
        clearInterval(this.leaseSweeper);
        this.leaseSweeper = null;
      }
    }, LEASE_SWEEP_INTERVAL_MS);
  }

  private drop(id: string): void {
    const conn = this.connections.get(id);
    if (!conn) return;
    this.connections.delete(id);
    if (conn.authTimer) clearTimeout(conn.authTimer);
    if (conn.expiryTimer) clearTimeout(conn.expiryTimer);
    this.service.disconnect(id);
  }

  // ---- RPC surface used by the gateway (internal routes) ----

  /** Same contract as the container Relay's POST /internal/publish: true when the frame type is supported. */
  publish(input: { workspaceId: string; channelId: string; type: RelayServerFrameType; payload: unknown }): boolean {
    return this.service.publishServerFrame(input);
  }

  lookupPty(workspaceId: string, sessionId: string): { channelId: string; ownerConnectionId: string; status: string } | null {
    return this.service.lookupPtySessionRoom(workspaceId, sessionId);
  }

  /** Close every socket authenticated as this principal (agent disconnected, member removed, token revoked). */
  revoke(principalId: string): number {
    let closed = 0;
    for (const conn of [...this.connections.values()]) {
      if (conn.principalId !== principalId) continue;
      try { conn.ws.send(errorFrame("session_revoked", "This connection was revoked.")); } catch { /* closing */ }
      this.closeSocket(conn, 4003, "session_revoked");
      closed += 1;
    }
    return closed;
  }

  stats(): { sockets: number } {
    return { sockets: this.connections.size };
  }
}
