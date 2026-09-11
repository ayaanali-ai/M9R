/**
 * Deterministic gate for deciding whether a run may add another agent.
 *
 * Activity is not value. A request coordinates only for a declared capability
 * gap or an independent check, with objective criteria and explicit token and
 * latency ceilings. The companion evaluator keeps later quality claims tied to
 * comparable observed results rather than agent self-report.
 */

import { evaluateUsagePolicy, type UsagePolicyInput } from "@/lib/adaptive-usage-policy";

export type CoordinationIntent = "distinct_capability" | "independent_assurance";
export type CoordinationRequestType = "HELP_REQUESTED" | "CHECK_REQUESTED";

export type CoordinationGateReason =
  | "coordination_need_not_declared"
  | "assurance_requires_check_request"
  | "distinct_capability_required"
  | "objective_success_criteria_required"
  | "similar_request_already_open"
  | "token_budget_required"
  | "token_budget_exceeded"
  | "latency_budget_exceeded"
  | "usage_policy_red";

export interface CoordinationValueRequest {
  requestType: CoordinationRequestType;
  intent: CoordinationIntent | null;
  requiredCapabilities: readonly string[];
  objectiveSuccessCriteria: readonly string[];
  maxEstimatedTokens: number | null;
  maxDurationMs: number;
  maxAddedLatencyMs: number;
  policyMaxEstimatedTokens: number | null;
  similarRequestOpen: boolean;
  /** Current aggregate usage; red usage blocks another dispatch. */
  usagePolicy?: UsagePolicyInput;
}

export interface CoordinationValueDecision {
  delivery: "solo" | "coordinate";
  reasons: CoordinationGateReason[];
}

/** Default-deny coordination gate. It performs no model call and mutates no state. */
export function decideCoordinationValue(input: CoordinationValueRequest): CoordinationValueDecision {
  const reasons: CoordinationGateReason[] = [];
  if (!input.intent) reasons.push("coordination_need_not_declared");
  if (input.intent === "independent_assurance" && input.requestType !== "CHECK_REQUESTED") {
    reasons.push("assurance_requires_check_request");
  }
  if (input.intent === "distinct_capability" && input.requiredCapabilities.length === 0) {
    reasons.push("distinct_capability_required");
  }
  if (input.objectiveSuccessCriteria.length === 0) reasons.push("objective_success_criteria_required");
  if (input.similarRequestOpen) reasons.push("similar_request_already_open");
  if (input.maxEstimatedTokens === null || input.maxEstimatedTokens <= 0) {
    reasons.push("token_budget_required");
  } else if (input.policyMaxEstimatedTokens === null || input.maxEstimatedTokens > input.policyMaxEstimatedTokens) {
    reasons.push("token_budget_exceeded");
  }
  if (input.maxDurationMs <= 0 || input.maxDurationMs > input.maxAddedLatencyMs) {
    reasons.push("latency_budget_exceeded");
  }
  if (input.usagePolicy && evaluateUsagePolicy(input.usagePolicy).verdict === "red") {
    reasons.push("usage_policy_red");
  }
  return { delivery: reasons.length === 0 ? "coordinate" : "solo", reasons };
}

export interface CoordinationOutcomeSample {
  objectiveChecksPassed: number;
  objectiveChecksFailed: number;
  reworkEvents: number;
  tokensUsed: number | null;
  durationMs: number;
}

export type CoordinationOutcomeReason =
  | "objective_evidence_missing"
  | "usage_evidence_missing"
  | "objective_quality_not_improved"
  | "token_overhead_exceeded"
  | "latency_overhead_exceeded"
  | "quality_per_token_not_improved";

export interface CoordinationOutcomeEvaluation {
  verdict: "improved" | "not_improved" | "insufficient_data";
  mayClaimQualityImprovement: boolean;
  reasons: CoordinationOutcomeReason[];
  tokenDelta: number | null;
  durationDeltaMs: number;
  /** Objective score divided by measured tokens; null when usage is absent. */
  soloQualityPerToken: number | null;
  coordinatedQualityPerToken: number | null;
}

function qualityScore(sample: CoordinationOutcomeSample): number {
  return sample.objectiveChecksPassed - sample.objectiveChecksFailed - sample.reworkEvents;
}

/**
 * Compare a coordinated run with a solo baseline. Improvement requires a
 * strictly better objective score, no token/latency ceiling breach, and no
 * regression in objective quality per reported token.
 */
export function evaluateCoordinationOutcome(input: {
  solo: CoordinationOutcomeSample;
  coordinated: CoordinationOutcomeSample;
  maxAddedTokens: number;
  maxAddedLatencyMs: number;
}): CoordinationOutcomeEvaluation {
  const tokenDelta = input.solo.tokensUsed === null || input.coordinated.tokensUsed === null
    ? null
    : input.coordinated.tokensUsed - input.solo.tokensUsed;
  const durationDeltaMs = input.coordinated.durationMs - input.solo.durationMs;
  const reasons: CoordinationOutcomeReason[] = [];
  const soloChecks = input.solo.objectiveChecksPassed + input.solo.objectiveChecksFailed;
  const coordinatedChecks = input.coordinated.objectiveChecksPassed + input.coordinated.objectiveChecksFailed;
  if (soloChecks === 0 || coordinatedChecks === 0) reasons.push("objective_evidence_missing");
  if (input.solo.tokensUsed === null || input.coordinated.tokensUsed === null
    || input.solo.tokensUsed <= 0 || input.coordinated.tokensUsed <= 0) {
    reasons.push("usage_evidence_missing");
  }
  if (reasons.length > 0) {
    return {
      verdict: "insufficient_data", mayClaimQualityImprovement: false, reasons, tokenDelta, durationDeltaMs,
      soloQualityPerToken: null, coordinatedQualityPerToken: null,
    };
  }

  const soloScore = qualityScore(input.solo);
  const coordinatedScore = qualityScore(input.coordinated);
  if (coordinatedScore <= soloScore) reasons.push("objective_quality_not_improved");
  if (tokenDelta! > input.maxAddedTokens) reasons.push("token_overhead_exceeded");
  if (durationDeltaMs > input.maxAddedLatencyMs) reasons.push("latency_overhead_exceeded");
  const soloQualityPerToken = soloScore / input.solo.tokensUsed!;
  const coordinatedQualityPerToken = coordinatedScore / input.coordinated.tokensUsed!;
  if (coordinatedQualityPerToken <= soloQualityPerToken) reasons.push("quality_per_token_not_improved");

  return reasons.length === 0
    ? { verdict: "improved", mayClaimQualityImprovement: true, reasons: [], tokenDelta, durationDeltaMs, soloQualityPerToken, coordinatedQualityPerToken }
    : { verdict: "not_improved", mayClaimQualityImprovement: false, reasons, tokenDelta, durationDeltaMs, soloQualityPerToken, coordinatedQualityPerToken };
}
