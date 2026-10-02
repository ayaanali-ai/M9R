import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { readAgentRunSettings } from "@/lib/agent-run-settings-service";
import { handleAgentError } from "../_shared";

export async function GET(req: NextRequest) {
  try {
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid agent token." }, { status: 401 });
    return NextResponse.json(await readAgentRunSettings(agent, req.nextUrl.searchParams.get("conversationId")));
  } catch (error) { return handleAgentError(error); }
}
