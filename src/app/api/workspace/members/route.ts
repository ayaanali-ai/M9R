import { NextRequest, NextResponse } from "next/server";
import { resolveActiveOrDefaultProjectId } from "@/lib/projects-service";
import { createClient } from "@/lib/supabase/server";
import {
  listWorkspaceMembers,
  inviteToWorkspace,
  WorkspaceMembershipError,
} from "@/lib/workspace-membership-service";

// ---------------------------------------------------------------------------
// GET  /api/workspace/members — the active workspace's roster.
// POST /api/workspace/members — invite an email. Body: { email, role }
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

export async function GET() {
  try {
    const workspaceId = await activeWorkspaceId();
    if (!workspaceId) return NextResponse.json({ error: "Sign in to view members." }, { status: 401 });
    const members = await listWorkspaceMembers(workspaceId);
    return NextResponse.json({ ok: true, members });
  } catch (err) {
    return handle(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const workspaceId = await activeWorkspaceId();
    if (!workspaceId) return NextResponse.json({ error: "Sign in to invite members." }, { status: 401 });
    let body: { email?: string; role?: string };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    if (!body.email || (body.role !== "admin" && body.role !== "member")) {
      return NextResponse.json({ error: "email and role ('admin' | 'member') are required." }, { status: 400 });
    }
    const invite = await inviteToWorkspace(workspaceId, body.email, body.role);
    return NextResponse.json({ ok: true, invite });
  } catch (err) {
    return handle(err);
  }
}

function handle(err: unknown) {
  if (err instanceof WorkspaceMembershipError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
  }
  console.error("Workspace members error:", err instanceof Error ? err.message : err);
  return NextResponse.json({ error: "Internal server error." }, { status: 500 });
}
