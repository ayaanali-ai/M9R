/**
 * Mission dispatch Runtime (Phase 2D.2)
 * ----------------------------------------------------------------------------
 * The execution boundary: turns a claimed `DispatchInstruction` into locally
 * supervised work, keeps its lease alive via heartbeat/renewal, enforces
 * fencing before ANY result is accepted, and recovers outstanding intents on
 * startup. Calls no provider — `ExecutionHost` is the seam Phase 3's real
 * adapters (Codex, Claude Code, Devin, a browser-verifier, ...) will
 * implement; this phase ships only an in-memory fake host, used to test
 * supervision behavior without spawning anything real.
 *
 * This is why adapters belong AFTER this file, not before: an adapter needs
 * a stable host enforcing fencing at its boundary — accepting a result only
 * when the lease that authorized the work is still the current one — rather
 * than reimplementing that check per adapter.
 */

import {
  beginExecution,
  cancelExecution,
  classifyOutstandingIntentForRecovery,
  completeExecution,
  isTerminalExecutionState,
  markLeaseLost,
  markRunning,
  recordHeartbeat,
  type ExecutionOutcome,
  type ExecutionRecord,
} from "./mission-execution";
import type { LeaseHolder, SchedulerPolicy } from "./mission-scheduler";
import type { DispatchInstruction, MissionSchedulerStore } from "./mission-scheduler-store";
import type { ProcessExecutionHost } from "./mission-process-host";
import { recoverOutstandingIntentsWithProcessHost } from "./mission-process-recovery";
import type { ProviderEvent } from "./mission-provider-adapter";
import { normalizeMissionRuntimeEvent, type MissionRuntimeEventJournal } from "./mission-runtime-event";
import type { MissionRuntimeActivityRelay } from "./mission-runtime-activity-relay";
import type { MissionAcceptedResultBoundary } from "./mission-accepted-result-service";
import type { MissionCollaborationResultBridge } from "./mission-collaboration-result-bridge";
import type { MissionPendingMessageSource } from "./mission-pending-message-source";

// ---------------------------------------------------------------------------
// ExecutionHost — the seam Phase 3 implements for real
// ---------------------------------------------------------------------------

export interface ExecutionHandle {
  handleId: string;
}

export interface ExecutionHost {
  /** Begin local supervision of a claimed instruction. Must not block until completion. */
  start(instruction: DispatchInstruction): Promise<ExecutionHandle>;
  /** Non-blocking: has the underlying work finished? Null while still running. */
  poll(handle: ExecutionHandle): Promise<ExecutionOutcome | null>;
  /** Optional normalized provider-event cursor. Hosts without provider events remain valid. */
  pollEvents?(handle: ExecutionHandle): Promise<ProviderEvent[]>;
  /** Best-effort — e.g. terminate a process. Must not throw for "already finished." */
  cancel(handle: ExecutionHandle): Promise<void>;
}

/**
 * Test double only — deliberately NOT a provider adapter. Lets tests script
 * exactly when, and how, a supervised execution finishes.
 */
export class InMemoryExecutionHost implements ExecutionHost {
  private readonly outcomes = new Map<string, ExecutionOutcome | null>();
  private readonly cancelledHandles = new Set<string>();
  private seq = 0;

  async start(): Promise<ExecutionHandle> {
    this.seq += 1;
    const handle: ExecutionHandle = { handleId: `handle-${this.seq}` };
    this.outcomes.set(handle.handleId, null);
    return handle;
  }

  async poll(handle: ExecutionHandle): Promise<ExecutionOutcome | null> {
    return this.outcomes.get(handle.handleId) ?? null;
  }

  async cancel(handle: ExecutionHandle): Promise<void> {
    this.cancelledHandles.add(handle.handleId);
  }

  /** Test control: script this handle as finished with the given outcome. */
  resolve(handle: ExecutionHandle, outcome: ExecutionOutcome): void {
    this.outcomes.set(handle.handleId, outcome);
  }

  wasCancelled(handle: ExecutionHandle): boolean {
    return this.cancelledHandles.has(handle.handleId);
  }
}

// ---------------------------------------------------------------------------
// MissionDispatchRuntime
// ---------------------------------------------------------------------------

interface TrackedExecution {
  record: ExecutionRecord;
  handle: ExecutionHandle;
  instruction: DispatchInstruction;
}

