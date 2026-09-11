/**
 * Mission reconciliation (spec STATE_MODEL §11, ORCHESTRATOR §9)
 * ----------------------------------------------------------------------------
 * Compares what the Mission projection believes against what execution
 * signals actually show — legacy Run/Assignment observations, provider
 * execution state, and local runtime/process state — and returns a typed
 * outcome.
 *
 * The rule this module exists to enforce: disagreement never resolves itself
 * by one side silently winning. A recoverable divergence proposes a specific,
 * named action; a blocked one names who must authorize resolving it; an
 * unknown one admits there isn't enough signal to say anything. None of the
 * three ever mutates state — this module only classifies.
 */

import { isTerminalMissionState, type MissionState } from "./mission-domain";
import type { NormalizedOrchestrationObservation, NormalizedOrchestrationPhase } from "./legacy-observation-mapping";

export const PROVIDER_EXECUTION_STATES = [
  "queued",
  "starting",
  "working",
  "waiting",
  "completed",
  "failed",
  "stopped",
  "unknown",
] as const;
export type ProviderExecutionState = (typeof PROVIDER_EXECUTION_STATES)[number];

export const RUNTIME_PROCESS_STATES = ["running", "exited", "missing", "unknown"] as const;
export type RuntimeProcessState = (typeof RUNTIME_PROCESS_STATES)[number];

export type RequiredAuthority = "human_review" | "system_reconciler" | "provider_reconnect";

export type ProposedReconciliationAction =
  | { type: "emit_normalized_completion"; details: string }
  | { type: "mark_needs_input"; details: string }
  | { type: "no_action_needed" };

export type ReconciliationOutcome =
  | { kind: "consistent" }
  | { kind: "recoverable_divergence"; proposedAction: ProposedReconciliationAction; details: string[] }
  | { kind: "blocked_divergence"; requiredAuthority: RequiredAuthority; details: string[] }
  | { kind: "unknown"; details: string[] };

export interface ReconciliationInput {
  missionId: string;
  missionState: MissionState;
  /** Legacy Run or Assignment observation, normalized, when one backs this Mission. */
  legacyObservation: NormalizedOrchestrationObservation | null;
  providerExecutionState: ProviderExecutionState | null;
  runtimeProcessState: RuntimeProcessState | null;
}

const ACTIVE_MISSION_PHASES: readonly MissionState[] = ["initializing", "executing", "reviewing", "verifying"];

/** True when a signal reports the underlying work as finished. */
function reportsCompleted(phase: NormalizedOrchestrationPhase | null, provider: ProviderExecutionState | null): boolean {
  return phase === "completed" || provider === "completed";
}

/** True when a signal reports the underlying work as finished with a different terminal outcome than the Mission recorded. */
function reportsConflictingTerminal(
  missionState: MissionState,
  phase: NormalizedOrchestrationPhase | null,
  provider: ProviderExecutionState | null,
): boolean {
  const missionAccepted = missionState === "accepted";
  const missionRejectedOrFailed = missionState === "rejected" || missionState === "failed" || missionState === "cancelled";
  const signalFailed = phase === "failed" || provider === "failed";
  const signalCompleted = phase === "completed" || provider === "completed";

  if (missionAccepted && signalFailed) return true;
  if (missionRejectedOrFailed && signalCompleted) return true;
  return false;
}

/**
 * Reconcile one Mission against whatever signals are available.
 *
 * Order of checks:
 *   1. Terminal Missions are immutable — a conflicting signal is always
 *      `blocked_divergence`, never an auto-correction, no matter how
 *      confident the signal is.
 *   2. A live Mission whose signals agree it has finished is a
 *      `recoverable_divergence` — the Mission can safely be nudged forward
 *      because nothing here contradicts a human decision.
 *   3. Missing/unknown execution signals for live work is `blocked_divergence`
 *      requiring the system reconciler, since the Mission cannot be trusted
 *      to still be doing anything.
 *   4. No signals at all is `unknown` — there is nothing to compare against.
 *   5. Otherwise, consistent.
 */
export function reconcileMission(input: ReconciliationInput): ReconciliationOutcome {
  const { missionState, legacyObservation, providerExecutionState, runtimeProcessState } = input;
  const phase = legacyObservation?.phase ?? null;
  const details: string[] = [];
  if (legacyObservation?.lossy) details.push(...legacyObservation.lossNotes);

  // ---- 1. Terminal Mission: never overwritten, ever ------------------------
  if (isTerminalMissionState(missionState)) {
    if (reportsConflictingTerminal(missionState, phase, providerExecutionState)) {
      return {
        kind: "blocked_divergence",
        requiredAuthority: "human_review",
        details: [
          `Mission is terminal (${missionState}); it is immutable and will not be overwritten.`,
          `Signal reports a conflicting outcome (legacy phase: ${phase ?? "none"}, provider: ${providerExecutionState ?? "none"}).`,
          "A successor Mission may be created to investigate; this Mission's record stands.",
          ...details,
        ],
      };
    }
    return { kind: "consistent" };
  }

  // ---- 2. Live Mission the signals say is actually done --------------------
  if (ACTIVE_MISSION_PHASES.includes(missionState) && reportsCompleted(phase, providerExecutionState)) {
    return {
      kind: "recoverable_divergence",
      proposedAction: {
        type: "emit_normalized_completion",
        details: `Mission is ${missionState} but execution signals report completion (legacy phase: ${phase ?? "n/a"}, provider: ${providerExecutionState ?? "n/a"}). Propose transitioning toward verification/decision.`,
      },
      details: [`Mission state (${missionState}) lags behind reported completion.`, ...details],
    };
  }

  // ---- 3. Missing process, unknown provider, live Mission ------------------
  if (
    ACTIVE_MISSION_PHASES.includes(missionState) &&
    runtimeProcessState === "missing" &&
    (providerExecutionState === "unknown" || providerExecutionState === null)
  ) {
    return {
      kind: "blocked_divergence",
      requiredAuthority: "system_reconciler",
      details: [
        `Mission is ${missionState}, but its runtime process is missing and provider state is unknown.`,
        "Cannot confirm whether work is still happening; requires reconciliation before proceeding.",
        ...details,
      ],
    };
  }

  // ---- 4. Nothing to compare against ---------------------------------------
  if (legacyObservation === null && providerExecutionState === null && runtimeProcessState === null) {
    return { kind: "unknown", details: ["No execution signal available for this Mission — nothing to reconcile against."] };
  }

  // ---- 5. Consistent --------------------------------------------------------
  return { kind: "consistent" };
}
