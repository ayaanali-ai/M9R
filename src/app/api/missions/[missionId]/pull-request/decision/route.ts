import { NextRequest, NextResponse } from "next/server";
import { MissionApiError } from "@/lib/mission/mission-application-errors";
import { decidePullRequest } from "@/lib/mission/mission-pull-request-store";
import { handleMissionApiError, queryWorkspaceId, withMissionPrincipal } from "../../../_shared";

export const dynamic = "force-dynamic";

/**
 * POST /api/missions/:id/pull-request/decision — the only place a pending
 * PR candidate becomes a real GitHub API call. requireHuman: true refuses a
 * bearer-authenticated (agent) caller outright, same as every other
 * human-decision gate in this codebase (see mission-principal.ts) -- an
 * agent can propose a PR, never approve its own.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ missionId: string }> }) {
  try {
    const { missionId } = await params;
    const principal = await withMissionPrincipal(req, { requestedWorkspaceId: queryWorkspaceId(req), requireHuman: true });
    if (!principal.userId) throw new MissionApiError("Only an authenticated human may decide a pull request.", "human_required", 403);

    const body = await req.json().catch(() => ({}));
    const candidateDigest = String(body.candidateDigest ?? "");
    const decision = body.decision;
    if (!candidateDigest || (decision !== "approved" && decision !== "rejected")) {
      throw new MissionApiError("candidateDigest and decision ('approved' | 'rejected') are required.", "validation_error", 400);
    }

    const record = await decidePullRequest({
      workspaceId: principal.workspaceId,
      missionId,
      candidateDigest,
      decision,
      decidedByUserId: principal.userId,
    });
    return NextResponse.json({ pullRequest: record });
  } catch (error) {
    if (error instanceof Error && !(error instanceof MissionApiError)) {
      return NextResponse.json({ error: error.message, code: "pull_request_decision_failed" }, { status: 502 });
    }
    return handleMissionApiError(error);
  }
}
