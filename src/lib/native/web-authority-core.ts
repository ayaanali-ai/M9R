/**
 * Cross-owner authority for the web broker (spike, docs: M9R_DEMO_BUILD_PLAN_2026-09-23.md, cross-owner risk).
 * The owner of a browser lets another owner's agent act in it under a grant that names one site, a few actions and an
 * expiry. The grantee never receives cookies or logins: it only gets the results of the actions the grant allows.
 * Every request, decision and revocation goes into a hash-chained log that detects accidental edits or corruption; it
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

export type AuthorityDecision = { allowed: true; grantId: string } | { allowed: false; reason: string };

export interface AuthorityDeps {
  ownerId: string;
  now?: () => number;
  newId?: () => string;
  blockedHosts?: string[];
  maxTtlMs?: number;
}

export interface WebAuthoritySnapshot {
  version: 1;
  grants: Grant[];
  requests: GrantRequest[];
  audit: AuditEntry[];
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

export function verifyAudit(entries: readonly AuditEntry[]): { ok: true } | { ok: false; brokenAt: number } {
  let prev = "genesis";
  for (let i = 0; i < entries.length; i++) {
    const { hash, ...rest } = entries[i];
    if (entries[i].seq !== i || entries[i].prev !== prev || chain(rest) !== hash) return { ok: false, brokenAt: i };
    prev = hash;
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

  function record(kind: AuditEntry["kind"], actor: string, fields: Partial<Pick<AuditEntry, "grantId" | "action" | "origin" | "selector" | "detail">> = {}): void {
    const prev = log.length ? log[log.length - 1].hash : "genesis";
    const base = { seq: log.length, at: now(), kind, actor, ...fields, prev };
    log.push({ ...base, hash: chain(base) });
  }

  const actorOf = (grantee: Grantee) => `${grantee.owner}/${grantee.agent}`;

  function requestGrant(input: { grantee: Grantee; origin: string; pathPrefix?: string; actions: WebAction[]; ttlMs?: number; reason?: string }): { ok: true; request: GrantRequest } | { ok: false; error: string } {
    const origin = originOf(input.origin);
    if (!origin) return { ok: false, error: "a grant needs an http or https site" };
    const parsedPath = pathOf(input.origin);
    const pathPrefix = canonicalPathPrefix(input.pathPrefix ?? (parsedPath && parsedPath !== "/" ? parsedPath : undefined));
    if (pathPrefix === null) return { ok: false, error: "path prefix must be an absolute URL path without query or fragment" };
    if (isBlockedOrigin(origin, deps.blockedHosts)) return { ok: false, error: `${new URL(origin).hostname} is on the never-grant list` };
    if (!input.actions.length) return { ok: false, error: "a grant needs at least one action" };
    if (input.grantee.owner === deps.ownerId) return { ok: false, error: "your own agents do not need a grant" };
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
    return [...requests.values()].filter((r) => now() - r.createdAt <= REQUEST_TTL_MS);
  }

  function approve(requestId: string, narrow: { actions?: WebAction[]; ttlMs?: number; maxUses?: number } = {}): { ok: true; grant: Grant } | { ok: false; error: string } {
    const request = requests.get(requestId);
    if (!request || now() - request.createdAt > REQUEST_TTL_MS) return { ok: false, error: "that request is unknown or has expired" };
    requests.delete(requestId);
    const actions = narrow.actions ? request.actions.filter((a) => narrow.actions?.includes(a)) : request.actions;
    if (!actions.length) return { ok: false, error: "nothing is left after narrowing the request" };
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
      action: fields.action?.slice(0, 40),
      ...(origin ? { origin } : {}),
      selector: fields.selector?.slice(0, 200),
      detail: fields.detail?.slice(0, 120),
    });
  }

  function snapshot(): WebAuthoritySnapshot {
    return {
      version: 1,
      grants: [...grants.values()].map((grant) => ({ ...grant, grantee: { ...grant.grantee }, actions: [...grant.actions] })),
      requests: [...requests.values()].map((request) => ({ ...request, grantee: { ...request.grantee }, actions: [...request.actions] })),
      audit: log.map((entry) => ({ ...entry })),
    };
  }

  function restore(state: WebAuthoritySnapshot): void {
    if (state.version !== 1 || !Array.isArray(state.grants) || !Array.isArray(state.requests) || !Array.isArray(state.audit)) {
      throw new Error("invalid web authority snapshot");
    }
    if (!verifyAudit(state.audit).ok) throw new Error("web authority audit chain is invalid");
    grants.clear();
    requests.clear();
    log.splice(0, log.length);
    for (const grant of state.grants) grants.set(grant.id, { ...grant, grantee: { ...grant.grantee }, actions: [...grant.actions] });
    for (const request of state.requests) requests.set(request.id, { ...request, grantee: { ...request.grantee }, actions: [...request.actions] });
    log.push(...state.audit.map((entry) => ({ ...entry })));
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
    snapshot,
    restore,
  };
}

export type WebAuthority = ReturnType<typeof createWebAuthority>;
