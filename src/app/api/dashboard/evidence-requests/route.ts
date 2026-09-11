import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolveActiveOrDefaultProjectId } from "@/lib/projects-service";
import { listPendingChatEvidenceRequestsForWorkspace, decideChatEvidenceRequestById } from "@/lib/bridge/chat-evidence-service";
import { isMissingOptionalTableError } from "@/lib/dashboard-optional-fallback";
import { sendDashboardConversationMessage } from "@/lib/conversation-service";
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

/**
 * GET lists every "may I submit evidence?" request still waiting on a human
 * yes/no. POST records that decision. This is the stage-1 gate (chat_evidence_requests) --
 * distinct from /api/dashboard/evidence, which decides the actual submitted
 * evidence content (chat_evidence_submissions, stage 2). The Watchfloor message
 * feed polls this to know which message id needs an inline Approve/Reject card.
 */
export async function GET() {
  const ctx = await currentUserAndWorkspace();
  if (!ctx) return NextResponse.json({ requests: [] });
  try {
    const requests = await listPendingChatEvidenceRequestsForWorkspace(ctx.workspaceId);
    return NextResponse.json({ requests }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (isMissingOptionalTableError(error)) return NextResponse.json({ requests: [], unavailable: true }, { headers: { "cache-control": "no-store" } });
    return NextResponse.json({ error: "Could not read pending evidence requests." }, { status: 500 });
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
    const decided = await decideChatEvidenceRequestById({ id, workspaceId: ctx.workspaceId, approved: body.approved, decidedByUserId: ctx.userId });
    // Recording the decision alone never reaches the agent -- only a real chat
    // message flows through the bridge's workspace scan and resumes its turn
    // (this is how the older text-reply "yes"/"okay" path already worked).
    // Without this, the button looked like it worked (row flips to
    // approved/rejected) but the agent sat waiting forever for a message that
    // clicking a button never sends.
    await sendDashboardConversationMessage({
      conversationId: decided.conversationId,
      body: body.approved ? "Approved." : "Rejected.",
      parentMessageId: decided.requestMessageId,
    }).catch((sendError) => {
      console.warn(`Evidence decision ${id} recorded but the notifying chat message failed to send:`, sendError instanceof Error ? sendError.message : sendError);
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof WorkspaceMembershipError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not record the decision." }, { status: 409 });
  }
}
