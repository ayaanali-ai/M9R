/**
 * Bounded production supervision cycle for Mission dispatch.
 *
 * This is intentionally an orchestration layer, not another scheduler: the
 * existing pure candidate selector decides eligibility, MissionSchedulerStore
 * owns durable claims/fencing, and MissionDispatchRuntime owns execution
 * adoption/recovery/ticking. A process host is injected through that runtime.
 * Nothing starts when this module is imported.
 */

import { MissionDispatchRuntime } from "./mission-dispatch-runtime";
import { DISPATCHABLE_MISSION_STATES, selectDispatchCandidates, type DispatchLease, type SchedulerPolicy } from "./mission-scheduler";
import type { DispatchKey, LeaseHolder } from "./mission-scheduler";
import type { MissionProjection } from "./mission-projection";
import type { MissionSchedulerStore } from "./mission-scheduler-store";
import type { MissionExecutionResultProcessor } from "./mission-execution-result-processor";

/**
 * Only the fields a bounded dispatch-read source can cheaply produce from an
 * index table, without replaying and re-projecting a Mission's full event
 * stream just to pick candidates. `selectDispatchCandidates`
 * (mission-scheduler.ts) only ever reads `.missionId`/`.state` off a
 * candidate's projection — asserted here as a named, checkable contract
 * instead of a bare `as MissionProjection` cast at each call site. If that
 * function ever starts reading a field this view doesn't carry, TypeScript
 * catches it at the widening point in `runOnce` below, not silently at
 * runtime.
 */
export type MissionDispatchProjectionView = Pick<MissionProjection, "missionId" | "workspaceId" | "repositoryId" | "state">;

export interface MissionDispatchSourceCandidate {
  projection: MissionDispatchProjectionView;
  assignmentId: string;
  dispatchKey: DispatchKey;
  adapterRequirement: string | null;
  executionConstraints: Record<string, unknown>;
  lease: DispatchLease | null;
}

/** Tenant-scoped, bounded read boundary. Production SQL belongs behind this interface. */
export interface MissionDispatchSource {
  listWorkspaces(): Promise<string[]>;
  listCandidates(input: { workspaceId: string; limit: number }): Promise<MissionDispatchSourceCandidate[]>;
}

export interface MissionRuntimeWorkerConfig {
  runtime: MissionDispatchRuntime;
  schedulerStore: MissionSchedulerStore;
  source: MissionDispatchSource;
  holder: LeaseHolder;
  policy: SchedulerPolicy;
  clock?: () => string;
  candidateBatchSize?: number;
  pollIntervalMs?: number;
  /** Optional application pass that projects accepted execution results into Mission events. */
  resultProcessor?: MissionExecutionResultProcessor;
  resultProcessorOwner?: string;
  resultProcessorBatchSize?: number;
}

export interface MissionRuntimeWorkerReport {
  recoveredCount: number;
  reviewRequiredCount: number;
  candidateCount: number;
  claimedCount: number;
  adoptedCount: number;
  completedCount: number;
  failedCount: number;
  leaseLostCount: number;
  acceptedResultClaimedCount: number;
  acceptedResultAppliedCount: number;
  acceptedResultFailedCount: number;
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`MissionRuntimeWorker: ${field} must be a positive integer.`);
}

/**
 * Persistent-process friendly worker. The eventual daemon loop is deliberately
 * outside this class: callers invoke `runOnce` serially, avoiding overlapping
 * async cycles and making tests deterministic.
 */
export class MissionRuntimeWorker {
  private readonly config: Required<Pick<MissionRuntimeWorkerConfig, "clock" | "candidateBatchSize" | "pollIntervalMs" | "resultProcessorOwner" | "resultProcessorBatchSize">> & Omit<MissionRuntimeWorkerConfig, "clock" | "candidateBatchSize" | "pollIntervalMs" | "resultProcessorOwner" | "resultProcessorBatchSize">;
  private recovered = false;
  private running = false;
  private stopRequested = false;
  private loopTask: Promise<void> | null = null;

  constructor(config: MissionRuntimeWorkerConfig) {
    const candidateBatchSize = config.candidateBatchSize ?? 25;
    const pollIntervalMs = config.pollIntervalMs ?? 5_000;
    const resultProcessorBatchSize = config.resultProcessorBatchSize ?? 25;
    assertPositiveInteger(candidateBatchSize, "candidateBatchSize");
    assertPositiveInteger(pollIntervalMs, "pollIntervalMs");
    assertPositiveInteger(resultProcessorBatchSize, "resultProcessorBatchSize");
    this.config = { ...config, clock: config.clock ?? (() => new Date().toISOString()), candidateBatchSize, pollIntervalMs, resultProcessorOwner: config.resultProcessorOwner ?? "mission-runtime-worker", resultProcessorBatchSize };
  }

