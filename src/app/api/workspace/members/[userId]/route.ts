import { NextRequest, NextResponse } from "next/server";
import { resolveActiveOrDefaultProjectId } from "@/lib/projects-service";
import { createClient } from "@/lib/supabase/server";
import {
  setWorkspaceMemberRole,
  removeWorkspaceMember,
  WorkspaceMembershipError,
} from "@/lib/workspace-membership-service";

// ---------------------------------------------------------------------------
// PATCH  /api/workspace/members/[userId] — change role. Body: { role }
// DELETE /api/workspace/members/[userId] — remove a member (owner/admin only)
// ---------------------------------------------------------------------------

async function activeWorkspaceId(): Promise<string | null> {
  const db = await createClient();
  if (!db) return null;
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return null;
  return resolveActiveOrDefaultProjectId(db, { id: user.id, email: user.email });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  try {
    const { userId } = await params;
    const workspaceId = await activeWorkspaceId();
    if (!workspaceId) return NextResponse.json({ error: "Sign in to manage members." }, { status: 401 });
    let body: { role?: string };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    if (body.role !== "admin" && body.role !== "member") {
      return NextResponse.json({ error: "role must be 'admin' or 'member'." }, { status: 400 });
    }
    await setWorkspaceMemberRole(workspaceId, userId, body.role);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handle(err);
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  try {
    const { userId } = await params;
    const workspaceId = await activeWorkspaceId();
    if (!workspaceId) return NextResponse.json({ error: "Sign in to manage members." }, { status: 401 });
    await removeWorkspaceMember(workspaceId, userId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handle(err);
  }
}

function handle(err: unknown) {
  if (err instanceof WorkspaceMembershipError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
  }
  console.error("Workspace member error:", err instanceof Error ? err.message : err);
  return NextResponse.json({ error: "Internal server error." }, { status: 500 });
}
