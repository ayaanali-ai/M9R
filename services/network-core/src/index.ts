import type { Env, HumanIdentity } from "./types";
import { ApiError, hmacText, json, makePairingCode, normalizeSlug, randomTokenSecret, readJson, requireString, UUID_RE } from "./util";
import { handleNetworkMcpRequest } from "./mcp";
import { handleAgentDoorRequest } from "./agent-door";
export { NetworkActor } from "./network-actor";

const CORS_ORIGINS = new Set(["https://m9r.dev", "https://www.m9r.dev", "http://localhost:3001", "http://localhost:5173"]);
const NETWORK_ROUTE = /^\/v1\/networks\/([0-9a-f-]{36})(?:\/.*)?$/i;
const AGENT_ACTION_ROUTE = /^\/v1\/agents\/([0-9a-f-]{36})\/(rotate|revoke)$/i;
const APPROVAL_DECISION_ROUTE = /^\/v1\/approvals\/([0-9a-f-]{36})\/decision$/i;

function withCors(response: Response, origin: string | null): Response {
  if (!origin || !CORS_ORIGINS.has(origin)) return response;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
  headers.set("access-control-allow-headers", "authorization,content-type,idempotency-key,mcp-protocol-version,mcp-session-id,last-event-id");
  headers.set("access-control-expose-headers", "mcp-protocol-version,mcp-session-id");
  headers.set("access-control-max-age", "600");
  headers.append("vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function preflight(origin: string | null): Response {
  const headers = new Headers();
  if (origin && CORS_ORIGINS.has(origin)) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
    headers.set("access-control-allow-headers", "authorization,content-type,idempotency-key,mcp-protocol-version,mcp-session-id,last-event-id");
    headers.set("access-control-expose-headers", "mcp-protocol-version,mcp-session-id");
    headers.set("access-control-max-age", "600");
    headers.append("vary", "Origin");
  }
  return new Response(null, { status: 204, headers });
}

function bearer(request: Request): string | null {
  const value = request.headers.get("authorization");
  const match = value && /^Bearer\s+(.+)$/i.exec(value);
  return match?.[1]?.trim() ?? null;
}

function parseAgentCredential(token: string): { networkId: string; agentId: string } | null {
  const match = /^m9rn\.([0-9a-f-]{36})\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/i.exec(token);
  if (!match || !UUID_RE.test(match[1]) || !UUID_RE.test(match[2])) return null;
  return { networkId: match[1].toLowerCase(), agentId: match[2].toLowerCase() };
}

async function requireHuman(request: Request, env: Env): Promise<HumanIdentity> {
  const token = bearer(request);
  if (!token || token.startsWith("m9rn.")) throw new ApiError("A signed-in human session is required.", 401, "UNAUTHORIZED");
  if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) throw new ApiError("Human authentication is not configured.", 503, "AUTH_NOT_CONFIGURED");
  let response: Response;
  try {
    response = await fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/user`, {
      headers: { authorization: `Bearer ${token}`, apikey: env.SUPABASE_PUBLISHABLE_KEY },
    });
  } catch {
    throw new ApiError("Human authentication is temporarily unavailable.", 503, "AUTH_UNAVAILABLE");
  }
  if (!response.ok) throw new ApiError("The human session is invalid or expired.", 401, "UNAUTHORIZED");
  const user = await response.json() as { id?: unknown; email?: unknown };
  if (typeof user.id !== "string" || user.id.length < 1 || user.id.length > 128) throw new ApiError("Human authentication returned an invalid identity.", 401, "UNAUTHORIZED");
  return { userId: user.id, email: typeof user.email === "string" ? user.email : null };
}

function internalRequest(request: Request, path: string, principal: { userId: string } | { token: string }): Promise<Request> {
  return request.arrayBuffer().then((body) => {
    const headers = new Headers(request.headers);
    headers.delete("authorization");
    headers.delete("cookie");
    headers.delete("x-m9r-human-user");
    headers.delete("x-m9r-agent-token");
    if ("userId" in principal) headers.set("x-m9r-human-user", principal.userId);
    else headers.set("x-m9r-agent-token", principal.token);
    return new Request(`https://network.internal${path}`, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : body,
    });
  });
}

