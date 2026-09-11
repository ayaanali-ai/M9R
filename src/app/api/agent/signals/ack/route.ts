import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { acknowledgeSignals } from "@/lib/work-signal-delivery";
import { handleAgentError } from "../../_shared";

/** Self-acknowledgement: a connection confirms receipt of its own Work Signals through a server sequence. */
export async function POST(req: NextRequest) {
  try {
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    if (!agent.scopes.includes("session:submit")) return NextResponse.json({ error: "Token lacks session:submit scope." }, { status: 403 });
    const body = await req.json() as Record<string, unknown>;
    const result = await acknowledgeSignals(agent, body.throughSequence);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) { return handleAgentError(error); }
}
