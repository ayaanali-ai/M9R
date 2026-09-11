import { NextRequest, NextResponse } from "next/server";
import { MissionApiError } from "@/lib/mission/mission-application-errors";
import { getMissionGitProvenance, getMission } from "@/lib/mission/mission-application-service";
import { mintRepositoryInstallationToken } from "@/lib/mission/mission-git-credential-broker";
import { getGithubInstallationForWorkspace } from "@/lib/github-installation-store";
import { verifyAttestationPayload, ATTESTATION_VERSION } from "@/lib/mission/mission-git-attestation-signer";
import { handleMissionApiError, queryWorkspaceId, withMissionPrincipal } from "../../missions/_shared";

export const dynamic = "force-dynamic";

/**
 * POST /api/bridge/git-token — mint a short-lived GitHub installation token
 * for exactly one already human-approved push candidate. This is the only
 * server endpoint that ever touches the GitHub App private key
 * (mission-git-credential-broker.ts); the token itself lives only in the
 * Bridge's process memory for the duration of one push (plan §11.2).
 *
 * Deliberately narrow: refuses unless a matching "recorded" (human-approved,
 * not yet completed/failed) push provenance row exists for the exact
 * candidateDigest and the calling agent's own participantId — an agent
 * cannot mint a token for a candidate nobody approved, or for a candidate
 * approved for a different participant.
 */
export async function POST(req: NextRequest) {
  try {
    const principal = await withMissionPrincipal(req, { requestedWorkspaceId: queryWorkspaceId(req) });
    if (principal.kind !== "agent") throw new MissionApiError("Only an authenticated Bridge may request a Git installation token.", "agent_required", 403);
    const body = await req.json().catch(() => ({}));
    const missionId = String(body.missionId ?? "");
    const candidateDigest = String(body.candidateDigest ?? "");
    const participantId = String(body.participantId ?? "");
    if (!missionId || !candidateDigest || !participantId) throw new MissionApiError("missionId, candidateDigest, and participantId are required.", "validation_error", 400);

    const [mission, operations] = await Promise.all([
      getMission(principal, missionId),
      getMissionGitProvenance(principal, missionId),
    ]);
    const approved = operations.find((op) => op.candidateDigest === candidateDigest && op.operation === "push" && op.participantId === participantId && op.status === "recorded" && op.authorization?.decision === "approved");
    if (!approved) throw new MissionApiError("No matching human-approved push candidate was found for this participant.", "conflict", 409);

    // The authorization row's signature/keyId existed for exactly this
    // moment -- the one place a stored decision unlocks a real GitHub
    // credential -- but nothing ever checked it (finding cf188bbf). A
    // missing signature (MISSION_GIT_ATTESTATION_SIGNING_KEY unconfigured at
    // authorization time) is an accepted, already-documented case and stays
    // fail-open; a PRESENT signature that doesn't verify means the stored
    // decision was tampered with or corrupted, and must hard-block minting.
    if (approved.authorization?.signature && approved.authorization?.keyId) {
      const authentic = verifyAttestationPayload(
        {
          missionId: approved.missionId,
          operation: approved.operation,
          actorId: approved.authorization.actorId,
          decision: approved.authorization.decision,
          candidateDigest: approved.authorization.candidateDigest,
          recordedAt: approved.authorization.recordedAt,
        },
        { version: ATTESTATION_VERSION, signature: approved.authorization.signature, keyId: approved.authorization.keyId },
      );
      if (!authentic) throw new MissionApiError("The stored approval for this push candidate failed signature verification.", "conflict", 409);
    }

    const [owner, repo] = mission.repository.split("/");
    if (!owner || !repo) throw new MissionApiError("Mission repository is not in owner/repo form.", "conflict", 409);

    const installation = await getGithubInstallationForWorkspace(principal.workspaceId);
    const token = await mintRepositoryInstallationToken({ owner, repo, installationId: installation?.installationId ?? null });
    return NextResponse.json({ token: token.token, expiresAt: token.expiresAt, owner, repo, branch: approved.branch, operationId: approved.operationId });
  } catch (err) {
    return handleMissionApiError(err);
  }
}
