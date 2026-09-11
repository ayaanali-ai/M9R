import { NextRequest, NextResponse } from "next/server";
import { listDashboardModerationReports, resolveDashboardModerationReport } from "@/lib/conversation-service";
import { handleDashboardApiError } from "../../_shared";

export async function GET(request: NextRequest) {
  const status = request.nextUrl.searchParams.get("status");
  const validStatus = status === "open" || status === "reviewed" || status === "dismissed" ? status : undefined;
  try {
    const reports = await listDashboardModerationReports(validStatus);
    return NextResponse.json({ reports });
  } catch (error) {
    return handleDashboardApiError(error);
  }
}

export async function PATCH(request: NextRequest) {
  const body = await request.json().catch(() => null) as { reportId?: unknown; status?: unknown } | null;
  if (typeof body?.reportId !== "string" || (body.status !== "reviewed" && body.status !== "dismissed")) {
    return NextResponse.json({ error: "reportId and a valid status are required." }, { status: 400 });
  }
  try {
    await resolveDashboardModerationReport({ reportId: body.reportId, status: body.status });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleDashboardApiError(error);
  }
}
