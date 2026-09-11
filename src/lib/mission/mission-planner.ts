/**
 * MissionPlanner — the deterministic planning core (Phase 5A).
 * ----------------------------------------------------------------------------
 * `propose`/`validate`/`simulate` — the interface item 13 asked for. All
 * three are pure: no provider launch, no Mission mutation, no randomness.
 * `propose` builds a `MissionPlanProposal` from a procedure template and
 * resolves provider selection by matching DECLARED capabilities only (never
 * inferred from a provider's name) against `PlannerInput.availableProviders`.
 * A future model-backed planner can replace `propose` alone — `validate`
 * and `simulate` stay the same pure gate every proposal, deterministic or
 * not, must pass. Neither this module nor any planner ever becomes a source
 * of authority: everything downstream still goes through
 * `applyMissionCommand`.
 */

import type {
  AssignmentApprovalPolicy,
  AssignmentBudget,
  AssignmentScope,
  MissionId,
  MissionParticipant,
  MissionPlanProposal,
  ParticipantRole,
  PlanId,
  PlannerOperatingMode,
} from "./mission-domain";
import type { CommunicationPolicyConfig } from "./mission-communication-policy";
import { buildProcedure, defaultProcedureForMode, type ProcedureTemplateId } from "./mission-planner-templates";
import { validateMissionPlanProposal, type PlanValidationContext, type PlanValidationResult } from "./mission-planner-validator";
import { simulateMissionPlanProposal, type PlanSimulationResult } from "./mission-planner-simulator";

export interface PlannerProviderDescriptor {
  id: string;
  capabilities: Record<string, boolean>;
}

export interface PlannerInput {
  missionId: MissionId;
  objective: string;
  workspaceContext: { repository: string; repositoryId: string | null };
  applicableRules: string[];
  availableProviders: PlannerProviderDescriptor[];
  allowedRoles: ParticipantRole[];
  budget: AssignmentBudget;
  scope: AssignmentScope;
  approvalPolicy: AssignmentApprovalPolicy;
  collaborationPolicy: CommunicationPolicyConfig;
  operatingMode: PlannerOperatingMode;
  constraints: string[];
  knownParticipants?: MissionParticipant[];
  /** Overrides the operating-mode default — see `defaultProcedureForMode`. */
  procedure?: ProcedureTemplateId;
  now: string;
  createdBy: string;
  /** First version defaults to 1; a revision supplies the next number explicitly (mission-command-handler.ts derives it from the superseded Plan when going through `SupersedeMissionPlan`). */
  version?: number;
  supersedesPlanId?: PlanId | null;
}

function planIdFor(input: PlannerInput): PlanId {
  return `${input.missionId}-plan-${input.version ?? 1}`;
}

/**
 * Provider-capability resolution — deterministic, provider-neutral,
 * capability-matched. The FIRST provider in `availableProviders` (in the
 * order given — never reordered, so caller-supplied preference order is
 * what decides ties) whose DECLARED capabilities are a superset of
 * `requiredCapabilities`. No match returns `null`.
 *
 * Shared by BOTH the deterministic Planner (`propose` below) and
 * model-assisted planning (`mission-model-plan-normalizer.ts`) — a model's
 * output may declare `requiredCapabilities`, but the actual PROVIDER
 * ASSIGNMENT always runs through this same function, never a raw string a
 * model claims. This is what makes "no fabricated provider capabilities"
 * structurally true rather than merely policed: nothing downstream ever
 * reads a provider identifier out of untrusted model output.
 */
export function resolveProviderForCapabilities(requiredCapabilities: readonly string[], availableProviders: readonly PlannerProviderDescriptor[]): string | null {
  const match = availableProviders.find((provider) => requiredCapabilities.every((capability) => provider.capabilities[capability] === true));
  return match?.id ?? null;
}

/**
 * Builds the Plan and resolves provider selection deterministically: for
 * each proposed participant, the FIRST provider in `availableProviders`
 * (in the order given — never reordered, so caller-supplied preference
 * order is what decides ties) whose DECLARED capabilities are a superset
 * of `providerConstraint.requiredCapabilities`. No match leaves
 * `providerConstraint.provider` null and records an unresolved question —
 * the Plan is never silently left claiming a provider that can't actually
 * do the work.
 */
export function propose(input: PlannerInput): MissionPlanProposal {
  const templateId = input.procedure ?? defaultProcedureForMode(input.operatingMode);
  const procedure = buildProcedure(templateId, input);

  const unresolvedQuestions: string[] = [];
  const warnings: string[] = [...procedure.assumptions.length === 0 ? [] : []];

  for (const proposedParticipant of procedure.participantProposals) {
    const required = proposedParticipant.providerConstraint.requiredCapabilities;
    const match = resolveProviderForCapabilities(required, input.availableProviders);
    if (match) {
      proposedParticipant.providerConstraint.provider = match;
    } else {
      unresolvedQuestions.push(
        `No available provider honestly declares all of [${required.join(", ")}] required for participant ${proposedParticipant.proposedParticipantId} (${proposedParticipant.role}).`,
      );
    }
  }

  return {
    id: planIdFor(input),
    missionId: input.missionId,
    version: input.version ?? 1,
    status: "draft",
    objective: input.objective,
    assumptions: procedure.assumptions,
    constraints: input.constraints,
    participantProposals: procedure.participantProposals,
    assignmentProposals: procedure.assignmentProposals,
    collaborationTopology: procedure.collaborationTopology,
    evidenceRequirements: procedure.evidenceRequirements,
    approvalGates: procedure.approvalGates,
    executionLimits: { maxDurationMs: input.budget.maxDurationMs, maxEstimatedTokens: input.budget.maxEstimatedTokens },
    unresolvedQuestions,
    warnings,
    validationErrors: [],
    createdAt: input.now,
    createdBy: input.createdBy,
    supersedesPlanId: input.supersedesPlanId ?? null,
  };
}

export function validate(plan: MissionPlanProposal, context: PlanValidationContext): PlanValidationResult {
  return validateMissionPlanProposal(plan, context);
}

export function simulate(plan: MissionPlanProposal): PlanSimulationResult {
  return simulateMissionPlanProposal(plan);
}

export const MissionPlanner = { propose, validate, simulate };
