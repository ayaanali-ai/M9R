import { NextResponse } from "next/server";
import { archiveWorkspaceRule, WorkspaceRulesError } from "@/lib/workspace-rules-service";
import { publicErrorMessage } from "@/lib/public-error";

// POST /api/workspace-rules/[id]/archive - deactivate an active rule.

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const rule = await archiveWorkspaceRule(id);
    return NextResponse.json({ ok: true, rule });
  } catch (err) {
    if (err instanceof WorkspaceRulesError) {
      return NextResponse.json({ error: publicErrorMessage(err.message, err.status), code: err.code }, { status: err.status });
    }
    console.error("Archive workspace rule error:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}
