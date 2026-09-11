import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { writeDraftSectionForAgent, listDraftsForAgent } from "@/lib/conversation-service";
import { handleAgentError } from "../../../_shared";

// ---------------------------------------------------------------------------
// #13 shared co-drafting.
// POST /api/agent/conversations/[id]/drafts — write (create-or-revise) one
// named section of a shared draft document in this conversation.
// GET  /api/agent/conversations/[id]/drafts — read every draft in this
// conversation, sections included, in document order.
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
    if (typeof body.draftTitle !== "string" || typeof body.heading !== "string" || typeof body.body !== "string") {
      return NextResponse.json({ error: "draftTitle, heading, and body are all required strings." }, { status: 400 });
    }

    const draft = await writeDraftSectionForAgent(agent, {
      conversationId,
      draftTitle: body.draftTitle,
      heading: body.heading,
      body: body.body,
    });
    return NextResponse.json({ draft }, { status: 201 });
  } catch (err) {
    return handleAgentError(err);
  }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: conversationId } = await params;
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });

    const drafts = await listDraftsForAgent(agent, conversationId);
    return NextResponse.json({ drafts });
  } catch (err) {
    return handleAgentError(err);
  }
}
