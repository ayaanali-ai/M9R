/**
 * Standalone entry point for the M9R MCP server: `m9r-engine mcp` (dispatch in build-engine.mjs's entry.mjs, same
 * pattern as m9r-hook.ts's own dedicated entry) or `node cli/dist/m9r-mcp.js` when a real Node is present. M9R-owned
 * provider launches pass their exact session scope through private environment metadata; legacy shared registrations
 * retain the provider-binding and compatibility paths in mcp-server.ts.
 */
import { homedir } from "node:os";
import { createLocalStore, defaultStoreRoot } from "@/lib/native/local-store";
import { createM9rMcpServer } from "@/lib/native/mcp-server";
import { readM9rMcpConnectionConfig } from "@/lib/native/mcp-connection-env";
import { createNetworkCoreClient, parseNetworkCredentials } from "@/lib/native/network-core-client";
import { createWebBrokerClient } from "@/lib/native/web-broker-client";
import { brokerKeyPath, ownerPipePath } from "@/lib/native/web-broker-paths";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

async function main(): Promise<void> {
  const root = defaultStoreRoot(homedir(), process.env);
  const store = createLocalStore(root);
  const web = createWebBrokerClient({ keyPath: brokerKeyPath(root), ownerPipePath: ownerPipePath(root), port: Number(process.env.M9R_WEB_BROKER_PORT) || undefined });
  const networkCore = createNetworkCoreClient({
    baseUrl: process.env.M9R_NETWORK_CORE_URL,
    credentials: parseNetworkCredentials(process.env.M9R_NETWORK_CREDENTIALS_JSON),
  });
  const roomStartedAt = Number(process.env.M9R_ROOM_STARTED_AT);
  const connection = readM9rMcpConnectionConfig(process.env, process.ppid);
  const server: McpServer = createM9rMcpServer({
    store,
    web,
    networkCore,
    ...(Number.isSafeInteger(roomStartedAt) && roomStartedAt > 0 ? { roomStartedAt } : {}),
    ...(connection.provider ? { connectionProvider: connection.provider } : {}),
    ...(connection.bindingId ? { connectionBindingId: connection.bindingId } : {}),
    ...(connection.processId ? { connectionProcessId: connection.processId } : {}),
    ...(connection.sessionId ? { connectionSessionId: connection.sessionId } : {}),
    ...(connection.cwd ? { connectionCwd: connection.cwd } : {}),
  });
  const transport = new StdioServerTransport();
  // The SDK's stdio transport never listens for stdin closing, and on Windows a Node process commonly does not exit
  // on its own when its pipe EOFs -- confirmed live: every closed Claude Code/Codex session left this process behind
  // as a permanent orphan, stacking up indefinitely across restarts with nothing to ever reap them. The host closing
  // its end of the pipe is the only signal this process gets that it is no longer wanted; act on it immediately.
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("close", () => process.exit(0));
  await server.connect(transport);
}

main().catch((error) => {
  process.stderr.write(`M9R MCP server crashed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
