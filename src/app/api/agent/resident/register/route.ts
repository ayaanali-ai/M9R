import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { registerResident } from "@/lib/resident-service";
import { handleAgentError } from "../../_shared";

export async function POST(req: NextRequest) {
  try {
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    const result = await registerResident(agent, await req.json());
    return NextResponse.json({ ok: true, ...result });
  } catch (error) { return handleAgentError(error); }
}
