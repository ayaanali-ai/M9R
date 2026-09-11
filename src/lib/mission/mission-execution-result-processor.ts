import type { CommandContext, MissionCommand } from "./mission-commands";
import type { AcceptedExecutionResult, MissionExecutionResultStore } from "./mission-execution-result-store";

export interface MissionExecutionResultCommandPort {
  /** Must call runMissionCommandDurable; direct event append is forbidden. */
  run(input: { command: MissionCommand; context: CommandContext; idempotencyKey: string; workspaceId: string }): Promise<{ ok: boolean }>;
}

export interface MissionExecutionResultProcessorDeps {
  store: MissionExecutionResultStore;
  commandPort: MissionExecutionResultCommandPort;
  clock: () => string;
  retryDelayMs: (retryCount: number) => number;
}

export class MissionExecutionResultProcessor {
  private readonly deps: MissionExecutionResultProcessorDeps;

  constructor(deps: MissionExecutionResultProcessorDeps) {
    this.deps = deps;
  }

  async runOnce(input: { owner: string; leaseDurationMs: number; limit: number }): Promise<{ claimed: number; fullyApplied: number; failed: number }> {
    const rows = await this.deps.store.claimUnapplied({ owner: input.owner, now: this.deps.clock(), leaseDurationMs: input.leaseDurationMs, limit: input.limit });
    let fullyApplied = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        await this.applyOne(row, input.owner);
        fullyApplied += 1;
      } catch (error) {
        failed += 1;
        const delay = Math.max(1_000, this.deps.retryDelayMs(row.retryCount));
        await this.deps.store.markApplicationFailed({ acceptedResultId: row.acceptedResultId, owner: input.owner, errorCode: error instanceof Error ? error.name : "application_error", nextAttemptAt: new Date(Date.parse(this.deps.clock()) + delay).toISOString() });
      }
    }
    return { claimed: rows.length, fullyApplied, failed };
  }

  private async applyOne(row: AcceptedExecutionResult, owner: string): Promise<void> {
    if (!rowLifecycleAlreadyApplied(row)) {
      const lifecycle = lifecycleCommand(row, this.deps.clock());
      const result = await this.deps.commandPort.run({ command: lifecycle, context: commandContext(row, this.deps.clock()), idempotencyKey: `execution-lifecycle:${row.acceptedResultId}`, workspaceId: row.workspaceId });
      if (!result.ok) throw new Error("mission_lifecycle_command_refused");
      await this.deps.store.markLifecycleApplied({ acceptedResultId: row.acceptedResultId, owner, at: this.deps.clock() });
    }
    // Evidence is separately idempotent and only records bounded descriptors.
    if (row.evidenceAppliedAt === null) for (const [index, descriptor] of row.evidenceDescriptors.entries()) {
      const result = await this.deps.commandPort.run({
        command: {
          type: "RecordEvidence", missionId: row.missionId, evidenceId: `execution-result:${row.acceptedResultId}:${index}`,
          assignmentId: row.assignmentId, producerParticipantId: null, producerKind: "system", executionId: row.executionId,
          dispatchKey: row.dispatchKey, provider: row.providerAdapterId, kind: "provider_execution_evidence", source: descriptor.storageRef ?? descriptor.digest,
          lifecycle: "attached", availability: "available", integrity: null,
        }, context: commandContext(row, this.deps.clock()), idempotencyKey: `execution-evidence:${row.acceptedResultId}:${index}`, workspaceId: row.workspaceId,
      });
      if (!result.ok) throw new Error("mission_evidence_command_refused");
    }
    await this.deps.store.markEvidenceApplied({ acceptedResultId: row.acceptedResultId, owner, at: this.deps.clock() });
    await this.deps.store.markFullyApplied({ acceptedResultId: row.acceptedResultId, owner, at: this.deps.clock() });
  }
}

function rowLifecycleAlreadyApplied(row: AcceptedExecutionResult): boolean {
  return row.lifecycleAppliedAt !== null;
}

function commandContext(row: AcceptedExecutionResult, timestamp: string): CommandContext {
  return { actor: { kind: "system", id: "orchestrator" }, timestamp, correlationId: row.correlationId, causationId: row.causationId };
}

function lifecycleCommand(row: AcceptedExecutionResult, timestamp: string): MissionCommand {
  const type = row.resultKind === "started" ? "RecordExecutionStarted" : row.resultKind === "completed" ? "RecordExecutionCompleted" : row.resultKind === "failed" ? "RecordExecutionFailed" : row.resultKind === "cancelled" ? "RecordExecutionCancelled" : "RecordExecutionLeaseLost";
  return { type, missionId: row.missionId, workspaceId: row.workspaceId, assignmentId: row.assignmentId, dispatchIntentId: row.dispatchIntentId, executionId: row.executionId, dispatchKey: row.dispatchKey, providerAdapterId: row.providerAdapterId, leaseId: row.leaseId, fencingToken: row.fencingGeneration, attempt: row.executionAttempt, correlationId: row.correlationId, causationId: row.causationId, timestamp, resultDigest: row.resultDigest, evidenceIds: [] };
}