async function callActor(env: Env, request: Request, networkId: string, path: string, principal: { userId: string } | { token: string }): Promise<Response> {
  const actorId = env.NETWORKS.idFromName(networkId);
  const actor = env.NETWORKS.get(actorId);
  const forwarded = await internalRequest(request, `${path}${new URL(request.url).search}`, principal);
  return actor.fetch(forwarded);
}

function normalizePairingCode(value: unknown): string {
  const code = requireString(value, "pairing_code", 8, 9).toUpperCase().replace(/[ -]/g, "");
  if (!/^[0-9A-HJKMNP-TV-Z]{8}$/.test(code)) throw new ApiError("pairing_code must contain eight Crockford Base32 characters.", 400, "INVALID_PAIRING_CODE");
  return code;
}

async function enforceRegistrationLimit(request: Request, env: Env): Promise<void> {
  const pepper = env.PAIRING_CODE_PEPPER;
  if (!pepper || pepper.length < 32) throw new ApiError("Pairing protection is not configured.", 503, "PAIRING_NOT_CONFIGURED");
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const ipHash = await hmacText(pepper, `registration-ip\0${ip}`);
  const bucketStart = Math.floor(Date.now() / 600_000) * 600_000;
  await env.HISTORY.prepare("INSERT INTO registration_rate_limits (ip_hash, window_start, attempts) VALUES (?, ?, 1) ON CONFLICT(ip_hash, window_start) DO UPDATE SET attempts = attempts + 1")
    .bind(ipHash, bucketStart).run();
  const row = await env.HISTORY.prepare("SELECT attempts FROM registration_rate_limits WHERE ip_hash = ? AND window_start = ?")
    .bind(ipHash, bucketStart).first<{ attempts: number }>();
  if (!row || Number(row.attempts) > 30) throw new ApiError("Too many registration attempts. Try again later.", 429, "RATE_LIMITED");
}

async function registerAgent(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const code = normalizePairingCode(body.pairing_code);
  await enforceRegistrationLimit(request, env);
  const pepper = env.PAIRING_CODE_PEPPER;
  const codeHash = await hmacText(pepper, `pairing-code\0${code}`);
  const route = await env.HISTORY.prepare("SELECT network_id, expires_at FROM pairing_routes WHERE code_hash = ?")
    .bind(codeHash).first<{ network_id: string; expires_at: number }>();
  if (!route || Number(route.expires_at) <= Date.now()) throw new ApiError("The pairing code is invalid, expired, or already used.", 400, "PAIRING_CODE_UNAVAILABLE");
  const agentName = normalizeSlug(body.agent_name, "agent_name");
  const provider = requireString(body.provider, "provider", 1, 32).toLowerCase();
  const door = body.door === undefined ? "mcp" : requireString(body.door, "door", 1, 32).toLowerCase();
  const agentId = crypto.randomUUID();
  const credential = `m9rn.${route.network_id}.${agentId}.${randomTokenSecret()}`;
  const actor = env.NETWORKS.get(env.NETWORKS.idFromName(route.network_id));
  const internal = new Request("https://network.internal/_internal/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code_hash: codeHash, agent_name: agentName, provider, door, agent_id: agentId, credential }),
  });
  const response = await actor.fetch(internal);
  if (!response.ok) return response;
  const result = await response.json() as Record<string, unknown>;
  const routeConsumed = result._route_consumed === true;
  delete result._route_consumed;
  if (routeConsumed) {
    try {
      await env.HISTORY.prepare("DELETE FROM pairing_routes WHERE code_hash = ? AND network_id = ?").bind(codeHash, route.network_id).run();
    } catch {
      // The Durable Object has consumed the code transactionally. A stale D1
      // index can only route a retry back to that same rejecting object.
    }
  }
  return json(result, 201);
}

