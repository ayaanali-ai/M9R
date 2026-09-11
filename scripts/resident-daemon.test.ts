import assert from "node:assert/strict";
import test from "node:test";

import { runResidentCycle, updateResidentProfileSequence, validateResidentProfile } from "@/lib/oathlock-resident-core";
import { buildResidentServicePlan } from "@/lib/resident-service-plan";
import { readFile } from "node:fs/promises";

test("resident profile keeps absolute roots local and validates provider binding", () => {
  const result = validateResidentProfile({
    apiUrl: "https://oathlock.example",
    token: "oak_local_secret_1234567890",
    provider: "codex",
    instanceKey: "codex-resident-01",
    repositoryBindingId: "binding-12345678",
    repositoryRoot: process.cwd(),
    capabilities: ["review"],
    executionMode: "read_only",
  });
  assert.equal(result.ok, true);
  assert.equal(result.profile?.repositoryRoot, process.cwd());
  assert.equal(validateResidentProfile({ ...result.profile, repositoryRoot: "relative/path" }).ok, false);
  // workspace_write is no longer refused outright now that executeProviderLaunch
  // runs it inside a real, disposable git worktree (resident-write-isolation.ts's
  // createGrantWorktree) instead of the real repository -- see
  // resident-provider-adapters.test.ts and oathlock-resident-worktree.test.ts.
  assert.equal(validateResidentProfile({ ...result.profile, executionMode: "workspace_write" }).ok, true);
});

test("one resident cycle registers, heartbeats, claims, and records causal provider events", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
    calls.push({ url, body });
    const json = url.endsWith("/register") ? { residentInstanceId: "resident-1", heartbeatSequence: 7, leaseExpiresAt: "2099-01-01T00:00:00.000Z" }
      : url.endsWith("/heartbeat") ? { sequence: 8, leaseExpiresAt: "2099-01-01T00:00:00.000Z" }
      : url.includes("/claim") ? { accepted: true, sequence: 3 }
      : url.includes("/events") ? { ok: true }
      : { grants: [{
          id: "grant-provider-123", provider: "codex", repository_binding_id: "binding-12345678",
          task: "Review adapter", allowed_paths: ["src/lib"], prohibited_paths: [".env*"],
          max_duration_ms: 30_000, state: "queued",
        }] };
    return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await runResidentCycle({
    apiUrl: "https://oathlock.example",
    token: "oak_local_secret_1234567890",
    provider: "codex",
    instanceKey: "codex-resident-01",
    repositoryBindingId: "binding-12345678",
    repositoryRoot: process.cwd(),
    capabilities: ["review"],
    executionMode: "read_only",
  }, {
    fetch,
    executeLaunch: async (_input, deps) => {
      await deps.recordEvent({ event: "launch", sequence: 4 });
      await deps.recordEvent({ event: "acknowledge_process", sequence: 5 });
      await deps.recordEvent({ event: "return_result", sequence: 6, resultText: "review complete" });
      return { status: "returned", result: null, worktree: null };
    },
  });
  assert.equal(result.claimed, 1);
  assert.equal(result.returned, 1);
  assert.equal(result.heartbeatSequence, 8);
  assert.equal(calls.find((call) => call.url.endsWith("/heartbeat"))?.body?.sequence, 8);
  assert.deepEqual(calls.filter((call) => call.url.includes("/events")).map((call) => call.body?.event), ["launch", "acknowledge_process", "return_result"]);
  assert.ok(!JSON.stringify(calls).includes(process.cwd()), "absolute local root must never be sent to OathLock");
});

