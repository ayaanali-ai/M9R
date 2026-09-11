import { NextRequest, NextResponse } from "next/server";
import { markDashboardConversationRead } from "@/lib/conversation-service";
import { handleDashboardApiError } from "../../../_shared";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => ({})) as { messageId?: unknown };
  try {
    await markDashboardConversationRead({ conversationId: id, messageId: typeof body.messageId === "string" ? body.messageId : null });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleDashboardApiError(error);
  }
}
