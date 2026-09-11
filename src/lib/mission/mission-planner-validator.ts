/**
 * Plan validator — Phase 5A.
 * ----------------------------------------------------------------------------
 * Pure: same Plan + same context, same verdict, every time. Returns typed
 * errors AND warnings, never a bare boolean — an "executable: true/false"
 * flag alone would hide exactly the uncertainty this phase is required to
 * surface. This is the one gate every proposal must pass regardless of
 * which Planner produced it (deterministic today, model-backed later) —
 * see mission-planner.ts's doc comment.
 */

import type { AssignmentScope, MissionPlanProposal, ParticipantCommunicationPermissions, ProposedAssignment, ProposedParticipant } from "./mission-domain";
import { validateScopeNarrowing } from "./mission-collaboration-graph";

const RECOGNIZED_DISPATCH_CONDITIONS = ["assignee_active", "dependencies_satisfied"] as const;
const RECOGNIZED_COMPLETION_CRITERIA = [
  "completion_notice_submitted",
  "review_completed_no_blocking_findings",
  "verification_passed",
  "investigation_notes_submitted",
] as const;
const RECOGNIZED_EVIDENCE_PREFIX = "evidence://";

export type PlanValidationErrorCode =
  | "assignment_missing_participant"
  | "dependency_references_unknown_assignment"
  | "dependency_cycle"
  | "provider_capability_unresolved"
  | "assignment_scope_exceeds_mission_scope"
  | "self_review_not_distinct"
  | "approval_authority_unavailable"
  | "budget_exceeds_mission_limit"
  | "unrecognized_dispatch_condition"
  | "unrecognized_completion_criterion"
  | "unrecognized_evidence_requirement"
  | "unreachable_completion_condition"
  | "prerequisite_for_impossible_work";

export interface PlanValidationError {
  code: PlanValidationErrorCode;
  assignmentId?: string;
  participantId?: string;
  detail: string;
}

export interface PlanValidationResult {
  ok: boolean;
  errors: PlanValidationError[];
  warnings: string[];
}

export interface PlanValidationContext {
  missionScope: AssignmentScope;
  missionBudget: { maxDurationMs: number | null; maxEstimatedTokens: number | null };
  /** Participant ids/roles already known to exist in the Mission, in addition to whatever this Plan itself proposes — a revision may reference an already-materialized participant instead of proposing a new one. */
  existingParticipants?: Record<string, { role: string; communicationPermissions: ParticipantCommunicationPermissions }>;
  /** Authorities recognized as able to satisfy an approval gate — e.g. ["human"], or a specific role name. Never assumed satisfiable if empty. */
  availableApprovalAuthorities: string[];
}

function budgetExceeds(assignmentBudget: ProposedAssignment["budget"], missionBudget: PlanValidationContext["missionBudget"]): boolean {
  if (missionBudget.maxDurationMs !== null && (assignmentBudget.maxDurationMs === null || assignmentBudget.maxDurationMs > missionBudget.maxDurationMs)) return true;
  if (missionBudget.maxEstimatedTokens !== null && (assignmentBudget.maxEstimatedTokens === null || assignmentBudget.maxEstimatedTokens > missionBudget.maxEstimatedTokens)) return true;
  return false;
}

/** Kahn's algorithm over the Plan's OWN proposed-assignment dependency graph — independent of `mission-collaboration-graph.ts`'s materialized-assignment cycle check, since these ids aren't real `AssignmentId`s yet. */
function findDependencyCycle(assignments: ProposedAssignment[]): string[] | null {
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const a of assignments) inDegree.set(a.proposedAssignmentId, 0);
  for (const a of assignments) {
    for (const dep of a.dependencies) {
      inDegree.set(a.proposedAssignmentId, (inDegree.get(a.proposedAssignmentId) ?? 0) + 1);
      dependents.set(dep, [...(dependents.get(dep) ?? []), a.proposedAssignmentId]);
    }
  }
  const queue = [...inDegree.entries()].filter(([, deg]) => deg === 0).map(([id]) => id);
  const visited = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    visited.add(id);
    for (const dependent of dependents.get(id) ?? []) {
      inDegree.set(dependent, (inDegree.get(dependent) ?? 0) - 1);
      if (inDegree.get(dependent) === 0) queue.push(dependent);
    }
  }
  const remaining = assignments.map((a) => a.proposedAssignmentId).filter((id) => !visited.has(id));
  return remaining.length > 0 ? remaining : null;
}

