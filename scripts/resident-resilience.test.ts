import assert from "node:assert/strict";
import test from "node:test";

import { canIssueRequest } from "@/lib/bounded-assistance";
import { updateResidentProfileSequence } from "@/lib/oathlock-resident-core";
import { executeProviderLaunch } from "@/lib/resident-provider-adapters";
import { applyLaunchEvent, checkLaunchClaim } from "@/lib/resident-launch-contract";

const grant = {
  grantId: "grant-resilience-123",
  repositoryRoot: process.cwd(),
  task: "Return a bounded acknowledgement.",
  allowedPaths: ["docs/proof/"],
  prohibitedPaths: ["src/", ".oathlock/"],
  maxDurationMs: 5_000,
  executionMode: "read_only" as const,
};

test("stale resident leases are rejected before claim", () => {
  const result = checkLaunchClaim({ nowMs: Date.parse("2026-07-14T01:00:00Z"), expiresAt: "2026-07-14T01:10:00Z",
    expectedResidentInstanceId: "resident-1", claimingResidentInstanceId: "resident-1", expectedTargetConnectionId: "connection-1",
    claimingTargetConnectionId: "connection-1", expectedProvider: "codex", claimingProvider: "codex",
    residentLeaseExpiresAt: "2026-07-14T00:59:59Z", authorizationActive: true, claimedAt: null });
  assert.equal(result.reason, "resident_offline");
});

test("duplicate claims are rejected deterministically", () => {
  const result = checkLaunchClaim({ nowMs: Date.parse("2026-07-14T01:00:00Z"), expiresAt: "2026-07-14T01:10:00Z",
    expectedResidentInstanceId: "resident-1", claimingResidentInstanceId: "resident-1", expectedTargetConnectionId: "connection-1",
    claimingTargetConnectionId: "connection-1", expectedProvider: "codex", claimingProvider: "codex",
    residentLeaseExpiresAt: "2026-07-14T01:01:00Z", authorizationActive: true, claimedAt: "2026-07-14T00:59:00Z" });
  assert.equal(result.reason, "already_claimed");
});

test("cancellation remains a terminal launch transition", () => {
  assert.equal(applyLaunchEvent("running", "cancel").state, "cancelled");
  assert.equal(applyLaunchEvent("cancelled", "return_result").ok, false);
});

test("provider timeout is retained as timed_out", async () => {
  const events: string[] = [];
  const outcome = await executeProviderLaunch({ provider: "codex", grant, firstSequence: 2 }, { recordEvent: async (event) => { events.push(event.event); },
    runProcess: async (_spec, _timeout, _signal, onSpawn) => { await onSpawn?.(); return { exitCode: null, timedOut: true, cancelled: false, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false }; } });
  assert.equal(outcome.status, "timed_out");
  assert.deepEqual(events, ["launch", "acknowledge_process", "timeout"]);
});

test("provider non-zero exit is retained as provider_failed", async () => {
  const events: string[] = [];
  const outcome = await executeProviderLaunch({ provider: "codex", grant, firstSequence: 2 }, { recordEvent: async (event) => { events.push(event.event); },
    runProcess: async (_spec, _timeout, _signal, onSpawn) => { await onSpawn?.(); return { exitCode: 1, timedOut: false, cancelled: false, stdout: "", stderr: "failed", stdoutTruncated: false, stderrTruncated: false }; } });
  assert.equal(outcome.status, "provider_failed");
  assert.deepEqual(events, ["launch", "acknowledge_process", "fail_provider"]);
});

test("missing model mapping fails one launch visibly instead of killing the resident loop", async () => {
  const events: string[] = [];
  const outcome = await executeProviderLaunch({
    provider: "codex",
    grant: { ...grant, modelTier: "economy" },
    firstSequence: 2,
  }, {
    recordEvent: async (event) => { events.push(event.event); },
    resolveModel: () => { throw new Error("model mapping missing"); },
  });
  assert.equal(outcome.status, "launch_failed");
  assert.deepEqual(events, ["launch", "fail_launch"]);
});

test("reconnect advances the persisted heartbeat without dropping profiles", () => {
  const updated = updateResidentProfileSequence({ profiles: [{ name: "codex", heartbeatSequence: 7 }, { name: "claude", heartbeatSequence: 3 }] }, "codex", 8);
  assert.equal(updated.profiles.length, 2);
  assert.equal(updated.profiles[0].heartbeatSequence, 8);
  assert.equal(updated.profiles[1].heartbeatSequence, 3);
});

test("coordination budget exhaustion blocks another request", () => {
  const result = canIssueRequest({ mode: "coordinated", maxSupportingAgents: 1, maxRequests: 1, maxDelegationDepth: 1,
    maxBriefCharacters: 4_000, maxEstimatedTokensPerRequest: 1_000, requiresHumanApprovalAbove: null, maxRunDurationMs: 60_000 },
    { requestsUsed: 1, supportingAgentsUsed: 0, currentDelegationDepth: 0 });
  assert.equal(result.allowed, false);
  assert.match(result.reason ?? "", /Request count 1 reached/);
});
