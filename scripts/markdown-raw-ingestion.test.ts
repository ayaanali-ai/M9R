/**
 * Markdown & raw session ingestion — OathLock
 * ----------------------------------------------------------------------------
 * Proves OathLock ingests Claude Code CLI markdown exports, raw text logs,
 * JSONL, and JSON without breaking the structured-JSON pipeline, and that source
 * quality is scored honestly and gates rule generation.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  detectSessionInput,
  sourceQualityAllowsActiveRules,
} from "../src/lib/session-input-detection.ts";
import { isAcceptedSessionFile } from "../src/lib/trace-inspection.ts";
import { normalizeRawSession, MAX_TITLE_LENGTH } from "../src/lib/raw-session-normalizer.ts";
import { normalizeToTrace } from "../src/lib/normalize-trace.ts";
import { computeTraceMetrics } from "../src/lib/trace-metrics.ts";
import { generateBlackboxReport } from "../src/lib/blackbox-report.ts";
import {
  generateRulesFromReport,
  summarizeRuleGeneration,
} from "../src/lib/generated-rules.ts";
import { dedupeRules } from "../src/lib/rule-deduplication.ts";
import { generateAllRulesFiles } from "../src/lib/rules-file-generator.ts";

const DIR = join(process.cwd(), "test-fixtures", "sessions");
const read = (name: string) => readFileSync(join(DIR, name), "utf8");

/** Full ingestion → report → rules pipeline from a file fixture. */
async function ingest(name: string) {
  const raw = read(name);
  const result = normalizeRawSession(raw, name);
  const trace = result.trace ? normalizeToTrace(result.trace) : normalizeToTrace({ steps: [] });
  const metrics = computeTraceMetrics(trace);
  const report = await generateBlackboxReport(trace);
  const rules = generateRulesFromReport(report, metrics);
  return { result, trace, metrics, report, rules };
}

// --- Acceptance: file types -------------------------------------------------

test(".md upload is accepted (Claude Code export)", async () => {
  const { result } = await ingest("claude-code-export-md.md");
  assert.equal(result.ok, true);
  assert.ok(result.trace);
});

test(".txt upload is accepted", async () => {
  const { result } = await ingest("raw-coding-session.txt");
  assert.equal(result.ok, true);
});

test(".log behaves like raw text (detected, not rejected)", () => {
  const d = detectSessionInput("$ npm run build\nError: build failed\nEdited src/x.ts", "session.log");
  assert.notEqual(d.format, "unknown");
  assert.ok(d.sourceQuality === "medium" || d.sourceQuality === "limited");
});

test(".json structured trace still works (existing pipeline preserved)", async () => {
  const raw = read("structured-trace-with-usage.json");
  const d = detectSessionInput(raw, "structured-trace-with-usage.json");
  assert.equal(d.format, "structured_json");
  const result = normalizeRawSession(raw, "structured-trace-with-usage.json", d);
  assert.equal(result.ok, true);
  const report = await generateBlackboxReport(normalizeToTrace(result.trace));
  assert.equal(report.parserConfidence.usageFieldsDetected, true);
});

test(".jsonl is detected as JSONL", () => {
  const d = detectSessionInput(read("jsonl-session.jsonl"), "jsonl-session.jsonl");
  assert.equal(d.format, "jsonl");
  assert.equal(d.sourceQuality, "strong");
});

// --- Claude Code CLI export -------------------------------------------------

test("Claude Code CLI export is detected as Claude Code CLI", () => {
  const d = detectSessionInput(read("claude-code-export-md.md"), "claude-code-export-md.md");
  assert.equal(d.format, "markdown_export");
  assert.equal(d.source, "claude_code_cli");
});

test("Claude Code CLI export produces medium/strong source quality", () => {
  const d = detectSessionInput(read("claude-code-export-md.md"));
  assert.ok(d.sourceQuality === "medium" || d.sourceQuality === "strong", d.sourceQuality);
});

test("Claude Code CLI export extracts model and working directory", async () => {
  const { result } = await ingest("claude-code-export-md.md");
  const extracted = result.extracted.join(" | ");
  assert.match(extracted, /model/i);
  assert.match(extracted, /working directory/i);
});

