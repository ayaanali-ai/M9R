import { NextResponse } from "next/server";
import { listRecentWhispers } from "@/lib/bridge/whisper-activity-service";
import { handleDashboardApiError } from "../_shared";

// Real agent-to-agent message list, queried directly -- replaces
// WhispersPanel's previous behavior of re-fetching and client-filtering the
// full /api/dashboard/conversations firehose. GET only, read/discovery surface.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const messages = await listRecentWhispers();
    return NextResponse.json({ messages }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleDashboardApiError(error);
  }
}
