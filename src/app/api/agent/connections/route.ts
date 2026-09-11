import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { authenticateAgent, bearerFrom, AgentJoinError } from "@/lib/agent-join-service";
import { isRecentlySeenConnection } from "@/lib/agent-dashboard-presenter";
import { handleAgentError } from "../_shared";

// ---------------------------------------------------------------------------
// GET /api/agent/connections — other active connections in this workspace,
// by agent kind. Lets a CLI resolve "codex" -> connection id for
// oathlock conversation start --with codex, instead of requiring the caller
// to already know a raw connection UUID. Bearer-token only; never returns
// tokens or any other connection's private setup state, only id + agent_kind.
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  try {
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    if (!supabase) throw new AgentJoinError("M9R agent backend is not configured.", "DB_NOT_CONFIGURED", 503);

    const { data, error } = await supabase
      .from("agent_connections")
      .select("id, agent_kind, last_seen_at")
      .eq("workspace_id", agent.workspaceId)
      // `agent_connections.status` is the durable connection lifecycle. A
      // claim is approved, but the connection created by that approval is
      // active. Filtering for the claim state made every freshly connected
      // peer disappear from CLI conversation routing even though its token
      // authenticated successfully.
      .eq("status", "active")
      .is("revoked_at", null);
    if (error) throw new AgentJoinError("Could not list connections.", "CONNECTIONS_LIST_FAILED", 500);

    const connections = (data ?? [])
      // Durable approval alone does not prove a bridge is listening. The
      // heartbeat lease prevents stale registrations being offered as peers.
      .filter((row) => row.id !== agent.connectionId && isRecentlySeenConnection({ last_seen_at: row.last_seen_at as string | null }))
      .map((row) => ({ connection_id: row.id, agent_kind: row.agent_kind }));
    return NextResponse.json({ connections });
  } catch (err) {
    return handleAgentError(err);
  }
}