export interface MissionDispatchRuntimeConfig {
  store: MissionSchedulerStore;
  host: ExecutionHost;
  holder: LeaseHolder;
  policy: SchedulerPolicy;
  mintExecutionId?: () => string;
  /** Optional durable, bounded event journal. No journal means events are not retained. */
  runtimeEventJournal?: MissionRuntimeEventJournal;
  /** Optional live relay fed only after normalized events are durably appended. */
  runtimeActivityRelay?: MissionRuntimeActivityRelay;
  /** Optional fenced result inbox. Legacy/unlinked instructions are skipped. */
  acceptedResultBoundary?: MissionAcceptedResultBoundary;
  /** Optional durable Mission command bridge for explicit collaboration directives. */
  collaborationResultBridge?: MissionCollaborationResultBridge;
  /** Optional Mission message read boundary used to enrich the next launch. */
  pendingMessageSource?: MissionPendingMessageSource;
  /**
   * Phase 4D Part 4 — the recovery-path consolidation point. When present,
   * `recoverOnStartup` delegates ENTIRELY to `recoverOutstandingIntentsWithProcessHost`
   * (mission-process-recovery.ts), the process-aware recovery that actually
   * checks whether a dispatched process is still alive before touching any
   * lease. When absent (no `ProcessExecutionHost` configured — e.g. tests
   * using only `InMemoryExecutionHost`, which carries no persisted process
   * handle at all), `recoverOnStartup` falls back to the ORIGINAL,
   * deliberately more conservative fence-only classification below — see
   * that method's doc comment for exactly why the fallback is intentional,
   * not a silently-weaker default a production caller could stumble into.
   * A production caller that wires up a real `ProcessExecutionHost` gets
   * the safe path automatically; it is not a separate opt-in a caller could
   * forget.
   */
  processHost?: ProcessExecutionHost;
}

export interface TickReport {
  completed: ExecutionRecord[];
  failed: ExecutionRecord[];
  leaseLost: ExecutionRecord[];
  renewed: number;
  runtimeEventsPersisted: number;
  runtimeEventErrors: number;
  runtimeActivitiesPublished: number;
  runtimeActivityErrors: number;
  acceptedResultRefusals: string[];
  acceptedResultErrors: number;
  collaborationCommands: number;
  collaborationErrors: number;
}

export interface RecoveryReport {
  closedAsStale: string[];
  revokedAndClosed: string[];
  /** Only ever populated by the process-aware path (`processHost` configured) — a still-live, reattachable process whose lease and execution identity were retained, not closed. */
  reattached: string[];
  /** Only ever populated by the process-aware path — process status could not be determined in a SHARED environment (or termination didn't confirm); neither the lease nor the intent was touched, and a human must resolve it. */
  blockedForReview: string[];
}

export class MissionDispatchRuntime {
  private readonly store: MissionSchedulerStore;
  private readonly host: ExecutionHost;
  private readonly holder: LeaseHolder;
  private readonly policy: SchedulerPolicy;
  private readonly mintExecutionId: (() => string) | null;
  private readonly processHost: ProcessExecutionHost | null;
  private readonly runtimeEventJournal: MissionRuntimeEventJournal | null;
  private readonly runtimeActivityRelay: MissionRuntimeActivityRelay | null;
  private readonly acceptedResultBoundary: MissionAcceptedResultBoundary | null;
  private readonly collaborationResultBridge: MissionCollaborationResultBridge | null;
  private readonly pendingMessageSource: MissionPendingMessageSource | null;
  private readonly executions = new Map<string, TrackedExecution>();

  constructor(config: MissionDispatchRuntimeConfig) {
    this.store = config.store;
    this.host = config.host;
    this.holder = config.holder;
    this.policy = config.policy;
    // The accepted-result contract intentionally uses the dispatch intent id
    // as the canonical execution id. A custom mint remains available for
    // isolated legacy tests and non-inbox callers.
    this.mintExecutionId = config.mintExecutionId ?? null;
    this.processHost = config.processHost ?? null;
    this.runtimeEventJournal = config.runtimeEventJournal ?? null;
    this.runtimeActivityRelay = config.runtimeActivityRelay ?? null;
    this.acceptedResultBoundary = config.acceptedResultBoundary ?? null;
    this.collaborationResultBridge = config.collaborationResultBridge ?? null;
    this.pendingMessageSource = config.pendingMessageSource ?? null;
  }

