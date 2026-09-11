import { NextRequest, NextResponse } from "next/server";
import {
  authenticateAgent,
  bearerFrom,
  disconnectAuthenticatedAgent,
} from "@/lib/agent-join-service";
import { handleAgentError } from "../_shared";

export const dynamic = "force-dynamic";

// POST /api/agent/disconnect - revoke the current Bearer-token connection.
export async function POST(req: NextRequest) {
  try {
    const token = bearerFrom(req.headers.get("authorization"));
    const agent = await authenticateAgent(token);
    if (!agent) {
      return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    }

    const result = await disconnectAuthenticatedAgent(agent);
    return NextResponse.json(result);
  } catch (err) {
    return handleAgentError(err);
  }
}
