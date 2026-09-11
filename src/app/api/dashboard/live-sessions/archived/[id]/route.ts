import { NextRequest, NextResponse } from "next/server";
import { getArchivedSessionForDashboard } from "@/lib/bridge/session-service";
import { handleDashboardApiError } from "../../../_shared";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await getArchivedSessionForDashboard(id);
    if (!session) return NextResponse.json({ error: "Session not found." }, { status: 404 });
    return NextResponse.json({ session }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleDashboardApiError(error);
  }
}
