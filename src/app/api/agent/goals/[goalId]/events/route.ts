import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { getGoalEvents } from "@/lib/goal/goal-service";
import { handleAgentError } from "../../../_shared";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ goalId: string }> }) {
  try {
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    const { goalId } = await params;
    return NextResponse.json({ events: await getGoalEvents(agent, goalId) });
  } catch (error) {
    return handleAgentError(error);
  }
}
