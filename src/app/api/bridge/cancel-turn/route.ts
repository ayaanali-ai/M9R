import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { listPendingCancelTurnRequests, markCancelTurnConsumed } from "@/lib/bridge/bridge-cancel-turn-service";
import { handleAgentError } from "@/app/api/agent/_shared";

export const dynamic = "force-dynamic";

/**
 * GET /api/bridge/cancel-turn?conversationId=...&connectionId=... -- the
 * Bridge polls this once per known session (scoped to that session's own
 * conversation+connection pairing) for a human's request to stop it.
 * DELETE ?id=... consumes a request once the Bridge has actually delivered
 * the cancellation via controller.cancelTurn, so a Bridge restart mid-poll
 * can't deliver the same cancel twice. Bearer-token only.
 */
export async function GET(req: NextRequest) {
  try {
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    const conversationId = req.nextUrl.searchParams.get("conversationId");
    const connectionId = req.nextUrl.searchParams.get("connectionId");
    if (!conversationId || !connectionId) return NextResponse.json({ error: "conversationId and connectionId are required." }, { status: 400 });
    const requests = await listPendingCancelTurnRequests(agent.workspaceId, conversationId, connectionId);
    return NextResponse.json({ requests });
  } catch (err) {
    return handleAgentError(err);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    const id = req.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id is required." }, { status: 400 });
    await markCancelTurnConsumed(agent.workspaceId, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleAgentError(err);
  }
}
