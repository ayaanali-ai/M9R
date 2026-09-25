/**
 * Standalone entry point for the M9R MCP server: `m9r-engine mcp` (dispatch in build-engine.mjs's entry.mjs, same
 * pattern as m9r-hook.ts's own dedicated entry) or `node cli/dist/m9r-mcp.js` when a real Node is present. One
 * process serves every session on the machine -- see mcp-server.ts's module comment for why the token lives on
 * each tool call instead of being baked into how this process was launched.
 */
import { homedir } from "node:os";
import { createLocalStore, defaultStoreRoot } from "@/lib/native/local-store";
import { createM9rMcpServer } from "@/lib/native/mcp-server";
import { createWebBrokerClient } from "@/lib/native/web-broker-client";
import { brokerKeyPath } from "@/lib/native/web-broker-paths";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

async function main(): Promise<void> {
  const root = defaultStoreRoot(homedir(), process.env);
  const store = createLocalStore(root);
  const web = createWebBrokerClient({ keyPath: brokerKeyPath(root), port: Number(process.env.M9R_WEB_BROKER_PORT) || undefined });
  const server: McpServer = createM9rMcpServer({ store, web });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  process.stderr.write(`M9R MCP server crashed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