test("Claude Code CLI export does not claim exact cost/tokens without metadata", async () => {
  const { result, metrics } = await ingest("claude-code-export-md.md");
  assert.equal(metrics.hasTokenUsage, false);
  assert.equal(metrics.hasCostData, false);
  const unavailable = result.unavailable.join(" | ").toLowerCase();
  assert.match(unavailable, /token/);
  assert.match(unavailable, /cost/);
});

test("Claude Code CLI export carries an input profile through to the report", async () => {
  const { report } = await ingest("claude-code-export-md.md");
  assert.ok(report.inputProfile);
  assert.equal(report.inputProfile!.source, "claude_code_cli");
  assert.equal(report.inputProfile!.formatLabel, "Claude Code CLI export");
});

// --- Fallback + honesty -----------------------------------------------------

test("invalid JSON falls back to raw text instead of failing", async () => {
  const d = detectSessionInput(read("invalid-json-fallback.txt"), "invalid-json-fallback.txt");
  assert.notEqual(d.format, "structured_json");
  const { result } = await ingest("invalid-json-fallback.txt");
  assert.equal(result.ok, true, "malformed JSON is analyzed as raw text, not rejected");
});

test("raw pasted summary (no execution evidence) is limited/insufficient", () => {
  const summary =
    "I asked the agent to refactor the auth module. It looked at the code and explained " +
    "the approach, then said it was done. Overall it seemed to go well.";
  const d = detectSessionInput(summary);
  assert.ok(
    d.sourceQuality === "limited" || d.sourceQuality === "insufficient",
    d.sourceQuality,
  );
});

test("raw text with commands/errors/edits is medium quality", () => {
  const d = detectSessionInput(read("raw-coding-session.txt"));
  assert.equal(d.sourceQuality, "medium");
});

// --- Source quality gates rule generation -----------------------------------

test("active rules are not generated from insufficient input", async () => {
  // A prose-only summary: detection says insufficient → no rules at all.
  const summary = "The agent refactored the module and said everything passed. Looks good.";
  const detection = detectSessionInput(summary);
  assert.equal(detection.sourceQuality, "insufficient");
  const result = normalizeRawSession(summary, null, detection);
  // Even if we force a trace through, insufficient quality blocks active rules.
  const trace = result.trace ? normalizeToTrace(result.trace) : normalizeToTrace({ steps: [] });
  const report = await generateBlackboxReport(trace);
  const rules = generateRulesFromReport(report, computeTraceMetrics(trace));
  assert.ok(!rules.some((r) => r.status === "active"), "no active rules from insufficient input");
});

test("limited source quality never yields active rules", async () => {
  // Synthesize a report with a strong behavioral finding but limited input.
  const trace = normalizeToTrace({
    schema: "oathlock.trace.v0",
    session_id: "limited-1",
    input_profile: {
      format: "raw_text",
      format_label: "Raw text transcript",
      source: "generic_agent",
      source_label: "Generic coding agent",
      source_quality: "limited",
      source_quality_label: "Limited",
      extracted: [],
      unavailable: [],
      reasons: [],
    },
    steps: [
      { step: 1, shell_commands: ["npm run build"], errors: ["build failed"] },
      { step: 2, shell_commands: ["npm run build"], errors: ["build failed"], retries: 1 },
      { step: 3, shell_commands: ["npm run build"], errors: ["build failed"], retries: 1 },
    ],
  });
  const report = await generateBlackboxReport(trace);
  const rules = generateRulesFromReport(report, computeTraceMetrics(trace));
  assert.ok(rules.length > 0, "limited input can still suggest rules");
  assert.ok(!rules.some((r) => r.status === "active"), "but none are active");
  const summary = summarizeRuleGeneration(rules);
  assert.ok(summary.needsReviewCount > 0 || !summary.recommended);
});

// --- Smoke: the real attached Claude Code CLI export ------------------------

test("smoke: real oathlock-session.md ingests as a Claude Code CLI export", async () => {
  const raw = readFileSync(join(process.cwd(), "oathlock-session.md"), "utf8");
  const detection = detectSessionInput(raw, "oathlock-session.md");
  assert.equal(detection.source, "claude_code_cli");
  assert.equal(detection.format, "markdown_export");
  assert.ok(
    detection.sourceQuality === "medium" || detection.sourceQuality === "strong",
    detection.sourceQuality,
  );

  const result = normalizeRawSession(raw, "oathlock-session.md", detection);
  assert.equal(result.ok, true);
  const trace = normalizeToTrace(result.trace);
  const metrics = computeTraceMetrics(trace);
  const report = await generateBlackboxReport(trace);

  // At least medium parser confidence, behavioral output only.
  assert.ok(["medium", "high"].includes(report.parserConfidence.confidence));
  // Exact token/cost stay unavailable unless metadata appears.
  assert.equal(metrics.hasTokenUsage, false);
  assert.equal(metrics.hasCostData, false);
  assert.ok(report.inputProfile);
});

