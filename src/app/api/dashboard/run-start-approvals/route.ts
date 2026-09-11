import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolveActiveOrDefaultProjectId } from "@/lib/projects-service";
import { supabase } from "@/lib/supabase";
import { decideApprovalRequest } from "@/lib/approval-requests";
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

interface PendingRunStartApproval {
  id: string;
  connectionId: string;
  riskClassification: string;
  sensitiveAreas: string[];
  requestMessageId: string | null;
  createdAt: string;
  expiresAt: string;
}

/**
 * GET lists every pending agent_run_start approval that has already announced
 * itself in the message feed (has a requestMessageId -- see attachApprovalRequestMessage
 * in run/start/route.ts). POST records the human's Approve/Reject click. This is
 * the inline-in-chat sibling of /api/dashboard/evidence-requests -- the Approval
 * Center drawer remains the other, older surface for the same underlying rows.
 */
export async function GET() {
  const ctx = await currentUserAndWorkspace();
  if (!ctx || !supabase) return NextResponse.json({ approvals: [] });
  try {
    const { data, error } = await supabase.from("approval_requests")
      .select("id, connection_id, risk_classification, request_summary, created_at, expires_at")
      .eq("workspace_id", ctx.workspaceId)
      .eq("status", "pending")
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: true })
      .limit(100);
    if (error) throw error;
    const approvals: PendingRunStartApproval[] = (data ?? [])
      .map((row) => ({
        id: String(row.id),
        connectionId: String(row.connection_id),
        riskClassification: String(row.risk_classification),
        requestMessageId: typeof (row.request_summary as Record<string, unknown> | null)?.requestMessageId === "string"
          ? (row.request_summary as Record<string, unknown>).requestMessageId as string
          : null,
        sensitiveAreas: Array.isArray((row.request_summary as Record<string, unknown> | null)?.sensitive_areas)
          ? ((row.request_summary as Record<string, unknown>).sensitive_areas as unknown[]).filter((v): v is string => typeof v === "string")
          : [],
        createdAt: String(row.created_at),
        expiresAt: String(row.expires_at),
      }))
      .filter((approval) => approval.requestMessageId !== null);
    return NextResponse.json({ approvals }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (isMissingOptionalTableError(error)) return NextResponse.json({ approvals: [], unavailable: true }, { headers: { "cache-control": "no-store" } });
    return NextResponse.json({ error: "Could not read pending run-start approvals." }, { status: 500 });
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
    const result = await decideApprovalRequest({ id, workspaceId: ctx.workspaceId, decision: body.approved ? "approved" : "rejected", decidedByUserId: ctx.userId });
    if (!result.ok) return NextResponse.json({ error: result.reason === "already_decided" ? "This request was already decided." : result.reason === "expired" ? "This request has expired." : "Could not record the decision." }, { status: 409 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof WorkspaceMembershipError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not record the decision." }, { status: 409 });
  }
}
