/**
 * Ties together everything Phase B8 built into the one call the Agent
 * Bridge makes once a human has approved a push candidate through the
 * existing /api/missions/:id/git/authorize flow. This is deliberately the
 * LAST step only — it never builds a candidate, never requests
 * authorization, and never runs unless the caller already has a "recorded"
 * (human-approved) provenance row for this exact candidateDigest. Building
 * and offering the candidate itself (diffing the worktree, posting it for
 * review) is separate, not-yet-built orchestration in
 * services/mission-bridge/src/index.ts — see the PR description for what
 * that still needs.
 */

import { ensureSigningIdentity, configureRepositoryForSigning, signAndCommit } from "./git-signer";
import { pushWithInstallationToken } from "./git-credential-helper";

export interface PerformApprovedPushInput {
  appUrl: string;
  agentToken: string;
  missionId: string;
  participantId: string;
  repoPath: string;
  signingKeyPath: string;
  candidateDigest: string;
  branch: string;
  owner: string;
  repo: string;
  commitMessage: string;
  authorName: string;
  authorEmail: string;
  /** True when repoPath already has the candidate committed (e.g. the ACP session itself ran `git commit`) — skips signAndCommit and just pushes what's there. */
  alreadyCommitted?: boolean;
}

async function postJson(url: string, agentToken: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${agentToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function performApprovedPush(input: PerformApprovedPushInput): Promise<{ commitSha: string; signatureVerified: boolean }> {
  const identity = ensureSigningIdentity(input.signingKeyPath, `${input.participantId}@m9r.bridge`);
  configureRepositoryForSigning(input.repoPath, identity);

  // Best-effort registration — a Bridge restart reuses the same key/path, so
  // this is idempotent (mission-git-signing-identity-store.ts upserts on
  // mission_id+participant_id) and safe to call every time.
  await postJson(`${input.appUrl}/api/missions/${encodeURIComponent(input.missionId)}/git/signing-key`, input.agentToken, {
    participantId: input.participantId,
    publicKey: identity.publicKey,
    fingerprint: identity.fingerprint,
  }).catch(() => undefined);

  const commit = input.alreadyCommitted
    ? { commitSha: "", signatureVerified: false }
    : signAndCommit(input.repoPath, { authorName: input.authorName, authorEmail: input.authorEmail, message: input.commitMessage });

  const tokenResponse = await postJson(`${input.appUrl}/api/bridge/git-token`, input.agentToken, {
    missionId: input.missionId,
    candidateDigest: input.candidateDigest,
    participantId: input.participantId,
  });
  if (!tokenResponse.ok) throw new Error(`Could not mint a Git installation token (HTTP ${tokenResponse.status}). The push candidate may not be human-approved yet.`);
  const tokenBody = await tokenResponse.json() as { token: string; owner: string; repo: string; branch: string; operationId: string };

  pushWithInstallationToken({ repoPath: input.repoPath, branch: tokenBody.branch, owner: tokenBody.owner, repo: tokenBody.repo, token: tokenBody.token });

  await postJson(`${input.appUrl}/api/missions/${encodeURIComponent(input.missionId)}/git/result`, input.agentToken, {
    operationId: tokenBody.operationId,
    candidateDigest: input.candidateDigest,
    outcome: "succeeded",
    providerRef: null,
    summary: `Pushed to ${input.owner}/${input.repo}:${input.branch}`,
  }).catch(() => undefined);

  return commit;
}
