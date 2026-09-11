/**
 * RealExecutionHost — the `ExecutionHost` (Phase 2D.2's simple `start/poll/
 * cancel` seam, `mission-dispatch-runtime.ts`) that `MissionDispatchRuntime`
 * actually takes in production (Phase 3B).
 * ----------------------------------------------------------------------------
 * Composes three things that each stay independently testable and
 * independently replaceable:
 *   - a `ProcessExecutionHost` (`mission-process-host.ts`) — process/
 *     environment lifecycle;
 *   - a `ProviderAdapterRegistry` (`mission-provider-registry.ts`) —
 *     capability-gated adapter lookup;
 *   - a `MissionSchedulerStore` (`mission-scheduler-store.ts`) — so the
 *     process handle `launch` produces is persisted immediately via
 *     `attachProcessHandle`, closing the exact gap Phase 3A's recovery
 *     correction depends on. Without this call, a crash between `launch`
 *     and the next scheduled `attachProcessHandle` would leave recovery
 *     with no handle to inspect — `process_status_unknown`, the most
 *     conservative outcome, every time.
 *
 * This class contains NO domain logic of its own: it does not decide
 * capability requirements (that's `ProviderAdapterRegistry`), does not
 * decide lease legality (that's `mission-scheduler.ts`/`mission-scheduler-
 * store.ts`, called by `MissionDispatchRuntime`, not from here), and does
 * not parse provider output (that's the adapter's `parseEvent`/
 * `collectResult`). It only sequences the calls in the right order and
 * keeps the bookkeeping (`ExecutionHandle` ↔ `PersistableProcessHandle` ↔
 * which adapter) a `start/poll/cancel` caller doesn't need to see.
 */

import type { DispatchInstruction, MissionSchedulerStore } from "./mission-scheduler-store";
import type { ExecutionHandle, ExecutionHost } from "./mission-dispatch-runtime";
import type { ExecutionOutcome } from "./mission-execution";
import type { PersistableProcessHandle, ProcessExecutionHost } from "./mission-process-host";
import type { ProviderAdapter, ProviderEvent } from "./mission-provider-adapter";
import { ProviderAdapterRegistry } from "./mission-provider-registry";

interface TrackedLaunch {
  persistableHandle: PersistableProcessHandle;
  adapter: ProviderAdapter;
  missionId: string;
  participantId: string | null;
  assignmentId: string | null;
  /** How many raw HostOutputEvents `pollEvents` has already normalized — so a repeated poll never re-emits the same event twice. */
  ingestedThroughSequence: number;
}

export interface RealExecutionHostConfig {
  processHost: ProcessExecutionHost;
  registry: ProviderAdapterRegistry;
  schedulerStore: MissionSchedulerStore;
  /** Where `ProcessExecutionHost.prepare` should base a new environment on — e.g. the repository's checked-out root. */
  repositoryRef: string;
  /** Capabilities required of every adapter before `start` will launch anything through it. */
  requiredCapabilities: Parameters<ProviderAdapterRegistry["assertCapabilities"]>[2];
}

export class RealExecutionHost implements ExecutionHost {
  private readonly processHost: ProcessExecutionHost;
  private readonly registry: ProviderAdapterRegistry;
  private readonly schedulerStore: MissionSchedulerStore;
  private readonly repositoryRef: string;
  private readonly requiredCapabilities: RealExecutionHostConfig["requiredCapabilities"];
  private readonly tracked = new Map<string, TrackedLaunch>();

  constructor(config: RealExecutionHostConfig) {
    this.processHost = config.processHost;
    this.registry = config.registry;
    this.schedulerStore = config.schedulerStore;
    this.repositoryRef = config.repositoryRef;
    this.requiredCapabilities = config.requiredCapabilities;
  }

