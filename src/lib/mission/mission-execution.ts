/**
 * Mission execution supervision (Phase 2D.2)
 * ----------------------------------------------------------------------------
 * Tracks what a Runtime knows about ONE locally-supervised execution of a
 * claimed DispatchInstruction: pure state, no process handle, no provider
 * call. The actual process lifecycle lives behind `ExecutionHost`
 * (mission-dispatch-runtime.ts); this file only says what states are legal
 * and when.
 *
 * Deliberately a THIRD state machine, independent of both `Mission.state`
 * (mission-domain.ts) and `DispatchLeaseState` (mission-scheduler.ts):
 *   - `Mission.state` — what's true about the work, from the domain's PoV.
 *   - `DispatchLeaseState` — who currently owns the right to act, and until
 *     when.
 *   - `ExecutionState` (here) — what THIS Runtime's local supervision of one
 *     attempt is doing right now.
 * A Mission can be `executing` with a live lease while its ExecutionState is
 * `lease_lost` (this worker discovered, via a failed renewal, that someone
 * else now owns the slot) — three different facts, deliberately not
 * collapsed into one.
 */

import type { MissionId } from "./mission-domain";
import type { DispatchKey, DispatchLeaseId } from "./mission-scheduler";

export const EXECUTION_STATES = ["starting", "running", "completed", "failed", "cancelled", "lease_lost"] as const;
export type ExecutionState = (typeof EXECUTION_STATES)[number];

export const TERMINAL_EXECUTION_STATES = ["completed", "failed", "cancelled", "lease_lost"] as const;
export type TerminalExecutionState = (typeof TERMINAL_EXECUTION_STATES)[number];

export function isTerminalExecutionState(state: ExecutionState): state is TerminalExecutionState {
  return (TERMINAL_EXECUTION_STATES as readonly string[]).includes(state);
}

export interface ExecutionOutcome {
  success: boolean;
  summary: string;
  details?: Record<string, unknown>;
}

export interface ExecutionRecord {
  executionId: string;
  instructionId: string;
  missionId: MissionId;
  workspaceId: string;
  dispatchKey: DispatchKey;
  leaseId: DispatchLeaseId;
  /** The Runtime's own record of the fencing token — bumped on every successful renewal so its NEXT renewal isn't itself stale. */
  fencingToken: number;
  attempt: number;
  state: ExecutionState;
  startedAt: string;
  endedAt: string | null;
  lastHeartbeatAt: string | null;
  outcome: ExecutionOutcome | null;
  terminationReason: string | null;
}

export interface ExecutionAlreadyTerminalError {
  code: "execution_already_terminal";
  executionId: string;
  state: TerminalExecutionState;
}

export type ExecutionTransitionError = ExecutionAlreadyTerminalError;
export type ExecutionTransitionResult = { ok: true; record: ExecutionRecord } | { ok: false; error: ExecutionTransitionError };

export function beginExecution(input: {
  executionId: string;
  instructionId: string;
  missionId: MissionId;
  workspaceId: string;
  dispatchKey: DispatchKey;
  leaseId: DispatchLeaseId;
  fencingToken: number;
  attempt: number;
  now: string;
}): ExecutionRecord {
  return {
    executionId: input.executionId,
    instructionId: input.instructionId,
    missionId: input.missionId,
    workspaceId: input.workspaceId,
    dispatchKey: input.dispatchKey,
    leaseId: input.leaseId,
    fencingToken: input.fencingToken,
    attempt: input.attempt,
    state: "starting",
    startedAt: input.now,
    endedAt: null,
    lastHeartbeatAt: input.now,
    outcome: null,
    terminationReason: null,
  };
}

function guardNotTerminal(record: ExecutionRecord): ExecutionTransitionResult | null {
  if (isTerminalExecutionState(record.state)) {
    return { ok: false, error: { code: "execution_already_terminal", executionId: record.executionId, state: record.state } };
  }
  return null;
}

export function markRunning(record: ExecutionRecord, now: string): ExecutionTransitionResult {
  return guardNotTerminal(record) ?? { ok: true, record: { ...record, state: "running", lastHeartbeatAt: now } };
}

/** A successful lease renewal is proof of life — not by itself a state change. `fencingToken` is updated to whatever the renewal returned. */
export function recordHeartbeat(record: ExecutionRecord, now: string, renewedFencingToken: number): ExecutionTransitionResult {
  return guardNotTerminal(record) ?? { ok: true, record: { ...record, lastHeartbeatAt: now, fencingToken: renewedFencingToken } };
}

export function completeExecution(record: ExecutionRecord, now: string, outcome: ExecutionOutcome): ExecutionTransitionResult {
  return (
    guardNotTerminal(record) ?? {
      ok: true,
      record: { ...record, state: outcome.success ? "completed" : "failed", endedAt: now, outcome, terminationReason: null },
    }
  );
}

export function cancelExecution(record: ExecutionRecord, now: string, reason: string): ExecutionTransitionResult {
  return guardNotTerminal(record) ?? { ok: true, record: { ...record, state: "cancelled", endedAt: now, terminationReason: reason } };
}

/**
 * The Runtime discovered — via a failed renewal, or a failed `validateFence`
 * check on a just-finished execution — that this execution's fencing token
 * is no longer current. Its local process must already have been cancelled
 * (best-effort) by the caller, and its outcome, if any arrived, must never
 * be accepted as this Mission's result.
 */
export function markLeaseLost(record: ExecutionRecord, now: string, reason: string): ExecutionTransitionResult {
  return guardNotTerminal(record) ?? { ok: true, record: { ...record, state: "lease_lost", endedAt: now, terminationReason: reason } };
}

// ---------------------------------------------------------------------------
// Recovery classification — what a restarted Runtime should do with an
// outstanding dispatch intent it did not itself create
// ---------------------------------------------------------------------------

export type RecoveryAction = "close_as_stale" | "revoke_and_close";

export interface RecoveryClassification {
  action: RecoveryAction;
  reason: string;
}

/**
 * A restarted Runtime has NO local process handle for work a previous
 * process instance claimed — that instance's process, and everything it
 * knew, died with it. There is no "reattach to the running work" option in
 * this phase (that would require Phase 3's real provider handles to even
 * attempt); the only choices are:
 *   - the fence is ALREADY invalid (someone else reclaimed the slot, or it
 *     expired and was reclaimed) — this intent is simply stale; close it.
 *   - the fence is STILL valid — this Runtime's own crashed process was the
 *     last thing holding the slot, and nothing is actually running anymore.
 *     Revoke the lease itself (freeing the slot for a clean re-claim)
 *     rather than leave it to expire on its own timer, then close the
 *     intent.
 * Pure: takes the fence-validity fact as an input rather than checking it
 * itself, so this stays independently testable from `validateFence`'s own
 * I/O.
 */
export function classifyOutstandingIntentForRecovery(fenceStillValid: boolean): RecoveryClassification {
  if (!fenceStillValid) {
    return { action: "close_as_stale", reason: "Fencing token is no longer current — a later claim already superseded this instruction." };
  }
  return {
    action: "revoke_and_close",
    reason: "Fencing token is still current, but no local process can resume it after a restart — releasing the slot for a clean re-claim.",
  };
}
