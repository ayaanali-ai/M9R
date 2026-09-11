// Unit tests for the OathLock rule evaluation engine. Run with:
//   npm run test
//
// These tests lock in the matching fixes:
//   1. Finding-type spellings (e.g. "repeated_file_read") resolve to the
//      correct structural matcher via the alias map.
//   2. `missing_usage_metadata` fires on BOTH total absence and partial
//      coverage, mirroring the Blackbox Report's detector.
//   3. Clean traces do not produce false-positive matches.
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateRulesForTraceSync, type Rule } from "@/lib/rule-engine";
import type { Trace } from "@/lib/oathlock";

// --- Test helpers ----------------------------------------------------------

let ruleCounter = 0;
function makeRule(leakType: string): Rule {
  ruleCounter += 1;
  return {
    id: `rule-${ruleCounter}`,
    title: `Rule for ${leakType}`,
    leakType,
    severity: "medium",
    cause: "test",
    fixNow: "test",
    promptFix: "test",
    policyRule: "test",
    evidenceNeeded: [],
    limitations: [],
    evidenceLevel: "Observed",
    sourceReportIds: [],
    createdAt: new Date().toISOString(),
  };
}

const RETRY_RULE = makeRule("retry_spiral");
const REPEATED_READ_RULE = makeRule("repeated_file_read"); // report's finding type
const MISSING_META_RULE = makeRule("missing_usage_metadata");
const MISSING_MODEL_RULE = makeRule("missing_model_identity");

const ALL_RULES = [RETRY_RULE, REPEATED_READ_RULE, MISSING_META_RULE, MISSING_MODEL_RULE];

function matchedLeakTypes(trace: Trace, rules: Rule[]): Set<string> {
  const result = evaluateRulesForTraceSync(trace, rules);
  return new Set(result.matchedRules.map((m) => m.rule.leakType));
}

// A "messy" trace: 3 reads of one file, 3 retries + 3 failing steps,
// no token usage anywhere, no model identity.
const messyTrace: Trace = {
  sessionId: "messy-1",
  taskSummary: "messy run",
  steps: [
    { step: 1, filesRead: ["src/app.ts"], errors: ["boom"] },
    { step: 2, filesRead: ["src/app.ts"], errors: ["boom"] },
    { step: 3, filesRead: ["src/app.ts"], errors: ["boom"] },
    { step: 4, shellCommands: ["npm test"] },
  ],
  totals: { steps: 4, failedCommands: 3, retries: 3 },
};

// A "clean" trace: distinct reads, no errors/retries, full token usage + model.
const cleanTrace: Trace = {
  sessionId: "clean-1",
  taskSummary: "clean run",
  steps: [
    {
      step: 1,
      model: "claude-opus-4-8",
      filesRead: ["a.ts"],
      tokenUsage: { input: 10, output: 5, total: 15 },
    },
    {
      step: 2,
      model: "claude-opus-4-8",
      filesRead: ["b.ts"],
      tokenUsage: { input: 8, output: 4, total: 12 },
    },
  ],
  totals: {
    steps: 2,
    failedCommands: 0,
    retries: 0,
    tokenUsage: { input: 18, output: 9, total: 27 },
  },
};

// --- Tests -----------------------------------------------------------------

test("repeated_file_read rule resolves via alias and triggers on repeated reads", () => {
  const matched = matchedLeakTypes(messyTrace, [REPEATED_READ_RULE]);
  assert.ok(
    matched.has("repeated_file_read"),
    "the report's `repeated_file_read` finding type must reach the repeated-context matcher",
  );
});

test("messy trace triggers all three major rules", () => {
  const matched = matchedLeakTypes(messyTrace, ALL_RULES);
  assert.ok(matched.has("retry_spiral"), "retry spiral should trigger");
  assert.ok(matched.has("repeated_file_read"), "repeated reads should trigger");
  assert.ok(matched.has("missing_usage_metadata"), "missing metadata should trigger");
  assert.ok(matched.has("missing_model_identity"), "missing model identity should trigger");
});

