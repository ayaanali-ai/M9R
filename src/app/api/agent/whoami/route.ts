import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { supabase } from "@/lib/supabase";

/**
 * GET /api/agent/whoami — resolves the bearer token's workspace/connection
 * identity. The local `.oathlock/agents/<kind>/local.json` token file
 * (written by `oathlock init`) never stores workspaceId itself; this is
 * what lets a local-only process (the terminal bridge's ACP integration)
 * discover it without a separate provisioning step.
 *
 * Also returns the connection's model override, if the workspace owner set
 * one from the dashboard -- the bridge already polls this endpoint every 30s
 * (bridge-runtime.ts's refreshOwnConnectionId) to refresh its own connection
 * identity, so this rides the same poll instead of needing new bridge-side
 * plumbing. Without this, a connected agent had no way to know or change
 * which model it should use short of editing that provider's own local CLI
 * config file directly -- exactly the gap that let a stale, unsupported
 * model silently break every Codex turn with no visibility from OathLock.
 */
export async function GET(req: NextRequest) {
  const token = bearerFrom(req.headers.get("authorization"));
  if (!token) return NextResponse.json({ error: "Bearer token required." }, { status: 401 });
  const agent = await authenticateAgent(token);
  if (!agent) return NextResponse.json({ error: "Invalid or expired agent token." }, { status: 401 });

  let model: string | null = null;
  let ownerUserId: string | null = null;
  if (supabase) {
    const { data } = await supabase.from("agent_connections").select("model, created_by").eq("id", agent.connectionId).maybeSingle();
    model = (data as { model?: string | null } | null)?.model ?? null;
    // Item #28 Part A: the owner-pty-runtime (one real shell per human, not
    // per provider connection) authenticates using whichever provider token
    // happens to be available -- it still needs to know the actual HUMAN it
    // belongs to, to self-filter a broadcast "someone wants a terminal here"
    // request down to only the request meant for it. This is the same
    // agent_connections.created_by every other owner check in this codebase
    // (isPtyOwnerRequest, resolvePtyOwnerHuman) already resolves against.
    ownerUserId = (data as { created_by?: string | null } | null)?.created_by ?? null;
  }

  return NextResponse.json({ workspaceId: agent.workspaceId, connectionId: agent.connectionId, agentKind: agent.agentKind, model, ownerUserId });
}
