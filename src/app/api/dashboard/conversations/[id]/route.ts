import { NextRequest, NextResponse } from "next/server";
import { updateDashboardConversation, deleteDashboardConversation, leaveDashboardConversation } from "@/lib/conversation-service";
import { handleDashboardApiError } from "../../_shared";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => null) as { action?: unknown; description?: unknown; isPrivate?: unknown } | null;
  const validActions = ["archive", "restore", "update", "pause_agents", "resume_agents", "leave"] as const;
  const action = validActions.find((candidate) => candidate === body?.action);
  if (!action) return NextResponse.json({ error: "A valid channel action is required." }, { status: 400 });
  try {
    if (action === "leave") {
      await leaveDashboardConversation(id);
    } else {
      await updateDashboardConversation({ conversationId: id, action, description: typeof body?.description === "string" ? body.description : undefined, isPrivate: typeof body?.isPrivate === "boolean" ? body.isPrivate : undefined });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleDashboardApiError(error);
  }
}

// DELETE permanently removes the channel/DM and everything in it -- not reversible, unlike PATCH { action: "archive" }.
export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await deleteDashboardConversation(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleDashboardApiError(error);
  }
}
