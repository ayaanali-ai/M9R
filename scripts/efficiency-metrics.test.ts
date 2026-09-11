import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeTokenEfficiency, summarizeFindingReuse, summarizeCoordinationCost } from "../src/lib/efficiency-metrics.ts";

test("token efficiency averages only known-token runs, never fills gaps with 0", () => {
  const report = summarizeTokenEfficiency([
    { mode: "solo", knownTokens: 100 },
    { mode: "solo", knownTokens: null },
    { mode: "coordinated", knownTokens: 200 },
  ]);
  assert.equal(report.byMode.solo.runCount, 2);
  assert.equal(report.byMode.solo.knownTokenRuns, 1);
  assert.equal(report.byMode.solo.averageKnownTokens, 100);
  assert.equal(report.byMode.coordinated.averageKnownTokens, 200);
  assert.equal(report.byMode.assurance.averageKnownTokens, null);
});

test("unknownTokenCoverage reflects the real share of unknown runs", () => {
  const report = summarizeTokenEfficiency([
    { mode: "solo", knownTokens: 100 },
    { mode: "solo", knownTokens: null },
    { mode: "solo", knownTokens: null },
    { mode: "solo", knownTokens: null },
  ]);
  assert.equal(report.unknownTokenCoverage, 0.75);
});

test("empty input reports zero runs and zero unknown coverage, not NaN", () => {
  const report = summarizeTokenEfficiency([]);
  assert.equal(report.totalRuns, 0);
  assert.equal(report.unknownTokenCoverage, 0);
  assert.equal(report.byMode.solo.averageKnownTokens, null);
});

test("finding reuse rate is null (not 0) when there are no available findings", () => {
  const report = summarizeFindingReuse([]);
  assert.equal(report.reuseRate, null);
  assert.equal(report.totalAvailable, 0);
});

test("finding reuse rate counts findings with at least one adoption", () => {
  const report = summarizeFindingReuse([{ adoptedCount: 2 }, { adoptedCount: 0 }, { adoptedCount: 1 }, { adoptedCount: 0 }]);
  assert.equal(report.totalAvailable, 4);
  assert.equal(report.adoptedCount, 2);
  assert.equal(report.reuseRate, 0.5);
});

test("coordination cost flags runs where requests were issued but never resolved", () => {
  const report = summarizeCoordinationCost([
    { mode: "solo", requestsIssued: 0, requestsResolved: 0 },
    { mode: "coordinated", requestsIssued: 2, requestsResolved: 2 },
    { mode: "assurance", requestsIssued: 1, requestsResolved: 0 },
  ]);
  assert.equal(report.coordinatedOrAssuranceRuns, 2);
  assert.equal(report.unresolvedCoordinationRuns, 1);
});

test("solo runs never count as coordinating even if requestsIssued is somehow nonzero", () => {
  const report = summarizeCoordinationCost([{ mode: "solo", requestsIssued: 1, requestsResolved: 0 }]);
  assert.equal(report.coordinatedOrAssuranceRuns, 0);
});
