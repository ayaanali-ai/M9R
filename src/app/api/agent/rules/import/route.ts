import { NextResponse } from "next/server";

import { importWorkspaceRuleDrafts, WorkspaceRulesError } from "@/lib/workspace-rules-service";

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const result = await importWorkspaceRuleDrafts({
      text: typeof body.text === "string" ? body.text : "",
      workspaceId: typeof body.workspace_id === "string" ? body.workspace_id : undefined,
      sourceLabel: typeof body.source_label === "string" ? body.source_label : null,
      riskLevel: typeof body.risk_level === "string" ? body.risk_level : null,
      pathPatterns: Array.isArray(body.path_patterns) || typeof body.path_patterns === "string" ? (body.path_patterns as string[] | string) : null,
    });
    return NextResponse.json({ ok: true, created: result.created, rules: result.rules, redaction: result.redaction });
  } catch (err) {
    if (err instanceof WorkspaceRulesError) {
      return NextResponse.json({ ok: false, error: err.message, code: err.code }, { status: err.status });
    }
    console.error("rule import failed:", err);
    return NextResponse.json({ ok: false, error: "Failed to import rule drafts." }, { status: 500 });
  }
}
