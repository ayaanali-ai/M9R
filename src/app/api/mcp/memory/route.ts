/**
 * #15: Memory as a real MCP endpoint -- any external MCP client (Claude
 * Desktop, Cursor, a script) can add this as a remote server and read a
 * workspace's Memory (Findings + Workspace Rules, the same merged surface
 * /dashboard/memory shows) without being one of M9R's own connected coding
 * agents. Read-only by design: this is a knowledge export, not a write path
 * -- publishing a Finding or promoting a rule still goes through the
 * reviewed, evidence-backed flows those features already have.
 *
 * Auth is a personal API token (user-api-token-service.ts), not an agent
 * connection token -- this is a human's own credential for their own
 * external tools, scoped to whichever workspace resolveActiveOrDefaultProjectId
 * resolves for them (their default workspace, since there's no browser
 * session/cookie for "active workspace" in this context).
 *
 * A fresh McpServer + stateless WebStandardStreamableHTTPServerTransport is
 * built per request -- appropriate for a small, read-only tool surface with
 * no need to hold state across calls (no sessionIdGenerator, matching the
 * SDK's documented stateless mode).
 */
import { NextRequest } from "next/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { resolveUserApiToken } from "@/lib/user-api-token-service";
import { resolveActiveOrDefaultProjectId } from "@/lib/projects-service";
import { supabase as admin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

function bearerFrom(req: NextRequest): string | null {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

async function resolveWorkspaceForRequest(req: NextRequest): Promise<{ workspaceId: string } | { error: string; status: number }> {
  const raw = bearerFrom(req);
  if (!raw) return { error: "Missing bearer token. Generate one in M9R under Settings > API tokens.", status: 401 };
  const resolved = await resolveUserApiToken(raw);
  if (!resolved) return { error: "Invalid or revoked API token.", status: 401 };
  if (!admin) return { error: "M9R backend is not configured.", status: 503 };
  const workspaceId = await resolveActiveOrDefaultProjectId(admin, { id: resolved.userId, email: null, name: null }).catch(() => null);
  if (!workspaceId) return { error: "No workspace is available for this account.", status: 404 };
  return { workspaceId };
}

function buildMemoryServer(workspaceId: string): McpServer {
  const server = new McpServer({ name: "m9r-memory", version: "1.0.0" });
  const db = admin!;

  server.registerTool(
    "list_findings",
    {
      description: "List this workspace's reviewed Findings -- human-confirmed observations agents have flagged, the kind of thing every future run should already know. Only ever returns review_state=available Findings; pending/rejected ones are never exposed here.",
      inputSchema: { limit: z.number().int().min(1).max(200).optional().describe("Max findings to return (default 50).") },
    },
    async ({ limit }) => {
      const { data, error } = await db
        .from("findings")
        .select("title, applicable_environment, observed_behavior, evidence_level, suggested_response, known_limitations, created_at")
        .eq("workspace_id", workspaceId)
        .eq("review_state", "available")
        .order("created_at", { ascending: false })
        .limit(limit ?? 50);
      if (error) throw new Error(`Could not list findings: ${error.message}`);
      return { content: [{ type: "text", text: JSON.stringify(data ?? [], null, 2) }] };
    },
  );

  server.registerTool(
    "list_rules",
    {
      description: "List this workspace's active Workspace Rules -- persistent, evidence-backed instructions every connected agent already loads at the start of a run.",
      inputSchema: { limit: z.number().int().min(1).max(200).optional().describe("Max rules to return (default 100).") },
    },
    async ({ limit }) => {
      const { data, error } = await db
        .from("workspace_rules")
        .select("title, body, rule_type, status, created_at")
        .eq("workspace_id", workspaceId)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(limit ?? 100);
      if (error) throw new Error(`Could not list rules: ${error.message}`);
      return { content: [{ type: "text", text: JSON.stringify(data ?? [], null, 2) }] };
    },
  );

  return server;
}

async function handle(req: NextRequest): Promise<Response> {
  const resolved = await resolveWorkspaceForRequest(req);
  if ("error" in resolved) return Response.json({ error: resolved.error }, { status: resolved.status });

  const server = buildMemoryServer(resolved.workspaceId);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function DELETE(req: NextRequest): Promise<Response> {
  return handle(req);
}
