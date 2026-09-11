/**
 * Evidence submission — capture / attachment / attestation separation.
 *
 * Locks the Phase 1 contract: structured evidence attaches automatically
 * without a human typing --approved, raw transcripts still require consent,
 * risk NEVER prevents valid evidence from being retained, and an agent's
 * submission is never silently converted into a human attestation.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  classifySubmission,
  decideAttachment,
  computeSubmissionDigest,
  DEFAULT_EVIDENCE_SUBMISSION_POLICY,
  type SubmissionInput,
} from "../src/lib/evidence-submission.ts";
import { EVIDENCE_CONTRACT_SCHEMA_VERSION } from "../src/lib/evidence-contract.ts";

function goodContract(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: EVIDENCE_CONTRACT_SCHEMA_VERSION,
    task: { requested: "Fix the drawer focus trap", scope_changes: [] },
    changes: [{ summary: "Adjusted focus handling", files: ["src/ui/drawer.tsx"] }],
    verification: [{ command: "npm test", result: "passed" }],
    failed_commands: [],
    limitations: [],
    sensitive_areas: [],
    ...overrides,
  };
}

function input(over: Partial<SubmissionInput> = {}): SubmissionInput {
  return {
    contract: goodContract(),
    rawSessionText: null,
    redactionCompleted: true,
    linkage: { runId: "run-1", expectedRunId: "run-1", assignmentStale: false, alreadySubmitted: false },
    ...over,
  };
}

function attach(over: Partial<SubmissionInput> = {}, opts: { policy?: "structured_auto" | "always_confirm"; humanConfirmed?: boolean } = {}) {
  const inp = input(over);
  const classification = classifySubmission(inp);
  return decideAttachment({
    classification,
    policy: opts.policy ?? DEFAULT_EVIDENCE_SUBMISSION_POLICY,
    origin: "agent",
    humanConfirmed: opts.humanConfirmed ?? false,
    digest: computeSubmissionDigest({ contract: inp.contract, rawSessionText: inp.rawSessionText, runId: inp.linkage.runId }),
  });
}

// --- criterion 1 + 3: structured evidence attaches without --approved -------

test("structured, clean evidence attaches automatically without human approval", () => {
  const decision = attach();
  assert.equal(decision.status, "attached");
  assert.equal(decision.origin, "agent");
  // The whole point: attaching must NOT imply a human vouched for it.
  assert.equal(decision.attestation, "not_requested");
});

test("an agent submission is never converted into a human attestation", () => {
  for (const policy of ["structured_auto", "always_confirm"] as const) {
    const decision = attach({}, { policy });
    assert.notEqual(decision.attestation, "attested", `${policy} must not fabricate attestation`);
  }
});

test("only an explicit human confirmation produces an attestation", () => {
  const decision = attach({}, { humanConfirmed: true });
  assert.equal(decision.status, "attached");
  assert.equal(decision.attestation, "attested");
});

// --- criterion 4: raw session material still requires consent --------------

test("a raw session transcript requires human confirmation even when clean", () => {
  const decision = attach({ rawSessionText: "a full session transcript, nothing secret in it" });
  assert.equal(decision.status, "validated", "must not attach without consent");
  assert.equal(decision.attestation, "pending");
  assert.match(decision.reasons.join(" "), /raw session transcripts require human confirmation/i);
});

test("a confirmed raw session transcript does attach", () => {
  const decision = attach({ rawSessionText: "a full session transcript" }, { humanConfirmed: true });
  assert.equal(decision.status, "attached");
  assert.equal(decision.attestation, "attested");
});

// --- risk must NOT block attachment ---------------------------------------

test("evidence describing FAILURE still attaches — risk never blocks the record", () => {
  const failing = goodContract({
    verification: [{ command: "npm test", result: "failed" }],
    failed_commands: ["npm test"],
    limitations: ["Could not verify the migration path"],
  });
  const decision = attach({ contract: failing });
  assert.equal(
    decision.status,
    "attached",
    "a failed run's evidence is still evidence; risk routes review, not retention",
  );
});

test("declared scope changes do not prevent attachment", () => {
  const deviated = goodContract({ task: { requested: "Fix drawer", scope_changes: ["also touched src/auth"] } });
  assert.equal(attach({ contract: deviated }).status, "attached");
});

// --- criterion 2 + 9: malformed / unclean payloads -------------------------

test("an unrecognized schema version is not structured", () => {
  const c = classifySubmission(input({ contract: goodContract({ schemaVersion: "oathlock.evidence.v99" }) }));
  assert.equal(c.structured, false);
  assert.match(c.reasons.join(" "), /schema version/i);
});

test("a contract missing the requested task is not structured", () => {
  const c = classifySubmission(input({ contract: goodContract({ task: { requested: "", scope_changes: [] } }) }));
  assert.equal(c.structured, false);
});

test("a non-object payload is rejected outright", () => {
  assert.equal(attach({ contract: "not an object" }).status, "rejected");
});

test("payload is rejected when server-side redaction did not run", () => {
  const decision = attach({ redactionCompleted: false });
  assert.equal(decision.status, "rejected");
  assert.match(decision.reasons.join(" "), /redaction did not complete/i);
});

test("OathLock's own credentials are rejected, never attached", () => {
  const leaky = goodContract({ limitations: ["retried with oak_abcdef123456789012345678"] });
  const c = classifySubmission(input({ contract: leaky }));
  assert.equal(c.clean, false, "secret-shaped content must fail the clean gate");
  assert.equal(attach({ contract: leaky }).status, "rejected");
});

// Regression: the contract path used to check only OathLock's own
// SECRET_PATTERNS, which do NOT cover third-party provider keys. That was
// survivable while a human eyeballed every submission; with auto-attachment
// it would silently persist a leaked provider key into the durable record.
test("third-party provider keys in contract fields are rejected", () => {
  const cases: Array<[string, string]> = [
    ["anthropic", "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA"],
    ["openai", "sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
    ["github", "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
    ["aws", "AKIAIOSFODNN7EXAMPLE"],
  ];
  for (const [label, secret] of cases) {
    const leaky = goodContract({ limitations: [`leaked ${secret} during the run`] });
    const c = classifySubmission(input({ contract: leaky }));
    assert.equal(c.clean, false, `${label} key must fail the clean gate`);
    assert.equal(attach({ contract: leaky }).status, "rejected", `${label} key must not attach`);
  }
});

// --- criterion 5: linkage / replay ----------------------------------------

test("a run identifier that does not match the authenticated run is not structured", () => {
  const c = classifySubmission(
    input({ linkage: { runId: "run-OTHER", expectedRunId: "run-1", assignmentStale: false, alreadySubmitted: false } }),
  );
  assert.equal(c.structured, false);
  assert.match(c.reasons.join(" "), /does not match/i);
});

test("a stale assignment is not structured", () => {
  const c = classifySubmission(
    input({ linkage: { runId: "run-1", expectedRunId: "run-1", assignmentStale: true, alreadySubmitted: false } }),
  );
  assert.equal(c.structured, false);
  assert.match(c.reasons.join(" "), /stale/i);
});

// --- criterion 6: idempotency ---------------------------------------------

test("the same payload always produces the same digest (idempotency key)", () => {
  const a = computeSubmissionDigest({ contract: goodContract(), rawSessionText: null, runId: "run-1" });
  const b = computeSubmissionDigest({ contract: goodContract(), rawSessionText: null, runId: "run-1" });
  assert.equal(a, b);
});

test("different payloads or different runs produce different digests", () => {
  const base = computeSubmissionDigest({ contract: goodContract(), rawSessionText: null, runId: "run-1" });
  const otherRun = computeSubmissionDigest({ contract: goodContract(), rawSessionText: null, runId: "run-2" });
  const otherBody = computeSubmissionDigest({
    contract: goodContract({ limitations: ["different"] }),
    rawSessionText: null,
    runId: "run-1",
  });
  assert.notEqual(base, otherRun);
  assert.notEqual(base, otherBody);
});

// --- criterion 7: no auto-close in this phase ------------------------------

test("attachment never reports a closed or completed run", () => {
  const statuses = new Set(
    [attach(), attach({ rawSessionText: "raw" }), attach({ contract: 42 })].map((d) => d.status),
  );
  for (const s of statuses) {
    assert.ok(
      ["draft", "validated", "attached", "rejected"].includes(s),
      `attachment must not invent a lifecycle state: ${s}`,
    );
  }
});

// --- policy ---------------------------------------------------------------

test("always_confirm policy holds even clean structured evidence for a human", () => {
  const decision = attach({}, { policy: "always_confirm" });
  assert.equal(decision.status, "validated");
  assert.equal(decision.attestation, "pending");
});

test("the shipped default is the safer structured-only policy", () => {
  assert.equal(DEFAULT_EVIDENCE_SUBMISSION_POLICY, "structured_auto");
});