  /** Adopt a just-claimed instruction: start local supervision. Does not itself touch the store — the caller already holds the lease from its own `claimCandidates` call. */
  async adopt(instruction: DispatchInstruction, now: string): Promise<ExecutionRecord> {
    const launchInstruction = await this.withPendingMessageContext(instruction);

    // Audit item 8 — dispatch-key/execution-id mutual consistency. The
    // default execution id IS the dispatch instruction id (see the
    // constructor's comment on `mintExecutionId`), but a custom
    // `mintExecutionId` remains configurable for legacy/test callers — if
    // that mint ever produces an id already tracking a DIFFERENT
    // dispatchKey, `this.executions.set(record.executionId, ...)` below
    // would silently overwrite the other execution's tracking entry,
    // corrupting supervision for whichever dispatchKey loses the
    // collision. Assert BEFORE starting the process (`this.host.start`
    // below), so a colliding mint is refused loudly instead of leaking a
    // started process this Runtime then loses track of.
    const candidateExecutionId = this.mintExecutionId?.() ?? instruction.instructionId;
    const colliding = this.executions.get(candidateExecutionId);
    if (colliding && colliding.record.dispatchKey !== instruction.dispatchKey) {
      throw new Error(
        `Dispatch-key/execution-id mismatch: execution id "${candidateExecutionId}" is already tracking dispatchKey "${colliding.record.dispatchKey}", cannot also adopt dispatchKey "${instruction.dispatchKey}" under the same execution id.`,
      );
    }

    const handle = await this.host.start(launchInstruction);
    let record = beginExecution({
      executionId: candidateExecutionId,
      instructionId: instruction.instructionId,
      missionId: instruction.missionId,
      workspaceId: instruction.workspaceId,
      dispatchKey: instruction.dispatchKey,
      leaseId: instruction.leaseId,
      fencingToken: instruction.fencingToken,
      attempt: instruction.attempt,
      now,
    });
    const running = markRunning(record, now);
    if (running.ok) record = running.record;
    this.executions.set(record.executionId, { record, handle, instruction });
    if (this.acceptedResultBoundary && instruction.assignmentId && instruction.adapterRequirement) {
      const accepted = await this.acceptedResultBoundary.accept({ instruction, execution: record, resultKind: "started", outcome: null, now });
      if (!accepted.ok) {
        this.executions.delete(record.executionId);
        await this.host.cancel(handle).catch(() => {});
        throw new Error(`Mission execution start result refused: ${accepted.reason}`);
      }
    }
    return record;
  }

  listTracked(): ExecutionRecord[] {
    return [...this.executions.values()].map((t) => t.record);
  }

  cancel(executionId: string, now: string, reason: string): ExecutionRecord | null {
    const tracked = this.executions.get(executionId);
    if (!tracked) return null;
    const result = cancelExecution(tracked.record, now, reason);
    if (result.ok) tracked.record = result.record;
    void this.host.cancel(tracked.handle);
    return tracked.record;
  }

