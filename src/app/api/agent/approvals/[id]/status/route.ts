import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { getApprovalRequest } from "@/lib/approval-requests";
import { handleAgentError } from "../../../_shared";

// GET /api/agent/approvals/[id]/status — bearer-authenticated, READ-ONLY.
// A bearer client polls its own approval request's status here. It can never
// approve or reject through this route (or any route besides the cookie-only
// /api/agent/approvals/[id]/decide) — no decision body is ever read here.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const token = bearerFrom(req.headers.get("authorization"));
    if (!token) {
      return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    }
    const agent = await authenticateAgent(token);
    if (!agent) {
      return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    }

    const { id } = await params;
    const request = await getApprovalRequest(id, agent.workspaceId);
    if (!request) {
      return NextResponse.json({ error: "Approval request not found." }, { status: 404 });
    }

    // Minimal fields only — never request_summary, decision_note, or
    // decided_by_user_id (the human decider's identity is not something to
    // leak back to the requesting agent).
    return NextResponse.json({
      approvalRequestId: request.id,
      status: request.status,
      dashboardPath: `/dashboard/approvals/${request.id}`,
      riskClassification: request.riskClassification,
      operationType: request.operationType,
    });
  } catch (err) {
    return handleAgentError(err);
  }
}
