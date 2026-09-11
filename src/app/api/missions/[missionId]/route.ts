import { NextRequest, NextResponse } from "next/server";
import { getMission } from "@/lib/mission/mission-application-service";
import { handleMissionApiError, queryWorkspaceId, withMissionPrincipal } from "../_shared";

export const dynamic = "force-dynamic";

// GET /api/missions/:missionId — Mission detail (bounded, redacted summary).
export async function GET(req: NextRequest, { params }: { params: Promise<{ missionId: string }> }) {
  try {
    const { missionId } = await params;
    const principal = await withMissionPrincipal(req, { requestedWorkspaceId: queryWorkspaceId(req) });
    const mission = await getMission(principal, missionId);
    return NextResponse.json({ mission });
  } catch (err) {
    return handleMissionApiError(err);
  }
}
