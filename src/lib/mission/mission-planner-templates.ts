/**
 * Procedure templates — the deterministic Planner's known procedures
 * (Phase 5A).
 * ----------------------------------------------------------------------------
 * Every template is a PURE function of `PlannerInput`: same input, same
 * proposal, every time — no randomness, no clock reads beyond `input.now`,
 * no provider launch args embedded (a template describes WHO does WHAT
 * under which policy, never a CLI invocation — that's
 * `mission-provider-adapter*.ts`'s job, several layers downstream of
 * anything a Plan touches).
 *
 * IDs are derived, not random: `${missionId}-plan-participant-<n>` /
 * `${missionId}-plan-assignment-<n>`, stable for the same missionId and
 * template — this is what makes "the same normalized input produces the
 * same Plan" true, including identity, not just content.
 */

import type {
  AssignmentBudget,
  AssignmentScope,
  ParticipantCommunicationPermissions,
  ParticipantWorkspacePermissions,
  PlanCollaborationEdge,
  ProposedAssignment,
  ProposedParticipant,
} from "./mission-domain";
import type { PlannerInput } from "./mission-planner";

export const PROCEDURE_TEMPLATE_IDS = [
  "solo_implementation",
  "implementation_review_pair",
  "implementation_security_review",
  "implementation_test_verification",
  "investigation_then_implementation",
] as const;
export type ProcedureTemplateId = (typeof PROCEDURE_TEMPLATE_IDS)[number];

export interface ProcedureOutput {
  participantProposals: ProposedParticipant[];
  assignmentProposals: ProposedAssignment[];
  collaborationTopology: PlanCollaborationEdge[];
  evidenceRequirements: string[];
  approvalGates: string[];
  assumptions: string[];
}

function defaultCommsPermissions(canDelegate: boolean): ParticipantCommunicationPermissions {
  return { canBroadcast: false, canDelegate, maxDelegationDepth: canDelegate ? 1 : 0 };
}

function defaultWorkspacePermissions(scope: AssignmentScope): ParticipantWorkspacePermissions {
  return { allowedPaths: scope.allowedPaths, prohibitedPaths: scope.prohibitedPaths };
}

function participant(id: string, role: ProposedParticipant["role"], requiredCapabilities: string[], scope: AssignmentScope, rationale: string, canDelegate = false): ProposedParticipant {
  return {
    proposedParticipantId: id,
    role,
    providerConstraint: { provider: null, requiredCapabilities },
    workspacePermissions: defaultWorkspacePermissions(scope),
    communicationPermissions: defaultCommsPermissions(canDelegate),
    rationale,
  };
}

function assignment(id: string, assigneeId: string | null, objective: string, scope: AssignmentScope, dependencies: string[], requiredEvidence: string[], budget: AssignmentBudget, approvalPolicy: ProposedAssignment["approvalPolicy"], completionCriteria: string[]): ProposedAssignment {
  return {
    proposedAssignmentId: id,
    proposedAssigneeId: assigneeId,
    objective,
    scope,
    dependencies,
    requiredEvidence,
    approvalPolicy,
    budget,
    dispatchEligibilityConditions: dependencies.length > 0 ? ["dependencies_satisfied", "assignee_active"] : ["assignee_active"],
    completionCriteria,
  };
}

function buildSoloImplementation(input: PlannerInput): ProcedureOutput {
  const implementerId = `${input.missionId}-plan-participant-1`;
  const assignmentId = `${input.missionId}-plan-assignment-1`;
  return {
    participantProposals: [participant(implementerId, "implementer", ["non_interactive_execution", "repository_editing"], input.scope, "Implements the objective directly.")],
    assignmentProposals: [assignment(assignmentId, implementerId, input.objective, input.scope, [], ["evidence://diff", "evidence://tests"], input.budget, input.approvalPolicy, ["completion_notice_submitted"])],
    collaborationTopology: [],
    evidenceRequirements: ["evidence://diff", "evidence://tests"],
    approvalGates: [],
    assumptions: ["No independent review is required for this Mission — a solo implementer completes and submits the work directly."],
  };
}

