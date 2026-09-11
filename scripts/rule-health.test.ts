/**
 * Rule Health v0 — unit tests
 * ----------------------------------------------------------------------------
 * Verifies the conservative, evidence-based classification of loaded workspace
 * rules against a submitted session's findings — including that agent
 * self-reports never override contradictory observed evidence.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateRuleHealth,
  dominantRuleHealthStatus,
  type SessionFindingInput,
} from "../src/lib/rule-health.ts";

const RETRY_RULE = {
  id: "rule_retry",
  title: "Stop retrying unchanged failing commands",
  rule_type: "retry_prevention",
  body: "If a command fails, do not rerun it unchanged; inspect the cause first.",
};

const retrySpiral = (evidenceLevel: string): SessionFindingInput => ({
  type: "retry_spiral",
  title: "Same failing command retried",
  evidenceLevel,
});

const EDIT_THRASH_RULE = {
  id: "rule_edit_thrash",
  title: "Inspect root cause before re-editing a file",
  rule_type: "edit_thrash_prevention",
  body: "After editing the same file twice for the same issue, stop and inspect the root cause.",
};

const editThrashFinding: SessionFindingInput = {
  type: "repeated_file_edit",
  title: "Same file edited repeatedly",
  evidenceLevel: "Observed",
};

test("loaded edit-thrash rule + repeated edit-thrash finding => violated", () => {
  const report = evaluateRuleHealth({
    rulesLoaded: [EDIT_THRASH_RULE],
    findings: [editThrashFinding],
    signals: { filesEdited: 4, commandsDetected: 2, parserConfidence: "high" },
  });

  assert.equal(report.evaluated, true);
  assert.equal(report.items.length, 1);
  assert.equal(report.items[0].status, "violated");
  assert.equal(report.items[0].evidenceLevel, "Observed");
  assert.deepEqual(report.items[0].matchedFindingTypes, ["repeated_file_edit"]);
  assert.equal(report.summary.violated, 1);
});

test("loaded edit-thrash rule + irrelevant session => not_applicable", () => {
  const report = evaluateRuleHealth({
    rulesLoaded: [EDIT_THRASH_RULE],
    findings: [], // nothing edit-related happened
    signals: { filesEdited: 0, commandsDetected: 0, parserConfidence: "high" },
  });

  assert.equal(report.items[0].status, "not_applicable");
  assert.equal(report.summary.not_applicable, 1);
  assert.equal(report.summary.followed, 0);
});

test("loaded edit-thrash rule + relevant clean session => followed (Inferred, conservative)", () => {
  const report = evaluateRuleHealth({
    rulesLoaded: [EDIT_THRASH_RULE],
    findings: [], // no recurrence
    signals: { filesEdited: 3, commandsDetected: 1, parserConfidence: "high" },
  });

  assert.equal(report.items[0].status, "followed");
  assert.equal(report.items[0].evidenceLevel, "Inferred");
});

test("relevant clean session but weak parser => needs_review, never followed", () => {
  const report = evaluateRuleHealth({
    rulesLoaded: [EDIT_THRASH_RULE],
    findings: [],
    signals: { filesEdited: 3, parserConfidence: "low" },
  });

  assert.equal(report.items[0].status, "needs_review");
  assert.notEqual(report.items[0].status, "followed");
});

test("vague rule => too_vague", () => {
  const report = evaluateRuleHealth({
    rulesLoaded: [{ id: "r_vague", title: "Be careful and write clean code" }],
    findings: [editThrashFinding],
    signals: { filesEdited: 2, parserConfidence: "high" },
  });

  assert.equal(report.items[0].status, "too_vague");
  assert.equal(report.items[0].evidenceLevel, "Insufficient");
  assert.equal(report.summary.too_vague, 1);
});

test("agent-reported 'followed' cannot override contradictory observed evidence", () => {
  const report = evaluateRuleHealth({
    rulesLoaded: [EDIT_THRASH_RULE],
    findings: [editThrashFinding], // the pattern recurred
    signals: { filesEdited: 5, parserConfidence: "high" },
    agentReported: { followed: ["rule_edit_thrash"] }, // agent claims it followed
  });

  // Observed violation wins; the agent's claim is noted, not obeyed.
  assert.equal(report.items[0].status, "violated");
  assert.match(report.items[0].reason, /observed evidence/i);
});

test("agent-reported 'violated' cannot fabricate a violation without evidence", () => {
  const report = evaluateRuleHealth({
    rulesLoaded: [EDIT_THRASH_RULE],
    findings: [], // no recurrence observed
    signals: { filesEdited: 3, parserConfidence: "high" },
    agentReported: { violated: ["rule_edit_thrash"] },
  });

  // We do not mint a violation from a self-report; mixed signal => needs_review.
  assert.equal(report.items[0].status, "needs_review");
  assert.notEqual(report.items[0].status, "violated");
});

test("no loaded rules => evaluated false with empty summary", () => {
  const report = evaluateRuleHealth({ rulesLoaded: [], findings: [editThrashFinding] });

  assert.equal(report.evaluated, false);
  assert.equal(report.items.length, 0);
  assert.deepEqual(report.summary, {
    followed: 0,
    violated: 0,
    not_applicable: 0,
    too_vague: 0,
    needs_review: 0,
    obsolete: 0,
  });
});

test("rule type can be inferred from text when not declared", () => {
  const report = evaluateRuleHealth({
    rulesLoaded: [{ id: "r1", title: "Stop re-editing the same file again and again" }],
    findings: [editThrashFinding],
    signals: { filesEdited: 4, parserConfidence: "high" },
  });

  assert.equal(report.items[0].status, "violated");
});

// ---------------------------------------------------------------------------
// Dominant Rule Health status (deterministic severity ranking, not first-item)
// ---------------------------------------------------------------------------

test("dominantRuleHealthStatus: needs_review + violated => violated", () => {
  assert.equal(dominantRuleHealthStatus(["needs_review", "violated"]), "violated");
});

test("dominantRuleHealthStatus: followed + not_applicable => followed", () => {
  assert.equal(dominantRuleHealthStatus(["followed", "not_applicable"]), "followed");
});

test("dominantRuleHealthStatus: not_applicable only => not_applicable", () => {
  assert.equal(dominantRuleHealthStatus(["not_applicable"]), "not_applicable");
});

test("dominantRuleHealthStatus: too_vague + needs_review => needs_review", () => {
  assert.equal(dominantRuleHealthStatus(["too_vague", "needs_review"]), "needs_review");
});

test("dominantRuleHealthStatus: accepts item objects and is order-independent", () => {
  assert.equal(
    dominantRuleHealthStatus([{ status: "not_applicable" }, { status: "violated" }, { status: "followed" }]),
    "violated",
  );
  assert.equal(dominantRuleHealthStatus([]), null);
});

// ---------------------------------------------------------------------------
// Retry-prevention sensitivity (a single ordinary failure is not a violation)
// ---------------------------------------------------------------------------

test("retry-prevention: one failed command + successful fix does NOT produce violated", () => {
  // A weak (Inferred) retry finding with no repeated failure → needs_review.
  const report = evaluateRuleHealth({
    rulesLoaded: [RETRY_RULE],
    findings: [retrySpiral("Inferred")],
    signals: { commandsDetected: 2, parserConfidence: "high", repeatedCommandFailures: 0, failedCommands: 1 },
  });
  assert.notEqual(report.items[0].status, "violated");
  assert.equal(report.items[0].status, "needs_review");
});

test("retry-prevention: a repeated failed command produces violated", () => {
  const report = evaluateRuleHealth({
    rulesLoaded: [RETRY_RULE],
    findings: [retrySpiral("Inferred")],
    signals: { commandsDetected: 4, parserConfidence: "high", repeatedCommandFailures: 1, failedCommands: 2 },
  });
  assert.equal(report.items[0].status, "violated");
});

test("retry-prevention: a strong retry_spiral finding produces violated (no contradicting repetition data)", () => {
  // Repetition signal is unknown here, so a strong Observed retry_spiral stands.
  const report = evaluateRuleHealth({
    rulesLoaded: [RETRY_RULE],
    findings: [retrySpiral("Observed")],
    signals: { commandsDetected: 4, parserConfidence: "high" },
  });
  assert.equal(report.items[0].status, "violated");
  assert.equal(report.items[0].evidenceLevel, "Observed");
});

test("retry-prevention: a known zero-repetition signal overrides a strong finding => needs_review", () => {
  const report = evaluateRuleHealth({
    rulesLoaded: [RETRY_RULE],
    findings: [retrySpiral("Observed")],
    signals: { commandsDetected: 4, parserConfidence: "high", repeatedCommandFailures: 0, failedCommands: 1 },
  });
  assert.equal(report.items[0].status, "needs_review");
});

test("retry-prevention: weak parser confidence produces needs_review, not followed", () => {
  const report = evaluateRuleHealth({
    rulesLoaded: [RETRY_RULE],
    findings: [], // no retry pattern at all
    signals: { commandsDetected: 2, parserConfidence: "low", repeatedCommandFailures: 0 },
  });
  assert.equal(report.items[0].status, "needs_review");
});