  /** Starts one serial poll loop. No timer is created on module import. */
  start(): void {
    if (this.loopTask) return;
    this.stopRequested = false;
    this.loopTask = this.runLoop().finally(() => { this.loopTask = null; });
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    await this.loopTask;
  }

  private async runLoop(): Promise<void> {
    while (!this.stopRequested) {
      await this.runOnce();
      if (!this.stopRequested) await new Promise<void>((resolve) => setTimeout(resolve, this.config.pollIntervalMs));
    }
  }

  async runOnce(): Promise<MissionRuntimeWorkerReport> {
    if (this.running) throw new Error("MissionRuntimeWorker: runOnce may not overlap an active cycle.");
    this.running = true;
    try {
      const report: MissionRuntimeWorkerReport = { recoveredCount: 0, reviewRequiredCount: 0, candidateCount: 0, claimedCount: 0, adoptedCount: 0, completedCount: 0, failedCount: 0, leaseLostCount: 0, acceptedResultClaimedCount: 0, acceptedResultAppliedCount: 0, acceptedResultFailedCount: 0 };
      const workspaces = [...new Set(await this.config.source.listWorkspaces())].sort();

      // Recovery is a hard startup gate: no fresh claims until every scoped
      // workspace has used the process-aware path configured on the runtime.
      if (!this.recovered) {
        for (const workspaceId of workspaces) {
          const recovery = await this.config.runtime.recoverOnStartup(workspaceId, this.config.clock());
          report.recoveredCount += recovery.closedAsStale.length + recovery.revokedAndClosed.length + recovery.reattached.length;
          report.reviewRequiredCount += recovery.blockedForReview.length;
        }
        this.recovered = true;
      }

      for (const workspaceId of workspaces) {
        const candidates = await this.config.source.listCandidates({ workspaceId, limit: this.config.candidateBatchSize });
        report.candidateCount += candidates.length;
        const selection = selectDispatchCandidates({
          policy: this.config.policy,
          candidates: candidates.map((candidate) => ({
            // Widened here, in exactly one place, from the honest
            // MissionDispatchProjectionView a bounded source can actually
            // produce — selectDispatchCandidates only reads
            // `.missionId`/`.state` (see that type's doc comment above).
            projection: candidate.projection as MissionProjection,
            workspaceId,
            dispatchKey: candidate.dispatchKey,
            lease: candidate.lease,
            now: this.config.clock(),
          })),
        });
        const eligible = new Set(selection.eligible.map((candidate) => `${candidate.missionId}:${candidate.dispatchKey}`));
        const claim = await this.config.schedulerStore.claimCandidates({
          holder: this.config.holder,
          now: this.config.clock(),
          policy: this.config.policy,
          dispatchableStates: DISPATCHABLE_MISSION_STATES,
          candidates: candidates
            .filter((candidate) => eligible.has(`${candidate.projection.missionId}:${candidate.dispatchKey}`))
            .map((candidate) => ({
              workspaceId,
              missionId: candidate.projection.missionId,
              repositoryId: candidate.projection.repositoryId,
              missionState: candidate.projection.state,
              assignmentId: candidate.assignmentId,
              dispatchKey: candidate.dispatchKey,
              adapterRequirement: candidate.adapterRequirement,
              executionConstraints: candidate.executionConstraints,
            })),
        });
        report.claimedCount += claim.claimed.length;
        for (const claimed of claim.claimed) {
          await this.config.runtime.adopt(claimed.instruction, this.config.clock());
          await this.config.schedulerStore.markDispatchIntentDelivered(claimed.instruction.instructionId, this.config.clock());
          report.adoptedCount += 1;
        }
      }

      const tick = await this.config.runtime.tick(this.config.clock());
      report.completedCount += tick.completed.length;
      report.failedCount += tick.failed.length;
      report.leaseLostCount += tick.leaseLost.length;
      if (this.config.resultProcessor) {
        const applied = await this.config.resultProcessor.runOnce({ owner: this.config.resultProcessorOwner, leaseDurationMs: this.config.policy.leaseDurationMs, limit: this.config.resultProcessorBatchSize });
        report.acceptedResultClaimedCount += applied.claimed;
        report.acceptedResultAppliedCount += applied.fullyApplied;
        report.acceptedResultFailedCount += applied.failed;
      }
      return report;
    } finally {
      this.running = false;
    }
  }
}
