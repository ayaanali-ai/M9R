import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  applyLaunchEvent,
  checkLaunchClaim,
  displayStateForLaunch,
  validateLaunchGrant,
} from "@/lib/resident-launch-contract";

const NOW = Date.parse("2026-07-13T20:00:00.000Z");

const validGrant = {
  assignmentId: "assignment-12345678",
  workspaceId: "workspace-12345678",
  requestingConnectionId: "codex-connection-12345678",
  targetConnectionId: "claude-connection-12345678",
  residentInstanceId: "resident-12345678",
  provider: "claude-code" as const,
  repository: "runleak",
  repositoryBindingId: "repo-binding-12345678",
  task: "Review the resident launch contract for authorization gaps.",
  requiredCapabilities: ["security-review"],
  allowedPaths: ["src/lib/resident-launch-contract.ts"],
  prohibitedPaths: [".env", ".oathlock/local.json"],
  maxDurationMs: 10 * 60_000,
  maxEstimatedTokens: 8_000,
  delegationDepth: 1,
  approvalPolicy: "human_before_start" as const,
  issuedAt: "2026-07-13T20:00:00.000Z",
  expiresAt: "2026-07-13T20:05:00.000Z",
  idempotencyKey: "launch:assignment-12345678:claude-connection-12345678",
  claimTokenHash: "a".repeat(64),
};

test("validates and normalizes a bounded one-time resident launch grant", () => {
  const result = validateLaunchGrant(validGrant, NOW);
  assert.equal(result.ok, true, result.errors.join(" "));
  assert.equal(result.grant?.protocolVersion, "oathlock.resident-launch.v1");
  assert.equal(result.grant?.state, "requested");
  assert.equal(result.grant?.provider, "claude-code");
  assert.deepEqual(result.grant?.allowedPaths, ["src/lib/resident-launch-contract.ts"]);
});

test("rejects unsafe, unbounded, expired, or recursively delegated grants", () => {
  assert.equal(validateLaunchGrant({ ...validGrant, task: "" }, NOW).ok, false);
  assert.equal(validateLaunchGrant({ ...validGrant, maxDurationMs: 0 }, NOW).ok, false);
  assert.equal(validateLaunchGrant({ ...validGrant, maxEstimatedTokens: 1_000_001 }, NOW).ok, false);
  assert.equal(validateLaunchGrant({ ...validGrant, delegationDepth: 2 }, NOW).ok, false);
  assert.equal(validateLaunchGrant({ ...validGrant, expiresAt: "2026-07-13T20:00:00.000Z" }, NOW).ok, false);
  assert.equal(validateLaunchGrant({ ...validGrant, allowedPaths: ["<script>alert(1)</script>"] }, NOW).ok, false);
  assert.equal(validateLaunchGrant({ ...validGrant, claimTokenHash: "raw-secret" }, NOW).ok, false);
});

test("launch lifecycle permits only sourced forward transitions", () => {
  assert.equal(applyLaunchEvent("requested", "require_policy").state, "policy_pending");
  assert.equal(applyLaunchEvent("requested", "authorize").state, "authorized");
  assert.equal(applyLaunchEvent("policy_pending", "authorize").state, "authorized");
  assert.equal(applyLaunchEvent("authorized", "queue").state, "queued");
  assert.equal(applyLaunchEvent("queued", "claim").state, "claimed");
  assert.equal(applyLaunchEvent("claimed", "launch").state, "launching");
  assert.equal(applyLaunchEvent("launching", "acknowledge_process").state, "running");
  assert.equal(applyLaunchEvent("running", "return_result").state, "returning");
  assert.equal(applyLaunchEvent("returning", "accept_evidence").state, "completed");
  assert.equal(applyLaunchEvent("requested", "acknowledge_process").ok, false);
  assert.equal(applyLaunchEvent("completed", "launch").ok, false);
  assert.equal(applyLaunchEvent("launching", "fail_launch").state, "launch_failed");
  assert.equal(applyLaunchEvent("running", "timeout").state, "timed_out");
  assert.equal(applyLaunchEvent("returning", "reject_evidence").state, "evidence_rejected");
});

test("late provider results cannot reopen a cancelled grant", () => {
  const lateResult = applyLaunchEvent("cancelled", "return_result");
  assert.equal(lateResult.ok, false);
  assert.equal(lateResult.state, "cancelled");
  assert.match(lateResult.reason ?? "", /Cannot apply return_result to a launch in cancelled/i);
});

