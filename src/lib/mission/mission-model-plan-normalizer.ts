/**
 * Model plan normalization — Phase 5B §9.
 * ----------------------------------------------------------------------------
 * Converts a SCHEMA-VALIDATED `RawModelPlanOutput` (mission-model-plan-schema.ts)
 * into the exact canonical `MissionPlanProposal` domain type — the SAME
 * type Phase 5A's deterministic Planner produces. No parallel authoritative
 * type (`AiMissionPlan`/`LlmPlan`/...) exists anywhere in this module or
 * downstream of it.
 *
 * Deterministic: the same normalized `RawModelPlanOutput` + the same
 * `PlannerProviderDescriptor[]` always produces byte-identical output,
 * including ids — model-local ids are mapped to
 * `${missionId}-plan-participant-<n>`/`${missionId}-plan-assignment-<n>`
 * using the SORTED ORDER of the model's own local ids (never the order
 * they happened to appear in the JSON array), so two logically-identical
 * proposals normalize identically regardless of key/array ordering the
 * model produced.
 *
 * Provider assignment is ALWAYS computed via
 * `resolveProviderForCapabilities` (mission-planner.ts) against the
 * caller's own trusted `availableProviders` — the model's
 * `requiredCapabilities` declaration is a REQUEST, never a provider
 * identity, and nothing here ever reads a provider string out of model
 * output (the schema doesn't even have a field for one).
 */

import type { AssignmentScope, MissionId, PlanCollaborationEdge, PlanId, ProposedAssignment, ProposedParticipant } from "./mission-domain";
import type { RawModelPlanOutput } from "./mission-model-plan-schema";
import { resolveProviderForCapabilities, type PlannerProviderDescriptor } from "./mission-planner";
import { checkTemplateSafeguards, type ProcedureTemplateId } from "./mission-planner-templates";
import { canonicalizeRepoPath } from "./mission-path-containment";
import type { MissionPlanProposal } from "./mission-domain";

export interface NormalizeModelPlanInput {
  missionId: MissionId;
  version: number;
  supersedesPlanId: PlanId | null;
  raw: RawModelPlanOutput;
  availableProviders: readonly PlannerProviderDescriptor[];
  now: string;
  createdBy: string;
}

export interface NormalizeModelPlanResult {
  proposal: MissionPlanProposal;
  /** Populated by `checkTemplateSafeguards` — a non-empty array means the caller must treat this as invalid before it ever reaches `validateMissionPlanProposal`, since it describes a mandatory-safeguard removal the domain validator has no template-awareness to catch on its own. */
  templateSafeguardViolations: string[];
}

/** Canonical repo-relative path form — trailing slash / '.' collapse handled by the SAME canonicalizer scope validation already uses, so a model's "src/" and "src" always normalize identically. */
function normalizePath(raw: string): string {
  const canonical = canonicalizeRepoPath(raw);
  return canonical.ok ? (canonical.segments.length === 0 ? "." : canonical.segments.join("/")) : raw;
}

function normalizeScope(allowedPaths: string[], prohibitedPaths: string[]): AssignmentScope {
  return {
    allowedPaths: [...new Set(allowedPaths.map(normalizePath))].sort(),
    prohibitedPaths: [...new Set(prohibitedPaths.map(normalizePath))].sort(),
  };
}

