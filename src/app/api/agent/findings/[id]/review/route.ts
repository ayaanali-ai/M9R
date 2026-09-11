import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { reviewFinding } from "@/lib/finding-service";
import { handleAgentError } from "../../../_shared";

// ---------------------------------------------------------------------------
// POST /api/agent/findings/[id]/review — human review decision for a Finding.
//
// Cookie-authenticated ONLY (signed-in Operator). This is the one place a
// Finding can move from "observed" to "available" or "retired" — there is no
// agent-callable path to this route, matching the "agents cannot mark their
// own work reviewed" guardrail.
// ---------------------------------------------------------------------------

interface ReviewBody {
  decision?: unknown;
  workspace_id?: unknown;
}

function jsonError(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: findingId } = await params;
    const db = await createClient();
  if (!db) return jsonError("M9R is not configured.", 503);
    const {
      data: { user },
    } = await db.auth.getUser();
    if (!user) return jsonError("Sign in to review a finding.", 401);

    const raw = (await req.json().catch(() => null)) as ReviewBody | null;
    if (!raw) return jsonError("Invalid JSON body.", 400);
    if (raw.decision !== "available" && raw.decision !== "retired") {
      return jsonError('decision must be "available" or "retired".', 400);
    }
    const workspaceId = typeof raw.workspace_id === "string" ? raw.workspace_id : "";
    if (!workspaceId) return jsonError("workspace_id is required.", 400);

    // RLS proof-of-ownership: this SELECT only succeeds if the signed-in user
    // owns the workspace, before we escalate to the service-role write.
    const { data: owned, error: ownedError } = await db.from("projects").select("id").eq("id", workspaceId).maybeSingle();
    if (ownedError) return jsonError("Could not verify workspace ownership.", 500);
    if (!owned) return jsonError("Workspace not found or not owned by this user.", 403);

    const result = await reviewFinding(workspaceId, findingId, raw.decision, user.id);
    if (!result.ok) return jsonError(result.error ?? "Could not record the review decision.", 500);
    return NextResponse.json({ ok: true, review_state: raw.decision });
  } catch (err) {
    return handleAgentError(err);
  }
}
