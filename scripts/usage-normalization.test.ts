import test from "node:test";
import assert from "node:assert/strict";
import {
  extractCost,
  extractTokenUsage,
  summarizeUsage,
} from "../src/lib/usage-normalization.ts";

test("extracts OpenAI, Anthropic, Gemini, OTEL, and camelCase usage shapes", () => {
  const cases = [
    [{ usage: { prompt_tokens: 100, completion_tokens: 25, total_tokens: 125 } }, 125],
    [{ usage: { input_tokens: "80", output_tokens: "20" } }, 100],
    [{ usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 10, totalTokenCount: 100 } }, 100],
    [{ attributes: { "gen_ai.usage.input_tokens": 70, "gen_ai.usage.output_tokens": 30 } }, 100],
    [{ tokenUsage: { inputTokens: 40, outputTokens: 10, totalTokens: 50 } }, 50],
  ] as const;

  for (const [raw, expected] of cases) {
    assert.equal(extractTokenUsage(raw).usage?.total, expected);
  }
});

test("preserves partial usage and reports completeness instead of filling missing values with zero", () => {
  const result = extractTokenUsage({ usage: { input_tokens: 120 } });
  assert.deepEqual(result.usage, { input: 120, output: null, total: null });
  assert.equal(result.completeness, "partial");
});

test("derives total only when input and output are both explicit", () => {
  const result = extractTokenUsage({ usage: { input_tokens: 120, output_tokens: 30 } });
  assert.deepEqual(result.usage, { input: 120, output: 30, total: 150 });
  assert.equal(result.totalDerived, true);
});

test("uses explicit cost and can calculate cost from explicit embedded rates", () => {
  assert.equal(extractCost({ costUsd: "0.0125" }).costUsd, 0.0125);
  const rated = extractCost({
    usage: { input_tokens: 1000, output_tokens: 500 },
    pricing: { input_usd_per_million_tokens: 2, output_usd_per_million_tokens: 8 },
  });
  assert.equal(rated.costUsd, 0.006);
  assert.equal(rated.source, "embedded-rates");
});

test("summarizes partial coverage without double counting authoritative totals", () => {
  const summary = summarizeUsage({
    steps: [
      { usage: { input_tokens: 100, output_tokens: 20 }, costUsd: 0.01 },
      { usageMetadata: { promptTokenCount: 50 } },
      { tool: "bash" },
    ],
    totals: { tokenUsage: { input: 150, output: 20, total: 170 }, estimatedCostUsd: 0.01 },
  });
  assert.equal(summary.tokens.total, 170);
  assert.equal(summary.tokenCoverage, 2 / 3);
  assert.equal(summary.tokenCompleteness, "partial");
  assert.equal(summary.costUsd, 0.01);
});
