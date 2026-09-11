import { NextRequest, NextResponse } from "next/server";
import { reportDashboardMessage } from "@/lib/conversation-service";
import { handleDashboardApiError } from "../../../../../_shared";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; messageId: string }> }) {
  const { id, messageId } = await params;
  const body = await request.json().catch(() => null) as { reason?: unknown } | null;
  if (typeof body?.reason !== "string" || !body.reason.trim()) return NextResponse.json({ error: "reason is required." }, { status: 400 });
  try {
    await reportDashboardMessage({ conversationId: id, messageId, reason: body.reason });
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (error) {
    return handleDashboardApiError(error);
  }
}
