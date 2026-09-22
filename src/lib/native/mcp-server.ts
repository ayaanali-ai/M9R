/**
 * M9R MCP server (P1, design: M9R_IDENTITY_AND_CONTROL_DESIGN.md sections 4 and 6). Spawned per session, scoped to
 * exactly one identity token issued by the SessionStart hook (see hook-handler.ts, renderSessionCard in inbox-core.ts).
 * Every tool call here is stamped with that verified identity instead of a claimed `--from` string.
 *
 * Delivery is honest about its limit, same as identity-core.ts: the token has to reach the agent through the
 * SessionStart hook's context text, which only helps an agent that actually reads its own context and passes the
 * token through (e.g. as an env var on this process, or a tool argument). There is no host-level wiring today that
 * hands this process a token automatically -- v1 requires --token (or M9R_SESSION_TOKEN) to be supplied explicitly.
 * Without a valid one, every tool below refuses at call time with a clear reason, same discipline as dev-mcp-server.ts.
 */

import { homedir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createLocalStore, defaultStoreRoot, type LocalStore } from "./local-store";
import { renderInboxInjection } from "./inbox-core";
import type { VerifiedIdentity } from "./identity-core";

export interface McpServerDeps {
  store: LocalStore;
  token: string;
  env?: Record<string, string | undefined>;
}

export function createM9rMcpServer(deps: McpServerDeps): McpServer {
  const server = new McpServer({ name: "m9r-mcp", version: "1.0.0" });

  function requireIdentity(): VerifiedIdentity {
    const identity = deps.store.verifyIdentity(deps.token);
    if (!identity) throw new Error("This M9R session token is invalid or has been revoked. Reconnect (start a new session) to get a fresh one from the SessionStart card.");
    return identity;
  }

  server.registerTool(
    "m9r_whoami",
    {
      description: "Confirm your own verified M9R identity (handle, provider, session) for this connection. Use this once if you're unsure whether M9R recognizes this session.",
      inputSchema: {},
    },
    async () => {
      const identity = requireIdentity();
      return { content: [{ type: "text", text: `You are @${identity.handle} (${identity.provider}), session ${identity.sessionId}.` }] };
    },
  );

  server.registerTool(
    "m9r_agents",
    {
      description: "List other M9R agents active recently. Use this before m9r_send if you don't already know who's around.",
      inputSchema: { activeWindowMinutes: z.number().int().min(1).max(1440).default(10) },
    },
    async ({ activeWindowMinutes }) => {
      const identity = requireIdentity();
      const now = Date.now();
      const others = deps.store.listEndpoints().filter((e) => e.handle !== identity.handle && now - Date.parse(e.lastSeenAt) < activeWindowMinutes * 60_000);
      if (others.length === 0) return { content: [{ type: "text", text: "No other agents active recently." }] };
      const rendered = others.map((e) => `@${e.handle} (${e.provider}), last seen ${e.lastSeenAt}`).join("\n");
      return { content: [{ type: "text", text: rendered }] };
    },
  );

  server.registerTool(
    "m9r_send",
    {
      description: "Send a task to another M9R agent by handle. It goes into their inbox and arrives at their next prompt or turn -- this does not wait for a reply.",
      inputSchema: {
        to: z.string().min(1).max(80).describe("The recipient's handle, without the @, e.g. \"codex\"."),
        goal: z.string().min(1).max(4_000).describe("What you want the recipient to do, written for them to act on directly."),
      },
    },
    async ({ to, goal }) => {
      const identity = requireIdentity();
      const result = deps.store.addTask({
        to,
        from: identity.handle,
        goal,
        fromSession: identity.sessionId,
        origin: "agent_initiated",
        idempotencyKey: `mcp:${identity.sessionId}:${to}:${goal.slice(0, 200)}`,
      });
      return { content: [{ type: "text", text: `Sent to @${to} as task ${result.task.id}.` }] };
    },
  );

  server.registerTool(
    "m9r_inbox",
    {
      description: "Check your own pending inbox tasks without waiting for the next SessionStart/UserPromptSubmit injection. Use this if you suspect something is waiting for you mid-turn.",
      inputSchema: {},
    },
    async () => {
      const identity = requireIdentity();
      const injection = renderInboxInjection(deps.store.tasksFor(identity.handle), deps.store.cursorFor(identity.handle, identity.sessionId));
      return { content: [{ type: "text", text: injection.text || "Inbox is empty." }] };
    },
  );

  server.registerTool(
    "m9r_result",
    {
      description: "Report the result of a task you were sent, so it gets recorded and (if the sender is a live Codex session) pushed back to them.",
      inputSchema: {
        taskId: z.string().min(1).max(80).describe("The task id you were given, e.g. \"T12\"."),
        summary: z.string().min(1).max(4_000).describe("What you actually did and found -- concrete, not a vague completion claim."),
      },
    },
    async ({ taskId, summary }) => {
      const identity = requireIdentity();
      const task = deps.store.setResult(taskId, summary);
      if (!task) throw new Error(`No task ${taskId} found.`);
      if (task.to !== identity.handle) throw new Error(`Task ${taskId} was not sent to you (@${identity.handle}), refusing to report a result for it.`);
      return { content: [{ type: "text", text: `Recorded result for ${taskId}, visible to @${task.from} next time they check their results.` }] };
    },
  );

  return server;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const tokenFlagIndex = args.indexOf("--token");
  const token = (tokenFlagIndex >= 0 ? args[tokenFlagIndex + 1] : undefined) ?? process.env.M9R_SESSION_TOKEN;
  if (!token) {
    process.stderr.write("Usage: mcp-server.ts --token <identity-token>  (or set M9R_SESSION_TOKEN)\n");
    process.exit(1);
  }
  const root = defaultStoreRoot(homedir(), process.env);
  const store = createLocalStore(root);
  const server = createM9rMcpServer({ store, token });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";

/** Portable direct-entry check for both tsx source and the compiled CLI. */
export function isDirectMcpServerProcess(argvPath = process.argv[1], moduleUrl = import.meta.url): boolean {
  if (!argvPath) return false;
  try {
    return resolvePath(argvPath) === resolvePath(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isDirectMcpServerProcess()) {
  main().catch((error) => {
    process.stderr.write(`M9R MCP server crashed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
