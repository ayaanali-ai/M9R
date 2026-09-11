/**
 * Report generation pipeline contract — OathLock
 * ----------------------------------------------------------------------------
 * Locks in the rule-generation behavior that the still-live submit-session
 * CLI flow depends on (agent-session-analysis.ts -> blackbox-report.ts ->
 * generated-rules.ts -> agent-instructions.ts):
 *  - no fake severity, no fake precision, no generic recommendations
 *
 * The web report page this file used to also assert page-shape against
 * (src/app/report/uploaded/page.tsx) was removed along with the rest of the
 * Blackbox Report marketing surface; these behavioral assertions run the
 * real pipeline over the attached oathlock-session.md fixture and are
 * independent of that page.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { detectSessionInput } from "../src/lib/session-input-detection.ts";
import { normalizeRawSession } from "../src/lib/raw-session-normalizer.ts";
import { normalizeToTrace } from "../src/lib/normalize-trace.ts";
import { computeTraceMetrics } from "../src/lib/trace-metrics.ts";
import { generateBlackboxReport } from "../src/lib/blackbox-report.ts";
import { generateRulesFromReport } from "../src/lib/generated-rules.ts";
import { dedupeRules } from "../src/lib/rule-deduplication.ts";
import { expectedImpact, buildAgentInstructionBlock } from "../src/lib/agent-instructions.ts";

async function ingestSmoke() {
  const fixtureName = "oathlock-session.md";
  const raw = readFileSync(join(process.cwd(), fixtureName), "utf8");
  const detection = detectSessionInput(raw, fixtureName);
  const result = normalizeRawSession(raw, fixtureName, detection);
  const trace = normalizeToTrace(result.trace);
  const metrics = computeTraceMetrics(trace);
  const report = await generateBlackboxReport(trace);
  const rules = dedupeRules(generateRulesFromReport(report, metrics)).rules;
  return { trace, metrics, report, rules };
}

// --- Behavioral fixture correctness ----------------------------------------

test("smoke fixture: no high-severity findings", async () => {
  const { report } = await ingestSmoke();
  assert.equal(report.findings.filter((f) => f.severity === "high").length, 0);
});

test("smoke fixture: edit-thrash is workflow risk (medium), never high", async () => {
  const { report } = await ingestSmoke();
  const edit = report.findings.find((f) => f.type === "repeated_file_edit");
  if (edit) assert.equal(edit.severity, "medium");
});

test("smoke fixture: no generic 'address highest-severity' recommendation", async () => {
  const { report } = await ingestSmoke();
  assert.ok(!report.recommendations.some((r) => /highest-severity/i.test(r.title)));
  assert.ok(!report.recommendations.some((r) => /require usage metadata/i.test(r.title)));
});

test("smoke fixture: no model handoffs, no security signals", async () => {
  const { report } = await ingestSmoke();
  assert.equal(report.modelHandoffs.length, 0);
  assert.equal(report.securitySignals.length, 0);
});

test("smoke fixture: verification present, so no verification rule", async () => {
  const { report, rules } = await ingestSmoke();
  assert.equal(report.verificationPresent, true);
  assert.ok(!rules.some((r) => r.ruleType === "verification"));
});

test("smoke fixture: exactly one generated rule — edit-thrash prevention", async () => {
  const { rules } = await ingestSmoke();
  assert.equal(rules.length, 1);
  assert.equal(rules[0].ruleType, "edit_thrash_prevention");
  assert.match(rules[0].title, /Inspect (the )?root cause before re-editing a file/);
});

test("expected impact carries no fake precision for edit churn", async () => {
  const { report, metrics } = await ingestSmoke();
  const edit = report.findings.find((f) => f.type === "repeated_file_edit");
  if (edit) {
    const impact = expectedImpact(edit, metrics);
    assert.ok(impact, "edit finding should have an expected-impact line");
    assert.ok(!/would have collapsed/i.test(impact!.text), impact!.text);
    assert.match(impact!.text, /may reduce edit churn/i);
  }
});

test("pasteable instruction block carries no banned overclaiming copy", async () => {
  const { report } = await ingestSmoke();
  const block = buildAgentInstructionBlock(report) ?? "";
  for (const re of [/would have collapsed/i, /high-volume queries/i, /claude-code → claude-app/i]) {
    assert.ok(!re.test(block), `instruction block must not contain ${re}`);
  }
});