test("real oathlock-session.md exports are evidence-only: edit-thrash rule + provenance, no static guardrails", async () => {
  const raw = readFileSync(join(process.cwd(), "oathlock-session.md"), "utf8");
  const detection = detectSessionInput(raw, "oathlock-session.md");
  const result = normalizeRawSession(raw, "oathlock-session.md", detection);
  assert.equal(result.ok, true);
  const trace = normalizeToTrace(result.trace);
  const metrics = computeTraceMetrics(trace);
  const report = await generateBlackboxReport(trace);
  const rules = dedupeRules(generateRulesFromReport(report, metrics)).rules;

  // The only evidence-backed rule from this session is edit-thrash prevention.
  assert.equal(rules.length, 1, `expected exactly 1 rule, got ${rules.length}`);
  assert.equal(rules[0].ruleType, "edit_thrash_prevention");

  const files = generateAllRulesFiles(rules, {
    sessionName: "oathlock-session.md",
    date: "2026-06-28",
  });

  // No static, generic guardrails may leak into any export or the copy block.
  const BANNED_SCAFFOLD = [
    /Verification protocol/i,
    /## Verification\b/,
    /Before reporting a task as done/i,
    /If a command fails/i,
    /If usage metadata/i,
    /Keep these rules honest/i,
  ];
  for (const file of files) {
    // The real generated rule must be present...
    assert.ok(
      file.content.includes(rules[0].body),
      `${file.filename} must contain the edit-thrash rule`,
    );
    // ...and minimal provenance...
    assert.match(file.content, /OathLock/i);
    // ...but none of the banned static guardrails.
    for (const re of BANNED_SCAFFOLD) {
      assert.ok(!re.test(file.content), `${file.filename} must not contain ${re}`);
    }
  }
});

test("medium/strong quality can produce active rules when evidence supports it", async () => {
  const { rules } = await ingest("raw-coding-session.txt");
  assert.ok(sourceQualityAllowsActiveRules("medium"));
  // The raw session has a build-fix loop; an active rule should be possible.
  assert.ok(rules.length > 0);
});

// ===========================================================================
// Correctness pass: honest reports from markdown/raw exports
// ===========================================================================

// --- 1. Upload acceptance ---------------------------------------------------

test("upload accepts .json/.jsonl/.md/.txt/.log; rejects binary", () => {
  for (const name of ["s.json", "s.jsonl", "s.md", "s.txt", "s.log"]) {
    assert.equal(isAcceptedSessionFile(name, ""), true, name);
  }
  assert.equal(isAcceptedSessionFile("transcript", "text/plain"), true);
  assert.equal(isAcceptedSessionFile("photo.png", "image/png"), false);
  assert.equal(isAcceptedSessionFile("archive.zip", "application/zip"), false);
});

// --- 2. No false model handoffs from text mentions --------------------------

test("real Claude Code export does not produce claude-code -> claude-app handoff", async () => {
  const { report } = await ingest("claude-code-export-md.md");
  assert.equal(report.modelHandoffs.length, 0);
});

test("pasted prompt mentioning multiple agents does not create a handoff", async () => {
  const prompt =
    "Compare Claude Code CLI, Claude Desktop/web (claude-app), Cursor, and Codex export paths.\n" +
    "$ npm run build\nError: build failed\nEdited src/x.ts\n$ npm run build\nBuild succeeded";
  const detection = detectSessionInput(prompt);
  const result = normalizeRawSession(prompt, null, detection);
  const report = await generateBlackboxReport(normalizeToTrace(result.trace));
  assert.equal(report.modelHandoffs.length, 0);
});

test("structured trace with real model changes still creates a handoff", async () => {
  const trace = normalizeToTrace({
    schema: "oathlock.trace.v0",
    session_id: "handoff-1",
    steps: [
      { step: 1, actor: "model", model: "claude-haiku-4-5" },
      { step: 2, actor: "model", model: "claude-opus-4-8" },
    ],
  });
  const report = await generateBlackboxReport(trace);
  assert.equal(report.modelHandoffs.length, 1);
  assert.equal(report.modelHandoffs[0].toModel, "claude-opus-4-8");
});

