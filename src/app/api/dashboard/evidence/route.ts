import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolveActiveOrDefaultProjectId } from "@/lib/projects-service";
import { listPendingChatEvidenceForWorkspace, decideChatEvidence } from "@/lib/bridge/chat-evidence-service";
import { isMissingOptionalTableError } from "@/lib/dashboard-optional-fallback";
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

/** GET lists every agent-submitted evidence summary still waiting on a human decision. POST records that decision. */
export async function GET() {
  const ctx = await currentUserAndWorkspace();
  if (!ctx) return NextResponse.json({ submissions: [] });
  try {
    const submissions = await listPendingChatEvidenceForWorkspace(ctx.workspaceId);
    return NextResponse.json({ submissions }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (isMissingOptionalTableError(error)) return NextResponse.json({ submissions: [], unavailable: true }, { headers: { "cache-control": "no-store" } });
    return NextResponse.json({ error: "Could not read pending evidence." }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const ctx = await currentUserAndWorkspace();
  if (!ctx) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const id = typeof body.id === "string" ? body.id : "";
  if (!id || typeof body.approved !== "boolean") return NextResponse.json({ error: "id and approved (boolean) are required." }, { status: 400 });
  try {
    await requireApproverRole(ctx.workspaceId, ctx.userId);
    await decideChatEvidence({ id, workspaceId: ctx.workspaceId, approved: body.approved, decidedByUserId: ctx.userId });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof WorkspaceMembershipError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not record the decision." }, { status: 409 });
  }
}
