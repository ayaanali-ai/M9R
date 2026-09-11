import { NextRequest, NextResponse } from "next/server";
import {
  getMissionConversation,
  postMissionMessage,
} from "@/lib/mission/mission-application-service";
import { handleMissionApiError, queryWorkspaceId, withMissionPrincipal } from "../../_shared";

export const dynamic = "force-dynamic";

/**
 * The Mission conversation is a durable, tenant-scoped channel.  It is kept
 * separate from the provider relay: the relay is a delivery transport, while
 * this endpoint is the authoritative record that the dashboard can reload.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ missionId: string }> }) {
  try {
    const { missionId } = await params;
    const principal = await withMissionPrincipal(req, { requestedWorkspaceId: queryWorkspaceId(req) });
    const limit = Number(req.nextUrl.searchParams.get("limit") ?? "100");
    const cursor = req.nextUrl.searchParams.get("cursor");
    const conversation = await getMissionConversation(principal, missionId, {
      limit: Number.isFinite(limit) ? limit : 100,
      cursor,
    });
    return NextResponse.json({ conversation });
  } catch (err) {
    return handleMissionApiError(err);
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ missionId: string }> }) {
  try {
    const { missionId } = await params;
    const principal = await withMissionPrincipal(req, { requestedWorkspaceId: queryWorkspaceId(req) });
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const message = await postMissionMessage(principal, missionId, {
      messageId: typeof body.messageId === "string" ? body.messageId : null,
      senderParticipantId: typeof body.senderParticipantId === "string" ? body.senderParticipantId : "",
      recipientParticipantIds: body.recipientParticipantIds === "mission_broadcast"
        ? "mission_broadcast"
        : Array.isArray(body.recipientParticipantIds)
          ? body.recipientParticipantIds.filter((id): id is string => typeof id === "string")
          : [],
      assignmentId: typeof body.assignmentId === "string" ? body.assignmentId : null,
      messageType: typeof body.messageType === "string" ? body.messageType : "information",
      body: typeof body.body === "string" ? body.body : "",
      evidenceRefs: Array.isArray(body.evidenceRefs)
        ? body.evidenceRefs.filter((ref): ref is string => typeof ref === "string")
        : [],
      replyToMessageId: typeof body.replyToMessageId === "string" ? body.replyToMessageId : null,
      structuredPayload: body.structuredPayload && typeof body.structuredPayload === "object" && !Array.isArray(body.structuredPayload)
        ? body.structuredPayload as Record<string, unknown>
        : {},
      clientRequestId: typeof body.clientRequestId === "string"
        ? body.clientRequestId
        : req.headers.get("idempotency-key"),
    });
    return NextResponse.json(message, { status: 201 });
  } catch (err) {
    return handleMissionApiError(err);
  }
}
