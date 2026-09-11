/**
 * Plan simulator — Phase 5A.
 * ----------------------------------------------------------------------------
 * A pure dry run: computes what WOULD happen if this Plan were materialized
 * and dispatched, without launching anything or touching Mission state.
 * Never calls a provider, never mutates anything — the simulator's entire
 * contract is "read the Plan, compute facts about it."
 */

import type { MissionPlanProposal } from "./mission-domain";

export interface PlanSimulationResult {
  /** Topologically-ordered proposedAssignmentIds — undefined for any assignment inside a cycle (the validator, not the simulator, is the authority on cycle rejection; the simulator just can't order what isn't orderable). */
  topologicalOrder: string[];
  /** Assignments with no unmet dependency — immediately dispatch-eligible once materialized and assigned. */
  initiallyReady: string[];
  /** Assignments waiting on at least one dependency. */
  blockedByDependency: string[];
  collaborationLinks: MissionPlanProposal["collaborationTopology"];
  /** Proposed assignment ids whose approvalPolicy is human_required. */
  requiredApprovalPoints: string[];
  /** Participants the Plan could not resolve a provider for — a real failure mode, not a warning the simulator invents independently (mission-planner-validator.ts already reports the same fact as an error; this just surfaces it in simulation terms). */
  possibleCapabilityFailures: string[];
  /** Every assignment id reachable when nothing is blocked forever — i.e. NOT inside the unordered remainder of a cycle. */
  reachableAssignments: string[];
  /** Assignment ids left out of `topologicalOrder` because they're inside (or depend on) a cycle. */
  unreachableAssignments: string[];
  /** The largest `dependencies.length` chain depth found — a proxy for delegation/dependency depth BEFORE any real delegation exists (this Plan hasn't been materialized yet, so no real DispatchLease/child-assignment depth is possible). */
  maxDependencyChainDepth: number;
  /** Assignment ids with no dependents — the Plan's own terminal/leaf work, whose completion criteria being met is what "the Plan succeeded" means. */
  terminalSuccessConditions: string[];
}

export function simulateMissionPlanProposal(plan: MissionPlanProposal): PlanSimulationResult {
  const ids = plan.assignmentProposals.map((a) => a.proposedAssignmentId);
  const depsOf = new Map(plan.assignmentProposals.map((a) => [a.proposedAssignmentId, a.dependencies]));
  const dependents = new Map<string, string[]>();
  for (const a of plan.assignmentProposals) {
    for (const dep of a.dependencies) dependents.set(dep, [...(dependents.get(dep) ?? []), a.proposedAssignmentId]);
  }

  // Kahn's algorithm — produces a valid topological order for the acyclic
  // portion; anything left over is unreachable (inside or downstream of a
  // cycle), reported separately rather than silently included out of order.
  const inDegree = new Map(ids.map((id) => [id, depsOf.get(id)?.length ?? 0]));
  const queue = ids.filter((id) => (inDegree.get(id) ?? 0) === 0);
  const order: string[] = [];
  const remainingInDegree = new Map(inDegree);
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id) ?? []) {
      remainingInDegree.set(dependent, (remainingInDegree.get(dependent) ?? 0) - 1);
      if (remainingInDegree.get(dependent) === 0) queue.push(dependent);
    }
  }
  const unreachable = ids.filter((id) => !order.includes(id));

  const initiallyReady = plan.assignmentProposals.filter((a) => a.dependencies.length === 0).map((a) => a.proposedAssignmentId);
  const blockedByDependency = plan.assignmentProposals.filter((a) => a.dependencies.length > 0).map((a) => a.proposedAssignmentId);
  const requiredApprovalPoints = plan.assignmentProposals.filter((a) => a.approvalPolicy === "human_required").map((a) => a.proposedAssignmentId);
  const possibleCapabilityFailures = plan.participantProposals.filter((p) => p.providerConstraint.provider === null).map((p) => p.proposedParticipantId);
  const terminalSuccessConditions = ids.filter((id) => !(dependents.get(id)?.length));

  function chainDepth(id: string, visiting: Set<string>): number {
    if (visiting.has(id)) return 0; // cyclic — don't recurse forever; the validator rejects this Plan anyway
    const deps = depsOf.get(id) ?? [];
    if (deps.length === 0) return 0;
    const nextVisiting = new Set(visiting).add(id);
    return 1 + Math.max(...deps.map((dep) => chainDepth(dep, nextVisiting)));
  }
  const maxDependencyChainDepth = ids.length === 0 ? 0 : Math.max(...ids.map((id) => chainDepth(id, new Set())));

  return {
    topologicalOrder: order,
    initiallyReady,
    blockedByDependency,
    collaborationLinks: plan.collaborationTopology,
    requiredApprovalPoints,
    possibleCapabilityFailures,
    reachableAssignments: order,
    unreachableAssignments: unreachable,
    maxDependencyChainDepth,
    terminalSuccessConditions,
  };
}
