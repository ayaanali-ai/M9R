import { NextRequest, NextResponse } from "next/server";
import { recordMissionGitOperationResult } from "@/lib/mission/mission-application-service";
import { MissionApiError } from "@/lib/mission/mission-application-errors";
import { handleMissionApiError, queryWorkspaceId, withMissionPrincipal } from "../../../_shared";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ missionId: string }> }) {
  try {
    const { missionId } = await params;
    const principal = await withMissionPrincipal(req, { requestedWorkspaceId: queryWorkspaceId(req) });
    const body = await req.json().catch(() => ({}));
    if (typeof body.operationId !== "string" || typeof body.candidateDigest !== "string" || (body.outcome !== "succeeded" && body.outcome !== "failed") || typeof body.summary !== "string") {
      throw new MissionApiError("operationId, candidateDigest, outcome, and summary are required.", "validation_error", 400);
    }
    const result = await recordMissionGitOperationResult(principal, missionId, {
      operationId: body.operationId,
      candidateDigest: body.candidateDigest,
      outcome: body.outcome,
      providerRef: body.providerRef == null ? null : String(body.providerRef),
      summary: body.summary,
    });
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    return handleMissionApiError(error);
  }
}
