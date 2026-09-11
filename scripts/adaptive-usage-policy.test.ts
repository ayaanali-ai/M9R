import assert from "node:assert/strict";
import test from "node:test";
import { evaluateUsagePolicy } from "@/lib/adaptive-usage-policy";

test("green usage continues optional work", () => {
  const decision = evaluateUsagePolicy({ usedTokens: 700, softLimitTokens: 1_000, hardLimitTokens: 1_500 });
  assert.equal(decision.verdict, "green");
  assert.equal(decision.action, "continue");
});

test("yellow usage preserves completion but stops optional follow-up", () => {
  const decision = evaluateUsagePolicy({ usedTokens: 1_100, softLimitTokens: 1_000, hardLimitTokens: 1_500 });
  assert.equal(decision.verdict, "yellow");
  assert.equal(decision.action, "finish_only");
  assert.equal(decision.overageTokens, 0);
});

test("red usage blocks new work without rejecting the completed result", () => {
  const decision = evaluateUsagePolicy({ usedTokens: 1_600, softLimitTokens: 1_000, hardLimitTokens: 1_500 });
  assert.equal(decision.verdict, "red");
  assert.equal(decision.action, "stop_new_work");
  assert.equal(decision.overageTokens, 100);
});

test("invalid limits fail closed", () => {
  assert.throws(() => evaluateUsagePolicy({ usedTokens: 1, softLimitTokens: 0, hardLimitTokens: 1 }));
  assert.throws(() => evaluateUsagePolicy({ usedTokens: 1, softLimitTokens: 2, hardLimitTokens: 1 }));
});
