import { NextRequest, NextResponse } from "next/server";
import { sendDashboardConversationMessage, updateDashboardMessage } from "@/lib/conversation-service";
import { handleDashboardApiError } from "../../../_shared";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => null) as { body?: unknown; parentMessageId?: unknown; idempotencyKey?: unknown } | null;
  if (typeof body?.body !== "string") {
    return NextResponse.json({ error: "Message body is required." }, { status: 400 });
  }
  try {
    const idempotencyKey = request.headers.get("idempotency-key") ?? (typeof body.idempotencyKey === "string" ? body.idempotencyKey : null);
    const message = await sendDashboardConversationMessage({ conversationId: id, body: body.body, parentMessageId: typeof body.parentMessageId === "string" ? body.parentMessageId : null, idempotencyKey });
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