  /**
   * One supervision pass over every tracked, non-terminal execution:
   *   - poll the host; if it finished, verify the fence is STILL current
   *     before accepting the result at all — a stale worker's outcome must
   *     never reach the Mission's own command handler;
   *   - if it hasn't finished, renew the lease; if renewal fails for ANY
   *     reason, cancel the local process and mark the execution
   *     `lease_lost` rather than let it keep running unfenced.
   */
  async tick(now: string): Promise<TickReport> {
    const report: TickReport = { completed: [], failed: [], leaseLost: [], renewed: 0, runtimeEventsPersisted: 0, runtimeEventErrors: 0, runtimeActivitiesPublished: 0, runtimeActivityErrors: 0, acceptedResultRefusals: [], acceptedResultErrors: 0, collaborationCommands: 0, collaborationErrors: 0 };

    for (const tracked of [...this.executions.values()]) {
      if (isTerminalExecutionState(tracked.record.state)) continue;

      if (this.runtimeEventJournal && this.host.pollEvents) {
        try {
          const events = await this.host.pollEvents(tracked.handle);
          if (events.length > 0) {
            const normalized = events.map((event, index) => this.normalizeRuntimeEvent(event, tracked, index));
            const persisted = await this.runtimeEventJournal.append(normalized);
            report.runtimeEventsPersisted += persisted.stored;
            if (this.runtimeActivityRelay) {
              const activities = normalized.flatMap((event) => event.activity ? [event.activity] : []);
              if (activities.length > 0) {
                try {
                  const published = await this.runtimeActivityRelay.publish(activities);
                  report.runtimeActivitiesPublished += published.published;
                } catch {
                  report.runtimeActivityErrors += 1;
                }
              }
            }
          }
        } catch {
          // Event retention must never cause the supervisor to stop renewing
          // or fencing the underlying execution. The report makes the loss
          // visible to the worker/operator without claiming persistence.
          report.runtimeEventErrors += 1;
        }
      }

      const outcome = await this.host.poll(tracked.handle);
      if (outcome) {
        const fenceValid = await this.store.validateFence({
          workspaceId: tracked.record.workspaceId,
          missionId: tracked.record.missionId,
          dispatchKey: tracked.record.dispatchKey,
          leaseId: tracked.record.leaseId,
          fencingToken: tracked.record.fencingToken,
        });

        if (!fenceValid) {
          const lost = markLeaseLost(
            tracked.record,
            now,
            "Execution finished, but its fencing token was no longer current — result discarded, never applied.",
          );
          if (lost.ok) {
            tracked.record = lost.record;
            report.leaseLost.push(lost.record);
          }
          continue;
        }

        const finished = completeExecution(tracked.record, now, outcome);
        if (finished.ok) {
          tracked.record = finished.record;
          if (this.acceptedResultBoundary && tracked.instruction.assignmentId && tracked.instruction.adapterRequirement) {
            const accepted = await this.acceptTerminalResult(tracked, outcome, now);
            if (!accepted.ok) {
              report.acceptedResultRefusals.push(accepted.reason);
              const lost = markLeaseLost(tracked.record, now, `Accepted result refused (${accepted.reason}) — lease retained for recovery rather than released.`);
              if (lost.ok) {
                tracked.record = lost.record;
                report.leaseLost.push(lost.record);
              }
              continue;
            }
          }
          if (this.collaborationResultBridge) {
            try {
              const collaboration = await this.collaborationResultBridge.apply({ instruction: tracked.instruction, execution: tracked.record, outcome, now });
              report.collaborationCommands += collaboration.commands;
            } catch {
              report.collaborationErrors += 1;
            }
          }
          (outcome.success ? report.completed : report.failed).push(finished.record);
          await this.store.releaseLease({
            workspaceId: tracked.record.workspaceId,
            missionId: tracked.record.missionId,
            dispatchKey: tracked.record.dispatchKey,
            leaseId: tracked.record.leaseId,
            fencingToken: tracked.record.fencingToken,
            holder: this.holder,
            now,
          });
        }
        continue;
      }

      const renewal = await this.store.renewLease({
        workspaceId: tracked.record.workspaceId,
        missionId: tracked.record.missionId,
        dispatchKey: tracked.record.dispatchKey,
        leaseId: tracked.record.leaseId,
        fencingToken: tracked.record.fencingToken,
        holder: this.holder,
        now,
        policy: this.policy,
      });

      if (renewal.ok) {
        const heartbeat = recordHeartbeat(tracked.record, now, renewal.lease.fencingToken);
        if (heartbeat.ok) tracked.record = heartbeat.record;
        report.renewed += 1;
        continue;
      }

      await this.host.cancel(tracked.handle);
      const lost = markLeaseLost(tracked.record, now, `Lease renewal failed (${renewal.reason}) — cancelling local execution.`);
      if (lost.ok) {
        tracked.record = lost.record;
        if (this.acceptedResultBoundary && tracked.instruction.assignmentId && tracked.instruction.adapterRequirement) {
          try {
            const accepted = await this.acceptedResultBoundary.accept({ instruction: tracked.instruction, execution: tracked.record, resultKind: "lease_lost", outcome: null, now });
            if (!accepted.ok) report.acceptedResultRefusals.push(accepted.reason);
          } catch {
            report.acceptedResultErrors += 1;
          }
        }
        report.leaseLost.push(lost.record);
      }
    }

    return report;
  }

  private async withPendingMessageContext(instruction: DispatchInstruction): Promise<DispatchInstruction> {
    if (!this.pendingMessageSource) return instruction;
    const participantId = typeof instruction.executionConstraints.participantId === "string" ? instruction.executionConstraints.participantId : null;
    if (!participantId) return instruction;
    const since = typeof instruction.executionConstraints.lastDispatchedAt === "string" ? instruction.executionConstraints.lastDispatchedAt : null;
    const context = await this.pendingMessageSource.loadPendingMessages({ missionId: instruction.missionId, participantId, since });
    if (!context) return instruction;
    return { ...instruction, executionConstraints: { ...instruction.executionConstraints, pendingMessagesContext: context } };
  }