test("resident claim requires the exact live authorized resident and is one-time", () => {
  const base = {
    nowMs: NOW + 30_000,
    expiresAt: validGrant.expiresAt,
    expectedResidentInstanceId: validGrant.residentInstanceId,
    claimingResidentInstanceId: validGrant.residentInstanceId,
    expectedTargetConnectionId: validGrant.targetConnectionId,
    claimingTargetConnectionId: validGrant.targetConnectionId,
    expectedProvider: validGrant.provider,
    claimingProvider: validGrant.provider,
    residentLeaseExpiresAt: "2026-07-13T20:02:00.000Z",
    authorizationActive: true,
    claimedAt: null,
  };
  assert.deepEqual(checkLaunchClaim(base), { ok: true, reason: null });
  assert.equal(checkLaunchClaim({ ...base, claimedAt: "2026-07-13T20:00:10.000Z" }).reason, "already_claimed");
  assert.equal(checkLaunchClaim({ ...base, claimingResidentInstanceId: "resident-other" }).reason, "wrong_resident");
  assert.equal(checkLaunchClaim({ ...base, claimingTargetConnectionId: "connection-other" }).reason, "wrong_connection");
  assert.equal(checkLaunchClaim({ ...base, claimingProvider: "codex" }).reason, "wrong_provider");
  assert.equal(checkLaunchClaim({ ...base, authorizationActive: false }).reason, "authorization_revoked");
  assert.equal(checkLaunchClaim({ ...base, residentLeaseExpiresAt: "2026-07-13T20:00:29.000Z" }).reason, "resident_offline");
  assert.equal(checkLaunchClaim({ ...base, nowMs: Date.parse(validGrant.expiresAt) }).reason, "grant_expired");
});

test("visible agent state is derived only from retained launch state", () => {
  assert.equal(displayStateForLaunch(null, true), "sleeping");
  assert.equal(displayStateForLaunch(null, false), "offline");
  assert.equal(displayStateForLaunch("claimed", true), "awakening");
  assert.equal(displayStateForLaunch("launching", true), "awakening");
  assert.equal(displayStateForLaunch("running", true), "working");
  assert.equal(displayStateForLaunch("returning", true), "returning");
  assert.equal(displayStateForLaunch("completed", true), "sleeping");
  assert.equal(displayStateForLaunch("provider_failed", true), "failed");
  assert.equal(displayStateForLaunch("running", false), "offline");
});

test("Gate 11A migration stores resident authorization and append-only launch custody without provider credentials", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20260713210000_gate11a_resident_launch.sql", import.meta.url), "utf8");
  assert.match(sql, /create table if not exists public\.resident_instances/i);
  assert.match(sql, /create table if not exists public\.resident_provider_authorizations/i);
  assert.match(sql, /create table if not exists public\.launch_grants/i);
  assert.match(sql, /create table if not exists public\.launch_events/i);
  assert.match(sql, /claim_token_hash/i);
  assert.match(sql, /unique\s*\(workspace_id,\s*idempotency_key\)/i);
  assert.match(sql, /enable row level security/gi);
  assert.match(sql, /references public\.agent_assignments/i);
  assert.match(sql, /references public\.agent_connections/i);
  assert.match(sql, /references public\.resident_instances/i);
  assert.match(sql, /alter table public\.agent_assignments/i);
  assert.match(sql, /requesting_connection_id/i);
  assert.match(sql, /dispatch_id/i);
  assert.match(sql, /launch_grant_id/i);
  assert.match(sql, /result_decision/i);
  assert.match(sql, /launch_events_no_update|prevent_launch_event_mutation/i);
  assert.doesNotMatch(sql, /provider_api_key|provider_secret|provider_credential|raw_launch_token|environment_json/i);
});

test("resident provider identity is no longer constrained to the original four names", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20260813010000_freeform_resident_provider_slug.sql", import.meta.url), "utf8");
  assert.match(sql, /drop constraint if exists resident_instances_provider_check/i);
  assert.match(sql, /drop constraint if exists resident_provider_authorizations_provider_check/i);
  assert.match(sql, /drop constraint if exists launch_grants_provider_check/i);
  assert.equal((sql.match(/provider_slug_check/g) ?? []).length, 3);
  assert.match(sql, /\^\[a-z0-9\]\(\[a-z0-9-\]\{0,38\}\[a-z0-9\]\)\?/i);
});
