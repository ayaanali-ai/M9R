import { NextRequest, NextResponse } from "next/server";
import {
  listWorkspaceRules,
  promoteGeneratedRules,
  WorkspaceRulesError,
} from "@/lib/workspace-rules-service";
import type { GeneratedRule } from "@/lib/generated-rules";

// ---------------------------------------------------------------------------
// GET  /api/workspace-rules            — list the active workspace's rules.
// POST /api/workspace-rules            — promote generated rules into it.
//   Body: { rules: GeneratedRule[], sourceReportId?, sourceSessionName? }
// ---------------------------------------------------------------------------

export async function GET() {
  try {
    const rules = await listWorkspaceRules();
    return NextResponse.json({ ok: true, rules });
  } catch (err) {
    return handle(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    let body: { rules?: GeneratedRule[]; sourceReportId?: string | null; sourceSessionName?: string | null };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    if (!Array.isArray(body.rules) || body.rules.length === 0) {
      return NextResponse.json({ error: "No rules to promote." }, { status: 400 });
    }
    const result = await promoteGeneratedRules(body.rules, {
      sourceReportId: body.sourceReportId ?? null,
      sourceSessionName: body.sourceSessionName ?? null,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return handle(err);
  }
}

function handle(err: unknown) {
  if (err instanceof WorkspaceRulesError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
  }
  console.error("Workspace rules error:", err instanceof Error ? err.message : err);
  return NextResponse.json({ error: "Internal server error." }, { status: 500 });
}
