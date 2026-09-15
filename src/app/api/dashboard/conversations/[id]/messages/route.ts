import { NextRequest, NextResponse } from "next/server";
import { AgentJoinError } from "@/lib/agent-join-service";
import { sendDashboardConversationMessage, updateDashboardMessage } from "@/lib/conversation-service";
import { handleDashboardApiError } from "../../../_shared";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => null) as { body?: unknown; parentMessageId?: unknown; idempotencyKey?: unknown } | null;
  if (typeof body?.body !== "string") {
    return NextResponse.json({ error: "Message body is required." }, { status: 400 });
  }
  try {
    const headerIdempotencyKey = request.headers.get("idempotency-key");
    const bodyIdempotencyKey = body.idempotencyKey;
    if (headerIdempotencyKey !== null && (headerIdempotencyKey.trim().length === 0 || headerIdempotencyKey.length > 256)) {
      throw new AgentJoinError("idempotency-key header is invalid.", "INVALID_IDEMPOTENCY_KEY", 400);
    }
    if (bodyIdempotencyKey !== undefined && bodyIdempotencyKey !== null && (typeof bodyIdempotencyKey !== "string" || bodyIdempotencyKey.trim().length === 0 || bodyIdempotencyKey.length > 256)) {
      throw new AgentJoinError("idempotencyKey is invalid.", "INVALID_IDEMPOTENCY_KEY", 400);
    }
    if (body.parentMessageId !== undefined && body.parentMessageId !== null && (typeof body.parentMessageId !== "string" || body.parentMessageId.trim().length === 0 || body.parentMessageId.length > 256)) {
      throw new AgentJoinError("parentMessageId is invalid.", "INVALID_PARENT", 400);
    }
    const normalizedHeaderIdempotencyKey = headerIdempotencyKey?.trim() ?? null;
    const normalizedBodyIdempotencyKey = typeof bodyIdempotencyKey === "string" ? bodyIdempotencyKey.trim() : null;
    if (normalizedHeaderIdempotencyKey && normalizedBodyIdempotencyKey && normalizedHeaderIdempotencyKey !== normalizedBodyIdempotencyKey) {
      throw new AgentJoinError("idempotency-key header and idempotencyKey body field must match.", "IDEMPOTENCY_KEY_CONFLICT", 409);
    }
    const idempotencyKey = normalizedHeaderIdempotencyKey ?? normalizedBodyIdempotencyKey;
    const message = await sendDashboardConversationMessage({ conversationId: id, body: body.body, parentMessageId: typeof body.parentMessageId === "string" ? body.parentMessageId.trim() : null, idempotencyKey });
    return NextResponse.json({ message }, { status: 201 });
  } catch (error) {
    return handleDashboardApiError(error);
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => null) as { messageId?: unknown; body?: unknown } | null;
  if (typeof body?.messageId !== "string" || (body.body !== null && typeof body.body !== "string")) return NextResponse.json({ error: "messageId and body are required." }, { status: 400 });
  try {
    await updateDashboardMessage({ conversationId: id, messageId: body.messageId, body: body.body as string | null });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleDashboardApiError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const messageId = request.nextUrl.searchParams.get("messageId");
  if (!messageId) return NextResponse.json({ error: "messageId is required." }, { status: 400 });
  try {
    await updateDashboardMessage({ conversationId: id, messageId, body: null });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleDashboardApiError(error);
  }
}
