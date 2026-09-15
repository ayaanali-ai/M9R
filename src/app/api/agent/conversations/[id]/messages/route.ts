import { NextRequest, NextResponse } from "next/server";
import { AgentJoinError, authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
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

const MESSAGE_OUTCOMES = ["ok", "failed", "incomplete"] as const;
type MessageOutcome = (typeof MESSAGE_OUTCOMES)[number];

function optionalMessageString(body: Record<string, unknown>, field: string, label: string): string | null {
  const value = body[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 256) {
    throw new AgentJoinError(`${label} is invalid.`, `INVALID_${field.toUpperCase()}`, 400);
  }
  return value.trim();
}

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
    const headerIdempotencyKey = req.headers.get("idempotency-key");
    const bodyIdempotencyKey = body.idempotency_key;
    if (headerIdempotencyKey !== null && (headerIdempotencyKey.trim().length === 0 || headerIdempotencyKey.length > 256)) {
      throw new AgentJoinError("idempotency-key header is invalid.", "INVALID_IDEMPOTENCY_KEY", 400);
    }
    if (bodyIdempotencyKey !== undefined && bodyIdempotencyKey !== null && (typeof bodyIdempotencyKey !== "string" || bodyIdempotencyKey.trim().length === 0 || bodyIdempotencyKey.length > 256)) {
      throw new AgentJoinError("idempotency_key is invalid.", "INVALID_IDEMPOTENCY_KEY", 400);
    }
    const normalizedHeaderIdempotencyKey = headerIdempotencyKey?.trim() ?? null;
    const normalizedBodyIdempotencyKey = typeof bodyIdempotencyKey === "string" ? bodyIdempotencyKey.trim() : null;
    if (normalizedHeaderIdempotencyKey && normalizedBodyIdempotencyKey && normalizedHeaderIdempotencyKey !== normalizedBodyIdempotencyKey) {
      throw new AgentJoinError("idempotency-key header and idempotency_key body field must match.", "IDEMPOTENCY_KEY_CONFLICT", 409);
    }
    const idempotencyKey = normalizedHeaderIdempotencyKey ?? normalizedBodyIdempotencyKey;
    if (typeof body.kind !== "string") throw new AgentJoinError("kind is required.", "INVALID_KIND", 400);
    if (typeof body.body !== "string") throw new AgentJoinError("body is required.", "INVALID_BODY", 400);
    const rawOutcome = body.outcome;
    if (rawOutcome !== undefined && rawOutcome !== null && (!MESSAGE_OUTCOMES.includes(rawOutcome as MessageOutcome))) {
      throw new AgentJoinError(`outcome must be one of: ${MESSAGE_OUTCOMES.join(", ")}.`, "INVALID_OUTCOME", 400);
    }
    const message = await sendConversationMessage(agent, {
      conversationId,
      recipientConnectionId: optionalMessageString(body, "recipient_connection_id", "recipient_connection_id"),
      kind: body.kind,
      body: body.body,
      parentMessageId: optionalMessageString(body, "parent_message_id", "parent_message_id"),
      idempotencyKey,
      outcome: rawOutcome as MessageOutcome | null | undefined,
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
