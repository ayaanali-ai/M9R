import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateEvidenceContract,
  buildEvidenceApprovalPreview,
  EVIDENCE_CONTRACT_SCHEMA_VERSION,
} from "../src/lib/evidence-contract.ts";
import { buildRunPassport, type PassportRunInput } from "../src/lib/run-passport-service.ts";
import { readFile } from "node:fs/promises";

function baseContract(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: EVIDENCE_CONTRACT_SCHEMA_VERSION,
    task: { requested: "Add live sync", scope_changes: [] },
    changes: [{ summary: "Classified waiting runs", files: ["src/lib/agent-workspace-data.ts"] }],
    verification: [{ command: "npm test", result: "passed", exit_code: 0, source: "agent_recorded", observed_at: new Date(Date.now() - 60_000).toISOString(), artifact_digest: "sha256:" + "a".repeat(64) }],
    failed_commands: [],
    limitations: ["Uses polling, not push."],
    sensitive_areas: [],
    ...overrides,
  };
}

test("rejects verification without an integer exit status", () => {
  const result = validateEvidenceContract(baseContract({ verification: [{ command: "npm test", result: "passed", source: "agent_recorded", observed_at: "2026-07-13T02:00:00.000Z", artifact_digest: "sha256:" + "a".repeat(64) }] }), { humanApprovedSubmission: true, nowMs: Date.parse("2026-07-13T02:01:00Z") });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /exit_code/.test(e.field)));
});

test("rejects stale, future, and malformed verification provenance", () => {
  const nowMs = Date.parse("2026-07-13T03:00:00Z");
  for (const observed_at of ["2026-07-12T20:00:00Z", "2026-07-13T03:10:00Z", "not-a-date"]) {
    const result = validateEvidenceContract(baseContract({ verification: [{ command: "npm test", result: "passed", exit_code: 0, source: "agent_recorded", observed_at, artifact_digest: "sha256:" + "a".repeat(64) }] }), { humanApprovedSubmission: true, nowMs, maxEvidenceAgeMs: 60 * 60_000 });
    assert.equal(result.ok, false);
  }
});

test("rejects a missing or malformed artifact digest", () => {
  for (const artifact_digest of [undefined, "sha256:nope", "md5:" + "a".repeat(32)]) {
    const result = validateEvidenceContract(baseContract({ verification: [{ command: "npm test", result: "passed", exit_code: 0, source: "agent_recorded", observed_at: "2026-07-13T02:00:00Z", artifact_digest }] }), { humanApprovedSubmission: true, nowMs: Date.parse("2026-07-13T02:01:00Z") });
    assert.equal(result.ok, false);
  }
});

test("a valid contract normalizes cleanly", () => {
  const result = validateEvidenceContract(baseContract(), { humanApprovedSubmission: true });
  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
  assert.ok(result.normalized);
  assert.equal(result.normalized!.verification[0].command, "npm test");
});

test("rejects without human_approved_submission, even with a perfect contract", () => {
  const result = validateEvidenceContract(baseContract(), { humanApprovedSubmission: false });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /human_approved_submission/.test(e.message)));
});

test("rejects the wrong schema version", () => {
  const result = validateEvidenceContract(baseContract({ schemaVersion: "oathlock.evidence.v0" }), {
    humanApprovedSubmission: true,
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.field === "schemaVersion"));
});

test("a verification result with no command is not evidence", () => {
  const result = validateEvidenceContract(
    baseContract({ verification: [{ result: "passed", source: "agent_recorded" }] }),
    { humanApprovedSubmission: true },
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /not evidence/.test(e.message)));
});

test("a command with no result state is rejected", () => {
  const result = validateEvidenceContract(
    baseContract({ verification: [{ command: "npm test", source: "agent_recorded" }] }),
    { humanApprovedSubmission: true },
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /no result state/.test(e.message)));
});

test("contradictory pass/fail for the same command is rejected", () => {
  const result = validateEvidenceContract(
    baseContract({
      verification: [
        { command: "npm test", result: "passed", source: "agent_recorded" },
        { command: "npm test", result: "failed", source: "agent_recorded" },
      ],
    }),
    { humanApprovedSubmission: true },
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /Contradictory results/.test(e.message)));
});

test("missing source classification is rejected", () => {
  const result = validateEvidenceContract(
    baseContract({ verification: [{ command: "npm test", result: "passed" }] }),
    { humanApprovedSubmission: true },
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /source classification/.test(e.message)));
});

