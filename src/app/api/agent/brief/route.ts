import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { listAvailableFindingsForWorkspace } from "@/lib/finding-service";
import { getWorkspaceIdentityForAgent } from "@/lib/workspace-identity-service";
import { buildBrief } from "@/lib/brief";
import { handleAgentError } from "../_shared";

// ---------------------------------------------------------------------------
// GET /api/agent/brief — the compact relevant-event packet for an agent.
//
// Bearer-authenticated. Returns the workspace's available (human-reviewed)
// Findings, capped to a small budget (brief.ts) — exact reuse, no semantic
// ranking, per the master spec's "exact reuse before semantic reuse" rule.
// ---------------------------------------------------------------------------

function jsonError(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status });
}

export async function GET(req: NextRequest) {
  try {
    const token = bearerFrom(req.headers.get("authorization"));
    if (!token) return jsonError("Bearer token required.", 401);
    const agent = await authenticateAgent(token);
    if (!agent) return jsonError("Invalid or missing agent token.", 401);

    const [findings, identity] = await Promise.all([
      listAvailableFindingsForWorkspace(agent.workspaceId),
      getWorkspaceIdentityForAgent(agent.workspaceId),
    ]);
    const brief = buildBrief(findings, identity);
    return NextResponse.json(brief);
  } catch (err) {
    return handleAgentError(err);
  }
}
