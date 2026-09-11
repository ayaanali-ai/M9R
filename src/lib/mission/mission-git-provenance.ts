import { createHash } from "node:crypto";
import { redactSession } from "@/lib/session-redaction";
import type { BoundedDiffManifest } from "@/lib/resident-write-isolation";

export type GitOperation = "commit" | "push" | "pull_request";

export interface GitCommitCandidate {
  version: "oathlock.git-commit-candidate.v1";
  workspaceId: string;
  missionId: string;
  assignmentId: string;
  participantId: string;
  branch: string;
  commitSha: string;
  manifestDigest: string;
  changedFiles: Array<{ status: string; path: string }>;
  message: string;
  reviewable: boolean;
  candidateDigest: string;
}

export interface GitAuthorizationAttestation {
  actorKind: "human" | "agent" | "system";
  actorId: string;
  decision: "approved" | "rejected";
  candidateDigest: string;
  recordedAt: string;
  /** Present only when MISSION_GIT_ATTESTATION_SIGNING_KEY is configured — see mission-git-attestation-signer.ts. A missing signature is a fact the UI shows, never silently backfilled. */
  signature: string | null;
  keyId: string | null;
}

export interface GitOperationResult {
  outcome: "succeeded" | "failed";
  providerRef: string | null;
  summary: string;
  recordedAt: string;
}

export interface MissionGitProvenanceRecord {
  operationId: string;
  operation: GitOperation;
  workspaceId: string;
  missionId: string;
  assignmentId: string;
  participantId: string;
  branch: string;
  commitSha: string;
  candidateDigest: string;
  manifestDigest: string;
  status: "recorded" | "rejected" | "failed" | "completed";
  authorization: GitAuthorizationAttestation | null;
  result: GitOperationResult | null;
  recordedAt: string;
}

function safeText(value: unknown, maxLength: number): string {
  return redactSession(typeof value === "string" ? value : String(value ?? "")).redactedText.slice(0, maxLength);
}

function validSha(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40,64}$/i.test(value);
}

function validBranch(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9._/-]{1,200}$/.test(value) && !value.startsWith("-") && !value.includes("..") && !value.endsWith("/");
}

export function buildGitCommitCandidate(input: {
  workspaceId: string;
  missionId: string;
  assignmentId: string;
  participantId: string;
  branch: string;
  commitSha: string;
  manifest: Pick<BoundedDiffManifest, "digest" | "reviewable" | "changedFiles" | "violations">;
  message: string;
}): GitCommitCandidate {
  if (!validSha(input.commitSha)) throw new Error("Commit SHA is invalid.");
  if (!validBranch(input.branch)) throw new Error("Git branch is invalid.");
  if (input.manifest.changedFiles.length > 500) throw new Error("Commit candidate exceeds the file limit.");
  const changedFiles = input.manifest.changedFiles.map((file) => ({ status: safeText(file.status, 4), path: safeText(file.path, 512) }));
  const candidateWithoutDigest = {
    version: "oathlock.git-commit-candidate.v1" as const,
    workspaceId: safeText(input.workspaceId, 256),
    missionId: safeText(input.missionId, 256),
    assignmentId: safeText(input.assignmentId, 256),
    participantId: safeText(input.participantId, 256),
    branch: safeText(input.branch, 200),
    commitSha: input.commitSha.toLowerCase(),
    manifestDigest: safeText(input.manifest.digest, 128),
    changedFiles,
    message: safeText(input.message, 512),
    reviewable: input.manifest.reviewable && input.manifest.violations.length === 0,
  };
  const candidateDigest = createHash("sha256").update(JSON.stringify(candidateWithoutDigest)).digest("hex");
  return { ...candidateWithoutDigest, candidateDigest };
}

export function authorizeGitOperation(input: {
  candidate: GitCommitCandidate;
  operation: GitOperation;
  attestation: GitAuthorizationAttestation | null;
}): { ok: true; reason: "human_approved_exact_candidate" } | { ok: false; reason: "candidate_not_reviewable" | "human_approval_required" | "candidate_digest_mismatch" | "approval_rejected" } {
  if (!input.candidate.reviewable) return { ok: false, reason: "candidate_not_reviewable" };
  if (!input.attestation || input.attestation.actorKind !== "human") return { ok: false, reason: "human_approval_required" };
  if (input.attestation.candidateDigest !== input.candidate.candidateDigest) return { ok: false, reason: "candidate_digest_mismatch" };
  if (input.attestation.decision !== "approved") return { ok: false, reason: "approval_rejected" };
  return { ok: true, reason: "human_approved_exact_candidate" };
}
