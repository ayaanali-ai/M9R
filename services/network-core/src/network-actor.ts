import { DurableObject } from "cloudflare:workers";
import { ApiError, asObject, hashText, json, normalizeSlug, parseCursor, parseLimit, readJson, requireString, UUID_RE } from "./util";
import type { AgentScope, Env, NetworkRole } from "./types";

type SqlValue = string | number | null | ArrayBuffer;
interface Row extends Record<string, SqlValue> {}
interface AgentRow extends Row {
  agent_id: string; member_id: string; handle: string; provider: string; door: string;
  scopes_json: string; status: string; credential_hash: string | null; last_seen_at: string | null;
}
interface MemberRow extends Row {
  member_id: string; user_id: string | null; handle: string; display_name: string | null; role: string;
}
interface PairingRow extends Row {
  pairing_id: string; code_hash: string; member_id: string; member_handle: string;
  scopes_json: string; max_uses: number; uses: number; expires_at: number; status: string;
}
interface EventRow extends Row {
  event_id: string; event_sequence: number; thread_id: string | null; sender_agent_id: string;
  sender_handle: string; recipient_handle: string; event_type: string; body: string;
  attachments_json: string; meta_json: string; idempotency_key: string; created_at: string;
}
interface OutboxRow extends Row { outbox_id: number; kind: string; payload_json: string }

const VALID_PROVIDERS = new Set(["muse", "dots", "grok", "instinct", "codex", "custom"]);
const VALID_DOORS = new Set(["mcp", "web", "sms", "slack", "whatsapp", "cli", "custom"]);
const VALID_EVENT_TYPES = new Set(["message", "file", "task", "task_update", "presence"]);
const VALID_SCOPES = new Set(["read", "write"]);
const DAY = 86_400_000;
const MAX_EVENT_BODY = 20_000;
const MAX_EVENT_METADATA = 16_000;

function nowIso(): string { return new Date().toISOString(); }
function toJson(value: unknown): string { return JSON.stringify(value); }
function parseJson(value: string, fallback: unknown = null): unknown {
  try { return JSON.parse(value) as unknown; } catch { return fallback; }
}

function validateScopes(value: unknown, fallback: AgentScope[] = ["read", "write"]): AgentScope[] {
  const scopes = value === undefined ? fallback : value;
  if (!Array.isArray(scopes) || !scopes.includes("read") || scopes.some((item) => typeof item !== "string" || !VALID_SCOPES.has(item))) {
    throw new ApiError("scopes must include read and use only read/write.", 400, "INVALID_SCOPES");
  }
  return [...new Set(scopes as AgentScope[])];
}

function eventDto(row: EventRow, cursor?: number) {
  return {
    ...(cursor === undefined ? {} : { cursor: String(cursor) }),
    event_id: row.event_id,
    thread_id: row.thread_id,
    type: row.event_type,
    from: row.sender_handle,
    to: row.recipient_handle,
    body: row.body,
    attachments: parseJson(row.attachments_json, []),
    ts: row.created_at,
    idempotency_key: row.idempotency_key,
    meta: parseJson(row.meta_json, {}),
  };
}

