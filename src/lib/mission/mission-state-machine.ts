/**
 * Mission state machine (spec STATE_MODEL §3, §10, §16)
 * ----------------------------------------------------------------------------
 * The authoritative transition table. The client may request commands but does
 * not author domain state (spec STATE_MODEL §2), so every transition passes
 * through `validateTransition` here.
 *
 * Three rules this file exists to enforce:
 *   1. Only declared transitions are legal.
 *   2. Terminal states are immutable — accepted/rejected/cancelled/failed
 *      never transition again. Further work creates a successor Mission.
 *   3. Non-happy-path states carry a structured reason, so the UI never has to
 *      invent an explanation for why something is blocked.
 */

import {
  ACTIVE_MISSION_STATES,
  isActiveMissionState,
  isTerminalMissionState,
  type ActiveMissionState,
  type MissionState,
  type StateReason,
} from "./mission-domain";

/**
 * Declared transitions, transcribed from spec STATE_MODEL §3.
 *
 * `needs_input`, `blocked`, and `paused` list the active states explicitly
 * rather than the spec's shorthand `previous_active_state`; the specific one
 * allowed at runtime is constrained further by `Mission.resumeTo`.
 */
export const MISSION_TRANSITIONS: Readonly<Record<MissionState, readonly MissionState[]>> = {
  draft: ["planning", "cancelled"],
  planning: ["ready", "needs_input", "failed", "cancelled"],
  ready: ["initializing", "planning", "cancelled"],
  initializing: ["executing", "blocked", "failed", "cancelled"],
  executing: ["reviewing", "verifying", "needs_input", "blocked", "paused", "failed", "cancelled"],
  reviewing: ["executing", "verifying", "needs_input", "blocked", "paused", "failed", "cancelled"],
  verifying: ["executing", "reviewing", "ready_for_decision", "blocked", "paused", "failed", "cancelled"],
  needs_input: [...ACTIVE_MISSION_STATES, "cancelled", "failed"],
  blocked: [...ACTIVE_MISSION_STATES, "cancelled", "failed"],
  paused: [...ACTIVE_MISSION_STATES, "cancelled"],
  // "reviewing" added for RequestMissionChanges/ContinueMissionInvestigation
  // (mission-commands.ts) — a decision to send work back is legal, but only
  // back through review, never straight to "executing". That specific pair
  // (ready_for_decision -> executing) stays illegal on purpose — see
  // "undeclared transitions are refused" in mission-domain.test.ts, which
  // guards the product rule that verification precedes a decision. Sending
  // work back still has to pass back through review before it can re-enter
  // active execution.
  ready_for_decision: ["accepted", "rejected", "cancelled", "reviewing", "needs_input"],
  // Terminal — no outbound transitions (spec STATE_MODEL §16).
  accepted: [],
  rejected: [],
  cancelled: [],
  failed: [],
} as const;

/** States that require a structured reason on entry (spec STATE_MODEL §10). */
export const STATES_REQUIRING_REASON: readonly MissionState[] = [
  "needs_input",
  "blocked",
  "paused",
  "failed",
  "cancelled",
  "rejected",
] as const;

export function requiresReason(state: MissionState): boolean {
  return STATES_REQUIRING_REASON.includes(state);
}

/** States that must record where the Mission resumes to. */
export const STATES_REQUIRING_RESUME_TARGET: readonly MissionState[] = [
  "needs_input",
  "blocked",
  "paused",
] as const;

export function requiresResumeTarget(state: MissionState): boolean {
  return STATES_REQUIRING_RESUME_TARGET.includes(state);
}

export interface TransitionRequest {
  from: MissionState;
  to: MissionState;
  /** Required when entering a state in STATES_REQUIRING_REASON. */
  reason?: StateReason | null;
  /** Required when entering needs_input/blocked/paused. */
  resumeTo?: ActiveMissionState | null;
  /**
   * The resume target recorded when the Mission was interrupted. Leaving an
   * interruption is only legal back to this exact state.
   */
  recordedResumeTo?: ActiveMissionState | null;
}

export interface TransitionResult {
  ok: boolean;
  errors: string[];
  /** The state to persist when ok; unchanged `from` otherwise. */
  state: MissionState;
  /** The resume target to persist alongside the state. */
  resumeTo: ActiveMissionState | null;
}

/**
 * Validate a single transition. Pure: no clock, no IO, no side effects, so the
 * same request always yields the same result.
 */
export function validateTransition(req: TransitionRequest): TransitionResult {
  const errors: string[] = [];
  const { from, to } = req;

  const fail = (): TransitionResult => ({ ok: false, errors, state: from, resumeTo: req.recordedResumeTo ?? null });

  // Terminal immutability first — the strongest rule, checked before anything
  // else so a terminal Mission can never be nudged by a well-formed request.
  if (isTerminalMissionState(from)) {
    errors.push(
      `Mission is terminal (${from}) and cannot transition. Create a successor Mission instead.`,
    );
    return fail();
  }

  const allowed = MISSION_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    errors.push(`Illegal transition ${from} → ${to}.`);
    return fail();
  }

  if (requiresReason(to) && !req.reason) {
    errors.push(`Entering ${to} requires a structured reason.`);
  }

  if (requiresResumeTarget(to)) {
    if (!req.resumeTo) {
      errors.push(`Entering ${to} requires a resume target.`);
    } else if (!isActiveMissionState(req.resumeTo)) {
      errors.push(`Resume target ${req.resumeTo} is not an active state.`);
    }
  }

  // Leaving an interruption: the spec's "previous_active_state" means the one
  // actually recorded, not any active state.
  if (requiresResumeTarget(from) && isActiveMissionState(to)) {
    if (!req.recordedResumeTo) {
      errors.push(`Cannot resume from ${from} without a recorded resume target.`);
    } else if (req.recordedResumeTo !== to) {
      errors.push(`Mission interrupted from ${req.recordedResumeTo}; it cannot resume into ${to}.`);
    }
  }

  if (errors.length > 0) return fail();

  const nextResumeTo = requiresResumeTarget(to) ? (req.resumeTo as ActiveMissionState) : null;
  return { ok: true, errors: [], state: to, resumeTo: nextResumeTo };
}

/** Every state reachable from `from` in one legal step. */
export function allowedTransitionsFrom(from: MissionState): readonly MissionState[] {
  return MISSION_TRANSITIONS[from];
}
