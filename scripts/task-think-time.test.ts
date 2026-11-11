import assert from "node:assert/strict";
import test from "node:test";
import { summarizeTaskThinkTime, type StageTimingSummary } from "../src/lib/native/inbox-core";

// Item 5 of the latency plan: split a finished task's wall-clock time into real, non-overlapping
// M9R-side dispatch time (the six top-level stage phases) vs. everything else -- overwhelmingly
// the agent provider's own think time on a real task, which M9R has no visibility into and does
// not claim to speed up.

test("splits total elapsed time into M9R top-level phase time vs. the inferred remainder", () => {
  const summary: StageTimingSummary = {
    queue_wait: { count: 1, totalDurationMs: 50, maxDurationMs: 50, errorCount: 0 },
    prepare: { count: 1, totalDurationMs: 100, maxDurationMs: 100, errorCount: 0 },
    action: { count: 3, totalDurationMs: 300, maxDurationMs: 150, errorCount: 0 },
    // Sub-phases of "action" above -- must NOT be summed again on top of "action" itself.
    "input-dispatch": { count: 3, totalDurationMs: 120, maxDurationMs: 60, errorCount: 0 },
    "accessibility-read": { count: 3, totalDurationMs: 90, maxDurationMs: 45, errorCount: 0 },
  };
  const result = summarizeTaskThinkTime({
    createdAt: "2026-11-11T12:00:00.000Z",
    completedAt: "2026-11-11T12:00:05.000Z", // 5000ms total
    stageTimingSummary: summary,
  });
  assert.ok(result);
  assert.equal(result!.totalElapsedMs, 5000);
  assert.equal(result!.m9rInfraMs, 450); // 50 + 100 + 300, sub-phases excluded
  assert.equal(result!.inferredNonInfraMs, 4550);
  assert.equal(result!.m9rInfraSharePercent, 9);
});

test("returns null for an unfinished task (no completedAt yet)", () => {
  const result = summarizeTaskThinkTime({ createdAt: "2026-11-11T12:00:00.000Z", completedAt: undefined, stageTimingSummary: {} });
  assert.equal(result, null);
});

test("returns null rather than a negative duration on malformed/skewed timestamps", () => {
  const result = summarizeTaskThinkTime({
    createdAt: "2026-11-11T12:00:05.000Z",
    completedAt: "2026-11-11T12:00:00.000Z", // completed before created
    stageTimingSummary: {},
  });
  assert.equal(result, null);
});

test("never reports more M9R infra time than the task actually took", () => {
  // Pathological/corrupt summary where recorded phase totals exceed the real wall-clock span.
  const summary: StageTimingSummary = { action: { count: 1, totalDurationMs: 9999, maxDurationMs: 9999, errorCount: 0 } };
  const result = summarizeTaskThinkTime({
    createdAt: "2026-11-11T12:00:00.000Z",
    completedAt: "2026-11-11T12:00:01.000Z", // 1000ms total
    stageTimingSummary: summary,
  });
  assert.ok(result);
  assert.equal(result!.m9rInfraMs, 1000);
  assert.equal(result!.inferredNonInfraMs, 0);
  assert.equal(result!.m9rInfraSharePercent, 100);
});
