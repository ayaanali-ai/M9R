/**
 * Soft/hard usage policy for coordinated work.
 *
 * A provider may finish slightly above its target; completed work is not
 * discarded. Yellow pauses additional optional work, while red blocks new
 * coordination/retries until a human changes the budget or scope.
 */

export type UsageVerdict = "green" | "yellow" | "red";
export type UsageAction = "continue" | "finish_only" | "stop_new_work";

export interface UsagePolicyInput {
  usedTokens: number;
  softLimitTokens: number;
  hardLimitTokens: number;
}

export interface UsagePolicyDecision {
  verdict: UsageVerdict;
  action: UsageAction;
  usedTokens: number;
  softLimitTokens: number;
  hardLimitTokens: number;
  softUtilization: number;
  hardUtilization: number;
  overageTokens: number;
}

function validate(input: UsagePolicyInput): void {
  for (const value of [input.usedTokens, input.softLimitTokens, input.hardLimitTokens]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Usage limits must be non-negative safe integers.");
  }
  if (input.softLimitTokens <= 0 || input.hardLimitTokens < input.softLimitTokens) {
    throw new Error("Usage limits must satisfy 0 < softLimitTokens <= hardLimitTokens.");
  }
}

export function evaluateUsagePolicy(input: UsagePolicyInput): UsagePolicyDecision {
  validate(input);
  const verdict: UsageVerdict = input.usedTokens > input.hardLimitTokens
    ? "red"
    : input.usedTokens > input.softLimitTokens
      ? "yellow"
      : "green";
  return {
    verdict,
    action: verdict === "green" ? "continue" : verdict === "yellow" ? "finish_only" : "stop_new_work",
    usedTokens: input.usedTokens,
    softLimitTokens: input.softLimitTokens,
    hardLimitTokens: input.hardLimitTokens,
    softUtilization: input.usedTokens / input.softLimitTokens,
    hardUtilization: input.usedTokens / input.hardLimitTokens,
    overageTokens: Math.max(0, input.usedTokens - input.hardLimitTokens),
  };
}
