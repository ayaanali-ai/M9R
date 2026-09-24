import { DurableObject } from "cloudflare:workers";
import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import { COORDINATOR_MAX_QUEUE, verifyCoordinatorEnvelope, verifyCoordinatorPoll, verifyCoordinatorSession, type SignedCoordinatorEnvelope, type SignedCoordinatorSession } from "./protocol";

const MAX_REQUEST_CHARS = 96 * 1024;
const REPLAY_RETENTION_MS = 3 * 60 * 1_000;

export interface Env {
  WEB_COORDINATOR: DurableObjectNamespace<CoordinatorRoom>;
}

type CoordinatorSqlValue = string | number | null | ArrayBuffer;
interface StoredSessionRow extends Record<string, CoordinatorSqlValue> { registration_json: string }
interface SequenceRow extends Record<string, CoordinatorSqlValue> { last_sequence: number }
interface CountRow extends Record<string, CoordinatorSqlValue> { count: number }
interface DeliveryRow extends Record<string, CoordinatorSqlValue> { id: number; envelope_json: string }

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

async function parseBody(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const text = await request.text();
  if (text.length > MAX_REQUEST_CHARS) return { ok: false, response: json({ error: "request body is too large" }, 413) };
  try { return { ok: true, value: JSON.parse(text) as unknown }; }
  catch { return { ok: false, response: json({ error: "request body must be valid JSON" }, 400) }; }
}

