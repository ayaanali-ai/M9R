import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolveActiveOrDefaultProjectId } from "@/lib/projects-service";
import { decideApprovalRequest } from "@/lib/approval-requests";
import { handleAgentError } from "../../../_shared";

const MAX_NOTE_LENGTH = 1000;

// POST /api/agent/approvals/[id]/decide — cookie-authenticated ONLY. A bearer
// token is never sufficient authority to decide an approval request; this
// route does not read the Authorization header at all, matching the same
// cookie-only pattern as /api/agent/runs/[id]/review.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const db = await createClient();
    if (!db) return NextResponse.json({ error: "M9R is not configured." }, { status: 503 });
    const {
      data: { user },
    } = await db.auth.getUser();
    if (!user) return NextResponse.json({ error: "Sign in to decide this approval request." }, { status: 401 });

    const body = (await req.json().catch(() => null)) as { decision?: unknown; note?: unknown } | null;
    if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    if (body.decision !== "approved" && body.decision !== "rejected") {
      return NextResponse.json({ error: "decision must be 'approved' or 'rejected'." }, { status: 400 });
    }
    const note = typeof body.note === "string" ? body.note : "";
    if (note.length > MAX_NOTE_LENGTH) {
      return NextResponse.json({ error: "Decision note is too large." }, { status: 413 });
    }

    const { id } = await params;
    const workspaceId = await resolveActiveOrDefaultProjectId(db, {
      id: user.id,
      email: user.email,
      name: (user.user_metadata?.name as string | undefined) ?? null,
    });

    const result = await decideApprovalRequest({
      id,
      workspaceId,
      decision: body.decision,
      decidedByUserId: user.id,
      decisionNote: note,
    });

    if (!result.ok) {
      if (result.reason === "not_found") {
        return NextResponse.json({ error: "Approval request not found." }, { status: 404 });
      }
      // already_decided / expired / invalid_decision
      return NextResponse.json(
        { error: `Approval request could not be decided: ${result.reason}.`, reason: result.reason },
        { status: 409 },
      );
    }

    return NextResponse.json({ ok: true, approvalRequest: result.request }, { status: 200 });
  } catch (err) {
    return handleAgentError(err);
  }
}
