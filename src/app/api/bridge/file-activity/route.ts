import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom } from "@/lib/agent-join-service";
import { recordWorkspaceFileActivity, listCurrentWorkspaceFileActivity } from "@/lib/bridge/workspace-file-activity-service";
import { handleAgentError } from "@/app/api/agent/_shared";

export const dynamic = "force-dynamic";

const ACTIVITY_KINDS = new Set(["read", "changed", "create", "delete"]);
const STATUSES = new Set(["started", "succeeded", "failed"]);

/**
 * POST /api/bridge/file-activity — the Bridge persists one real, verified
 * file-activity event (a real ACP tool-call, never self-reported chat text)
 * alongside its existing live relay push. Bearer-token only: an agent can
 * only write activity for its own workspace and its own connection.
 */
export async function POST(req: NextRequest) {
  try {
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const conversationId = typeof body.conversationId === "string" ? body.conversationId : "";
    const filePath = typeof body.filePath === "string" ? body.filePath : "";
    const activityKind = typeof body.activityKind === "string" ? body.activityKind : "";
    const status = typeof body.status === "string" ? body.status : "";
    if (!conversationId || !filePath || !ACTIVITY_KINDS.has(activityKind) || !STATUSES.has(status)) {
      return NextResponse.json({ error: "conversationId, filePath, a valid activityKind, and a valid status are required." }, { status: 400 });
    }
    const result = await recordWorkspaceFileActivity({
      workspaceId: agent.workspaceId,
      conversationId,
      connectionId: agent.connectionId,
      messageId: typeof body.messageId === "string" ? body.messageId : null,
      filePath,
      activityKind: activityKind as "read" | "changed" | "create" | "delete",
      status: status as "started" | "succeeded" | "failed",
      oldText: typeof body.oldText === "string" ? body.oldText : null,
      newText: typeof body.newText === "string" ? body.newText : null,
      diffPatch: typeof body.diffPatch === "string" ? body.diffPatch : null,
      additions: typeof body.additions === "number" ? body.additions : null,
      deletions: typeof body.deletions === "number" ? body.deletions : null,
    });
    return NextResponse.json({ ok: true, id: result.id }, { status: 201 });
  } catch (err) {
    return handleAgentError(err);
  }
}

/**
 * GET /api/bridge/file-activity?conversationId=... — every other connected
 * agent's current file activity in this channel, the read side of the
 * cross-agent "eyes" mechanism: called before a turn's prompt is built, and
 * by the dashboard's file-tree view. Never that agent's own activity --
 * callers filter their own connectionId out, since an agent doesn't need to
 * be told what it itself is doing.
 */
export async function GET(req: NextRequest) {
  try {
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    if (!agent) return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
    const conversationId = req.nextUrl.searchParams.get("conversationId");
    if (!conversationId) return NextResponse.json({ error: "conversationId is required." }, { status: 400 });
    const activity = await listCurrentWorkspaceFileActivity(conversationId);
    return NextResponse.json({ activity });
  } catch (err) {
    return handleAgentError(err);
  }
}
