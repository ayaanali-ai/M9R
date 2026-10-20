/**
 * Standalone entry point for the M9R MCP server: `m9r-engine mcp` (dispatch in build-engine.mjs's entry.mjs, same
 * pattern as m9r-hook.ts's own dedicated entry) or `node cli/dist/m9r-mcp.js` when a real Node is present. One
 * process serves every session on the machine -- see mcp-server.ts's module comment for why the token lives on
 * each tool call instead of being baked into how this process was launched.
 */
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runMcpStdioSupervisor } from "@/lib/native/mcp-stdio-supervisor";
import { mcpWorkerEnvironment, readM9rMcpConnectionConfig } from "@/lib/native/mcp-connection-env";
import { startLocalPresenceHeartbeat } from "@/lib/native/local-presence-heartbeat";
import { hasPendingRuntimeTransaction } from "@/lib/native/runtime-install-transaction";
import { createLocalStore, defaultStoreRoot } from "@/lib/native/local-store";
import { createM9rMcpServer } from "@/lib/native/mcp-server";
import { createNetworkCoreClient, parseNetworkCredentials } from "@/lib/native/network-core-client";
import { createWebBrokerClient } from "@/lib/native/web-broker-client";
import { brokerKeyPath, ownerPipePath } from "@/lib/native/web-broker-paths";
import { isPackagedMcpExecutable, resolveMcpRuntimeExecutable } from "@/lib/native/mcp-runtime-path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

function localAgentToken(provider: string, env: NodeJS.ProcessEnv): string | undefined {
  const direct = env.M9R_AGENT_TOKEN?.trim();
  if (direct) return direct;
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(provider)) return undefined;
  const roots = [join(process.cwd(), ".m9r"), defaultStoreRoot(homedir(), env)];
  for (const root of roots) {
    const path = join(root, "agents", provider, "local.json");
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { token?: unknown };
      if (typeof parsed.token === "string" && parsed.token.trim()) return parsed.token.trim();
    } catch { /* A missing/corrupt local token must not block MCP startup. */ }
  }
  return undefined;
}

function startMcpPresence(connection: ReturnType<typeof readM9rMcpConnectionConfig>): ReturnType<typeof startLocalPresenceHeartbeat> | null {
  if (process.env.M9R_MCP_WORKER === "1" || !connection.provider) return null;
  const token = localAgentToken(connection.provider, process.env);
  if (!token) return null;
  const appUrl = (process.env.M9R_APP_URL?.trim() || process.env.M9R_API_URL?.trim() || "https://m9r.dev").replace(/\/+$/, "");
  return startLocalPresenceHeartbeat({
    appUrl,
    agentToken: token,
    provider: connection.provider,
    adapterInstanceId: `m9r-mcp-${connection.provider}-${process.pid}-${randomUUID()}`.slice(0, 128),
    onError: (error) => process.stderr.write(`M9R local presence heartbeat failed: ${error instanceof Error ? error.message : String(error)}\n`),
  });
}

async function main(): Promise<void> {
  const connection = readM9rMcpConnectionConfig(process.env, process.ppid);
  if (process.env.M9R_MCP_WORKER !== "1") {
    const presence = startMcpPresence(connection);
    const runtimeExecutable = resolveMcpRuntimeExecutable(process.env, process.execPath);
    const packaged = isPackagedMcpExecutable(runtimeExecutable);
    const executableDirectory = dirname(runtimeExecutable);
    const workerRevision = packaged ? () => {
      if (hasPendingRuntimeTransaction(executableDirectory)) return undefined;
      try {
        const manifest = JSON.parse(readFileSync(join(executableDirectory, "m9r-build-info.json"), "utf8"));
        return typeof manifest.buildId === "string" && /^[a-f0-9]{64}$/.test(manifest.buildId) ? manifest.buildId : undefined;
      } catch { return undefined; }
    } : undefined;
    const args = isPackagedMcpExecutable(runtimeExecutable)
      ? ["mcp"] : [...process.execArgv, ...process.argv.slice(1)];
    const runtime = runMcpStdioSupervisor({ input: process.stdin, output: process.stdout, workerRevision,
      spawnWorker: () => spawn(runtimeExecutable, args, {
        stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
        env: mcpWorkerEnvironment(process.env, connection),
      }),
      onEvent: event => process.stderr.write(`M9R MCP lifecycle ${JSON.stringify(event)}\n`),
    });
    try {
      await runtime.closed;
    } finally {
      presence?.stop();
    }
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
  const server: McpServer = createM9rMcpServer({
    store,
    web,
    networkCore,
    ...(Number.isSafeInteger(roomStartedAt) && roomStartedAt > 0 ? { roomStartedAt } : {}),
    ...(connection.bindingId ? { connectionBindingId: connection.bindingId } : {}),
    ...(connection.processId ? { connectionProcessId: connection.processId } : {}),
    ...(connection.provider ? { connectionProvider: connection.provider } : {}),
    // A worker can be refreshed by a newer engine while its provider-owned
    // outer supervisor still carries an older environment. In that narrow
    // private-worker mode the server may adopt exactly one active local claim;
    // ambiguity remains fail-closed. Legacy standalone MCP launches do not
    // receive this escape hatch.
    ...(process.env.M9R_MCP_WORKER === "1" && !connection.provider && !connection.bindingId && !connection.processId
      ? { connectionWorkerFallback: true }
      : {}),
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  process.stderr.write(`M9R MCP server crashed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
