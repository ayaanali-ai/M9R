import { NextRequest, NextResponse } from "next/server";
import { requestCancelTurnForConversation, cancelTurnStatusForConversation } from "@/lib/conversation-service";
import { handleDashboardApiError } from "../../../_shared";

/** POST -- the Stop button. Leaves a durable request for the owning Bridge process to consume on its next cancel-turn poll (see /api/bridge/cancel-turn). */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => null) as { connectionId?: unknown } | null;
  const connectionId = typeof body?.connectionId === "string" ? body.connectionId : "";
  if (!connectionId) return NextResponse.json({ error: "connectionId is required." }, { status: 400 });
  try {
    await requestCancelTurnForConversation({ conversationId: id, connectionId });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleDashboardApiError(error);
  }
}

/** GET ?connectionId=... -- the composer's confirmation poll, so the Stop button can revert to Send once the Bridge actually delivers the cancellation, instead of guessing from a timeout. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const connectionId = request.nextUrl.searchParams.get("connectionId") ?? "";
  if (!connectionId) return NextResponse.json({ error: "connectionId is required." }, { status: 400 });
  try {
    const status = await cancelTurnStatusForConversation({ conversationId: id, connectionId });
    return NextResponse.json({ status }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleDashboardApiError(error);
  }
}
