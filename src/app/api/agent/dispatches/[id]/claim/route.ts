import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { claimBoundedRequest } from "@/lib/bounded-assistance-service";
import { publishDispatch } from "@/lib/dispatch-service";
import { publishResponse } from "@/lib/response-service";
import { handleAgentError } from "../../../_shared";

// ---------------------------------------------------------------------------
// POST /api/agent/dispatches/[id]/claim — accept an open HELP_REQUESTED /
// CHECK_REQUESTED Dispatch and create the Linked (supporting) Run.
//
// Bearer-authenticated. Atomic claim (bounded-assistance-service.ts) — a
// second concurrent claim attempt on the same Dispatch is told it was already
// claimed, never silently double-accepted.
// ---------------------------------------------------------------------------

interface ClaimBody {
  task_title?: unknown;
}

function jsonError(error: string, status: number, extra: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json({ error, ...extra }, { status });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: dispatchId } = await params;
    const token = bearerFrom(req.headers.get("authorization"));
    if (!token) return jsonError("Bearer token required.", 401);
    const claimant = await authenticateAgent(token);
    if (!claimant) return jsonError("Invalid or missing agent token.", 401);

    const raw = (await req.json().catch(() => ({}))) as ClaimBody;
    const taskTitle = typeof raw.task_title === "string" ? raw.task_title : null;

    const result = await claimBoundedRequest(claimant, dispatchId, taskTitle);
    if (!result.ok) {
      return jsonError(result.error ?? "Could not claim this request.", result.alreadyClaimed ? 409 : 400, {
        already_claimed: Boolean(result.alreadyClaimed),
      });
    }

    await publishDispatch({
      workspaceId: claimant.workspaceId,
      runId: result.linkedRunId!,
      type: "RUN_STARTED",
      sender: claimant.agentKind ?? "agent",
      summary: taskTitle ? `task: ${taskTitle}` : "linked run started",
    });
    await publishResponse({
      workspaceId: claimant.workspaceId,
      runId: result.linkedRunId!,
      dispatchId,
      type: "acceptance",
      senderRole: "agent",
      sender: claimant.agentKind ?? "agent",
      recipient: "operator",
      body: `Accepted. Linked run ${result.linkedRunId} started.`,
    });

    return NextResponse.json({ linked_run_id: result.linkedRunId });
  } catch (err) {
    return handleAgentError(err);
  }
}
