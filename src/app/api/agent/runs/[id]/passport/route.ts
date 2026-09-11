import { NextResponse } from "next/server";
import { loadRunPassportForUser } from "@/lib/run-passport-loader";
import { handleAgentError } from "../../../_shared";

// ---------------------------------------------------------------------------
// GET /api/agent/runs/[id]/passport - read-only dashboard passport for one run.
//
// Cookie-authenticated. All reads happen in run-passport-loader through the
// signed-in user's RLS scope. The loader never reads raw session content and
// never returns rule bodies.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const loaded = await loadRunPassportForUser(id);
    if (!loaded) return NextResponse.json({ error: "Run not found." }, { status: 404 });

    return NextResponse.json({ ok: true, passport: loaded.passport });
  } catch (err) {
    return handleAgentError(err);
  }
}
