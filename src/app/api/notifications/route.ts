import { NextRequest, NextResponse } from "next/server";
import { createSupabaseMissionNotificationStore } from "@/lib/mission/mission-notification-store";
import { handleMissionApiError, queryWorkspaceId, withMissionPrincipal } from "../missions/_shared";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const principal = await withMissionPrincipal(req, { requestedWorkspaceId: queryWorkspaceId(req), requireHuman: true });
    const store = createSupabaseMissionNotificationStore();
    const notifications = await store.list({
      workspaceId: principal.workspaceId,
      recipientUserId: principal.userId ?? principal.actor.id,
      unreadOnly: req.nextUrl.searchParams.get("unread") === "1",
      limit: Number(req.nextUrl.searchParams.get("limit") ?? "") || 100,
    });
    return NextResponse.json({ notifications, unreadCount: notifications.filter((notification) => notification.readAt === null).length }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleMissionApiError(error);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const principal = await withMissionPrincipal(req, { requestedWorkspaceId: queryWorkspaceId(req), requireHuman: true });
    const body = await req.json().catch(() => ({}));
    const notificationIds = Array.isArray(body.notificationIds) ? body.notificationIds.map(String).filter(Boolean).slice(0, 200) : [];
    const marked = await createSupabaseMissionNotificationStore().markRead({
      workspaceId: principal.workspaceId,
      recipientUserId: principal.userId ?? principal.actor.id,
      notificationIds,
      readAt: new Date().toISOString(),
    });
    return NextResponse.json({ marked });
  } catch (error) {
    return handleMissionApiError(error);
  }
}