async function createNetwork(request: Request, env: Env): Promise<Response> {
  const user = await requireHuman(request, env);
  const body = await readJson(request);
  const name = requireString(body.name, "name", 1, 100);
  const networkId = crypto.randomUUID();
  const rawOwner = typeof body.owner_handle === "string" && body.owner_handle.trim()
    ? body.owner_handle
    : user.email?.split("@")[0] ?? "owner";
  const ownerHandle = normalizeSlug(rawOwner, "owner_handle");
  const createdAt = new Date().toISOString();
  await env.HISTORY.prepare("INSERT INTO networks (network_id, name, owner_user_id, created_at) VALUES (?, ?, ?, ?)")
    .bind(networkId, name, user.userId, createdAt).run();
  const actor = env.NETWORKS.get(env.NETWORKS.idFromName(networkId));
  const response = await actor.fetch(new Request("https://network.internal/_internal/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ network_id: networkId, name, owner_user_id: user.userId, owner_handle: ownerHandle, owner_display_name: body.owner_display_name ?? null }),
  }));
  if (!response.ok) {
    await env.HISTORY.prepare("DELETE FROM networks WHERE network_id = ?").bind(networkId).run();
    return response;
  }
  return json({ network_id: networkId, name, created_at: createdAt, owner_handle: ownerHandle }, 201);
}

async function createPairingCode(request: Request, env: Env, networkId: string, userId: string): Promise<Response> {
  const body = await readJson(request);
  if (!env.PAIRING_CODE_PEPPER || env.PAIRING_CODE_PEPPER.length < 32) throw new ApiError("Pairing protection is not configured.", 503, "PAIRING_NOT_CONFIGURED");
  const code = makePairingCode();
  const codeHash = await hmacText(env.PAIRING_CODE_PEPPER, `pairing-code\0${code.replace("-", "")}`);
  const actor = env.NETWORKS.get(env.NETWORKS.idFromName(networkId));
  const response = await actor.fetch(await internalRequest(
    new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify({ ...body, code_hash: codeHash }) }),
    `/v1/networks/${networkId}/pairing-codes`,
    { userId },
  ));
  if (!response.ok) return response;
  const result = await response.json() as Record<string, unknown>;
  try {
    await env.HISTORY.prepare("INSERT INTO pairing_routes (pairing_id, code_hash, network_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(result.pairing_code_id, codeHash, networkId, Date.parse(String(result.expires_at)), Date.now()).run();
  } catch {
    return json({ error: "Pairing code routing could not be stored; the code was not issued. Retry with a new code." }, 503);
  }
  return json({ ...result, code }, 201);
}

