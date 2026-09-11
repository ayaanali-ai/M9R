import { NextResponse } from "next/server";
import { resolveActiveOrDefaultProjectId } from "@/lib/projects-service";
import { createClient } from "@/lib/supabase/server";
import { leaveWorkspace, WorkspaceMembershipError } from "@/lib/workspace-membership-service";

// ---------------------------------------------------------------------------
// POST /api/workspace/leave — the signed-in user leaves the active workspace.
// Never the owner: the owner cannot leave their own workspace.
// ---------------------------------------------------------------------------

export async function POST() {
  try {
    const db = await createClient();
    if (!db) return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
    const {
      data: { user },
    } = await db.auth.getUser();
    if (!user) return NextResponse.json({ error: "Sign in to leave a workspace." }, { status: 401 });
    const workspaceId = await resolveActiveOrDefaultProjectId(db, { id: user.id, email: user.email });
    await leaveWorkspace(workspaceId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof WorkspaceMembershipError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    console.error("Workspace leave error:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}
