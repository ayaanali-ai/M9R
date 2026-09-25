/**
 * Local transport for the web broker (spike). Two doors, both loopback only:
 * - POST /cmd from the M9R MCP tools, allowed only with the secret in ~/.m9r/web-broker.key. Requests that carry an
 *   Origin header are refused, so a web page cannot drive the browser through this port.
 * - a WebSocket at /ext for the browser extension, allowed only from a chrome-extension:// origin and either a
 *   listed extension id or an explicit development-only opt-in when no ids are configured. One extension at a time:
 *   an authorized new connection replaces the old one.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { verifyAudit, type WebAuthority, type WebAuthoritySnapshot } from "./web-authority-core";
import { createWebBroker, type WebAction, type WebRequest } from "./web-broker-core";
import { DEFAULT_BROKER_PORT } from "./web-broker-paths";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_EXTENSION_MESSAGE_BYTES = 256 * 1024;

export function loadOrCreateBrokerKey(path: string): string {
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {
    // fall through and create one
  }
  const key = randomBytes(32).toString("hex");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${key}\n`, { mode: 0o600 });
  return key;
}

function sameSecret(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(null));
  });
}

export interface WebBrokerServerOptions {
  key: string;
  port?: number;
  host?: string;
  allowedExtensionIds?: string[];
  allowAnyExtension?: boolean;
  timeoutMs?: number;
  /** Maximum wait for the extension's ready handshake when a browser command arrives during startup. */
  extensionConnectTimeoutMs?: number;
  claimTtlMs?: number;
  approvalTimeoutMs?: number;
  ownerId?: string;
  authority?: WebAuthority;
  authorityStore?: { load(): WebAuthoritySnapshot; save(snapshot: WebAuthoritySnapshot): void };
}

