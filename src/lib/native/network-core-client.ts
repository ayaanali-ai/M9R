const NETWORK_CORE_DEFAULT_URL = "https://m9r-network-core.m9r.workers.dev";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT_CREDENTIAL_PATTERN = /^m9rn\.([0-9a-f-]{36})\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/i;

export interface NetworkAgentCredentialParts {
  networkId: string;
  agentId: string;
}

export interface NetworkAgentRegistration {
  agent_id: string;
  network_id: string;
  member_id: string;
  handle: string;
  provider: string;
  door: string;
  scopes: string[];
  status: string;
  credential: string;
}

export class NetworkCoreClientError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message);
    this.name = "NetworkCoreClientError";
  }
}

export interface NetworkCoreClient {
  registerAgent(input: { pairing_code: string; agent_name: string; provider: string; door: string }): Promise<NetworkAgentRegistration>;
  roster(networkId: string): Promise<unknown>;
  sendEvent(networkId: string, input: {
    to: string;
    body: string;
    type: "message" | "file" | "task" | "task_update" | "presence";
    thread_id?: string | null;
    idempotency_key: string;
  }): Promise<unknown>;
  inbox(networkId: string, input: { since: string; limit: number }): Promise<unknown>;
  history(networkId: string, input: { since: string; limit: number }): Promise<unknown>;
  requestApproval(networkId: string, input: { action: string; detail: string; thread_id?: string | null }): Promise<unknown>;
  revokeSelf(networkId: string): Promise<unknown>;
}

export function parseNetworkAgentCredential(value: string): NetworkAgentCredentialParts | null {
  const match = AGENT_CREDENTIAL_PATTERN.exec(value);
  if (!match || !UUID_PATTERN.test(match[1]) || !UUID_PATTERN.test(match[2])) return null;
  return { networkId: match[1].toLowerCase(), agentId: match[2].toLowerCase() };
}

/**
 * Parse per-agent credentials from the MCP process environment. Keeping bearer credentials in client config
 * avoids repeating them in model-visible tool arguments. The JSON object is keyed by network UUID so an agent
 * can hold a distinct membership credential for each network.
 */
export function parseNetworkCredentials(raw: string | undefined): Readonly<Record<string, string>> {
  if (!raw?.trim()) return Object.freeze({});

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("M9R_NETWORK_CREDENTIALS_JSON must be a JSON object keyed by network UUID.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("M9R_NETWORK_CREDENTIALS_JSON must be a JSON object keyed by network UUID.");
  }

  const credentials: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [rawNetworkId, value] of Object.entries(parsed)) {
    const networkId = rawNetworkId.toLowerCase();
    if (!UUID_PATTERN.test(networkId) || typeof value !== "string") {
      throw new Error("M9R_NETWORK_CREDENTIALS_JSON contains an invalid network entry.");
    }
    const parts = parseNetworkAgentCredential(value);
    if (!parts || parts.networkId !== networkId) {
      throw new Error("M9R_NETWORK_CREDENTIALS_JSON contains a credential that does not match its network UUID.");
    }
    credentials[networkId] = value;
  }
  return Object.freeze(credentials);
}

function validateNetworkId(networkId: string): string {
  const normalized = networkId.toLowerCase();
  if (!UUID_PATTERN.test(normalized)) throw new NetworkCoreClientError("network_id must be a UUID.", 400, "INVALID_NETWORK_ID");
  return normalized;
}

