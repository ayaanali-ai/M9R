/**
 * Mission collaboration — pure transition rules for participants and
 * assignments (Phase 4A).
 * ----------------------------------------------------------------------------
 * Deliberately NOT a second Mission state machine. `Mission.state`
 * (mission-state-machine.ts) still governs the Mission itself; these are two
 * SEPARATE, smaller state machines for the sub-entities this phase
 * introduces — the same layering `mission-execution.ts`'s `ExecutionState`
 * and `mission-scheduler.ts`'s `DispatchLeaseState` already established
 * relative to `Mission.state` and to each other. A participant can be
 * `active` while its current assignment is `blocked`; an assignment can be
 * `running` while the dispatch lease backing it has already expired — three
 * different facts, on purpose.
 */

import {
  isTerminalAssignmentStatus,
  isTerminalFindingStatus,
  isTerminalParticipantStatus,
  type AssignmentStatus,
  type FindingStatus,
  type MissionAssignment,
  type MissionFinding,
  type ParticipantStatus,
} from "./mission-domain";

// ---------------------------------------------------------------------------
// Participant transitions
// ---------------------------------------------------------------------------

const PARTICIPANT_TRANSITIONS: Record<ParticipantStatus, readonly ParticipantStatus[]> = {
  // "active" reachable directly from "proposed" — this phase's command set
  // has no separate "mark participant ready" command, so `ActivateParticipant`
  // covers proposed/ready/waiting/blocked -> active in one step. "ready" stays
  // a legal target for a future command that wants the intermediate state.
  proposed: ["ready", "active", "removed"],
  ready: ["active", "removed"],
  active: ["waiting", "blocked", "completed", "failed", "removed"],
  waiting: ["active", "blocked", "removed"],
  blocked: ["active", "removed"],
  completed: [],
  failed: [],
  removed: [],
};

export interface ParticipantTransitionResult {
  ok: boolean;
  errors: string[];
}

/**
 * `removed` is reachable from every non-terminal state (a human or
 * reconciler can remove a participant at any point short of it already
 * being terminal) — modeled as an explicit allowance on every non-terminal
 * row above, not a blanket bypass, so a terminal participant still can't be
 * "removed" a second time.
 */
export function validateParticipantTransition(from: ParticipantStatus, to: ParticipantStatus): ParticipantTransitionResult {
  if (isTerminalParticipantStatus(from)) {
    return { ok: false, errors: [`Participant status '${from}' is terminal — further transitions require a new participant.`] };
  }
  if (!PARTICIPANT_TRANSITIONS[from].includes(to)) {
    return { ok: false, errors: [`Participant cannot move from '${from}' to '${to}'.`] };
  }
  return { ok: true, errors: [] };
}

// ---------------------------------------------------------------------------
// Assignment transitions
// ---------------------------------------------------------------------------

const ASSIGNMENT_TRANSITIONS: Record<AssignmentStatus, readonly AssignmentStatus[]> = {
  // "claimed" reachable directly from "proposed" — `AssignAssignment` covers
  // proposed/ready -> claimed in one step, matching the participant table's
  // same shortcut and this phase's command set (no separate "mark ready").
  proposed: ["ready", "claimed", "cancelled"],
  ready: ["claimed", "cancelled"],
  claimed: ["running", "cancelled", "failed"],
  running: ["waiting_for_input", "blocked", "submitted", "failed", "cancelled"],
  waiting_for_input: ["running", "blocked", "cancelled", "failed"],
  blocked: ["running", "cancelled", "failed"],
  submitted: ["verified", "rejected", "failed"],
  verified: ["accepted", "rejected"],
  accepted: [],
  rejected: [],
  cancelled: [],
  failed: [],
};

export interface AssignmentTransitionResult {
  ok: boolean;
  errors: string[];
}

export function validateAssignmentTransition(from: AssignmentStatus, to: AssignmentStatus): AssignmentTransitionResult {
  if (isTerminalAssignmentStatus(from)) {
    return { ok: false, errors: [`Assignment status '${from}' is terminal — further work requires a new assignment.`] };
  }
  if (!ASSIGNMENT_TRANSITIONS[from].includes(to)) {
    return { ok: false, errors: [`Assignment cannot move from '${from}' to '${to}'.`] };
  }
  return { ok: true, errors: [] };
}

// ---------------------------------------------------------------------------
// Dependencies — an assignment cannot start until every dependency has
// reached a genuinely successful terminal state
// ---------------------------------------------------------------------------

