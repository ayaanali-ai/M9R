export const M9R_WEB_PROTOCOL_VERSION = "m9r-web/0" as const;
export const MAX_PROTOCOL_FRAME_BYTES = 16 * 1024;
export const MAX_PROTOCOL_LEDGER_FRAMES = 10_000;
/** Local broker persistence cap; keeps its protocol journal bounded independently of remote room limits. */
export const MAX_AWARE_PROTOCOL_FRAMES = 2_048;

export const M9R_WEB_PROTOCOL_TYPES = [
  "post", "get", "reply", "subscribe", "request-context", "share-artifact", "ask",
  "presence", "cursor", "claim", "release", "approval-request", "approval-decision",
  "stop-all", "audit-entry", "grant", "disclosure-request", "disclosure-decision", "membership",
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
    case "ask": return only("question_id", "to", "question", "requested_by") && boundedString(payload.question_id, 128) && boundedString(payload.to, 128) && text("question") && boundedString(payload.requested_by, 128) ? null : "ask payload is invalid or missing request attribution";
    case "presence": return only("agent", "provider", "url", "action", "seq", "target") && boundedString(payload.agent, 80) && boundedString(payload.provider, 80) && validHttpUrl(payload.url) && ["open", "read", "click", "type", "submit"].includes(String(payload.action)) && Number.isSafeInteger(payload.seq) && (payload.seq as number) >= 0 && (payload.target === undefined || validTarget(payload.target)) ? null : "presence payload is invalid";
    case "cursor": return only("tab_id", "target") && boundedString(payload.tab_id, 128) && validCursorTarget(payload.target) ? null : "cursor payload is invalid";
    case "claim": return only("claim_id", "tab_id", "scope", "expires_at") && boundedString(payload.claim_id, 128) && boundedString(payload.tab_id, 128) && validClaimScope(payload.scope) && validFuture(payload.expires_at, nowMs) ? null : "claim payload is invalid or expired";
    case "release": return only("claim_id") && boundedString(payload.claim_id, 128) ? null : "release payload is invalid";
    case "approval-request": return only("operation_id", "action", "target", "expires_at") && boundedString(payload.operation_id, 128) && boundedString(payload.action, 80) && validTarget(payload.target) && validFuture(payload.expires_at, nowMs) ? null : "approval-request payload is invalid or expired";
    case "approval-decision": return only("operation_id", "decision", "approver", "expires_at") && boundedString(payload.operation_id, 128) && ["approve", "deny"].includes(String(payload.decision)) && boundedString(payload.approver, 128) && (payload.expires_at === undefined || validFuture(payload.expires_at, nowMs)) ? null : "approval-decision payload is invalid or expired";
    case "stop-all": return only("reason") && boundedString(payload.reason, 500) ? null : "stop-all payload is invalid";
    case "audit-entry": return only("event_id", "event_type", "previous_hash", "hash", "target", "depends_on") && boundedString(payload.event_id, 128) && boundedString(payload.event_type, 128) && (payload.previous_hash === null || isHash(payload.previous_hash)) && isHash(payload.hash) && (payload.target === undefined || validTarget(payload.target)) && validIdList(payload.depends_on) ? null : "audit-entry payload is invalid";
    case "grant": return only("site", "path", "actions", "expires_at", "max_uses", "use_count", "spend_cap") && validSite(payload.site) && validPath(payload.path) && validActions(payload.actions) && validFuture(payload.expires_at, nowMs) && Number.isSafeInteger(payload.max_uses) && (payload.max_uses as number) > 0 && Number.isSafeInteger(payload.use_count) && (payload.use_count as number) >= 0 && (payload.use_count as number) < (payload.max_uses as number) && validSpendCap(payload.spend_cap) ? null : "grant is invalid, expired, exhausted, or missing a spend cap";
    case "disclosure-request": return only("request_id", "asked_by", "subject", "data_class", "audience", "proposed_text_digest", "expires_at") && boundedString(payload.request_id, 128) && boundedString(payload.asked_by, 128) && boundedString(payload.subject, 200) && validDisclosureClass(payload.data_class) && validAudience(payload.audience) && isHash(payload.proposed_text_digest) && validFuture(payload.expires_at, nowMs) ? null : "disclosure request is invalid, expired, or missing request attribution";
    case "disclosure-decision": return only("request_id", "decision", "decided_by", "receipt_id") && boundedString(payload.request_id, 128) && ["approve", "deny"].includes(String(payload.decision)) && boundedString(payload.decided_by, 128) && boundedString(payload.receipt_id, 128) ? null : "disclosure decision is invalid or missing its receipt";
    case "membership": return only("room_id", "member_id", "state", "requested_by", "invited_by", "quiet_until_invited", "expires_at") && boundedString(payload.room_id, 128) && boundedString(payload.member_id, 128) && ["requested", "invited", "active", "left", "removed", "denied"].includes(String(payload.state)) && (payload.requested_by === undefined || boundedString(payload.requested_by, 128)) && (payload.invited_by === undefined || boundedString(payload.invited_by, 128)) && (payload.quiet_until_invited === undefined || typeof payload.quiet_until_invited === "boolean") && (payload.expires_at === undefined || validFuture(payload.expires_at, nowMs)) && (payload.state !== "requested" || (payload.quiet_until_invited === true && boundedString(payload.requested_by, 128))) && (payload.state !== "active" || boundedString(payload.invited_by, 128)) ? null : "membership is invalid or a join/invite is missing attribution";
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
function validSpendCap(value: unknown): boolean {
  return record(value) && Object.keys(value).every((key) => ["currency", "max_minor", "used_minor"].includes(key))
    && boundedString(value.currency, 12) && /^[A-Z]{3}$/.test(value.currency)
    && Number.isSafeInteger(value.max_minor) && (value.max_minor as number) >= 0
    && Number.isSafeInteger(value.used_minor) && (value.used_minor as number) >= 0
    && (value.used_minor as number) <= (value.max_minor as number);
}
function validDisclosureClass(value: unknown): boolean { return ["room_content", "own_messages", "own_files_named", "account_facts"].includes(String(value)); }
function validAudience(value: unknown): boolean { return value === "room" || (Array.isArray(value) && value.length > 0 && value.length <= 32 && value.every((item) => boundedString(item, 128))); }
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

export interface ProtocolLedgerOptions {
  now?: () => number;
  maxFrames?: number;
  /** The room's owner, if known. When set, approval-decision and disclosure-decision must come from them, not from an
   * arbitrary member -- without it, only self-approval (deciding your own request) is refused. */
  ownerId?: string;
}
export interface AuthenticatedPrincipal { principalId: string }
export interface ProtocolLedger {
  accept(input: unknown, auth: AuthenticatedPrincipal): ProtocolValidation;
  emit(input: unknown, auth: AuthenticatedPrincipal): ProtocolValidation;
  /** Replays a persisted journal before serving requests. Historical expiry is evaluated at frame creation time. */
  restore(frames: readonly unknown[]): void;
  snapshot(): ProtocolMessage[];
  members(sessionId: string): Array<{ principalId: string; state: string; quietUntilInvited: boolean; expiresAt: number | null }>;
  pendingDisclosures(sessionId: string): ProtocolMessage[];
  authorizeAction(principalId: string, sessionId: string): { ok: true } | { ok: false; error: string };
  authorizeDisclosure(input: { principalId: string; sessionId: string; digest: string; audience: string[] }): { ok: true; receiptId: string } | { ok: false; error: string; denied?: boolean };
  /** True once a stop-all frame has been accepted. A caller wires this to actually halting the room; the ledger only
   * remembers that it happened, and keeps accepting stop-all even once full (see below). */
  isStopped(): boolean;
}

// Message types the quiet-until-invited / active-membership rule applies to: anything that speaks into the room. Reads
// of your own state, presence, claims and the membership/approval/disclosure control types themselves are exempt, or
// membership could never be granted (a member could never even ask to join).
const MEMBERSHIP_GATED_TYPES = new Set<ProtocolMessageType>(["post", "reply", "ask", "share-artifact"]);

/** Small local reference ledger; auth principal comes from the transport, never from the frame itself. */
export function createProtocolLedger(options: ProtocolLedgerOptions = {}): ProtocolLedger {
  const now = options.now ?? Date.now;
  const maxFrames = options.maxFrames ?? MAX_PROTOCOL_LEDGER_FRAMES;
  const messages: ProtocolMessage[] = [];
  const seenIds = new Set<string>();
  const lastSequence = new Map<string, number>();
  let stopped = false;

  // Enforced state the format validator alone cannot see: who is really a member (and whether they are still quiet
  // until invited), which approval/disclosure requests are still open, and how much of each spend cap has been used.
  const members = new Map<string, { roomId: string; principalId: string; state: string; quietUntilInvited: boolean; expiresAt: number | null }>();
  const openApprovals = new Map<string, { requestedBy: string; expiresAt: number }>();
  const openDisclosures = new Map<string, { message: ProtocolMessage; askedBy: string; dataClass: string; audience: "room" | string[]; digest: string; expiresAt: number }>();
  const disclosureDecisions = new Map<string, { askedBy: string; dataClass: string; audience: "room" | string[]; digest: string; expiresAt: number; receiptId: string; approved: boolean }>();
  const spend = new Map<string, number>();
  const membershipKey = (roomId: string, principalId: string) => `${roomId}\u0000${principalId}`;
  const disclosureKey = (sessionId: string, askedBy: string, digest: string, audience: "room" | string[]) =>
    `${sessionId}\u0000${askedBy}\u0000${digest}\u0000${audience === "room" ? "room" : [...audience].sort().join(",")}`;

  function semanticError(message: ProtocolMessage, principalId: string, replay = false): string | null {
    const type = message.message_type;
    const payload = message.payload;
    if (type === "membership") {
      // A membership frame declares its OWN state as fact; that is fine for "requested" (asking to join) but a
      // principal cannot unilaterally declare itself "active" -- only the room's owner may admit or remove someone.
      const state = String(payload.state);
      if (payload.room_id !== message.session_id) return "membership room_id must match the protocol session_id";
      if ((state === "requested" && (payload.member_id !== principalId || payload.requested_by !== principalId || payload.quiet_until_invited !== true)) ||
          (state === "left" && payload.member_id !== principalId)) return "a member may only request or leave its own membership";
      if (state !== "requested" && state !== "left" && options.ownerId && principalId !== options.ownerId) {
        return "only the room owner can change a member's state to anything but requesting to join or leaving";
      }
      if (state === "active" && payload.invited_by !== principalId) return "active membership must be attributed to the inviting owner";
      return null;
    }
    if (type === "approval-request") {
      if (openApprovals.has(String(payload.operation_id))) return "an approval request with this operation_id is already open";
      return null;
    }
    if (type === "approval-decision") {
      const open = openApprovals.get(String(payload.operation_id));
      if (!open) return "no open approval request matches this operation_id";
      if (open.expiresAt <= now()) return "the approval request has expired";
      if (payload.approver !== principalId) return "approval decision attribution must match the authenticated principal";
      if (open.requestedBy === principalId) return "a principal cannot approve its own request";
      if (options.ownerId && principalId !== options.ownerId) return "only the room owner may decide an approval request";
      return null;
    }
    if (type === "disclosure-request") {
      if (payload.asked_by !== principalId) return "a disclosure request must be attributed to its authenticated requester";
      if (openDisclosures.has(String(payload.request_id))) return "a disclosure request with this request_id already exists";
      return null;
    }
    if (type === "disclosure-decision") {
      const open = openDisclosures.get(String(payload.request_id));
      if (!open) return "no open disclosure request matches this request_id";
      if (open.expiresAt <= now() && !replay) return "the disclosure request has expired";
      if (payload.decided_by !== principalId) return "disclosure decision attribution must match the authenticated principal";
      if (options.ownerId && principalId !== options.ownerId) return "only the room owner may decide a disclosure request";
      return null;
    }
    if (type === "grant" && record(payload.spend_cap)) {
      const cap = payload.spend_cap as { currency: string; max_minor: number; used_minor: number };
      const key = `${message.session_id}\u0000${cap.currency}`;
      const already = spend.get(key) ?? 0;
      if (cap.used_minor < already) return "spend_cap.used_minor went backwards from what was already recorded";
      return null;
    }
    // Membership enforcement is opt-in via ownerId: a caller that has not told the ledger who the room's owner is has not
    // opted into gating speech by membership either, so every frame is treated as it always was (format-checked only) --
    // this keeps every existing caller's behavior exactly as it was until it deliberately wires ownerId through. The
    // owner never needs a membership record for their own room, the way a guest does.
    if (options.ownerId && principalId !== options.ownerId && MEMBERSHIP_GATED_TYPES.has(type)) {
      const member = members.get(membershipKey(message.session_id, principalId));
      if (!member || member.state !== "active") return `@${principalId} is not an active member of this room and cannot ${type} into it`;
      if (member.quietUntilInvited || (member.expiresAt !== null && member.expiresAt <= now())) return `@${principalId} is quiet until invited and has not been invited to speak yet`;
    }
    return null;
  }

  function applyEffect(message: ProtocolMessage): void {
    const payload = message.payload;
    switch (message.message_type) {
      case "membership":
        members.set(membershipKey(message.session_id, String(payload.member_id)), {
          roomId: message.session_id,
          principalId: String(payload.member_id),
          state: String(payload.state),
          quietUntilInvited: Boolean(payload.quiet_until_invited),
          expiresAt: dateMs(payload.expires_at) ?? null,
        });
        return;
      case "approval-request":
        openApprovals.set(String(payload.operation_id), { requestedBy: message.sender.principal_id, expiresAt: dateMs(payload.expires_at) ?? Infinity });
        return;
      case "approval-decision":
        openApprovals.delete(String(payload.operation_id));
        return;
      case "disclosure-request":
        openDisclosures.set(String(payload.request_id), {
          message,
          askedBy: String(payload.asked_by),
          dataClass: String(payload.data_class),
          audience: payload.audience as "room" | string[],
          digest: String(payload.proposed_text_digest),
          expiresAt: dateMs(payload.expires_at) ?? Infinity,
        });
        return;
      case "disclosure-decision": {
        const requestId = String(payload.request_id);
        const open = openDisclosures.get(requestId);
        if (open) {
          disclosureDecisions.set(disclosureKey(message.session_id, open.askedBy, open.digest, open.audience), {
            askedBy: open.askedBy,
            dataClass: open.dataClass,
            audience: open.audience,
            digest: open.digest,
            expiresAt: open.expiresAt,
            receiptId: String(payload.receipt_id),
            approved: payload.decision === "approve",
          });
        }
        openDisclosures.delete(requestId);
        return;
      }
      case "grant":
        if (record(payload.spend_cap)) {
          const cap = payload.spend_cap as { currency: string; used_minor: number };
          spend.set(`${message.session_id}\u0000${cap.currency}`, cap.used_minor);
        }
        return;
      case "stop-all":
        stopped = true;
        return;
    }
  }

  function recordFrame(input: unknown, auth: AuthenticatedPrincipal, replay = false): ProtocolValidation {
    const creationMs = replay && record(input) ? dateMs(input.created_at) : null;
    const checked = validateProtocolMessage(input, { nowMs: creationMs ?? now(), authenticatedPrincipalId: auth.principalId });
    if (!checked.ok) return checked;
    const { message } = checked;
    const isStopAll = message.message_type === "stop-all";
    const sequenceKey = `${message.session_id}\u0000${message.sender.principal_id}`;
    const previousSequence = lastSequence.get(sequenceKey) ?? 0;
    if (seenIds.has(message.message_id)) return fail("replayed message ID");
    if (message.sequence <= previousSequence) return fail("replayed or out-of-order sequence");
    // A full ledger must never be the reason the first stop-all is refused. Keep one emergency frame past
    // the ordinary cap. Once stopped, reject subsequent stop-all frames rather than accepting operations whose
    // replay IDs and sequence high-water marks cannot be durably appended to the bounded journal.
    if (isStopAll && stopped) return fail("stop-all has already been recorded");
    if (messages.length >= maxFrames && !isStopAll) return fail("protocol ledger is full; refusing without losing replay history");
    const semantic = semanticError(message, auth.principalId, replay);
    if (semantic) return fail(semantic);
    seenIds.add(message.message_id);
    lastSequence.set(sequenceKey, message.sequence);
    applyEffect(message);
    if (messages.length < maxFrames || (isStopAll && messages.length === maxFrames)) messages.push(message);
    return checked;
  }

  return {
    accept: recordFrame,
    emit: recordFrame,
    restore(frames: readonly unknown[]) {
      if (messages.length !== 0 || seenIds.size !== 0) throw new Error("protocol journal can only be restored into an empty ledger");
      if (frames.length > maxFrames + 1) throw new Error("persisted protocol journal exceeds its frame limit");
      if (frames.length === maxFrames + 1 && (!record(frames[maxFrames]) || frames[maxFrames].message_type !== "stop-all")) {
        throw new Error("persisted protocol journal overflow must end with one stop-all frame");
      }
      for (const frame of frames) {
        if (!record(frame) || !record(frame.sender) || typeof frame.sender.principal_id !== "string") throw new Error("persisted protocol journal contains an invalid frame");
        const result = recordFrame(frame, { principalId: frame.sender.principal_id }, true);
        if (!result.ok) throw new Error(`persisted protocol journal is invalid: ${result.error}`);
      }
    },
    snapshot: () => messages.map((message) => structuredClone(message)),
    members: (sessionId) => [...members.values()].filter((member) => member.roomId === sessionId).map((member) => ({
      principalId: member.principalId, state: member.state, quietUntilInvited: member.quietUntilInvited, expiresAt: member.expiresAt,
    })),
    pendingDisclosures: (sessionId) => [...openDisclosures.values()].filter((entry) => entry.message.session_id === sessionId && entry.expiresAt > now()).map((entry) => structuredClone(entry.message)),
    authorizeAction(principalId, sessionId) {
      if (!options.ownerId || principalId === options.ownerId) return { ok: true };
      const member = members.get(membershipKey(sessionId, principalId));
      if (!member || member.state !== "active") return { ok: false, error: `@${principalId} has no active room membership; a quiet join request is required` };
      if (member.quietUntilInvited || (member.expiresAt !== null && member.expiresAt <= now())) return { ok: false, error: `@${principalId} is quiet until invited` };
      return { ok: true };
    },
    authorizeDisclosure({ principalId, sessionId, digest, audience }) {
      const receipt = disclosureDecisions.get(disclosureKey(sessionId, principalId, digest, audience));
      if (!receipt || receipt.expiresAt <= now()) return { ok: false, error: "no unexpired owner-approved disclosure receipt matches this content" };
      if (!receipt.approved) return { ok: false, error: "the owner denied disclosure of this content", denied: true };
      return { ok: true, receiptId: receipt.receiptId };
    },
    isStopped: () => stopped,
  };
}
