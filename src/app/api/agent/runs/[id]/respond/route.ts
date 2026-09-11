import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { requireOwnRun, getAgentRunForUser } from "@/lib/agent-run-service";
import { deliverOperatorResponseToAgent, publishResponse } from "@/lib/response-service";
import { createClient } from "@/lib/supabase/server";
import { isResponseType, type ResponseType } from "@/lib/response";
import { handleAgentError } from "../../../_shared";

// ---------------------------------------------------------------------------
// POST /api/agent/runs/[id]/respond — publish a typed Response into a Run Room.
//
// Two trust paths, same as the rest of the Agent Dashboard:
//  - Bearer token (agent): can only respond within a run started by its own
//    connection (requireOwnRun).
//  - Cookie (signed-in human = Operator): can only respond within a run in a
//    workspace they own (getAgentRunForUser, RLS-scoped).
//
// This is a Run Room exchange, NOT the final review decision — that stays on
// POST /api/agent/runs/[id]/review (run-review-decision-service.ts). A run can
// have any number of Responses before its final human_review decision.
// ---------------------------------------------------------------------------

interface RespondBody {
  type?: unknown;
  body?: unknown;
  dispatch_id?: unknown;
  recipient?: unknown;
  scope?: unknown;
}

function jsonError(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: runId } = await params;
    const raw = (await req.json().catch(() => null)) as RespondBody | null;
    if (!raw) return jsonError("Invalid JSON body.", 400);

    if (!isResponseType(raw.type)) {
      return jsonError("type must be one of the recognized Response types.", 400);
    }
    const type = raw.type as ResponseType;
    const body = typeof raw.body === "string" ? raw.body : "";
    const dispatchId = typeof raw.dispatch_id === "string" ? raw.dispatch_id : null;
    const scope = Array.isArray(raw.scope) ? raw.scope.filter((s): s is string => typeof s === "string") : undefined;

    const token = bearerFrom(req.headers.get("authorization"));
    if (token) {
      const agent = await authenticateAgent(token);
      if (!agent) return jsonError("Invalid or missing agent token.", 401);
      const run = await requireOwnRun(agent, runId);

      const result = await publishResponse({
        workspaceId: run.workspace_id,
        runId,
        dispatchId,
        type,
        senderRole: "agent",
        sender: agent.agentKind ?? "agent",
        recipient: typeof raw.recipient === "string" && raw.recipient ? raw.recipient : "operator",
        body,
        scope,
      });
      if (!result.ok) return jsonError(result.errors.join(" ") || "Could not record the response.", 400);
      return NextResponse.json({ response_id: result.id });
    }

    // Operator (cookie) path.
    const run = await getAgentRunForUser(runId);
    if (!run) return jsonError("Run not found.", 404);
    if (!run.workspace_id) return jsonError("Run has no workspace.", 400);

    const auth = await createClient();
    const { data: { user } } = auth ? await auth.auth.getUser() : { data: { user: null } };
    if (!user) return jsonError("Sign in to respond to this run.", 401);

    const result = await publishResponse({
      workspaceId: run.workspace_id,
      runId,
      dispatchId,
      type,
      senderRole: "operator",
      sender: "operator",
      recipient: typeof raw.recipient === "string" && raw.recipient ? raw.recipient : (run.agent_kind ?? "agent"),
      body,
      scope,
    });
    if (!result.ok) return jsonError(result.errors.join(" ") || "Could not record the response.", 400);
    const delivery = result.id
      ? await deliverOperatorResponseToAgent({
        workspaceId: run.workspace_id,
        connectionId: run.connection_id,
        operatorUserId: user.id,
        runId,
        responseId: result.id,
        dispatchId,
        body,
      })
      : { status: "unavailable" as const, reason: "responses storage is unavailable" };
    return NextResponse.json({ response_id: result.id, delivery }, { status: delivery.status === "delivered" ? 200 : 202 });
  } catch (err) {
    return handleAgentError(err);
  }
}
