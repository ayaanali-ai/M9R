import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolveActiveOrDefaultProjectId } from "@/lib/projects-service";
import { listPendingPermissionsForWorkspace, decidePendingPermission } from "@/lib/bridge/bridge-permission-service";
import { requireApproverRole, WorkspaceMembershipError } from "@/lib/workspace-membership-service";

async function currentUserAndWorkspace(): Promise<{ userId: string; workspaceId: string } | null> {
  const db = await createClient();
  if (!db) return null;
  const { data: { user } } = await db.auth.getUser();
  if (!user) return null;
  let workspaceId: string;
  try {
    workspaceId = await resolveActiveOrDefaultProjectId(db, { id: user.id, email: user.email });
  } catch {
    return null;
  }
  return { userId: user.id, workspaceId };
}

/** GET lists every permission request a live agent session is waiting on you to answer. POST records your decision -- the only thing that unblocks the real, waiting session. */
export async function GET() {
  const ctx = await currentUserAndWorkspace();
  if (!ctx) return NextResponse.json({ permissions: [] });
  const permissions = await listPendingPermissionsForWorkspace(ctx.workspaceId);
  return NextResponse.json({ permissions }, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const ctx = await currentUserAndWorkspace();
  if (!ctx) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const id = typeof body.id === "string" ? body.id : "";
  const approved = body.approved === true;
  if (!id || typeof body.approved !== "boolean") return NextResponse.json({ error: "id and approved (boolean) are required." }, { status: 400 });
  try {
    await requireApproverRole(ctx.workspaceId, ctx.userId);
    await decidePendingPermission({ id, workspaceId: ctx.workspaceId, approved, decidedByUserId: ctx.userId });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof WorkspaceMembershipError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not record the decision." }, { status: 409 });
  }
}
