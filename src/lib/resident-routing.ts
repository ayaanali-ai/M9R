import type { ResidentProvider } from "@/lib/resident-launch-contract";

export interface AssistanceRoutingRequest {
  requestingConnectionId: string;
  explicitTargetConnectionId: string | null;
  preferredProvider: ResidentProvider | null;
  repositoryBindingId: string;
  requiredCapabilities: string[];
  delegationDepth: number;
}

export interface ResidentRoutingCandidate {
  connectionId: string;
  residentInstanceId: string;
  provider: ResidentProvider;
  repositoryBindingId: string;
  capabilities: string[];
  leaseExpiresAt: string;
  authorizationActive: boolean;
  maxDelegationDepth: number;
  activeLaunches: number;
}

export type RoutingExclusionReason =
  | "requester_cannot_support_itself"
  | "explicit_target_mismatch"
  | "provider_mismatch"
  | "authorization_revoked"
  | "repository_not_authorized"
  | "capability_missing"
  | "delegation_depth_exceeded"
  | "resident_offline";

export interface RoutingExclusion {
  connectionId: string;
  reason: RoutingExclusionReason;
}

export interface AssistanceRoutingResult {
  ok: boolean;
  selected: ResidentRoutingCandidate | null;
  reason: "eligible_resident_with_least_active_work" | "explicit_target_eligible" | "explicit_target_ineligible" | "no_eligible_resident";
  exclusions: RoutingExclusion[];
}

export type ApprovalBoundaryReason =
  | "policy_requires_human"
  | "duration_exceeds_authorization"
  | "token_budget_not_authorized"
  | "delegation_depth_exceeds_authorization";

export function decideAssistanceApproval(
  request: { maxDurationMs: number; maxEstimatedTokens: number | null; delegationDepth: number },
  authorization: {
    approvalPolicy: "human_before_start" | "preauthorized_bounded";
    maxDurationMs: number;
    maxEstimatedTokens: number | null;
    maxDelegationDepth: number;
  },
): { decision: "preauthorized" | "human_approval_required"; reasons: ApprovalBoundaryReason[] } {
  const reasons: ApprovalBoundaryReason[] = [];
  if (authorization.approvalPolicy !== "preauthorized_bounded") reasons.push("policy_requires_human");
  if (request.maxDurationMs > authorization.maxDurationMs) reasons.push("duration_exceeds_authorization");
  if (request.maxEstimatedTokens !== null
    && (authorization.maxEstimatedTokens === null || request.maxEstimatedTokens > authorization.maxEstimatedTokens)) {
    reasons.push("token_budget_not_authorized");
  }
  if (request.delegationDepth > authorization.maxDelegationDepth) reasons.push("delegation_depth_exceeds_authorization");
  return reasons.length === 0
    ? { decision: "preauthorized", reasons: [] }
    : { decision: "human_approval_required", reasons };
}

function exclusionFor(
  request: AssistanceRoutingRequest,
  candidate: ResidentRoutingCandidate,
  nowMs: number,
): RoutingExclusionReason | null {
  if (candidate.connectionId === request.requestingConnectionId) return "requester_cannot_support_itself";
  if (request.explicitTargetConnectionId && candidate.connectionId !== request.explicitTargetConnectionId) return "explicit_target_mismatch";
  if (request.preferredProvider && candidate.provider !== request.preferredProvider) return "provider_mismatch";
  if (!candidate.authorizationActive) return "authorization_revoked";
  if (candidate.repositoryBindingId !== request.repositoryBindingId) return "repository_not_authorized";
  if (!request.requiredCapabilities.every((capability) => candidate.capabilities.includes(capability))) return "capability_missing";
  if (!Number.isSafeInteger(request.delegationDepth) || request.delegationDepth < 0 || request.delegationDepth > candidate.maxDelegationDepth) {
    return "delegation_depth_exceeded";
  }
  const leaseExpiresMs = Date.parse(candidate.leaseExpiresAt);
  if (!Number.isFinite(leaseExpiresMs) || leaseExpiresMs <= nowMs) return "resident_offline";
  return null;
}

/**
 * Pick a supporting resident without a model call. Eligibility is policy data;
 * load and connection id provide a stable, reproducible tie-break.
 */
export function routeAssistanceRequest(
  request: AssistanceRoutingRequest,
  candidates: readonly ResidentRoutingCandidate[],
  nowMs = Date.now(),
): AssistanceRoutingResult {
  const exclusions: RoutingExclusion[] = [];
  const eligible: ResidentRoutingCandidate[] = [];

  for (const candidate of candidates) {
    const reason = exclusionFor(request, candidate, nowMs);
    if (reason) exclusions.push({ connectionId: candidate.connectionId, reason });
    else eligible.push(candidate);
  }

  eligible.sort((a, b) => {
    const loadDifference = a.activeLaunches - b.activeLaunches;
    return loadDifference || a.connectionId.localeCompare(b.connectionId);
  });

  const selected = eligible[0] ?? null;
  if (!selected) {
    return {
      ok: false,
      selected: null,
      reason: request.explicitTargetConnectionId ? "explicit_target_ineligible" : "no_eligible_resident",
      exclusions,
    };
  }

  return {
    ok: true,
    selected,
    reason: request.explicitTargetConnectionId ? "explicit_target_eligible" : "eligible_resident_with_least_active_work",
    exclusions,
  };
}
