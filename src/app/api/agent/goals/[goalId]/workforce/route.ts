import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { proposeGoalWorkforce } from "@/lib/goal/goal-service";
import { handleAgentError } from "../../../_shared";

export const dynamic = "force-dynamic";

/** GET returns an advisory workforce proposal for an authorized Goal. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ goalId: string }> }) {
  try {
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    const { goalId } = await params;
    return NextResponse.json(await proposeGoalWorkforce(agent, goalId));
  } catch (error) {
    return handleAgentError(error);
  }
}
