import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { sendConversationMessage } from "@/lib/conversation-service";
import { attachEvidenceRequestMessage, requestChatEvidenceReview } from "@/lib/bridge/chat-evidence-service";
import { findCurrentRunIdForConnection } from "@/lib/agent-run-service";
import { handleAgentError } from "../../../../_shared";

/**
 * POST /api/agent/conversations/[id]/evidence/requests
 *
 * The agent asks for permission to submit evidence. This does not create an
 * evidence record and does not claim that the work is verified. The human's
 * next explicit in-channel approval unlocks the separate submit endpoint.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: conversationId } = await params;
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const summary = typeof body.summary === "string" ? body.summary.trim() : "";
    if (!summary) return NextResponse.json({ error: "summary is required." }, { status: 400 });

    const idempotencyKey = req.headers.get("idempotency-key") ?? (typeof body.idempotencyKey === "string" ? body.idempotencyKey : null);
    const request = await requestChatEvidenceReview({
      workspaceId: agent.workspaceId,
      conversationId,
      agentConnectionId: agent.connectionId,
      provider: agent.agentKind ?? null,
      summary,
      idempotencyKey,
    });
    if (request.status !== "pending") return NextResponse.json({ id: request.id, replay: true, status: request.status }, { status: 200 });
    const relatedRunId = await findCurrentRunIdForConnection(agent.workspaceId, agent.connectionId).catch(() => null);
    const message = await sendConversationMessage(agent, {
      conversationId,
      recipientConnectionId: null,
      kind: "notice",
      body: `Requesting evidence review: ${summary}`,
      parentMessageId: null,
      idempotencyKey: `evidence-request-message:${request.id}`,
      relatedRunId,
    });
    await attachEvidenceRequestMessage(request.id, message.id);
    return NextResponse.json({ id: request.id, message, ...(request.created ? {} : { replay: true }) }, { status: request.created ? 201 : 200 });
  } catch (err) {
    return handleAgentError(err);
  }
}
