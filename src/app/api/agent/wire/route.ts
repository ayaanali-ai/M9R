import { NextResponse } from "next/server";
import { listWireForUser } from "@/lib/dispatch-service";
import { handleAgentError } from "../_shared";

// ---------------------------------------------------------------------------
// GET /api/agent/wire — recent Dispatches for the SIGNED-IN human (dashboard).
//
// Cookie-authenticated. RLS limits results to dispatches in workspaces the
// user owns (same pattern as GET /api/agent/runs). Returns [] when signed out
// / unconfigured / the dispatches migration hasn't been applied yet.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const dispatches = await listWireForUser();
    return NextResponse.json({ dispatches });
  } catch (err) {
    return handleAgentError(err);
  }
}
