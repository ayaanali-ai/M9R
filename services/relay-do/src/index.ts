import { RELAY_SERVER_FRAME_TYPES } from "../../../src/lib/mission/mission-relay-protocol";
import type { RelayServerFrameType } from "../../../src/lib/mission/mission-relay-protocol";
import type { Env } from "./env";
export { WorkspaceHub } from "./hub";

const MAX_INTERNAL_BODY_BYTES = 64 * 1024;
const FIRST_FRAME_DEADLINE_MS = 5_000;
/** Workspace ids are UUIDs. Anything else never reaches a Durable Object: an unauthenticated caller must not be able to mint objects (each one is billable) by inventing ids. */
const WORKSPACE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

/** Constant-time bearer check; identical in shape to the container Relay's `authorizedInternalBearer`. */
async function authorizedBearer(request: Request, secret: string | undefined): Promise<boolean> {
  if (!secret) return false;
  const digest = (value: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const [expected, supplied] = await Promise.all([digest(`Bearer ${secret}`), digest(request.headers.get("authorization") ?? "")]);
  return crypto.subtle.timingSafeEqual(expected, supplied);
}

function hubFor(env: Env, workspaceId: string) {
  return env.HUB.get(env.HUB.idFromName(workspaceId));
}

function sanitizeCloseCode(code: number | undefined): number {
  if (code === undefined) return 1000;
  if (code === 1000 || (code >= 1001 && code <= 1003) || (code >= 1007 && code <= 1011) || (code >= 3000 && code <= 4999)) return code;
  return 1000;
}

function errorFrame(code: string, message: string): string {
  return JSON.stringify({
    version: "oathlock.relay.v1",
    frameId: `gateway-error-${crypto.randomUUID()}`,
    type: "relay.error",
    workspaceId: "unknown",
    correlationId: `gateway-${code}`,
    causationId: null,
    idempotencyKey: null,
    sentAt: new Date().toISOString(),
    payload: { code, message },
  });
}

/**
 * Clients connect to the bare Relay URL and only name their workspace in the first frame, but a
 * Durable Object has to be chosen when the connection is made. The gateway therefore accepts the
 * socket, reads the first frame, picks that workspace's Hub, and pipes the two sockets together.
 * Existing CLIs and the browser client need no change, and the URL does not change.
 */
type FirstFrame = { workspaceId?: unknown; type?: unknown; frameId?: unknown; correlationId?: unknown; payload?: unknown };

function parseFirstFrame(data: string | ArrayBuffer): FirstFrame | null {
  try {
    const parsed = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as FirstFrame : null;
  } catch {
    return null;
  }
}

function proxyWebSocket(env: Env): Response {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
  server.accept();

  let upstream: WebSocket | null = null;
  let connecting = false;
  const queue: Array<string | ArrayBuffer> = [];
  const deadline = setTimeout(() => {
    if (upstream || connecting) return;
    try { server.send(errorFrame("auth_timeout", "No first frame was received in time.")); } catch { /* closing */ }
    try { server.close(4001, "auth_timeout"); } catch { /* closing */ }
  }, FIRST_FRAME_DEADLINE_MS);

  const failClient = (code: string, message: string, closeCode: number) => {
    clearTimeout(deadline);
    try { server.send(errorFrame(code, message)); } catch { /* closing */ }
    try { server.close(closeCode, code); } catch { /* closing */ }
  };

  const connectUpstream = async (workspaceId: string) => {
    connecting = true;
    try {
      const response = await hubFor(env, workspaceId).fetch("https://hub/ws", { headers: { Upgrade: "websocket" } });
      const socket = response.webSocket;
      if (!socket) { failClient("relay_unavailable", `Relay hub refused the connection (${response.status}).`, 1013); return; }
      socket.accept();
      upstream = socket;
      socket.addEventListener("message", (event) => { try { server.send(event.data as string); } catch { /* client gone */ } });
      socket.addEventListener("close", (event) => { try { server.close(sanitizeCloseCode(event.code), event.reason || undefined); } catch { /* client gone */ } });
      socket.addEventListener("error", () => { try { server.close(1011, "upstream_error"); } catch { /* client gone */ } });
      clearTimeout(deadline);
      for (const pending of queue.splice(0)) socket.send(pending);
    } catch (error) {
      failClient("relay_unavailable", error instanceof Error ? error.message : "Relay hub unavailable.", 1013);
    }
  };

  server.addEventListener("message", (event) => {
    const data = event.data as string | ArrayBuffer;
    if (upstream) { try { upstream.send(data); } catch { /* closing */ } return; }
    if (connecting) { queue.push(data); return; }
    // Only an authentication frame naming a real workspace may wake a Hub; everything else is answered here.
    const frame = parseFirstFrame(data);
    const workspaceId = frame && typeof frame.workspaceId === "string" && WORKSPACE_ID_PATTERN.test(frame.workspaceId) ? frame.workspaceId : null;
    if (!frame || !workspaceId) { failClient("invalid_frame", "The first frame must be JSON that names a workspaceId.", 1008); return; }
    const payload = frame.payload && typeof frame.payload === "object" ? frame.payload as { credential?: unknown } : null;
    if ((frame.type !== "auth.browser" && frame.type !== "auth.bridge") || typeof payload?.credential !== "string") {
      // Same reply the container Relay gave for a frame sent before auth; the socket stays open until the deadline.
      try {
        server.send(JSON.stringify({
          version: "oathlock.relay.v1", frameId: `error-${String(frame.frameId ?? "gateway")}`, type: "relay.error", workspaceId,
          correlationId: typeof frame.correlationId === "string" ? frame.correlationId : "gateway", causationId: typeof frame.frameId === "string" ? frame.frameId : null,
          idempotencyKey: null, sentAt: new Date().toISOString(), payload: { code: "unauthenticated", message: "Authenticate before sending other frames." },
        }));
      } catch { /* closing */ }
      return;
    }
    queue.push(data);
    void connectUpstream(workspaceId);
  });
  server.addEventListener("close", (event) => { clearTimeout(deadline); try { upstream?.close(sanitizeCloseCode(event.code), event.reason || undefined); } catch { /* closing */ } });
  server.addEventListener("error", () => { clearTimeout(deadline); try { upstream?.close(1011, "client_error"); } catch { /* closing */ } });

  return new Response(null, { status: 101, webSocket: client });
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  const text = await request.text();
  if (text.length > MAX_INTERNAL_BODY_BYTES) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") return proxyWebSocket(env);

    if (request.method === "GET" && url.pathname === "/healthz") return json(200, { status: "ok", runtime: "durable-objects" });

    // Same routes, status codes and body shapes as the container Relay.
    if (request.method === "GET" && url.pathname.startsWith("/internal/pty-session/")) {
      if (!(await authorizedBearer(request, env.MISSION_RELAY_TOKEN_SECRET))) return json(401, { error: "unauthorized" });
      const sessionId = decodeURIComponent(url.pathname.slice("/internal/pty-session/".length));
      const workspaceId = url.searchParams.get("workspaceId");
      if (!workspaceId || !sessionId || !WORKSPACE_ID_PATTERN.test(workspaceId)) return json(400, { error: "workspaceId and sessionId are required" });
      const room = await hubFor(env, workspaceId).lookupPty(workspaceId, sessionId);
      return room ? json(200, room) : json(404, { error: "not_found" });
    }

    if (request.method === "POST" && url.pathname === "/internal/publish") {
      if (!(await authorizedBearer(request, env.MISSION_RELAY_TOKEN_SECRET))) return json(401, { error: "unauthorized" });
      const body = await readJsonBody(request);
      const workspaceId = typeof body?.workspaceId === "string" ? body.workspaceId : "";
      const channelId = typeof body?.channelId === "string" ? body.channelId : "";
      const type = typeof body?.type === "string" ? body.type : "";
      if (!workspaceId || !channelId || !type || !body || !("payload" in body) || !WORKSPACE_ID_PATTERN.test(workspaceId)) {
        return json(400, { error: "workspaceId, channelId, type, and payload are required" });
      }
      if (!(RELAY_SERVER_FRAME_TYPES as readonly string[]).includes(type)) return json(400, { error: "unsupported frame type" });
      const ok = await hubFor(env, workspaceId).publish({ workspaceId, channelId, type: type as RelayServerFrameType, payload: body.payload });
      return ok ? json(200, { ok: true }) : json(400, { error: "unsupported frame type" });
    }

    // New: the web app calls this when an agent is disconnected or a member is removed.
    if (request.method === "POST" && url.pathname === "/internal/revoke") {
      if (!(await authorizedBearer(request, env.MISSION_RELAY_TOKEN_SECRET))) return json(401, { error: "unauthorized" });
      const body = await readJsonBody(request);
      const workspaceId = typeof body?.workspaceId === "string" ? body.workspaceId : "";
      const principalId = typeof body?.principalId === "string" ? body.principalId : "";
      if (!workspaceId || !principalId || !WORKSPACE_ID_PATTERN.test(workspaceId)) return json(400, { error: "workspaceId and principalId are required" });
      return json(200, { closed: await hubFor(env, workspaceId).revoke(principalId) });
    }

    return json(404, { error: "not_found" });
  },
} satisfies ExportedHandler<Env>;
