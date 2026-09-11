import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  acceptResidentHeartbeat,
  validateResidentRegistration,
  validateLaunchEventSubmission,
} from "@/lib/resident-service-contract";
import { buildFixtureLaunchSpec, runFixtureLaunch } from "@/lib/resident-local-runtime";

test("resident registration is bounded and tied to the authenticated provider", () => {
  const accepted = validateResidentRegistration({
    instanceKey: "codex-resident-01",
    protocolVersion: "oathlock.resident-launch.v1",
    provider: "codex",
    capabilities: ["review", "tests", "review"],
  }, "codex");
  assert.equal(accepted.ok, true);
  assert.deepEqual(accepted.registration?.capabilities, ["review", "tests"]);

  assert.equal(validateResidentRegistration({
    instanceKey: "codex-resident-01",
    protocolVersion: "oathlock.resident-launch.v1",
    provider: "claude-code",
    capabilities: [],
  }, "codex").reason, "provider_mismatch");
});

test("resident heartbeat renews a short lease and rejects replay", () => {
  const accepted = acceptResidentHeartbeat({ sequence: 4 }, {
    now: "2026-07-13T21:00:00.000Z",
    previousSequence: 3,
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.leaseExpiresAt, "2026-07-13T21:01:30.000Z");
  assert.equal(acceptResidentHeartbeat({ sequence: 3 }, {
    now: "2026-07-13T21:00:00.000Z",
    previousSequence: 3,
  }).reason, "sequence_not_newer");
});

test("resident event source and sequence are constrained before persistence", () => {
  assert.equal(validateLaunchEventSubmission({ event: "launch", sequence: 3 }, "claimed", 2).ok, true);
  assert.equal(validateLaunchEventSubmission({ event: "authorize", sequence: 3 }, "policy_pending", 2).reason, "event_not_resident_owned");
  assert.equal(validateLaunchEventSubmission({ event: "launch", sequence: 2 }, "claimed", 2).reason, "sequence_not_newer");
  assert.equal(validateLaunchEventSubmission({ event: "acknowledge_process", sequence: 3 }, "claimed", 2).reason, "invalid_transition");
  assert.equal(validateLaunchEventSubmission({ event: "return_result", sequence: 3 }, "running", 2).reason, "invalid_result");
  assert.equal(validateLaunchEventSubmission({ event: "return_result", sequence: 3, resultText: "review complete" }, "running", 2).resultText, "review complete");
});

test("resident return_result event carries real usage the provider CLI reported, never a fabricated 0", () => {
  const withUsage = validateLaunchEventSubmission({
    event: "return_result", sequence: 3, resultText: "review complete",
    usage: { inputTokens: 120, outputTokens: 40, totalTokens: 160, costUsd: 0.02 },
  }, "running", 2);
  assert.deepEqual(withUsage.usage, { inputTokens: 120, outputTokens: 40, totalTokens: 160, costUsd: 0.02 });

  const withoutUsage = validateLaunchEventSubmission({ event: "return_result", sequence: 3, resultText: "review complete" }, "running", 2);
  assert.equal(withoutUsage.usage, null);

  const nonReturnEvent = validateLaunchEventSubmission({
    event: "launch", sequence: 3, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0.01 },
  }, "claimed", 2);
  assert.equal(nonReturnEvent.usage, null);

  const malformedUsage = validateLaunchEventSubmission({
    event: "return_result", sequence: 3, resultText: "review complete",
    usage: { inputTokens: "not a number", outputTokens: -5 },
  }, "running", 2);
  assert.equal(malformedUsage.usage, null);
});

test("resident return_result retains only bounded requested-model metadata", () => {
  const checked = validateLaunchEventSubmission({
    event: "return_result", sequence: 3, resultText: "review complete",
    modelTier: "economy", requestedModel: "haiku",
  }, "running", 2);
  assert.equal(checked.modelTier, "economy");
  assert.equal(checked.requestedModel, "haiku");

  const invalid = validateLaunchEventSubmission({
    event: "return_result", sequence: 3, resultText: "review complete",
    modelTier: "unknown", requestedModel: "x".repeat(201),
  }, "running", 2);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, "invalid_model_metadata");
});

