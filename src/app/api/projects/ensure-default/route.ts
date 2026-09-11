import { NextResponse } from "next/server";
import { ensureDefaultWorkspace, ProjectsServiceError } from "@/lib/projects-service";
import { PlanLimitError } from "@/lib/plan-limits-service";

// ---------------------------------------------------------------------------
// POST /api/projects/ensure-default — one-time repair for the signed-in user.
//
// Guarantees the user has a public.users row and at least one workspace,
// creating a "Default workspace" if needed. Safe to call repeatedly
// (idempotent). Backs the Settings "Ensure Default Workspace" button so users
// provisioned before the signup trigger was fixed can self-repair.
// ---------------------------------------------------------------------------

export async function POST() {
  try {
    const project = await ensureDefaultWorkspace();
    return NextResponse.json({ ok: true, project });
  } catch (err) {
    if (err instanceof PlanLimitError) {
      return NextResponse.json({ error: err.message, code: err.code, usage: err.usage }, { status: err.status });
    }
    if (err instanceof ProjectsServiceError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    console.error("Ensure default workspace error:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}