export function validateMissionPlanProposal(plan: MissionPlanProposal, context: PlanValidationContext): PlanValidationResult {
  const errors: PlanValidationError[] = [];
  const warnings: string[] = [...plan.warnings];

  const proposedParticipantIds = new Set(plan.participantProposals.map((p) => p.proposedParticipantId));
  const proposedAssignmentIds = new Set(plan.assignmentProposals.map((a) => a.proposedAssignmentId));
  const existingParticipants = context.existingParticipants ?? {};

  // ---- every assignment has a valid participant ----------------------------
  for (const a of plan.assignmentProposals) {
    if (a.proposedAssigneeId === null) continue;
    if (!proposedParticipantIds.has(a.proposedAssigneeId) && !(a.proposedAssigneeId in existingParticipants)) {
      errors.push({ code: "assignment_missing_participant", assignmentId: a.proposedAssignmentId, detail: `Assignment ${a.proposedAssignmentId} references unknown participant ${a.proposedAssigneeId}.` });
    }
  }

  // ---- dependency references + acyclic --------------------------------------
  for (const a of plan.assignmentProposals) {
    for (const dep of a.dependencies) {
      if (!proposedAssignmentIds.has(dep)) {
        errors.push({ code: "dependency_references_unknown_assignment", assignmentId: a.proposedAssignmentId, detail: `Assignment ${a.proposedAssignmentId} depends on unknown assignment ${dep}.` });
      }
    }
  }
  const cycle = findDependencyCycle(plan.assignmentProposals);
  if (cycle) errors.push({ code: "dependency_cycle", detail: `Dependency graph is cyclic among: ${cycle.join(", ")}.` });

  // ---- provider capability resolution ----------------------------------------
  for (const p of plan.participantProposals) {
    if (p.providerConstraint.provider === null) {
      errors.push({ code: "provider_capability_unresolved", participantId: p.proposedParticipantId, detail: `No provider satisfies participant ${p.proposedParticipantId}'s required capabilities honestly.` });
    }
  }

  // ---- scope containment: an assignment can never exceed Mission scope ------
  for (const a of plan.assignmentProposals) {
    const narrowing = validateScopeNarrowing(context.missionScope, a.scope);
    if (!narrowing.ok) {
      errors.push({ code: "assignment_scope_exceeds_mission_scope", assignmentId: a.proposedAssignmentId, detail: `Assignment ${a.proposedAssignmentId} scope exceeds the Mission's own authority (excess allowed paths: ${narrowing.excessAllowedPaths.join(", ") || "none"}; dropped prohibitions: ${narrowing.droppedProhibitedPaths.join(", ") || "none"}).` });
    }
  }

  // ---- self-review distinctness for "review" collaboration edges ------------
  for (const edge of plan.collaborationTopology) {
    if (edge.kind !== "review") continue;
    const reviewer = plan.assignmentProposals.find((a) => a.proposedAssignmentId === edge.fromProposedId)?.proposedAssigneeId;
    const reviewee = plan.assignmentProposals.find((a) => a.proposedAssignmentId === edge.toProposedId)?.proposedAssigneeId;
    if (reviewer && reviewee && reviewer === reviewee) {
      errors.push({ code: "self_review_not_distinct", assignmentId: edge.fromProposedId, detail: `Review edge ${edge.fromProposedId} -> ${edge.toProposedId} assigns the same participant to both sides.` });
    }
  }

  // ---- approval authority named and available --------------------------------
  for (const a of plan.assignmentProposals) {
    if (a.approvalPolicy === "human_required" && !context.availableApprovalAuthorities.includes("human")) {
      errors.push({ code: "approval_authority_unavailable", assignmentId: a.proposedAssignmentId, detail: `Assignment ${a.proposedAssignmentId} requires human approval, but no human authority is available to this Mission.` });
    }
  }

  // ---- budgets within Mission limits ------------------------------------------
  for (const a of plan.assignmentProposals) {
    if (budgetExceeds(a.budget, context.missionBudget)) {
      errors.push({ code: "budget_exceeds_mission_limit", assignmentId: a.proposedAssignmentId, detail: `Assignment ${a.proposedAssignmentId}'s budget exceeds the Mission's own limit.` });
    }
  }

  // ---- dispatch conditions / completion criteria / evidence recognized ------
  for (const a of plan.assignmentProposals) {
    for (const condition of a.dispatchEligibilityConditions) {
      if (!(RECOGNIZED_DISPATCH_CONDITIONS as readonly string[]).includes(condition)) {
        errors.push({ code: "unrecognized_dispatch_condition", assignmentId: a.proposedAssignmentId, detail: `"${condition}" is not a recognized dispatch condition.` });
      }
    }
    if (a.completionCriteria.length === 0) {
      errors.push({ code: "unreachable_completion_condition", assignmentId: a.proposedAssignmentId, detail: `Assignment ${a.proposedAssignmentId} has no completion criteria at all — it could never be considered done.` });
    }
    for (const criterion of a.completionCriteria) {
      if (!(RECOGNIZED_COMPLETION_CRITERIA as readonly string[]).includes(criterion)) {
        errors.push({ code: "unrecognized_completion_criterion", assignmentId: a.proposedAssignmentId, detail: `"${criterion}" is not a recognized completion criterion.` });
      }
    }
    for (const evidenceRef of a.requiredEvidence) {
      if (!evidenceRef.startsWith(RECOGNIZED_EVIDENCE_PREFIX)) {
        errors.push({ code: "unrecognized_evidence_requirement", assignmentId: a.proposedAssignmentId, detail: `"${evidenceRef}" is not a recognized evidence reference shape (expected an "${RECOGNIZED_EVIDENCE_PREFIX}" prefix).` });
      }
    }
  }

  // ---- no terminal assignment is a prerequisite for impossible work ---------
  // "Impossible" here means: a dependency chain that terminates in an
  // assignment already flagged as having a missing/cyclic/unresolvable
  // dependency graph. Reported once per affected assignment, not duplicated
  // per already-reported cause.
  if (cycle) {
    const cycleSet = new Set(cycle);
    for (const a of plan.assignmentProposals) {
      if (a.dependencies.some((dep) => cycleSet.has(dep)) && !cycleSet.has(a.proposedAssignmentId)) {
        errors.push({ code: "prerequisite_for_impossible_work", assignmentId: a.proposedAssignmentId, detail: `Assignment ${a.proposedAssignmentId} depends on work inside a cyclic (impossible) dependency chain.` });
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

export type { ProposedParticipant };