export class NetworkActor extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const sql = ctx.storage.sql;
      sql.exec("CREATE TABLE IF NOT EXISTS network_meta (network_id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_user_id TEXT NOT NULL, settings_json TEXT NOT NULL, created_at TEXT NOT NULL)");
      sql.exec("CREATE TABLE IF NOT EXISTS members (member_id TEXT PRIMARY KEY, user_id TEXT, handle TEXT NOT NULL, display_name TEXT, role TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(user_id), UNIQUE(handle))");
      sql.exec("CREATE TABLE IF NOT EXISTS pairing_codes (pairing_id TEXT NOT NULL UNIQUE, code_hash TEXT PRIMARY KEY, member_id TEXT NOT NULL, scopes_json TEXT NOT NULL, max_uses INTEGER NOT NULL, uses INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL, status TEXT NOT NULL, issued_by_user_id TEXT NOT NULL, created_at TEXT NOT NULL)");
      sql.exec("CREATE TABLE IF NOT EXISTS agents (agent_id TEXT PRIMARY KEY, member_id TEXT NOT NULL, handle TEXT NOT NULL, provider TEXT NOT NULL, door TEXT NOT NULL, scopes_json TEXT NOT NULL, status TEXT NOT NULL, credential_hash TEXT, created_at TEXT NOT NULL, last_seen_at TEXT, UNIQUE(handle))");
      sql.exec("CREATE INDEX IF NOT EXISTS agents_member_id ON agents(member_id)");
      sql.exec("CREATE TABLE IF NOT EXISTS events (event_sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, thread_id TEXT, sender_agent_id TEXT NOT NULL, sender_handle TEXT NOT NULL, recipient_handle TEXT NOT NULL, event_type TEXT NOT NULL, body TEXT NOT NULL, attachments_json TEXT NOT NULL, meta_json TEXT NOT NULL, idempotency_key TEXT NOT NULL, created_at TEXT NOT NULL)");
      sql.exec("CREATE INDEX IF NOT EXISTS events_thread_sequence ON events(thread_id, event_sequence)");
      sql.exec("CREATE TABLE IF NOT EXISTS deliveries (agent_id TEXT NOT NULL, inbox_cursor INTEGER NOT NULL, event_id TEXT NOT NULL, PRIMARY KEY(agent_id, inbox_cursor), UNIQUE(agent_id, event_id))");
      sql.exec("CREATE TABLE IF NOT EXISTS inbox_counters (agent_id TEXT PRIMARY KEY, last_cursor INTEGER NOT NULL)");
      sql.exec("CREATE TABLE IF NOT EXISTS idempotency_keys (agent_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, payload_hash TEXT NOT NULL, event_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(agent_id, idempotency_key))");
      sql.exec("CREATE TABLE IF NOT EXISTS approvals (approval_id TEXT PRIMARY KEY, requester_agent_id TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL, thread_id TEXT, status TEXT NOT NULL, requested_at TEXT NOT NULL, decided_at TEXT, decided_by_user_id TEXT)");
      sql.exec("CREATE TABLE IF NOT EXISTS audit_log (audit_sequence INTEGER PRIMARY KEY AUTOINCREMENT, audit_id TEXT NOT NULL UNIQUE, action TEXT NOT NULL, actor_kind TEXT NOT NULL, actor_id TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT, context_json TEXT NOT NULL, created_at TEXT NOT NULL)");
      sql.exec("CREATE TABLE IF NOT EXISTS mirror_outbox (outbox_id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL)");
    });
  }

  override async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/_internal/bootstrap") return await this.bootstrap(request);
      if (request.method === "POST" && url.pathname === "/_internal/register") return await this.register(request);
      if (request.method === "POST" && url.pathname === "/_internal/prune") return await this.prune();
      const userId = request.headers.get("x-m9r-human-user");
      const rawAgentToken = request.headers.get("x-m9r-agent-token");
      if (!userId && !rawAgentToken) throw new ApiError("Authentication is required.", 401, "UNAUTHORIZED");
      return await this.dispatch(request, userId, rawAgentToken);
    } catch (error) {
      if (error instanceof ApiError) return json({ error: error.message, code: error.code }, error.status);
      console.error("Network actor request failed:", error instanceof Error ? error.name : "unknown");
      return json({ error: "The network service could not complete the request.", code: "NETWORK_STORAGE_ERROR" }, 503);
    }
  }

  private get sql() { return this.ctx.storage.sql; }

  private async bootstrap(request: Request): Promise<Response> {
    const body = await readJson(request);
    const networkId = requireString(body.network_id, "network_id", 36, 36);
    const ownerUserId = requireString(body.owner_user_id, "owner_user_id", 1, 128);
    const name = requireString(body.name, "name", 1, 100);
    if (!UUID_RE.test(networkId)) throw new ApiError("network_id must be a UUID.", 400, "INVALID_NETWORK_ID");
    const ownerHandle = normalizeSlug(body.owner_handle ?? "owner", "owner_handle");
    const ownerDisplayName = typeof body.owner_display_name === "string" ? body.owner_display_name.trim().slice(0, 80) || null : null;
    const createdAt = nowIso();
    const existing = this.sql.exec<Row>("SELECT network_id, name, owner_user_id FROM network_meta WHERE network_id = ?", networkId).toArray()[0];
    if (existing) {
      if (existing.owner_user_id !== ownerUserId) throw new ApiError("The network already exists.", 409, "NETWORK_EXISTS");
      return json({ network_id: networkId, name: existing.name, duplicate: true });
    }
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("INSERT INTO network_meta (network_id, name, owner_user_id, settings_json, created_at) VALUES (?, ?, ?, ?, ?)", networkId, name, ownerUserId, toJson({ join_policy: "invite_only", event_retention_days: 90 }), createdAt);
      this.sql.exec("INSERT INTO members (member_id, user_id, handle, display_name, role, created_at) VALUES (?, ?, ?, ?, 'owner', ?)", crypto.randomUUID(), ownerUserId, ownerHandle, ownerDisplayName, createdAt);
      this.addAudit("network.created", "human", ownerUserId, "network", networkId, {});
    });
    await this.kickOutbox();
    return json({ network_id: networkId, name, duplicate: false }, 201);
  }

  private async register(request: Request): Promise<Response> {
    const body = await readJson(request);
    const network = this.sql.exec<Row>("SELECT network_id FROM network_meta LIMIT 1").toArray()[0];
    if (!network) throw new ApiError("The network does not exist.", 404, "NETWORK_NOT_FOUND");
    const networkId = String(network.network_id);
    const codeHash = requireString(body.code_hash, "code_hash", 64, 64);
    const agentName = normalizeSlug(body.agent_name, "agent_name");
    const provider = requireString(body.provider, "provider", 1, 32).toLowerCase();
    if (!VALID_PROVIDERS.has(provider)) throw new ApiError("provider must be muse, dots, grok, instinct, codex, or custom.", 400, "INVALID_PROVIDER");
    const door = typeof body.door === "undefined" ? "mcp" : requireString(body.door, "door", 1, 32).toLowerCase();
    if (!VALID_DOORS.has(door)) throw new ApiError("door is not supported.", 400, "INVALID_DOOR");
    const agentId = requireString(body.agent_id, "agent_id", 36, 36);
    const token = requireString(body.credential, "credential", 80, 220);
    if (!UUID_RE.test(agentId) || !token.startsWith(`m9rn.${networkId}.${agentId}.`)) throw new ApiError("The registration credential is invalid.", 400, "INVALID_CREDENTIAL");
    const credentialHash = await hashText(token);
    const timestamp = nowIso();
    let result: Record<string, unknown> | null = null;
    let routeConsumed = false;
    this.ctx.storage.transactionSync(() => {
      const pairing = this.sql.exec<PairingRow>("SELECT pairing_id, code_hash, member_id, scopes_json, max_uses, uses, expires_at, status FROM pairing_codes WHERE code_hash = ?", codeHash).toArray()[0];
      if (!pairing || pairing.status !== "active" || pairing.expires_at <= Date.now() || pairing.uses >= pairing.max_uses) {
        throw new ApiError("The pairing code is invalid, expired, or already used.", 400, "PAIRING_CODE_UNAVAILABLE");
      }
      const member = this.sql.exec<MemberRow>("SELECT member_id, handle, display_name FROM members WHERE member_id = ?", pairing.member_id).toArray()[0];
      if (!member) throw new ApiError("The pairing code's member slot is unavailable.", 409, "PAIRING_MEMBER_UNAVAILABLE");
      const base = `${member.handle}/${agentName}`;
      let handle = `@${base}`;
      let suffix = 2;
      while (this.sql.exec("SELECT 1 FROM agents WHERE handle = ?", handle).toArray().length) {
        handle = `@${member.handle}/${agentName.slice(0, Math.max(1, 38 - String(suffix).length - 1))}-${suffix++}`;
      }
      this.sql.exec("UPDATE pairing_codes SET uses = uses + 1, status = CASE WHEN uses + 1 >= max_uses THEN 'consumed' ELSE status END WHERE code_hash = ?", codeHash);
      routeConsumed = pairing.uses + 1 >= pairing.max_uses;
      const scopes = validateScopes(parseJson(pairing.scopes_json, ["read", "write"]));
      this.sql.exec("INSERT INTO agents (agent_id, member_id, handle, provider, door, scopes_json, status, credential_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)", agentId, member.member_id, handle, provider, door, toJson(scopes), credentialHash, timestamp, timestamp);
      this.sql.exec("INSERT INTO inbox_counters (agent_id, last_cursor) VALUES (?, 0)", agentId);
      this.addAudit("agent.registered", "agent", agentId, "agent", agentId, { handle, provider, door, pairing_code_id: pairing.pairing_id });
      result = { agent_id: agentId, network_id: networkId, member_id: member.member_id, handle, provider, door, scopes, status: "active", credential: token };
    });
    await this.kickOutbox();
    if (!result) throw new ApiError("Agent registration did not complete.", 503, "REGISTRATION_FAILED");
    return json({ ...(result as Record<string, unknown>), _route_consumed: routeConsumed }, 201);
  }

  private async dispatch(request: Request, userId: string | null, rawAgentToken: string | null): Promise<Response> {
    const url = new URL(request.url);
    const networkId = this.sql.exec<Row>("SELECT network_id FROM network_meta LIMIT 1").toArray()[0]?.network_id;
    if (!networkId) throw new ApiError("The network does not exist.", 404, "NETWORK_NOT_FOUND");
    const network = String(networkId);
    const path = url.pathname;

    if (path === `/v1/networks/${network}` && request.method === "GET") {
      if (rawAgentToken) await this.agentForToken(rawAgentToken, "read");
      return this.getNetwork(userId, rawAgentToken);
    }
    if (path === `/v1/networks/${network}/members` && request.method === "POST") return this.createMember(request, userId);
    if (path === `/v1/networks/${network}/pairing-codes` && request.method === "POST") return this.createPairingCode(request, userId);
    if (path === `/v1/networks/${network}/pairing-codes` && request.method === "GET") return this.listPairingCodes(url, userId);
    const pairingRevoke = new RegExp(`^/v1/networks/${network}/pairing-codes/([0-9a-f-]{36})/revoke$`, "i").exec(path);
    if (pairingRevoke && request.method === "POST") return this.revokePairingCode(pairingRevoke[1], userId);
    if (path === `/v1/networks/${network}/roster` && request.method === "GET") return this.roster(userId, rawAgentToken);
    if (path === `/v1/networks/${network}/events` && request.method === "GET") return this.history(url, userId, rawAgentToken);
    if (path === `/v1/networks/${network}/audit` && request.method === "GET") return this.audit(url, userId);
    if (path === `/v1/networks/${network}/approvals` && request.method === "GET") return this.listApprovals(url, userId);
    const approvalDecision = new RegExp(`^/v1/networks/${network}/approvals/([0-9a-f-]{36})/decision$`, "i").exec(path);
    if (approvalDecision && request.method === "POST") return this.decideApproval(request, approvalDecision[1], userId);
    const agentAction = new RegExp(`^/v1/networks/${network}/agents/([0-9a-f-]{36})/(rotate|revoke)$`, "i").exec(path);
    if (agentAction && request.method === "POST") return this.manageAgent(request, agentAction[1], agentAction[2], userId, rawAgentToken);
    if (path === "/v1/events" && request.method === "POST") return this.sendEvent(request, rawAgentToken);
    if (path === "/v1/events" && request.method === "GET") return this.inbox(url, rawAgentToken);
    if (path === "/v1/approvals" && request.method === "POST") return this.createApproval(request, rawAgentToken);
    throw new ApiError("Not found.", 404, "NOT_FOUND");
  }

  private memberForUser(userId: string | null): MemberRow {
    if (!userId) throw new ApiError("A signed-in network member is required.", 401, "UNAUTHORIZED");
    const row = this.sql.exec<MemberRow>("SELECT member_id, user_id, handle, display_name, role FROM members WHERE user_id = ?", userId).toArray()[0];
    if (!row) throw new ApiError("You are not a member of this network.", 403, "FORBIDDEN");
    return row;
  }

  private ownerForUser(userId: string | null): MemberRow {
    const member = this.memberForUser(userId);
    if (member.role !== "owner") throw new ApiError("Only the network owner can perform this action.", 403, "FORBIDDEN");
    return member;
  }

  private async agentForToken(token: string | null, requiredScope?: AgentScope): Promise<AgentRow> {
    if (!token) throw new ApiError("An agent credential is required.", 401, "UNAUTHORIZED");
    const tokenHash = await hashText(token);
    const row = this.sql.exec<AgentRow>("SELECT agent_id, member_id, handle, provider, door, scopes_json, status, credential_hash, last_seen_at FROM agents WHERE credential_hash = ?", tokenHash).toArray()[0];
    if (!row || row.status !== "active" || row.credential_hash !== tokenHash) throw new ApiError("Agent credential is invalid or revoked.", 401, "INVALID_CREDENTIAL");
    const scopes = validateScopes(parseJson(row.scopes_json, ["read"]));
    if (requiredScope && !scopes.includes(requiredScope)) throw new ApiError("The agent credential does not have the required scope.", 403, "INSUFFICIENT_SCOPE");
    this.sql.exec("UPDATE agents SET last_seen_at = ? WHERE agent_id = ?", nowIso(), row.agent_id);
    return row;
  }

  private async getNetwork(userId: string | null, token: string | null): Promise<Response> {
    if (token) {
      const name = this.sql.exec<Row>("SELECT name, created_at, settings_json FROM network_meta LIMIT 1").toArray()[0];
      return json({ network_id: this.sql.exec<Row>("SELECT network_id FROM network_meta LIMIT 1").toArray()[0]?.network_id, name: name?.name, created_at: name?.created_at, settings: parseJson(String(name?.settings_json ?? "{}"), {}) });
    }
    const member = this.memberForUser(userId);
    this.addAudit("network.read", "human", String(member.user_id), "network", String(this.sql.exec<Row>("SELECT network_id FROM network_meta LIMIT 1").toArray()[0]?.network_id), {});
    await this.kickOutbox();
    const name = this.sql.exec<Row>("SELECT network_id, name, created_at, settings_json FROM network_meta LIMIT 1").toArray()[0];
    return json({ network_id: name?.network_id, name: name?.name, created_at: name?.created_at, settings: parseJson(String(name?.settings_json ?? "{}"), {}) });
  }

  private async createMember(request: Request, userId: string | null): Promise<Response> {
    const owner = this.ownerForUser(userId);
    const body = await readJson(request);
    const handle = normalizeSlug(body.handle, "handle");
    const displayName = body.display_name === undefined || body.display_name === null ? null : requireString(body.display_name, "display_name", 1, 80);
    const memberId = crypto.randomUUID();
    const createdAt = nowIso();
    this.ctx.storage.transactionSync(() => {
      if (this.sql.exec("SELECT 1 FROM members WHERE handle = ?", handle).toArray().length) throw new ApiError("That member handle is already in use.", 409, "HANDLE_CONFLICT");
      this.sql.exec("INSERT INTO members (member_id, user_id, handle, display_name, role, created_at) VALUES (?, NULL, ?, ?, 'member', ?)", memberId, handle, displayName, createdAt);
      this.addAudit("member.slot_created", "human", String(owner.user_id), "member", memberId, { handle });
    });
    await this.kickOutbox();
    return json({ member_id: memberId, handle, display_name: displayName, role: "member", created_at: createdAt }, 201);
  }

  private async createPairingCode(request: Request, userId: string | null): Promise<Response> {
    const owner = this.ownerForUser(userId);
    const body = await readJson(request);
    const memberId = body.member_id === undefined ? String(owner.member_id) : requireString(body.member_id, "member_id", 36, 36);
    const member = this.sql.exec<MemberRow>("SELECT member_id, handle, display_name FROM members WHERE member_id = ?", memberId).toArray()[0];
    if (!member) throw new ApiError("The selected member slot is not in this network.", 404, "MEMBER_NOT_FOUND");
    const scopes = validateScopes(body.scopes);
    const maxUses = body.max_uses === undefined ? 1 : Number(body.max_uses);
    const ttlHours = body.ttl_hours === undefined ? 24 : Number(body.ttl_hours);
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 10) throw new ApiError("max_uses must be between 1 and 10.", 400, "INVALID_MAX_USES");
    if (!Number.isInteger(ttlHours) || ttlHours < 1 || ttlHours > 168) throw new ApiError("ttl_hours must be between 1 and 168.", 400, "INVALID_TTL");
    const codeHash = requireString(body.code_hash, "code_hash", 64, 64);
    const expiresAt = Date.now() + ttlHours * 60 * 60 * 1000;
    const pairingId = crypto.randomUUID();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("INSERT INTO pairing_codes (pairing_id, code_hash, member_id, scopes_json, max_uses, uses, expires_at, status, issued_by_user_id, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, 'active', ?, ?)", pairingId, codeHash, memberId, toJson(scopes), maxUses, expiresAt, String(owner.user_id), nowIso());
      this.addAudit("pairing_code.created", "human", String(owner.user_id), "pairing_code", pairingId, { member_id: memberId, max_uses: maxUses, expires_at: new Date(expiresAt).toISOString(), scopes });
    });
    await this.kickOutbox();
    return json({ pairing_code_id: pairingId, network_id: this.sql.exec<Row>("SELECT network_id FROM network_meta LIMIT 1").toArray()[0]?.network_id, member_id: memberId, member_handle: member.handle, member_display_name: member.display_name, scopes, max_uses: maxUses, expires_at: new Date(expiresAt).toISOString() }, 201);
  }

  private async listPairingCodes(url: URL, userId: string | null): Promise<Response> {
    const owner = this.ownerForUser(userId);
    const requestedStatus = url.searchParams.get("status") ?? "active";
    if (!new Set(["active", "consumed", "revoked", "all"]).has(requestedStatus)) throw new ApiError("status must be active, consumed, revoked, or all.", 400, "INVALID_STATUS");
    const rows = requestedStatus === "all"
      ? this.sql.exec<PairingRow>("SELECT p.pairing_id, p.member_id, m.handle AS member_handle, p.scopes_json, p.max_uses, p.uses, p.expires_at, p.status, p.created_at FROM pairing_codes p JOIN members m ON m.member_id = p.member_id ORDER BY p.created_at DESC LIMIT 200").toArray()
      : this.sql.exec<PairingRow>("SELECT p.pairing_id, p.member_id, m.handle AS member_handle, p.scopes_json, p.max_uses, p.uses, p.expires_at, p.status, p.created_at FROM pairing_codes p JOIN members m ON m.member_id = p.member_id WHERE p.status = ? ORDER BY p.created_at DESC LIMIT 200", requestedStatus).toArray();
    this.addAudit("pairing_codes.read", "human", String(owner.user_id), "pairing_code", null, { status: requestedStatus, returned: rows.length });
    await this.kickOutbox();
    return json({ pairing_codes: rows.map((row) => ({ pairing_code_id: row.pairing_id, member_id: row.member_id, member_handle: row.member_handle, scopes: parseJson(row.scopes_json, []), max_uses: row.max_uses, uses: row.uses, expires_at: new Date(row.expires_at).toISOString(), status: row.status, created_at: row.created_at })) });
  }

  private async revokePairingCode(pairingId: string, userId: string | null): Promise<Response> {
    const owner = this.ownerForUser(userId);
    const row = this.sql.exec<PairingRow>("SELECT pairing_id, code_hash, member_id, scopes_json, max_uses, uses, expires_at, status FROM pairing_codes WHERE pairing_id = ?", pairingId).toArray()[0];
    if (!row) throw new ApiError("The pairing code was not found.", 404, "PAIRING_CODE_NOT_FOUND");
    if (row.status !== "active") throw new ApiError("The pairing code is no longer active.", 409, "PAIRING_CODE_NOT_ACTIVE");
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("UPDATE pairing_codes SET status = 'revoked' WHERE pairing_id = ? AND status = 'active'", pairingId);
      this.addAudit("pairing_code.revoked", "human", String(owner.user_id), "pairing_code", pairingId, {});
    });
    await this.kickOutbox();
    return json({ pairing_code_id: pairingId, status: "revoked" });
  }

  private async roster(userId: string | null, token: string | null): Promise<Response> {
    let actor: { kind: string; id: string };
    if (token) {
      const agent = await this.agentForToken(token, "read");
      actor = { kind: "agent", id: agent.agent_id };
    } else {
      const member = this.memberForUser(userId);
      actor = { kind: "human", id: String(member.user_id) };
    }
    const members = this.sql.exec<MemberRow>("SELECT member_id, handle, display_name, role, created_at FROM members ORDER BY created_at").toArray();
    const agents = this.sql.exec<AgentRow>("SELECT agent_id, member_id, handle, provider, door, scopes_json, status, last_seen_at, created_at FROM agents ORDER BY created_at").toArray();
    const networkId = this.sql.exec<Row>("SELECT network_id FROM network_meta LIMIT 1").toArray()[0]?.network_id;
    this.addAudit("roster.read", actor.kind, actor.id, "network", String(networkId), {});
    await this.kickOutbox();
    return json({ network_id: networkId, members: members.map((m) => ({ member_id: m.member_id, handle: m.handle, display_name: m.display_name, role: m.role })), agents: agents.map((a) => ({ agent_id: a.agent_id, member_id: a.member_id, handle: a.handle, provider: a.provider, door: a.door, scopes: parseJson(a.scopes_json, []), status: a.status, last_seen_at: a.last_seen_at })) });
  }

  private async manageAgent(request: Request, agentId: string, action: string, userId: string | null, token: string | null): Promise<Response> {
    const body = action === "rotate" ? await readJson(request) : {};
    const target = this.sql.exec<AgentRow>("SELECT agent_id, member_id, handle, provider, door, scopes_json, status, credential_hash FROM agents WHERE agent_id = ?", agentId).toArray()[0];
    if (!target) throw new ApiError("The agent was not found in this network.", 404, "AGENT_NOT_FOUND");
    let authorized = false;
    let actor = { kind: "human", id: userId ?? "" };
    if (token) {
      const caller = await this.agentForToken(token);
      authorized = caller.agent_id === agentId;
      actor = { kind: "agent", id: String(caller.agent_id) };
    } else {
      const member = this.memberForUser(userId);
      authorized = member.role === "owner" || member.member_id === target.member_id;
      actor.id = String(member.user_id);
    }
    if (!authorized) throw new ApiError("You cannot manage this agent.", 403, "FORBIDDEN");
    if (target.status === "revoked") throw new ApiError("The agent is already revoked.", 409, "AGENT_REVOKED");
    if (action === "rotate") {
      const credential = requireString(body.credential, "credential", 80, 220);
      const networkId = String(this.sql.exec<Row>("SELECT network_id FROM network_meta LIMIT 1").toArray()[0]?.network_id ?? "");
      if (!credential.startsWith(`m9rn.${networkId}.${agentId}.`)) throw new ApiError("The replacement credential is invalid.", 400, "INVALID_CREDENTIAL");
      const credentialHash = await hashText(credential);
      this.ctx.storage.transactionSync(() => {
        const current = this.sql.exec<Row>("SELECT status FROM agents WHERE agent_id = ?", agentId).toArray()[0];
        if (!current || current.status !== "active") throw new ApiError("The agent is not active.", 409, "AGENT_NOT_ACTIVE");
        this.sql.exec("UPDATE agents SET credential_hash = ?, last_seen_at = ? WHERE agent_id = ?", credentialHash, nowIso(), agentId);
        this.addAudit("agent.credential_rotated", actor.kind, actor.id, "agent", agentId, {});
      });
      await this.kickOutbox();
      return json({ ok: true, agent_id: agentId, credential }, 200);
    }
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("UPDATE agents SET status = 'revoked', credential_hash = NULL WHERE agent_id = ?", agentId);
      this.addAudit("agent.revoked", actor.kind, actor.id, "agent", agentId, { handle: target.handle });
    });
    await this.kickOutbox();
    return json({ ok: true, agent_id: agentId, status: "revoked" });
  }

  private async sendEvent(request: Request, token: string | null): Promise<Response> {
    const agent = await this.agentForToken(token, "write");
    const body = await readJson(request);
    const to = requireString(body.to, "to", 1, 80);
    if (to !== "*" && !/^@[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(to)) {
      throw new ApiError("to must be a network handle such as @member/agent or *.", 400, "INVALID_RECIPIENT");
    }
    const type = body.type === undefined ? "message" : requireString(body.type, "type", 1, 32);
    if (!VALID_EVENT_TYPES.has(type)) throw new ApiError("type must be message, file, task, task_update, or presence.", 400, "INVALID_EVENT_TYPE");
    const text = requireString(body.body, "body", 1, MAX_EVENT_BODY);
    if (new TextEncoder().encode(text).byteLength > MAX_EVENT_BODY) throw new ApiError("body exceeds the 20 KB limit.", 413, "INVALID_BODY");
    const key = requireString(body.idempotency_key, "idempotency_key", 36, 36);
    if (!UUID_RE.test(key)) throw new ApiError("idempotency_key must be a UUID.", 400, "INVALID_IDEMPOTENCY_KEY");
    const threadId = body.thread_id === undefined || body.thread_id === null ? null : requireString(body.thread_id, "thread_id", 36, 36);
    if (threadId && !UUID_RE.test(threadId)) throw new ApiError("thread_id must be a UUID or null.", 400, "INVALID_THREAD_ID");
    const attachments = body.attachments === undefined ? [] : body.attachments;
    const meta = body.meta === undefined ? {} : body.meta;
    if (!Array.isArray(attachments) || attachments.length > 20 || !meta || typeof meta !== "object" || Array.isArray(meta)) {
      throw new ApiError("attachments must be an array of at most 20 items and meta must be an object.", 400, "INVALID_EVENT_METADATA");
    }
    if (new TextEncoder().encode(toJson({ attachments, meta })).byteLength > MAX_EVENT_METADATA) throw new ApiError("attachments and meta exceed the 16 KB limit.", 413, "EVENT_METADATA_TOO_LARGE");
    const payload = { to, type, body: text, thread_id: threadId, attachments, meta };
    const payloadHash = await hashText(toJson(payload));
    const eventId = crypto.randomUUID();
    let returnedEventId: string = eventId;
    let createdAt = nowIso();
    let eventSequence = 0;
    let duplicate = false;
    this.ctx.storage.transactionSync(() => {
      const current = this.sql.exec<AgentRow>("SELECT status, credential_hash FROM agents WHERE agent_id = ?", agent.agent_id).toArray()[0];
      if (!current || current.status !== "active" || current.credential_hash !== agent.credential_hash) throw new ApiError("Agent credential is invalid or revoked.", 401, "INVALID_CREDENTIAL");
      const existing = this.sql.exec<Row>("SELECT payload_hash, event_id FROM idempotency_keys WHERE agent_id = ? AND idempotency_key = ?", agent.agent_id, key).toArray()[0];
      if (existing) {
        if (existing.payload_hash !== payloadHash) throw new ApiError("The idempotency key was reused with a different event.", 409, "IDEMPOTENCY_CONFLICT");
        const saved = this.sql.exec<Row>("SELECT event_id, event_sequence, created_at FROM events WHERE event_id = ?", String(existing.event_id)).toArray()[0];
        if (!saved) throw new ApiError("The original event is no longer available.", 409, "IDEMPOTENCY_EXPIRED");
        returnedEventId = String(saved.event_id);
        eventSequence = Number(saved.event_sequence);
        createdAt = String(saved.created_at);
        duplicate = true;
        return;
      }
      const recipients = to === "*"
        ? this.sql.exec<AgentRow>("SELECT agent_id FROM agents WHERE status = 'active' AND agent_id <> ?", agent.agent_id).toArray()
        : this.sql.exec<AgentRow>("SELECT agent_id FROM agents WHERE handle = ? AND status = 'active'", to).toArray();
      if (to !== "*" && recipients.length === 0) throw new ApiError("The recipient is not active in this network.", 404, "RECIPIENT_NOT_FOUND");
      this.sql.exec("INSERT INTO events (event_id, thread_id, sender_agent_id, sender_handle, recipient_handle, event_type, body, attachments_json, meta_json, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", eventId, threadId, agent.agent_id, agent.handle, to, type, text, toJson(attachments), toJson(meta), key, createdAt);
      eventSequence = Number(this.sql.exec<Row>("SELECT last_insert_rowid() AS id").toArray()[0]?.id ?? 0);
      for (const recipient of recipients) {
        const recipientId = String(recipient.agent_id);
        const cursor = Number(this.sql.exec<Row>("SELECT last_cursor FROM inbox_counters WHERE agent_id = ?", recipientId).toArray()[0]?.last_cursor ?? 0) + 1;
        this.sql.exec("INSERT INTO inbox_counters (agent_id, last_cursor) VALUES (?, ?) ON CONFLICT(agent_id) DO UPDATE SET last_cursor = excluded.last_cursor", recipientId, cursor);
        this.sql.exec("INSERT INTO deliveries (agent_id, inbox_cursor, event_id) VALUES (?, ?, ?)", recipientId, cursor, eventId);
      }
      this.sql.exec("INSERT INTO idempotency_keys (agent_id, idempotency_key, payload_hash, event_id, created_at) VALUES (?, ?, ?, ?, ?)", agent.agent_id, key, payloadHash, eventId, createdAt);
      const event: EventRow = { event_id: eventId, event_sequence: eventSequence, thread_id: threadId, sender_agent_id: agent.agent_id, sender_handle: agent.handle, recipient_handle: to, event_type: type, body: text, attachments_json: toJson(attachments), meta_json: toJson(meta), idempotency_key: key, created_at: createdAt };
      this.enqueue("event", { event });
      this.addAudit("event.sent", "agent", agent.agent_id, "event", eventId, { to, type });
    });
    if (!duplicate) await this.kickOutbox();
    return json({ event_id: returnedEventId, sequence: String(eventSequence), ts: createdAt, duplicate }, duplicate ? 200 : 201);
  }

  private async inbox(url: URL, token: string | null): Promise<Response> {
    const agent = await this.agentForToken(token, "read");
    const since = parseCursor(url.searchParams.get("since"), "since");
    const limit = parseLimit(url.searchParams.get("limit"));
    const lastCursor = Number(this.sql.exec<Row>("SELECT last_cursor FROM inbox_counters WHERE agent_id = ?", agent.agent_id).toArray()[0]?.last_cursor ?? 0);
    if (since > lastCursor) throw new ApiError("since is ahead of this agent's inbox.", 400, "INVALID_CURSOR");
    const page = this.sql.exec<Row>("SELECT d.inbox_cursor, e.event_id, e.thread_id, e.sender_agent_id, e.sender_handle, e.recipient_handle, e.event_type, e.body, e.attachments_json, e.meta_json, e.idempotency_key, e.created_at FROM deliveries d JOIN events e ON e.event_id = d.event_id WHERE d.agent_id = ? AND d.inbox_cursor > ? ORDER BY d.inbox_cursor LIMIT ?", agent.agent_id, since, limit + 1).toArray();
    const hasMore = page.length > limit;
    const selected = page.slice(0, limit);
    const events = selected.map((row) => eventDto(row as unknown as EventRow, Number(row.inbox_cursor)));
    const cursor = selected.length ? Number(selected[selected.length - 1].inbox_cursor) : lastCursor;
    this.addAudit("inbox.read", "agent", agent.agent_id, "event", null, { since, cursor, returned: events.length });
    return json({ events, cursor: String(cursor), has_more: hasMore });
  }

  private async history(url: URL, userId: string | null, token: string | null): Promise<Response> {
    if (token) await this.agentForToken(token, "read");
    else this.memberForUser(userId);
    const since = parseCursor(url.searchParams.get("since"), "since");
    const limit = parseLimit(url.searchParams.get("limit"));
    const page = this.sql.exec<EventRow>("SELECT event_id, event_sequence, thread_id, sender_agent_id, sender_handle, recipient_handle, event_type, body, attachments_json, meta_json, idempotency_key, created_at FROM events WHERE event_sequence > ? ORDER BY event_sequence LIMIT ?", since, limit + 1).toArray();
    const selected = page.slice(0, limit);
    const events = selected.map((row) => ({ ...eventDto(row), cursor: String(row.event_sequence) }));
    const cursor = selected.length ? Number(selected[selected.length - 1].event_sequence) : since;
    this.addAudit("network.history.read", token ? "agent" : "human", token ? "authenticated" : String(this.memberForUser(userId).user_id), "network_event", null, { since, cursor, returned: events.length });
    await this.kickOutbox();
    return json({ events, cursor: String(cursor), has_more: page.length > limit });
  }

  private async createApproval(request: Request, token: string | null): Promise<Response> {
    const agent = await this.agentForToken(token, "write");
    const body = await readJson(request);
    const action = requireString(body.action, "action", 1, 160);
    const detail = requireString(body.detail, "detail", 1, 8_000);
    const threadId = body.thread_id === undefined || body.thread_id === null ? null : requireString(body.thread_id, "thread_id", 36, 36);
    if (threadId && !UUID_RE.test(threadId)) throw new ApiError("thread_id must be a UUID or null.", 400, "INVALID_THREAD_ID");
    const approvalId = crypto.randomUUID();
    const requestedAt = nowIso();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("INSERT INTO approvals (approval_id, requester_agent_id, action, detail, thread_id, status, requested_at, decided_at, decided_by_user_id) VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL, NULL)", approvalId, agent.agent_id, action, detail, threadId, requestedAt);
      const networkOwner = this.sql.exec<MemberRow>("SELECT handle FROM members WHERE role = 'owner' LIMIT 1").toArray()[0];
      const eventId = crypto.randomUUID();
      this.sql.exec("INSERT INTO events (event_id, thread_id, sender_agent_id, sender_handle, recipient_handle, event_type, body, attachments_json, meta_json, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, 'approval_request', ?, '[]', '{}', ?, ?)", eventId, threadId, agent.agent_id, agent.handle, networkOwner ? `@${networkOwner.handle}/approvals` : "@network/approvals", toJson({ approval_id: approvalId, action, detail }), crypto.randomUUID(), requestedAt);
      const event = this.sql.exec<EventRow>("SELECT event_id, event_sequence, thread_id, sender_agent_id, sender_handle, recipient_handle, event_type, body, attachments_json, meta_json, idempotency_key, created_at FROM events WHERE event_id = ?", eventId).toArray()[0];
      if (event) this.enqueue("event", { event });
      this.addAudit("approval.requested", "agent", agent.agent_id, "approval", approvalId, { action });
    });
    await this.kickOutbox();
    return json({ approval_id: approvalId, status: "pending" }, 201);
  }

  private async listApprovals(url: URL, userId: string | null): Promise<Response> {
    const owner = this.ownerForUser(userId);
    const status = url.searchParams.get("status") ?? "pending";
    if (!new Set(["pending", "granted", "denied", "all"]).has(status)) throw new ApiError("status must be pending, granted, denied, or all.", 400, "INVALID_STATUS");
    const rows = status === "all"
      ? this.sql.exec<Row>("SELECT a.approval_id, a.requester_agent_id, g.handle, a.action, a.detail, a.thread_id, a.status, a.requested_at, a.decided_at, a.decided_by_user_id FROM approvals a JOIN agents g ON g.agent_id = a.requester_agent_id ORDER BY a.requested_at DESC LIMIT 200").toArray()
      : this.sql.exec<Row>("SELECT a.approval_id, a.requester_agent_id, g.handle, a.action, a.detail, a.thread_id, a.status, a.requested_at, a.decided_at, a.decided_by_user_id FROM approvals a JOIN agents g ON g.agent_id = a.requester_agent_id WHERE a.status = ? ORDER BY a.requested_at DESC LIMIT 200", status).toArray();
    this.addAudit("approvals.read", "human", String(owner.user_id), "approval", null, { status, returned: rows.length });
    await this.kickOutbox();
    return json({ approvals: rows });
  }

  private async decideApproval(request: Request, approvalId: string, userId: string | null): Promise<Response> {
    const owner = this.ownerForUser(userId);
    const body = await readJson(request);
    const decision = requireString(body.decision, "decision", 1, 10).toLowerCase();
    if (decision !== "grant" && decision !== "deny") throw new ApiError("decision must be grant or deny.", 400, "INVALID_DECISION");
    const row = this.sql.exec<Row>("SELECT approval_id, requester_agent_id, action, detail, thread_id, status FROM approvals WHERE approval_id = ?", approvalId).toArray()[0];
    if (!row) throw new ApiError("Approval was not found.", 404, "APPROVAL_NOT_FOUND");
    if (row.status !== "pending") throw new ApiError("Approval has already been decided.", 409, "APPROVAL_ALREADY_DECIDED");
    const decidedAt = nowIso();
    const newEventId = crypto.randomUUID();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("UPDATE approvals SET status = ?, decided_at = ?, decided_by_user_id = ? WHERE approval_id = ? AND status = 'pending'", decision === "grant" ? "granted" : "denied", decidedAt, String(owner.user_id), approvalId);
      const agent = this.sql.exec<AgentRow>("SELECT agent_id, handle, status FROM agents WHERE agent_id = ?", String(row.requester_agent_id)).toArray()[0];
      if (agent?.status === "active") {
        this.sql.exec("INSERT INTO events (event_id, thread_id, sender_agent_id, sender_handle, recipient_handle, event_type, body, attachments_json, meta_json, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '{}', ?, ?)", newEventId, row.thread_id, String(row.requester_agent_id), "@network/owner", agent.handle, decision === "grant" ? "approval_grant" : "approval_deny", toJson({ approval_id: approvalId, action: row.action, detail: row.detail, decision }), crypto.randomUUID(), decidedAt);
        const sequence = Number(this.sql.exec<Row>("SELECT last_insert_rowid() AS id").toArray()[0]?.id ?? 0);
        const cursor = Number(this.sql.exec<Row>("SELECT last_cursor FROM inbox_counters WHERE agent_id = ?", String(agent.agent_id)).toArray()[0]?.last_cursor ?? 0) + 1;
        this.sql.exec("INSERT INTO inbox_counters (agent_id, last_cursor) VALUES (?, ?) ON CONFLICT(agent_id) DO UPDATE SET last_cursor = excluded.last_cursor", String(agent.agent_id), cursor);
        this.sql.exec("INSERT INTO deliveries (agent_id, inbox_cursor, event_id) VALUES (?, ?, ?)", String(agent.agent_id), cursor, newEventId);
        const event = this.sql.exec<EventRow>("SELECT event_id, event_sequence, thread_id, sender_agent_id, sender_handle, recipient_handle, event_type, body, attachments_json, meta_json, idempotency_key, created_at FROM events WHERE event_id = ?", newEventId).toArray()[0];
        if (event) this.enqueue("event", { event });
        void sequence;
      }
      this.addAudit(`approval.${decision === "grant" ? "granted" : "denied"}`, "human", String(owner.user_id), "approval", approvalId, {});
    });
    await this.kickOutbox();
    return json({ approval_id: approvalId, status: decision === "grant" ? "granted" : "denied", decided_at: decidedAt });
  }

  private async audit(url: URL, userId: string | null): Promise<Response> {
    const owner = this.ownerForUser(userId);
    const since = parseCursor(url.searchParams.get("since"), "since");
    const limit = parseLimit(url.searchParams.get("limit"));
    const rows = this.sql.exec<Row>("SELECT audit_sequence, audit_id, action, actor_kind, actor_id, target_type, target_id, context_json, created_at FROM audit_log WHERE audit_sequence > ? ORDER BY audit_sequence LIMIT ?", since, limit + 1).toArray();
    const page = rows.slice(0, limit).map((row) => ({ cursor: String(row.audit_sequence), audit_id: row.audit_id, action: row.action, actor: { kind: row.actor_kind, id: row.actor_id }, target: { type: row.target_type, id: row.target_id }, context: parseJson(String(row.context_json), {}), ts: row.created_at }));
    this.addAudit("audit.read", "human", String(owner.user_id), "audit_log", null, { since, returned: page.length });
    await this.kickOutbox();
    return json({ entries: page, cursor: page.length ? page[page.length - 1].cursor : String(since), has_more: rows.length > limit });
  }

  private addAudit(action: string, actorKind: string, actorId: string, targetType: string, targetId: string | null, context: Record<string, unknown>): void {
    const auditId = crypto.randomUUID();
    const createdAt = nowIso();
    this.sql.exec("INSERT INTO audit_log (audit_id, action, actor_kind, actor_id, target_type, target_id, context_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", auditId, action, actorKind, actorId, targetType, targetId, toJson(context), createdAt);
    const sequence = Number(this.sql.exec<Row>("SELECT last_insert_rowid() AS id").toArray()[0]?.id ?? 0);
    this.enqueue("audit", { audit_id: auditId, sequence, action, actor_kind: actorKind, actor_id: actorId, target_type: targetType, target_id: targetId, context_json: toJson(context), created_at: createdAt });
  }

  private enqueue(kind: "event" | "audit", payload: unknown): void {
    this.sql.exec("INSERT INTO mirror_outbox (kind, payload_json, created_at) VALUES (?, ?, ?)", kind, toJson(payload), nowIso());
  }

  private async kickOutbox(): Promise<void> {
    try {
      await this.ctx.storage.setAlarm(Date.now() + 100);
    } catch (error) {
      // The local write has already committed. Do not turn an accepted send or
      // credential rotation into an apparent failure just because mirror
      // scheduling is temporarily unavailable; the daily sweep retries it.
      console.error("Network history mirror scheduling deferred:", error instanceof Error ? error.name : "unknown");
    }
  }

  override async alarm(): Promise<void> {
    const rows = this.sql.exec<OutboxRow>("SELECT outbox_id, kind, payload_json FROM mirror_outbox ORDER BY outbox_id LIMIT 100").toArray();
    if (!rows.length) return;
    try {
      const statements: D1PreparedStatement[] = [];
      const historyCutoff = Date.now() - 90 * DAY;
      for (const row of rows) {
        const payload = asObject(parseJson(row.payload_json, {}));
        if (row.kind === "event") {
          const event = asObject(payload.event);
          if (typeof event.created_at === "string" && Date.parse(event.created_at) < historyCutoff) continue;
          statements.push(this.env.HISTORY.prepare("INSERT OR IGNORE INTO network_event_history (network_id, event_id, sequence, thread_id, sender_agent_id, sender_handle, recipient_handle, event_type, body, attachments_json, meta_json, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(event.network_id ?? this.sql.exec<Row>("SELECT network_id FROM network_meta LIMIT 1").toArray()[0]?.network_id, event.event_id, event.event_sequence, event.thread_id ?? null, event.sender_agent_id, event.sender_handle, event.recipient_handle, event.event_type, event.body, event.attachments_json, event.meta_json, event.idempotency_key, event.created_at));
        } else if (row.kind === "audit") {
          statements.push(this.env.HISTORY.prepare("INSERT OR IGNORE INTO network_audit_history (network_id, audit_id, sequence, action, actor_kind, actor_id, target_type, target_id, context_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(this.sql.exec<Row>("SELECT network_id FROM network_meta LIMIT 1").toArray()[0]?.network_id, payload.audit_id, payload.sequence, payload.action, payload.actor_kind, payload.actor_id, payload.target_type, payload.target_id ?? null, payload.context_json, payload.created_at));
        }
      }
      if (statements.length) await this.env.HISTORY.batch(statements);
      const ids = rows.map((row) => row.outbox_id);
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(`DELETE FROM mirror_outbox WHERE outbox_id IN (${ids.map(() => "?").join(",")})`, ...ids);
      });
      if (rows.length === 100 || this.sql.exec<Row>("SELECT 1 AS pending FROM mirror_outbox LIMIT 1").toArray().length) await this.ctx.storage.setAlarm(Date.now() + 100);
    } catch (error) {
      console.error("Network history mirror deferred:", error instanceof Error ? error.name : "unknown");
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
    }
  }

  private async prune(): Promise<Response> {
    const cutoff = Date.now() - 90 * DAY;
    const cutoffIso = new Date(cutoff).toISOString();
    let removed = 0;
    this.ctx.storage.transactionSync(() => {
      const expired = this.sql.exec<Row>("SELECT event_id FROM events WHERE created_at < ?", cutoffIso).toArray();
      removed = expired.length;
      this.sql.exec("DELETE FROM deliveries WHERE event_id IN (SELECT event_id FROM events WHERE created_at < ?)", cutoffIso);
      this.sql.exec("DELETE FROM idempotency_keys WHERE event_id IN (SELECT event_id FROM events WHERE created_at < ?)", cutoffIso);
      this.sql.exec("DELETE FROM events WHERE created_at < ?", cutoffIso);
      this.sql.exec("DELETE FROM pairing_codes WHERE expires_at < ?", Date.now() - 30 * DAY);
      this.sql.exec("DELETE FROM approvals WHERE requested_at < ? AND status <> 'pending'", new Date(Date.now() - 365 * DAY).toISOString());
    });
    await this.env.HISTORY.prepare("DELETE FROM network_event_history WHERE network_id = ? AND created_at < ?")
      .bind(this.sql.exec<Row>("SELECT network_id FROM network_meta LIMIT 1").toArray()[0]?.network_id, cutoffIso).run();
    if (this.sql.exec<Row>("SELECT 1 FROM mirror_outbox LIMIT 1").toArray().length) await this.kickOutbox();
    return json({ removed });
  }
}

