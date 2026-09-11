import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { transitionAssignmentForAgent } from "@/lib/assignment-service";
import { handleAgentError } from "../../_shared";
import type { AssignmentDecision } from "@/lib/assignment";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const token = bearerFrom(req.headers.get("authorization"));
    if (!token) return NextResponse.json({ error: "Bearer token required." }, { status: 401 });
    const agent = await authenticateAgent(token);
    if (!agent) return NextResponse.json({ error: "Invalid agent token." }, { status: 401 });
    const body = await req.json();
    if (!["accept", "reject", "complete"].includes(body.decision)) return NextResponse.json({ error: "Invalid agent decision." }, { status: 400 });
    const { id } = await params;
    const assignment = await transitionAssignmentForAgent(agent, id, body.decision as AssignmentDecision, body.evidence_record_id, body.run_id);
    return NextResponse.json({ assignment });
  } catch (error) { return handleAgentError(error); }
}
