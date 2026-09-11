import { NextRequest, NextResponse } from "next/server";
import { MissionApiError } from "@/lib/mission/mission-application-errors";
import { createSupabaseMissionBridgeStore } from "@/lib/bridge/bridge-store";
import { handleMissionApiError, queryWorkspaceId, withMissionPrincipal } from "../../missions/_shared";

export const dynamic = "force-dynamic";

function boundedString(value: unknown, field: string, max: number): string {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || result.length > max) throw new MissionApiError(`${field} is required and bounded to ${max} characters.`, "validation_error", 400);
  return result;
}

// POST /api/bridge/dead-letters — persist bounded bridge diagnostics without
// copying the original user message body into an operator log.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const principal = await withMissionPrincipal(req, { requestedWorkspaceId: queryWorkspaceId(req) });
    const queuedAt = typeof body.queuedAt === "number" && Number.isFinite(body.queuedAt) && body.queuedAt > 0
      ? new Date(body.queuedAt).toISOString()
      : (() => { throw new MissionApiError("queuedAt must be a valid timestamp.", "validation_error", 400); })();
    const store = createSupabaseMissionBridgeStore();
    await store.recordDeadLetter({
      id: boundedString(body.id, "id", 512),
      workspaceId: principal.workspaceId,
      bridgeInstanceId: boundedString(body.bridgeInstanceId, "bridgeInstanceId", 256),
      sessionId: boundedString(body.sessionId, "sessionId", 256),
      conversationId: boundedString(body.conversationId, "conversationId", 256),
      messageId: boundedString(body.messageId, "messageId", 256),
      topic: boundedString(body.topic, "topic", 512),
      reason: boundedString(body.reason, "reason", 128),
      detail: boundedString(body.detail, "detail", 1_000),
      queuedAt,
      createdAt: new Date().toISOString(),
    });
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (err) {
    return handleMissionApiError(err);
  }
}
