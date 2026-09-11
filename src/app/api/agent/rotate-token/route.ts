import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom, rotateAgentToken } from "@/lib/agent-join-service";
import { handleAgentError } from "../_shared";

/**
 * POST /api/agent/rotate-token — mint a new token for the calling connection
 * and revoke exactly the one used to authenticate this request. Never touches
 * connection status, never requires a new human-approved claim.
 */
export async function POST(req: NextRequest) {
  try {
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    const result = await rotateAgentToken(agent);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) { return handleAgentError(error); }
}
