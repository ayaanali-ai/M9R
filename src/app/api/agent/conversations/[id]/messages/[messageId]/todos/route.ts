import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { setMessageTodosForAgent } from "@/lib/conversation-service";
import { handleAgentError } from "../../../../../_shared";

// ---------------------------------------------------------------------------
// PUT /api/agent/conversations/[id]/messages/[messageId]/todos — replace the
// live checklist attached to a message this connection already sent.
//
// PUT, not POST: ACP's plan contract is replace-the-whole-list (see
// message-todo-service.ts), so every call is a full-state write, not an
// append. Bearer-token only; the caller must be a participant in the
// conversation AND the message's own sender_connection_id -- an agent must
// never be able to set another agent's checklist (enforced in
// setMessageTodosForAgent, not here).
//
// This is the durable half only. The live half is the Bridge's own
// `workspace.todos` relay frame, published from the same bridge-runtime code
// path that calls this route -- the relay is a WebSocket fabric published
// into by connected clients, and the Next server is not one of them, so a
// route cannot broadcast without inventing a second server-side relay
// client. The Bridge holding both an open socket and this token is the
// existing pattern (see postWorkspaceResult).
// ---------------------------------------------------------------------------

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string; messageId: string }> }) {
  try {
    const { id: conversationId, messageId } = await params;
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const todos = await setMessageTodosForAgent(agent, { conversationId, messageId, entries: body.entries });
    return NextResponse.json({ todos });
  } catch (err) {
    return handleAgentError(err);
  }
}
