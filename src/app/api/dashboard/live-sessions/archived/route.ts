import { NextResponse } from "next/server";
import { listArchivedSessions } from "@/lib/bridge/session-service";
import { handleDashboardApiError } from "../../_shared";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const sessions = await listArchivedSessions();
    return NextResponse.json({ sessions }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleDashboardApiError(error);
  }
}
