import assert from "node:assert/strict";
import test from "node:test";
import { deriveRuleEffectiveness } from "@/lib/rule-effectiveness";

const item = (status: "followed" | "violated" | "needs_review") => ({
  rule_id: "r1", title: "Stop retries", status, evidenceLevel: "Observed" as const,
  reason: "evidence", matchedFindingTypes: [],
});

test("followed rule produces a measured-help increment hint", () => {
  assert.equal(deriveRuleEffectiveness(item("followed")).action, "increment_helped");
});

test("violated rule returns to review instead of auto-retiring", () => {
  const decision = deriveRuleEffectiveness(item("violated"));
  assert.equal(decision.action, "mark_needs_review");
});

test("inconclusive health does not mutate lifecycle state", () => {
  assert.equal(deriveRuleEffectiveness(item("needs_review")).action, "no_change");
});
