import { NextRequest, NextResponse } from "next/server";
import { MissionApiError } from "@/lib/mission/mission-application-errors";
import { getMission } from "@/lib/mission/mission-application-service";
import { proposePullRequest, listPullRequests } from "@/lib/mission/mission-pull-request-store";
import { handleMissionApiError, queryWorkspaceId, withMissionPrincipal } from "../../_shared";

export const dynamic = "force-dynamic";

/** GET lists candidates for a Mission (human dashboard or agent Bridge, either may view). POST is agent-only: propose a PR candidate. Neither ever opens a PR -- only /pull-request/decision, on human approval, does that. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ missionId: string }> }) {
  try {
    const { missionId } = await params;
    const principal = await withMissionPrincipal(req, { requestedWorkspaceId: queryWorkspaceId(req) });
    const pullRequests = await listPullRequests(principal.workspaceId, missionId);
    return NextResponse.json({ pullRequests });
  } catch (error) {
    return handleMissionApiError(error);
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ missionId: string }> }) {
  try {
    const { missionId } = await params;
    const principal = await withMissionPrincipal(req, { requestedWorkspaceId: queryWorkspaceId(req) });
    if (principal.kind !== "agent") throw new MissionApiError("Only an authenticated Bridge may propose a pull request.", "agent_required", 403);

    const body = await req.json().catch(() => ({}));
    const assignmentId = String(body.assignmentId ?? "");
    const headBranch = String(body.headBranch ?? "");
    const baseBranch = String(body.baseBranch ?? "");
    const title = String(body.title ?? "");
    const prBody = body.body == null ? "" : String(body.body);
    if (!assignmentId || !headBranch || !baseBranch || !title) {
      throw new MissionApiError("assignmentId, headBranch, baseBranch, and title are required.", "validation_error", 400);
    }

    const mission = await getMission(principal, missionId);
    const [owner, repo] = mission.repository.split("/");
    if (!owner || !repo) throw new MissionApiError("Mission repository is not in owner/repo form.", "conflict", 409);

    const record = await proposePullRequest({
      workspaceId: principal.workspaceId,
      missionId,
      assignmentId,
      participantId: principal.actor.id,
      owner,
      repo,
      headBranch,
      baseBranch,
      title,
      body: prBody,
    });
    return NextResponse.json({ pullRequest: record }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && !(error instanceof MissionApiError)) {
      return NextResponse.json({ error: error.message, code: "validation_error" }, { status: 400 });
    }
    return handleMissionApiError(error);
  }
}
