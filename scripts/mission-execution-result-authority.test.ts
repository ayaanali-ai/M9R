import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { MissionExecutionResultProcessor } from "@/lib/mission/mission-execution-result-processor";
import type { AcceptedExecutionResult, MissionExecutionResultStore } from "@/lib/mission/mission-execution-result-store";

const sql = readFileSync(join(process.cwd(), "supabase/migrations/20260728020000_mission_execution_result_authority.sql"), "utf8");

test("result inbox permits one start plus one terminal and forbids raw provider payloads", () => {
  assert.match(sql, /where result_kind = 'started'/);
  assert.match(sql, /where result_kind in \('completed','failed','cancelled','lease_lost'\)/);
  assert.match(sql, /rawOutput','stdout','stderr','prompt','conversation','environment','token','secret/);
  assert.match(sql, /metadata ->> 'redactionState' = 'redacted'/);
});

test("acceptance is fenced and assignment-linked in one security-definer RPC", () => {
  assert.match(sql, /create or replace function public\.accept_mission_execution_result_atomic/i);
  assert.match(sql, /security definer set search_path = ''/i);
  assert.match(sql, /legacy_missing_assignment_linkage/);
  assert.match(sql, /stale_fencing_generation/);
  assert.match(sql, /terminal_result_conflict/);
  assert.match(sql, /insert into public\.mission_execution_result_inbox/i);
  assert.ok(sql.indexOf("select * into v_intent") < sql.indexOf("insert into public.mission_execution_result_inbox"));
});

test("acceptance RPC exposes every required typed refusal and rejects legacy or raw input", () => {
  for (const reason of ["legacy_missing_assignment_linkage", "dispatch_not_found", "workspace_mismatch", "mission_mismatch", "assignment_mismatch", "execution_mismatch", "provider_mismatch", "lease_mismatch", "stale_fencing_generation", "execution_attempt_mismatch", "unsupported_result_kind", "unsupported_schema_version", "invalid_digest", "invalid_idempotency_key", "metadata_not_redacted", "metadata_too_large", "invalid_dispatch_state", "execution_not_started", "terminal_result_conflict", "result_after_lease_loss", "idempotency_conflict"]) assert.match(sql, new RegExp(reason));
  assert.match(sql, /p_execution_id <> p_dispatch_intent_id::text/);
  assert.match(sql, /v_intent\.assignment_id is null/);
  assert.match(sql, /for update/);
});

test("processor maps every accepted lifecycle kind through only the command port", async () => {
  const kinds = [["started", "RecordExecutionStarted"], ["completed", "RecordExecutionCompleted"], ["failed", "RecordExecutionFailed"], ["cancelled", "RecordExecutionCancelled"], ["lease_lost", "RecordExecutionLeaseLost"]] as const;
  for (const [kind, expected] of kinds) {
    const row: AcceptedExecutionResult = { acceptedResultId: `r-${kind}`, workspaceId: "ws", missionId: "m", assignmentId: "a", dispatchIntentId: "intent", dispatchKey: "primary", executionId: "intent", providerAdapterId: "codex", leaseId: "lease", fencingGeneration: "9007199254740993", executionAttempt: 1, resultKind: kind, resultDigest: "digest-1234567890", metadata: { redactionState: "redacted" }, evidenceDescriptors: [], evidenceRequired: false, correlationId: "corr", causationId: "cause", retryCount: 0, lifecycleAppliedAt: null, evidenceAppliedAt: null };
    const commands: string[] = [];
    const store: MissionExecutionResultStore = { acceptResult: async () => { throw new Error("unused"); }, claimUnapplied: async () => [row], markLifecycleApplied: async () => {}, markEvidenceApplied: async () => {}, markFullyApplied: async () => {}, markApplicationFailed: async () => {}, releaseApplicationClaim: async () => {} };
    await new MissionExecutionResultProcessor({ store, clock: () => "2026-07-28T00:00:00.000Z", retryDelayMs: () => 1_000, commandPort: { run: async ({ command }) => { commands.push(command.type); return { ok: true }; } } }).runOnce({ owner: "p", leaseDurationMs: 60_000, limit: 1 });
    assert.deepEqual(commands, [expected]);
  }
});

