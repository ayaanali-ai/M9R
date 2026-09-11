import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { claimResidentGrant } from "@/lib/resident-service";
import { handleAgentError } from "../../../../_shared";

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    const { id } = await context.params;
    const body = await req.json() as { instanceKey?: unknown };
    if (typeof body.instanceKey !== "string") return NextResponse.json({ error: "Resident instance key is required." }, { status: 400 });
    return NextResponse.json({ ok: true, ...(await claimResidentGrant(agent, id, body.instanceKey)) });
  } catch (error) { return handleAgentError(error); }
}
