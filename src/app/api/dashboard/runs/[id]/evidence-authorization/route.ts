import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolveActiveOrDefaultProjectId } from "@/lib/projects-service";
import {
  createOrGetPendingApprovalRequest,
  decideApprovalRequest,
  findApprovalRequestByIdempotencyKey,
  type ApprovalRequestRecord,
} from "@/lib/approval-requests";
import { createInstructionForDashboard } from "@/lib/agent-instruction-channel-service";
import { requireApproverRole, WorkspaceMembershipError } from "@/lib/workspace-membership-service";

/**
 * Run Detail's explicit first-stage evidence decision. This authorizes the
 * connected agent to prepare/submit evidence; it does not record evidence or
 * bypass the separate final evidence review.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const db = await createClient();
  if (!db) return NextResponse.json({ error: "M9R is not configured." }, { status: 503 });
  const { data: { user } } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in to authorize evidence." }, { status: 401 });

  const workspaceId = await resolveActiveOrDefaultProjectId(db, {
    id: user.id,
    email: user.email,
    name: (user.user_metadata?.name as string | undefined) ?? null,
  });
  try {
    await requireApproverRole(workspaceId, user.id);
  } catch (roleError) {
    if (roleError instanceof WorkspaceMembershipError) return NextResponse.json({ error: roleError.message }, { status: roleError.status });
    throw roleError;
  }

  const { id: runId } = await params;
  const { data: run, error } = await db
    .from("agent_runs")
    .select("id, workspace_id, connection_id, agent_kind, task_title, status")
    .eq("id", runId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) return NextResponse.json({ error: "Could not read the run." }, { status: 500 });
  if (!run) return NextResponse.json({ error: "Run not found." }, { status: 404 });
  if (!run.connection_id) return NextResponse.json({ error: "This run is not linked to an agent connection." }, { status: 409 });

  const requestInput = {
    workspaceId,
    connectionId: String(run.connection_id),
    operationType: "agent_evidence_submit",
    operationIdentity: String(run.id),
  };
  const existing = await findApprovalRequestByIdempotencyKey(requestInput);
  let approval: ApprovalRequestRecord;
  if (existing && existing.status === "approved" && Date.parse(existing.expiresAt) > Date.now()) {
    approval = existing;
  } else {
    const pending = await createOrGetPendingApprovalRequest({
      ...requestInput,
      riskClassification: "medium",
      requestSummary: {
        runId: String(run.id),
        agentKind: String(run.agent_kind ?? "other"),
        taskTitle: String(run.task_title ?? "Untitled run"),
        status: String(run.status ?? "unknown"),
        authorization: "Human authorized the agent to submit structured evidence; final recording remains a separate review decision.",
      },
    });
    const decided = await decideApprovalRequest({
      id: pending.id,
      workspaceId,
      decision: "approved",
      decidedByUserId: user.id,
      decisionNote: "Authorized from Run Detail.",
    });
    if (!decided.ok) return NextResponse.json({ error: `Evidence authorization could not be recorded: ${decided.reason}.` }, { status: 409 });
    approval = decided.request;
  }

  const instruction = await createInstructionForDashboard({
    connectionId: String(run.connection_id),
    instruction: `Evidence submission authorized for run ${run.id}. Prepare structured, redacted evidence for human review. Authorization request: ${approval.id}. Do not claim the evidence is recorded until the human approves the submitted record.`,
  });

  return NextResponse.json({
    ok: true,
    authorization: {
      id: approval.id,
      status: approval.status,
      runId: run.id,
      expiresAt: approval.expiresAt,
    },
    instruction: { id: instruction.id, status: instruction.status },
  });
}
