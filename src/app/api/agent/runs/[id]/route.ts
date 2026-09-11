import { NextResponse } from "next/server";
import { getAgentRunForUser } from "@/lib/agent-run-service";
import { handleAgentError } from "../../_shared";

// ---------------------------------------------------------------------------
// GET /api/agent/runs/[id] — a single agent run for the signed-in human.
//
// Cookie-authenticated; RLS scopes the row to a workspace the user owns. 404
// for a run the user does not own (never leaks another user's run).
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const run = await getAgentRunForUser(id);
    if (!run) return NextResponse.json({ error: "Run not found." }, { status: 404 });
    return NextResponse.json({ run });
  } catch (err) {
    return handleAgentError(err);
  }
}