async function routeRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const agentDoorResponse = await handleAgentDoorRequest(request, {
    registerAgent: (source, input) => {
      const headers = new Headers({ "content-type": "application/json" });
      const clientIp = source.headers.get("cf-connecting-ip");
      if (clientIp) headers.set("cf-connecting-ip", clientIp);
      return registerAgent(new Request(new URL("/v1/agents/register", source.url), {
        method: "POST",
        headers,
        body: JSON.stringify(input),
      }), env);
    },
    callAgentApi: (source, identity, path, input = {}) => {
      const target = new URL(path, source.url);
      const headers = new Headers();
      const init: RequestInit = { method: input.method ?? "GET", headers };
      if (input.method === "POST") {
        headers.set("content-type", "application/json");
        init.body = JSON.stringify(input.body ?? {});
      }
      return callActor(env, new Request(target, init), identity.networkId, target.pathname, { token: identity.token });
    },
  });
  if (agentDoorResponse) return agentDoorResponse;
  if (request.method === "GET" && url.pathname === "/health") return json({ ok: true, service: "m9r-network-core" });
  if (request.method === "POST" && url.pathname === "/v1/networks") return createNetwork(request, env);
  if (request.method === "POST" && url.pathname === "/v1/agents/register") return registerAgent(request, env);
  if (url.pathname === "/mcp") {
    return handleNetworkMcpRequest(request, {
      registerAgent: (mcpRequest, input) => {
        const headers = new Headers({ "content-type": "application/json" });
        const clientIp = mcpRequest.headers.get("cf-connecting-ip");
        if (clientIp) headers.set("cf-connecting-ip", clientIp);
        return registerAgent(new Request(mcpRequest.url, {
          method: "POST",
          headers,
          body: JSON.stringify(input),
        }), env);
      },
      callAgentApi: (mcpRequest, identity, input) => {
        const target = new URL(mcpRequest.url);
        target.search = "";
        target.hash = "";
        const headers = new Headers();
        const init: RequestInit = { method: input.method, headers };
        if (input.method === "POST") {
          headers.set("content-type", "application/json");
          init.body = JSON.stringify(input.body ?? {});
        }
        return callActor(
          env,
          new Request(target, init),
          identity.networkId,
          input.path,
          { token: identity.token },
        );
      },
    });
  }

  const token = bearer(request);
  const agent = token ? parseAgentCredential(token) : null;
  if (token?.startsWith("m9rn.") && !agent) throw new ApiError("Agent credential is malformed.", 401, "INVALID_CREDENTIAL");

  const globalAgentAction = AGENT_ACTION_ROUTE.exec(url.pathname);
  if (globalAgentAction) {
    const [, rawTargetAgentId, action] = globalAgentAction;
    const targetAgentId = rawTargetAgentId.toLowerCase();
    let networkId: string;
    let principal: { userId: string } | { token: string };
    let bodyValue: Record<string, unknown> | null = null;
    if (agent && token) {
      if (agent.agentId !== targetAgentId.toLowerCase()) throw new ApiError("An agent can manage only its own credential.", 403, "FORBIDDEN");
      networkId = agent.networkId;
      principal = { token };
      bodyValue = {};
    } else {
      const human = await requireHuman(request, env);
      const rawBody = await request.clone().text();
      if (rawBody.trim()) {
        try {
          const parsed: unknown = JSON.parse(rawBody);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
          bodyValue = parsed as Record<string, unknown>;
        } catch {
          throw new ApiError("Request body must be a JSON object.", 400, "INVALID_JSON");
        }
      } else {
        bodyValue = {};
      }
      networkId = requireString(bodyValue?.network_id ?? url.searchParams.get("network_id"), "network_id", 36, 36);
      if (!UUID_RE.test(networkId)) throw new ApiError("network_id must be a UUID.", 400, "INVALID_NETWORK_ID");
      networkId = networkId.toLowerCase();
      principal = { userId: human.userId };
    }
    const path = `/v1/networks/${networkId}/agents/${targetAgentId}/${action}`;
    if (action === "rotate") {
      const credential = `m9rn.${networkId}.${targetAgentId}.${randomTokenSecret()}`;
      const body = { ...(bodyValue ?? {}), ...("userId" in principal ? { network_id: networkId } : {}), credential };
      const forwarded = new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify(body) });
      return callActor(env, forwarded, networkId, path, principal);
    }
    if (bodyValue) {
      const forwarded = new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify(bodyValue) });
      return callActor(env, forwarded, networkId, path, principal);
    }
    return callActor(env, request, networkId, path, principal);
  }

  const globalApprovalDecision = APPROVAL_DECISION_ROUTE.exec(url.pathname);
  if (globalApprovalDecision) {
    const human = await requireHuman(request, env);
    const body = await readJson(request.clone());
    const networkId = requireString(body.network_id ?? url.searchParams.get("network_id"), "network_id", 36, 36);
    if (!UUID_RE.test(networkId)) throw new ApiError("network_id must be a UUID.", 400, "INVALID_NETWORK_ID");
    const canonicalNetworkId = networkId.toLowerCase();
    const path = `/v1/networks/${canonicalNetworkId}/approvals/${globalApprovalDecision[1]}/decision`;
    const forwarded = new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify(body) });
    return callActor(env, forwarded, canonicalNetworkId, path, { userId: human.userId });
  }

  if (url.pathname === "/v1/events" || url.pathname === "/v1/approvals") {
    if (!agent || !token) throw new ApiError("An M9R agent credential is required.", 401, "UNAUTHORIZED");
    return callActor(env, request, agent.networkId, url.pathname, { token });
  }

  const networkMatch = NETWORK_ROUTE.exec(url.pathname);
  if (networkMatch) {
    const networkId = networkMatch[1].toLowerCase();
    if (!UUID_RE.test(networkId)) throw new ApiError("network_id must be a UUID.", 400, "INVALID_NETWORK_ID");
    let principal: { userId: string } | { token: string };
    if (agent && token) {
      if (agent.networkId !== networkId) throw new ApiError("This credential belongs to a different network.", 403, "NETWORK_MISMATCH");
      principal = { token };
    } else {
      const human = await requireHuman(request, env);
      principal = { userId: human.userId };
    }
    if (url.pathname === `/v1/networks/${networkId}/pairing-codes` && request.method === "POST") {
      if (!("userId" in principal)) throw new ApiError("Only a signed-in network owner can issue pairing codes.", 403, "FORBIDDEN");
      return createPairingCode(request, env, networkId, principal.userId);
    }
    const pairingRevoke = /^\/v1\/networks\/[0-9a-f-]{36}\/pairing-codes\/([0-9a-f-]{36})\/revoke$/i.exec(url.pathname);
    const response = await callActor(env, request, networkId, url.pathname, principal);
    if (pairingRevoke && request.method === "POST" && response.ok) {
      try {
        await env.HISTORY.prepare("DELETE FROM pairing_routes WHERE pairing_id = ? AND network_id = ?").bind(pairingRevoke[1], networkId).run();
      } catch {
        // The Durable Object has marked the code revoked; a stale route is harmless.
      }
    }
    return response;
  }
  throw new ApiError("Not found.", 404, "NOT_FOUND");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("origin");
    if (request.method === "OPTIONS") return preflight(origin);
    try {
      return withCors(await routeRequest(request, env), origin);
    } catch (error) {
      if (error instanceof ApiError) return withCors(json({ error: error.message, code: error.code }, error.status), origin);
      console.error("Network Worker request failed:", error instanceof Error ? error.name : "unknown");
      return withCors(json({ error: "The network service could not complete the request.", code: "NETWORK_STORAGE_ERROR" }, 503), origin);
    }
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const networks = await env.HISTORY.prepare("SELECT network_id FROM networks ORDER BY created_at LIMIT 500").all<{ network_id: string }>();
    for (let start = 0; start < networks.results.length; start += 20) {
      const batch = networks.results.slice(start, start + 20);
      await Promise.all(batch.map(async (row) => {
        const actor = env.NETWORKS.get(env.NETWORKS.idFromName(row.network_id));
        await actor.fetch(new Request("https://network.internal/_internal/prune", { method: "POST" }));
      }));
    }
    const now = Date.now();
    await env.HISTORY.prepare("DELETE FROM pairing_routes WHERE expires_at < ?").bind(now - 30 * 86_400_000).run();
    await env.HISTORY.prepare("DELETE FROM registration_rate_limits WHERE window_start < ?").bind(now - 86_400_000).run();
    await env.HISTORY.prepare("DELETE FROM network_audit_history WHERE created_at < ?").bind(new Date(now - 3_650 * 86_400_000).toISOString()).run();
  },
};