export function createNetworkCoreClient(options: {
  baseUrl?: string;
  credentials?: Readonly<Record<string, string>>;
  fetch?: typeof globalThis.fetch;
} = {}): NetworkCoreClient {
  const baseUrl = options.baseUrl ?? NETWORK_CORE_DEFAULT_URL;
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new Error("M9R_NETWORK_CORE_URL must be a valid HTTPS URL (HTTP is allowed only for loopback development).");
  }
  const isLoopback = base.hostname === "localhost" || base.hostname === "127.0.0.1" || base.hostname === "[::1]";
  if ((base.protocol !== "https:" && !(base.protocol === "http:" && isLoopback)) || base.username || base.password || base.search || base.hash) {
    throw new Error("M9R_NETWORK_CORE_URL must be HTTPS (HTTP is allowed only for loopback development) and must not contain credentials, a query, or a fragment.");
  }
  const origin = base.origin;
  const credentials: Readonly<Record<string, string>> = options.credentials ?? Object.freeze(Object.create(null) as Record<string, string>);
  const fetcher = options.fetch ?? globalThis.fetch;

  function credentialFor(networkId: string): string {
    const normalizedId = validateNetworkId(networkId);
    const credential = credentials[normalizedId];
    const parsed = typeof credential === "string" ? parseNetworkAgentCredential(credential) : null;
    if (!parsed || parsed.networkId !== normalizedId) {
      throw new NetworkCoreClientError(
        `No valid Network Core credential is configured for network ${normalizedId}. Join with a pairing code, add the returned credential to this agent's M9R_NETWORK_CREDENTIALS_JSON, and restart its MCP server.`,
        401,
        "NETWORK_CREDENTIAL_NOT_CONFIGURED",
      );
    }
    return credential;
  }

  async function request<T>(path: string, input: { method?: "GET" | "POST"; credential?: string; body?: unknown } = {}): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const headers = new Headers({ accept: "application/json" });
    if (input.body !== undefined) headers.set("content-type", "application/json");
    if (input.credential) headers.set("authorization", `Bearer ${input.credential}`);
    let response: Response;
    let payload: unknown;
    try {
      response = await fetcher(new URL(path, `${origin}/`), {
        method: input.method ?? "GET",
        headers,
        ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
        signal: controller.signal,
        cache: "no-store",
      });
      try {
        payload = await response.json();
      } catch {
        throw new NetworkCoreClientError("The M9R Network Core returned an unreadable response.", response.status);
      }
    } catch (error) {
      if (error instanceof NetworkCoreClientError) throw error;
      throw new NetworkCoreClientError("Could not reach the M9R Network Core. Check the endpoint and connection, then retry.");
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      const record = payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : {};
      const message = typeof record.error === "string" ? record.error : `Network Core request failed (${response.status}).`;
      const code = typeof record.code === "string" ? record.code : undefined;
      throw new NetworkCoreClientError(message, response.status, code);
    }
    return payload as T;
  }

  function authorized(networkId: string, path: string, input: { method?: "GET" | "POST"; body?: unknown } = {}) {
    const normalizedId = validateNetworkId(networkId);
    return request(path.replace(":networkId", normalizedId), { ...input, credential: credentialFor(normalizedId) });
  }

  return {
    async registerAgent(input) {
      const result = await request<NetworkAgentRegistration>("/v1/agents/register", { method: "POST", body: input });
      const parts = typeof result?.credential === "string" ? parseNetworkAgentCredential(result.credential) : null;
      if (!parts || parts.networkId !== String(result.network_id).toLowerCase() || parts.agentId !== String(result.agent_id).toLowerCase()) {
        throw new NetworkCoreClientError("The Network Core returned an invalid agent registration response.");
      }
      return result;
    },
    roster(networkId) {
      return authorized(networkId, "/v1/networks/:networkId/roster");
    },
    sendEvent(networkId, input) {
      return authorized(networkId, "/v1/events", { method: "POST", body: input });
    },
    inbox(networkId, input) {
      const query = new URLSearchParams({ since: input.since, limit: String(input.limit) });
      return authorized(networkId, `/v1/events?${query.toString()}`);
    },
    history(networkId, input) {
      const query = new URLSearchParams({ since: input.since, limit: String(input.limit) });
      return authorized(networkId, `/v1/networks/:networkId/events?${query.toString()}`);
    },
    requestApproval(networkId, input) {
      return authorized(networkId, "/v1/approvals", { method: "POST", body: input });
    },
    async revokeSelf(networkId) {
      const parts = parseNetworkAgentCredential(credentialFor(networkId));
      if (!parts) throw new NetworkCoreClientError("The configured Network Core credential is invalid.", 401, "INVALID_CREDENTIAL");
      return authorized(networkId, `/v1/agents/${parts.agentId}/revoke`, { method: "POST", body: {} });
    },
  };
}
