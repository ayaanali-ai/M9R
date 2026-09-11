import { NextRequest, NextResponse } from "next/server";
import { MissionApiError } from "@/lib/mission/mission-application-errors";
import { BRIDGE_PROTOCOL_VERSION, validateBridgeHeartbeat } from "@/lib/bridge/bridge-protocol";
import { createSupabaseMissionBridgeStore } from "@/lib/bridge/bridge-store";
import { handleMissionApiError, queryWorkspaceId, withMissionPrincipal } from "../../missions/_shared";

export const dynamic = "force-dynamic";

// POST /api/bridge/heartbeat — refresh Bridge and session liveness with a
// bounded, versioned heartbeat envelope.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    if (!validateBridgeHeartbeat(body)) throw new MissionApiError("Invalid Bridge heartbeat.", "validation_error", 400);
    const principal = await withMissionPrincipal(req, { requestedWorkspaceId: queryWorkspaceId(req) });
    if (body.protocolVersion !== BRIDGE_PROTOCOL_VERSION) throw new MissionApiError("Unsupported Bridge protocol version.", "validation_error", 400);
    const store = createSupabaseMissionBridgeStore();
    const instance = await store.heartbeatInstance({ id: body.bridgeInstanceId, workspaceId: principal.workspaceId, now: new Date().toISOString() });
    if (!instance) throw new MissionApiError("Bridge instance was not found.", "mission_not_found", 404);
    const touchedSessions = await store.touchSessions({ bridgeInstanceId: body.bridgeInstanceId, workspaceId: principal.workspaceId, sessionIds: body.activeSessionIds.slice(0, 8), now: new Date().toISOString() });
    return NextResponse.json({ bridgeInstanceId: instance.id, lastHeartbeatAt: instance.lastHeartbeatAt, touchedSessions });
  } catch (err) {
    return handleMissionApiError(err);
  }
}
