import { createHash } from "node:crypto";
import { redactSession } from "../session-redaction";
import type { ExecutionOutcome, ExecutionRecord } from "./mission-execution";
import type { DispatchInstruction } from "./mission-scheduler-store";
import type { AcceptExecutionResultResult, AcceptedExecutionResultKind, MissionExecutionResultStore, RedactedEvidenceDescriptor } from "./mission-execution-result-store";

export interface MissionAcceptedResultInput {
  instruction: DispatchInstruction;
  execution: ExecutionRecord;
  resultKind: AcceptedExecutionResultKind;
  outcome: ExecutionOutcome | null;
  now: string;
}

export interface MissionAcceptedResultBoundary {
  accept(input: MissionAcceptedResultInput): Promise<AcceptExecutionResultResult>;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function boundedUsage(details: Record<string, unknown> | undefined): Record<string, number | null> | null {
  const usage = details?.usage;
  if (!usage || typeof usage !== "object") return null;
  const value = usage as Record<string, unknown>;
  const inputTokens = value.inputTokens;
  const outputTokens = value.outputTokens;
  return {
    inputTokens: typeof inputTokens === "number" && Number.isSafeInteger(inputTokens) && inputTokens >= 0 ? inputTokens : null,
    outputTokens: typeof outputTokens === "number" && Number.isSafeInteger(outputTokens) && outputTokens >= 0 ? outputTokens : null,
  };
}

function descriptorsFrom(details: Record<string, unknown> | undefined, now: string): RedactedEvidenceDescriptor[] {
  const descriptors = details?.evidenceDescriptors;
  if (!Array.isArray(descriptors)) return [];
  return descriptors.slice(0, 32).flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const row = value as Record<string, unknown>;
    if (typeof row.evidenceType !== "string" || typeof row.digest !== "string" || typeof row.byteSize !== "number") return [];
    if (!Number.isSafeInteger(row.byteSize) || row.byteSize < 0 || row.byteSize > 10_000_000) return [];
    return [{
      evidenceType: redactSession(row.evidenceType).redactedText.slice(0, 128),
      digest: row.digest.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 256),
      storageRef: typeof row.storageRef === "string" ? redactSession(row.storageRef).redactedText.slice(0, 512) : null,
      byteSize: row.byteSize,
      redactionState: "redacted" as const,
      generatedAt: typeof row.generatedAt === "string" ? row.generatedAt : now,
      mimeType: typeof row.mimeType === "string" ? redactSession(row.mimeType).redactedText.slice(0, 128) : null,
    }];
  });
}

/**
 * Converts a locally supervised execution into the durable fenced result
 * contract. The store performs the authoritative fence, assignment, lease,
 * and lifecycle checks; this class only constructs a bounded, redacted row.
 */
export class MissionAcceptedResultService implements MissionAcceptedResultBoundary {
  private readonly store: MissionExecutionResultStore;

  constructor(store: MissionExecutionResultStore) {
    this.store = store;
  }

  async accept(input: MissionAcceptedResultInput): Promise<AcceptExecutionResultResult> {
    const assignmentId = input.instruction.assignmentId;
    const providerAdapterId = input.instruction.adapterRequirement;
    if (!assignmentId) return { ok: false, reason: "legacy_missing_assignment_linkage" };
    if (!providerAdapterId) return { ok: false, reason: "provider_mismatch" };

    const summary = input.outcome ? redactSession(input.outcome.summary).redactedText.slice(0, 2_048) : null;
    const usage = boundedUsage(input.outcome?.details);
    const evidenceDescriptors = descriptorsFrom(input.outcome?.details, input.now);
    const metadata = {
      redactionState: "redacted" as const,
      resultKind: input.resultKind,
      success: input.outcome?.success ?? false,
      summary,
      usage,
    };
    const identity = {
      workspaceId: input.execution.workspaceId,
      missionId: input.execution.missionId,
      assignmentId,
      dispatchIntentId: input.instruction.instructionId,
      executionId: input.execution.executionId,
      dispatchKey: input.execution.dispatchKey,
      leaseId: input.execution.leaseId,
      fencingGeneration: String(input.execution.fencingToken),
      executionAttempt: input.execution.attempt,
      resultKind: input.resultKind,
      metadata,
      evidenceDescriptors,
    };
    const resultDigest = digest(identity);
    return this.store.acceptResult({
      workspaceId: input.execution.workspaceId,
      missionId: input.execution.missionId,
      assignmentId,
      dispatchIntentId: input.instruction.instructionId,
      dispatchKey: input.execution.dispatchKey,
      executionId: input.execution.executionId,
      providerAdapterId,
      leaseId: input.execution.leaseId,
      fencingGeneration: String(input.execution.fencingToken),
      executionAttempt: input.execution.attempt,
      resultKind: input.resultKind,
      resultSchemaVersion: 1,
      resultDigest,
      idempotencyKey: `execution-result-v1:${resultDigest}`,
      metadata,
      evidenceDescriptors,
      evidenceRequired: input.instruction.executionConstraints.evidenceRequired === true,
      correlationId: `execution:${input.instruction.instructionId}`,
      causationId: input.execution.executionId,
      now: input.now,
    });
  }
}
