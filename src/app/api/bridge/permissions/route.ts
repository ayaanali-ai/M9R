import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { reportPendingPermission, attachPermissionMessage, listDecidedPermissionsForExecution, markPermissionConsumed } from "@/lib/bridge/bridge-permission-service";
import { findOrCreateAgentDmForBearer, sendConversationMessage } from "@/lib/conversation-service";
import { findCurrentRunIdForConnection } from "@/lib/agent-run-service";
import { handleAgentError } from "@/app/api/agent/_shared";

export const dynamic = "force-dynamic";

/**
 * POST /api/bridge/permissions — the Bridge reports a new pending
 * permission request the moment a live ACP session asks for one.
 * GET  /api/bridge/permissions?executionId=... — the Bridge polls for a
 * decision on requests belonging to one of its own sessions, then must call
 * DELETE (markPermissionConsumed via ?id=) once it has actually delivered
 * the decision to the waiting session -- so a decision is never silently
 * lost to a Bridge restart mid-delivery, and never delivered twice.
 * Bearer-token only: an agent can only report/poll for its own workspace.
 */
export async function POST(req: NextRequest) {
  try {
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const missionId = typeof body.missionId === "string" ? body.missionId : "";
    const executionId = typeof body.executionId === "string" ? body.executionId : "";
    const requestId = typeof body.requestId === "string" ? body.requestId : "";
    const summary = typeof body.summary === "string" ? body.summary : "";
    if (!missionId || !executionId || !requestId || !summary) {
      return NextResponse.json({ error: "missionId, executionId, requestId, and summary are required." }, { status: 400 });
    }
    const report = await reportPendingPermission({
      workspaceId: agent.workspaceId,
      missionId,
      executionId,
      requestId,
      summary,
      command: typeof body.command === "string" ? body.command : null,
      filePath: typeof body.filePath === "string" ? body.filePath : null,
    });
    // Only the call that actually created the row announces it -- a retried
    // report of the same request must never post a second chat message.
    if (report.created) {
      try {
        // Route the notice to whichever channel actually triggered this
        // request when the bridge could tell us (see
        // conversationIdForChannelMission's own comment in
        // acp-stdio-adapter.ts) -- falling back to this agent's own fixed
        // DM only for a real Mission-based session with no dashboard
        // channel equivalent. sendConversationMessage's own
        // requireParticipant check below is what actually enforces this
        // agent may post here; a bogus/foreign conversationId is rejected
        // there, not trusted here.
        const requestedConversationId = typeof body.conversationId === "string" ? body.conversationId : null;
        const conversationId = requestedConversationId ?? await findOrCreateAgentDmForBearer(agent);
        const message = await sendConversationMessage(agent, {
          conversationId,
          recipientConnectionId: null,
          kind: "notice",
          body: `Requesting permission: ${summary}`,
          parentMessageId: null,
          idempotencyKey: `permission-request-message:${report.id}`,
          relatedRunId: await findCurrentRunIdForConnection(agent.workspaceId, agent.connectionId).catch(() => null),
        });
        await attachPermissionMessage(report.id, agent.workspaceId, message.id);
      } catch {
        // The top-of-page permissions panel remains the source of truth;
        // the inline chat card is additive and must never block the ACP
        // session's own permission wait.
      }
    }
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (err) {
    return handleAgentError(err);
  }
}

export async function GET(req: NextRequest) {
  try {
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    const executionId = req.nextUrl.searchParams.get("executionId");
    if (!executionId) return NextResponse.json({ error: "executionId is required." }, { status: 400 });
    const decisions = await listDecidedPermissionsForExecution(agent.workspaceId, executionId);
    return NextResponse.json({ decisions });
  } catch (err) {
    return handleAgentError(err);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    const id = req.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id is required." }, { status: 400 });
    await markPermissionConsumed(agent.workspaceId, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleAgentError(err);
  }
}
