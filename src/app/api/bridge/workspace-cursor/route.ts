import { NextRequest, NextResponse } from "next/server";
import { MissionApiError } from "@/lib/mission/mission-application-errors";
import { createSupabaseMissionBridgeStore } from "@/lib/bridge/bridge-store";
import { decodeWorkspaceCursor } from "@/lib/mission/workspace-cursor";
import { handleMissionApiError, queryWorkspaceId, withMissionPrincipal } from "../../missions/_shared";

export const dynamic = "force-dynamic";

function requiredString(value: unknown, field: string, max = 256): string {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || result.length > max) throw new MissionApiError(field + " is required and bounded.", "validation_error", 400);
  return result;
}

export async function GET(req: NextRequest) {
  try {
    const principal = await withMissionPrincipal(req, { requestedWorkspaceId: queryWorkspaceId(req) });
    const bridgeInstanceId = requiredString(req.nextUrl.searchParams.get("bridgeInstanceId"), "bridgeInstanceId");
    const conversationId = requiredString(req.nextUrl.searchParams.get("conversationId"), "conversationId");
    const store = createSupabaseMissionBridgeStore();
    const cursor = await store.getWorkspaceCursor({
      workspaceId: principal.workspaceId,
      bridgeInstanceId,
      ownerId: principal.actor.id,
      conversationId,
    });
    return NextResponse.json({ cursor });
  } catch (error) {
    return handleMissionApiError(error);
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const principal = await withMissionPrincipal(req, { requestedWorkspaceId: queryWorkspaceId(req) });
    const bridgeInstanceId = requiredString(body.bridgeInstanceId, "bridgeInstanceId");
    const conversationId = requiredString(body.conversationId, "conversationId");
    const cursor = decodeWorkspaceCursor(typeof body.cursor === "string" ? body.cursor : null);
    if (!cursor?.messageId) throw new MissionApiError("cursor must be a Phase 1 workspace cursor.", "validation_error", 400);
    const store = createSupabaseMissionBridgeStore();
    const saved = await store.saveWorkspaceCursor({
      workspaceId: principal.workspaceId,
      bridgeInstanceId,
      ownerId: principal.actor.id,
      conversationId,
      cursorCreatedAt: cursor.createdAt,
      cursorMessageId: cursor.messageId,
      now: new Date().toISOString(),
    });
    return NextResponse.json({ cursor: saved });
  } catch (error) {
    return handleMissionApiError(error);
  }
}
