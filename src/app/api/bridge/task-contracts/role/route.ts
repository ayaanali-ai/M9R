import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { roleForMessage } from "@/lib/bridge/task-contract-service";
import { handleAgentError } from "@/app/api/agent/_shared";

export const dynamic = "force-dynamic";

/**
 * GET /api/bridge/task-contracts/role?messageId=... — what this connection
 * should do about a multi-mention message: `decomposer` (propose the split),
 * `participant` (hold, another agent is splitting it), or `none`.
 *
 * The bridge calls this only when it locally sees a human message naming
 * more than one provider, so the ordinary single-mention path never pays
 * this round-trip.
 */
export async function GET(req: NextRequest) {
  try {
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    const messageId = req.nextUrl.searchParams.get("messageId");
    if (!messageId) return NextResponse.json({ error: "messageId is required." }, { status: 400 });
    const result = await roleForMessage({ messageId, connectionId: agent.connectionId });
    return NextResponse.json(result);
  } catch (err) {
    return handleAgentError(err);
  }
}
