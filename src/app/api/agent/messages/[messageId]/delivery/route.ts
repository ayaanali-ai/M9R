import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { getMessageDelivery } from "@/lib/delivery-service";
import { handleAgentError } from "../../../_shared";

// GET /api/agent/messages/[messageId]/delivery: who a message was for and how far it got, per recipient.
// Read-only; derived from stored evidence. Bearer-authenticated; the caller must be in the conversation.
export async function GET(req: NextRequest, { params }: { params: Promise<{ messageId: string }> }) {
  try {
    const { messageId } = await params;
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    return NextResponse.json(await getMessageDelivery(agent, messageId));
  } catch (err) {
    return handleAgentError(err);
  }
}
