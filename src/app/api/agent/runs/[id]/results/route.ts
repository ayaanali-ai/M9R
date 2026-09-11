import { NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { listCoordinationStatusesForAgent, listReturnedResultsForAgent } from "@/lib/result-adoption-service";
import { handleAgentError } from "../../../_shared";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    const { id: runId } = await params;
    const [results, statuses] = await Promise.all([
      listReturnedResultsForAgent(agent, runId),
      listCoordinationStatusesForAgent(agent, runId),
    ]);
    return NextResponse.json({ results, statuses });
  } catch (error) {
    return handleAgentError(error);
  }
}
