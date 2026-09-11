import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { recordResidentLaunchEvent } from "@/lib/resident-service";
import { handleAgentError } from "../../../../_shared";

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    const { id } = await context.params;
    const body = await req.json() as Record<string, unknown>;
    if (typeof body.instanceKey !== "string") return NextResponse.json({ error: "Resident instance key is required." }, { status: 400 });
    return NextResponse.json({ ok: true, ...(await recordResidentLaunchEvent(agent, id, body.instanceKey, body)) });
  } catch (error) { return handleAgentError(error); }
}
