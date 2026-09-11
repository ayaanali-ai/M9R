import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { decideCoordinationValue, evaluateCoordinationOutcome } from "@/lib/coordination-value-gate";

const boundedRequest = {
  requestType: "HELP_REQUESTED" as const,
  intent: "distinct_capability" as const,
  requiredCapabilities: ["visual_design"],
  objectiveSuccessCriteria: ["watchfloor workspace test passes"],
  maxEstimatedTokens: 8_000,
  maxDurationMs: 15 * 60_000,
  maxAddedLatencyMs: 20 * 60_000,
  policyMaxEstimatedTokens: 20_000,
  similarRequestOpen: false,
};

test("coordination defaults to solo without a declared distinct capability or assurance need", () => {
  const decision = decideCoordinationValue({ ...boundedRequest, intent: null });
  assert.equal(decision.delivery, "solo");
  assert.deepEqual(decision.reasons, ["coordination_need_not_declared"]);
});

test("a bounded distinct-capability request can coordinate", () => {
  const decision = decideCoordinationValue(boundedRequest);
  assert.equal(decision.delivery, "coordinate");
  assert.deepEqual(decision.reasons, []);
});

test("independent assurance is verification-only", () => {
  const decision = decideCoordinationValue({ ...boundedRequest, intent: "independent_assurance" });
  assert.equal(decision.delivery, "solo");
  assert.ok(decision.reasons.includes("assurance_requires_check_request"));
});

test("duplicate, unmeasured, over-token, and over-latency requests are rejected", () => {
  assert.ok(decideCoordinationValue({ ...boundedRequest, similarRequestOpen: true }).reasons.includes("similar_request_already_open"));
  assert.ok(decideCoordinationValue({ ...boundedRequest, maxEstimatedTokens: null }).reasons.includes("token_budget_required"));
  assert.ok(decideCoordinationValue({ ...boundedRequest, maxEstimatedTokens: 20_001 }).reasons.includes("token_budget_exceeded"));
  assert.ok(decideCoordinationValue({ ...boundedRequest, maxDurationMs: 20 * 60_000 + 1 }).reasons.includes("latency_budget_exceeded"));
});

test("coordination requires objective success criteria and a real capability boundary", () => {
  assert.ok(decideCoordinationValue({ ...boundedRequest, objectiveSuccessCriteria: [] }).reasons.includes("objective_success_criteria_required"));
  assert.ok(decideCoordinationValue({ ...boundedRequest, requiredCapabilities: [] }).reasons.includes("distinct_capability_required"));
});

test("outcome is improved only when quality and quality-per-token both beat the solo baseline", () => {
  const result = evaluateCoordinationOutcome({
    solo: { objectiveChecksPassed: 4, objectiveChecksFailed: 1, reworkEvents: 2, tokensUsed: 10_000, durationMs: 600_000 },
    coordinated: { objectiveChecksPassed: 6, objectiveChecksFailed: 0, reworkEvents: 1, tokensUsed: 12_000, durationMs: 720_000 },
    maxAddedTokens: 4_000,
    maxAddedLatencyMs: 180_000,
  });
  assert.equal(result.verdict, "improved");
  assert.equal(result.mayClaimQualityImprovement, true);
  assert.equal(result.soloQualityPerToken, 0.0001);
  assert.equal(result.coordinatedQualityPerToken, 5 / 12_000);
});

test("higher activity cannot claim improvement when efficiency falls or budgets are exceeded", () => {
  const result = evaluateCoordinationOutcome({
    solo: { objectiveChecksPassed: 4, objectiveChecksFailed: 0, reworkEvents: 0, tokensUsed: 4_000, durationMs: 300_000 },
    coordinated: { objectiveChecksPassed: 5, objectiveChecksFailed: 0, reworkEvents: 0, tokensUsed: 20_000, durationMs: 900_000 },
    maxAddedTokens: 8_000,
    maxAddedLatencyMs: 300_000,
  });
  assert.equal(result.verdict, "not_improved");
  assert.equal(result.mayClaimQualityImprovement, false);
  assert.ok(result.reasons.includes("token_overhead_exceeded"));
  assert.ok(result.reasons.includes("quality_per_token_not_improved"));
});

test("missing usage or objective evidence yields insufficient data, never a quality claim", () => {
  const result = evaluateCoordinationOutcome({
    solo: { objectiveChecksPassed: 0, objectiveChecksFailed: 0, reworkEvents: 0, tokensUsed: null, durationMs: 100 },
    coordinated: { objectiveChecksPassed: 1, objectiveChecksFailed: 0, reworkEvents: 0, tokensUsed: 1_000, durationMs: 200 },
    maxAddedTokens: 2_000,
    maxAddedLatencyMs: 1_000,
  });
  assert.equal(result.verdict, "insufficient_data");
  assert.equal(result.mayClaimQualityImprovement, false);
});

test("targeted request-help evaluates the value gate before publishing a dispatch", () => {
  const source = readFileSync("src/app/api/agent/runs/[id]/request-help/route.ts", "utf8");
  const gateIndex = source.indexOf("decideCoordinationValue(");
  const publishIndex = source.indexOf("publishDispatch(");
  assert.ok(gateIndex > 0, "request-help must call the value gate");
  assert.ok(gateIndex < publishIndex, "a rejected request must not publish coordination activity");
  assert.match(source, /routeAgentTask\(/, "request-help must derive the lightest task tier");
  assert.match(source, /Math\.min\(policy\.maxEstimatedTokensPerRequest, taskRoute\.maxEstimatedTokens\)/,
    "the task tier must tighten, never expand, the run token ceiling");
});
