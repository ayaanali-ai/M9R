import { NextRequest, NextResponse } from "next/server";
import { approveClaimBatch, rejectClaimBatch } from "@/lib/agent-join-service";
import { handleAgentError } from "../../_shared";

/** POST /api/agent/claim/batch { batch_id, decision: approve | reject } */
export async function POST(req: NextRequest) {
  try {
    let body: { batch_id?: string; decision?: string };
    try {
      body = (await req.json()) as { batch_id?: string; decision?: string };
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    if (!body.batch_id) return NextResponse.json({ error: "batch_id is required." }, { status: 400 });
    if (body.decision === "approve") {
      const result = await approveClaimBatch(body.batch_id);
      return NextResponse.json({ ok: true, ...result });
    }
    if (body.decision === "reject") {
      const result = await rejectClaimBatch(body.batch_id);
      return NextResponse.json({ ok: true, ...result });
    }
    return NextResponse.json({ error: 'decision must be "approve" or "reject".' }, { status: 400 });
  } catch (err) {
    return handleAgentError(err);
  }
}