function buildImplementationReviewPair(input: PlannerInput): ProcedureOutput {
  const implementerId = `${input.missionId}-plan-participant-1`;
  const reviewerId = `${input.missionId}-plan-participant-2`;
  const implAssignmentId = `${input.missionId}-plan-assignment-1`;
  const reviewAssignmentId = `${input.missionId}-plan-assignment-2`;
  return {
    participantProposals: [
      participant(implementerId, "implementer", ["non_interactive_execution", "repository_editing"], input.scope, "Implements the objective."),
      participant(reviewerId, "reviewer", ["non_interactive_execution", "structured_output"], { allowedPaths: input.scope.allowedPaths, prohibitedPaths: input.scope.prohibitedPaths }, "Reviews the implementer's submitted work."),
    ],
    assignmentProposals: [
      assignment(implAssignmentId, implementerId, input.objective, input.scope, [], ["evidence://diff", "evidence://tests"], input.budget, "auto", ["completion_notice_submitted"]),
      assignment(reviewAssignmentId, reviewerId, `Review: ${input.objective}`, input.scope, [implAssignmentId], ["evidence://review"], input.budget, input.approvalPolicy, ["review_completed_no_blocking_findings"]),
    ],
    collaborationTopology: [{ fromProposedId: reviewAssignmentId, toProposedId: implAssignmentId, kind: "review" }],
    evidenceRequirements: ["evidence://diff", "evidence://tests", "evidence://review"],
    approvalGates: ["reviewer_sign_off"],
    assumptions: ["A single reviewer, distinct from the implementer, reviews the completed work before it is accepted."],
  };
}

function buildImplementationSecurityReview(input: PlannerInput): ProcedureOutput {
  const base = buildImplementationReviewPair(input);
  const reviewerProposal = base.participantProposals[1];
  reviewerProposal.rationale = "Performs a security-focused review of the implementer's submitted work.";
  reviewerProposal.providerConstraint.requiredCapabilities = [...reviewerProposal.providerConstraint.requiredCapabilities, "tool_event_reporting"];
  const reviewAssignment = base.assignmentProposals[1];
  reviewAssignment.objective = `Security review: ${input.objective}`;
  reviewAssignment.requiredEvidence = ["evidence://security_review"];
  return {
    ...base,
    evidenceRequirements: ["evidence://diff", "evidence://tests", "evidence://security_review"],
    approvalGates: ["security_reviewer_sign_off"],
    assumptions: ["A security-focused reviewer, distinct from the implementer, reviews the completed work for security-relevant findings before it is accepted."],
  };
}

function buildImplementationTestVerification(input: PlannerInput): ProcedureOutput {
  const implementerId = `${input.missionId}-plan-participant-1`;
  const verifierId = `${input.missionId}-plan-participant-2`;
  const implAssignmentId = `${input.missionId}-plan-assignment-1`;
  const verifyAssignmentId = `${input.missionId}-plan-assignment-2`;
  return {
    participantProposals: [
      participant(implementerId, "implementer", ["non_interactive_execution", "repository_editing"], input.scope, "Implements the objective."),
      participant(verifierId, "verifier", ["non_interactive_execution", "structured_output"], input.scope, "Independently verifies test coverage and results."),
    ],
    assignmentProposals: [
      assignment(implAssignmentId, implementerId, input.objective, input.scope, [], ["evidence://diff", "evidence://tests"], input.budget, "auto", ["completion_notice_submitted"]),
      // "human approval after verification" — this assignment's OWN
      // approvalPolicy is forced to human_required regardless of the
      // Mission's default, matching the procedure's own name.
      assignment(verifyAssignmentId, verifierId, `Verify: ${input.objective}`, input.scope, [implAssignmentId], ["evidence://test_verification"], input.budget, "human_required", ["verification_passed"]),
    ],
    collaborationTopology: [{ fromProposedId: verifyAssignmentId, toProposedId: implAssignmentId, kind: "review" }],
    evidenceRequirements: ["evidence://diff", "evidence://tests", "evidence://test_verification"],
    approvalGates: ["human_verification_signoff"],
    assumptions: ["Test verification is independent of implementation, and a human must sign off after verification passes — this procedure never auto-accepts."],
  };
}

function buildInvestigationThenImplementation(input: PlannerInput): ProcedureOutput {
  const investigatorId = `${input.missionId}-plan-participant-1`;
  const investigateAssignmentId = `${input.missionId}-plan-assignment-1`;
  const implementAssignmentId = `${input.missionId}-plan-assignment-2`;
  return {
    participantProposals: [participant(investigatorId, "implementer", ["non_interactive_execution", "repository_editing"], input.scope, "Investigates the root cause, then implements the fix.", false)],
    assignmentProposals: [
      assignment(investigateAssignmentId, investigatorId, `Investigate: ${input.objective}`, { allowedPaths: input.scope.allowedPaths, prohibitedPaths: input.scope.prohibitedPaths }, [], ["evidence://investigation_notes"], input.budget, "auto", ["investigation_notes_submitted"]),
      assignment(implementAssignmentId, investigatorId, `Implement: ${input.objective}`, input.scope, [investigateAssignmentId], ["evidence://diff", "evidence://tests"], input.budget, input.approvalPolicy, ["completion_notice_submitted"]),
    ],
    collaborationTopology: [{ fromProposedId: implementAssignmentId, toProposedId: investigateAssignmentId, kind: "dependency" }],
    evidenceRequirements: ["evidence://investigation_notes", "evidence://diff", "evidence://tests"],
    approvalGates: [],
    assumptions: ["The root cause is not yet known — investigation must complete and produce notes before implementation begins."],
  };
}

