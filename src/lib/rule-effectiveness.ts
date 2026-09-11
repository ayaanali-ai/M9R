import type { RuleHealthItem, RuleHealthStatus } from "@/lib/rule-health";

export type RuleEffectAction = "increment_helped" | "mark_needs_review" | "no_change";

export interface RuleEffectivenessDecision {
  ruleId: string;
  status: RuleHealthStatus;
  action: RuleEffectAction;
  reason: string;
}

/**
 * Translate already-evaluated Rule Health into a conservative lifecycle hint.
 * This does not mutate the database or auto-promote/retire anything.
 */
export function deriveRuleEffectiveness(item: RuleHealthItem): RuleEffectivenessDecision {
  if (item.status === "followed") {
    return {
      ruleId: item.rule_id,
      status: item.status,
      action: "increment_helped",
      reason: "Relevant activity occurred without recurrence of the targeted pattern.",
    };
  }
  if (item.status === "violated") {
    return {
      ruleId: item.rule_id,
      status: item.status,
      action: "mark_needs_review",
      reason: "The targeted pattern recurred while the rule was loaded.",
    };
  }
  return {
    ruleId: item.rule_id,
    status: item.status,
    action: "no_change",
    reason: "Evidence is insufficient to change the rule lifecycle state.",
  };
}
