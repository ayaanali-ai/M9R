import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { applyAssignmentDecision, checkAssignmentCompletionLinkage, checkAssignmentRuntimeConstraints, validateAssignment } from "@/lib/assignment";

const valid = {
  repository: "runleak",
  task: "Verify the assignment lifecycle",
  scope: ["scripts/assignment.test.ts"],
  prohibitedScope: ["production credentials"],
  maxDurationMs: 30 * 60_000,
  maxEstimatedTokens: 8_000,
  approvalPolicy: "human_before_material_action" as const,
  evidenceRequired: true,
  expiresAt: "2026-07-14T00:00:00.000Z",
};

test("validates and normalizes a bounded structured assignment", () => {
  const result = validateAssignment(valid, Date.parse("2026-07-13T00:00:00.000Z"));
  assert.equal(result.ok, true);
  assert.equal(result.assignment?.state, "requested");
  assert.equal(result.assignment?.repository, "runleak");
  assert.equal(result.assignment?.evidenceRequired, true);
});

test("rejects unbounded, expired, or unsafe assignment input", () => {
  assert.equal(validateAssignment({ ...valid, task: "" }).ok, false);
  assert.equal(validateAssignment({ ...valid, maxDurationMs: 0 }).ok, false);
  assert.equal(validateAssignment({ ...valid, expiresAt: "2026-07-12T00:00:00.000Z" }, Date.parse("2026-07-13T00:00:00.000Z")).ok, false);
  assert.equal(validateAssignment({ ...valid, scope: ["<script>alert(1)</script>"] }).ok, false);
});

test("prohibited scope may safely name secret files without allowing active content", () => {
  assert.equal(validateAssignment({
    ...valid,
    prohibitedScope: [".env", ".oathlock/local.json", "private keys"],
  }, Date.parse("2026-07-13T00:00:00.000Z")).ok, true);
  assert.equal(validateAssignment({
    ...valid,
    prohibitedScope: ["<script>alert(1)</script>"],
  }, Date.parse("2026-07-13T00:00:00.000Z")).ok, false);
});

test("assignment lifecycle permits only explicit terminal-safe transitions", () => {
  assert.equal(applyAssignmentDecision("requested", "accept").state, "accepted");
  assert.equal(applyAssignmentDecision("requested", "reject").state, "rejected");
  assert.equal(applyAssignmentDecision("accepted", "complete").state, "completed");
  assert.equal(applyAssignmentDecision("accepted", "cancel").state, "cancelled");
  assert.equal(applyAssignmentDecision("requested", "expire").state, "expired");
  assert.equal(applyAssignmentDecision("completed", "accept").ok, false);
  assert.equal(applyAssignmentDecision("rejected", "complete").ok, false);
});

test("decision-time constraints expire stale or over-duration assignments", () => {
  const now = Date.parse("2026-07-13T04:00:00Z");
  assert.deepEqual(checkAssignmentRuntimeConstraints({ decision: "accept", expiresAt: "2026-07-13T03:59:59Z", acceptedAt: null, maxDurationMs: 60_000, nowMs: now }), { ok: false, reason: "expired" });
  assert.deepEqual(checkAssignmentRuntimeConstraints({ decision: "complete", expiresAt: "2026-07-13T05:00:00Z", acceptedAt: "2026-07-13T03:58:59Z", maxDurationMs: 60_000, nowMs: now }), { ok: false, reason: "duration_exceeded" });
  assert.deepEqual(checkAssignmentRuntimeConstraints({ decision: "complete", expiresAt: "2026-07-13T05:00:00Z", acceptedAt: "2026-07-13T03:59:30Z", maxDurationMs: 60_000, nowMs: now }), { ok: true, reason: null });
});

test("assignment list services sweep expired requested and accepted work before listing", async () => {
  const service = await readFile(new URL("../src/lib/assignment-service.ts", import.meta.url), "utf8");
  assert.match(service, /listAssignmentsForDashboard[\s\S]*?await sweepExpiredAssignments\(\)/);
  assert.match(service, /listAssignmentsForAgent[\s\S]*?await sweepExpiredAssignments\(\)/);
});

