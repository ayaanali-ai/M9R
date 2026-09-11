import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { reviewFinding } from "@/lib/finding-service";
import { createRuleFromFinding, WorkspaceRulesError } from "@/lib/workspace-rules-service";
import { handleAgentError } from "../../../_shared";

// ---------------------------------------------------------------------------
// POST /api/agent/findings/[id]/promote-to-rule — approve a Finding's evidence
// AND draft a rule from it in one human action.
//
// Cookie-authenticated ONLY (signed-in Operator), same guardrail as
// /review: there is no agent-callable path here. Marks the Finding
// `available` (if it wasn't already) and drafts a `needs_review` workspace
// rule from its suggested_response -- the rule itself still requires a
// separate human promotion before any agent can fetch it.
// ---------------------------------------------------------------------------

interface PromoteBody {
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
    if (!user) return jsonError("Sign in to promote a finding.", 401);

    const raw = (await req.json().catch(() => null)) as PromoteBody | null;
    const workspaceId = raw && typeof raw.workspace_id === "string" ? raw.workspace_id : "";
    if (!workspaceId) return jsonError("workspace_id is required.", 400);

    // RLS proof-of-ownership, same pattern as /review.
    const { data: owned, error: ownedError } = await db.from("projects").select("id").eq("id", workspaceId).maybeSingle();
    if (ownedError) return jsonError("Could not verify workspace ownership.", 500);
    if (!owned) return jsonError("Workspace not found or not owned by this user.", 403);

    const { data: finding, error: findingError } = await db
      .from("findings")
      .select("id, workspace_id, title, observed_behavior, suggested_response, evidence_level, review_state, applicable_environment")
      .eq("id", findingId)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (findingError) return jsonError("Could not load the finding.", 500);
    if (!finding) return jsonError("Finding not found.", 404);
    const row = finding as {
      id: string;
      workspace_id: string;
      title: string;
      observed_behavior: string;
      suggested_response: string;
      evidence_level: string;
      review_state: string;
      applicable_environment: string;
    };
    if (row.review_state === "retired") {
      return jsonError("A retired finding cannot be used to draft a rule.", 409);
    }

    if (row.review_state === "observed") {
      const reviewResult = await reviewFinding(workspaceId, findingId, "available", user.id);
      if (!reviewResult.ok) return jsonError(reviewResult.error ?? "Could not mark the finding available.", 500);
    }

    const rule = await createRuleFromFinding({
      id: row.id,
      workspaceId: row.workspace_id,
      title: row.title,
      observedBehavior: row.observed_behavior,
      suggestedResponse: row.suggested_response,
      evidenceLevel: row.evidence_level,
      applicableEnvironment: row.applicable_environment,
    });

    return NextResponse.json({ ok: true, review_state: "available", rule });
  } catch (err) {
    if (err instanceof WorkspaceRulesError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    return handleAgentError(err);
  }
}
