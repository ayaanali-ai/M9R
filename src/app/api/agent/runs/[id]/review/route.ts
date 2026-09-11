import { NextResponse } from "next/server";
import { getAgentRunForUser, recordRunReviewDecision } from "@/lib/agent-run-service";
import { createClient } from "@/lib/supabase/server";
import {
  MAX_REVIEW_NOTE_LENGTH,
  containsActiveReviewNotePayload,
  isRunReviewDecision,
} from "@/lib/run-review-decision-service";
import { handleAgentError } from "../../../_shared";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const db = await createClient();
    if (!db) return NextResponse.json({ error: "M9R is not configured." }, { status: 503 });
    const {
      data: { user },
    } = await db.auth.getUser();
    if (!user) return NextResponse.json({ error: "Sign in to review this run." }, { status: 401 });

    const body = (await req.json().catch(() => null)) as { decision?: unknown; note?: unknown } | null;
    if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    if (!isRunReviewDecision(body.decision)) {
      return NextResponse.json({ error: "Review decision is required." }, { status: 400 });
    }

    const note = typeof body.note === "string" ? body.note : "";
    if (note.length > MAX_REVIEW_NOTE_LENGTH) {
      return NextResponse.json({ error: "Reviewer note is too large." }, { status: 413 });
    }
    if (containsActiveReviewNotePayload(note)) {
      return NextResponse.json({ error: "Active HTML or script content is not allowed." }, { status: 400 });
    }

    const { id } = await params;
    const run = await getAgentRunForUser(id);
    if (!run) return NextResponse.json({ error: "Run not found." }, { status: 404 });
    if (!run.latest_session_id) {
      return NextResponse.json({ error: "Submit evidence before saving a review decision." }, { status: 409 });
    }

    const human_review = await recordRunReviewDecision(run.id, { decision: body.decision, note });
    return NextResponse.json({ ok: true, human_review });
  } catch (err) {
    return handleAgentError(err);
  }
}