test("missing_usage_metadata fires on PARTIAL coverage (matches report)", () => {
  // 5 steps, only 1 carries token usage -> <50% coverage on a >3-step trace.
  const partialTrace: Trace = {
    sessionId: "partial-1",
    taskSummary: "partial usage",
    steps: [
      { step: 1, model: "m", tokenUsage: { input: 1, output: 1, total: 2 } },
      { step: 2, model: "m" },
      { step: 3, model: "m" },
      { step: 4, model: "m" },
      { step: 5, model: "m" },
    ],
    totals: { steps: 5, failedCommands: 0, retries: 0 },
  };
  const matched = matchedLeakTypes(partialTrace, [MISSING_META_RULE]);
  assert.ok(
    matched.has("missing_usage_metadata"),
    "partial metadata coverage must trigger the rule, not silently miss",
  );
});

test("clean trace produces no false-positive matches", () => {
  const result = evaluateRulesForTraceSync(cleanTrace, ALL_RULES);
  assert.equal(result.matchedRules.length, 0, "clean trace should match no rules");
  assert.equal(result.unmatchedRules.length, ALL_RULES.length);
});

test("matched rules carry a non-empty human-readable reason", () => {
  const result = evaluateRulesForTraceSync(messyTrace, ALL_RULES);
  for (const m of result.matchedRules) {
    assert.ok(m.reason.length > 0, `${m.rule.leakType} should have a reason`);
    assert.ok(["weak", "moderate", "strong"].includes(m.signalStrength));
  }
});

// --- Report-driven matching ------------------------------------------------

test("a rule fires when the report recommends it via a SECURITY SIGNAL only", () => {
  // The report flags missing metadata through a security signal (and a
  // recommendation) — NOT a finding the rule's structural matcher would catch.
  // Without report-driven matching, this rule would silently miss.
  const reportWithSignalOnly = {
    findings: [], // deliberately empty
    securitySignals: [
      {
        kind: "other",
        title: "Missing execution metadata",
        severity: "medium" as const,
      },
    ],
    recommendations: [
      { title: "Require usage metadata on all model calls" },
    ],
  };
  // Use a trace that on its own would NOT trip the structural matcher
  // (only 2 steps, so partial-coverage rule cannot fire).
  const thinTrace: Trace = {
    sessionId: "thin-1",
    taskSummary: "thin",
    steps: [
      { step: 1, model: "m", tokenUsage: { input: 1, output: 1, total: 2 } },
      { step: 2, model: "m" },
    ],
    totals: { steps: 2, failedCommands: 0, retries: 0 },
  };

  const structuralOnly = matchedLeakTypes(thinTrace, [MISSING_META_RULE]);
  assert.ok(
    !structuralOnly.has("missing_usage_metadata"),
    "sanity: structural matching alone should NOT fire here",
  );

  const result = evaluateRulesForTraceSync(thinTrace, [MISSING_META_RULE], reportWithSignalOnly);
  const matched = new Set(result.matchedRules.map((m) => m.rule.leakType));
  assert.ok(
    matched.has("missing_usage_metadata"),
    "report's signal/recommendation must trigger the rule",
  );
});

test("report-driven matching derives signal strength from finding severity", () => {
  const report = {
    findings: [
      { id: "f1", type: "retry_spiral", title: "Retry spiral", severity: "high" as const },
    ],
    securitySignals: [],
    recommendations: [],
  };
  const result = evaluateRulesForTraceSync(cleanTrace, [RETRY_RULE], report);
  const m = result.matchedRules.find((x) => x.rule.leakType === "retry_spiral");
  assert.ok(m, "retry rule should match via the report finding");
  assert.equal(m!.signalStrength, "strong", "high-severity finding => strong signal");
});

test("report-driven matching does not invent matches for unrelated rules", () => {
  const report = {
    findings: [
      { id: "f1", type: "retry_spiral", title: "Retry spiral", severity: "high" as const },
    ],
    securitySignals: [],
    recommendations: [],
  };
  // Clean trace + a report that only mentions retry_spiral: the metadata rule
  // must NOT match (no finding, no signal, structural matcher clean).
  const result = evaluateRulesForTraceSync(cleanTrace, [MISSING_META_RULE], report);
  assert.equal(result.matchedRules.length, 0, "unrelated rules must not match");
});