export function normalizeModelPlanProposal(input: NormalizeModelPlanInput): NormalizeModelPlanResult {
  const { raw, missionId } = input;

  // Deterministic id mapping: sort by the MODEL's own local id string —
  // stable regardless of array order in the raw JSON.
  const participantIdMap = new Map<string, string>();
  const sortedParticipants = [...raw.participants].sort((a, b) => a.participantId.localeCompare(b.participantId));
  sortedParticipants.forEach((p, i) => participantIdMap.set(p.participantId, `${missionId}-plan-participant-${i + 1}`));

  const assignmentIdMap = new Map<string, string>();
  const sortedAssignments = [...raw.assignments].sort((a, b) => a.assignmentId.localeCompare(b.assignmentId));
  sortedAssignments.forEach((a, i) => assignmentIdMap.set(a.assignmentId, `${missionId}-plan-assignment-${i + 1}`));

  const unresolvedQuestions = [...raw.unresolvedQuestions];

  const participantProposals: ProposedParticipant[] = sortedParticipants.map((p) => {
    const provider = resolveProviderForCapabilities(p.requiredCapabilities, input.availableProviders);
    if (!provider) {
      unresolvedQuestions.push(`No available provider honestly declares all of [${p.requiredCapabilities.join(", ")}] required for participant ${participantIdMap.get(p.participantId)} (${p.role}).`);
    }
    return {
      proposedParticipantId: participantIdMap.get(p.participantId)!,
      role: p.role as ProposedParticipant["role"],
      providerConstraint: { provider, requiredCapabilities: [...p.requiredCapabilities].sort() },
      workspacePermissions: { allowedPaths: normalizeScope(p.allowedPaths, p.prohibitedPaths).allowedPaths, prohibitedPaths: normalizeScope(p.allowedPaths, p.prohibitedPaths).prohibitedPaths },
      communicationPermissions: { canBroadcast: false, canDelegate: false, maxDelegationDepth: 0 },
      rationale: p.rationale,
    };
  });

  const assignmentProposals: ProposedAssignment[] = sortedAssignments.map((a) => {
    const scope = normalizeScope(a.allowedPaths, a.prohibitedPaths);
    return {
      proposedAssignmentId: assignmentIdMap.get(a.assignmentId)!,
      proposedAssigneeId: a.assigneeId ? (participantIdMap.get(a.assigneeId) ?? null) : null,
      objective: a.objective,
      scope,
      dependencies: [...a.dependencies].map((d) => assignmentIdMap.get(d)!).sort(),
      requiredEvidence: [...new Set(a.requiredEvidence)].sort(),
      approvalPolicy: a.approvalPolicy as ProposedAssignment["approvalPolicy"],
      budget: { maxDurationMs: a.maxDurationMs, maxEstimatedTokens: a.maxEstimatedTokens },
      dispatchEligibilityConditions: [...new Set(a.dispatchEligibilityConditions)].sort(),
      completionCriteria: [...new Set(a.completionCriteria)].sort(),
    };
  });

  const collaborationTopology: PlanCollaborationEdge[] = [...raw.collaborationTopology]
    .map((e) => ({ fromProposedId: assignmentIdMap.get(e.from)!, toProposedId: assignmentIdMap.get(e.to)!, kind: e.kind as PlanCollaborationEdge["kind"] }))
    .sort((a, b) => (a.fromProposedId + a.toProposedId + a.kind).localeCompare(b.fromProposedId + b.toProposedId + b.kind));

  const proposal: MissionPlanProposal = {
    id: `${missionId}-plan-${input.version}`,
    missionId,
    version: input.version,
    status: "draft",
    objective: raw.interpretedObjective,
    assumptions: [...new Set(raw.assumptions)].sort(),
    constraints: [],
    participantProposals,
    assignmentProposals,
    collaborationTopology,
    evidenceRequirements: [...new Set(raw.evidenceRequirements)].sort(),
    approvalGates: [...new Set(raw.approvalGates)].sort(),
    executionLimits: raw.executionLimits,
    unresolvedQuestions: [...new Set(unresolvedQuestions)].sort(),
    warnings: [...new Set(raw.warnings)].sort(),
    validationErrors: [],
    createdAt: input.now,
    createdBy: input.createdBy,
    supersedesPlanId: input.supersedesPlanId,
  };

  const templateSafeguardViolations = checkTemplateSafeguards(raw.procedureTemplate as ProcedureTemplateId, proposal);

  return { proposal, templateSafeguardViolations };
}