test("completion linkage rejects runs or evidence that predate assignment acceptance", () => {
  const acceptedAt = "2026-07-13T18:00:00Z";
  assert.deepEqual(checkAssignmentCompletionLinkage({
    acceptedAt,
    runId: "run-new",
    runStartedAt: "2026-07-13T17:59:59Z",
    evidenceRunId: "run-new",
    evidenceCreatedAt: "2026-07-13T18:01:00Z",
  }), { ok: false, reason: "run_predates_acceptance" });
  assert.deepEqual(checkAssignmentCompletionLinkage({
    acceptedAt,
    runId: "run-new",
    runStartedAt: "2026-07-13T18:01:00Z",
    evidenceRunId: "run-new",
    evidenceCreatedAt: "2026-07-13T17:59:59Z",
  }), { ok: false, reason: "evidence_predates_acceptance" });
});

test("completion linkage requires matching post-acceptance run and evidence", () => {
  assert.deepEqual(checkAssignmentCompletionLinkage({
    acceptedAt: "2026-07-13T18:00:00Z",
    runId: "run-new",
    runStartedAt: "2026-07-13T18:01:00Z",
    evidenceRunId: "run-other",
    evidenceCreatedAt: "2026-07-13T18:02:00Z",
  }), { ok: false, reason: "evidence_run_mismatch" });
  assert.deepEqual(checkAssignmentCompletionLinkage({
    acceptedAt: "2026-07-13T18:00:00Z",
    runId: "run-new",
    runStartedAt: "2026-07-13T18:01:00Z",
    evidenceRunId: "run-new",
    evidenceCreatedAt: "2026-07-13T18:02:00Z",
  }), { ok: true, reason: null });
});

test("Gate 5 migration creates an exposed RLS-scoped assignment ledger", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20260713024634_gate5_assignments.sql", import.meta.url), "utf8");
  assert.match(sql, /create table if not exists public\.agent_assignments/i);
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /grant select, insert, update on public\.agent_assignments to authenticated/i);
  assert.match(sql, /for update\s+to authenticated\s+using[\s\S]+with check/i);
  assert.match(sql, /workspace_id[\s\S]+target_connection_id[\s\S]+repository/i);
  assert.doesNotMatch(sql, /auth\.role\(\)/i);
});

test("assignment delivery migration links inbox delivery and completion evidence", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20260713025613_gate5_assignment_delivery.sql", import.meta.url), "utf8");
  assert.match(sql, /add column if not exists assignment_id/i);
  assert.match(sql, /references public\.agent_assignments/i);
  assert.match(sql, /add column if not exists evidence_record_id/i);
  assert.match(sql, /references public\.evidence_records/i);
});

test("assignment APIs separate owner creation from bearer-agent decisions", async () => {
  const dashboard = await readFile(new URL("../src/app/api/assignments/route.ts", import.meta.url), "utf8");
  const agent = await readFile(new URL("../src/app/api/agent/assignments/[id]/route.ts", import.meta.url), "utf8");
  const service = await readFile(new URL("../src/lib/assignment-service.ts", import.meta.url), "utf8");
  const ownerDecision = await readFile(new URL("../src/app/api/assignments/[id]/route.ts", import.meta.url), "utf8");
  assert.match(dashboard, /createAssignmentForDashboard/);
  assert.doesNotMatch(dashboard, /authenticateAgent/);
  assert.match(agent, /authenticateAgent/);
  assert.match(agent, /transitionAssignmentForAgent/);
  assert.match(service, /\.eq\("target_connection_id", agent\.connectionId\)/);
  assert.match(service, /evidence_required[\s\S]+evidenceRecordId/);
  assert.match(service, /assignment_id/);
  assert.match(service, /created_by:\s*user\.id/);
  assert.match(service, /version:\s*a\.version/);
  assert.doesNotMatch(service, /schema_version:\s*a\.version/);
  assert.match(service, /\.eq\("state", current\.state\)/);
  assert.match(service, /checkAssignmentRuntimeConstraints/);
  assert.match(service, /ASSIGNMENT_DURATION_EXCEEDED/);
  assert.match(ownerDecision, /cancelAssignmentForDashboard/);
  assert.doesNotMatch(ownerDecision, /authenticateAgent/);
});
