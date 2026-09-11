import assert from "node:assert/strict";
import test from "node:test";
import { deriveCoordinationRuleCandidates } from "../src/lib/coordination-rule-candidates.ts";

test("one non-adopted result is not enough to create a workspace rule", () => {
  assert.deepEqual(deriveCoordinationRuleCandidates({ rejected: 1, challenged: 0 }), []);
});

test("repeated reviewed non-adoption creates one review-only candidate input", () => {
  const candidates = deriveCoordinationRuleCandidates({ rejected: 1, challenged: 1 });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].ruleType, "cost_control");
  assert.match(candidates[0].body, /distinct question, specialization, or independent check/);
});
