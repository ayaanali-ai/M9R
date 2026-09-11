/**
 * Quality signal extraction tests — OathLock
 * ----------------------------------------------------------------------------
 * Proves OathLock extracts MEASURABLE proof signals from session markdown without
 * overclaiming: changed files, command-tied focused/full test results, lint/build
 * results, and human review — while refusing to treat agent self-claims as proof.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  extractQualitySignals,
  deriveQualitySignals,
  buildMeasurabilitySummary,
  hasCommandTiedVerificationSignal,
} from "../src/lib/quality-signal-extraction.ts";

// The exact structured evidence shape OathLock must now read.
const STRUCTURED_EVIDENCE = `# Session

Changed file:
- scripts/oathlock-cli.test.ts

Focused test:
Command:
node --disable-warning=ExperimentalWarning --import ./scripts/register-alias.mjs --test ./scripts/oathlock-cli.test.ts

Result:
passed, 28/28

Full test:
Command:
npm test

Result:
passed, 455/455

No commit or push was performed.
No secrets exposed.
`;

const SMOKE_EVIDENCE_STYLE = `# OathLock Agent Smoke Test - Run 2

## Verification commands

- npm run lint: passed, 0 errors, 3 warnings
- npm test: passed, 568 passed, 0 failed
- npm run build: passed, with existing warning categories

## Results

- npm run lint exited 0
- npm test exited 0
- npm run build exited 0

## Failed commands

- None.

Everything worked.
`;

test("extracts one changed file from a 'Changed file:' bullet block", () => {
  const s = extractQualitySignals(STRUCTURED_EVIDENCE);
  assert.deepEqual(s.changedFiles, ["scripts/oathlock-cli.test.ts"]);
});

test("focused test command + 'passed, 28/28' extracts focused test passed", () => {
  const s = extractQualitySignals(STRUCTURED_EVIDENCE);
  assert.ok(s.focusedTestCommand?.includes("--test"));
  assert.equal(s.focusedTestResult, "passed");
});

test("'npm test' + 'passed, 455/455' extracts full test passed", () => {
  const s = extractQualitySignals(STRUCTURED_EVIDENCE);
  assert.ok(/npm\s+test/.test(s.fullTestCommand ?? ""));
  assert.equal(s.fullTestResult, "passed");
});

test("'No commit or push was performed' records commitPerformed false", () => {
  const s = extractQualitySignals(STRUCTURED_EVIDENCE);
  assert.equal(s.commitPerformed, false);
});

test("derived signals + measurability summary reflect the structured evidence", () => {
  const s = extractQualitySignals(STRUCTURED_EVIDENCE);
  const derived = deriveQualitySignals(s);
  assert.equal(derived.testsPassed, true);
  assert.equal(derived.buildPassed, null);
  assert.equal(derived.lintPassed, null);
  assert.equal(derived.humanApproval, null);

  const ms = buildMeasurabilitySummary(s);
  assert.equal(ms.hasObjectiveSignals, true);
  assert.equal(ms.changedFiles, 1);
  assert.equal(ms.tests, "focused passed, full passed");
  assert.equal(ms.build, "not supplied");
  assert.equal(ms.lint, "not supplied");
});

test("smoke evidence style extracts lint passed line", () => {
  const s = extractQualitySignals(SMOKE_EVIDENCE_STYLE);
  assert.equal(s.lintResult, "passed");
  assert.equal(deriveQualitySignals(s).lintPassed, true);
});

test("smoke evidence style extracts npm test passed line", () => {
  const s = extractQualitySignals(SMOKE_EVIDENCE_STYLE);
  assert.ok(/npm\s+test/.test(s.fullTestCommand ?? ""));
  assert.equal(s.fullTestResult, "passed");
  assert.equal(deriveQualitySignals(s).testsPassed, true);
});

test("smoke evidence style extracts npm run build passed line", () => {
  const s = extractQualitySignals(SMOKE_EVIDENCE_STYLE);
  assert.equal(s.buildResult, "passed");
  assert.equal(deriveQualitySignals(s).buildPassed, true);
  assert.equal(hasCommandTiedVerificationSignal(s), true);
});

test("'Failed commands: None' does not create a failed command", () => {
  const s = extractQualitySignals(SMOKE_EVIDENCE_STYLE);
  assert.equal(s.failedCommandCount, 0);
  assert.equal(s.failedCommandsExplicitNone, true);
});

test("a real failed command line creates a failed verification signal", () => {
  const text = `## Verification commands
- npm run lint: passed, 0 errors

## Failed commands
- npm test exited 1`;
  const s = extractQualitySignals(text);
  assert.equal(s.failedCommandCount, 1);
  assert.equal(s.fullTestResult, "failed");
  assert.equal(deriveQualitySignals(s).testsPassed, false);
  assert.equal(hasCommandTiedVerificationSignal(s), true);
});

test("vague self-claims are ignored even near verification sections", () => {
  const s = extractQualitySignals("## Verification\nEverything worked and the app looks good.");
  assert.equal(s.focusedTestResult, null);
  assert.equal(s.fullTestResult, null);
  assert.equal(s.lintResult, null);
  assert.equal(s.buildResult, null);
  assert.equal(hasCommandTiedVerificationSignal(s), false);
});

test("agent-reported 'followed' is NOT treated as an objective signal", () => {
  const claim = `## Rule-Following Assessment
Loaded rule status reported by agent: followed
The promoted rule appears followed.`;
  const s = extractQualitySignals(claim);
  assert.equal(s.focusedTestResult, null);
  assert.equal(s.fullTestResult, null);
  assert.equal(s.lintResult, null);
  assert.equal(s.buildResult, null);
  assert.equal(s.humanReviewed, null);
  assert.equal(buildMeasurabilitySummary(s).hasObjectiveSignals, false);
});

test("a bare 'passed' with no command in its section is ignored (not objective)", () => {
  const text = `## Notes
Everything passed and looked great.`;
  const s = extractQualitySignals(text);
  assert.equal(s.focusedTestResult, null);
  assert.equal(s.fullTestResult, null);
});

test("a failing focused test is recorded as failed", () => {
  const text = `Focused test:
Command:
node --test ./scripts/x.test.ts

Result:
failed, 3/28`;
  const s = extractQualitySignals(text);
  assert.equal(s.focusedTestResult, "failed");
  assert.equal(deriveQualitySignals(s).testsPassed, false);
});

test("inline lint/build results and human approval are extracted", () => {
  const text = `## Verification
Lint result: passed
Build: passed
Human approval: supplied`;
  const s = extractQualitySignals(text);
  assert.equal(s.lintResult, null);
  assert.equal(s.buildResult, null);
  assert.equal(s.humanReviewed, true);
  assert.equal(buildMeasurabilitySummary(s).humanApproval, "supplied");
});

test("verification provenance keeps executed commands tied to observed results", () => {
  const s = extractQualitySignals(`## Verification commands
- npm run lint: passed, 0 errors
- npm test exited 0
- npm run build: failed, exit code 1`);
  assert.deepEqual(s.verification, [
    { kind: "lint", command: "npm run lint", result: "passed", source: "command_tied" },
    { kind: "test", command: "npm test", result: "passed", source: "command_tied" },
    { kind: "build", command: "npm run build", result: "failed", source: "command_tied" },
  ]);
});

test("bare success claims are retained only as claims, never executed verification", () => {
  const s = extractQualitySignals("Lint result: passed\nBuild: passed\nTests passed");
  assert.deepEqual(s.verification, []);
  assert.equal(s.lintResult, null);
  assert.equal(s.buildResult, null);
});

test("multiline 'Human approval: supplied' is extracted", () => {
  const s = extractQualitySignals("Human approval:\nsupplied");
  assert.equal(s.humanReviewed, true);
  assert.equal(deriveQualitySignals(s).humanApproval, true);
  assert.equal(buildMeasurabilitySummary(s).humanApproval, "supplied");
});

test("'Human approval: pending' is not treated as supplied", () => {
  const s = extractQualitySignals("Human approval requested before submission: pending");
  assert.equal(s.humanReviewed, false);
  assert.equal(buildMeasurabilitySummary(s).humanApproval, "not supplied");
});

test("approval is not objective proof of agent-reported followed", () => {
  const s = extractQualitySignals(`Human approval:
supplied

Loaded rule status reported by agent: followed
The promoted rule appears followed.`);
  assert.equal(deriveQualitySignals(s).humanApproval, true);
  assert.equal(buildMeasurabilitySummary(s).humanApproval, "supplied");
  assert.equal(s.focusedTestResult, null);
  assert.equal(s.fullTestResult, null);
  assert.equal(s.lintResult, null);
  assert.equal(s.buildResult, null);
});

test("extractor never echoes secret-shaped tokens it was given", () => {
  const s = extractQualitySignals("Changed file:\n- src/x.ts\nResult: passed, 1/1");
  const json = JSON.stringify(s);
  assert.ok(!/oak_|setup_code|local\.json|service[_ ]?key/i.test(json));
});
