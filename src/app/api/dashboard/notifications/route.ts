import { NextRequest, NextResponse } from "next/server";
import { countUnreadDashboardNotifications, listDashboardNotifications, markAllDashboardNotificationsRead, markDashboardNotificationsRead } from "@/lib/conversation-service";
import { handleDashboardApiError } from "../_shared";

export async function GET() {
  try {
    // unreadCount used to be a filter over `notifications` -- a capped
    // 100-row page -- so it was never a real total. It is now its own count
    // query; the list stays paged for display.
    const [notifications, unreadCount] = await Promise.all([listDashboardNotifications(), countUnreadDashboardNotifications()]);
    return NextResponse.json({ notifications, unreadCount }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleDashboardApiError(error);
  }
}

export async function PATCH(request: NextRequest) {
  const body = await request.json().catch(() => ({})) as { notificationIds?: unknown; markAll?: unknown };
  const notificationIds = Array.isArray(body.notificationIds) ? body.notificationIds.filter((value): value is string => typeof value === "string") : [];
  try {
    // markAll updates by predicate server-side; it deliberately ignores
    // notificationIds so it is not bounded by whatever page the client holds.
    const marked = body.markAll === true ? await markAllDashboardNotificationsRead() : await markDashboardNotificationsRead(notificationIds);
    return NextResponse.json({ marked });
  } catch (error) {
    return handleDashboardApiError(error);
  }
}