test("recovery skips applied lifecycle and uses deterministic idempotency for partial evidence retries", async () => {
  const row: AcceptedExecutionResult = { acceptedResultId: "recover", workspaceId: "ws", missionId: "m", assignmentId: "a", dispatchIntentId: "intent", dispatchKey: "primary", executionId: "intent", providerAdapterId: "codex", leaseId: "lease", fencingGeneration: "1", executionAttempt: 1, resultKind: "completed", resultDigest: "digest-1234567890", metadata: { redactionState: "redacted" }, evidenceDescriptors: [{ evidenceType: "test", digest: "evidence-digest", storageRef: null, byteSize: 1, redactionState: "redacted", generatedAt: "2026-07-28T00:00:00.000Z", mimeType: null }], evidenceRequired: true, correlationId: "corr", causationId: "cause", retryCount: 1, lifecycleAppliedAt: "2026-07-28T00:00:01.000Z", evidenceAppliedAt: null };
  const commands: string[] = [];
  const store: MissionExecutionResultStore = { acceptResult: async () => { throw new Error("unused"); }, claimUnapplied: async () => [row], markLifecycleApplied: async () => { throw new Error("must not rerun lifecycle"); }, markEvidenceApplied: async () => {}, markFullyApplied: async () => {}, markApplicationFailed: async () => {}, releaseApplicationClaim: async () => {} };
  await new MissionExecutionResultProcessor({ store, clock: () => "2026-07-28T00:00:00.000Z", retryDelayMs: () => 1_000, commandPort: { run: async ({ command }) => { commands.push(command.type); return { ok: true }; } } }).runOnce({ owner: "p", leaseDurationMs: 60_000, limit: 1 });
  assert.deepEqual(commands, ["RecordEvidence"]);
});

test("application processor maps a terminal accepted result through the command port then completes", async () => {
  const marks: string[] = [];
  const row: AcceptedExecutionResult = {
    acceptedResultId: "result-1", workspaceId: "ws", missionId: "m", assignmentId: "a", dispatchIntentId: "intent", dispatchKey: "primary", executionId: "intent", providerAdapterId: "codex", leaseId: "lease", fencingGeneration: "9007199254740993", executionAttempt: 1, resultKind: "completed", resultDigest: "digest-1234567890", metadata: { redactionState: "redacted" }, evidenceDescriptors: [], evidenceRequired: false, correlationId: "corr", causationId: null, retryCount: 0, lifecycleAppliedAt: null, evidenceAppliedAt: null,
  };
  const store: MissionExecutionResultStore = {
    acceptResult: async () => { throw new Error("not used"); }, claimUnapplied: async () => [row],
    markLifecycleApplied: async () => { marks.push("lifecycle"); }, markEvidenceApplied: async () => { marks.push("evidence"); }, markFullyApplied: async () => { marks.push("full"); }, markApplicationFailed: async () => { marks.push("failed"); }, releaseApplicationClaim: async () => {},
  };
  const commands: string[] = [];
  const processor = new MissionExecutionResultProcessor({ store, clock: () => "2026-07-28T00:00:00.000Z", retryDelayMs: () => 10_000, commandPort: { run: async ({ command }) => { commands.push(command.type); return { ok: true }; } } });
  const result = await processor.runOnce({ owner: "worker", leaseDurationMs: 60_000, limit: 1 });
  assert.deepEqual(commands, ["RecordExecutionCompleted"]);
  assert.deepEqual(marks, ["lifecycle", "evidence", "full"]);
  assert.deepEqual(result, { claimed: 1, fullyApplied: 1, failed: 0 });
});

test("application failure retains the accepted result and schedules a retry", async () => {
  const row = { acceptedResultId: "result-2", workspaceId: "ws", missionId: "m", assignmentId: "a", dispatchIntentId: "intent", dispatchKey: "primary", executionId: "intent", providerAdapterId: "codex", leaseId: "lease", fencingGeneration: "1", executionAttempt: 1, resultKind: "started", resultDigest: "digest-1234567890", metadata: { redactionState: "redacted" }, evidenceDescriptors: [], evidenceRequired: false, correlationId: "corr", causationId: null, retryCount: 2, lifecycleAppliedAt: null, evidenceAppliedAt: null } satisfies AcceptedExecutionResult;
  let failed = false;
  const store: MissionExecutionResultStore = { acceptResult: async () => { throw new Error("not used"); }, claimUnapplied: async () => [row], markLifecycleApplied: async () => {}, markEvidenceApplied: async () => {}, markFullyApplied: async () => {}, markApplicationFailed: async () => { failed = true; }, releaseApplicationClaim: async () => {} };
  const processor = new MissionExecutionResultProcessor({ store, clock: () => "2026-07-28T00:00:00.000Z", retryDelayMs: () => 10_000, commandPort: { run: async () => ({ ok: false }) } });
  const result = await processor.runOnce({ owner: "worker", leaseDurationMs: 60_000, limit: 1 });
  assert.equal(failed, true);
  assert.equal(result.failed, 1);
});
