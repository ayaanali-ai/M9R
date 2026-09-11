import { NextRequest, NextResponse } from "next/server";
import { getMissionEvidence, recordMissionEvidence } from "@/lib/mission/mission-application-service";
import { MissionApiError } from "@/lib/mission/mission-application-errors";
import { handleMissionApiError, queryWorkspaceId, withMissionPrincipal } from "../../_shared";

export const dynamic = "force-dynamic";

// GET /api/missions/:missionId/evidence — redacted evidence summary (no raw provider stdout/env).
export async function GET(req: NextRequest, { params }: { params: Promise<{ missionId: string }> }) {
  try {
    const { missionId } = await params;
    const principal = await withMissionPrincipal(req, { requestedWorkspaceId: queryWorkspaceId(req) });
    const evidence = await getMissionEvidence(principal, missionId);
    return NextResponse.json({ evidence });
  } catch (err) {
    return handleMissionApiError(err);
  }
}

const EVIDENCE_KINDS = ["test_result", "build_result", "lint_result", "diff_or_patch", "screenshot_or_artifact", "review_evidence", "remediation_evidence", "provider_execution_evidence"];
const LIFECYCLES = ["captured", "validated", "attached", "attested", "accepted"];
const AVAILABILITIES = ["available", "invalid", "redacted", "unavailable"];
const PRODUCER_KINDS = ["agent", "human", "system"];

// POST /api/missions/:missionId/evidence — record one evidence entry, e.g. from
// a live ACP session's completed turn (src/lib/bridge/acp-client.ts).
export async function POST(req: NextRequest, { params }: { params: Promise<{ missionId: string }> }) {
  try {
    const { missionId } = await params;
    const principal = await withMissionPrincipal(req, { requestedWorkspaceId: queryWorkspaceId(req) });
    const body = await req.json().catch(() => ({}));
    if (!EVIDENCE_KINDS.includes(body.kind)) throw new MissionApiError(`kind must be one of: ${EVIDENCE_KINDS.join(", ")}.`, "validation_error", 400);
    if (!LIFECYCLES.includes(body.lifecycle)) throw new MissionApiError(`lifecycle must be one of: ${LIFECYCLES.join(", ")}.`, "validation_error", 400);
    if (!AVAILABILITIES.includes(body.availability)) throw new MissionApiError(`availability must be one of: ${AVAILABILITIES.join(", ")}.`, "validation_error", 400);
    if (!PRODUCER_KINDS.includes(body.producerKind)) throw new MissionApiError(`producerKind must be one of: ${PRODUCER_KINDS.join(", ")}.`, "validation_error", 400);
    const evidence = await recordMissionEvidence(principal, missionId, {
      evidenceId: body.evidenceId ?? null,
      assignmentId: body.assignmentId ?? null,
      producerParticipantId: body.producerParticipantId ?? null,
      producerKind: body.producerKind,
      executionId: body.executionId ?? null,
      dispatchKey: body.dispatchKey ?? null,
      provider: body.provider ?? null,
      kind: body.kind,
      source: String(body.source ?? ""),
      lifecycle: body.lifecycle,
      availability: body.availability,
      integrity: body.integrity ?? null,
      clientRequestId: body.clientRequestId ?? req.headers.get("idempotency-key"),
    });
    return NextResponse.json({ evidence }, { status: 201 });
  } catch (err) {
    return handleMissionApiError(err);
  }
}
