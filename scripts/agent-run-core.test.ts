/**
 * Agent Run — pure core tests
 * ----------------------------------------------------------------------------
 * Exercises the security boundary (run-event redaction) and the conservative
 * two-run proof copy + shaping without a DB or browser.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  RUN_STATUSES,
  isRunStatus,
  statusForPhase,
  redactRunEvent,
  looksLikeSourceCode,
  isCleanRunEvent,
  TWO_RUN_PROOF_COPY,
  FORBIDDEN_PROOF_PHRASES,
  assertConservative,
  buildTwoRunProof,
  proofsFromRun,
  isRuleHealthStatus,
  PROOF_PENDING_COPY,
  type ProofRunRef,
} from "../src/lib/agent-run-core.ts";

// ---------------------------------------------------------------------------
// Status + phase
// ---------------------------------------------------------------------------

test("run statuses are the documented set", () => {
  assert.deepEqual(
    [...RUN_STATUSES],
    ["started", "working", "blocked", "waiting_for_human", "submitted", "completed", "failed", "expired"],
  );
  assert.ok(isRunStatus("waiting_for_human"));
  assert.ok(!isRunStatus("nonsense"));
});

test("statusForPhase maps common phrases to a canonical status", () => {
  assert.equal(statusForPhase("reading files"), "working");
  assert.equal(statusForPhase("editing files"), "working");
  assert.equal(statusForPhase("waiting for human approval"), "waiting_for_human");
  assert.equal(statusForPhase("submitting evidence"), "submitted");
  assert.equal(statusForPhase("completed"), "completed");
  assert.equal(statusForPhase("run budget expired"), "expired");
  assert.equal(statusForPhase("hit an error"), "failed");
  assert.equal(statusForPhase(""), "working");
});

// ---------------------------------------------------------------------------
// Event redaction — no token, setup code, claim URL, local.json, or source code
// ---------------------------------------------------------------------------

test("redactRunEvent strips scoped tokens and Bearer headers", () => {
  const out = redactRunEvent("loaded with token oak_abc123DEF456 via Bearer oak_secretvalue");
  assert.ok(!/oak_abc123DEF456/.test(out));
  assert.ok(!/oak_secretvalue/.test(out));
  assert.match(out, /\[redacted-token\]|Bearer \[redacted\]/);
});

test("redactRunEvent strips claim URLs and setup codes", () => {
  const out = redactRunEvent("approve https://oathlock.vercel.app/claim/abc-123 setup_code: s3cr3t");
  assert.ok(!/claim\/abc-123/.test(out));
  assert.ok(!/s3cr3t/.test(out));
});

test("redactRunEvent strips references to the local token file", () => {
  const out = redactRunEvent("read token from .oathlock/local.json");
  assert.ok(!/local\.json/.test(out));
});

test("redactRunEvent rejects source-code-looking content with a generic label", () => {
  assert.ok(looksLikeSourceCode("function foo() { return 1; }"));
  assert.ok(looksLikeSourceCode("line one\nline two"));
  assert.equal(redactRunEvent("export function leak() { return secret; }"), "[status update]");
  assert.equal(redactRunEvent("const a = 1;\nconst b = 2;"), "[status update]");
});

test("redactRunEvent keeps a clean status phrase intact and truncates long ones", () => {
  assert.equal(redactRunEvent("phase: editing files"), "phase: editing files");
  assert.ok(isCleanRunEvent("phase: reading files"));
  const long = "x".repeat(500);
  assert.ok(redactRunEvent(long).length <= 200);
});

// ---------------------------------------------------------------------------
// Two-run proof — conservative copy
// ---------------------------------------------------------------------------

test("two-run proof copy matches the required conservative wording", () => {
  assert.equal(TWO_RUN_PROOF_COPY.followed, "Evidence suggests this rule held in the later run.");
  assert.equal(TWO_RUN_PROOF_COPY.violated, "The same pattern recurred while this rule was loaded.");
  assert.equal(TWO_RUN_PROOF_COPY.not_applicable, "The later run did not touch this rule’s behavior.");
  assert.equal(TWO_RUN_PROOF_COPY.needs_review, "Evidence is mixed or insufficient.");
  assert.equal(TWO_RUN_PROOF_COPY.too_vague, "This rule is too broad to evaluate reliably.");
  assert.equal(TWO_RUN_PROOF_COPY.obsolete, "Later evidence suggests this rule may no longer apply.");
});

test("no proof copy contains an overclaiming phrase", () => {
  for (const copy of Object.values(TWO_RUN_PROOF_COPY)) {
    assert.doesNotThrow(() => assertConservative(copy));
  }
  assert.doesNotThrow(() => assertConservative(PROOF_PENDING_COPY));
  // The guard actually catches overclaims.
  assert.throws(() => assertConservative("This proved it worked and guaranteed improvement."));
  // Spot-check the forbidden list is real.
  assert.ok(FORBIDDEN_PROOF_PHRASES.includes("guaranteed improvement"));
  assert.ok(FORBIDDEN_PROOF_PHRASES.includes("saved cost"));
});

// ---------------------------------------------------------------------------
// Two-run proof — shaping
// ---------------------------------------------------------------------------

const RUN_A: ProofRunRef = { runId: "a", taskTitle: "Run A", rulesLoadedCount: 0, status: "completed" };

test("buildTwoRunProof is pending (non-claiming) until a later run evaluates the rule", () => {
  const proof = buildTwoRunProof({
    runA: RUN_A,
    rule: { id: "r1", title: "Inspect root cause", ruleType: "edit_thrash_prevention" },
    runB: null,
    health: null,
  });
  assert.equal(proof.evaluated, false);
  assert.equal(proof.health, null);
  assert.equal(proof.copy, PROOF_PENDING_COPY);
});

test("buildTwoRunProof only evaluates when Run B actually loaded rules", () => {
  const proof = buildTwoRunProof({
    runA: RUN_A,
    rule: { id: "r1", title: "Inspect root cause", ruleType: "edit_thrash_prevention" },
    runB: { runId: "b", taskTitle: "Run B", rulesLoadedCount: 0, status: "completed" },
    health: "followed",
  });
  // rulesLoadedCount is 0 → not a real later run that loaded the rule.
  assert.equal(proof.evaluated, false);
  assert.equal(proof.copy, PROOF_PENDING_COPY);
});

test("proofsFromRun: Run B with loaded rules produces evaluated Rule Health", () => {
  const proofs = proofsFromRun(
    {
      runId: "b",
      taskTitle: "Add a config option",
      rulesLoadedCount: 1,
      status: "completed",
      ruleHealth: {
        evaluated: true,
        items: [
          { status: "followed", title: "Inspect root cause" },
          { status: "violated", title: "Read each file once" },
        ],
      },
    },
    RUN_A,
  );
  assert.equal(proofs.length, 2);
  assert.equal(proofs[0].evaluated, true);
  assert.equal(proofs[0].health, "followed");
  assert.equal(proofs[0].copy, TWO_RUN_PROOF_COPY.followed);
  assert.equal(proofs[1].health, "violated");
  assert.equal(proofs[1].copy, TWO_RUN_PROOF_COPY.violated);
});

test("proofsFromRun returns nothing when the run did not evaluate Rule Health", () => {
  const proofs = proofsFromRun(
    { runId: "b", taskTitle: "x", rulesLoadedCount: 0, status: "completed", ruleHealth: null },
    RUN_A,
  );
  assert.deepEqual(proofs, []);
});

test("isRuleHealthStatus guards the six valid statuses", () => {
  for (const s of ["followed", "violated", "not_applicable", "too_vague", "needs_review", "obsolete"]) {
    assert.ok(isRuleHealthStatus(s));
  }
  assert.ok(!isRuleHealthStatus("made_up"));
});
