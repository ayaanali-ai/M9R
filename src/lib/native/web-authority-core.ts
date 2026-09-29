/**
 * Cross-owner authority for the web broker (spike, docs: M9R_DEMO_BUILD_PLAN_2026-09-23.md, cross-owner risk).
 * The owner of a browser lets another owner's agent act in it under a grant that names one site, a few actions and an
 * expiry. The grantee never receives cookies or logins: it only gets the results of the actions the grant allows.
 * Every request, decision and revocation enters a bounded hash-chained audit window with a persisted chain anchor that detects accidental edits or corruption; it
 * is not proof against someone who can write the file. The log holds metadata only (who, what, which site, which selector), never typed text or page
 * content. Approving is an owner-side call; nothing an agent can submit through the broker's command path creates a grant.
 */
import { createHash, randomUUID } from "node:crypto";
import type { WebAction } from "./web-broker-core";

export const DEFAULT_BLOCKED_HOSTS = [
  "accounts.google.com",
  "login.microsoftonline.com",
  "appleid.apple.com",
  "paypal.com",
  "1password.com",
  "bitwarden.com",
  "lastpass.com",
];

const DEFAULT_TTL_MS = 30 * 60_000;
const DEFAULT_MAX_TTL_MS = 8 * 60 * 60_000;
const REQUEST_TTL_MS = 10 * 60_000;
/** Active authority state is bounded independently of the rolling audit window. */
export const MAX_AUTHORITY_GRANTS = 512;
export const MAX_PENDING_AUTHORITY_REQUESTS = 256;
const MAX_GRANTEE_FIELD_CHARS = 128;
const MAX_AUTHORITY_URL_CHARS = 2_048;
/** Keep local authority snapshots small enough that each atomic write has a fixed upper bound. */
export const MAX_AUDIT_ENTRIES = 2_048;
/** Maximum UTF-8 size of the serialized audit array, including its brackets and separators. */
export const MAX_AUDIT_SERIALIZED_BYTES = 512 * 1024;

const AUDIT_FIELD_SERIALIZED_BYTES = {
  actor: 256,
  grantId: 160,
  action: 96,
  origin: 384,
  selector: 256,
  detail: 192,
} as const;

export interface Grantee {
  owner: string;
  agent: string;
}

export interface GrantRequest {
  id: string;
  grantee: Grantee;
  origin: string;
  pathPrefix?: string;
  actions: WebAction[];
  ttlMs: number;
  reason: string;
  createdAt: number;
}

export interface Grant {
  id: string;
  grantorOwner: string;
  grantee: Grantee;
  origin: string;
  pathPrefix?: string;
  actions: WebAction[];
  createdAt: number;
  expiresAt: number;
  maxUses?: number;
  uses: number;
  revokedAt?: number;
}

export interface AuditEntry {
  seq: number;
  at: number;
  kind: "grant.requested" | "grant.approved" | "grant.denied" | "grant.revoked" | "action.allowed" | "action.refused" | "action.requested" | "action.approved" | "action.denied" | "action.timed_out";
  actor: string;
  grantId?: string;
  action?: string;
  origin?: string;
  selector?: string;
  detail?: string;
  prev: string;
  hash: string;
}

export interface AuditAnchor {
  /** Sequence number expected for the first retained entry. */
  sequence: number;
  /** Hash of the immediately preceding entry, or "genesis" for a new chain. */
  hash: string;
}

export type AuthorityDecision = { allowed: true; grantId: string } | { allowed: false; reason: string };

export interface AuthorityDeps {
  ownerId: string;
  now?: () => number;
  newId?: () => string;
  blockedHosts?: string[];
  maxTtlMs?: number;
}

export interface WebAuthoritySnapshot {
  version: 2;
  grants: Grant[];
  requests: GrantRequest[];
  audit: AuditEntry[];
  auditAnchor: AuditAnchor;
}