test("resident renews its lease while a provider task is still running", async () => {
  const heartbeatSequences: number[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
    if (url.endsWith("/heartbeat") && typeof body?.sequence === "number") heartbeatSequences.push(body.sequence);
    const json = url.endsWith("/register") ? { residentInstanceId: "resident-long-task", heartbeatSequence: 1 }
      : url.endsWith("/heartbeat") ? { sequence: body?.sequence ?? 0 }
        : url.includes("/claim") ? { accepted: true, sequence: 3 }
          : url.includes("/events") ? { ok: true }
            : { grants: [{ id: "grant-long-task", provider: "codex", repository_binding_id: "binding-12345678", task: "Long review", allowed_paths: ["src/lib"], prohibited_paths: [".env*"], max_duration_ms: 30_000, state: "queued" }] };
    return new Response(JSON.stringify(json), { status: 200 });
  };
  const result = await runResidentCycle({
    apiUrl: "https://oathlock.example",
    token: "oak_local_secret_1234567890",
    provider: "codex",
    instanceKey: "codex-long-task",
    repositoryBindingId: "binding-12345678",
    repositoryRoot: process.cwd(),
    capabilities: ["review"],
    executionMode: "read_only",
  }, {
    fetch,
    heartbeatIntervalMs: 2,
    executeLaunch: async () => {
      await new Promise((resolve) => setTimeout(resolve, 12));
      return { status: "returned", result: null, worktree: null };
    },
  });
  assert.ok(heartbeatSequences.length >= 2, "initial and in-task heartbeats should both be sent");
  assert.equal(result.heartbeatSequence, heartbeatSequences.at(-1));
});

test("resident ignores grants for another local binding without claiming them", async () => {
  let claimed = false;
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/claim")) claimed = true;
    const body = url.endsWith("/register") ? { residentInstanceId: "resident-1" }
      : url.endsWith("/heartbeat") ? { sequence: 1 }
      : url.endsWith("/grants?instance_key=codex-resident-01") ? { grants: [{ id: "grant-other-123", provider: "codex", repository_binding_id: "other-binding", task: "x", allowed_paths: ["src"], prohibited_paths: [], max_duration_ms: 1000 }] }
      : { ok: true };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const profile = validateResidentProfile({ apiUrl: "https://oathlock.example", token: "oak_local_secret_1234567890", provider: "codex", instanceKey: "codex-resident-01", repositoryBindingId: "binding-12345678", repositoryRoot: process.cwd(), capabilities: ["review"], executionMode: "read_only" }).profile!;
  const result = await runResidentCycle(profile, { fetch, executeLaunch: async () => { throw new Error("must not execute"); } });
  assert.equal(result.claimed, 0);
  assert.equal(claimed, false);
});

test("resident persists a monotonic heartbeat without dropping sibling profiles or local credentials", () => {
  const config = {
    profiles: [
      { name: "codex", provider: "codex", token: "codex-local-token", heartbeatSequence: 4 },
      { name: "claude", provider: "claude-code", token: "claude-local-token", heartbeatSequence: 7 },
    ],
  };
  const updated = updateResidentProfileSequence(config, "claude", 8);
  assert.deepEqual(updated, {
    profiles: [
      { name: "codex", provider: "codex", token: "codex-local-token", heartbeatSequence: 4 },
      { name: "claude", provider: "claude-code", token: "claude-local-token", heartbeatSequence: 8 },
    ],
  });
  assert.throws(() => updateResidentProfileSequence(config, "claude", 7), /advance monotonically/);
  assert.throws(() => updateResidentProfileSequence(config, "missing", 9), /not found/);
});

test("resident service plan is explicit, restartable, and never carries a token", () => {
  const plan = buildResidentServicePlan({ profile: "claude-review", workingDirectory: process.cwd(), configFile: ".oathlock/resident.local.json", pollMs: 15_000 });
  assert.deepEqual(plan.command.slice(0, 5), ["oathlock", "resident", "run", "--profile", "claude-review"]);
  assert.equal(plan.restart.policy, "on-failure");
  assert.equal(plan.health.staleAfterSeconds, 90);
  assert.ok(!JSON.stringify(plan).includes("token"));
});

test("distributed CLI exposes a foreground resident command without printing profile secrets", async () => {
  const entry = await readFile(new URL("../scripts/m9r-cli.ts", import.meta.url), "utf8");
  const build = await readFile(new URL("../scripts/build-cli.mjs", import.meta.url), "utf8");
  const readme = await readFile(new URL("../cli/README.md", import.meta.url), "utf8");
  assert.match(entry, /runResidentCli/);
  assert.match(entry, /resident run/);
  assert.match(entry, /resident configure/);
  assert.match(entry, /service-plan/);
  assert.doesNotMatch(entry, /JSON\.stringify\(profile\)|profile\.token\)/);
  assert.match(build, /oathlock-resident-core/);
  assert.match(build, /resident-provider-adapters/);
  assert.match(readme, /m9r resident run/);
  assert.match(readme, /resident\.local\.json/);
  assert.match(readme, /resident service-plan/);
});