export function buildProcedure(templateId: ProcedureTemplateId, input: PlannerInput): ProcedureOutput {
  switch (templateId) {
    case "solo_implementation":
      return buildSoloImplementation(input);
    case "implementation_review_pair":
      return buildImplementationReviewPair(input);
    case "implementation_security_review":
      return buildImplementationSecurityReview(input);
    case "implementation_test_verification":
      return buildImplementationTestVerification(input);
    case "investigation_then_implementation":
      return buildInvestigationThenImplementation(input);
  }
}

/**
 * Phase 5B — mandatory, per-template safeguards a model-assisted proposal
 * must still satisfy, even though the model (not `buildProcedure`) authors
 * the actual participants/assignments/topology for that template. Checked
 * as VALIDATION (a typed rejection), never silently patched into the
 * model's output — silently overwriting what a model proposed would hide
 * exactly the "did the model try to remove this" signal a human reviewer
 * needs to see.
 */
export interface TemplateSafeguards {
  /** At least one assignment must carry `approvalPolicy: "human_required"`. */
  requiresHumanApproval: boolean;
  /** At least one `collaborationTopology` edge of kind "review" must exist. */
  requiresReviewEdge: boolean;
  /** At least one `collaborationTopology` edge of kind "dependency" must exist. */
  requiresDependencyEdge: boolean;
  minParticipants: number;
  maxParticipants: number;
}

export const TEMPLATE_SAFEGUARDS: Record<ProcedureTemplateId, TemplateSafeguards> = {
  solo_implementation: { requiresHumanApproval: false, requiresReviewEdge: false, requiresDependencyEdge: false, minParticipants: 1, maxParticipants: 1 },
  implementation_review_pair: { requiresHumanApproval: false, requiresReviewEdge: true, requiresDependencyEdge: false, minParticipants: 2, maxParticipants: 2 },
  implementation_security_review: { requiresHumanApproval: false, requiresReviewEdge: true, requiresDependencyEdge: false, minParticipants: 2, maxParticipants: 2 },
  implementation_test_verification: { requiresHumanApproval: true, requiresReviewEdge: true, requiresDependencyEdge: false, minParticipants: 2, maxParticipants: 2 },
  investigation_then_implementation: { requiresHumanApproval: false, requiresReviewEdge: false, requiresDependencyEdge: true, minParticipants: 1, maxParticipants: 1 },
};

/** Returns one violation message per broken safeguard — empty array means the template's mandatory safeguards all held. */
export function checkTemplateSafeguards(templateId: ProcedureTemplateId, proposal: { participantProposals: ProposedParticipant[]; assignmentProposals: ProposedAssignment[]; collaborationTopology: PlanCollaborationEdge[] }): string[] {
  const safeguards = TEMPLATE_SAFEGUARDS[templateId];
  const violations: string[] = [];
  if (proposal.participantProposals.length < safeguards.minParticipants || proposal.participantProposals.length > safeguards.maxParticipants) {
    violations.push(`Template "${templateId}" requires between ${safeguards.minParticipants} and ${safeguards.maxParticipants} participants, got ${proposal.participantProposals.length}.`);
  }
  if (safeguards.requiresHumanApproval && !proposal.assignmentProposals.some((a) => a.approvalPolicy === "human_required")) {
    violations.push(`Template "${templateId}" requires at least one assignment with approvalPolicy "human_required" — none was proposed.`);
  }
  if (safeguards.requiresReviewEdge && !proposal.collaborationTopology.some((e) => e.kind === "review")) {
    violations.push(`Template "${templateId}" requires at least one "review" collaboration edge — none was proposed.`);
  }
  if (safeguards.requiresDependencyEdge && !proposal.collaborationTopology.some((e) => e.kind === "dependency")) {
    violations.push(`Template "${templateId}" requires at least one "dependency" collaboration edge — none was proposed.`);
  }
  return violations;
}

/** Deterministic default template per operating mode — overridable via `PlannerInput.procedure`. */
export function defaultProcedureForMode(mode: PlannerInput["operatingMode"]): ProcedureTemplateId {
  switch (mode) {
    case "solo":
      return "solo_implementation";
    case "review_pair":
      return "implementation_review_pair";
    case "specialist_team":
      return "implementation_security_review";
    case "human_led":
      return "implementation_test_verification";
  }
}
