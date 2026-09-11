import { NextResponse } from "next/server";
import { resolveActiveOrDefaultProjectId } from "@/lib/projects-service";
import { createClient } from "@/lib/supabase/server";
import { listWorkspaceInvites, WorkspaceMembershipError } from "@/lib/workspace-membership-service";

// ---------------------------------------------------------------------------
// GET /api/workspace/invites — the active workspace's pending invites.
// ---------------------------------------------------------------------------

export async function GET() {
  try {
    const db = await createClient();
    if (!db) return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
    const {
      data: { user },
    } = await db.auth.getUser();
    if (!user) return NextResponse.json({ error: "Sign in to view invites." }, { status: 401 });
    const workspaceId = await resolveActiveOrDefaultProjectId(db, { id: user.id, email: user.email });
    const invites = await listWorkspaceInvites(workspaceId);
    return NextResponse.json({ ok: true, invites });
  } catch (err) {
    if (err instanceof WorkspaceMembershipError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    console.error("Workspace invites error:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}
