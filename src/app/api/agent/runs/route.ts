import { NextResponse } from "next/server";
import { listAgentRunsForUser } from "@/lib/agent-run-service";
import { handleAgentError } from "../_shared";

// ---------------------------------------------------------------------------
// GET /api/agent/runs — recent agent runs for the SIGNED-IN human (dashboard).
//
// Cookie-authenticated. RLS limits results to runs in workspaces the user owns,
// so a user can never see another user's agent runs. Used by the dashboard
// poller (every 5–10s). Returns [] when signed out / unconfigured.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const runs = await listAgentRunsForUser();
    return NextResponse.json({ runs });
  } catch (err) {
    return handleAgentError(err);
  }
}
