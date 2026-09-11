import { NextRequest, NextResponse } from "next/server";
import { approveClaim, rejectClaim } from "@/lib/agent-join-service";
import { handleAgentError } from "../../_shared";

// ---------------------------------------------------------------------------
// POST /api/agent/claim/[claimId]  { decision: "approve" | "reject" }
//
// The human approval/rejection action behind the /claim/[claimId] page. Requires
// a signed-in user (enforced in approveClaim/rejectClaim). Approval binds the
// connection to a workspace the user owns and provisions a scoped token.
// ---------------------------------------------------------------------------

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> },
) {
  try {
    const { claimId } = await params;
    let body: { decision?: string };
    try {
      body = (await req.json()) as { decision?: string };
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    if (body.decision === "approve") {
      const result = await approveClaim(claimId);
      return NextResponse.json({ ok: true, ...result });
    }
    if (body.decision === "reject") {
      const result = await rejectClaim(claimId);
      return NextResponse.json({ ok: true, ...result });
    }
    return NextResponse.json({ error: 'decision must be "approve" or "reject".' }, { status: 400 });
  } catch (err) {
    return handleAgentError(err);
  }
}
