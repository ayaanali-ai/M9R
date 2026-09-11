import { NextRequest, NextResponse } from "next/server";
import { registerMissionGitSigningIdentity, getMissionGitSigningIdentities } from "@/lib/mission/mission-application-service";
import { MissionApiError } from "@/lib/mission/mission-application-errors";
import { handleMissionApiError, queryWorkspaceId, withMissionPrincipal } from "../../../_shared";

export const dynamic = "force-dynamic";

// GET /api/missions/:missionId/git/signing-key — registered participant commit-signing identities.
export async function GET(req: NextRequest, { params }: { params: Promise<{ missionId: string }> }) {
  try {
    const { missionId } = await params;
    const principal = await withMissionPrincipal(req, { requestedWorkspaceId: queryWorkspaceId(req) });
    const identities = await getMissionGitSigningIdentities(principal, missionId);
    return NextResponse.json({ identities });
  } catch (err) {
    return handleMissionApiError(err);
  }
}

// POST /api/missions/:missionId/git/signing-key — Bridge registers its own participant's PUBLIC key only.
export async function POST(req: NextRequest, { params }: { params: Promise<{ missionId: string }> }) {
  try {
    const { missionId } = await params;
    const principal = await withMissionPrincipal(req, { requestedWorkspaceId: queryWorkspaceId(req) });
    const body = await req.json().catch(() => ({}));
    if (typeof body.participantId !== "string" || typeof body.publicKey !== "string" || typeof body.fingerprint !== "string") {
      throw new MissionApiError("participantId, publicKey, and fingerprint are required.", "validation_error", 400);
    }
    const identity = await registerMissionGitSigningIdentity(principal, missionId, { participantId: body.participantId, publicKey: body.publicKey, fingerprint: body.fingerprint });
    return NextResponse.json({ identity }, { status: 201 });
  } catch (err) {
    return handleMissionApiError(err);
  }
}
