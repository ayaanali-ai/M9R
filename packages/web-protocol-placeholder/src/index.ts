export const M9R_WEB_PROTOCOL_VERSION = "m9r-web/0" as const;
export const MAX_PROTOCOL_FRAME_BYTES = 16 * 1024;
export const MAX_PROTOCOL_LEDGER_FRAMES = 10_000;

export const M9R_WEB_PROTOCOL_TYPES = [
  "post", "get", "reply", "subscribe", "request-context", "share-artifact", "ask",
  "presence", "cursor", "claim", "release", "approval-request", "approval-decision",
  "stop-all", "audit-entry", "grant",
] as const;
export type ProtocolMessageType = (typeof M9R_WEB_PROTOCOL_TYPES)[number];

export interface ProtocolMessage {
  protocol: typeof M9R_WEB_PROTOCOL_VERSION;
  message_id: string;
  session_id: string;
  sender: { principal_id: string; key_id: string };
  sequence: number;
  created_at: string;
  causal: { lamport: number; observed: string[] };
  message_type: ProtocolMessageType;
  payload: Record<string, unknown>;
  signature: string;
}

export type ProtocolValidation = { ok: true; message: ProtocolMessage } | { ok: false; error: string };

export interface ProtocolValidationOptions {
  nowMs?: number;
  authenticatedPrincipalId?: string;
  maxBytes?: number;
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const boundedString = (value: unknown, max: number, min = 1): value is string => typeof value === "string" && value.length >= min && value.length <= max;
const dateMs = (value: unknown): number | null => typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const fail = (error: string): ProtocolValidation => ({ ok: false, error });

function validPath(value: unknown): value is string {
  if (!boundedString(value, 2048) || !value.startsWith("/")) return false;
  try { const parsed = new URL(value, "https://m9r.invalid"); return parsed.pathname === value && !parsed.search && !parsed.hash; }
  catch { return false; }
}

function validSite(value: unknown): value is string {
  if (!boundedString(value, 2048)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password && url.origin === value;
  } catch { return false; }
}

function validTarget(value: unknown): boolean {
  if (!record(value)) return false;
  const allowed = new Set(["tab_id", "path", "scope", "key", "selector", "x", "y"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  if (value.tab_id !== undefined && !boundedString(value.tab_id, 128)) return false;
  if (value.path !== undefined && !validPath(value.path)) return false;
  if (value.scope !== undefined && !["field", "form", "tab"].includes(String(value.scope))) return false;
  if (value.key !== undefined && !boundedString(value.key, 512)) return false;
  if (value.selector !== undefined && !boundedString(value.selector, 512)) return false;
  if (value.x !== undefined && (typeof value.x !== "number" || value.x < 0 || value.x > 1)) return false;
  if (value.y !== undefined && (typeof value.y !== "number" || value.y < 0 || value.y > 1)) return false;
  if ((value.x === undefined) !== (value.y === undefined)) return false;
  return true;
}

function validPayload(type: ProtocolMessageType, payload: Record<string, unknown>, nowMs: number): string | null {
  const keys = Object.keys(payload);
  const only = (...allowed: string[]) => keys.every((key) => allowed.includes(key));
  const text = (key: string, max = 4000) => boundedString(payload[key], max);
  switch (type) {
    case "post": return only("text", "to", "depends_on") && text("text") && (payload.to === undefined || boundedString(payload.to, 128)) && validIdList(payload.depends_on) ? null : "post payload is invalid";
    case "get": return only("resource", "query") && boundedString(payload.resource, 128) && (payload.query === undefined || (record(payload.query) && Object.keys(payload.query).length <= 32)) ? null : "get payload is invalid";
    case "reply": return only("in_reply_to", "text") && boundedString(payload.in_reply_to, 128) && text("text") ? null : "reply payload is invalid";
    case "subscribe": return only("room_id", "cursor") && boundedString(payload.room_id, 128) && (payload.cursor === undefined || payload.cursor === null || boundedString(payload.cursor, 128)) ? null : "subscribe payload is invalid";
    case "request-context": return only("site", "path", "context_kind") && validSite(payload.site) && validPath(payload.path) && (payload.context_kind === undefined || ["page", "selection", "accessibility"].includes(String(payload.context_kind))) ? null : "request-context payload is invalid";
    case "share-artifact": return only("artifact_id", "media_type", "digest", "label") && boundedString(payload.artifact_id, 128) && boundedString(payload.media_type, 128) && typeof payload.digest === "string" && /^[a-f0-9]{64}$/.test(payload.digest) && (payload.label === undefined || boundedString(payload.label, 200)) ? null : "share-artifact payload is invalid";
    case "ask": return only("question_id", "to", "question") && boundedString(payload.question_id, 128) && boundedString(payload.to, 128) && text("question") ? null : "ask payload is invalid";
    case "presence": return only("agent", "provider", "url", "action", "seq", "target") && boundedString(payload.agent, 80) && boundedString(payload.provider, 80) && validHttpUrl(payload.url) && ["open", "read", "click", "type", "submit"].includes(String(payload.action)) && Number.isSafeInteger(payload.seq) && (payload.seq as number) >= 0 && (payload.target === undefined || validTarget(payload.target)) ? null : "presence payload is invalid";
    case "cursor": return only("tab_id", "target") && boundedString(payload.tab_id, 128) && validCursorTarget(payload.target) ? null : "cursor payload is invalid";
    case "claim": return only("claim_id", "tab_id", "scope", "expires_at") && boundedString(payload.claim_id, 128) && boundedString(payload.tab_id, 128) && validClaimScope(payload.scope) && validFuture(payload.expires_at, nowMs) ? null : "claim payload is invalid or expired";
    case "release": return only("claim_id") && boundedString(payload.claim_id, 128) ? null : "release payload is invalid";
    case "approval-request": return only("operation_id", "action", "target", "expires_at") && boundedString(payload.operation_id, 128) && boundedString(payload.action, 80) && validTarget(payload.target) && validFuture(payload.expires_at, nowMs) ? null : "approval-request payload is invalid or expired";
    case "approval-decision": return only("operation_id", "decision", "approver", "expires_at") && boundedString(payload.operation_id, 128) && ["approve", "deny"].includes(String(payload.decision)) && boundedString(payload.approver, 128) && (payload.expires_at === undefined || validFuture(payload.expires_at, nowMs)) ? null : "approval-decision payload is invalid or expired";
    case "stop-all": return only("reason") && boundedString(payload.reason, 500) ? null : "stop-all payload is invalid";
    case "audit-entry": return only("event_id", "event_type", "previous_hash", "hash", "target", "depends_on") && boundedString(payload.event_id, 128) && boundedString(payload.event_type, 128) && (payload.previous_hash === null || isHash(payload.previous_hash)) && isHash(payload.hash) && (payload.target === undefined || validTarget(payload.target)) && validIdList(payload.depends_on) ? null : "audit-entry payload is invalid";
    case "grant": return only("site", "path", "actions", "expires_at", "max_uses", "use_count") && validSite(payload.site) && validPath(payload.path) && validActions(payload.actions) && validFuture(payload.expires_at, nowMs) && Number.isSafeInteger(payload.max_uses) && (payload.max_uses as number) > 0 && Number.isSafeInteger(payload.use_count) && (payload.use_count as number) >= 0 && (payload.use_count as number) < (payload.max_uses as number) ? null : "grant is invalid, expired, or its use count is exhausted";
  }
}

function validHttpUrl(value: unknown): boolean {
  if (!boundedString(value, 2048)) return false;
  try { const url = new URL(value); return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password; }
  catch { return false; }
}
function validFuture(value: unknown, nowMs: number): boolean { const expiry = dateMs(value); return expiry !== null && expiry > nowMs; }
function validIdList(value: unknown): boolean { return value === undefined || (Array.isArray(value) && value.length <= 32 && value.every((item) => boundedString(item, 128))); }
function isHash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function validActions(value: unknown): boolean { return Array.isArray(value) && value.length > 0 && value.length <= 16 && new Set(value).size === value.length && value.every((item) => ["read", "click", "type", "open", "submit"].includes(String(item))); }
function validCursorTarget(value: unknown): boolean {
  if (!record(value)) return false;
  if (Object.keys(value).some((key) => !["selector", "x", "y"].includes(key))) return false;
  if (value.selector !== undefined && !boundedString(value.selector, 512)) return false;
  if (value.x !== undefined && (typeof value.x !== "number" || value.x < 0 || value.x > 1)) return false;
  if (value.y !== undefined && (typeof value.y !== "number" || value.y < 0 || value.y > 1)) return false;
  return (typeof value.selector === "string") !== (typeof value.x === "number" && typeof value.y === "number");
}
function validClaimScope(value: unknown): boolean {
  if (!record(value) || Object.keys(value).some((key) => !["kind", "key", "shared_with"].includes(key))) return false;
  if (!["field", "form", "tab"].includes(String(value.kind))) return false;
  if (value.kind !== "tab" && !boundedString(value.key, 512)) return false;
  return (value.shared_with === undefined || (Array.isArray(value.shared_with) && value.shared_with.length <= 32 && value.shared_with.every((entry) => boundedString(entry, 128))));
}

export function validateProtocolMessage(input: unknown, options: ProtocolValidationOptions = {}): ProtocolValidation {
  if (!record(input)) return fail("message must be a JSON object");
  let serialized: string;
  try { serialized = JSON.stringify(input); } catch { return fail("message is not JSON serializable"); }
  const maxBytes = options.maxBytes ?? MAX_PROTOCOL_FRAME_BYTES;
  if (new TextEncoder().encode(serialized).byteLength > maxBytes) return fail("message exceeds the protocol size limit");
  const nowMs = options.nowMs ?? Date.now();
  if (input.protocol !== M9R_WEB_PROTOCOL_VERSION) return fail("unsupported protocol version");
  if (!boundedString(input.message_id, 128) || !boundedString(input.session_id, 128)) return fail("message or session ID is invalid");
  if (!record(input.sender) || !boundedString(input.sender.principal_id, 128) || !boundedString(input.sender.key_id, 128)) return fail("sender identity is invalid");
  if (options.authenticatedPrincipalId && input.sender.principal_id !== options.authenticatedPrincipalId) return fail("spoofed sender: transport identity does not match envelope");
  if (!Number.isSafeInteger(input.sequence) || (input.sequence as number) < 1) return fail("sequence must be a positive safe integer");
  if (dateMs(input.created_at) === null) return fail("created_at must be an ISO date-time");
  if (!record(input.causal) || !Number.isSafeInteger(input.causal.lamport) || (input.causal.lamport as number) < 0 || !Array.isArray(input.causal.observed) || input.causal.observed.length > 128 || !input.causal.observed.every((entry) => boundedString(entry, 128))) return fail("causal metadata is invalid");
  if (typeof input.message_type !== "string" || !(M9R_WEB_PROTOCOL_TYPES as readonly string[]).includes(input.message_type)) return fail("unknown message type");
  if (!record(input.payload) || !boundedString(input.signature, 1024)) return fail("payload or signature is invalid");
  const payloadError = validPayload(input.message_type as ProtocolMessageType, input.payload, nowMs);
  if (payloadError) return fail(payloadError);
  if (Object.keys(input).some((key) => !["protocol", "message_id", "session_id", "sender", "sequence", "created_at", "causal", "message_type", "payload", "signature"].includes(key))) return fail("message contains unsupported fields");
  return { ok: true, message: input as unknown as ProtocolMessage };
}

export interface ProtocolLedgerOptions { now?: () => number; maxFrames?: number }
export interface AuthenticatedPrincipal { principalId: string }
export interface ProtocolLedger {
  accept(input: unknown, auth: AuthenticatedPrincipal): ProtocolValidation;
  emit(input: unknown, auth: AuthenticatedPrincipal): ProtocolValidation;
  snapshot(): ProtocolMessage[];
}

/** Small local reference ledger; auth principal comes from the transport, never from the frame itself. */
export function createProtocolLedger(options: ProtocolLedgerOptions = {}): ProtocolLedger {
  const now = options.now ?? Date.now;
  const maxFrames = options.maxFrames ?? MAX_PROTOCOL_LEDGER_FRAMES;
  const messages: ProtocolMessage[] = [];
  const seenIds = new Set<string>();
  const lastSequence = new Map<string, number>();

  function recordFrame(input: unknown, auth: AuthenticatedPrincipal): ProtocolValidation {
    const checked = validateProtocolMessage(input, { nowMs: now(), authenticatedPrincipalId: auth.principalId });
    if (!checked.ok) return checked;
    const { message } = checked;
    const sequenceKey = `${message.session_id}\u0000${message.sender.principal_id}`;
    const previousSequence = lastSequence.get(sequenceKey) ?? 0;
    if (seenIds.has(message.message_id)) return fail("replayed message ID");
    if (message.sequence <= previousSequence) return fail("replayed or out-of-order sequence");
    if (messages.length >= maxFrames) return fail("protocol ledger is full; refusing without losing replay history");
    seenIds.add(message.message_id);
    lastSequence.set(sequenceKey, message.sequence);
    messages.push(message);
    return checked;
  }

  return {
    accept: recordFrame,
    emit: recordFrame,
    snapshot: () => messages.map((message) => structuredClone(message)),
  };
}
