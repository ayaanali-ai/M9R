/**
 * Local transport for the web broker (spike). Three doors:
 * - POST /cmd from the M9R MCP tools, allowed only with the owner-scoped key in ~/.m9r/web-broker.key. Requests that
 *   carry an Origin header are refused, so a web page cannot drive the browser through this port.
 * - a local named pipe/Unix socket with read-only status access; it is not an approval or mutation path.
 * - a WebSocket at /ext for the browser extension, allowed only from a chrome-extension:// origin and either a
 *   listed extension id or an explicit development-only opt-in when no ids are configured. One extension at a time:
 *   an authorized new connection replaces the old one.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { platform } from "node:os";
import { WebSocket, WebSocketServer } from "ws";
import { originOf, verifyAudit, type WebAuthority, type WebAuthoritySnapshot } from "./web-authority-core";
import { createWebBroker, ROOM_MODES, type RoomMode, type WebAction, type WebBatchRequest, type WebRequest } from "./web-broker-core";
import { isDisclosureAction } from "./web-powers-core";
import { DEFAULT_BROKER_PORT } from "./web-broker-paths";
import { startOwnerPipe, type OwnerPipeRequest } from "./owner-pipe";
import { isUiMessage, type UiState, type WebUiBridge } from "./web-ui-bridge";
import { createProtocolLedger, MAX_AWARE_PROTOCOL_FRAMES, type ProtocolMessage, type ProtocolMessageType } from "../../../packages/web-protocol-placeholder/src/index";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_EXTENSION_MESSAGE_BYTES = 256 * 1024;
const LOCAL_AWARE_ROOM_ID = "room-local";

/**
 * Windows ignores the 0o600 file mode entirely, so without this any process running as the same OS user -- including a
 * Codex sandbox, which carries the explicit CodexSandboxUsers group grant a sandbox needs to read its own files -- can
 * read the broker key and use it to approve its own risky actions or flip the room to hands-off. This narrows the file's
 * ACL to the current user only and explicitly denies CodexSandboxUsers. If the required owner-only ACL cannot be
 * applied, startup fails closed instead of exposing the owner credential.
 */
export interface KeyFileAclOptions {
  platform?: NodeJS.Platform;
  username?: string;
  run?: (args: string[]) => void;
}

export function tightenKeyFileAcl(path: string, options: KeyFileAclOptions = {}): void {
  if ((options.platform ?? platform()) !== "win32") return;
  const username = options.username ?? process.env.USERNAME;
  if (!username) throw new Error("cannot secure the M9R broker key: the current Windows username is unavailable");
  const run = options.run ?? ((args: string[]) => { execFileSync("icacls", args, { windowsHide: true, stdio: "ignore" }); });
  try {
    run([path, "/inheritance:r"]);
    run([path, "/grant:r", `${username}:(R,W)`]);
  } catch {
    throw new Error("cannot secure the M9R broker key ACL; refusing to start with an exposed owner credential");
  }
  try {
    run([path, "/deny", "CodexSandboxUsers:(R,W)"]);
  } catch {
    // the group may not exist on this machine; the owner-only grant above is still the real protection
  }
}

