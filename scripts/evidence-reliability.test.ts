/**
 * Evidence Reliability Pass — trace corpus tests.
 *
 * Proves OathLock is honest and useful across messy pasted sessions, markdown
 * exports, structured traces, clean sessions, and partial sessions:
 *  - behavioral findings work WITHOUT token/cost metadata,
 *  - exact cost/tokens are shown ONLY when metadata exists,
 *  - parser confidence is reported per input,
 *  - rules are generated only from supported findings,
 *  - clean/weak sessions yield "No new rule recommended".
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseRawOutput } from "../src/lib/raw-trace-parser.ts";
import { parseTraceJsonl } from "../src/lib/oathlock-trace-adapter.ts";
import { normalizeToTrace } from "../src/lib/normalize-trace.ts";
import { computeTraceMetrics } from "../src/lib/trace-metrics.ts";
import { generateBlackboxReport, type BlackboxReport } from "../src/lib/blackbox-report.ts";
import {
  generateRulesFromReport,
  summarizeRuleGeneration,
} from "../src/lib/generated-rules.ts";
import {
  canShowExactCost,
  canShowExactTokens,
} from "../src/lib/evidence-reliability.ts";

const DIR = join(process.cwd(), "test-fixtures", "sessions");

function read(name: string): string {
  return readFileSync(join(DIR, name), "utf8");
}

/** Run a markdown/text fixture through the messy-paste path. */
async function fromRaw(name: string) {
  const r = parseRawOutput(read(name));
  const raw = r.ok && r.trace ? r.trace : { session_id: `empty_${name}`, steps: [] };
  return pipeline(raw, r.ok);
}

/** Run a structured/JSONL fixture through the normalizer path. */
async function fromObject(raw: unknown, parseOk = true) {
  return pipeline(raw, parseOk);
}

async function pipeline(raw: unknown, parseOk: boolean) {
  const trace = normalizeToTrace(raw);
  const metrics = computeTraceMetrics(trace);
  const report = await generateBlackboxReport(trace);
  const rules = generateRulesFromReport(report, metrics);
  const ruleSummary = summarizeRuleGeneration(rules);
  return { trace, metrics, report, rules, ruleSummary, parseOk };
}

const hasFinding = (report: BlackboxReport, type: string) =>
  report.findings.some((f) => f.type === type);

// ---------------------------------------------------------------------------

test("claude-code-clean.md — clean session, no repeat pattern, no fake rule", async () => {
  const { report, metrics } = await fromRaw("claude-code-clean.md");
  assert.equal(report.parserConfidence.confidence, "medium");
  assert.equal(report.parserConfidence.metadataDetected, true);
  assert.equal(report.parserConfidence.usageFieldsDetected, false);
  assert.equal(hasFinding(report, "retry_spiral"), false);
  assert.equal(report.noNewRuleRecommended, true);
  // No usage metadata → no exact cost/tokens.
  assert.equal(canShowExactCost(metrics), false);
  assert.equal(canShowExactTokens(metrics), false);
});

test("claude-code-retry-loop.md — retry spiral observed without metadata", async () => {
  const { report, metrics, rules } = await fromRaw("claude-code-retry-loop.md");
  assert.equal(report.parserConfidence.confidence, "medium");
  assert.ok(report.parserConfidence.commandsDetected >= 3);
  assert.ok(report.parserConfidence.failedCommandsDetected >= 2);

  const retry = report.findings.find((f) => f.type === "retry_spiral");
  assert.ok(retry, "retry spiral should be detected");
  assert.equal(retry!.category, "behavioral");
  assert.equal(retry!.evidenceSupport, "observed");
  assert.equal(retry!.metricReliability, "high");

  // No usage metadata, but the behavioral rule is still produced.
  assert.equal(canShowExactCost(metrics), false);
  assert.ok(rules.some((r) => r.ruleType === "retry_prevention" && r.status === "active"));
  assert.equal(report.noNewRuleRecommended, false);
});

test("cursor-messy-composer.md — edit thrash detected from visible edits", async () => {
  const { report, rules } = await fromRaw("cursor-messy-composer.md");
  assert.equal(hasFinding(report, "repeated_file_edit"), true);
  assert.ok(rules.some((r) => r.ruleType === "edit_thrash_prevention"));
});

