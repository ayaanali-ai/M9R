import { NextRequest, NextResponse } from "next/server";
import { decideResidentDiffReview } from "@/lib/resident-diff-review-service";
import { handleAgentError } from "../../../agent/_shared";

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    return NextResponse.json({ ok: true, review: await decideResidentDiffReview(id, await req.json()) });
  } catch (error) { return handleAgentError(error); }
}
