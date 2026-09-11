import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { setLoopAutoPause, clearLoopAutoPauseIfActive } from "@/lib/conversation-service";
import { handleAgentError } from "../../../_shared";

// ---------------------------------------------------------------------------
// POST /api/agent/conversations/[id]/loop-pause -- Layer 2's durable,
// cross-process pause. Any bridge process that detects the hard-stop
// threshold calls this; the underlying write is race-safe (only the first
// caller actually flips the row), and the response's `created` flag tells
// the caller whether it won that race -- only the winner should post the
// "stuck in a loop" chat notice, turning what used to be one duplicate
// notice per live process into exactly one.
//
// DELETE clears it, but only when the pause reason is 'loop_detected' --
// never a human's own deliberate pause (Layer 3), which only the dashboard's
// explicit resume_agents action may lift. Called the instant a human posts a
// real message in the channel, same resolution rule the old in-memory
// version used.
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: conversationId } = await params;
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    const result = await setLoopAutoPause(agent, conversationId);
    return NextResponse.json(result);
  } catch (err) {
    return handleAgentError(err);
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: conversationId } = await params;
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    await clearLoopAutoPauseIfActive(agent, conversationId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleAgentError(err);
  }
}
