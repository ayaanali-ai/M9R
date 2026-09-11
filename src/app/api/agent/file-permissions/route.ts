import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { listDeniedFilePatterns } from "@/lib/bridge/agent-file-permissions-service";
import { handleAgentError } from "@/app/api/agent/_shared";

export const dynamic = "force-dynamic";

/**
 * GET /api/agent/file-permissions — an agent's own DENY-list of file path
 * glob patterns, fetched on the same startup + 30s cadence as
 * /api/agent/rules (see refreshOwnDeniedFilePatterns in bridge-runtime.ts).
 * Bearer-token only: an agent can only ever read its own connection's list.
 */
export async function GET(req: NextRequest) {
  try {
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    const deniedPatterns = await listDeniedFilePatterns(agent.connectionId);
    return NextResponse.json({ deniedPatterns });
  } catch (err) {
    return handleAgentError(err);
  }
}
