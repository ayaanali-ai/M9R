import { NextResponse } from "next/server";
import { whisperActivitySummary } from "@/lib/bridge/whisper-activity-service";
import { handleDashboardApiError } from "../_shared";

// Real observability for agent-to-agent messaging -- see
// whisper-activity-service.ts. GET only, read/discovery surface.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const summary = await whisperActivitySummary();
    return NextResponse.json(summary, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleDashboardApiError(error);
  }
}