test("changes reported with zero files across all changes fails file reconciliation", () => {
  const result = validateEvidenceContract(
    baseContract({ changes: [{ summary: "did something", files: [] }] }),
    { humanApprovedSubmission: true },
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /reconcile/.test(e.message)));
});

test("secret-shaped content is rejected even inside a limitations string", () => {
  const result = validateEvidenceContract(
    baseContract({ limitations: ["Bearer sk-live-abcdef1234567890"] }),
    { humanApprovedSubmission: true },
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /Rejected/.test(e.message)));
});

test("active script content is rejected", () => {
  const result = validateEvidenceContract(
    baseContract({ task: { requested: "<script>alert(1)</script>", scope_changes: [] } }),
    { humanApprovedSubmission: true },
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /active script/.test(e.message)));
});

test("oversized payload is rejected", () => {
  const huge = "x".repeat(60_000);
  const result = validateEvidenceContract(baseContract({ limitations: [huge] }), {
    humanApprovedSubmission: true,
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /exceeds/.test(e.message)));
});

test("scope changes are recorded as a warning, not an error", () => {
  const result = validateEvidenceContract(
    baseContract({ task: { requested: "Add sync", scope_changes: ["touched an extra file"] } }),
    { humanApprovedSubmission: true },
  );
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((w) => /scope changes/.test(w.message)));
});

test("approval preview never claims more than the validated contract contains", () => {
  const result = validateEvidenceContract(baseContract(), { humanApprovedSubmission: true });
  assert.ok(result.normalized);
  const preview = buildEvidenceApprovalPreview(result.normalized!);
  assert.equal(preview.changedFileCount, 1);
  assert.equal(preview.commandTiedChecks, 1);
  assert.equal(preview.limitationsStated, 1);
  assert.equal(preview.scopeChangesDeclared, 0);
});

function baseRun(): PassportRunInput {
  return {
    id: "run-1",
    connection_id: "conn-1",
    workspace_id: "ws-1",
    latest_session_id: "session-1",
  };
}

test("Run Passport carries a contract_preview only when an Evidence Contract was submitted", () => {
  const withoutContract = buildRunPassport({ run: baseRun() });
  assert.equal(withoutContract.evidence.contract_preview, null);

  const result = validateEvidenceContract(baseContract(), { humanApprovedSubmission: true });
  assert.ok(result.normalized);
  const withContract = buildRunPassport({ run: baseRun(), evidenceContract: result.normalized });
  assert.ok(withContract.evidence.contract_preview);
  assert.equal(withContract.evidence.contract_preview!.changedFileCount, 1);
  assert.equal(withContract.evidence.contract_preview!.commandTiedChecks, 1);
});

test("Run Passport trusts validated contract verification over lossy free-text behavior parsing", () => {
  const result = validateEvidenceContract(baseContract(), { humanApprovedSubmission: true });
  assert.ok(result.normalized);
  const passport = buildRunPassport({
    run: {
      ...baseRun(),
      behavior: { failedCommands: 1, verificationPresent: false },
    },
    evidenceContract: result.normalized,
  });

  assert.deepEqual(passport.evidence.verification.failed_commands, []);
  assert.equal(passport.behavior.failed_commands, 0);
  assert.equal(passport.behavior.verification_present, true);
  assert.equal(passport.evidence.verification_provenance.length, 1);
  assert.equal(passport.evidence.verification_provenance[0].command, "npm test");
  assert.equal(passport.evidence.verification_provenance[0].result, "passed");
});

test("Gate 7 persistence rejects replayed contracts by workspace digest", async () => {
  const migration = await readFile(new URL("../supabase/migrations/20260713034000_gate7_evidence_replay_integrity.sql", import.meta.url), "utf8");
  const service = await readFile(new URL("../src/lib/agent-run-service.ts", import.meta.url), "utf8");
  assert.match(migration, /unique index[\s\S]+workspace_id, contract_digest/i);
  assert.match(service, /createHash\("sha256"\)/);
  assert.match(service, /error\.code === "23505"/);
});

test("Gate 7 persistence carries the route's human approval into the evidence row", async () => {
  const service = await readFile(new URL("../src/lib/agent-run-service.ts", import.meta.url), "utf8");
  assert.match(
    service,
    /\.from\("evidence_records"\)[\s\S]+?\.insert\(\{[\s\S]+?human_approved_submission:\s*true/,
  );
});