export async function startWebBroker(options: WebBrokerServerOptions): Promise<{ port: number; close: () => Promise<void> }> {
  const host = options.host ?? "127.0.0.1";
  const allowed = (options.allowedExtensionIds ?? []).filter(Boolean);
  const allowAnyExtension = allowed.length === 0 && (options.allowAnyExtension === true || process.env.M9R_ALLOW_ANY_EXTENSION === "1");
  const authority = options.authority;
  if (authority && options.authorityStore) authority.restore(options.authorityStore.load());
  const persistAuthority = () => {
    if (authority && options.authorityStore) options.authorityStore.save(authority.snapshot());
  };
  let extension: WebSocket | null = null;
  let readyExtension: WebSocket | null = null;
  let closeServer: () => Promise<void> = async () => undefined;
  const readyWaiters = new Set<(ready: boolean) => void>();

  function settleReadyWaiters(ready: boolean): void {
    for (const settle of [...readyWaiters]) settle(ready);
  }

  function waitForExtensionReady(timeoutMs: number): Promise<boolean> {
    if (extension && extension === readyExtension && extension.readyState === WebSocket.OPEN) return Promise.resolve(true);
    return new Promise((resolve) => {
      const settle = (ready: boolean) => {
        clearTimeout(timer);
        readyWaiters.delete(settle);
        resolve(ready);
      };
      readyWaiters.add(settle);
      const timer = setTimeout(() => settle(false), Math.max(0, timeoutMs));
    });
  }

  const sendApprovedGrant = (grant: WebAuthoritySnapshot["grants"][number]) => {
    if (!extension || extension !== readyExtension || extension.readyState !== WebSocket.OPEN) return;
    extension.send(JSON.stringify({ type: "grant-approved", grant: {
      grantId: grant.id, origin: grant.origin, pathPrefix: grant.pathPrefix ?? "/", actions: grant.actions,
    } }));
  };

  const broker = createWebBroker({
    send: (message) => {
      if (!extension || extension !== readyExtension || extension.readyState !== WebSocket.OPEN) return false;
      extension.send(JSON.stringify(message));
      return true;
    },
    timeoutMs: options.timeoutMs,
    claimTtlMs: options.claimTtlMs,
    approvalTimeoutMs: options.approvalTimeoutMs,
    ownerId: options.ownerId,
    authority,
    onAuthorityChange: persistAuthority,
  });

  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") return reply(res, 200, { ok: true });
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname.startsWith("/web/")) {
      if (req.headers.origin !== undefined) return reply(res, 403, { ok: false, error: "browser-originated requests are refused" });
      if (!sameSecret(req.headers["x-m9r-key"] as string | undefined, options.key)) return reply(res, 401, { ok: false, error: "missing or wrong key" });
      if (req.method === "GET" && requestUrl.pathname === "/web/status") {
        return reply(res, 200, { ok: true, broker: "ready", extensionConnected: !!extension && extension.readyState === WebSocket.OPEN, extensionReady: !!extension && extension === readyExtension && extension.readyState === WebSocket.OPEN });
      }
      if (req.method === "POST" && requestUrl.pathname === "/web/shutdown") {
        reply(res, 200, { ok: true, stopped: true });
        setTimeout(() => void closeServer(), 0);
        return;
      }
      if (req.method === "GET" && requestUrl.pathname === "/web/feed") return reply(res, 200, broker.feedSnapshot());
      if (req.method === "POST" && requestUrl.pathname === "/web/message") {
        const bodyText = await readBody(req);
        if (bodyText === null) return reply(res, 413, { ok: false, error: "request too large" });
        let body: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(bodyText);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("body must be an object");
          body = parsed as Record<string, unknown>;
        } catch {
          return reply(res, 400, { ok: false, error: "invalid json object" });
        }
        if (typeof body.agent !== "string" || body.agent.length > 80 || typeof body.provider !== "string" || body.provider.length > 80 ||
            typeof body.sessionId !== "string" || body.sessionId.length > 128 || typeof body.to !== "string" || body.to.length > 80 ||
            typeof body.messageId !== "string" || body.messageId.length > 128 || typeof body.text !== "string" || body.text.length > 4_000 ||
            (body.owner !== undefined && (typeof body.owner !== "string" || body.owner.length > 80))) {
          return reply(res, 400, { ok: false, error: "invalid message notice" });
        }
        const accepted = broker.notifyAgentMessage({
          agent: body.agent, provider: body.provider, sessionId: body.sessionId, to: body.to,
          messageId: body.messageId, text: body.text, ...(typeof body.owner === "string" ? { owner: body.owner } : {}),
        });
        return reply(res, 200, { ok: true, displayed: accepted });
      }
      if (!authority) return reply(res, 503, { ok: false, error: "web authority is not configured" });

      if (req.method === "GET" && requestUrl.pathname === "/web/pending") return reply(res, 200, { requests: authority.pendingRequests() });
      if (req.method === "GET" && requestUrl.pathname === "/web/grants") return reply(res, 200, { grants: authority.grants() });
      if (req.method === "GET" && requestUrl.pathname === "/web/actions/pending") return reply(res, 200, { actions: broker.pendingApprovals() });
        if (req.method === "GET" && requestUrl.pathname === "/web/audit") {
        const entries = authority.audit();
        return reply(res, 200, requestUrl.searchParams.get("verify") === "1" ? { entries, verification: verifyAudit(entries) } : { entries });
      }
      if (req.method !== "POST" || !["/web/approve", "/web/deny", "/web/revoke", "/web/revoke-all", "/web/actions/approve", "/web/actions/deny"].includes(requestUrl.pathname)) {
        return reply(res, 404, { ok: false, error: "not found" });
      }
      const bodyText = await readBody(req);
      if (bodyText === null) return reply(res, 413, { ok: false, error: "request too large" });
      let body: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(bodyText);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("body must be an object");
        body = parsed as Record<string, unknown>;
      } catch {
        return reply(res, 400, { ok: false, error: "invalid json object" });
      }
      const persist = (): boolean => {
        try {
          persistAuthority();
          return true;
        } catch {
          reply(res, 500, { ok: false, error: "could not persist web authority state" });
          return false;
        }
      };
      if (requestUrl.pathname === "/web/actions/approve" || requestUrl.pathname === "/web/actions/deny") {
        if (typeof body.id !== "string" || !body.id) return reply(res, 400, { ok: false, error: "id is required" });
        const decision = requestUrl.pathname.endsWith("/approve") ? "approve" : "deny";
        if (!broker.decideApproval(body.id, decision)) return reply(res, 404, { ok: false, error: "pending action was not found or has expired" });
        return reply(res, 200, { ok: true, decision });
      }
      if (requestUrl.pathname === "/web/approve") {
        if (typeof body.id !== "string" || !body.id ||
            (body.actions !== undefined && (!Array.isArray(body.actions) || body.actions.some((item) => !["open", "read", "click", "type"].includes(String(item))))) ||
            (body.ttlMs !== undefined && (!Number.isSafeInteger(body.ttlMs) || (body.ttlMs as number) < 1)) ||
            (body.maxUses !== undefined && (!Number.isSafeInteger(body.maxUses) || (body.maxUses as number) < 1))) {
          return reply(res, 400, { ok: false, error: "invalid approval options" });
        }
        const result = authority.approve(body.id, {
          ...(Array.isArray(body.actions) ? { actions: body.actions as WebAction[] } : {}),
          ...(typeof body.ttlMs === "number" ? { ttlMs: body.ttlMs } : {}),
          ...(typeof body.maxUses === "number" ? { maxUses: body.maxUses } : {}),
        });
        if (!persist()) return;
        if (result.ok) sendApprovedGrant(result.grant);
        return result.ok ? reply(res, 200, result) : reply(res, 404, { ok: false, error: result.error });
      }
      if (requestUrl.pathname === "/web/deny" || requestUrl.pathname === "/web/revoke") {
        if (typeof body.id !== "string" || !body.id) return reply(res, 400, { ok: false, error: "id is required" });
        const changed = requestUrl.pathname === "/web/deny" ? authority.deny(body.id) : authority.revoke(body.id);
        if (!changed) return reply(res, 404, { ok: false, error: "request or grant not found" });
        if (!persist()) return;
        return reply(res, 200, { ok: true });
      }
      const revoked = authority.revokeAll();
      if (!persist()) return;
      return reply(res, 200, { ok: true, revoked });
    }
    if (req.method !== "POST" || req.url !== "/cmd") return reply(res, 404, { ok: false, error: "not found" });
    if (req.headers.origin) return reply(res, 403, { ok: false, error: "browser-originated requests are refused" });
    if (!sameSecret(req.headers["x-m9r-key"] as string | undefined, options.key)) {
      return reply(res, 401, { ok: false, error: "missing or wrong key" });
    }
    const body = await readBody(req);
    if (body === null) return reply(res, 413, { ok: false, error: "request too large" });
    let parsed: WebRequest;
    try {
      parsed = JSON.parse(body) as WebRequest;
    } catch {
      return reply(res, 400, { ok: false, error: "invalid json" });
    }
    const ready = await waitForExtensionReady(options.extensionConnectTimeoutMs ?? 30_000);
    if (!ready) return reply(res, 200, { ok: false, error: "the browser extension did not become ready before the connection wait expired" });
    return reply(res, 200, await broker.submit(parsed));
  });

  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_EXTENSION_MESSAGE_BYTES });

  server.on("upgrade", (req, socket, head) => {
    const origin = String(req.headers.origin ?? "");
    const candidateId = origin.startsWith("chrome-extension://") ? origin.slice("chrome-extension://".length).replace(/\/$/, "") : "";
    const id = candidateId && !/[/?#]/.test(candidateId) ? candidateId : "";
    const permitted = req.url === "/ext" && id !== "" && (allowed.length > 0 ? allowed.includes(id) : allowAnyExtension);
    if (!permitted) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      if (extension && extension.readyState === WebSocket.OPEN) extension.close(4000, "replaced by a newer extension connection");
      extension = ws;
      readyExtension = null;
      ws.on("message", (data) => {
        try {
          const message: unknown = JSON.parse(data.toString());
          if (typeof message === "object" && message !== null && "type" in message && message.type === "ready") {
            if (extension !== ws) return;
            readyExtension = ws;
            settleReadyWaiters(true);
            for (const grant of authority?.grants() ?? []) if (!grant.revokedAt && grant.expiresAt > Date.now()) sendApprovedGrant(grant);
            ws.send(JSON.stringify({ type: "broker-state", stopped: broker.feedSnapshot().stop.state === "stopped" }));
            return;
          }
          if (extension !== ws || readyExtension !== ws) return;
          if (typeof message === "object" && message !== null && "type" in message && message.type === "stop-all") {
            broker.stopAll("you");
            return;
          }
          if (typeof message === "object" && message !== null && "type" in message && message.type === "message-visibility") {
            const visibility = message as { sessionId?: unknown; show?: unknown };
            if (typeof visibility.sessionId === "string" && visibility.sessionId.length <= 128 && typeof visibility.show === "boolean") {
              const accepted = broker.setMessageTextVisibility(visibility.sessionId, visibility.show);
              ws.send(JSON.stringify({ type: "message-visibility-result", sessionId: visibility.sessionId, show: visibility.show, accepted }));
            }
            return;
          }
            if (typeof message === "object" && message !== null && "type" in message && message.type === "permission-result") {
            const permission = message as { grantId?: unknown; origin?: unknown; granted?: unknown };
            if (typeof permission.grantId !== "string" || typeof permission.origin !== "string" || typeof permission.granted !== "boolean" || !authority) return;
            const grant = authority.grants().find((item) => item.id === permission.grantId && item.origin === permission.origin && !item.revokedAt);
            if (!grant) return;
            if (!permission.granted) authority.revoke(grant.id);
            try { persistAuthority(); } catch { /* enforcement remains fail-closed in the broker core */ }
            return;
          }
          broker.onExtensionMessage(message);
        } catch {
          // ignore malformed frames
        }
      });
      ws.on("close", () => {
        if (extension === ws) {
          extension = null;
          readyExtension = null;
          broker.onExtensionClosed();
        }
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? DEFAULT_BROKER_PORT, host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port ?? DEFAULT_BROKER_PORT;

  let closePromise: Promise<void> | null = null;
  const close = () => {
    if (closePromise) return closePromise;
    closePromise = new Promise<void>((resolve) => {
      settleReadyWaiters(false);
      extension?.close();
      sockets.close();
      server.close(() => resolve());
      server.closeAllConnections();
    });
    return closePromise;
  };
  closeServer = close;
  return { port, close };
}
