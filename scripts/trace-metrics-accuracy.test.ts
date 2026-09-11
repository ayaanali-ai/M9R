/**
 * Accuracy tests for the improved metrics / cost / waste / MTM pipeline.
 *
 * These lock in the behaviors that matter to "serious agent builders":
 *  - Provider-native token shapes survive normalization (no more "—").
 *  - Cost is estimated from model pricing when not recorded, and flagged.
 *  - Waste is attributed to failed/retried steps, never invented.
 *  - MTM signals fire on escalation / high-volume / missing credentials.
 *  - Honesty: nothing is fabricated when data is absent.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { normalizeToTrace } from "../src/lib/normalize-trace.ts";
import { computeTraceMetrics } from "../src/lib/trace-metrics.ts";
import { estimateCostFromTokens, getModelTier, lookupModelPrice } from "../src/lib/cost-model.ts";
import { detectMtmSignals } from "../src/lib/mtm-signals.ts";
import { generateBlackboxReport } from "../src/lib/blackbox-report.ts";

test("normalizes OpenAI-style step usage into real token totals", () => {
  const trace = normalizeToTrace({
    session_id: "s1",
    steps: [
      { step: 1, model: "gpt-4o", usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 } },
    ],
  });
  const m = computeTraceMetrics(trace);
  assert.equal(m.hasTokenUsage, true);
  assert.equal(m.totalTokens, 1200);
  assert.equal(m.inputTokens, 1000);
});

test("estimates cost from model pricing when the trace records none, and flags it", () => {
  const trace = normalizeToTrace({
    session_id: "s2",
    steps: [
      { step: 1, model: "gpt-4o", usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } },
    ],
  });
  const m = computeTraceMetrics(trace);
  assert.equal(m.hasCostData, false, "no recorded cost");
  assert.equal(m.hasEstimatedCost, true);
  assert.equal(m.costIsEstimated, true);
  // gpt-4o: $2.5/M input + $10/M output = $12.50 for 1M+1M.
  assert.equal(m.effectiveCostUsd, 12.5);
});

test("prefers recorded cost over estimation and does not mark it estimated", () => {
  const trace = normalizeToTrace({
    session_id: "s3",
    steps: [{ step: 1, model: "gpt-4o", usage: { input_tokens: 10, output_tokens: 10 }, estimated_cost_usd: 0.99 }],
  });
  const m = computeTraceMetrics(trace);
  assert.equal(m.hasCostData, true);
  assert.equal(m.costUsd, 0.99);
  assert.equal(m.costIsEstimated, false);
  assert.equal(m.effectiveCostUsd, 0.99);
});

test("attributes waste to failed/retried steps as a lower bound", () => {
  const trace = normalizeToTrace({
    session_id: "s4",
    steps: [
      { step: 1, model: "gpt-4o", usage: { input_tokens: 500, output_tokens: 500 }, shell_commands: ["npm run build"], errors: ["build failed"] },
      { step: 2, model: "gpt-4o", usage: { input_tokens: 500, output_tokens: 500 }, shell_commands: ["npm run build"], errors: ["build failed"] },
      { step: 3, model: "gpt-4o", usage: { input_tokens: 100, output_tokens: 100 } },
    ],
  });
  const m = computeTraceMetrics(trace);
  assert.equal(m.failedSteps, 2);
  assert.equal(m.wasteTokens, 2000, "tokens from the two failed steps only");
  assert.equal(m.stuckLoop, true, "same command failed twice");
  assert.deepEqual(m.repeatedFailures, [{ command: "npm run build", count: 2 }]);
  assert.ok(m.wasteUsd && m.wasteUsd > 0);
});

test("detects the same tool input recurring 3+ times as repeated-context waste, excluding the first occurrence", () => {
  const bigBlock = "You are reviewing repository rules: ".repeat(6); // > 120 chars
  const trace = normalizeToTrace({
    session_id: "s-repeat",
    steps: [
      { step: 1, model: "gpt-4o", tool_input_summary: bigBlock, usage: { input_tokens: 4000, output_tokens: 100 } },
      { step: 2, model: "gpt-4o", tool_input_summary: bigBlock, usage: { input_tokens: 4000, output_tokens: 100 } },
      { step: 3, model: "gpt-4o", tool_input_summary: bigBlock, usage: { input_tokens: 4000, output_tokens: 100 } },
      { step: 4, model: "gpt-4o", tool_input_summary: "a short, unrelated line" },
    ],
  });
  const m = computeTraceMetrics(trace);
  assert.equal(m.repeatedContextFindings.length, 1);
  const finding = m.repeatedContextFindings[0];
  assert.equal(finding.source, "toolInputSummary");
  assert.equal(finding.occurrences, 3);
  assert.deepEqual(finding.wastedStepNumbers, [2, 3]);
  // Waste excludes the first occurrence (step 1): only steps 2 and 3 count.
  assert.equal(finding.wasteTokens, 8200);
  assert.ok((finding.wasteUsd ?? 0) > 0);
  assert.equal(m.repeatedContextWasteTokens, 8200);
});

test("does not flag short repeated strings or fewer than 3 occurrences as repeated context", () => {
  const trace = normalizeToTrace({
    session_id: "s-no-repeat",
    steps: [
      { step: 1, model: "gpt-4o", tool_input_summary: "short" },
      { step: 2, model: "gpt-4o", tool_input_summary: "short" },
      { step: 3, model: "gpt-4o", tool_input_summary: "a".repeat(200) },
      { step: 4, model: "gpt-4o", tool_input_summary: "a".repeat(200) },
    ],
  });
  const m = computeTraceMetrics(trace);
  assert.equal(m.repeatedContextFindings.length, 0, "short strings and 2-occurrence groups should not qualify");
  assert.equal(m.repeatedContextWasteTokens, null);
  assert.match(m.repeatedContextNote, /No repeated context detected/);
});

test("stays honest: no token/cost data yields nulls, not zeros", () => {
  const trace = normalizeToTrace({
    session_id: "s5",
    steps: [{ step: 1, model: "gpt-4o" }, { step: 2, tool: "bash" }],
  });
  const m = computeTraceMetrics(trace);
  assert.equal(m.hasTokenUsage, false);
  assert.equal(m.totalTokens, null);
  assert.equal(m.effectiveCostUsd, null);
  assert.equal(m.wasteUsd, null);
});

test("cost-model: tiers and estimates resolve for versioned ids", () => {
  assert.equal(getModelTier("claude-opus-4-8-20260101"), 3);
  assert.equal(getModelTier("gpt-4o-mini-2024"), 1);
  assert.equal(lookupModelPrice("totally-unknown-model"), null);
  assert.equal(estimateCostFromTokens("unknown", 100, 100, 200), null, "unknown model → not estimable");
});

test("MTM: flags escalation to a stronger model (end-to-end in report)", async () => {
  const trace = normalizeToTrace({
    session_id: "s6",
    steps: [
      { step: 1, actor: "model", model: "gpt-4o-mini" },
      { step: 2, actor: "model", model: "claude-opus-4-8" },
    ],
  });
  const report = await generateBlackboxReport(trace);
  const escalation = report.securitySignals.find((s) => s.title.includes("escalation"));
  assert.ok(escalation, "escalation signal present");
  assert.equal(escalation!.severity, "high", "light → frontier is a 2-tier jump");
});

test("MTM: flags missing credential metadata on model calls", () => {
  const trace = normalizeToTrace({
    session_id: "s7",
    steps: [
      { step: 1, model: "gpt-4o", missing_metadata: ["credential"] },
    ],
  });
  const signals = detectMtmSignals(trace, []);
  assert.ok(signals.some((s) => s.kind === "missing_credentials"));
});

test("MTM: flags high-volume querying of a single model", () => {
  const steps = Array.from({ length: 9 }, (_, i) => ({ step: i + 1, actor: "model", model: "gpt-4o" }));
  const trace = normalizeToTrace({ session_id: "s8", steps });
  const signals = detectMtmSignals(trace, []);
  assert.ok(signals.some((s) => s.kind === "high_volume_queries"));
});
