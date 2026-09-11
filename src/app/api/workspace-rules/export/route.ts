import { NextRequest, NextResponse } from "next/server";
import { exportWorkspaceRules, WorkspaceRulesError } from "@/lib/workspace-rules-service";
import type { RulesFileFormat } from "@/lib/rules-file-generator";

// ---------------------------------------------------------------------------
// POST /api/workspace-rules/export — export the active workspace rules.
//   Body: { format: "agents"|"claude"|"cursor"|"plain",
//           workspaceName?, includeNeedsReview? }
//   Returns: { ok, filename, content }
// ---------------------------------------------------------------------------

const FORMATS: RulesFileFormat[] = ["agents", "claude", "cursor", "plain"];

export async function POST(req: NextRequest) {
  try {
    let body: { format?: string; workspaceName?: string | null; includeNeedsReview?: boolean };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    const format = body.format as RulesFileFormat;
    if (!FORMATS.includes(format)) {
      return NextResponse.json({ error: "Invalid export format." }, { status: 400 });
    }
    const file = await exportWorkspaceRules(format, {
      workspaceName: body.workspaceName ?? null,
      includeNeedsReview: Boolean(body.includeNeedsReview),
    });
    return NextResponse.json({ ok: true, filename: file.filename, content: file.content });
  } catch (err) {
    if (err instanceof WorkspaceRulesError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    console.error("Export workspace rules error:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}
