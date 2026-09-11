import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { listAssignmentsForAgent } from "@/lib/assignment-service";
import { handleAgentError } from "../_shared";

export async function GET(req: NextRequest) {
  try {
    const token = bearerFrom(req.headers.get("authorization"));
    if (!token) return NextResponse.json({ error: "Bearer token required." }, { status: 401 });
    const agent = await authenticateAgent(token);
    if (!agent) return NextResponse.json({ error: "Invalid agent token." }, { status: 401 });
    return NextResponse.json({ assignments: await listAssignmentsForAgent(agent) });
  } catch (error) { return handleAgentError(error); }
}
