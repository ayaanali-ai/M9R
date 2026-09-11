import { NextRequest, NextResponse } from "next/server";
import { authorizeGoal } from "@/lib/goal/goal-service";
import { handleAgentError } from "@/app/api/agent/_shared";
import { resolveMissionPrincipal } from "@/lib/mission/mission-principal";

export const dynamic = "force-dynamic";

/** Human-only approval boundary for a proposed Goal. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ goalId: string }> }) {
  try {
    const principal = await resolveMissionPrincipal(req, { requireHuman: true });
    const { goalId } = await params;
    return NextResponse.json({ goal: await authorizeGoal(principal, goalId) });
  } catch (error) {
    return handleAgentError(error);
  }
}
