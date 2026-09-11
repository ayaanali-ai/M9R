import test from "node:test";
import assert from "node:assert/strict";

import { run, localPath, runPath, type CliDeps } from "../src/lib/oathlock-cli-core.ts";

const CWD = "/repo";

function response(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

function harness(router: (url: string, init?: RequestInit) => ReturnType<typeof response>) {
  const token = "oak_coordinate_secret";
  const files = new Map<string, string>([
    [localPath(CWD), JSON.stringify({ token })],
    [runPath(CWD), JSON.stringify({ run_id: "run-1" })],
  ]);
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    cwd: CWD,
    env: {},
    fetch: (async (url: string | URL, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return router(String(url), init);
    }) as unknown as typeof fetch,
    readFile: async (path) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`ENOENT: ${path}`);
      return value;
    },
    writeFile: async (path, value) => { files.set(path, value); },
    mkdir: async () => {},
    fileExists: async (path) => files.has(path),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  return { deps, requests, out, err, token };
}

test("coordinate request sends one bounded request for the active per-agent run", async () => {
  const h = harness(() => response(200, {
    dispatch_id: "dispatch-1",
    routing_status: "queued",
    task_route: { model_tier: "economy", provider_preference: "claude-code", max_estimated_tokens: 4000 },
  }));

  const code = await run([
    "coordinate", "request", "--type", "check", "--need", "Audit the auth diff",
    "--intent", "independent_assurance", "--criteria", "focused tests pass",
    "--binding", "repo-binding-1", "--allow", "src/auth/**", "--deny", ".env",
    "--capability", "security-review", "--max-tokens", "4000",
    "--max-duration-ms", "120000", "--max-latency-ms", "180000",
  ], h.deps);

  assert.equal(code, 0);
  assert.match(h.requests[0].url, /\/api\/agent\/runs\/run-1\/request-help$/);
  const body = JSON.parse(String(h.requests[0].init?.body));
  assert.deepEqual(body, {
    type: "CHECK_REQUESTED",
    need: "Audit the auth diff",
    coordination_intent: "independent_assurance",
    objective_success_criteria: ["focused tests pass"],
    repository_binding_id: "repo-binding-1",
    required_capabilities: ["security-review"],
    allowed_paths: ["src/auth/**"],
    prohibited_paths: [".env"],
    max_estimated_tokens: 4000,
    max_duration_ms: 120000,
    max_added_latency_ms: 180000,
    preferred_provider: null,
  });
  assert.match(h.out.join("\n"), /dispatch-1/);
});

test("coordinate request sends an explicit --preferred-provider instead of leaving it to the server's classifier/tie-break", async () => {
  // Reproduces the 2026-07-19 demo bug: with no explicit target, the value
  // gate's provider preference falls back to a task-text classifier, then a
  // load/alphabetical tie-break across every resident authorized for the
  // binding -- including a stale/unrelated one -- and a Codex-to-Claude
  // request landed on Grok Build instead. An explicit flag removes the guess.
  const h = harness(() => response(200, {
    dispatch_id: "dispatch-2",
    routing_status: "queued",
    task_route: { model_tier: "economy", provider_preference: "claude-code", max_estimated_tokens: 4000 },
  }));

  const code = await run([
    "coordinate", "request", "--type", "check", "--need", "Review the Watchfloor UX",
    "--intent", "independent_assurance", "--criteria", "one safe recommendation",
    "--binding", "repo-binding-1", "--allow", "src/**", "--deny", ".env",
    "--capability", "design-review", "--max-tokens", "4000",
    "--max-duration-ms", "60000", "--max-latency-ms", "120000",
    "--preferred-provider", "claude-code",
  ], h.deps);

  assert.equal(code, 0);
  const body = JSON.parse(String(h.requests[0].init?.body));
  assert.equal(body.preferred_provider, "claude-code");
});

