/**
 * Planner authority invariants — Phase 5D Priority 2.
 * ----------------------------------------------------------------------------
 * Centralizes (does not duplicate) the executable checks that state "what
 * may move a Plan/PlanningRequest forward." Every function here is a pure
 * predicate over already-loaded domain state — none of them mutate
 * anything, call a store, or run a command. They exist so call sites that
 * need to answer "is this transition/actor allowed to do X" have exactly
 * one place to ask, instead of re-deriving the rule inline.
 *
 * These wrap `validatePlanTransition`/`PLAN_STATUSES` (mission-collaboration.ts,
 * mission-domain.ts) rather than re-encoding the transition table — the
 * transition table itself remains the single source of truth for legal
 * PlanStatus moves.
 */

import type { MissionPlanProposal, PlanStatus } from "./mission-domain";
import { isTerminalPlanStatus } from "./mission-domain";
import { validatePlanTransition } from "./mission-collaboration";

/**
 * Invariant #1 — only a canonical `MissionPlanProposal` (i.e. one that has
 * been through `normalizeModelPlanProposal`) may enter validation. A raw
 * model output object is never itself a `MissionPlanProposal` — the type
 * system already enforces this at the call site (`validateMissionPlanProposal`
 * takes a `MissionPlanProposal`, not `RawModelPlanOutput`), so this function
 * is a runtime restatement for callers that received an `unknown`/loosely
 * typed value (e.g. deserialized from storage) and need to check before
 * calling into `validateMissionPlanProposal`.
 */
export function isCanonicalPlanProposalShape(value: unknown): value is MissionPlanProposal {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.missionId === "string" &&
    typeof v.version === "number" &&
    typeof v.status === "string" &&
    Array.isArray(v.participantProposals) &&
    Array.isArray(v.assignmentProposals)
  );
}

/** Invariant #2 — only a Plan currently in `validating` may transition to `valid`/`invalid` (the outcome of running validation). */
export function canEnterSimulation(planStatus: PlanStatus): boolean {
  return planStatus === "valid";
}

/** Invariant #3 — only a Plan whose deterministic simulation succeeded (status `valid`, reached via `draft`/`validating` -> `valid`) may be considered simulation-success; `invalid` never is. */
export function isSimulationSuccessStatus(planStatus: PlanStatus): boolean {
  return planStatus === "valid";
}

/** Invariant #4 — only a `valid` Plan may be approved (`ApproveMissionPlan` -> `approved`). Delegates to the real transition table rather than re-listing it. */
export function canApprovePlan(planStatus: PlanStatus): boolean {
  return validatePlanTransition(planStatus, "approved").ok;
}

/**
 * Invariant #5 — only an approved Plan that is ALSO the mission's current
 * (non-superseded, non-cancelled) Plan may materialize. `validatePlanTransition`
 * alone only checks the PlanStatus edge (`approved` -> `materializing`); it does
 * not know about "current" — that is a cross-Plan concept owned by
 * `findCurrentPlanProposal` (mission-collaboration.ts). This function composes
 * both checks, which is the actual authorization gate `MaterializeMissionPlan`
 * must apply.
 */
export function canMaterializePlan(plan: MissionPlanProposal, currentPlan: MissionPlanProposal | null): boolean {
  if (!validatePlanTransition(plan.status, "materializing").ok) return false;
  if (isTerminalPlanStatus(plan.status)) return false;
  // Must be the mission's current Plan — an approved-but-stale (superseded
  // by a newer revision after approval, before materialization) Plan must
  // never materialize even though its own PlanStatus edge looks legal.
  return currentPlan !== null && currentPlan.id === plan.id;
}

/**
 * Invariant #6 — model output (a `RawModelPlanOutput`/normalized proposal)
 * can never itself carry `status`, `approval`, or materialization state.
 * `normalizeModelPlanProposal` is the only place a `MissionPlanProposal` is
 * constructed from model output, and it always mints `status: "draft"`
 * regardless of what the raw model output contained (the schema for raw
 * model output has no `status` field at all — see
 * `mission-model-plan-schema.ts`). This function is a defensive runtime
 * check for callers that want to assert the invariant explicitly rather
 * than trust it structurally.
 */
export function modelOutputCannotSetPlanState(rawModelOutput: unknown): boolean {
  if (typeof rawModelOutput !== "object" || rawModelOutput === null) return true;
  const v = rawModelOutput as Record<string, unknown>;
  return !("status" in v) && !("approvedAt" in v) && !("materializedAt" in v) && !("approvedBy" in v);
}
