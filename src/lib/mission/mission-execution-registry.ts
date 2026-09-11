/**
 * Authoritative execution lifecycle state used by Mission events.
 *
 * An execution is one durable dispatch-intent generation. Its id is the
 * dispatch intent id, not a provider PID: retries create a new intent and
 * therefore a new execution id. Provider process/session identifiers are
 * references only and cannot be used to authorise a result.
 */

export const MISSION_EXECUTION_STATUSES = ["started", "completed", "failed", "cancelled", "lease_lost"] as const;
export type MissionExecutionStatus = (typeof MISSION_EXECUTION_STATUSES)[number];
export const TERMINAL_MISSION_EXECUTION_STATUSES = ["completed", "failed", "cancelled", "lease_lost"] as const;

export function isTerminalMissionExecutionStatus(status: MissionExecutionStatus): boolean {
  return (TERMINAL_MISSION_EXECUTION_STATUSES as readonly string[]).includes(status);
}

export interface MissionExecutionRecord {
  executionId: string;
  missionId: string;
  workspaceId: string;
  assignmentId: string;
  dispatchIntentId: string;
  dispatchKey: string;
  providerAdapterId: string;
  leaseId: string;
  /** Canonical decimal string: never round-trip a PostgreSQL bigint through JS number. */
  fencingToken: string;
  attempt: number;
  status: MissionExecutionStatus;
  startedAt: string;
  terminalAt: string | null;
  terminalReason: string | null;
  resultDigest: string | null;
  evidenceIds: string[];
  correlationId: string;
  causationId: string | null;
}

export type ExecutionTransitionResult =
  | { ok: true; record: MissionExecutionRecord }
  | { ok: false; code: "execution_not_started" | "execution_already_terminal" | "execution_terminal_conflict" };

export function transitionMissionExecution(
  current: MissionExecutionRecord | undefined,
  nextStatus: MissionExecutionStatus,
  input: { timestamp: string; reason?: string | null; resultDigest?: string | null; evidenceIds?: string[] },
): ExecutionTransitionResult {
  if (!current) return { ok: false, code: "execution_not_started" };
  if (!isTerminalMissionExecutionStatus(nextStatus)) return { ok: false, code: "execution_terminal_conflict" };
  if (isTerminalMissionExecutionStatus(current.status)) {
    if (current.status === nextStatus && current.terminalReason === (input.reason ?? null) && current.resultDigest === (input.resultDigest ?? null)) {
      return { ok: true, record: current };
    }
    return { ok: false, code: "execution_already_terminal" };
  }
  return {
    ok: true,
    record: {
      ...current,
      status: nextStatus,
      terminalAt: input.timestamp,
      terminalReason: input.reason ?? null,
      resultDigest: input.resultDigest ?? null,
      evidenceIds: [...new Set([...(current.evidenceIds ?? []), ...(input.evidenceIds ?? [])])],
    },
  };
}
