import { NextResponse } from "next/server";
import { disconnectAgentConnection } from "@/lib/agent-join-service";
import { handleAgentError } from "../../../_shared";

export const dynamic = "force-dynamic";

// POST /api/agent/connections/[id]/disconnect - revoke one connected agent.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const result = await disconnectAgentConnection(id);
    return NextResponse.json(result);
  } catch (err) {
    return handleAgentError(err);
  }
}
