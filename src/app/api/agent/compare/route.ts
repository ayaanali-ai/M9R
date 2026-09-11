import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { compareAgentRuns } from "@/lib/agent-run-service";
import { handleAgentError } from "../_shared";

// ---------------------------------------------------------------------------
// GET /api/agent/compare?baseline=<id>&later=<id> — conservative two-run proof.
//
// Bearer-token only. Runs must be in the token workspace, or linked by approved
// same-owner rule lineage from baseline evidence to a later evaluated active
// rule. The comparison never fabricates token/cost or quality gains: usage is
// compared only when both runs recorded metadata, and output quality is left
// unjudged unless objective signals exist.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) {
      return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    }

    const url = new URL(req.url);
    const baseline = url.searchParams.get("baseline") || url.searchParams.get("baseline_run") || "";
    const later = url.searchParams.get("later") || url.searchParams.get("later_run") || "";
    if (!baseline || !later) {
      return NextResponse.json({ error: "baseline and later run ids are required." }, { status: 400 });
    }

    const comparison = await compareAgentRuns(agent, baseline, later);
    return NextResponse.json({ comparison });
  } catch (err) {
    return handleAgentError(err);
  }
}
