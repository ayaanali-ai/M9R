import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeGitOperation,
  buildGitCommitCandidate,
  type GitAuthorizationAttestation,
} from "@/lib/mission/mission-git-provenance";

const manifest = {
  version: "oathlock.diff-manifest.v1" as const,
  grantId: "grant-1234",
  baseCommit: "a".repeat(40),
  headCommit: "b".repeat(40),
  changedFiles: [{ status: "M" as const, path: "src/lib/mission/example.ts" }],
  violations: [],
  reviewable: true,
  digest: "digest-1",
};

test("commit candidate is bound to the assignment, manifest, participant, and exact commit", () => {
  const candidate = buildGitCommitCandidate({
    workspaceId: "workspace-1",
    missionId: "mission-1",
    assignmentId: "assignment-1",
    participantId: "agent-a",
    branch: "oathlock/grant-1234",
    commitSha: "c".repeat(40),
    manifest,
    message: "Update mission handler",
  });
  assert.equal(candidate.reviewable, true);
  assert.equal(candidate.assignmentId, "assignment-1");
  assert.equal(candidate.manifestDigest, "digest-1");
});

test("Git authorization requires a human and matches the exact candidate digest", () => {
  const candidate = buildGitCommitCandidate({
    workspaceId: "workspace-1",
    missionId: "mission-1",
    assignmentId: "assignment-1",
    participantId: "agent-a",
    branch: "oathlock/grant-1234",
    commitSha: "c".repeat(40),
    manifest,
    message: "Update mission handler",
  });
  const approval: GitAuthorizationAttestation = { actorKind: "human", actorId: "human-1", decision: "approved", candidateDigest: candidate.candidateDigest, recordedAt: "2026-08-01T00:00:00.000Z", signature: null, keyId: null };
  assert.equal(authorizeGitOperation({ candidate, operation: "push", attestation: approval }).ok, true);
  assert.equal(authorizeGitOperation({ candidate, operation: "push", attestation: { ...approval, actorKind: "agent" } }).ok, false);
  assert.equal(authorizeGitOperation({ candidate, operation: "push", attestation: { ...approval, candidateDigest: "wrong" } }).ok, false);
});
