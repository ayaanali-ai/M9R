import { NextRequest, NextResponse } from "next/server";
import { createDashboardChannel, listConversationsForDashboard } from "@/lib/conversation-service";
import { handleDashboardApiError } from "../_shared";

/**
 * GET /api/dashboard/conversations — every open conversation the signed-in
 * owner's workspace holds. Full message history (up to 80) is only returned
 * for `?selected=<conversationId>`, the channel actually open in the
 * viewer's UI; every other channel gets just its latest message, which is
 * all the channel-switcher preview line ever needed. Cookie-authenticated
 * (RLS-scoped via listConversationsForDashboard), same pattern as the Wire's
 * /api/agent/runs/[id]/thread. Polled by the Watchfloor's conversation panel.
 */
export async function GET(req: NextRequest) {
  try {
    const selected = req.nextUrl.searchParams.get("selected");
    const conversations = await listConversationsForDashboard(selected);
    return NextResponse.json({ conversations }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleDashboardApiError(error);
  }
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { name?: unknown; description?: unknown; isPrivate?: unknown; participantConnectionIds?: unknown; humanUserIds?: unknown } | null;
  if (typeof body?.name !== "string") return NextResponse.json({ error: "Channel name is required." }, { status: 400 });
  try {
    const conversation = await createDashboardChannel({
      name: body.name,
      description: typeof body.description === "string" ? body.description : null,
      isPrivate: body.isPrivate === true,
      participantConnectionIds: Array.isArray(body.participantConnectionIds) ? body.participantConnectionIds.filter((value): value is string => typeof value === "string") : undefined,
      humanUserIds: Array.isArray(body.humanUserIds) ? body.humanUserIds.filter((value): value is string => typeof value === "string") : undefined,
    });
    return NextResponse.json({ conversation }, { status: 201 });
  } catch (error) {
    return handleDashboardApiError(error);
  }
}
