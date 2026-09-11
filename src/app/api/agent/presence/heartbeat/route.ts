import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { recordAgentHeartbeat } from "@/lib/agent-presence-service";
import { handleAgentError } from "../../_shared";

export async function POST(req: NextRequest) {
  try {
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    if (!agent.scopes.includes("session:submit")) {
      return NextResponse.json({ error: "Token lacks session:submit scope." }, { status: 403 });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const observation = await recordAgentHeartbeat(agent, body);
    return NextResponse.json({
      ok: true,
      state: "awake",
      truth: "observed",
      received_at: observation.receivedAt,
      lease_expires_at: observation.leaseExpiresAt,
      next_sequence: observation.sequence + 1,
    });
  } catch (error) {
    return handleAgentError(error);
  }
}
