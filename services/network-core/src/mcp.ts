import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { AgentCredentialRoute } from "./types";
import { ApiError, UUID_RE } from "./util";

export interface NetworkMcpHandlers {
  registerAgent(request: Request, input: {
    pairing_code: string;
    agent_name: string;
    provider: "muse" | "dots" | "grok";
  }): Promise<Response>;
  callAgentApi(
    request: Request,
    identity: AgentCredentialRoute & { token: string },
    input: { method: "GET" | "POST"; path: string; body?: Record<string, unknown> },
  ): Promise<Response>;
}

const TOOL_ERROR = "The M9R Network request failed.";

function textResult(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

async function responseResult(response: Response) {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = { error: TOOL_ERROR, status: response.status };
  }
  return textResult(payload, !response.ok);
}

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  return header && /^Bearer\s+(.+)$/i.test(header) ? header.replace(/^Bearer\s+/i, "").trim() : null;
}

function credentialIdentity(request: Request): AgentCredentialRoute & { token: string } {
  const token = bearer(request);
  const match = token && /^m9rn\.([0-9a-f-]{36})\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/i.exec(token);
  if (!token || !match || !UUID_RE.test(match[1]) || !UUID_RE.test(match[2])) {
    throw new ApiError("This tool requires the M9R agent credential configured for this connector.", 401, "UNAUTHORIZED");
  }
  return { networkId: match[1].toLowerCase(), agentId: match[2].toLowerCase(), token };
}

function toolError(error: unknown) {
  const message = error instanceof ApiError ? error.message : TOOL_ERROR;
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

async function withAgentApi(
  request: Request,
  handlers: NetworkMcpHandlers,
  input: { method: "GET" | "POST"; path: string; body?: Record<string, unknown> },
) {
  try {
    const identity = credentialIdentity(request);
    return await responseResult(await handlers.callAgentApi(request, identity, {
      ...input,
      path: input.path.replaceAll("__NETWORK__", `/v1/networks/${identity.networkId}`),
    }));
  } catch (error) {
    return toolError(error);
  }
}

function createNetworkMcpServer(request: Request, handlers: NetworkMcpHandlers): McpServer {
  const server = new McpServer({ name: "m9r-network-core", version: "1.0.0" });

  server.registerTool("m9r_register", {
    title: "Join an M9R network",
    description: "Redeem an owner-issued one-time pairing code for this personal agent. The response contains a bearer credential shown once. Copy it into this agent's private connector authentication settings, then reconnect. Never share the credential or use this tool in a shared conversation.",
    inputSchema: {
      pairing_code: z.string().min(8).max(9),
      agent_name: z.string().min(1).max(38).describe("Network-local name for this agent, such as muse, dots, or grok."),
      provider: z.enum(["muse", "dots", "grok"]),
    },
  }, async ({ pairing_code, agent_name, provider }) => {
    try {
      const response = await handlers.registerAgent(request, { pairing_code, agent_name, provider });
      if (!response.ok) return await responseResult(response);
      const registration = await response.json() as Record<string, unknown>;
      return textResult({
        ...registration,
        credential_notice: "This bearer credential is shown once and may be retained in the provider conversation. Copy it only into this agent's private M9R connector authentication settings; do not share or commit it. Revoke it immediately if exposed.",
      });
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool("m9r_roster", {
    title: "Read the network roster",
    description: "List the people and agents in the M9R network attached to this connector credential.",
    inputSchema: {},
  }, async () => withAgentApi(request, handlers, {
    method: "GET",
    path: "__NETWORK__/roster",
  }));

  server.registerTool("m9r_send", {
    title: "Send a network event",
    description: "Send a message, task, task update, file notice, or presence event to a member agent such as @mom/dots. Delivery is store-and-forward. Use a new UUID idempotency key for a new event and reuse the same key only when retrying that exact event.",
    inputSchema: {
      to: z.string().min(1).max(80),
      body: z.string().min(1).max(20_000),
      type: z.enum(["message", "file", "task", "task_update", "presence"]).default("message"),
      thread_id: z.string().uuid().nullable().optional(),
      idempotency_key: z.string().uuid(),
    },
  }, async ({ to, body, type, thread_id, idempotency_key }) => withAgentApi(request, handlers, {
    method: "POST",
    path: "/v1/events",
    body: { to, body, type, thread_id: thread_id ?? null, idempotency_key },
  }));

  server.registerTool("m9r_inbox", {
    title: "Read this agent's inbox",
    description: "Poll this agent's durable M9R inbox. Save the returned cursor and use it as since on the next poll to avoid replaying older events.",
    inputSchema: {
      since: z.string().regex(/^(0|[1-9][0-9]{0,14})$/).default("0"),
      limit: z.number().int().min(1).max(200).default(100),
    },
  }, async ({ since, limit }) => withAgentApi(request, handlers, {
    method: "GET",
    path: `/v1/events?since=${encodeURIComponent(since)}&limit=${limit}`,
  }));

  server.registerTool("m9r_history", {
    title: "Read network history",
    description: "Read the network's shared, paginated event history after a sequence cursor.",
    inputSchema: {
      since: z.string().regex(/^(0|[1-9][0-9]{0,14})$/).default("0"),
      limit: z.number().int().min(1).max(200).default(100),
    },
  }, async ({ since, limit }) => withAgentApi(request, handlers, {
    method: "GET",
    path: `__NETWORK__/events?since=${encodeURIComponent(since)}&limit=${limit}`,
  }));

  server.registerTool("m9r_request_approval", {
    title: "Request human approval",
    description: "Record an approval request for a human network owner. This creates a pending request; it does not grant approval or execute the action.",
    inputSchema: {
      action: z.string().min(1).max(160),
      detail: z.string().min(1).max(8_000),
      thread_id: z.string().uuid().nullable().optional(),
    },
  }, async ({ action, detail, thread_id }) => withAgentApi(request, handlers, {
    method: "POST",
    path: "/v1/approvals",
    body: { action, detail, thread_id: thread_id ?? null },
  }));

  server.registerTool("m9r_revoke_self", {
    title: "Revoke this agent's network access",
    description: "Immediately revoke this agent's credential for the network. Rejoining requires a new owner-issued pairing code. Use only when explicitly asked to disconnect this agent.",
    inputSchema: { confirm: z.literal("REVOKE") },
  }, async ({ confirm }) => {
    if (confirm !== "REVOKE") return toolError(new ApiError("Set confirm to REVOKE to disconnect this agent.", 400, "CONFIRMATION_REQUIRED"));
    try {
      const identity = credentialIdentity(request);
      return await responseResult(await handlers.callAgentApi(request, identity, {
        method: "POST",
        path: `/v1/networks/${identity.networkId}/agents/${identity.agentId}/revoke`,
        body: {},
      }));
    } catch (error) {
      return toolError(error);
    }
  });

  return server;
}

/**
 * Serve the provider-neutral agent tools without per-client in-memory state.
 * The SDK transport and MCP server are deliberately created for each HTTP
 * request so Cloudflare can handle independent provider requests safely.
 */
export async function handleNetworkMcpRequest(request: Request, handlers: NetworkMcpHandlers): Promise<Response> {
  const server = createNetworkMcpServer(request, handlers);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  return transport.handleRequest(request);
}

