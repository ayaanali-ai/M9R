import { NextRequest, NextResponse } from "next/server";
import { resolveActiveOrDefaultProjectId } from "@/lib/projects-service";
import { createClient } from "@/lib/supabase/server";
import { revokeWorkspaceInvite, WorkspaceMembershipError } from "@/lib/workspace-membership-service";

// ---------------------------------------------------------------------------
// DELETE /api/workspace/invites/[id] — revoke a pending invite.
// ---------------------------------------------------------------------------

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const db = await createClient();
    if (!db) return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
    const {
      data: { user },
    } = await db.auth.getUser();
    if (!user) return NextResponse.json({ error: "Sign in to manage invites." }, { status: 401 });
    const workspaceId = await resolveActiveOrDefaultProjectId(db, { id: user.id, email: user.email });
    await revokeWorkspaceInvite(workspaceId, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof WorkspaceMembershipError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    console.error("Workspace invite revoke error:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}
