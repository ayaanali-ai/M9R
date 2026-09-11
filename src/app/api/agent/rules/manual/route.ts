import { NextResponse } from "next/server";

import { createManualWorkspaceRule, WorkspaceRulesError } from "@/lib/workspace-rules-service";

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const result = await createManualWorkspaceRule({
      title: typeof body.title === "string" ? body.title : "",
      body: typeof body.body === "string" ? body.body : "",
      workspaceId: typeof body.workspace_id === "string" ? body.workspace_id : undefined,
      riskLevel: typeof body.risk_level === "string" ? body.risk_level : null,
      pathPatterns: Array.isArray(body.path_patterns) || typeof body.path_patterns === "string" ? (body.path_patterns as string[] | string) : null,
    });
    return NextResponse.json({ ok: true, rule: result.rule, redaction: result.redaction });
  } catch (err) {
    if (err instanceof WorkspaceRulesError) {
      return NextResponse.json({ ok: false, error: err.message, code: err.code }, { status: err.status });
    }
    console.error("manual rule creation failed:", err);
    return NextResponse.json({ ok: false, error: "Failed to create manual rule draft." }, { status: 500 });
  }
}
