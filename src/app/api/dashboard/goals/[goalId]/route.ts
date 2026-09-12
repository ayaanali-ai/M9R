import { NextRequest, NextResponse } from "next/server";
import { getGoalHandoffRecord } from "@/lib/goal/goal-service";
import { resolveMissionPrincipal } from "@/lib/mission/mission-principal";
import { handleDashboardApiError } from "../../_shared";

/**
 * GET /api/dashboard/goals/[goalId] — one Goal's full human-visible handoff
 * record: lifecycle events, what context was handed over, and what was
 * proven done. Cookie-authenticated. Fetched on-demand when a row is
 * expanded, not bundled into the list response -- same fetch-on-expand
 * shape as TaskCard's Whispers drawer.
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ goalId: string }> }) {
  try {
    const principal = await resolveMissionPrincipal(req, { requireHuman: true });
    const { goalId } = await params;
    const record = await getGoalHandoffRecord(principal, goalId);
    return NextResponse.json(record, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleDashboardApiError(error);
  }
}
