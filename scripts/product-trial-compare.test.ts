/**
 * Product Trial — conservative two-run comparison tests
 * ----------------------------------------------------------------------------
 * Proves the trial layer never fabricates token/cost or quality gains, reports
 * "unavailable/unknown" honestly, detects behavioral improvement/recurrence from
 * objective counts, and contains no overclaiming language. Docs + CLI + dashboard
 * copy are checked structurally.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  buildProductTrialComparison,
  USAGE_UNAVAILABLE_MESSAGE,
  QUALITY_UNJUDGEABLE_MESSAGE,
  QUALITY_BASELINE_LACKS_MESSAGE,
  QUALITY_BOTH_PRESENT_MESSAGE,
  QUALITY_MEASURABLE_HINT,
  RULE_HEALTH_SNAPSHOT_UNAVAILABLE_MESSAGE,
  BEHAVIOR_SNAPSHOT_UNAVAILABLE_MESSAGE,
  type TrialCompareInput,
} from "../src/lib/product-trial-compare.ts";
import { FORBIDDEN_PROOF_PHRASES } from "../src/lib/agent-run-core.ts";
import type { RunStats } from "../src/lib/run-comparison.ts";
import {
  deriveQualitySignals,
  extractQualitySignals,
  hasCommandTiedVerificationSignal,
} from "../src/lib/quality-signal-extraction.ts";

const WORKSPACE_PATH = "src/components/product/AgentWorkspaceClient.tsx";
// AgentWorkspaceClient.tsx was split into src/components/product/agent-workspace/*
// with the orchestrator left in the original file. `read(WORKSPACE_PATH)`
// transparently returns the concatenation of the orchestrator plus every
// split file, so assertions below keep checking the same source text
// regardless of which file it now lives in -- same multi-file-read pattern
// as scripts/workspace-rules.test.ts.
const WORKSPACE_SPLIT_FILES = [
  WORKSPACE_PATH,
  "src/components/product/agent-workspace/shared.tsx",
  "src/components/product/agent-workspace/strip-board.tsx",
  "src/components/product/agent-workspace/run-panels.tsx",
  "src/components/product/agent-workspace/preflight.tsx",
  "src/components/product/agent-workspace/approval-center.tsx",
  "src/components/product/agent-workspace/handoff.tsx",
];
const read = (p: string) =>
  p === WORKSPACE_PATH
    ? WORKSPACE_SPLIT_FILES.map((f) => readFileSync(resolve(process.cwd(), f), "utf8")).join("\n")
    : readFileSync(resolve(process.cwd(), p), "utf8");

function stats(overrides: Partial<RunStats> = {}): RunStats {
  return {
    stepCount: 5,
    retries: 0,
    repeatedCommands: 0,
    repeatedFileEdits: 0,
    failedCommands: 0,
    toolCalls: 4,
    changedFiles: 1,
    scopeCreepSignals: 1,
    verificationPresent: false,
    totalTokens: null,
    costUsd: null,
    ...overrides,
  };
}

function input(overrides: Partial<TrialCompareInput> = {}): TrialCompareInput {
  return {
    baselineRunId: "run-a",
    laterRunId: "run-b",
    loadedRules: [],
    promotedRuleIds: [],
    before: stats(),
    after: stats(),
    ...overrides,
  };
}

function assertNoOverclaim(text: string) {
  const lower = text.toLowerCase();
  for (const phrase of [...FORBIDDEN_PROOF_PHRASES, "caused", "worked", "fixed", "prevented"]) {
    assert.ok(!lower.includes(phrase), `overclaim found: "${phrase}" in: ${text}`);
  }
}

const SMOKE_EVIDENCE_STYLE = `## Verification commands
- npm run lint: passed, 0 errors, 3 warnings
- npm test: passed, 568 passed, 0 failed
- npm run build: passed, with existing warning categories

## Failed commands
- None.
`;

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

test("compare refuses to claim cost savings without usage metadata", () => {
  const c = buildProductTrialComparison(
    input({
      before: stats({ repeatedFileEdits: 3 }),
      after: stats({ repeatedFileEdits: 0 }),
      usageBefore: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null },
      usageAfter: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null },
    }),
  );
  assert.equal(c.usage_delta.available, false);
  // The verdict mentions improved behavior but makes NO cost claim.
  assertNoOverclaim(c.honest_verdict);
  assert.ok(c.honest_verdict.includes(USAGE_UNAVAILABLE_MESSAGE));
  assert.ok(!/saved|cheaper|less cost/i.test(c.honest_verdict));
});

test("compare reports unknown usage when metadata is missing", () => {
  const c = buildProductTrialComparison(input());
  assert.equal(c.usage_delta.available, false);
  assert.equal(c.usage_delta.message, USAGE_UNAVAILABLE_MESSAGE);
  assert.equal(c.usage_delta.totalTokensBefore, null);
  assert.equal(c.usage_delta.totalTokensAfter, null);
});

test("compare compares usage only when BOTH runs recorded metadata", () => {
  const c = buildProductTrialComparison(
    input({
      before: stats({ totalTokens: 1000, costUsd: 0.02 }),
      after: stats({ totalTokens: 600, costUsd: 0.012 }),
      usageBefore: { inputTokens: 700, outputTokens: 300, totalTokens: 1000, cost: 0.02 },
      usageAfter: { inputTokens: 400, outputTokens: 200, totalTokens: 600, cost: 0.012 },
    }),
  );
  assert.equal(c.usage_delta.available, true);
  assert.equal(c.usage_delta.totalTokensBefore, 1000);
  assert.equal(c.usage_delta.totalTokensAfter, 600);
  assert.equal(c.usage_delta.costAfter, 0.012);
});

// ---------------------------------------------------------------------------
// Behavioral delta
// ---------------------------------------------------------------------------

test("compare detects behavioral improvement when a repeated pattern disappears", () => {
  const c = buildProductTrialComparison(
    input({ before: stats({ repeatedFileEdits: 4, retries: 2 }), after: stats({ repeatedFileEdits: 0, retries: 0 }) }),
  );
  const edits = c.behavioral_delta.find((m) => m.key === "repeatedFileEdits");
  assert.ok(edits);
  assert.equal(edits!.before, 4);
  assert.equal(edits!.after, 0);
  assert.equal(edits!.change, "improved");
});

test("compare detects violation when the pattern recurs (Rule Health violated)", () => {
  const c = buildProductTrialComparison(
    input({
      before: stats({ repeatedFileEdits: 2 }),
      after: stats({ repeatedFileEdits: 3 }),
      ruleHealth: { evaluated: true, dominant: "violated", items: [{ status: "violated", title: "Inspect root cause" }] },
    }),
  );
  const edits = c.behavioral_delta.find((m) => m.key === "repeatedFileEdits");
  assert.equal(edits!.change, "worsened");
  assert.match(c.honest_verdict, /pattern recurred while this rule was loaded/i);
  assertNoOverclaim(c.honest_verdict);
});

test("neutral activity metrics are not labeled worsened by raw count", () => {
  const c = buildProductTrialComparison(
    input({
      before: stats({ failedCommands: 0, toolCalls: 0, changedFiles: 0, verificationPresent: false }),
      after: stats({ failedCommands: 2, toolCalls: 4, changedFiles: 1, verificationPresent: true }),
      qualityBefore: null,
      qualityAfter: { testsPassed: true },
    }),
  );

  assert.equal(c.behavioral_delta.find((m) => m.key === "failedCommands")!.change, "increased");
  assert.equal(c.behavioral_delta.find((m) => m.key === "toolCalls")!.change, "increased");
  assert.equal(c.behavioral_delta.find((m) => m.key === "changedFiles")!.change, "changed");
  assert.equal(c.behavioral_delta.find((m) => m.key === "verification")!.change, "improved");
  assert.equal(c.verification_delta.note, "A verification step (test/build/lint) was present in the later run but not the baseline.");
  assert.ok(!c.behavioral_delta.some((m) => ["failedCommands", "toolCalls", "changedFiles"].includes(m.key) && m.change === "worsened"));
  assert.ok(!c.honest_verdict.includes("Behavior appears improved"));
  assert.ok(c.honest_verdict.includes("Evidence is mixed or insufficient."));
  assert.ok(c.honest_verdict.includes("The later run includes objective verification signals and no observed retry/edit-thrash regression"));
  assert.ok(c.honest_verdict.includes(QUALITY_BASELINE_LACKS_MESSAGE));
  assertNoOverclaim(c.honest_verdict);
});

test("verification alone does not produce behavior-improved verdict", () => {
  const c = buildProductTrialComparison(
    input({
      before: stats({ retries: 0, repeatedCommands: 0, repeatedFileEdits: 0, failedCommands: 0, verificationPresent: false }),
      after: stats({ retries: 0, repeatedCommands: 0, repeatedFileEdits: 0, failedCommands: 0, verificationPresent: true }),
      qualityBefore: null,
      qualityAfter: { testsPassed: true },
    }),
  );

  assert.equal(c.behavioral_delta.find((m) => m.key === "verification")!.change, "improved");
  assert.ok(!c.honest_verdict.includes("Behavior appears improved"));
  assert.ok(c.honest_verdict.includes("Evidence is mixed or insufficient."));
  assertNoOverclaim(c.honest_verdict);
});

test("needs-review rule health does not duplicate the mixed/insufficient verdict lead", () => {
  const c = buildProductTrialComparison(
    input({
      ruleHealth: { evaluated: true, dominant: "needs_review", items: [{ status: "needs_review", title: "Review manually" }] },
      before: stats({ failedCommands: 0, toolCalls: 0, changedFiles: 0, verificationPresent: false }),
      after: stats({ failedCommands: 2, toolCalls: 4, changedFiles: 1, verificationPresent: true }),
      qualityBefore: null,
      qualityAfter: { testsPassed: true },
    }),
  );

  assert.ok(
    !c.honest_verdict.includes("Evidence is mixed or insufficient. Evidence is mixed or insufficient."),
  );
  assert.equal(countOccurrences(c.honest_verdict, "Evidence is mixed or insufficient."), 1);
  assert.equal(
    c.honest_verdict,
    "Evidence is mixed or insufficient. The later run includes objective verification signals and no observed retry/edit-thrash regression, but the baseline lacks comparable output-quality signals. This is an observed difference between two sessions, not proof that rules changed the outcome. Usage comparison unavailable because one or both sessions did not include token/cost metadata. Output quality signals were present for the later run, but the baseline lacks comparable objective signals, so output quality was not compared.",
  );
  assertNoOverclaim(c.honest_verdict);
});

test("repeated verdict lead phrases are not duplicated", () => {
  const c = buildProductTrialComparison(
    input({
      ruleHealth: { evaluated: true, dominant: "needs_review", items: [{ status: "needs_review" }] },
      before: stats({ verificationPresent: false }),
      after: stats({ verificationPresent: true }),
      qualityBefore: null,
      qualityAfter: { buildPassed: true },
    }),
  );

  const firstSentence = c.honest_verdict.match(/^[^.!?]+[.!?]/)?.[0] ?? "";
  assert.equal(countOccurrences(c.honest_verdict, firstSentence), 1);
  assertNoOverclaim(c.honest_verdict);
});

test("harmful metric decrease still produces conservative behavior improvement wording", () => {
  const c = buildProductTrialComparison(
    input({
      before: stats({ repeatedFileEdits: 3, verificationPresent: false }),
      after: stats({ repeatedFileEdits: 0, verificationPresent: false }),
    }),
  );

  assert.equal(c.behavioral_delta.find((m) => m.key === "repeatedFileEdits")!.change, "improved");
  assert.ok(c.honest_verdict.includes("Harmful behavior patterns decreased in the follow-up run."));
  assert.ok(!c.honest_verdict.includes("Behavior appears improved"));
  assertNoOverclaim(c.honest_verdict);
});

test("failed command increase is worsened only with repeated harmful failure evidence", () => {
  const single = buildProductTrialComparison(
    input({ before: stats({ failedCommands: 0, repeatedCommands: 0 }), after: stats({ failedCommands: 2, repeatedCommands: 0 }) }),
  );
  assert.equal(single.behavioral_delta.find((m) => m.key === "failedCommands")!.change, "increased");

  const repeated = buildProductTrialComparison(
    input({ before: stats({ failedCommands: 0, repeatedCommands: 0 }), after: stats({ failedCommands: 2, repeatedCommands: 1 }) }),
  );
  assert.equal(repeated.behavioral_delta.find((m) => m.key === "failedCommands")!.change, "worsened");
});

// ---------------------------------------------------------------------------
// Rule Health snapshot availability (missing snapshot ≠ "rule never loaded")
// ---------------------------------------------------------------------------

test("later run loaded a rule but lost its snapshot → reports snapshot unavailable, not 'may not have loaded the rule'", () => {
  const c = buildProductTrialComparison(
    input({
      ruleHealth: null,
      laterRulesLoadedCount: 1,
    }),
  );
  assert.equal(c.rule_health_snapshot_available, false);
  // Honest, specific message — and never the misleading "may not have loaded" copy.
  assert.ok(c.honest_verdict.includes(RULE_HEALTH_SNAPSHOT_UNAVAILABLE_MESSAGE));
  assert.ok(!/may not have loaded the rule/i.test(c.honest_verdict));
  for (const l of c.limitations) {
    if (/Rule Health/i.test(l)) assert.ok(!/may not have loaded the rule/i.test(l));
  }
  assertNoOverclaim(c.honest_verdict);
});

test("missing snapshot adds a visible 'fresh later run required' limitation", () => {
  const c = buildProductTrialComparison(
    input({ ruleHealth: null, ruleHealthSnapshotUnavailable: true }),
  );
  assert.equal(c.rule_health_snapshot_available, false);
  assert.ok(c.limitations.includes(RULE_HEALTH_SNAPSHOT_UNAVAILABLE_MESSAGE));
  assert.ok(c.limitations.some((l) => /fresh later run/i.test(l)));
});

test("genuinely no rules loaded still reports 'may not have loaded the rule' (not snapshot copy)", () => {
  const c = buildProductTrialComparison(input({ ruleHealth: null, laterRulesLoadedCount: 0 }));
  assert.equal(c.rule_health_snapshot_available, true);
  assert.ok(c.limitations.some((l) => /may not have loaded the rule/i.test(l)));
  assert.ok(!c.honest_verdict.includes(RULE_HEALTH_SNAPSHOT_UNAVAILABLE_MESSAGE));
});

test("hydrated session snapshot produces rule health: needs_review", () => {
  const c = buildProductTrialComparison(
    input({
      laterRulesLoadedCount: 1,
      ruleHealth: {
        evaluated: true,
        dominant: "needs_review",
        items: [{ status: "needs_review", title: "Stop retrying unchanged failing commands" }],
      },
    }),
  );
  assert.equal(c.rule_health_snapshot_available, true);
  assert.equal(c.rule_health_result?.dominant, "needs_review");
  // Snapshot-unavailable copy must NOT appear when Rule Health was hydrated.
  assert.ok(!c.honest_verdict.includes(RULE_HEALTH_SNAPSHOT_UNAVAILABLE_MESSAGE));
});

// ---------------------------------------------------------------------------
// Behavior snapshot availability (zeros are not meaningful when missing)
// ---------------------------------------------------------------------------

test("missing behavior snapshot does not present 0 → 0 counts as meaningful", () => {
  const c = buildProductTrialComparison(
    input({ before: stats({ toolCalls: 0 }), after: stats({ toolCalls: 0 }), behaviorSnapshotUnavailable: true }),
  );
  assert.equal(c.behavior_snapshot_available, false);
  assert.ok(c.honest_verdict.includes(BEHAVIOR_SNAPSHOT_UNAVAILABLE_MESSAGE));
  assert.ok(c.limitations.includes(BEHAVIOR_SNAPSHOT_UNAVAILABLE_MESSAGE));
  assertNoOverclaim(c.honest_verdict);
});

test("CLI compare surfaces snapshot-unavailable rule health and suppresses meaningless behavior zeros", () => {
  const cli = read("src/lib/oathlock-cli-core.ts");
  assert.match(cli, /rule health: snapshot unavailable/);
  assert.match(cli, /behavior: snapshot unavailable/);
  assert.match(cli, /rule_health_snapshot_available === false/);
  assert.match(cli, /behavior_snapshot_available === false/);
});

test("no secrets or tokens are referenced by the compare layer messages", () => {
  for (const msg of [RULE_HEALTH_SNAPSHOT_UNAVAILABLE_MESSAGE, BEHAVIOR_SNAPSHOT_UNAVAILABLE_MESSAGE]) {
    assert.ok(!/oak_|token|setup_code|local\.json|service[_ ]?key|secret/i.test(msg), `secret-shaped text in: ${msg}`);
  }
});

// ---------------------------------------------------------------------------
// Output quality
// ---------------------------------------------------------------------------

test("compare reports output quality unknown without tests/acceptance criteria", () => {
  const c = buildProductTrialComparison(input());
  assert.equal(c.output_quality_delta.judgeable, false);
  assert.equal(c.output_quality_delta.message, QUALITY_UNJUDGEABLE_MESSAGE);
  assert.ok(c.honest_verdict.includes(QUALITY_UNJUDGEABLE_MESSAGE));
});

test("the output quality message names objective signals and includes a measurable hint", () => {
  const c = buildProductTrialComparison(input());
  // New wording names build/test/lint/acceptance/human approval.
  assert.match(c.output_quality_delta.message!, /build result, test result, lint result, acceptance criteria, or human approval/);
  // Actionable hint is present and warns against secrets/source.
  assert.deepEqual(c.output_quality_delta.hint, QUALITY_MEASURABLE_HINT);
  assert.ok(c.output_quality_delta.hint!.some((h) => /do not include secrets/i.test(h)));
});

test("partial usage metadata (only one run) does not produce a usage comparison", () => {
  const c = buildProductTrialComparison(
    input({
      before: stats({ totalTokens: 1000 }),
      usageBefore: { inputTokens: 700, outputTokens: 300, totalTokens: 1000, cost: 0.02 },
      usageAfter: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null },
    }),
  );
  assert.equal(c.usage_delta.available, false);
  assert.equal(c.usage_delta.message, USAGE_UNAVAILABLE_MESSAGE);
});

test("compare does NOT say 'no signals were supplied' when the later run has test evidence", () => {
  const c = buildProductTrialComparison(
    input({
      qualityBefore: null,
      qualityAfter: { testsPassed: true },
    }),
  );
  // Asymmetric: not judgeable, but the honest reason is "baseline lacks
  // comparable signals" — never the false "no signals were supplied".
  assert.equal(c.output_quality_delta.judgeable, false);
  assert.equal(c.output_quality_delta.message, QUALITY_BASELINE_LACKS_MESSAGE);
  assert.ok(c.honest_verdict.includes(QUALITY_BASELINE_LACKS_MESSAGE));
  assert.ok(
    !c.limitations.some((l) => /No tests\/build\/lint\/acceptance\/human-review signals were supplied/.test(l)),
  );
  assert.ok(!c.honest_verdict.includes(QUALITY_UNJUDGEABLE_MESSAGE));
  assertNoOverclaim(c.honest_verdict);
  for (const l of c.limitations) assertNoOverclaim(l);
});

test("compare says baseline lacks comparable signals when only the later run has tests", () => {
  const c = buildProductTrialComparison(
    input({ qualityBefore: null, qualityAfter: { testsPassed: true, buildPassed: true } }),
  );
  assert.ok(c.limitations.includes(QUALITY_BASELINE_LACKS_MESSAGE));
  // Signals we DO have are surfaced even though quality is not compared.
  const tests = c.output_quality_delta.signals.find((s) => s.key === "testsPassed");
  assert.equal(tests!.after, true);
});

test("compare says both runs include objective signals without claiming improvement", () => {
  const c = buildProductTrialComparison(
    input({
      qualityBefore: { testsPassed: true },
      qualityAfter: { testsPassed: true, humanApproval: true },
    }),
  );
  assert.equal(c.output_quality_delta.judgeable, true);
  assert.equal(c.output_quality_delta.message, QUALITY_BOTH_PRESENT_MESSAGE);
  assert.ok(c.honest_verdict.includes(QUALITY_BOTH_PRESENT_MESSAGE));
  // Must not claim the rule improved quality or make certainty/attribution claims.
  assertNoOverclaim(c.honest_verdict);
  assert.ok(!/improved quality|the rule improved|\bproved\b|guaranteed|caused/i.test(c.honest_verdict));
});

test("compare marks verification present when smoke evidence yields objective signals", () => {
  const extracted = extractQualitySignals(SMOKE_EVIDENCE_STYLE);
  const quality = deriveQualitySignals(extracted);
  assert.equal(hasCommandTiedVerificationSignal(extracted), true);

  const c = buildProductTrialComparison(
    input({
      before: stats({ verificationPresent: true, failedCommands: 0 }),
      after: stats({ verificationPresent: true, failedCommands: 0 }),
      qualityBefore: quality,
      qualityAfter: quality,
    }),
  );

  const verification = c.behavioral_delta.find((m) => m.key === "verification");
  assert.equal(verification?.before, 1);
  assert.equal(verification?.after, 1);
  assert.equal(verification?.change, "unchanged");
  assert.equal(c.output_quality_delta.judgeable, true);
  assert.equal(c.output_quality_delta.message, QUALITY_BOTH_PRESENT_MESSAGE);
  assertNoOverclaim(c.honest_verdict);
});

test("compare reports output quality evidence only from objective checks", () => {
  const c = buildProductTrialComparison(
    input({
      qualityBefore: { testsPassed: false, buildPassed: true },
      qualityAfter: { testsPassed: true, buildPassed: true, humanApproval: true },
    }),
  );
  assert.equal(c.output_quality_delta.judgeable, true);
  const tests = c.output_quality_delta.signals.find((s) => s.key === "testsPassed");
  assert.equal(tests!.before, false);
  assert.equal(tests!.after, true);
});

// ---------------------------------------------------------------------------
// No overclaiming — verdict, dashboard, CLI
// ---------------------------------------------------------------------------

test("the honest verdict never contains overclaiming language across statuses", () => {
  for (const dominant of ["followed", "violated", "not_applicable", "too_vague", "needs_review", "obsolete"] as const) {
    const c = buildProductTrialComparison(input({ ruleHealth: { evaluated: true, dominant, items: [] } }));
    assertNoOverclaim(c.honest_verdict);
    for (const l of c.limitations) assertNoOverclaim(l);
  }
});

test("dashboard Product Trial copy contains no overclaiming", () => {
  // Product-trial comparison stays out of the normal Run Control Board; scan both
  // surfaces for overclaiming while asserting the new agent-native framing.
  const text = (
    read("src/app/dashboard/agents/page.tsx") + read("src/components/product/AgentWorkspaceClient.tsx")
  ).toLowerCase();
  for (const phrase of FORBIDDEN_PROOF_PHRASES) {
    assert.ok(!text.includes(phrase), `dashboard overclaim: "${phrase}"`);
  }
  assert.match(read("src/app/dashboard/agents/page.tsx"), /The Watchfloor/);
});

test("CLI compare/proof prints server values and adds no overclaiming language", () => {
  const cli = read("src/lib/oathlock-cli-core.ts");
  // The compare command exists and is wired for both verbs.
  assert.match(cli, /async function cmdCompare/);
  assert.match(cli, /case "compare":\s*\n\s*case "proof":/);
  // The compare command's printed strings contain no overclaim.
  const start = cli.indexOf("async function cmdCompare");
  const slice = cli.slice(start, start + 2500).toLowerCase();
  for (const phrase of FORBIDDEN_PROOF_PHRASES) {
    assert.ok(!slice.includes(phrase), `CLI compare overclaim: "${phrase}"`);
  }
});

// ---------------------------------------------------------------------------
// Docs require human approval before submission
// ---------------------------------------------------------------------------

test("banned overclaim language is absent from dashboard, compare layer, CLI, and docs", () => {
  // "quality improved" / "cost improved" are now banned bare claims.
  assert.ok(FORBIDDEN_PROOF_PHRASES.includes("quality improved"));
  assert.ok(FORBIDDEN_PROOF_PHRASES.includes("cost improved"));
  const sources = [
    "src/app/dashboard/agents/page.tsx",
    "src/lib/product-trial-compare.ts",
    "src/lib/oathlock-cli-core.ts",
    "src/lib/agent-md.ts",
    "cli/README.md",
    "src/app/agents/page.tsx",
  ];
  for (const file of sources) {
    const text = read(file).toLowerCase();
    for (const phrase of FORBIDDEN_PROOF_PHRASES) {
      assert.ok(!text.includes(phrase), `${file} contains banned phrase: "${phrase}"`);
    }
  }
});

test("Claude Code flow docs require human approval before session submission", () => {
  const agentMd = read("src/lib/agent-md.ts");
  assert.match(agentMd, /human review \+ redaction|Ask the human before submitting/i);
  const readme = read("cli/README.md");
  assert.match(readme, /human|approved/i);
  // submit-session without --approved must disclose the UNREVIEWED path and
  // never claim human approval it does not have.
  const cliCore = read("src/lib/oathlock-cli-core.ts");
  assert.match(cliCore, /UNREVIEWED/);
  assert.match(cliCore, /human_approved_submission: Boolean\(parsed\.approved\)/);
});
