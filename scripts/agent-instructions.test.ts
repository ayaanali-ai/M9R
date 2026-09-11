/**
 * Tests for the agent-instruction layer — proving it turns real findings into
 * pasteable rules and only quotes impact numbers the trace actually supports.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { parseRawOutput } from "../src/lib/raw-trace-parser.ts";
import { normalizeToTrace } from "../src/lib/normalize-trace.ts";
import { computeTraceMetrics } from "../src/lib/trace-metrics.ts";
import { generateBlackboxReport } from "../src/lib/blackbox-report.ts";
import {
  buildAgentInstructionBlock,
  deriveAgentRules,
  expectedImpact,
  recommendationInstruction,
  coveredFindingCount,
} from "../src/lib/agent-instructions.ts";

const RETRY_SAMPLE = `Task: fix the failing build
$ npm run build
Error: build failed
Reading src/config.ts
$ npm run build
Error: build failed again
Reading src/config.ts
Edited src/config.ts
$ npm run build
Build succeeded
`;

async function buildReport(raw: string) {
  const trace = normalizeToTrace(parseRawOutput(raw).trace);
  const report = await generateBlackboxReport(trace);
  const metrics = computeTraceMetrics(trace);
  return { report, metrics };
}

test("derives a non-empty, priority-ordered instruction block from real findings", async () => {
  const { report } = await buildReport(RETRY_SAMPLE);
  const rules = deriveAgentRules(report);
  assert.ok(rules.length > 0, "should derive at least one rule");
  // High-priority rules come first.
  const priorities = rules.map((r) => r.priority);
  const rank = { high: 3, medium: 2, low: 1 };
  for (let i = 1; i < priorities.length; i++) {
    assert.ok(rank[priorities[i - 1]] >= rank[priorities[i]], "rules must be priority-ordered");
  }

  const block = buildAgentInstructionBlock(report);
  assert.ok(block?.includes("OATHLOCK RULES (HIGHEST PRIORITY)"));
  assert.ok(block?.includes("* "), "block should contain bullet rules");
});

test("retry impact only quotes avoided re-runs the metrics support", async () => {
  const { report, metrics } = await buildReport(RETRY_SAMPLE);
  const retry = report.findings.find((f) => f.type === "retry_spiral");
  assert.ok(retry, "sample should produce a retry finding");

  const impact = expectedImpact(retry!, metrics);
  assert.ok(impact, "retry finding should have an impact line");
  assert.equal(impact!.tone, "win");
  // npm run build failed twice → 1 avoided re-run. Never a fabricated number.
  assert.match(impact!.text, /avoided 1 needless re-run/);
});

test("never fabricates token/cost in impact when the trace has none", async () => {
  const { report, metrics } = await buildReport(RETRY_SAMPLE);
  for (const finding of report.findings) {
    const impact = expectedImpact(finding, metrics);
    if (impact) {
      assert.ok(!/\$\d/.test(impact.text), `no cost should appear: "${impact.text}"`);
      assert.ok(!/\dk tokens|\d tokens/.test(impact.text), `no token figure: "${impact.text}"`);
    }
  }
});

test("recommendation instruction produces a focused pasteable snippet", async () => {
  const { report } = await buildReport(RETRY_SAMPLE);
  const rec = report.recommendations[0];
  const snippet = recommendationInstruction(report, rec.id);
  assert.ok(snippet?.includes("OATHLOCK RULE"));
  assert.ok(snippet?.includes("* "));
});

test("coveredFindingCount counts only findings matched by active rule leakTypes", async () => {
  const { report } = await buildReport(RETRY_SAMPLE);
  const types = report.findings.map((f) => f.type);
  assert.equal(coveredFindingCount(report, []), 0);
  assert.equal(coveredFindingCount(report, [types[0]]), 1);
  assert.equal(coveredFindingCount(report, types), report.findings.length);
});