test("coordinate request rejects a malformed --preferred-provider before any network call", async () => {
  const h = harness(() => response(500, {}));
  const code = await run([
    "coordinate", "request", "--type", "check", "--need", "Review the Watchfloor UX",
    "--intent", "independent_assurance", "--criteria", "one safe recommendation",
    "--binding", "repo-binding-1", "--allow", "src/**", "--deny", ".env",
    "--capability", "design-review", "--max-tokens", "4000",
    "--max-duration-ms", "60000", "--max-latency-ms", "120000",
    "--preferred-provider", "grok_3000",
  ], h.deps);
  assert.equal(code, 1);
  assert.equal(h.requests.length, 0);
  assert.match(h.err.join("\n"), /--preferred-provider must be a lowercase provider slug/);
});

test("coordinate request fails closed before network when a bound is missing", async () => {
  const h = harness(() => response(500, {}));
  const code = await run(["coordinate", "request", "--type", "help", "--need", "do work"], h.deps);
  assert.equal(code, 1);
  assert.equal(h.requests.length, 0);
  assert.match(h.err.join("\n"), /requires.*intent.*criteria.*binding.*allow.*deny.*capability.*max-tokens.*max-duration-ms.*max-latency-ms/i);
});

test("coordinate request explains when a live resident still needs owner authorization", async () => {
  const h = harness(() => response(200, {
    dispatch_id: "dispatch-unrouted",
    routing_status: "no_eligible_resident",
    routing: { status: "no_eligible_resident", routingReason: "no_eligible_resident" },
  }));

  const code = await run([
    "coordinate", "request", "--type", "check", "--need", "Review the demo",
    "--intent", "independent_assurance", "--criteria", "one blocker identified",
    "--binding", "binding-gate11e-readonly", "--allow", "docs/", "--deny", ".oathlock/",
    "--capability", "review", "--max-tokens", "1200",
    "--max-duration-ms", "120000", "--max-latency-ms", "150000",
  ], h.deps);

  assert.equal(code, 0);
  const rendered = h.out.join("\n");
  assert.match(rendered, /reason: no_eligible_resident/);
  assert.match(rendered, /authorize a live resident/i);
  assert.match(rendered, /binding-gate11e-readonly/);
});

test("coordinate results lists only returned results for the active run", async () => {
  const h = harness(() => response(200, { results: [{
    launch_grant_id: "grant-1", provider: "claude-code", model_tier: "economy",
    requested_model: "haiku", reported_model: null, result_text: "Focused tests pass.",
    usage: { totalTokens: 812 }, returned_at: "2026-07-16T00:00:00.000Z",
  }] }));
  assert.equal(await run(["coordinate", "results"], h.deps), 0);
  assert.match(h.requests[0].url, /\/api\/agent\/runs\/run-1\/results$/);
  const rendered = h.out.join("\n");
  assert.match(rendered, /grant-1/);
  assert.match(rendered, /requested model: haiku/);
  assert.match(rendered, /provider-reported model: unknown/);
  assert.match(rendered, /812/);
});

test("coordinate decide records an explicit adoption decision without leaking the token", async () => {
  const h = harness(() => response(201, { adoption: { id: "adoption-1", decision: "adopted" } }));
  const code = await run([
    "coordinate", "decide", "grant-1", "--decision", "adopted",
    "--rationale", "Focused tests passed", "--plan-effect", "Use the reviewed boundaries",
  ], h.deps);
  assert.equal(code, 0);
  assert.match(h.requests[0].url, /\/api\/agent\/runs\/run-1\/adopt-result$/);
  assert.deepEqual(JSON.parse(String(h.requests[0].init?.body)), {
    launch_grant_id: "grant-1",
    decision: "adopted",
    rationale: "Focused tests passed",
    plan_effect: "Use the reviewed boundaries",
  });
  assert.ok(!`${h.out.join("\n")}\n${h.err.join("\n")}`.includes(h.token));
});