  private normalizeRuntimeEvent(event: ProviderEvent, tracked: TrackedExecution, index: number) {
    const participantId = event.participantId ?? (typeof tracked.instruction.executionConstraints.participantId === "string" ? tracked.instruction.executionConstraints.participantId : null);
    const assignmentId = event.assignmentId ?? tracked.instruction.assignmentId ?? (typeof tracked.instruction.executionConstraints.assignmentId === "string" ? tracked.instruction.executionConstraints.assignmentId : null);
    return normalizeMissionRuntimeEvent({
      event,
      workspaceId: tracked.record.workspaceId,
      missionId: tracked.record.missionId,
      executionId: tracked.record.executionId,
      participantId,
      assignmentId,
      eventId: `${tracked.record.executionId}:${event.eventId ?? `${event.type}:${event.timestamp}:${index}`}`,
      correlationId: event.correlationId || `execution:${tracked.instruction.instructionId}`,
      causationId: event.causationId ?? tracked.record.executionId,
    });
  }

  private async acceptTerminalResult(tracked: TrackedExecution, outcome: ExecutionOutcome, now: string) {
    try {
      return await this.acceptedResultBoundary!.accept({ instruction: tracked.instruction, execution: tracked.record, resultKind: outcome.success ? "completed" : "failed", outcome, now });
    } catch {
      return { ok: false as const, reason: "invalid_dispatch_state" as const };
    }
  }

  /**
   * Startup recovery: this Runtime process has no memory of what a previous
   * instance was supervising — that instance's local process died with it
   * (or, in the process-aware case below, may still be running).
   *
   * Phase 4D Part 4 — recovery-path consolidation. This method is now a
   * ROUTER, not the recovery logic itself:
   *   - `this.processHost` configured (a real `ProcessExecutionHost` was
   *     given to this Runtime) -> delegates entirely to
   *     `recoverOutstandingIntentsWithProcessHost` (mission-process-recovery.ts),
   *     which actually inspects whether each dispatched process is still
   *     alive before ever touching a lease. This is the AUTHORITATIVE path.
   *   - No `processHost` configured -> falls back to the ORIGINAL fence-only
   *     classification (`classifyOutstandingIntentForRecovery`), which has
   *     no way to check process liveness at all and always closes every
   *     outstanding intent. This fallback exists ONLY because a caller with
   *     no process-handle tracking capability (e.g. `InMemoryExecutionHost`
   *     in tests) has nothing more informative to check — it is not a
   *     silently-weaker default a production caller could stumble into,
   *     since a production caller wiring up `RealExecutionHost`'s
   *     underlying `ProcessExecutionHost` here gets the safe path for free.
   */
  async recoverOnStartup(workspaceId: string, now: string): Promise<RecoveryReport> {
    if (this.processHost) {
      const result = await recoverOutstandingIntentsWithProcessHost({ schedulerStore: this.store, processHost: this.processHost, workspaceId, now });
      const report: RecoveryReport = { closedAsStale: [], revokedAndClosed: [], reattached: [], blockedForReview: [] };
      for (const outcome of result.outcomes) {
        switch (outcome.outcome) {
          case "process_confirmed_dead":
          case "process_terminated":
          case "environment_quarantined":
            report.revokedAndClosed.push(outcome.instructionId);
            break;
          case "process_reattached":
            report.reattached.push(outcome.instructionId);
            break;
          case "process_status_unknown":
            report.blockedForReview.push(outcome.instructionId);
            break;
        }
      }
      return report;
    }

    const report: RecoveryReport = { closedAsStale: [], revokedAndClosed: [], reattached: [], blockedForReview: [] };
    const outstanding = await this.store.listOutstandingDispatchIntents(workspaceId);

    for (const intent of outstanding) {
      const fenceValid = await this.store.validateFence({
        workspaceId: intent.workspaceId,
        missionId: intent.missionId,
        dispatchKey: intent.dispatchKey,
        leaseId: intent.leaseId,
        fencingToken: intent.fencingToken,
      });

      const classification = classifyOutstandingIntentForRecovery(fenceValid);

      if (classification.action === "revoke_and_close") {
        await this.store.revokeLease({
          workspaceId: intent.workspaceId,
          missionId: intent.missionId,
          dispatchKey: intent.dispatchKey,
          now,
          reason: classification.reason,
        });
        report.revokedAndClosed.push(intent.instructionId);
      } else {
        report.closedAsStale.push(intent.instructionId);
      }

      await this.store.markDispatchIntentDelivered(intent.instructionId, now);
    }

    return report;
  }
}