export function loadOrCreateBrokerKey(path: string, applyAcl: (path: string) => void = tightenKeyFileAcl): string {
  let existing: string | null = null;
  try {
    existing = readFileSync(path, "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing && existing.length >= 32) {
    // Never rotate a readable key just because its ACL could not be tightened. In that case the broker must fail
    // closed, leaving the existing credential untouched for an explicit recovery decision.
    applyAcl(path);
    return existing;
  }
  const key = randomBytes(32).toString("hex");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${key}\n`, { mode: 0o600 });
  try {
    applyAcl(path);
  } catch (error) {
    try { rmSync(path, { force: true }); } catch { /* startup still fails closed if cleanup is blocked */ }
    throw error;
  }
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
    let oversized = false;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      if (oversized) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        oversized = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(oversized ? null : Buffer.concat(chunks).toString("utf8")));
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
  loopGuard?: { repeat: number; budget: number; windowMs: number };
  approvalTimeoutMs?: number;
  ownerId?: string;
  authority?: WebAuthority;
  authorityStore?: {
    load(): WebAuthoritySnapshot;
    save(snapshot: WebAuthoritySnapshot): void;
    loadProtocolFrames?(): unknown[];
    saveProtocolFrames?(frames: readonly unknown[]): void;
  };
  /** The in-page pill bridge (web-ui-bridge.ts). Its frames are accepted only on the ready extension socket. */
  ui?: WebUiBridge;
  /** Where the room mode (watch / ask / hands-off) is kept between runs. Defaults to watch. */
  modeFile?: string;
  /** Plain-words `step`/`phase` on presence frames; on by default when `ui` is set. */
  narrate?: boolean;
  /** Called on a real POST /web/shutdown, in addition to closing this HTTP/WS server, so the caller can also stop its own
   * timers, sessions and exit the process. Without this the server socket closes but the process (and any interval it
   * started that isn't unref'd) keeps running. */
  onShutdownRequested?: () => void;
  /** When set, this local endpoint exposes read-only status; mutations use the broker-key HTTP API after CLI confirmation. */
  ownerPipePath?: string;
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
  const ownerId = options.ownerId ?? "local-machine";
  // Bind semantic protocol decisions to the same owner identity used by the
  // authenticated local transport. Without this, the ledger only validated
  // frames and silently skipped its owner/member/disclosure checks.
  const ownerPrincipalId = `owner:${ownerId}`;
  const protocolLedger = createProtocolLedger({ ownerId: ownerPrincipalId, maxFrames: MAX_AWARE_PROTOCOL_FRAMES });
  protocolLedger.restore(options.authorityStore?.loadProtocolFrames?.() ?? []);
  let protocolJournalPersisted = true;
  function persistProtocolLedger(): boolean {
    if (!options.authorityStore?.saveProtocolFrames) return true;
    try {
      options.authorityStore.saveProtocolFrames(protocolLedger.snapshot());
      protocolJournalPersisted = true;
      return true;
    } catch {
      protocolJournalPersisted = false;
      return false;
    }
  }
  function ensureProtocolJournalDurable(): boolean {
    return protocolJournalPersisted || persistProtocolLedger();
  }
  function nextProtocolSequence(principalId: string): number {
    return protocolLedger.snapshot().reduce((max, frame) =>
      frame.session_id === LOCAL_AWARE_ROOM_ID && frame.sender.principal_id === principalId ? Math.max(max, frame.sequence) : max, 0) + 1;
  }
  function makeProtocolFrame(messageType: ProtocolMessageType, principalId: string, payload: Record<string, unknown>): ProtocolMessage {
    const sequence = nextProtocolSequence(principalId);
    const at = new Date().toISOString();
    return {
      protocol: "m9r-web/0", message_id: randomUUID(), session_id: LOCAL_AWARE_ROOM_ID,
      sender: { principal_id: principalId, key_id: principalId === ownerPrincipalId ? "local-owner" : "local-agent" },
      sequence, created_at: at, causal: { lamport: sequence, observed: [] },
      message_type: messageType, payload, signature: "local-reference",
    };
  }
  function acceptProtocolFrame(frame: ProtocolMessage, principalId: string): { ok: true; message: ProtocolMessage } | { ok: false; error: string } {
    const accepted = protocolLedger.accept(frame, { principalId });
    if (!accepted.ok) return accepted;
    if (!persistProtocolLedger()) return { ok: false, error: "could not persist AWARE policy state; browser action is refused" };
    return accepted;
  }
  function principalForAction(value: unknown): string | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const request = value as Record<string, unknown>;
    if (typeof request.agent !== "string" || !/^[A-Za-z0-9_.-]{1,80}$/.test(request.agent)) return null;
    const memberOwner = request.owner === undefined ? ownerId : request.owner;
    if (typeof memberOwner !== "string" || !/^[A-Za-z0-9_.-]{1,80}$/.test(memberOwner)) return null;
    const principalId = `agent:${memberOwner}/${request.agent}`;
    return principalId.length <= 128 ? principalId : null;
  }
  function stableJson(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  function disclosureContent(request: unknown, response: unknown, batch: boolean): unknown | null {
    if (typeof request !== "object" || request === null || Array.isArray(request) ||
        typeof response !== "object" || response === null || Array.isArray(response)) return null;
    const result = response as Record<string, unknown>;
    const capture = (action: unknown, item: unknown, actionInput?: Record<string, unknown>): unknown | null => {
      if (typeof action !== "string" || typeof item !== "object" || item === null || Array.isArray(item)) return null;
      const responseItem = item as Record<string, unknown>;
      if (responseItem.ok !== true) return null;
      const containsPageState = responseItem.pageState !== undefined || responseItem.changedPart !== undefined;
      const data = typeof responseItem.data === "object" && responseItem.data !== null && !Array.isArray(responseItem.data)
        ? responseItem.data as Record<string, unknown> : undefined;
      const containsClickLabel = action === "click" && (
        responseItem.label !== undefined || responseItem.targetLabel !== undefined ||
        data?.label !== undefined || data?.targetLabel !== undefined
      );
      const containsNavigationTitle = ["open", "back", "forward", "reload"].includes(action) && responseItem.label !== undefined;
      const containsNavigationMetadata = responseItem.url !== undefined || responseItem.title !== undefined ||
        data?.url !== undefined || data?.title !== undefined;
      if (!isDisclosureAction(action) && !containsPageState && !containsClickLabel && !containsNavigationTitle && !containsNavigationMetadata) return null;
      return {
        action,
        ...(action === "click" && actionInput?.targetLabel !== undefined ? { requestedTargetLabel: actionInput.targetLabel } : {}),
        ...(action === "open" && actionInput?.url !== undefined ? { requestedUrl: actionInput.url } : {}),
        ...(responseItem.data !== undefined ? { data: responseItem.data } : {}),
        ...(responseItem.targetLabel !== undefined ? { targetLabel: responseItem.targetLabel } : {}),
        ...(responseItem.label !== undefined ? { label: responseItem.label } : {}),
        ...(responseItem.url !== undefined ? { url: responseItem.url } : {}),
        ...(responseItem.title !== undefined ? { title: responseItem.title } : {}),
        ...(responseItem.room !== undefined ? { room: responseItem.room } : {}),
        ...(responseItem.pageState !== undefined ? { pageState: responseItem.pageState } : {}),
        ...(responseItem.changedPart !== undefined ? { changedPart: responseItem.changedPart } : {}),
      };
    };
    const actionRequest = request as Record<string, unknown>;
    if (!batch) return capture(actionRequest.action, result, actionRequest);
    if (!Array.isArray(actionRequest.steps) || !Array.isArray(result.steps)) return null;
    const requestedSteps = actionRequest.steps as unknown[];
    const captured = result.steps.flatMap((step, index) => {
      if (typeof step !== "object" || step === null || Array.isArray(step)) return [];
      const item = step as Record<string, unknown>;
      const requestedStep = requestedSteps[index];
      if (typeof requestedStep !== "object" || requestedStep === null || Array.isArray(requestedStep)) return [];
      const stepRequest = requestedStep as Record<string, unknown>;
      const content = capture(stepRequest.action, item.response, stepRequest);
      return content === null ? [] : [content];
    });
    return captured.length ? captured : null;
  }

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

  let roomMode: RoomMode = "watch";
  try { if (options.modeFile) { const saved = readFileSync(options.modeFile, "utf8").trim() as RoomMode; if (ROOM_MODES.includes(saved)) roomMode = saved; } } catch { /* no saved mode yet */ }
  const broker = createWebBroker({
    roomMode: () => roomMode,
    send: (message) => {
      if (!extension || extension !== readyExtension || extension.readyState !== WebSocket.OPEN) return false;
      extension.send(JSON.stringify(message));
      return true;
    },
    timeoutMs: options.timeoutMs,
    claimTtlMs: options.claimTtlMs,
    loopGuard: options.loopGuard,
    approvalTimeoutMs: options.approvalTimeoutMs,
    ownerId: options.ownerId,
    authority,
    onAuthorityChange: persistAuthority,
    narrate: options.narrate ?? options.ui !== undefined,
    onActivity: options.ui ? (activity) => options.ui!.onActivity(activity) : undefined,
  });
  options.ui?.attachBroker(broker);

  const ownerOnlyPaths = new Set([
    "/web/mode", "/web/shutdown", "/web/approve", "/web/deny", "/web/revoke", "/web/revoke-all",
    "/web/actions/approve", "/web/actions/deny", "/web/aware/members/invite", "/web/aware/members/remove",
    "/web/aware/disclosures/decision", "/web/protocol",
  ]);
  const ownerPipeReadPaths = new Set(["/web/aware/members", "/web/aware/disclosures"]);
  const ownerReply = (ok: boolean, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ ok, ...extra });
  function memberPrincipal(body: Record<string, unknown>): string | null {
    const agent = body.agent;
    const memberOwner = body.owner === undefined ? ownerId : body.owner;
    if (typeof agent !== "string" || !/^[A-Za-z0-9_.-]{1,80}$/.test(agent) ||
        typeof memberOwner !== "string" || !/^[A-Za-z0-9_.-]{1,80}$/.test(memberOwner)) return null;
    const principalId = `agent:${memberOwner}/${agent}`;
    return principalId.length <= 128 ? principalId : null;
  }
  function decideDisclosure(requestId: string, decision: "approve" | "deny"): { ok: true; receiptId: string } | { ok: false; error: string } {
    const open = protocolLedger.pendingDisclosures(LOCAL_AWARE_ROOM_ID).find((frame) => frame.payload.request_id === requestId);
    if (!open) return { ok: false, error: "disclosure request was not found or has expired" };
    const receiptId = randomUUID();
    const frame = makeProtocolFrame("disclosure-decision", ownerPrincipalId, {
      request_id: requestId, decision, decided_by: ownerPrincipalId, receipt_id: receiptId,
    });
    const result = acceptProtocolFrame(frame, ownerPrincipalId);
    return result.ok ? { ok: true, receiptId } : result;
  }
  const handleOwnerRequest = async (request: OwnerPipeRequest): Promise<Record<string, unknown>> => {
    if (!ownerOnlyPaths.has(request.path) && !ownerPipeReadPaths.has(request.path)) return ownerReply(false, { error: "route is not owner-only" });
    if (request.path === "/web/aware/members" && request.method === "GET") {
      return ownerReply(true, { roomId: LOCAL_AWARE_ROOM_ID, members: protocolLedger.members(LOCAL_AWARE_ROOM_ID) });
    }
    if (request.path === "/web/aware/disclosures" && request.method === "GET") {
      return ownerReply(true, { roomId: LOCAL_AWARE_ROOM_ID, requests: protocolLedger.pendingDisclosures(LOCAL_AWARE_ROOM_ID) });
    }
    if (request.path === "/web/protocol" && request.method === "GET") {
      return ownerReply(true, { protocol: "m9r-web/0", messages: protocolLedger.snapshot() });
    }
    if (request.path === "/web/protocol" && request.method === "POST") {
      if (typeof request.body !== "object" || request.body === null || Array.isArray(request.body)) return ownerReply(false, { error: "protocol message must be an object" });
      const accepted = acceptProtocolFrame(request.body as unknown as ProtocolMessage, ownerPrincipalId);
      return accepted.ok ? ownerReply(true, { message: accepted.message }) : ownerReply(false, { error: accepted.error });
    }
    if (request.path === "/web/aware/members/invite" || request.path === "/web/aware/members/remove") {
      if (request.method !== "POST" || typeof request.body !== "object" || request.body === null || Array.isArray(request.body)) return ownerReply(false, { error: "request body must be an object" });
      const body = request.body as Record<string, unknown>;
      const principalId = memberPrincipal(body);
      if (!principalId) return ownerReply(false, { error: "agent and owner must be valid names" });
      const isInvite = request.path.endsWith("/invite");
      const frame = makeProtocolFrame("membership", ownerPrincipalId, {
        room_id: LOCAL_AWARE_ROOM_ID,
        member_id: principalId,
        state: isInvite ? "active" : "removed",
        ...(isInvite ? { invited_by: ownerPrincipalId } : {}),
        quiet_until_invited: !isInvite,
      });
      const result = acceptProtocolFrame(frame, ownerPrincipalId);
      return result.ok ? ownerReply(true, { member: result.message.payload, principalId }) : ownerReply(false, { error: result.error });
    }
    if (request.path === "/web/aware/disclosures/decision") {
      if (request.method !== "POST" || typeof request.body !== "object" || request.body === null || Array.isArray(request.body)) return ownerReply(false, { error: "request body must be an object" });
      const body = request.body as Record<string, unknown>;
      if (typeof body.requestId !== "string" || !body.requestId || (body.decision !== "approve" && body.decision !== "deny")) return ownerReply(false, { error: "requestId and approve|deny decision are required" });
      const result = decideDisclosure(body.requestId, body.decision);
      return result.ok ? ownerReply(true, { decision: body.decision, receiptId: result.receiptId }) : ownerReply(false, { error: result.error });
    }
    if (request.path === "/web/mode") {
      if (request.method === "GET") return ownerReply(true, { mode: roomMode, modes: ROOM_MODES });
      if (request.method !== "POST" || typeof request.body !== "object" || request.body === null || Array.isArray(request.body)) return ownerReply(false, { error: "request body must be an object" });
      const body = request.body as { mode?: unknown };
      if (!ROOM_MODES.includes(body.mode as RoomMode)) return ownerReply(false, { error: `mode must be one of ${ROOM_MODES.join(", ")}` });
      roomMode = body.mode as RoomMode;
      if (options.modeFile) { try { mkdirSync(dirname(options.modeFile), { recursive: true }); writeFileSync(options.modeFile, roomMode + String.fromCharCode(10)); } catch { /* still applies for this run */ } }
      return ownerReply(true, { mode: roomMode });
    }
    if (request.path === "/web/shutdown") {
      if (request.method !== "POST") return ownerReply(false, { error: "shutdown requires POST" });
      setTimeout(() => { options.onShutdownRequested?.(); void closeServer(); }, 0);
      return ownerReply(true, { stopped: true });
    }
    if (!authority) return ownerReply(false, { error: "web authority is not configured" });
    if (request.method !== "POST" || typeof request.body !== "object" || request.body === null || Array.isArray(request.body)) return ownerReply(false, { error: "request body must be an object" });
    const body = request.body as Record<string, unknown>;
    const persist = (): boolean => { try { persistAuthority(); return true; } catch { return false; } };
    if (request.path === "/web/actions/approve" || request.path === "/web/actions/deny") {
      if (typeof body.id !== "string" || !body.id) return ownerReply(false, { error: "id is required" });
      const decision = request.path.endsWith("/approve") ? "approve" : "deny";
      if (!broker.decideApproval(body.id, decision)) return ownerReply(false, { error: "pending action was not found or has expired" });
      return ownerReply(true, { decision });
    }
    if (request.path === "/web/approve") {
      if (typeof body.id !== "string" || !body.id ||
          (body.actions !== undefined && (!Array.isArray(body.actions) || body.actions.some((item) => !["open", "read", "click", "type"].includes(String(item))))) ||
          (body.ttlMs !== undefined && (!Number.isSafeInteger(body.ttlMs) || (body.ttlMs as number) < 1)) ||
          (body.maxUses !== undefined && (!Number.isSafeInteger(body.maxUses) || (body.maxUses as number) < 1))) return ownerReply(false, { error: "invalid approval options" });
      const result = authority.approve(body.id, {
        ...(Array.isArray(body.actions) ? { actions: body.actions as WebAction[] } : {}),
        ...(typeof body.ttlMs === "number" ? { ttlMs: body.ttlMs } : {}),
        ...(typeof body.maxUses === "number" ? { maxUses: body.maxUses } : {}),
      });
      if (!persist()) return ownerReply(false, { error: "could not persist web authority state" });
      if (result.ok) { sendApprovedGrant(result.grant); return result; }
      return ownerReply(false, { error: result.error });
    }
    if (request.path === "/web/deny" || request.path === "/web/revoke") {
      if (typeof body.id !== "string" || !body.id) return ownerReply(false, { error: "id is required" });
      const changed = request.path === "/web/deny" ? authority.deny(body.id) : authority.revoke(body.id);
      if (!changed) return ownerReply(false, { error: "request or grant not found" });
      if (!persist()) return ownerReply(false, { error: "could not persist web authority state" });
      return ownerReply(true);
    }
    const revoked = authority.revokeAll();
    if (!persist()) return ownerReply(false, { error: "could not persist web authority state" });
    return ownerReply(true, { revoked });
  };
  const ownerServer = options.ownerPipePath ? await startOwnerPipe({
    path: options.ownerPipePath,
    handle: (request) => request.method === "GET"
      ? handleOwnerRequest(request)
      : ownerReply(false, { error: "owner pipe is read-only; mutations require the authenticated loopback API" }),
  }) : null;

  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") return reply(res, 200, { ok: true });
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname.startsWith("/web/")) {
      if (req.headers.origin !== undefined) return reply(res, 403, { ok: false, error: "browser-originated requests are refused" });
      if (!sameSecret(req.headers["x-m9r-key"] as string | undefined, options.key)) return reply(res, 401, { ok: false, error: "missing or wrong key" });
      if (req.method === "GET" && requestUrl.pathname === "/web/status") {
        return reply(res, 200, { ok: true, broker: "ready", extensionConnected: !!extension && extension.readyState === WebSocket.OPEN, extensionReady: !!extension && extension === readyExtension && extension.readyState === WebSocket.OPEN });
      }
      if (req.method === "GET" && requestUrl.pathname === "/web/agents") {
        return reply(res, 200, { ok: true, agents: options.ui?.roster?.() ?? [] });
      }
      if (requestUrl.pathname === "/web/mode") {
        if (req.method === "GET") return reply(res, 200, { ok: true, mode: roomMode, modes: ROOM_MODES });
        if (req.method === "POST") {
          let body: { mode?: string } = {};
          try { body = JSON.parse(await readBody(req) || "{}") as { mode?: string }; } catch { return reply(res, 400, { ok: false, error: "request body must be JSON" }); }
          if (!ROOM_MODES.includes(body.mode as RoomMode)) return reply(res, 400, { ok: false, error: `mode must be one of ${ROOM_MODES.join(", ")}` });
          roomMode = body.mode as RoomMode;
          if (options.modeFile) { try { mkdirSync(dirname(options.modeFile), { recursive: true }); writeFileSync(options.modeFile, roomMode + String.fromCharCode(10)); } catch { /* still applies for this run */ } }
          return reply(res, 200, { ok: true, mode: roomMode });
        }
      }
      if (req.method === "POST" && requestUrl.pathname === "/web/shutdown") {
        reply(res, 200, { ok: true, stopped: true });
        setTimeout(() => { options.onShutdownRequested?.(); void closeServer(); }, 0);
        return;
      }
      if (req.method === "GET" && requestUrl.pathname === "/web/feed") return reply(res, 200, broker.feedSnapshot());
      if (req.method === "GET" && requestUrl.pathname === "/web/protocol") {
        return reply(res, 200, { protocol: "m9r-web/0", messages: protocolLedger.snapshot() });
      }
      if (req.method === "GET" && requestUrl.pathname === "/web/aware/members") {
        return reply(res, 200, { roomId: LOCAL_AWARE_ROOM_ID, members: protocolLedger.members(LOCAL_AWARE_ROOM_ID) });
      }
      if (req.method === "GET" && requestUrl.pathname === "/web/aware/disclosures") {
        return reply(res, 200, { roomId: LOCAL_AWARE_ROOM_ID, requests: protocolLedger.pendingDisclosures(LOCAL_AWARE_ROOM_ID) });
      }
      if (req.method === "POST" && requestUrl.pathname === "/web/aware/messages/authorize") {
        const bodyText = await readBody(req);
        if (bodyText === null) return reply(res, 413, { ok: false, error: "request too large" });
        let body: unknown;
        try { body = JSON.parse(bodyText) as unknown; }
        catch { return reply(res, 400, { ok: false, error: "invalid JSON" }); }
        if (typeof body !== "object" || body === null || Array.isArray(body)) return reply(res, 400, { ok: false, error: "request body must be an object" });
        const values = body as Record<string, unknown>;
        const sender = memberPrincipal({ agent: values.sender });
        const recipient = memberPrincipal({ agent: values.recipient });
        if (!sender || !recipient) return reply(res, 400, { ok: false, error: "sender and recipient must be valid room agent handles" });
        const senderAccess = protocolLedger.authorizeAction(sender, LOCAL_AWARE_ROOM_ID);
        if (!senderAccess.ok) return reply(res, 403, { ok: false, error: senderAccess.error });
        const recipientAccess = protocolLedger.authorizeAction(recipient, LOCAL_AWARE_ROOM_ID);
        if (!recipientAccess.ok) return reply(res, 403, { ok: false, error: `recipient ${recipientAccess.error}` });
        return reply(res, 200, { ok: true });
      }
      if (req.method === "POST" && requestUrl.pathname === "/web/protocol") {
        if (!ensureProtocolJournalDurable()) return reply(res, 503, { ok: false, error: "AWARE policy state is not durable; refusing protocol updates" });
        const bodyText = await readBody(req);
        if (bodyText === null) return reply(res, 413, { ok: false, error: "protocol message exceeds broker limit" });
        let frame: unknown;
        try { frame = JSON.parse(bodyText) as unknown; }
        catch { return reply(res, 400, { ok: false, error: "protocol message is not valid JSON" }); }
        const accepted = protocolLedger.accept(frame, { principalId: `owner:${ownerId}` });
        if (!accepted.ok) return reply(res, 400, { ok: false, error: accepted.error });
        if (!persistProtocolLedger()) return reply(res, 503, { ok: false, error: "could not persist AWARE policy state" });
        // The accepted frame is returned and retained in the local protocol feed for subscribers.
        return reply(res, 200, { ok: true, message: accepted.message });
      }
      if (req.method === "POST" && ["/web/aware/members/invite", "/web/aware/members/remove", "/web/aware/disclosures/decision"].includes(requestUrl.pathname)) {
        const bodyText = await readBody(req);
        if (bodyText === null) return reply(res, 413, { ok: false, error: "request too large" });
        let body: unknown;
        try { body = JSON.parse(bodyText) as unknown; }
        catch { return reply(res, 400, { ok: false, error: "invalid json object" }); }
        if (typeof body !== "object" || body === null || Array.isArray(body)) return reply(res, 400, { ok: false, error: "request body must be an object" });
        const ownerResult = await handleOwnerRequest({ path: requestUrl.pathname, method: "POST", body: body as Record<string, unknown> });
        const ok = ownerResult.ok === true;
        return reply(res, ok ? 200 : 400, ownerResult);
      }
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
        // Agent-to-agent traffic for the pill's thread; display only, it can never become a human-typed message.
        if (body.owner === undefined) options.ui?.onActivity({ kind: "message", agent: body.agent, provider: body.provider, sessionId: body.sessionId, to: body.to, text: body.text });
        return reply(res, 200, { ok: true, displayed: accepted });
      }
      if (req.method === "POST" && requestUrl.pathname === "/web/agent-done") {
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
            typeof body.sessionId !== "string" || body.sessionId.length === 0 || body.sessionId.length > 128) {
          return reply(res, 400, { ok: false, error: "invalid agent-done notice" });
        }
        const marked = await broker.markAgentDone(body.agent, body.provider, body.sessionId);
        return reply(res, 200, { ok: true, marked });
      }
      if (!authority) return reply(res, 503, { ok: false, error: "web authority is not configured" });

      if (req.method === "GET" && requestUrl.pathname === "/web/pending") return reply(res, 200, { requests: authority.pendingRequests() });
      if (req.method === "GET" && requestUrl.pathname === "/web/grants") return reply(res, 200, { grants: authority.grants() });
      if (req.method === "GET" && requestUrl.pathname === "/web/actions/pending") return reply(res, 200, { actions: broker.pendingApprovals() });
        if (req.method === "GET" && requestUrl.pathname === "/web/audit") {
        const entries = authority.audit();
        const anchor = authority.auditAnchor();
        return reply(res, 200, requestUrl.searchParams.get("verify") === "1" ? { entries, anchor, verification: verifyAudit(entries, anchor) } : { entries, anchor });
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
    if (req.method !== "POST" || (req.url !== "/cmd" && req.url !== "/batch")) return reply(res, 404, { ok: false, error: "not found" });
    if (req.headers.origin) return reply(res, 403, { ok: false, error: "browser-originated requests are refused" });
    if (!sameSecret(req.headers["x-m9r-key"] as string | undefined, options.key)) {
      return reply(res, 401, { ok: false, error: "missing or wrong key" });
    }
    const body = await readBody(req);
    if (body === null) return reply(res, 413, { ok: false, error: "request too large" });
    let parsed: WebRequest | WebBatchRequest;
    try {
      parsed = JSON.parse(body) as WebRequest;
    } catch {
      return reply(res, 400, { ok: false, error: "invalid json" });
    }
    const principalId = principalForAction(parsed);
    if (!principalId) return reply(res, 400, { ok: false, error: "AWARE participant identity is missing or invalid" });
    if (!ensureProtocolJournalDurable()) return reply(res, 503, { ok: false, error: "AWARE policy state is not durable; browser action is refused" });
    const membership = protocolLedger.authorizeAction(principalId, LOCAL_AWARE_ROOM_ID);
    if (!membership.ok) {
      const currentMember = protocolLedger.members(LOCAL_AWARE_ROOM_ID).find((member) => member.principalId === principalId);
      if (!currentMember) {
        const joinRequest = makeProtocolFrame("membership", principalId, {
          room_id: LOCAL_AWARE_ROOM_ID, member_id: principalId, state: "requested", requested_by: principalId, quiet_until_invited: true,
        });
        const requested = acceptProtocolFrame(joinRequest, principalId);
        if (!requested.ok) return reply(res, 503, { ok: false, error: requested.error });
      }
      return reply(res, 200, { ok: false, error: membership.error });
    }
    const ready = await waitForExtensionReady(options.extensionConnectTimeoutMs ?? 30_000);
    if (!ready) return reply(res, 200, { ok: false, error: "the browser extension did not become ready before the connection wait expired" });
    const batch = req.url === "/batch";
    const result = batch ? await broker.submitBatch(parsed as unknown as WebBatchRequest) : await broker.submit(parsed as WebRequest);
    const disclosed = disclosureContent(parsed, result, batch);
    if (disclosed !== null) {
      let serialized: string;
      try { serialized = stableJson(disclosed); }
      catch { return reply(res, 200, { ok: false, error: "AWARE refused page disclosure because its result could not be safely fingerprinted" }); }
      if (Buffer.byteLength(serialized, "utf8") > MAX_EXTENSION_MESSAGE_BYTES) {
        return reply(res, 200, { ok: false, error: "AWARE refused page disclosure because the result exceeds the bounded disclosure limit" });
      }
      const digest = createHash("sha256").update(serialized, "utf8").digest("hex");
      const disclosure = protocolLedger.authorizeDisclosure({ principalId, sessionId: LOCAL_AWARE_ROOM_ID, digest, audience: [principalId] });
      if (!disclosure.ok) {
        if (disclosure.denied) return reply(res, 200, { ok: false, error: disclosure.error });
        const pending = protocolLedger.pendingDisclosures(LOCAL_AWARE_ROOM_ID).find((frame) =>
          frame.payload.asked_by === principalId && frame.payload.proposed_text_digest === digest &&
          Array.isArray(frame.payload.audience) && frame.payload.audience.includes(principalId));
        const requestId = typeof pending?.payload.request_id === "string" ? pending.payload.request_id : randomUUID();
        if (!pending) {
          const resultRecord = result as unknown as Record<string, unknown>;
          const resultData = resultRecord.data;
          const pageUrl = typeof resultRecord.url === "string" ? resultRecord.url
            : typeof resultData === "object" && resultData !== null && !Array.isArray(resultData) && typeof (resultData as Record<string, unknown>).url === "string"
              ? (resultData as Record<string, unknown>).url as string : undefined;
          const frame = makeProtocolFrame("disclosure-request", principalId, {
            request_id: requestId,
            asked_by: principalId,
            subject: `${(parsed as WebRequest).action ?? "web action"} result${originOf(pageUrl) ? ` from ${originOf(pageUrl)}` : ""}`.slice(0, 200),
            data_class: "room_content",
            audience: [principalId],
            proposed_text_digest: digest,
            expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
          });
          const requested = acceptProtocolFrame(frame, principalId);
          if (!requested.ok) return reply(res, 503, { ok: false, error: requested.error });
        }
        return reply(res, 200, { ok: false, error: `AWARE disclosure requires owner approval; request_id=${requestId}; digest=${digest}` });
      }
    }
    return reply(res, 200, result);
  });

  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_EXTENSION_MESSAGE_BYTES });
  const uiSinks = new Map<WebSocket, (state: UiState) => boolean>();

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
          // The only door for human-typed web messages: the ready, origin-checked extension socket.
          if (isUiMessage(message)) {
            if (!uiSinks.has(ws)) uiSinks.set(ws, (state: UiState) => { if (extension !== ws || ws.readyState !== WebSocket.OPEN) return false; ws.send(JSON.stringify(state)); return true; });
            options.ui?.handleExtensionMessage(message, uiSinks.get(ws));
            return;
          }
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
        options.ui?.unsubscribe(uiSinks.get(ws));
        uiSinks.delete(ws);
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
      const ownerClosed = ownerServer
        ? new Promise<void>((done) => ownerServer.close(() => done()))
        : Promise.resolve();
      const httpClosed = new Promise<void>((done) => server.close(() => done()));
      void Promise.all([ownerClosed, httpClosed]).then(() => resolve());
      (ownerServer as (typeof ownerServer) & { closeAllConnections?: () => void } | null)?.closeAllConnections?.();
      server.closeAllConnections();
    });
    return closePromise;
  };
  closeServer = close;
  return { port, close };
}
