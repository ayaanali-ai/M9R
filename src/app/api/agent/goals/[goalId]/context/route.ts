import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { createContextPacket, listContextPackets } from "@/lib/goal/goal-service";
import { handleAgentError } from "../../../_shared";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ goalId: string }> }) {
  try {
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    const { goalId } = await params;
    return NextResponse.json({ packets: await listContextPackets(agent, goalId) });
  } catch (error) {
    return handleAgentError(error);
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ goalId: string }> }) {
  try {
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    const { goalId } = await params;
    return NextResponse.json({ packet: await createContextPacket(agent, goalId, await req.json()) }, { status: 201 });
  } catch (error) {
    return handleAgentError(error);
  }
}