export interface DependencyCheckResult {
  ok: boolean;
  /** Dependency assignment ids that are missing entirely or not yet `accepted`. */
  unsatisfied: string[];
}

/**
 * Only `accepted` counts as "done" for a dependency — `verified` isn't
 * enough (a verified-but-not-yet-accepted assignment can still be
 * rejected), and a dependency that doesn't exist in the projection at all
 * is never silently treated as satisfied.
 */
export function checkDependenciesSatisfied(assignment: Pick<MissionAssignment, "dependencies">, assignments: Record<string, MissionAssignment>): DependencyCheckResult {
  const unsatisfied = assignment.dependencies.filter((dependencyId) => assignments[dependencyId]?.status !== "accepted");
  return { ok: unsatisfied.length === 0, unsatisfied };
}

// ---------------------------------------------------------------------------
// Finding transitions (Phase 4B)
// ---------------------------------------------------------------------------

const FINDING_TRANSITIONS: Record<FindingStatus, readonly FindingStatus[]> = {
  opened: ["acknowledged", "disputed", "withdrawn"],
  acknowledged: ["remediation_requested", "disputed", "verified", "withdrawn"],
  disputed: ["acknowledged", "unresolved", "withdrawn"],
  remediation_requested: ["remediation_submitted", "unresolved", "withdrawn"],
  remediation_submitted: ["verified", "remediation_requested", "unresolved"],
  unresolved: ["acknowledged", "closed", "withdrawn"],
  verified: ["closed"],
  withdrawn: [],
  closed: [],
};

export interface FindingTransitionResult {
  ok: boolean;
  errors: string[];
}

export function validateFindingTransition(from: FindingStatus, to: FindingStatus): FindingTransitionResult {
  if (isTerminalFindingStatus(from)) {
    return { ok: false, errors: [`Finding status '${from}' is terminal.`] };
  }
  if (!FINDING_TRANSITIONS[from].includes(to)) {
    return { ok: false, errors: [`Finding cannot move from '${from}' to '${to}'.`] };
  }
  return { ok: true, errors: [] };
}

/**
 * Whether an assignment's OPEN findings should block its verification —
 * an explicit policy decision (never assumed): a finding existing at all is
 * NOT the same fact as it blocking anything. Only findings in a
 * non-terminal, non-`acknowledged`-as-accepted-risk state count as
 * "blocking" here; `withdrawn`/`closed`/`verified` findings never do, and
 * `acknowledged` is deliberately treated as blocking too (acknowledging a
 * finding is not the same as resolving it).
 */
const BLOCKING_FINDING_STATUSES: readonly FindingStatus[] = ["opened", "acknowledged", "disputed", "remediation_requested", "remediation_submitted", "unresolved"];

export function findingsBlockingVerification(findings: MissionFinding[]): MissionFinding[] {
  return findings.filter((finding) => BLOCKING_FINDING_STATUSES.includes(finding.status));
}

// ---------------------------------------------------------------------------
// Plan proposal transitions (Phase 5A)
// ---------------------------------------------------------------------------

import { isTerminalPlanStatus, type PlanStatus } from "./mission-domain";

/**
 * "validating" (from the suggested status list) is deliberately never a
 * PERSISTED status — validation is synchronous and pure
 * (`mission-planner-validator.ts`), so `ValidateMissionPlan` goes directly
 * from `draft`/`invalid` to `valid`/`invalid` in one event, with no
 * transient state worth its own history entry. `active` is reached only
 * via materialization, never a self-transition; `superseded` is something
 * that happens TO an older Plan when a newer one is created, not a status
 * the old Plan's own command chooses.
 */
// Phase 5B §14: "cancelled" is now reachable — `CancelMissionPlan` explicitly
// covers draft/invalid/valid/approved-but-unmaterialized (matching the
// audit's own determination that materialized-Plan cancellation is
// rejected, not supported). Previously a real, stated Phase 5A limitation
// ("no command reaches 'cancelled' this phase") — closed here, not removed
// silently: the PlanStatus enum value existed since Phase 5A specifically
// so this could be wired up without a domain-shape change.
const PLAN_TRANSITIONS: Record<PlanStatus, readonly PlanStatus[]> = {
  draft: ["valid", "invalid", "rejected", "superseded", "cancelled"],
  validating: ["valid", "invalid", "rejected"],
  valid: ["approved", "invalid", "rejected", "superseded", "cancelled"],
  invalid: ["valid", "rejected", "superseded", "cancelled"],
  approved: ["materializing", "rejected", "superseded", "cancelled"],
  materializing: ["active"],
  active: [],
  superseded: [],
  rejected: [],
  cancelled: [],
};

