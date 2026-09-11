import { NextRequest, NextResponse } from "next/server";
import { toggleDashboardReaction } from "@/lib/conversation-service";
import { handleDashboardApiError } from "../../../_shared";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => null) as { messageId?: unknown; emoji?: unknown } | null;
  if (typeof body?.messageId !== "string" || typeof body.emoji !== "string") return NextResponse.json({ error: "messageId and emoji are required." }, { status: 400 });
  try {
    return NextResponse.json(await toggleDashboardReaction({ conversationId: id, messageId: body.messageId, emoji: body.emoji }));
  } catch (error) {
    return handleDashboardApiError(error);
  }
}