test("cursor-clean-session.md — low confidence, no new rule", async () => {
  const { report, ruleSummary } = await fromRaw("cursor-clean-session.md");
  assert.equal(report.parserConfidence.confidence, "low");
  assert.equal(report.noNewRuleRecommended, true);
  assert.equal(ruleSummary.recommended, false);
  assert.match(ruleSummary.message, /No new workspace rule recommended/i);
});

test("partial-paste-no-tools.txt — insufficient content, confidence none", async () => {
  const { report, parseOk } = await fromRaw("partial-paste-no-tools.txt");
  assert.equal(parseOk, false, "natural-language paste yields no structure");
  assert.equal(report.parserConfidence.confidence, "none");
  assert.equal(report.noNewRuleRecommended, true);
});

test("repeated-edit-thrash.md — same file edited 4× flagged", async () => {
  const { report } = await fromRaw("repeated-edit-thrash.md");
  const thrash = report.findings.find((f) => f.type === "repeated_file_edit");
  assert.ok(thrash);
  assert.equal(thrash!.evidenceSupport, "observed");
});

test("missing-verification.md — behavioral analysis without metadata", async () => {
  const { report, metrics } = await fromRaw("missing-verification.md");
  assert.equal(report.parserConfidence.usageFieldsDetected, false);
  assert.equal(canShowExactCost(metrics), false);
  // The report is still produced (never blocked by missing metadata).
  assert.ok(report.findings.length >= 0);
});

test("codex-history-jsonl.jsonl — structured JSONL, no usage metadata", async () => {
  const { report, metrics } = await fromObject(
    parseTraceJsonl(read("codex-history-jsonl.jsonl")),
  );
  assert.equal(report.parserConfidence.confidence, "medium");
  assert.equal(report.parserConfidence.usageFieldsDetected, false);
  assert.equal(report.parserConfidence.failedCommandsDetected, 1);
  assert.equal(canShowExactCost(metrics), false);
});

test("structured-trace-with-usage.json — exact cost/tokens allowed", async () => {
  const { report, metrics } = await fromObject(
    JSON.parse(read("structured-trace-with-usage.json")),
  );
  assert.equal(report.parserConfidence.confidence, "high");
  assert.equal(report.parserConfidence.usageFieldsDetected, true);
  assert.equal(canShowExactCost(metrics), true);
  assert.equal(canShowExactTokens(metrics), true);
  assert.ok(metrics.costUsd != null && metrics.costUsd > 0);
  assert.equal(hasFinding(report, "retry_spiral"), true);
});

test("structured-trace-no-usage.json — behavior still found, exact cost blocked", async () => {
  const { report, metrics } = await fromObject(
    JSON.parse(read("structured-trace-no-usage.json")),
  );
  assert.equal(report.parserConfidence.confidence, "high");
  assert.equal(report.parserConfidence.usageFieldsDetected, false);
  // CORE GUARANTEE: the same retry behavior is detected without any metadata.
  assert.equal(hasFinding(report, "retry_spiral"), true);
  // And exact cost/tokens are NOT claimed.
  assert.equal(canShowExactCost(metrics), false);
  assert.equal(canShowExactTokens(metrics), false);
  assert.equal(metrics.costUsd, null);
  // The usage-unavailable note is present and honest.
  const note = report.findings.find((f) => f.type === "missing_usage_metadata");
  assert.ok(note);
  assert.equal(note!.evidenceSupport, "unavailable");
  assert.match(note!.summary, /M9R can still analyze visible behavior/i);
});

// --- Cross-cutting guards ---------------------------------------------------

test("usage findings are never the basis for an active workspace rule", async () => {
  const { rules } = await fromObject(
    JSON.parse(read("structured-trace-no-usage.json")),
  );
  // No rule should be minted from the unavailable usage finding.
  assert.ok(!rules.some((r) => r.ruleType === "metadata" && r.status === "active"));
});

test("a session with usage metadata reports exact cost, estimate flag off", async () => {
  const { metrics } = await fromObject(
    JSON.parse(read("structured-trace-with-usage.json")),
  );
  assert.equal(metrics.hasCostData, true);
  assert.equal(metrics.costIsEstimated, false);
});
