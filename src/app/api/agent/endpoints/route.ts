import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { listEndpoints } from "@/lib/endpoint-service";
import { handleAgentError } from "../_shared";

// GET /api/agent/endpoints: the durable endpoints in this agent's workspace, with live reachability.
// Bearer-authenticated; read-only.
export async function GET(req: NextRequest) {
  try {
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    return NextResponse.json({ endpoints: await listEndpoints(agent) });
  } catch (err) {
    return handleAgentError(err);
  }
}
