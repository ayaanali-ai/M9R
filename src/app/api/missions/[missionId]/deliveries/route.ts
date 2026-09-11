import { NextRequest, NextResponse } from "next/server";
import {
  acknowledgeMissionMessageDelivery,
  getMissionMessageDeliveries,
} from "@/lib/mission/mission-application-service";
import { handleMissionApiError, queryWorkspaceId, withMissionPrincipal } from "../../_shared";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ missionId: string }> }) {
  try {
    const { missionId } = await params;
    const principal = await withMissionPrincipal(req, { requestedWorkspaceId: queryWorkspaceId(req) });
    const limit = Number(req.nextUrl.searchParams.get("limit") ?? "100");
    const recipientParticipantId = req.nextUrl.searchParams.get("recipientParticipantId");
    const result = await getMissionMessageDeliveries(principal, missionId, {
      limit: Number.isFinite(limit) ? limit : 100,
      recipientParticipantId,
    });
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return handleMissionApiError(err);
  }
}

/** A human dashboard may acknowledge a delivery while inspecting the record. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ missionId: string }> }) {
  try {
    const { missionId } = await params;
    const principal = await withMissionPrincipal(req, { requestedWorkspaceId: queryWorkspaceId(req) });
    const body = await req.json().catch(() => ({})) as { deliveryId?: unknown };
    if (typeof body.deliveryId !== "string" || !body.deliveryId.trim()) {
      return NextResponse.json({ error: "deliveryId is required.", code: "validation_error" }, { status: 400 });
    }
    const delivery = await acknowledgeMissionMessageDelivery(principal, missionId, body.deliveryId);
    return NextResponse.json({ delivery });
  } catch (err) {
    return handleMissionApiError(err);
  }
}
