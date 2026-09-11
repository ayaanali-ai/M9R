import { NextRequest, NextResponse } from "next/server";
import {
  updateWorkspaceRuleStatus,
  updateWorkspaceRuleText,
  markRuleHelped,
  markRuleNeedsReview,
  retireWorkspaceRule,
  softDeleteWorkspaceRule,
  WorkspaceRulesError,
} from "@/lib/workspace-rules-service";
import type { RuleStatus } from "@/lib/generated-rules";

// ---------------------------------------------------------------------------
// PATCH  /api/workspace-rules/[id] — edit rule text or limited review status.
// DELETE /api/workspace-rules/[id] — soft-delete a draft or archived rule from product views.
//   PATCH Body: { status? } | { title?, body? } | { helped: true }
// ---------------------------------------------------------------------------

const STATUSES: RuleStatus[] = ["needs_review", "low_confidence", "retired"];

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    let body: { status?: string; title?: string; body?: string; helped?: boolean };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    if (body.helped) {
      await markRuleHelped(id);
      return NextResponse.json({ ok: true });
    }
    if (typeof body.title === "string" || typeof body.body === "string") {
      const rule = await updateWorkspaceRuleText(id, { title: body.title, body: body.body });
      return NextResponse.json({ ok: true, rule });
    }
    if (typeof body.status === "string") {
      if (body.status === "active") {
        return NextResponse.json({ error: "Use the promote route to activate a rule." }, { status: 400 });
      }
      if (!STATUSES.includes(body.status as RuleStatus)) {
        return NextResponse.json({ error: "Invalid status." }, { status: 400 });
      }
      const rule =
        body.status === "needs_review"
          ? await markRuleNeedsReview(id)
          : body.status === "retired"
            ? await retireWorkspaceRule(id)
            : await updateWorkspaceRuleStatus(id, body.status as RuleStatus);
      return NextResponse.json({ ok: true, rule });
    }
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  } catch (err) {
    if (err instanceof WorkspaceRulesError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    console.error("Update workspace rule error:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const deleted = await softDeleteWorkspaceRule(id);
    return NextResponse.json({ ok: true, deleted });
  } catch (err) {
    if (err instanceof WorkspaceRulesError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    console.error("Delete workspace rule error:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}
