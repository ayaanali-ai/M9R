import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { listArchivedSessionsForExport } from "@/lib/bridge/session-service";
import { handleAgentError } from "../../_shared";

// ---------------------------------------------------------------------------
// GET /api/agent/memory/export?since=<ISO timestamp> -- feeds `m9r-cli
// memory export`'s local markdown writer (M9R_MASTER_BUILD_PLAN.md #11, the
// Jake Van Clief "second brain" idea). Returns every Session archived in
// this workspace after `since`, oldest first, full transcript, one page
// (50) at a time -- the CLI advances its own on-disk cursor and calls again
// until a page comes back short of 50, same shape as every other
// cursor-paginated poll in this codebase. Bearer-token only.
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  try {
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    const since = new URL(req.url).searchParams.get("since");
    const sessions = await listArchivedSessionsForExport(agent.workspaceId, since);
    return NextResponse.json({ sessions });
  } catch (err) {
    return handleAgentError(err);
  }
}
