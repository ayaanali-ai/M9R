import { NextRequest, NextResponse } from "next/server";
import {
  promoteWorkspaceRule,
  promoteWorkspaceRuleForAgentConnection,
  WorkspaceRulesError,
} from "@/lib/workspace-rules-service";
import { PlanLimitError } from "@/lib/plan-limits-service";

// ---------------------------------------------------------------------------
// POST /api/agent/rules/promote — promote a recommended rule to active.
//
// Cookie-authenticated (the signed-in human). Flips a recommended (needs_review)
// workspace rule to `active`, which makes it appear in `npx m9r-cli rules` on
// the next run. This is the human-action gate: OathLock never auto-promotes.
// RLS in the promote helper scopes the rule to a workspace the user owns.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const ruleId = typeof body.rule_id === "string" ? body.rule_id.trim() : "";
    if (!ruleId) {
      return NextResponse.json({ error: "rule_id is required." }, { status: 400 });
    }

    const targetConnectionId = typeof body.target_connection_id === "string" ? body.target_connection_id.trim() : "";
    const rule = targetConnectionId
      ? await promoteWorkspaceRuleForAgentConnection(ruleId, targetConnectionId)
      : await promoteWorkspaceRule(ruleId);
    return NextResponse.json({ ok: true, rule });
  } catch (err) {
    if (err instanceof WorkspaceRulesError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    if (err instanceof PlanLimitError) {
      return NextResponse.json({ error: err.message, code: err.code, usage: err.usage }, { status: err.status });
    }
    console.error("promote route error:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}
