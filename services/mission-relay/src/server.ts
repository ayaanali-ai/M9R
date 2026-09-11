import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { MissionRelayService, type MissionRelayServiceOptions } from "../../../src/lib/mission/mission-relay-service";
import type { RelayServerFrameType } from "../../../src/lib/mission/mission-relay-protocol";

export interface MissionRelayServerOptions extends MissionRelayServiceOptions {
  port: number;
  host?: string;
  /** Item #21 Phase 6's resolved relay-ingest gap: shared secret authenticating the Next.js app's server-to-server calls to /internal/*. Reuses MISSION_RELAY_TOKEN_SECRET rather than provisioning a second secret -- both processes already have it, and it never leaves either server. */
  internalSecret?: string;
}

/** Constant-time bearer check -- same shape as the app's own authorizedStaticBearer, reimplemented here rather than imported since this process has no Next.js runtime to pull that helper's module graph from. */
function authorizedInternalBearer(request: IncomingMessage, secret: string | undefined): boolean {
  if (!secret) return false;
  const supplied = request.headers.authorization ?? "";
  const expectedDigest = createHash("sha256").update(`Bearer ${secret}`).digest();
  const suppliedDigest = createHash("sha256").update(supplied).digest();
  return expectedDigest.length === suppliedDigest.length && timingSafeEqual(expectedDigest, suppliedDigest);
}

async function readJsonBody(request: IncomingMessage, maxBytes = 64 * 1024): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) return null;
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function respondJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

/**
 * Long-running transport boundary for the Mission Relay. Authentication,
 * tenant checks, snapshots, and writes remain in MissionRelayService so the
 * WebSocket adapter cannot accidentally bypass domain policy.
 */
export function createMissionRelayServer(options: MissionRelayServerOptions): { server: HttpServer; webSocketServer: WebSocketServer; service: MissionRelayService } {
  const service = new MissionRelayService(options);
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }

    // Item #21 Phase 6's resolved relay-ingest gap: the only two things a
    // stateless HTTP caller (the Next.js app, acting on an MCP tool call)
    // needs from this process -- resolve a live PTY session's room, and
    // publish a frame into a room -- both internal-secret gated, both
    // narrow reads/writes onto MissionRelayService rather than a general
    // RPC surface.
    if (request.method === "GET" && request.url?.startsWith("/internal/pty-session/")) {
      if (!authorizedInternalBearer(request, options.internalSecret)) return respondJson(response, 401, { error: "unauthorized" });
      const url = new URL(request.url, "http://internal");
      const workspaceId = url.searchParams.get("workspaceId");
      const sessionId = decodeURIComponent(url.pathname.slice("/internal/pty-session/".length));
      if (!workspaceId || !sessionId) return respondJson(response, 400, { error: "workspaceId and sessionId are required" });
      const room = service.lookupPtySessionRoom(workspaceId, sessionId);
      if (!room) return respondJson(response, 404, { error: "not_found" });
      return respondJson(response, 200, room);
    }

    if (request.method === "POST" && request.url === "/internal/publish") {
      if (!authorizedInternalBearer(request, options.internalSecret)) return respondJson(response, 401, { error: "unauthorized" });
      void (async () => {
        const body = await readJsonBody(request);
        const workspaceId = typeof body?.workspaceId === "string" ? body.workspaceId : "";
        const channelId = typeof body?.channelId === "string" ? body.channelId : "";
        const type = typeof body?.type === "string" ? body.type as RelayServerFrameType : "" as RelayServerFrameType;
        if (!workspaceId || !channelId || !type || !("payload" in (body ?? {}))) {
          return respondJson(response, 400, { error: "workspaceId, channelId, type, and payload are required" });
        }
        const ok = service.publishServerFrame({ workspaceId, channelId, type, payload: body!.payload });
        if (!ok) return respondJson(response, 400, { error: "unsupported frame type" });
        return respondJson(response, 200, { ok: true });
      })();
      return;
    }

    response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "not_found" }));
  });
  const webSocketServer = new WebSocketServer({ server });
  const socketLiveness = new WeakMap<WebSocket, boolean>();
  const heartbeatTimer = setInterval(() => {
    for (const socket of webSocketServer.clients) {
      if (socketLiveness.get(socket) === false) {
        socket.terminate();
        continue;
      }
      socketLiveness.set(socket, false);
      socket.ping();
    }
  }, 30_000);
  heartbeatTimer.unref?.();
  webSocketServer.once("close", () => clearInterval(heartbeatTimer));
  webSocketServer.on("connection", (socket: WebSocket) => {
    const connectionId = `ws-${randomUUID()}`;
    socketLiveness.set(socket, true);
    socket.on("pong", () => socketLiveness.set(socket, true));
    service.connect({ connectionId, send: (frame) => { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame)); } });
    socket.on("message", (message) => {
      let payload: unknown = null;
      try {
        payload = JSON.parse(message.toString());
      } catch {
        payload = null;
      }
      void service.receive(connectionId, payload);
    });
    socket.on("close", () => { socketLiveness.delete(socket); service.disconnect(connectionId); });
    socket.on("error", () => { socketLiveness.delete(socket); service.disconnect(connectionId); });
  });
  server.listen(options.port, options.host);
  return { server, webSocketServer, service };
}