// --- 3. High-volume model-call findings need real call metadata -------------

test("markdown export does not produce a high-volume model-call finding", async () => {
  const { report } = await ingest("claude-code-export-md.md");
  assert.ok(!report.securitySignals.some((s) => s.kind === "high_volume_queries"));
});

test("structured trace with repeated model calls can produce high-volume signal", async () => {
  const steps = Array.from({ length: 10 }, (_, i) => ({
    step: i + 1,
    actor: "model",
    model: "claude-opus-4-8",
  }));
  const report = await generateBlackboxReport(
    normalizeToTrace({ session_id: "vol-1", steps }),
  );
  assert.ok(report.securitySignals.some((s) => s.kind === "high_volume_queries"));
});

// --- 4. Missing metadata is a limitation, not a finding/signal/rule ---------

test("markdown export: missing token/cost shown in profile, not as finding/signal", async () => {
  const { report, rules, metrics } = await ingest("claude-code-export-md.md");
  // Surfaced as a limitation in the input profile.
  assert.ok(report.inputProfile!.unavailable.some((u) => /token/i.test(u)));
  assert.ok(report.inputProfile!.unavailable.some((u) => /cost/i.test(u)));
  // NOT a finding, NOT a security signal, NOT a recommendation/rule.
  assert.ok(!report.findings.some((f) => f.type === "missing_usage_metadata"));
  assert.ok(!report.securitySignals.some((s) => /metadata/i.test(s.title)));
  assert.ok(!report.recommendations.some((r) => /require usage metadata/i.test(r.title)));
  assert.ok(!rules.some((r) => r.ruleType === "metadata"));
  // Exact cost/tokens stay blocked.
  assert.equal(metrics.hasCostData, false);
  assert.equal(metrics.hasTokenUsage, false);
});

// --- 5. Verification detection for recap/export summaries -------------------

test("real markdown fixture detects verification summary present", async () => {
  const { report } = await ingest("claude-code-export-md.md");
  assert.equal(report.verificationPresent, true);
});

test("markdown fixture does not generate a generic verification rule", async () => {
  const { rules } = await ingest("claude-code-export-md.md");
  assert.ok(!rules.some((r) => r.ruleType === "verification"));
});

test("missing-verification fixture still produces a verification rule", async () => {
  // Failures with no verification success → the verify rule should still fire.
  const trace = normalizeToTrace({
    session_id: "noverify-1",
    steps: [
      { step: 1, shell_commands: ["npm run build"], errors: ["build failed"] },
      { step: 2, shell_commands: ["npm run build"], errors: ["build failed"], retries: 1 },
    ],
  });
  const report = await generateBlackboxReport(trace);
  assert.equal(report.verificationPresent, false);
  const rules = generateRulesFromReport(report, computeTraceMetrics(trace));
  assert.ok(rules.some((r) => r.ruleType === "verification"));
});

// --- 6. Rule generation stays tight for markdown exports --------------------

test("markdown fixture generates only supported visible-evidence rules", async () => {
  const { rules } = await ingest("claude-code-export-md.md");
  for (const r of rules) {
    assert.ok(
      ["edit_thrash_prevention", "context_control", "retry_prevention"].includes(r.ruleType),
      `unexpected rule from markdown export: ${r.ruleType}`,
    );
    assert.ok(r.body.length > 30, "rule should be specific, not generic");
  }
});

// --- 7. Readable report title ----------------------------------------------

test("long prompt produces a short, readable report title", async () => {
  const { trace } = await ingest("claude-code-export-md.md");
  assert.ok(trace.taskSummary.length <= MAX_TITLE_LENGTH, trace.taskSummary);
  assert.match(trace.taskSummary, /^Claude Code export/);
});

// --- 8. Source profile copy -------------------------------------------------

test("markdown export profile lists extracted behavioral evidence", async () => {
  const { report } = await ingest("claude-code-export-md.md");
  const extracted = report.inputProfile!.extracted.join(" | ").toLowerCase();
  for (const term of ["model", "working directory", "verification"]) {
    assert.match(extracted, new RegExp(term));
  }
});