  async start(instruction: DispatchInstruction): Promise<ExecutionHandle> {
    const adapterId = instruction.adapterRequirement;
    if (!adapterId) throw new Error(`Dispatch instruction ${instruction.instructionId} has no adapterRequirement — nothing to launch it with.`);

    // The fence must be current BEFORE anything is prepared or launched —
    // provider-agnostic, applies to every adapter behind this host. A
    // caller acting on a stale claim (e.g. its instruction was superseded
    // by a later claim on the same slot before `start` ran) must never
    // reach `processHost.prepare`/`launch` at all.
    const fenceValid = await this.schedulerStore.validateFence({
      workspaceId: instruction.workspaceId,
      missionId: instruction.missionId,
      dispatchKey: instruction.dispatchKey,
      leaseId: instruction.leaseId,
      fencingToken: instruction.fencingToken,
    });
    if (!fenceValid) {
      throw new Error(`Cannot start instruction ${instruction.instructionId}: fencing token is no longer current — this claim has been superseded.`);
    }

    const capabilityCheck = await this.registry.assertCapabilities(adapterId, { workspaceId: instruction.workspaceId }, this.requiredCapabilities);
    if (!capabilityCheck.ok) {
      throw new Error(`Cannot start instruction ${instruction.instructionId}: ${capabilityCheck.error.code} for adapter ${adapterId}.`);
    }
    const adapter = this.registry.get(adapterId);
    if (!adapter) throw new Error(`Adapter ${adapterId} vanished between capability check and lookup.`);

    const environment = await this.processHost.prepare({ instruction, repositoryRef: this.repositoryRef });
    const goal = typeof instruction.executionConstraints.goal === "string" ? instruction.executionConstraints.goal : "";
    // Phase 4A: Mission-native participant/assignment identity rides in the
    // same opaque executionConstraints bag every other adapter-specific
    // field already uses — no new typed field on DispatchInstruction, no
    // second metadata channel.
    const participantId = typeof instruction.executionConstraints.participantId === "string" ? instruction.executionConstraints.participantId : null;
    const assignmentId = typeof instruction.executionConstraints.assignmentId === "string" ? instruction.executionConstraints.assignmentId : null;
    const invocation = await adapter.prepareInvocation(
      { missionId: instruction.missionId, dispatchKey: instruction.dispatchKey, goal, executionConstraints: instruction.executionConstraints, participantId, assignmentId },
      { workingDirectory: environment.workingDirectory, kind: environment.kind },
    );

    // Revalidate immediately before the irreversible step. Capability
    // discovery, environment prep, and invocation prep above can all take
    // meaningful wall-clock time — long enough for the lease backing this
    // exact instruction to expire, be revoked, or be renewed onto a new
    // fencing token. Checking the fence only once, back at entry, leaves a
    // real window where a superseded claim still launches a process; this
    // second check closes it. A caller acting on a claim that went stale
    // during preparation must never reach `processHost.launch` at all.
    const stillValid = await this.schedulerStore.validateFence({
      workspaceId: instruction.workspaceId,
      missionId: instruction.missionId,
      dispatchKey: instruction.dispatchKey,
      leaseId: instruction.leaseId,
      fencingToken: instruction.fencingToken,
    });
    if (!stillValid) {
      throw new Error(`Cannot start instruction ${instruction.instructionId}: fencing token became stale during preparation — this claim was superseded before launch.`);
    }

    const persistableHandle = await this.processHost.launch({ instruction, environment, invocation });

    // Track locally BEFORE the durable attach call — if that call throws or
    // returns ambiguously, the process has already launched and this is the
    // only in-process record of it. Losing that record here (by tracking
    // only after a successful attach) is exactly what leaves a real,
    // running child process with no handle anyone can cancel.
    this.tracked.set(persistableHandle.executionId, {
      persistableHandle,
      adapter,
      missionId: instruction.missionId,
      participantId,
      assignmentId,
      ingestedThroughSequence: 0,
    });

    try {
      await this.schedulerStore.attachProcessHandle(instruction.instructionId, persistableHandle as unknown as Record<string, unknown>);
    } catch (error) {
      // The process is real and running, but its handle never became
      // durable — a future recovery pass has no row to find it by. Rather
      // than orphan it, terminate what we just launched and drop local
      // tracking before propagating, so the failure this method reports
      // and the actual state of the world agree.
      this.tracked.delete(persistableHandle.executionId);
      await this.processHost.terminate(persistableHandle).catch(() => {});
      throw error;
    }

    return { handleId: persistableHandle.executionId };
  }

  async poll(handle: ExecutionHandle): Promise<ExecutionOutcome | null> {
    const entry = this.tracked.get(handle.handleId);
    if (!entry) return null;

    const output = await this.processHost.collect(entry.persistableHandle);
    if (output.exitCode === null) return null; // still running

    const result = await entry.adapter.collectResult({ events: output.events, exitCode: output.exitCode });
    return { success: result.success, summary: result.summary, details: result.usage ? { usage: result.usage } : undefined };
  }

  /**
   * Phase 4B — the provider-event ingestion path. Consumes whatever raw
   * output the process host has captured SINCE THE LAST CALL (never
   * re-emitting an already-ingested `HostOutputEvent`), runs it through the
   * SAME `adapter.parseEvent` `start`/`poll` already use, and attaches
   * Mission/participant/assignment/dispatch/execution/provider identity —
   * never fabricated by the adapter itself, which has no notion of any of
   * this. Order is preserved exactly as `ProcessExecutionHost.collect`
   * returns it (append-order, the same order the process actually emitted
   * output in, as far as the underlying stream supports). A malformed line
   * simply produces zero `ProviderEvent`s from `parseEvent` — this method
   * never invents one to fill the gap.
   */
  async pollEvents(handle: ExecutionHandle): Promise<ProviderEvent[]> {
    const entry = this.tracked.get(handle.handleId);
    if (!entry) return [];

    const output = await this.processHost.collect(entry.persistableHandle);
    const newEvents = output.events.filter((event) => event.sequence > entry.ingestedThroughSequence);
    if (newEvents.length === 0) return [];

    const normalized: ProviderEvent[] = [];
    for (const hostEvent of newEvents) {
      const parsed = entry.adapter.parseEvent(hostEvent);
      parsed.forEach((event, indexWithinRawEvent) => {
        // Stable regardless of restart: derived from the execution + the
        // raw host sequence + position within that raw event's own parse
        // batch — never a locally-incrementing counter that would restart
        // at 0 after a crash and collide with earlier-delivered ids.
        const eventId = `${handle.handleId}:${hostEvent.sequence}:${indexWithinRawEvent}`;
        normalized.push({ ...event, eventId, executionId: handle.handleId, participantId: entry.participantId, assignmentId: entry.assignmentId });
      });
      entry.ingestedThroughSequence = Math.max(entry.ingestedThroughSequence, hostEvent.sequence);
    }
    return normalized;
  }

  async cancel(handle: ExecutionHandle): Promise<void> {
    const entry = this.tracked.get(handle.handleId);
    if (!entry) return;
    await this.processHost.terminate(entry.persistableHandle);
  }
}