export function originOf(url: string | undefined): string | null {
  try {
    const parsed = new URL(url ?? "");
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

export function pathOf(url: string | undefined): string | null {
  try {
    const parsed = new URL(url ?? "");
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.pathname : null;
  } catch {
    return null;
  }
}

function canonicalPathPrefix(value: string | undefined): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("?") || value.includes("#")) return null;
  try {
    const parsed = new URL(value, "https://m9r.invalid");
    return parsed.pathname === "/" ? "/" : parsed.pathname.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function pathWithin(path: string, prefix: string): boolean {
  return prefix === "/" || path === prefix || path.startsWith(`${prefix}/`);
}

export function isBlockedOrigin(origin: string, extraBlocked: string[] = []): boolean {
  const host = new URL(origin).hostname.toLowerCase();
  return [...DEFAULT_BLOCKED_HOSTS, ...extraBlocked].some((blocked) => host === blocked || host.endsWith(`.${blocked}`));
}

function chain(entry: Omit<AuditEntry, "hash">): string {
  const fields = [entry.seq, entry.at, entry.kind, entry.actor, entry.grantId ?? "", entry.action ?? "", entry.origin ?? "", entry.selector ?? "", entry.detail ?? "", entry.prev];
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

function serializedStringBytes(value: string): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function safePrefixEnd(value: string, end: number): number {
  if (end > 0 && end < value.length) {
    const previous = value.charCodeAt(end - 1);
    const next = value.charCodeAt(end);
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) return end - 1;
  }
  return end;
}

/** Keep a short display prefix and commit the full JSON-encoded value by digest when metadata is oversized. */
function boundedAuditText(value: string, maxSerializedBytes: number): string {
  if (serializedStringBytes(value) <= maxSerializedBytes) return value;
  const digest = createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
  const suffix = ` [truncated sha256:${digest}]`;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const candidate = Math.ceil((low + high) / 2);
    const end = safePrefixEnd(value, candidate);
    if (serializedStringBytes(value.slice(0, end) + suffix) <= maxSerializedBytes) low = candidate;
    else high = candidate - 1;
  }
  return value.slice(0, safePrefixEnd(value, low)) + suffix;
}

/** Exact JSON byte count for the audit array persisted by the authority store. */
export function auditSerializedBytes(entries: readonly AuditEntry[]): number {
  let bytes = 2 + Math.max(0, entries.length - 1);
  for (const entry of entries) bytes += Buffer.byteLength(JSON.stringify(entry), "utf8");
  return bytes;
}

/** Drop only a prefix and move the anchor to the last removed hash, preserving a verifiable retained chain. */
export function boundAuditWindow(
  entries: readonly AuditEntry[],
  initialAnchor: AuditAnchor,
): { audit: AuditEntry[]; auditAnchor: AuditAnchor } {
  let retainedCount = entries.length;
  let retainedBytes = auditSerializedBytes(entries);
  let firstRetained = 0;
  let auditAnchor = { ...initialAnchor };
  while (retainedCount > MAX_AUDIT_ENTRIES || retainedBytes > MAX_AUDIT_SERIALIZED_BYTES) {
    const removed = entries[firstRetained++];
    retainedBytes -= Buffer.byteLength(JSON.stringify(removed), "utf8") + (retainedCount > 1 ? 1 : 0);
    retainedCount -= 1;
    auditAnchor = { sequence: removed.seq + 1, hash: removed.hash };
  }
  return {
    audit: entries.slice(firstRetained).map((entry) => ({ ...entry })),
    auditAnchor,
  };
}

export function verifyAudit(entries: readonly AuditEntry[], anchor: AuditAnchor = { sequence: 0, hash: "genesis" }): { ok: true } | { ok: false; brokenAt: number } {
  if (!anchor || typeof anchor !== "object" || !Number.isSafeInteger(anchor.sequence) || anchor.sequence < 0 ||
      (anchor.sequence === 0 ? anchor.hash !== "genesis" : !/^[a-f0-9]{64}$/i.test(anchor.hash))) {
    return { ok: false, brokenAt: 0 };
  }
  let prev = anchor.hash;
  let expectedSequence = anchor.sequence;
  for (let i = 0; i < entries.length; i++) {
    const { hash, ...rest } = entries[i];
    if (entries[i].seq !== expectedSequence || entries[i].prev !== prev || chain(rest) !== hash) return { ok: false, brokenAt: i };
    prev = hash;
    expectedSequence += 1;
  }
  return { ok: true };
}

export function createWebAuthority(deps: AuthorityDeps) {
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? (() => randomUUID());
  const maxTtlMs = deps.maxTtlMs ?? DEFAULT_MAX_TTL_MS;
  const requests = new Map<string, GrantRequest>();
  const grants = new Map<string, Grant>();
  const log: AuditEntry[] = [];
  let auditAnchor: AuditAnchor = { sequence: 0, hash: "genesis" };
  let auditBytes = 2;

  function pruneExpiredRequests(): void {
    const current = now();
    for (const [id, request] of requests) if (current - request.createdAt > REQUEST_TTL_MS) requests.delete(id);
  }

  function pruneInactiveGrants(): void {
    const current = now();
    for (const [id, grant] of grants) if (grant.revokedAt !== undefined || grant.expiresAt <= current) grants.delete(id);
  }

  function record(kind: AuditEntry["kind"], actor: string, fields: Partial<Pick<AuditEntry, "grantId" | "action" | "origin" | "selector" | "detail">> = {}): void {
    const prev = log.length ? log[log.length - 1].hash : auditAnchor.hash;
    const base: Omit<AuditEntry, "hash"> = {
      seq: auditAnchor.sequence + log.length,
      at: now(),
      kind,
      actor: boundedAuditText(actor, AUDIT_FIELD_SERIALIZED_BYTES.actor),
      ...(fields.grantId !== undefined ? { grantId: boundedAuditText(fields.grantId, AUDIT_FIELD_SERIALIZED_BYTES.grantId) } : {}),
      ...(fields.action !== undefined ? { action: boundedAuditText(fields.action, AUDIT_FIELD_SERIALIZED_BYTES.action) } : {}),
      ...(fields.origin !== undefined ? { origin: boundedAuditText(fields.origin, AUDIT_FIELD_SERIALIZED_BYTES.origin) } : {}),
      ...(fields.selector !== undefined ? { selector: boundedAuditText(fields.selector, AUDIT_FIELD_SERIALIZED_BYTES.selector) } : {}),
      ...(fields.detail !== undefined ? { detail: boundedAuditText(fields.detail, AUDIT_FIELD_SERIALIZED_BYTES.detail) } : {}),
      prev,
    };
    const entry = { ...base, hash: chain(base) };
    log.push(entry);
    auditBytes += Buffer.byteLength(JSON.stringify(entry), "utf8") + (log.length > 1 ? 1 : 0);
    while (log.length > MAX_AUDIT_ENTRIES || auditBytes > MAX_AUDIT_SERIALIZED_BYTES) {
      const removed = log.shift();
      if (!removed) break;
      auditBytes -= Buffer.byteLength(JSON.stringify(removed), "utf8") + (log.length > 0 ? 1 : 0);
      auditAnchor = { sequence: removed.seq + 1, hash: removed.hash };
    }
  }

  const actorOf = (grantee: Grantee) => `${grantee.owner}/${grantee.agent}`;

  function requestGrant(input: { grantee: Grantee; origin: string; pathPrefix?: string; actions: WebAction[]; ttlMs?: number; reason?: string }): { ok: true; request: GrantRequest } | { ok: false; error: string } {
    pruneExpiredRequests();
    if (!input.grantee || typeof input.grantee.owner !== "string" || typeof input.grantee.agent !== "string" ||
        input.grantee.owner.length > MAX_GRANTEE_FIELD_CHARS || input.grantee.agent.length > MAX_GRANTEE_FIELD_CHARS ||
        typeof input.origin !== "string" || input.origin.length > MAX_AUTHORITY_URL_CHARS ||
        (input.pathPrefix !== undefined && (typeof input.pathPrefix !== "string" || input.pathPrefix.length > MAX_AUTHORITY_URL_CHARS))) {
      return { ok: false, error: "the grant request exceeds a bounded identity or URL limit" };
    }
    const origin = originOf(input.origin);
    if (!origin) return { ok: false, error: "a grant needs an http or https site" };
    if (origin.length > 512) return { ok: false, error: "the grant origin exceeds its size limit" };
    const parsedPath = pathOf(input.origin);
    const pathPrefix = canonicalPathPrefix(input.pathPrefix ?? (parsedPath && parsedPath !== "/" ? parsedPath : undefined));
    if (pathPrefix === null) return { ok: false, error: "path prefix must be an absolute URL path without query or fragment" };
    if (isBlockedOrigin(origin, deps.blockedHosts)) return { ok: false, error: `${new URL(origin).hostname} is on the never-grant list` };
    if (!input.actions.length) return { ok: false, error: "a grant needs at least one action" };
    if (input.grantee.owner === deps.ownerId) return { ok: false, error: "your own agents do not need a grant" };
    if (requests.size >= MAX_PENDING_AUTHORITY_REQUESTS) return { ok: false, error: "the local web authority is at pending-request capacity" };
    const request: GrantRequest = {
      id: newId(),
      grantee: input.grantee,
      origin,
      ...(pathPrefix ? { pathPrefix } : {}),
      actions: [...new Set(input.actions)],
      ttlMs: Math.min(input.ttlMs ?? DEFAULT_TTL_MS, maxTtlMs),
      reason: (input.reason ?? "").slice(0, 200),
      createdAt: now(),
    };
    requests.set(request.id, request);
    record("grant.requested", actorOf(input.grantee), { origin, detail: request.actions.join(",") });
    return { ok: true, request };
  }

  function pendingRequests(): GrantRequest[] {
    pruneExpiredRequests();
    return [...requests.values()].filter((r) => now() - r.createdAt <= REQUEST_TTL_MS);
  }

  function approve(requestId: string, narrow: { actions?: WebAction[]; ttlMs?: number; maxUses?: number } = {}): { ok: true; grant: Grant } | { ok: false; error: string } {
    pruneExpiredRequests();
    pruneInactiveGrants();
    const request = requests.get(requestId);
    if (!request || now() - request.createdAt > REQUEST_TTL_MS) return { ok: false, error: "that request is unknown or has expired" };
    if (grants.size >= MAX_AUTHORITY_GRANTS) return { ok: false, error: "the local web authority is at grant capacity; revoke or expire a grant before approving another" };
    const actions = narrow.actions ? request.actions.filter((a) => narrow.actions?.includes(a)) : request.actions;
    if (!actions.length) return { ok: false, error: "nothing is left after narrowing the request" };
    requests.delete(requestId);
    const grant: Grant = {
      id: newId(),
      grantorOwner: deps.ownerId,
      grantee: request.grantee,
      origin: request.origin,
      ...(request.pathPrefix ? { pathPrefix: request.pathPrefix } : {}),
      actions,
      createdAt: now(),
      expiresAt: now() + Math.min(narrow.ttlMs ?? request.ttlMs, request.ttlMs),
      maxUses: narrow.maxUses,
      uses: 0,
    };
    grants.set(grant.id, grant);
    record("grant.approved", deps.ownerId, { grantId: grant.id, origin: grant.origin, detail: actions.join(",") });
    return { ok: true, grant };
  }

  function deny(requestId: string): boolean {
    const request = requests.get(requestId);
    if (!request) return false;
    requests.delete(requestId);
    record("grant.denied", deps.ownerId, { origin: request.origin, detail: actorOf(request.grantee) });
    return true;
  }

  function revoke(grantId: string): boolean {
    const grant = grants.get(grantId);
    if (!grant || grant.revokedAt) return false;
    grant.revokedAt = now();
    record("grant.revoked", deps.ownerId, { grantId, origin: grant.origin });
    return true;
  }

  function revokeAll(): number {
    let count = 0;
    for (const id of grants.keys()) if (revoke(id)) count++;
    return count;
  }

  function check(input: { grantee: Grantee; action: WebAction; origin: string; path?: string; selector?: string }): AuthorityDecision {
    const actor = actorOf(input.grantee);
    const refuse = (reason: string, grantId?: string): AuthorityDecision => {
      record("action.refused", actor, { grantId, action: input.action, origin: input.origin, selector: input.selector?.slice(0, 200), detail: reason });
      return { allowed: false, reason };
    };

    const mine = [...grants.values()].filter((g) => g.grantee.owner === input.grantee.owner && g.grantee.agent === input.grantee.agent);
    if (!mine.length) return refuse(`no grant for ${actor}`);
    const onSite = mine.filter((g) => g.origin === input.origin);
    if (!onSite.length) return refuse(`no grant covers ${input.origin}`);
    const requestPath = input.path === undefined ? undefined : canonicalPathPrefix(input.path);
    if (requestPath === null) return refuse("the requested path is invalid", onSite[0].id);

    let reason = "no live grant";
    for (const grant of onSite) {
      if (grant.revokedAt) reason = "the grant was revoked";
      else if (grant.expiresAt <= now()) reason = "the grant has expired";
      else if (!grant.actions.includes(input.action)) reason = `the grant does not allow ${input.action}`;
      else if (grant.pathPrefix && (!requestPath || !pathWithin(requestPath, grant.pathPrefix))) reason = `the grant does not cover path ${requestPath ?? "(unknown)"}`;
      else if (grant.maxUses !== undefined && grant.uses >= grant.maxUses) reason = "the grant has no uses left";
      else {
        grant.uses++;
        record("action.allowed", actor, { grantId: grant.id, action: input.action, origin: input.origin, selector: input.selector?.slice(0, 200) });
        return { allowed: true, grantId: grant.id };
      }
    }
    return refuse(reason, onSite[0].id);
  }

  function recordActionDecision(
    kind: Extract<AuditEntry["kind"], "action.requested" | "action.approved" | "action.denied" | "action.timed_out">,
    actor: string,
    fields: Pick<AuditEntry, "action" | "origin" | "selector" | "detail">,
  ): void {
    const origin = originOf(fields.origin);
    record(kind, actor, {
      action: fields.action,
      ...(origin ? { origin } : {}),
      selector: fields.selector,
      detail: fields.detail,
    });
  }

  function snapshot(): WebAuthoritySnapshot {
    pruneExpiredRequests();
    return {
      version: 2,
      grants: [...grants.values()].map((grant) => ({ ...grant, grantee: { ...grant.grantee }, actions: [...grant.actions] })),
      requests: [...requests.values()].map((request) => ({ ...request, grantee: { ...request.grantee }, actions: [...request.actions] })),
      audit: log.map((entry) => ({ ...entry })),
      auditAnchor: { ...auditAnchor },
    };
  }

  function restore(state: WebAuthoritySnapshot): void {
    if (state.version !== 2 || !Array.isArray(state.grants) || !Array.isArray(state.requests) || !Array.isArray(state.audit) ||
        state.grants.length > MAX_AUTHORITY_GRANTS || state.requests.length > MAX_PENDING_AUTHORITY_REQUESTS ||
        !state.auditAnchor || state.audit.length > MAX_AUDIT_ENTRIES || auditSerializedBytes(state.audit) > MAX_AUDIT_SERIALIZED_BYTES) {
      throw new Error("invalid web authority snapshot");
    }
    if (!verifyAudit(state.audit, state.auditAnchor).ok) throw new Error("web authority audit chain is invalid");
    grants.clear();
    requests.clear();
    log.splice(0, log.length);
    auditAnchor = { ...state.auditAnchor };
    for (const grant of state.grants) grants.set(grant.id, { ...grant, grantee: { ...grant.grantee }, actions: [...grant.actions] });
    for (const request of state.requests) requests.set(request.id, { ...request, grantee: { ...request.grantee }, actions: [...request.actions] });
    log.push(...state.audit.map((entry) => ({ ...entry })));
    auditBytes = auditSerializedBytes(log);
  }

  return {
    requestGrant,
    pendingRequests,
    approve,
    deny,
    revoke,
    revokeAll,
    check,
    recordActionDecision,
    grants: () => [...grants.values()],
    audit: (): AuditEntry[] => log.map((entry) => ({ ...entry })),
    auditAnchor: (): AuditAnchor => ({ ...auditAnchor }),
    snapshot,
    restore,
  };
}

export type WebAuthority = ReturnType<typeof createWebAuthority>;
