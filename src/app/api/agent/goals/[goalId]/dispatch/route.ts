import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { dispatchGoalToMission } from "@/lib/goal/goal-service";
import { handleAgentError } from "../../../_shared";

export const dynamic = "force-dynamic";

/** POST dispatches a human-authorized Goal into the existing Mission kernel. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ goalId: string }> }) {
  try {
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    const { goalId } = await params;
    return NextResponse.json(await dispatchGoalToMission(agent, goalId), { status: 202 });
  } catch (error) {
    return handleAgentError(error);
  }
}
