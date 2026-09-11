import { NextRequest, NextResponse } from "next/server";
import { sanitizeString } from "@/lib/agent-join";
import { pollClaimStatus } from "@/lib/agent-join-service";
import { handleAgentError } from "../_shared";

// ---------------------------------------------------------------------------
// GET /api/agent/claim-status?claim_id=...&setup_code=...
//
// The agent polls here after handing the human a claim URL. claim_id alone is
// never enough — the secret setup_code is required. The raw token is returned
// exactly once after approval; later polls report "approved" without it.
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const claimId = sanitizeString(searchParams.get("claim_id"), 64);
    const setupCode = sanitizeString(searchParams.get("setup_code"), 128);

    if (!claimId) {
      return NextResponse.json({ error: "claim_id is required." }, { status: 400 });
    }
    if (!setupCode) {
      return NextResponse.json({ error: "setup_code is required." }, { status: 400 });
    }

    const result = await pollClaimStatus(claimId, setupCode);
    return NextResponse.json(result);
  } catch (err) {
    return handleAgentError(err);
  }
}