export class CoordinatorRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const sql = ctx.storage.sql;
      sql.exec("CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, registration_json TEXT NOT NULL, expires_at INTEGER NOT NULL)");
      sql.exec("CREATE TABLE IF NOT EXISTS sender_sequences (session_id TEXT NOT NULL, owner_id TEXT NOT NULL, last_sequence INTEGER NOT NULL, PRIMARY KEY (session_id, owner_id))");
      sql.exec("CREATE TABLE IF NOT EXISTS frame_nonces (session_id TEXT NOT NULL, owner_id TEXT NOT NULL, nonce TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (session_id, owner_id, nonce))");
      sql.exec("CREATE TABLE IF NOT EXISTS poll_nonces (session_id TEXT NOT NULL, owner_id TEXT NOT NULL, nonce TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (session_id, owner_id, nonce))");
      sql.exec("CREATE TABLE IF NOT EXISTS deliveries (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id TEXT NOT NULL, envelope_json TEXT NOT NULL, created_at INTEGER NOT NULL)");
      sql.exec("CREATE INDEX IF NOT EXISTS deliveries_owner_id_id ON deliveries(owner_id, id)");
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST") return json({ error: "POST required" }, 405);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 1) return json({ error: "unknown coordinator operation" }, 404);
    const parsed = await parseBody(request);
    if (!parsed.ok) return parsed.response;

    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return json({ error: "invalid routed session id" }, 400);
    if (parts[0] === "register") return this.register(parsed.value, sessionId);
    if (parts[0] === "frames") return this.route(parsed.value, sessionId);
    if (parts[0] === "poll") return this.poll(parsed.value, sessionId);
    return json({ error: "unknown coordinator operation" }, 404);
  }

  private async register(value: unknown, routedSessionId: string): Promise<Response> {
    const result = await verifyCoordinatorSession(value);
    if (!result.ok) return json({ error: result.error }, 400);
    const session = result.session;
    const descriptor = session.descriptor;
    if (descriptor.sessionId !== routedSessionId) return json({ error: "session id does not match the routed object" }, 400);
    const registrationJson = JSON.stringify({
      descriptor: { ...descriptor, members: [...descriptor.members].sort((a, b) => a.ownerId.localeCompare(b.ownerId)) },
      acceptances: [...session.acceptances].sort((a, b) => a.ownerId.localeCompare(b.ownerId)),
    });
    const existing = this.ctx.storage.sql.exec<StoredSessionRow>("SELECT registration_json FROM sessions WHERE session_id = ?", descriptor.sessionId).toArray()[0];
    if (existing) return existing.registration_json === registrationJson ? json({ ok: true, duplicate: true }) : json({ error: "session id is already bound to a different signed owner pair" }, 409);
    this.ctx.storage.sql.exec("INSERT INTO sessions (session_id, registration_json, expires_at) VALUES (?, ?, ?)", descriptor.sessionId, registrationJson, descriptor.expiresAt);
    return json({ ok: true, duplicate: false }, 201);
  }

  private async readSession(sessionId: string): Promise<SignedCoordinatorSession | null> {
    const row = this.ctx.storage.sql.exec<StoredSessionRow>("SELECT registration_json FROM sessions WHERE session_id = ?", sessionId).toArray()[0];
    if (!row) return null;
    try { return JSON.parse(row.registration_json) as SignedCoordinatorSession; }
    catch { return null; }
  }

  private async route(value: unknown, routedSessionId: string): Promise<Response> {
    if (!value || typeof value !== "object") return json({ error: "frame must be an object" }, 400);
    const frame = value as Partial<SignedCoordinatorEnvelope>;
    if (frame.sessionId !== routedSessionId) return json({ error: "session id does not match the routed object" }, 400);
    const session = await this.readSession(frame.sessionId);
    if (!session) return json({ error: "session is unknown or expired" }, 404);
    const verified = await verifyCoordinatorEnvelope(session, frame, Date.now());
    if (!verified.ok) return json({ error: verified.error }, 400);
    const message = verified.frame;
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM frame_nonces WHERE session_id = ? AND created_at < ?", message.sessionId, Date.now() - REPLAY_RETENTION_MS);
    const sequence = sql.exec<SequenceRow>("SELECT last_sequence FROM sender_sequences WHERE session_id = ? AND owner_id = ?", message.sessionId, message.fromOwner).toArray()[0]?.last_sequence ?? 0;
    if (message.sequence <= sequence) return json({ error: "sequence was replayed or arrived out of order" }, 409);
    const nonce = sql.exec("SELECT 1 FROM frame_nonces WHERE session_id = ? AND owner_id = ? AND nonce = ?", message.sessionId, message.fromOwner, message.nonce).toArray()[0];
    if (nonce) return json({ error: "nonce was replayed" }, 409);
    const queued = sql.exec<CountRow>("SELECT COUNT(*) AS count FROM deliveries WHERE owner_id = ?", message.toOwner).one().count;
    if (queued >= COORDINATOR_MAX_QUEUE) return json({ error: "recipient queue is full" }, 429);

    // These synchronous writes are coalesced by the Durable Object's SQLite transaction boundary.
    sql.exec("INSERT INTO sender_sequences (session_id, owner_id, last_sequence) VALUES (?, ?, ?) ON CONFLICT(session_id, owner_id) DO UPDATE SET last_sequence = excluded.last_sequence", message.sessionId, message.fromOwner, message.sequence);
    sql.exec("INSERT INTO frame_nonces (session_id, owner_id, nonce, created_at) VALUES (?, ?, ?, ?)", message.sessionId, message.fromOwner, message.nonce, message.createdAt);
    sql.exec("INSERT INTO deliveries (owner_id, envelope_json, created_at) VALUES (?, ?, ?)", message.toOwner, JSON.stringify(message), Date.now());
    return json({ ok: true, accepted: true });
  }

  private async poll(value: unknown, routedSessionId: string): Promise<Response> {
    if (!value || typeof value !== "object") return json({ error: "poll request must be an object" }, 400);
    const poll = value as { sessionId?: unknown };
    if (poll.sessionId !== routedSessionId) return json({ error: "session id does not match the routed object" }, 400);
    const session = await this.readSession(routedSessionId);
    if (!session) return json({ error: "session is unknown or expired" }, 404);
    const verified = await verifyCoordinatorPoll(session, value, Date.now());
    if (!verified.ok) return json({ error: verified.error }, 401);
    const request = verified.request;
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM poll_nonces WHERE session_id = ? AND created_at < ?", request.sessionId, Date.now() - REPLAY_RETENTION_MS);
    if (sql.exec("SELECT 1 FROM poll_nonces WHERE session_id = ? AND owner_id = ? AND nonce = ?", request.sessionId, request.ownerId, request.nonce).toArray()[0]) return json({ error: "poll nonce was replayed" }, 409);
    const rows = sql.exec<DeliveryRow>("SELECT id, envelope_json FROM deliveries WHERE owner_id = ? ORDER BY id LIMIT ?", request.ownerId, COORDINATOR_MAX_QUEUE).toArray();
    const frames: SignedCoordinatorEnvelope[] = [];
    for (const row of rows) {
      try { frames.push(JSON.parse(row.envelope_json) as SignedCoordinatorEnvelope); }
      catch { return json({ error: "queued coordinator data is corrupt" }, 500); }
    }
    sql.exec("INSERT INTO poll_nonces (session_id, owner_id, nonce, created_at) VALUES (?, ?, ?, ?)", request.sessionId, request.ownerId, request.nonce, request.createdAt);
    if (rows.length) sql.exec("DELETE FROM deliveries WHERE id IN (" + rows.map(() => "?").join(",") + ")", ...rows.map((row) => row.id));
    return json({ ok: true, frames });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/v1\/sessions\/([A-Za-z0-9_-]{1,128})\/(register|frames|poll)$/.exec(url.pathname);
    if (!match) return json({ error: "not found" }, 404);
    const [, sessionId, operation] = match;
    const stub = env.WEB_COORDINATOR.getByName(sessionId);
    return stub.fetch(new Request(`https://coordinator.internal/${operation}?sessionId=${encodeURIComponent(sessionId)}`, request));
  },
};
