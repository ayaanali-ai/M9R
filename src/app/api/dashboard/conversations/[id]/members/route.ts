import { NextRequest, NextResponse } from "next/server";
import { listConversationHumanRoster, addHumanToConversation, removeHumanFromConversation } from "@/lib/conversation-service";
import { handleDashboardApiError } from "../../../_shared";

// #19 session-sharing: manage which workspace members can see a specific
// (typically private) channel, after it's already been created -- the
// creation flow's own human picker only covers "who's in it on day one."
// GET    — every workspace member, each flagged with whether they're in
//          this channel.
// POST   — add one workspace member to this channel.
// DELETE — remove one member (?userId=) from this channel.

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const roster = await listConversationHumanRoster(id);
    return NextResponse.json({ roster });
  } catch (error) {
    return handleDashboardApiError(error);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => null) as { userId?: unknown } | null;
  if (typeof body?.userId !== "string" || !body.userId) {
    return NextResponse.json({ error: "userId is required." }, { status: 400 });
  }
  try {
    await addHumanToConversation(id, body.userId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleDashboardApiError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const userId = request.nextUrl.searchParams.get("userId");
  if (!userId) return NextResponse.json({ error: "userId is required." }, { status: 400 });
  try {
    await removeHumanFromConversation(id, userId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleDashboardApiError(error);
  }
}
