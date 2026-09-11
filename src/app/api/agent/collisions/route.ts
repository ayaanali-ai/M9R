import { NextResponse } from "next/server";
import { listAgentRunsForUser } from "@/lib/agent-run-service";
import { listLatestScopeByRun } from "@/lib/dispatch-service";
import { detectCollisions } from "@/lib/collision";
import { handleAgentError } from "../_shared";

// ---------------------------------------------------------------------------
// GET /api/agent/collisions — active scope overlaps for the SIGNED-IN human.
//
// Cookie-authenticated, RLS-scoped (mirrors GET /api/agent/runs). Reads each
// live run's most recently announced scope and returns deterministic pairwise
// overlaps — no model call. Operator resolution (assign ownership, split,
// pause) happens through the existing Response mechanism
// (POST /api/agent/runs/[id]/respond, type: "scope_decision"), not a separate
// endpoint.
// ---------------------------------------------------------------------------

const LIVE_STATUSES = new Set(["started", "working", "blocked", "waiting_for_human"]);

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [runs, latestScope] = await Promise.all([listAgentRunsForUser(), listLatestScopeByRun()]);
    const liveRunIds = new Set(runs.filter((r) => LIVE_STATUSES.has(r.status)).map((r) => r.id));

    const runScopes = [...latestScope.entries()]
      .filter(([runId]) => liveRunIds.has(runId))
      .map(([runId, v]) => ({ runId, sender: v.sender, scope: v.scope }));

    const collisions = detectCollisions(runScopes);
    return NextResponse.json({ collisions });
  } catch (err) {
    return handleAgentError(err);
  }
}
