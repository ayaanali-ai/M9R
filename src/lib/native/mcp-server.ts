/**
 * M9R MCP server (P1, design: M9R_IDENTITY_AND_CONTROL_DESIGN.md sections 4 and 6). One shared local server (matches
 * "One server, local first" in section 6) -- every tool takes the caller's own per-session token as an argument
 * rather than the process being launched scoped to one token. This is what actually makes a static, once-per-machine
 * MCP registration work for every agent session: the host app (Claude Code/Codex) starts this same process for any
 * session per its own .mcp.json-style config, and each session supplies the token it was already handed in its
 * SessionStart card (see hook-handler.ts, renderSessionCard in inbox-core.ts) with every call it makes.
 *
 * Delivery is still honest about its limit: this only helps an agent that actually reads its own SessionStart
 * context and passes the token through as the `token` argument on each call. There is no host-level mechanism that
 * hands a tool call its own caller's token automatically. Without a valid one, every tool below refuses at call
 * time with a clear reason, same discipline as dev-mcp-server.ts.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { LocalStore } from "./local-store";
import { renderInboxInjection } from "./inbox-core";
import type { VerifiedIdentity } from "./identity-core";

export interface McpServerDeps {
  store: LocalStore;
}

const TOKEN_FIELD = { token: z.string().min(1).describe("Your M9R session token, from the line the SessionStart card gave you (\"M9R session token: ...\"). Required on every call.") };

export function createM9rMcpServer(deps: McpServerDeps): McpServer {
  const server = new McpServer({ name: "m9r-mcp", version: "1.0.0" });

  function requireIdentity(token: string): VerifiedIdentity {
    const identity = deps.store.verifyIdentity(token);
    if (!identity) throw new Error("This M9R session token is invalid or has been revoked. Reconnect (start a new session) to get a fresh one from the SessionStart card.");
    return identity;
  }

  server.registerTool(
    "m9r_whoami",
    {
      description: "Confirm your own verified M9R identity (handle, provider, session) for this connection. Use this once if you're unsure whether M9R recognizes this session.",
      inputSchema: { ...TOKEN_FIELD },
    },
    async ({ token }) => {
      const identity = requireIdentity(token);
      return { content: [{ type: "text", text: `You are @${identity.handle} (${identity.provider}), session ${identity.sessionId}.` }] };
    },
  );

  server.registerTool(
    "m9r_agents",
    {
      description: "List other M9R agents active recently. Use this before m9r_send if you don't already know who's around.",
      inputSchema: { ...TOKEN_FIELD, activeWindowMinutes: z.number().int().min(1).max(1440).default(10) },
    },
    async ({ token, activeWindowMinutes }) => {
      const identity = requireIdentity(token);
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
        ...TOKEN_FIELD,
        to: z.string().min(1).max(80).describe("The recipient's handle, without the @, e.g. \"codex\"."),
        goal: z.string().min(1).max(4_000).describe("What you want the recipient to do, written for them to act on directly."),
      },
    },
    async ({ token, to, goal }) => {
      const identity = requireIdentity(token);
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
      inputSchema: { ...TOKEN_FIELD },
    },
    async ({ token }) => {
      const identity = requireIdentity(token);
      const injection = renderInboxInjection(deps.store.tasksFor(identity.handle), deps.store.cursorFor(identity.handle, identity.sessionId));
      return { content: [{ type: "text", text: injection.text || "Inbox is empty." }] };
    },
  );

  server.registerTool(
    "m9r_result",
    {
      description: "Report the result of a task you were sent, so it gets recorded and (if the sender is a live Codex session) pushed back to them.",
      inputSchema: {
        ...TOKEN_FIELD,
        taskId: z.string().min(1).max(80).describe("The task id you were given, e.g. \"T12\"."),
        summary: z.string().min(1).max(4_000).describe("What you actually did and found -- concrete, not a vague completion claim."),
      },
    },
    async ({ token, taskId, summary }) => {
      const identity = requireIdentity(token);
      const task = deps.store.setResult(taskId, summary);
      if (!task) throw new Error(`No task ${taskId} found.`);
      if (task.to !== identity.handle) throw new Error(`Task ${taskId} was not sent to you (@${identity.handle}), refusing to report a result for it.`);
      return { content: [{ type: "text", text: `Recorded result for ${taskId}, visible to @${task.from} next time they check their results.` }] };
    },
  );

  return server;
}
