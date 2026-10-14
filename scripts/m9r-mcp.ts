/**
 * Standalone entry point for the M9R MCP server: `m9r-engine mcp` (dispatch in build-engine.mjs's entry.mjs, same
 * pattern as m9r-hook.ts's own dedicated entry) or `node cli/dist/m9r-mcp.js` when a real Node is present. One
 * process serves every session on the machine -- see mcp-server.ts's module comment for why the token lives on
 * each tool call instead of being baked into how this process was launched.
 */
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { runMcpStdioSupervisor } from "@/lib/native/mcp-stdio-supervisor";
import { createLocalStore, defaultStoreRoot } from "@/lib/native/local-store";
import { createM9rMcpServer } from "@/lib/native/mcp-server";
import { createNetworkCoreClient, parseNetworkCredentials } from "@/lib/native/network-core-client";
import { createWebBrokerClient } from "@/lib/native/web-broker-client";
import { brokerKeyPath, ownerPipePath } from "@/lib/native/web-broker-paths";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

async function main(): Promise<void> {
  if (process.env.M9R_MCP_WORKER !== "1") {
    const args = /m9r-engine(?:\.exe)?$/i.test(process.execPath)
      ? ["mcp"] : [...process.execArgv, ...process.argv.slice(1)];
    const runtime = runMcpStdioSupervisor({ input: process.stdin, output: process.stdout,
      spawnWorker: () => spawn(process.execPath, args, {
        stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
        env: { ...process.env, M9R_MCP_WORKER: "1" },
      }),
      onEvent: event => process.stderr.write(`M9R MCP lifecycle ${JSON.stringify(event)}\n`),
    });
    await runtime.closed;
    return;
  }
  const root = defaultStoreRoot(homedir(), process.env);
  const store = createLocalStore(root);
  const web = createWebBrokerClient({ keyPath: brokerKeyPath(root), ownerPipePath: ownerPipePath(root), port: Number(process.env.M9R_WEB_BROKER_PORT) || undefined });
  const networkCore = createNetworkCoreClient({
    baseUrl: process.env.M9R_NETWORK_CORE_URL,
    credentials: parseNetworkCredentials(process.env.M9R_NETWORK_CREDENTIALS_JSON),
  });
  const roomStartedAt = Number(process.env.M9R_ROOM_STARTED_AT);
  const server: McpServer = createM9rMcpServer({ store, web, networkCore, ...(Number.isSafeInteger(roomStartedAt) && roomStartedAt > 0 ? { roomStartedAt } : {}) });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  process.stderr.write(`M9R MCP server crashed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