export interface PlanTransitionResult {
  ok: boolean;
  errors: string[];
}

export function validatePlanTransition(from: PlanStatus, to: PlanStatus): PlanTransitionResult {
  if (isTerminalPlanStatus(from)) {
    return { ok: false, errors: [`Plan status '${from}' is terminal — a revision requires a new Plan version.`] };
  }
  if (!PLAN_TRANSITIONS[from].includes(to)) {
    return { ok: false, errors: [`Plan cannot move from '${from}' to '${to}'.`] };
  }
  return { ok: true, errors: [] };
}

// ---------------------------------------------------------------------------
// Planning request transitions (Phase 5B)
// ---------------------------------------------------------------------------

import {
  isTerminalPlanningRequestStatus,
  type PlanId,
  type PlanningRequestKind,
  type PlanningRequestRecord,
  type PlanningRequestStatus,
  type MissionPlanProposal,
} from "./mission-domain";

const PLANNING_REQUEST_TRANSITIONS: Record<PlanningRequestStatus, readonly PlanningRequestStatus[]> = {
  // A repair re-attempt goes back to "requested" from "in_progress" —
  // never a separate "repairing" status; `attemptCount` on the record is
  // what distinguishes a first attempt from a bounded repair retry.
  requested: ["in_progress", "cancelled", "stale", "superseded"],
  in_progress: ["requested", "completed", "failed", "cancelled", "stale", "superseded"],
  completed: [],
  failed: [],
  cancelled: [],
  stale: [],
  superseded: [],
};

export interface PlanningRequestTransitionResult {
  ok: boolean;
  errors: string[];
}

export function validatePlanningRequestTransition(from: PlanningRequestStatus, to: PlanningRequestStatus): PlanningRequestTransitionResult {
  if (isTerminalPlanningRequestStatus(from)) {
    return { ok: false, errors: [`Planning request status '${from}' is terminal.`] };
  }
  if (!PLANNING_REQUEST_TRANSITIONS[from].includes(to)) {
    return { ok: false, errors: [`Planning request cannot move from '${from}' to '${to}'.`] };
  }
  return { ok: true, errors: [] };
}

// ---------------------------------------------------------------------------
// Planning request / Plan discoverability (Phase 5D §5 — supersession)
// ---------------------------------------------------------------------------

/**
 * The "slot" a planning request occupies for supersession purposes: two
 * outstanding requests of the same `kind` targeting the same `basePlanId`
 * (both `null` for the mission's initial `proposal`, or both the same real
 * Plan id for a `revision`) are racing for the same lineage — creating a
 * new one must supersede the old one, never let both resolve independently.
 */
export interface PlanningRequestSlot {
  missionId: string;
  kind: PlanningRequestKind;
  basePlanId: PlanId | null;
}

/**
 * Find the current outstanding (`requested` | `in_progress`) planning
 * request occupying the given slot, if any. At most one should ever exist
 * by construction (this function is what `RequestModelPlanning` calls
 * before minting a new request, to supersede whatever it finds) — but a
 * caller should not assume that invariant holds if it skips the check.
 */
export function findOutstandingPlanningRequestForSlot(
  planningRequests: Record<string, PlanningRequestRecord>,
  slot: PlanningRequestSlot,
): PlanningRequestRecord | null {
  for (const record of Object.values(planningRequests)) {
    if (record.missionId !== slot.missionId) continue;
    if (record.kind !== slot.kind) continue;
    if (record.basePlanId !== slot.basePlanId) continue;
    if (record.status !== "requested" && record.status !== "in_progress") continue;
    return record;
  }
  return null;
}

/**
 * The mission's current "live" Plan — the highest-version Plan proposal
 * that is not itself terminal-superseded/rejected/cancelled. Used for
 * supersession-lineage comparisons and general discoverability (Phase 5D
 * §5's "discover the current Plan version" requirement); never authoritative
 * for approval/materialization gating, which stays with `PLAN_TRANSITIONS`.
 */
export function findCurrentPlanProposal(planProposals: Record<PlanId, MissionPlanProposal>): MissionPlanProposal | null {
  let current: MissionPlanProposal | null = null;
  for (const proposal of Object.values(planProposals)) {
    if (proposal.status === "superseded" || proposal.status === "rejected" || proposal.status === "cancelled") continue;
    if (!current || proposal.version > current.version) current = proposal;
  }
  return current;
}
