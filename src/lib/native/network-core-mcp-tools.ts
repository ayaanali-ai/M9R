import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { VerifiedIdentity } from "./identity-core";
import type { NetworkCoreClient } from "./network-core-client";

const LOCAL_TOKEN_FIELD = {
  token: z.string().min(1).describe("Your local M9R session token from the SessionStart card. This identifies the current Claude/Codex/OpenCode session to local M9R."),
};

const NETWORK_ID_FIELD = {
  network_id: z.string().uuid().describe("The M9R network UUID returned when this agent joined."),
};

function asText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function networkProvider(provider: string): string {
  if (provider === "claude-code") return "claude";
  if (provider === "codex-cli") return "codex";
  return provider;
}

export function registerNetworkCoreTools(input: {
  server: McpServer;
  client: NetworkCoreClient;
  requireIdentity(token: string): VerifiedIdentity;
}): void {
  const { server, client, requireIdentity } = input;

  server.registerTool(
    "m9r_network_join",
    {
      description: "Join an M9R Network using an owner-issued one-time pairing code. Returns this agent's network bearer credential once. Copy it into this provider's M9R_NETWORK_CREDENTIALS_JSON MCP environment, keyed by network_id, then restart the MCP server. The credential is not saved by this tool.",
      inputSchema: {
        ...LOCAL_TOKEN_FIELD,
        pairing_code: z.string().min(8).max(9).describe("The one-time code issued by the network owner."),
        agent_name: z.string().min(1).max(64).optional().describe("Network-local agent name; defaults to this local M9R handle."),
      },
    },
    async ({ token, pairing_code, agent_name }) => {
      const identity = requireIdentity(token);
      const registration = await client.registerAgent({
        pairing_code,
        agent_name: agent_name ?? identity.handle,
        provider: networkProvider(identity.provider),
        door: "mcp",
      });
      return {
        content: [{
          type: "text",
          text: [
            `Joined the M9R Network as ${registration.handle} (${registration.provider}).`,
            `Network ID: ${registration.network_id}`,
            `Agent ID: ${registration.agent_id}`,
            "The bearer credential is shown once below. Store it in this agent provider's private MCP environment config, then restart the MCP server. Do not commit or share it.",
            `M9R_NETWORK_CREDENTIALS_JSON entry: ${JSON.stringify(registration.network_id)}: ${JSON.stringify(registration.credential)}`,
          ].join("\n"),
        }],
      };
    },
  );

  server.registerTool(
    "m9r_network_roster",
    {
      description: "Read the members and agents in a joined M9R Network. Uses this provider's separately configured network credential; the local M9R session token never grants network membership.",
      inputSchema: { ...LOCAL_TOKEN_FIELD, ...NETWORK_ID_FIELD },
    },
    async ({ token, network_id }) => {
      requireIdentity(token);
      return { content: [{ type: "text", text: asText(await client.roster(network_id)) }] };
    },
  );

  server.registerTool(
    "m9r_network_send",
    {
      description: "Send a message, task, update, file notice, or presence event to a joined agent in an M9R Network. Use a network handle such as @member/agent or * for the joined network. Reuse the same UUID idempotency_key if retrying the same send.",
      inputSchema: {
        ...LOCAL_TOKEN_FIELD,
        ...NETWORK_ID_FIELD,
        to: z.string().min(1).max(80),
        body: z.string().min(1).max(20_000),
        type: z.enum(["message", "file", "task", "task_update", "presence"]).default("message"),
        thread_id: z.string().uuid().nullable().optional(),
        idempotency_key: z.string().uuid().describe("Client-generated UUID; keep it stable when retrying this event."),
      },
    },
    async ({ token, network_id, to, body, type, thread_id, idempotency_key }) => {
      requireIdentity(token);
      const result = await client.sendEvent(network_id, { to, body, type, thread_id, idempotency_key });
      return { content: [{ type: "text", text: asText(result) }] };
    },
  );

  server.registerTool(
    "m9r_network_inbox",
    {
      description: "Poll this agent's M9R Network inbox after a cursor. The response includes the next cursor; save it and supply it on the next poll to avoid replaying prior events.",
      inputSchema: {
        ...LOCAL_TOKEN_FIELD,
        ...NETWORK_ID_FIELD,
        since: z.string().regex(/^(0|[1-9][0-9]{0,14})$/).default("0"),
        limit: z.number().int().min(1).max(200).default(100),
      },
    },
    async ({ token, network_id, since, limit }) => {
      requireIdentity(token);
      return { content: [{ type: "text", text: asText(await client.inbox(network_id, { since, limit })) }] };
    },
  );

  server.registerTool(
    "m9r_network_history",
    {
      description: "Read paginated event history for a joined M9R Network after a cursor.",
      inputSchema: {
        ...LOCAL_TOKEN_FIELD,
        ...NETWORK_ID_FIELD,
        since: z.string().regex(/^(0|[1-9][0-9]{0,14})$/).default("0"),
        limit: z.number().int().min(1).max(200).default(100),
      },
    },
    async ({ token, network_id, since, limit }) => {
      requireIdentity(token);
      return { content: [{ type: "text", text: asText(await client.history(network_id, { since, limit })) }] };
    },
  );

  server.registerTool(
    "m9r_network_request_approval",
    {
      description: "Request human approval for an action in a joined M9R Network. This records a pending approval; an agent cannot grant its own request.",
      inputSchema: {
        ...LOCAL_TOKEN_FIELD,
        ...NETWORK_ID_FIELD,
        action: z.string().min(1).max(160),
        detail: z.string().min(1).max(8_000),
        thread_id: z.string().uuid().nullable().optional(),
      },
    },
    async ({ token, network_id, action, detail, thread_id }) => {
      requireIdentity(token);
      return { content: [{ type: "text", text: asText(await client.requestApproval(network_id, { action, detail, thread_id })) }] };
    },
  );

  server.registerTool(
    "m9r_network_revoke_self",
    {
      description: "Immediately revoke this agent's credential for the selected M9R Network. This cannot be undone; the agent must be paired again to rejoin.",
      inputSchema: { ...LOCAL_TOKEN_FIELD, ...NETWORK_ID_FIELD },
    },
    async ({ token, network_id }) => {
      requireIdentity(token);
      return { content: [{ type: "text", text: asText(await client.revokeSelf(network_id)) }] };
    },
  );
}
