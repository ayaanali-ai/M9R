import { NextRequest, NextResponse } from "next/server";
import { MissionApiError } from "@/lib/mission/mission-application-errors";
import { createSupabaseMissionBridgeStore } from "@/lib/bridge/bridge-store";
import { BRIDGE_SESSION_STATES, type BridgeSessionState } from "@/lib/bridge/bridge-session-registry";
import { BRIDGE_PROTOCOL_VERSION } from "@/lib/bridge/bridge-protocol";
import { handleMissionApiError, queryWorkspaceId, withMissionPrincipal } from "../../../missions/_shared";

export const dynamic = "force-dynamic";

// POST /api/bridge/session/transition — persist only valid Bridge session
// lifecycle transitions; provider processes cannot skip lifecycle gates.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const principal = await withMissionPrincipal(req, { requestedWorkspaceId: queryWorkspaceId(req) });
    if (body.protocolVersion !== BRIDGE_PROTOCOL_VERSION) throw new MissionApiError("Unsupported Bridge protocol version.", "validation_error", 400);
    if (typeof body.sessionId !== "string" || typeof body.bridgeInstanceId !== "string" || !BRIDGE_SESSION_STATES.includes(body.nextState)) {
      throw new MissionApiError("sessionId, bridgeInstanceId, and a valid nextState are required.", "validation_error", 400);
    }
    const store = createSupabaseMissionBridgeStore();
    const session = await store.transitionSession({
      sessionId: body.sessionId,
      bridgeInstanceId: body.bridgeInstanceId,
      workspaceId: principal.workspaceId,
      nextState: body.nextState as BridgeSessionState,
      now: new Date().toISOString(),
    });
    if (!session) throw new MissionApiError("Bridge session was not found or the transition is not allowed.", "conflict", 409);
    return NextResponse.json({ session });
  } catch (err) {
    return handleMissionApiError(err);
  }
}
