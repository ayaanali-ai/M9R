import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { sendConversationMessage } from "@/lib/conversation-service";
import { submitChatEvidence, attachEvidenceMessage } from "@/lib/bridge/chat-evidence-service";
import { renderChatEvidenceMessage } from "@/lib/bridge/chat-evidence-contract";
import { findCurrentRunIdForConnection } from "@/lib/agent-run-service";
import { handleAgentError } from "../../../_shared";

// ---------------------------------------------------------------------------
// POST /api/agent/conversations/[id]/evidence — submit structured evidence
// after the matching in-channel request was explicitly approved. Creates a
// pending row AND posts the exact facts for final human review.
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: conversationId } = await params;
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    const submission = await submitChatEvidence({
      workspaceId: agent.workspaceId,
      conversationId,
      agent,
      requestId: typeof body.requestId === "string" ? body.requestId : "",
      provider: agent.agentKind ?? null,
      evidence: body.evidence,
    });
    const relatedRunId = await findCurrentRunIdForConnection(agent.workspaceId, agent.connectionId).catch(() => null);
    const message = await sendConversationMessage(agent, {
      conversationId,
      recipientConnectionId: null,
      kind: "result",
      body: renderChatEvidenceMessage(submission.evidence),
      parentMessageId: submission.requestMessageId,
      relatedRunId,
    });
    // Best-effort link, not a reason to fail a submission that already
    // durably exists (row + chat message both written above) -- but silently
    // discarding the failure with no trace meant a broken link was
    // indistinguishable from a working one until someone went looking for
    // evidence by message and found nothing. One retry, then a real log line
    // naming the exact submission/message ids so this is at least visible
    // instead of invisible.
    await attachEvidenceMessage(submission.id, message.id).catch(async () => {
      await attachEvidenceMessage(submission.id, message.id).catch((retryErr) => {
        console.error(
          `Could not link evidence submission ${submission.id} to message ${message.id} after 2 attempts:`,
          retryErr instanceof Error ? retryErr.message : retryErr,
        );
      });
    });
    return NextResponse.json({
      id: submission.id,
      message,
      requestId: typeof body.requestId === "string" ? body.requestId : null,
      missionId: submission.missionId,
      missionEvidenceId: submission.missionEvidenceId,
    }, { status: 201 });
  } catch (err) {
    return handleAgentError(err);
  }
}