test("resident accepts a token budget failure as a provider-owned terminal event", () => {
  const checked = validateLaunchEventSubmission({
    event: "fail_provider",
    sequence: 3,
    failureCode: "token_budget_exceeded",
  }, "running", 2);
  assert.equal(checked.ok, true);
  assert.equal(checked.failureCode, "token_budget_exceeded");
  assert.equal(checked.nextState, "provider_failed");
});

test("resident failure events persist a bounded failure code instead of being rejected as a non-empty payload", () => {
  const sql = readFileSync("supabase/migrations/20260718150000_enforce_resident_token_budget.sql", "utf8");
  assert.match(sql, /p_event_type in \('fail_launch', 'fail_provider', 'timeout'\)/i);
  assert.match(sql, /p_payload \? 'failure_code'/i);
  assert.match(sql, /token_budget_exceeded/i);
});

test("Gate 12 migration retains the selected model tier on launch grants", () => {
  const sql = readFileSync("supabase/migrations/20260716230000_gate12_model_tier_execution.sql", "utf8");
  assert.match(sql, /add column if not exists model_tier text/i);
  assert.match(sql, /create_resident_launch_grant_v2_atomic/i);
  assert.match(sql, /check \(model_tier in \('economy', 'balanced', 'frontier'\)\)/i);
});

test("Gate 11C exposes bearer-authenticated resident routes and no client workspace identity", async () => {
  const routePaths = [
    "../src/app/api/agent/resident/register/route.ts",
    "../src/app/api/agent/resident/heartbeat/route.ts",
    "../src/app/api/agent/resident/grants/route.ts",
    "../src/app/api/agent/resident/grants/[id]/claim/route.ts",
    "../src/app/api/agent/resident/grants/[id]/events/route.ts",
  ];
  for (const path of routePaths) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    assert.match(source, /authenticateAgent\(bearerFrom\(req\.headers\.get\("authorization"\)\)\)/);
    assert.doesNotMatch(source, /body\.workspaceId|body\.connectionId|body\.workspace_id|body\.connection_id/);
  }
});

test("claim and event transitions are atomic database operations with least privilege", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20260713210000_gate11a_resident_launch.sql", import.meta.url), "utf8");
  assert.match(sql, /heartbeat_sequence/);
  assert.match(sql, /create or replace function public\.claim_resident_launch_grant_atomic/i);
  assert.match(sql, /for update/i);
  assert.match(sql, /state = 'claimed'/i);
  assert.match(sql, /create or replace function public\.record_resident_launch_event_atomic/i);
  assert.match(sql, /revoke all on function public\.claim_resident_launch_grant_atomic/i);
  assert.match(sql, /grant execute on function public\.claim_resident_launch_grant_atomic[\s\S]+service_role/i);
  assert.doesNotMatch(sql, /grant execute on function public\.claim_resident_launch_grant_atomic[^\n]+to (?:anon|authenticated)/i);
});

test("cloud resident records never contain an absolute local repository path or provider secret", async () => {
  const service = await readFile(new URL("../src/lib/resident-service.ts", import.meta.url), "utf8");
  assert.doesNotMatch(service, /repositoryRoot|absolutePath|providerApiKey|providerToken/);
  assert.match(service, /repository_binding_id/);
  assert.match(service, /claim_resident_launch_grant_atomic/);
  assert.match(service, /record_resident_launch_event_atomic/);
});

test("local fixture launch uses argv without a shell and stays inside its authorized repository", async () => {
  const spec = buildFixtureLaunchSpec({
    repositoryRoot: process.cwd(),
    workingDirectory: ".",
    grantId: "grant-fixture-123",
    task: "Return a harmless resident acknowledgement.",
  });
  assert.equal(spec.shell, false);
  assert.equal(spec.cwd, process.cwd());
  assert.equal(spec.args[0], "-e");
  assert.deepEqual(Object.keys(spec.env).sort(), ["NODE_ENV", ...["NO_COLOR", "PATH", "SystemRoot", "TEMP", "TMP"].filter((key) => process.env[key] !== undefined)].sort());
  assert.throws(() => buildFixtureLaunchSpec({
    repositoryRoot: process.cwd(),
    workingDirectory: "..",
    grantId: "grant-fixture-123",
    task: "Escape attempt",
  }), /authorized repository/);

  const result = await runFixtureLaunch(spec, 5_000);
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.match(result.stdout, /"kind":"oathlock\.resident-fixture\.v1"/);
  assert.match(result.stdout, /"grantId":"grant-fixture-123"/);
});
