/** Durable, fenced provider-result acceptance boundary. */

export const ACCEPTED_EXECUTION_RESULT_KINDS = ["started", "completed", "failed", "cancelled", "lease_lost"] as const;
export type AcceptedExecutionResultKind = (typeof ACCEPTED_EXECUTION_RESULT_KINDS)[number];
export type FencingGeneration = string;

export interface RedactedEvidenceDescriptor {
  evidenceType: string;
  digest: string;
  storageRef: string | null;
  byteSize: number;
  redactionState: "redacted";
  generatedAt: string;
  mimeType: string | null;
}

export interface AcceptExecutionResultInput {
  workspaceId: string;
  missionId: string;
  assignmentId: string;
  dispatchIntentId: string;
  dispatchKey: string;
  /** Canonically equal to dispatchIntentId; provider process IDs are never accepted here. */
  executionId: string;
  providerAdapterId: string;
  leaseId: string;
  fencingGeneration: FencingGeneration;
  executionAttempt: number;
  resultKind: AcceptedExecutionResultKind;
  resultSchemaVersion: 1;
  resultDigest: string;
  idempotencyKey: string;
  metadata: { redactionState: "redacted"; [key: string]: unknown };
  evidenceDescriptors: readonly RedactedEvidenceDescriptor[];
  /** Trusted execution policy; never inferred from descriptor count. */
  evidenceRequired: boolean;
  correlationId: string;
  causationId: string | null;
  now: string;
}

export type AcceptedResultRefusalReason =
  | "legacy_missing_assignment_linkage" | "dispatch_not_found" | "workspace_mismatch" | "mission_mismatch"
  | "assignment_mismatch" | "execution_mismatch" | "provider_mismatch" | "lease_mismatch"
  | "stale_fencing_generation" | "execution_attempt_mismatch" | "unsupported_result_kind"
  | "unsupported_schema_version" | "invalid_digest" | "invalid_idempotency_key" | "metadata_not_redacted"
  | "metadata_too_large" | "invalid_dispatch_state" | "execution_not_started" | "execution_already_terminal"
  | "terminal_result_conflict" | "result_after_lease_loss" | "idempotency_conflict"
  | "invalid_evidence_requirement";

export type AcceptExecutionResultResult =
  | { ok: true; duplicate: boolean; acceptedResultId: string; applicationStatus: "pending" | "claimed" | "retry" | "fully_applied" }
  | { ok: false; reason: AcceptedResultRefusalReason };

export interface AcceptedExecutionResult {
  acceptedResultId: string;
  workspaceId: string;
  missionId: string;
  assignmentId: string;
  dispatchIntentId: string;
  dispatchKey: string;
  executionId: string;
  providerAdapterId: string;
  leaseId: string;
  fencingGeneration: FencingGeneration;
  executionAttempt: number;
  resultKind: AcceptedExecutionResultKind;
  resultDigest: string;
  metadata: { redactionState: "redacted"; [key: string]: unknown };
  evidenceDescriptors: readonly RedactedEvidenceDescriptor[];
  /** NULL is reserved for pre-policy legacy rows. */
  evidenceRequired: boolean | null;
  correlationId: string;
  causationId: string | null;
  retryCount: number;
  lifecycleAppliedAt: string | null;
  evidenceAppliedAt: string | null;
}

export interface MissionExecutionResultStore {
  acceptResult(input: AcceptExecutionResultInput): Promise<AcceptExecutionResultResult>;
  claimUnapplied(input: { owner: string; now: string; leaseDurationMs: number; limit: number }): Promise<AcceptedExecutionResult[]>;
  markLifecycleApplied(input: { acceptedResultId: string; owner: string; at: string }): Promise<void>;
  markEvidenceApplied(input: { acceptedResultId: string; owner: string; at: string }): Promise<void>;
  markFullyApplied(input: { acceptedResultId: string; owner: string; at: string }): Promise<void>;
  markApplicationFailed(input: { acceptedResultId: string; owner: string; errorCode: string; nextAttemptAt: string }): Promise<void>;
  releaseApplicationClaim(input: { acceptedResultId: string; owner: string }): Promise<void>;
}
