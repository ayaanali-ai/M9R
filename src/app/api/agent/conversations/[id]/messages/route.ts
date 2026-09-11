import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { sendConversationMessage, listConversationMessagesForAgent } from "@/lib/conversation-service";
import { handleAgentError } from "../../../_shared";

// ---------------------------------------------------------------------------
// POST /api/agent/conversations/[id]/messages — send a message, handoff,
// ack, or result into an open conversation. recipient_connection_id omitted
// or null broadcasts to every participant.
// GET  /api/agent/conversations/[id]/messages — poll for messages visible to
// this connection (broadcasts, messages addressed to it, its own sent
// messages), optionally only those after ?since=<workspace cursor>.
// Bearer-token only; caller must be a participant in the conversation.
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

    // The dashboard send path (ConversationPanel.tsx -> its own route) has
    // always sent an idempotency-key header; this agent-facing path never
    // read one from either a header or the body, so sendConversationMessage's
    // existing idempotencyKey dedup (it already fully supports this -- see
    // conversation-service.ts) was silently dead here. A retried
    // send_message/postWorkspaceResult call had no protection against
    // posting a genuine duplicate.
    const idempotencyKey = req.headers.get("idempotency-key")
      ?? (typeof body.idempotency_key === "string" ? body.idempotency_key : null);
    const message = await sendConversationMessage(agent, {
      conversationId,
      recipientConnectionId: typeof body.recipient_connection_id === "string" ? body.recipient_connection_id : null,
      kind: typeof body.kind === "string" ? body.kind : "",
      body: typeof body.body === "string" ? body.body : "",
      parentMessageId: typeof body.parent_message_id === "string" ? body.parent_message_id : null,
      idempotencyKey,
      outcome: typeof body.outcome === "string" ? body.outcome as "ok" | "failed" | "incomplete" : null,
    });
    return NextResponse.json({ message }, { status: 201 });
  } catch (err) {
    return handleAgentError(err);
  }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: conversationId } = await params;
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });

    const since = req.nextUrl.searchParams.get("since");
    const messages = await listConversationMessagesForAgent(agent, {
      conversationId,
      sinceCursor: since,
    });
    return NextResponse.json({ messages });
  } catch (err) {
    return handleAgentError(err);
  }
}
