import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { searchArchivedSessionsForAgent } from "@/lib/bridge/session-service";
import { handleAgentError } from "../../_shared";

// ---------------------------------------------------------------------------
// GET /api/agent/memory/search?q=<text>&limit=<n> -- M9R_MASTER_BUILD_PLAN.md
// items #1's "agent recall of an archived session" fast-follow and #11/#29
// (memory as structured markdown files / the Mosaic-proven shared-context
// catalog). Searches this workspace's already-archived Sessions (title and
// message body) and returns a bounded transcript excerpt per match -- real,
// cross-provider, cross-machine memory recall, backed by data that already
// exists (conversation_sessions), not a new store. Bearer-token only, same
// as every other /api/agent/* route.
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  try {
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    const url = new URL(req.url);
    const query = url.searchParams.get("q") ?? "";
    const rawLimit = Number(url.searchParams.get("limit") ?? "8");
    const limit = Number.isFinite(rawLimit) ? rawLimit : 8;
    const matches = await searchArchivedSessionsForAgent(agent.workspaceId, query, limit);
    return NextResponse.json({ matches });
  } catch (err) {
    return handleAgentError(err);
  }
}
