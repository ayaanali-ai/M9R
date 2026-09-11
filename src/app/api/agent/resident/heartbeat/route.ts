import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { heartbeatResident } from "@/lib/resident-service";
import { handleAgentError } from "../../_shared";

export async function POST(req: NextRequest) {
  try {
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    return NextResponse.json({ ok: true, ...(await heartbeatResident(agent, await req.json())) });
  } catch (error) { return handleAgentError(error); }
}
