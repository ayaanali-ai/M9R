/**
 * /api/agent/session response contract — Rule Health wiring
 * ----------------------------------------------------------------------------
 * Guards the regression the production smoke surfaced: the session response must
 * always carry a `rule_health` section, and it must be evaluated whenever the
 * caller sends a non-empty `rules_loaded` (as the direct API smoke did).
 *
 * We exercise the real response builder over the real analysis pipeline (no DB,
 * no auth, no network — those stay in the route), and statically assert the
 * route delegates to the builder so the wiring can't silently regress.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  analyzeAgentSession,
  buildRuleCandidateMessage,
  buildAgentSessionResponse,
} from "../src/lib/agent-session-analysis.ts";

// A realistic edit-thrash session: the same file edited many times for one fix.
const EDIT_THRASH_SESSION = `# Claude Code session

## User
Fix the failing auth test.

## Assistant
I'll update the handler.

\`\`\`bash
$ npm test
FAIL src/auth.test.ts
\`\`\`

Edit(src/auth.ts)
Edit(src/auth.ts)
Edit(src/auth.ts)
Edit(src/auth.ts)
Edit(src/auth.ts)

\`\`\`bash
$ npm test
FAIL src/auth.test.ts
\`\`\`

Edit(src/auth.ts)
Edit(src/auth.ts)
`;

const SMOKE_RULES_LOADED = [
  {
    id: "smoke-edit-thrash",
    title: "Inspect root cause before re-editing the same file",
    rule_type: "edit_thrash_prevention",
  },
];

test("session response always includes a rule_health section", async () => {
  const analysis = await analyzeAgentSession("just some plain text, nothing technical");
  const body = buildAgentSessionResponse(analysis, {
    rulesLoaded: [],
    redactionStatus: "human_reviewed",
  });

  assert.ok("rule_health" in body, "rule_health must always be present");
  // No loaded rules → evaluated false (honest), but the key still exists.
  assert.equal(body.rule_health.evaluated, false);
  assert.equal(body.redaction_status, "human_reviewed");
  assert.equal(body.ok, true);
});

test("rule_health.evaluated === true when rules_loaded is sent (smoke payload)", async () => {
  const analysis = await analyzeAgentSession(EDIT_THRASH_SESSION, "session.markdown_export");
  const body = buildAgentSessionResponse(analysis, {
    rulesLoaded: SMOKE_RULES_LOADED,
    rulesFollowed: [],
    rulesViolated: [],
    redactionStatus: "human_reviewed",
  });

  assert.equal(body.rule_health.evaluated, true);
  assert.equal(body.rule_health.items.length, 1);
  assert.equal(body.rule_health.items[0].rule_id, "smoke-edit-thrash");
  // The summary buckets must add up to the loaded rule count.
  const total = Object.values(body.rule_health.summary).reduce((a, b) => a + b, 0);
  assert.equal(total, 1);
  assert.equal(body.next_step, "Review the rule candidate(s) in the dashboard before promoting anything.");
});

// Structured evidence summary: lists a changed file and command-tied test
// results as plain markdown (no agent-native tool calls).
const STRUCTURED_EVIDENCE_SESSION = `# Session

Changed file:
- scripts/oathlock-cli.test.ts

Focused test:
Command:
node --import ./scripts/register-alias.mjs --test ./scripts/oathlock-cli.test.ts

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

const SMOKE_EVIDENCE_TEMPLATE_SESSION = `# OathLock Agent Smoke Test - Run 2

## Changed files

- docs/proof/oathlock-agent-smoke-test.md

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

## Human review notes

- This evidence is approved for OathLock review.
- This is a review aid, not proof of correctness.
`;

const PROOF_RUN_ONE_SANDBOX_FAILURE = `${STRUCTURED_EVIDENCE_SESSION}

Focused test first attempt:
Command:
node --disable-warning=ExperimentalWarning --import ./scripts/register-alias.mjs --test ./scripts/quality-signal-extraction.test.ts

Result:
failed to launch: CreateProcessAsUserW failed: 1312

Focused test after changing execution context:
Command:
node --disable-warning=ExperimentalWarning --import ./scripts/register-alias.mjs --test ./scripts/quality-signal-extraction.test.ts

Result:
passed, 13/13
`;

const ONE_FAILED_COMMAND_SESSION = `# Session

Command:
npm test

Result:
failed, 1/10
`;

const REPEATED_FAILED_COMMAND_SESSION = `# Session

$ npm test
Error: src/auth.test.ts failed

$ npm test
Error: src/auth.test.ts failed

$ npm test
Error: src/auth.test.ts failed
`;

test("structured markdown evidence yields files_edited 1 and a measurability block", async () => {
  const analysis = await analyzeAgentSession(STRUCTURED_EVIDENCE_SESSION, "session.markdown_export", {
    humanApprovedSubmission: true,
  });
  const body = buildAgentSessionResponse(analysis, { rulesLoaded: [], redactionStatus: "human_reviewed" });

  // files_edited reflects the explicitly listed changed file (was 0 before).
  assert.equal(body.parser_confidence.filesEdited, 1);

  // The measurability block carries the objective signals OathLock extracted.
  assert.equal(body.measurable_signals.hasObjectiveSignals, true);
  assert.equal(body.measurable_signals.changedFiles, 1);
  assert.equal(body.measurable_signals.tests, "focused passed, full passed");
  assert.equal(body.measurable_signals.build, "not supplied");
  assert.equal(body.measurable_signals.lint, "not supplied");
  assert.equal(body.measurable_signals.humanApproval, "supplied");

  // Derived compare-layer signals are populated (later run will carry these).
  assert.equal(analysis.qualitySignals.testsPassed, true);
  assert.equal(analysis.qualitySignals.humanApproval, true);
});

test("smoke evidence template yields verification behavior and no false failed command", async () => {
  const analysis = await analyzeAgentSession(SMOKE_EVIDENCE_TEMPLATE_SESSION, "session.markdown_export", {
    humanApprovedSubmission: true,
    rulesLoaded: SMOKE_RULES_LOADED,
  });
  const body = buildAgentSessionResponse(analysis, { rulesLoaded: SMOKE_RULES_LOADED, redactionStatus: "human_reviewed" });

  assert.equal(body.parser_confidence.filesEdited, 1);
  assert.equal(body.measurable_signals.tests, "full passed");
  assert.equal(body.measurable_signals.build, "passed");
  assert.equal(body.measurable_signals.lint, "passed");
  assert.equal(analysis.behavior.verificationPresent, true);
  assert.equal(analysis.behavior.failedCommands, 0);
  assert.equal(analysis.qualitySignals.testsPassed, true);
  assert.equal(analysis.qualitySignals.buildPassed, true);
  assert.equal(analysis.qualitySignals.lintPassed, true);
  assert.ok(!JSON.stringify(body).includes("docs/proof/oathlock-agent-smoke-test.md"));
  assert.ok(!JSON.stringify(body).includes("This evidence is approved"));
});

test("markdown Human approval supplied yields measurable approval without CLI flag", async () => {
  const analysis = await analyzeAgentSession(
    `${STRUCTURED_EVIDENCE_SESSION}\nHuman approval:\nsupplied\n`,
    "session.markdown_export",
  );

  assert.equal(analysis.measurableSignals.humanApproval, "supplied");
  assert.equal(analysis.qualitySignals.humanApproval, true);
});

test("markdown Human approval pending does not count without CLI approval", async () => {
  const analysis = await analyzeAgentSession(
    `${STRUCTURED_EVIDENCE_SESSION}\nHuman approval: pending\n`,
    "session.markdown_export",
  );

  assert.equal(analysis.measurableSignals.humanApproval, "not supplied");
  assert.equal(analysis.qualitySignals.humanApproval, false);
});

test("proof-run style session with one sandbox launch failure creates no rule candidates", async () => {
  const analysis = await analyzeAgentSession(PROOF_RUN_ONE_SANDBOX_FAILURE, "session.markdown_export", {
    humanApprovedSubmission: true,
  });
  const body = buildAgentSessionResponse(analysis, { rulesLoaded: [], redactionStatus: "human_reviewed" });

  assert.equal(body.rules.needsReviewCount, 0);
  assert.equal(body.rules.activeCount, 0);
  assert.equal(body.rules.recommended, false);
  assert.equal(body.rules.message, "No new rule candidates were created from this session.");
  assert.equal(body.next_step, "No new rule candidates were created from this session.");
  assert.ok(body.rules.ruleLikeFindingsCount === 0 || body.rules.ruleLikeFindingsCount === 1);
  assert.equal(body.measurable_signals.tests, "focused passed, full passed");
  assert.equal(body.measurable_signals.humanApproval, "supplied");
});

test("one failed command alone creates no retry-prevention candidate", async () => {
  const analysis = await analyzeAgentSession(ONE_FAILED_COMMAND_SESSION, "session.markdown_export");

  assert.equal(analysis.rules.needsReviewCount, 0);
  assert.ok(!analysis.generatedRules.some((r) => r.ruleType === "retry_prevention"));
});

test("repeated unchanged failed commands can create a retry-prevention candidate", async () => {
  const analysis = await analyzeAgentSession(REPEATED_FAILED_COMMAND_SESSION, "session.markdown_export");

  assert.ok(analysis.generatedRules.some((r) => r.ruleType === "retry_prevention"));
  assert.equal(analysis.rules.needsReviewCount, analysis.generatedRules.length);
  assert.equal(analysis.rules.activeCount, 0);
});

test("repeated file edit thrash can create an edit-thrash candidate", async () => {
  const analysis = await analyzeAgentSession(EDIT_THRASH_SESSION, "session.markdown_export");

  assert.ok(analysis.generatedRules.some((r) => r.ruleType === "edit_thrash_prevention"));
  assert.equal(analysis.rules.needsReviewCount, analysis.generatedRules.length);
  assert.equal(analysis.rules.activeCount, 0);
});

test("loaded active rule coverage suppresses duplicate candidate creation", async () => {
  const analysis = await analyzeAgentSession(REPEATED_FAILED_COMMAND_SESSION, "session.markdown_export", {
    rulesLoaded: [
      {
        id: "retry-loaded",
        title: "Stop retrying unchanged failing commands",
        rule_type: "retry_prevention",
      },
    ],
  });

  assert.equal(analysis.rules.needsReviewCount, 0);
  assert.equal(analysis.rules.activeCount, 0);
  assert.equal(analysis.generatedRules.length, 0);
  assert.ok(analysis.rules.ruleLikeFindingsCount >= 1);
  assert.equal(
    analysis.rules.message,
    "No new rule candidates were created. Rule-like findings were kept as findings only; review the active rule health before promoting anything.",
  );
});

test("submit-session candidate copy stays consistent and never says generated candidates are active", async () => {
  const analysis = await analyzeAgentSession(REPEATED_FAILED_COMMAND_SESSION, "session.markdown_export");
  const body = buildAgentSessionResponse(analysis, { rulesLoaded: [], redactionStatus: "human_reviewed" });

  assert.equal(body.rules.needsReviewCount, analysis.generatedRules.length);
  assert.equal(body.rules.activeCount, 0);
  assert.match(body.rules.message, /rule candidate(?:s)? for review/);
  assert.ok(!/\bactive\b/i.test(body.rules.message));
  assert.ok(!/recommended|auto|generated active|proved|guaranteed|caused|worked/i.test(body.rules.message));
});

test("rule candidate messages are based only on reviewable candidate count", () => {
  assert.equal(
    buildRuleCandidateMessage(0, 0),
    "No new rule candidates were created from this session.",
  );
  assert.equal(
    buildRuleCandidateMessage(0, 2),
    "No new rule candidates were created. Rule-like findings were kept as findings only; review the active rule health before promoting anything.",
  );
  assert.equal(buildRuleCandidateMessage(1, 0), "1 rule candidate for review.");
  assert.equal(buildRuleCandidateMessage(2, 0), "2 rule candidates for review.");

  for (const message of [
    buildRuleCandidateMessage(0, 2),
    buildRuleCandidateMessage(1, 0),
    buildRuleCandidateMessage(2, 0),
  ]) {
    assert.ok(!/recommended|auto|generated active|proved|guaranteed|caused|worked/i.test(message));
  }
});

test("route delegates response shaping to buildAgentSessionResponse", () => {
  const routeSrc = readFileSync(
    resolve(process.cwd(), "src/app/api/agent/session/route.ts"),
    "utf8",
  );
  assert.match(routeSrc, /buildAgentSessionResponse/, "route must call the response builder");
  assert.match(routeSrc, /rules_loaded/, "route must pass rules_loaded through");
  assert.match(routeSrc, /recordSubmission\(/, "route must reuse the shared submission helper");
});

test("evidence contract recording never hardcodes human approval -- an unreviewed submission must not be recorded as approved", () => {
  const routeSrc = readFileSync(
    resolve(process.cwd(), "src/app/api/agent/session/route.ts"),
    "utf8",
  );
  // Regression guard: this previously read
  // `validateEvidenceContract(input.evidenceContract, { humanApprovedSubmission: true })`
  // unconditionally, so an explicitly human_approved_submission:false bearer
  // submission still got its evidence_contract recorded as human-approved.
  assert.doesNotMatch(
    routeSrc,
    /humanApprovedSubmission:\s*true/,
    "tryRecordEvidenceContract must never hardcode approval -- it must thread the caller's real, already-verified humanApproved value",
  );
  assert.match(
    routeSrc,
    /humanApprovedSubmission:\s*input\.humanApproved/,
    "tryRecordEvidenceContract must validate against the caller-supplied humanApproved value",
  );
  // The bearer path's real, per-request approval flag must reach the call.
  assert.match(
    routeSrc,
    /tryRecordEvidenceContract\(\{[\s\S]{0,300}humanApproved,/,
    "the bearer-path call site must pass the real humanApproved flag through, not a literal",
  );
});
