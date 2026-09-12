import { NextRequest, NextResponse } from "next/server";
import { listWorkspaceGoals } from "@/lib/goal/goal-service";
import { resolveMissionPrincipal } from "@/lib/mission/mission-principal";
import { handleDashboardApiError } from "../_shared";

/**
 * GET /api/dashboard/goals — every Goal in the signed-in owner's workspace,
 * not just ones tied to one agent connection. The whole point of this
 * surface is watching handoffs *between* connections (see
 * goal-service.ts's requireHumanPrincipal comment). Cookie-authenticated.
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const principal = await resolveMissionPrincipal(req, { requireHuman: true });
    const goals = await listWorkspaceGoals(principal);
    return NextResponse.json({ goals }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleDashboardApiError(error);
  }
}
