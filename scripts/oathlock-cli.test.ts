/**
 * M9R CLI v0 — unit tests
 * ----------------------------------------------------------------------------
 * Exercises the testable CLI core with an in-memory filesystem and a fake fetch
 * (no real network, no repo writes). Covers the human-approval gate, local file
 * persistence, Bearer auth, doctor's clean failure without a token, and the
 * guarantee that token values never leak into error output.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import {
  run,
  inferSessionFormat,
  apiBase,
  maskToken,
  localPath,
  agentLocalPath,
  configPath,
  agentConfigPath,
  rulesPath,
  extractLoadedRules,
  parseLocalJson,
  resolveAgentKind,
  type CliDeps,
} from "../src/lib/oathlock-cli-core.ts";

const BOM = String.fromCharCode(0xfeff);

const CWD = "/repo";

interface FakeResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

function jsonResponse(status: number, body: unknown): FakeResponse {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

type Router = (url: string, init?: RequestInit) => FakeResponse;

function makeDeps(opts: {
  env?: Record<string, string | undefined>;
  router?: Router;
  files?: Record<string, string>;
  probeVersion?: (binary: string) => Promise<string | null>;
  drainCapture?: () => Promise<{ drained: number; failed: number }>;
}) {
  const files = new Map<string, string>(Object.entries(opts.files ?? {}));
  const out: string[] = [];
  const err: string[] = [];
  const requests: Array<{ url: string; init?: RequestInit }> = [];

  const router: Router = opts.router ?? (() => jsonResponse(500, { error: "no router" }));

  const deps: CliDeps = {
    cwd: CWD,
    env: opts.env ?? {},
    fetch: (async (url: string | URL, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return router(String(url), init);
    }) as unknown as typeof fetch,
    readFile: async (p) => {
      if (files.has(p)) return files.get(p)!;
      throw new Error(`ENOENT: ${p}`);
    },
    writeFile: async (p, data) => {
      files.set(p, data);
    },
    removeFile: async (p) => {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
      files.delete(p);
    },
    mkdir: async () => {},
    fileExists: async (p) => files.has(p),
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    pollIntervalMs: 0,
    maxPolls: 3,
    sleep: async () => {},
    probeVersion: opts.probeVersion,
    drainCapture: opts.drainCapture,
  };

  return { deps, files, out, err, requests };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("inferSessionFormat maps extensions to API formats", () => {
  assert.equal(inferSessionFormat("oathlock-session.md"), "markdown_export");
  assert.equal(inferSessionFormat("trace.json"), "json");
  assert.equal(inferSessionFormat("trace.jsonl"), "jsonl");
  assert.equal(inferSessionFormat("run.txt"), "text_log");
  assert.equal(inferSessionFormat("run.log"), "text_log");
  assert.equal(inferSessionFormat("session.weird"), "text_log");
});

test("apiBase honors OATHLOCK_API_URL and defaults to the M9R production API", () => {
  assert.equal(apiBase({}), "https://app.m9r.workers.dev");
  assert.equal(apiBase({ OATHLOCK_API_URL: "http://localhost:3000/" }), "http://localhost:3000");
});

test("maskToken never reveals the full token", () => {
  const masked = maskToken("m9r_supersecretvalue1234");
  assert.equal(masked, "m9r_…1234");
  assert.ok(!masked.includes("supersecret"));
});

// ---------------------------------------------------------------------------
// submit-session: human-approval gate
// ---------------------------------------------------------------------------

test("submit-session without --approved lands honestly as UNREVIEWED agent evidence", async () => {
  const sessionPath = join(CWD, "oathlock-session.md");
  const { deps, requests, out } = makeDeps({
    env: { OATHLOCK_API_URL: "http://localhost:3000" },
    files: {
      [localPath(CWD)]: JSON.stringify({ token: "oak_x" }),
      [sessionPath]: "# session\nredacted content",
    },
    router: () => jsonResponse(200, { report_id: "r1", rule_health: { evaluated: false, items: [] } }),
  });

  const code = await run(["submit-session", "oathlock-session.md"], deps);

  assert.equal(code, 0);
  const body = JSON.parse(String(requests[0]?.init?.body ?? "{}"));
  assert.equal(body.human_approved_submission, false, "must never claim human approval it does not have");
  assert.equal(body.redaction_status, "agent_submitted");
  assert.match(out.join("\n"), /UNREVIEWED/);
});

test("submit-session with --approved sends approval + human_reviewed redaction", async () => {
  const sessionPath = join(CWD, "oathlock-session.md");
  const { deps, requests, out } = makeDeps({
    env: { OATHLOCK_API_URL: "http://localhost:3000" },
    files: {
      [localPath(CWD)]: JSON.stringify({ token: "oak_tok_999" }),
      [sessionPath]: "# session\nsome redacted content",
    },
    router: () =>
      jsonResponse(200, {
        ok: true,
        source_quality: "good",
        parser_confidence: {
          confidence: "high",
          reason: "Structured turns and commands detected.",
          turnsDetected: 12,
          commandsDetected: 5,
          filesEdited: 3,
          usageFieldsDetected: true,
        },
        findings_count: 2,
        rules: { recommended: true, activeCount: 0, needsReviewCount: 2, message: "2 rule candidates for review." },
        next_step: "Review in dashboard.",
      }),
  });

  const code = await run(["submit-session", "oathlock-session.md", "--approved"], deps);

  assert.equal(code, 0);
  assert.equal(requests.length, 1);
  const body = JSON.parse(String(requests[0].init!.body));
  assert.equal(body.human_approved_submission, true);
  assert.equal(body.redaction_status, "human_reviewed");
  assert.equal(body.session_format, "markdown_export");

  const text = out.join("\n");
  assert.ok(!text.includes("[object Object]"), "parser_confidence must be rendered, not stringified");
  assert.match(text, /parser_confidence: high/);
  assert.match(text, /parser_reason: Structured turns and commands detected\./);
  assert.match(text, /turns_detected: 12/);
  assert.match(text, /commands_detected: 5/);
  assert.match(text, /files_edited: 3/);
  assert.match(text, /usage_fields_detected: true/);
  assert.match(text, /findings_count: 2/);
  assert.match(text, /rule candidates: 2 for review/);
  assert.match(text, /new recommended rules for review: 2/);
  assert.match(text, /rules message: 2 rule candidates for review\./);
  // Rules are never auto-activated; the dangerous "auto-recommended active" copy
  // must not reappear.
  assert.ok(!/auto-recommended active/.test(text));
  assert.ok(!/rule recommendation: recommended/.test(text));
});

test("submit-session sends an approved structured Evidence Contract and prints its record id", async () => {
  const sessionPath = join(CWD, "oathlock-session.md");
  const contractPath = join(CWD, "evidence-contract.json");
  const contract = {
    schemaVersion: "oathlock.evidence.v1",
    task: { requested: "Verify the bounded runbook", scope_changes: [] },
    changes: [],
    verification: [
      {
        command: "sha256sum docs/proof/runbook.md",
        result: "passed",
        exit_code: 0,
        source: "agent_recorded",
        observed_at: "2026-07-13T12:00:00.000Z",
        artifact_digest: `sha256:${"a".repeat(64)}`,
      },
    ],
    failed_commands: [],
    limitations: [],
    sensitive_areas: [],
  };
  const { deps, requests, out } = makeDeps({
    files: {
      [localPath(CWD)]: JSON.stringify({ token: "oak_contract" }),
      [sessionPath]: "Approved evidence draft",
      [contractPath]: JSON.stringify(contract),
    },
    router: () =>
      jsonResponse(200, {
        ok: true,
        source_quality: "good",
        findings_count: 0,
        rules: { needsReviewCount: 0, ruleLikeFindingsCount: 0 },
        evidence_contract_id: "evidence-123",
      }),
  });

  const code = await run(
    ["submit-session", "oathlock-session.md", "--approved", "--evidence-contract", "evidence-contract.json"],
    deps,
  );

  assert.equal(code, 0);
  assert.equal(requests.length, 1);
  const body = JSON.parse(String(requests[0].init!.body));
  assert.deepEqual(body.evidence_contract, contract);
  assert.match(out.join("\n"), /evidence contract id: evidence-123/);
});

test("submit-session rejects an invalid Evidence Contract before contacting the API", async () => {
  const { deps, requests, err } = makeDeps({
    files: {
      [localPath(CWD)]: JSON.stringify({ token: "oak_contract" }),
      [join(CWD, "oathlock-session.md")]: "Approved evidence draft",
      [join(CWD, "evidence-contract.json")]: "{not-json",
    },
  });

  const code = await run(
    ["submit-session", "oathlock-session.md", "--approved", "--evidence-contract", "evidence-contract.json"],
    deps,
  );

  assert.equal(code, 1);
  assert.equal(requests.length, 0);
  assert.match(err.join("\n"), /Evidence Contract.*valid JSON/i);
});

test("explicit agent kind may confirm but cannot contradict detected runtime identity", () => {
  assert.deepEqual(resolveAgentKind("codex", { CODEX_HOME: "1" }), { kind: "codex" });
  assert.match(resolveAgentKind("claude-code", { CODEX_HOME: "1" }).error ?? "", /runtime identifies as codex/i);
  assert.match(resolveAgentKind("codex", { CLAUDE_CODE: "1" }).error ?? "", /runtime identifies as claude-code/i);
  assert.deepEqual(resolveAgentKind("claude-code", {}), { kind: "claude-code" });
  assert.deepEqual(resolveAgentKind("skynet", {}), { kind: "skynet" });
  assert.match(resolveAgentKind("Skynet Prime!", {}).error ?? "", /lowercase letters, numbers, and hyphens/i);
  assert.match(resolveAgentKind(undefined, {}).error ?? "", /--agent-kind/i);
});

test("a detected Codex runtime never falls back to the shared legacy token profile", async () => {
  const { deps, requests, err } = makeDeps({
    env: { CODEX_HOME: "1" },
    files: {
      [localPath(CWD)]: JSON.stringify({ token: "oak_opencode_token_must_not_be_used" }),
      [configPath(CWD)]: JSON.stringify({ agent_kind: "opencode" }),
    },
    router: () => jsonResponse(500, { error: "the shared profile must not be contacted" }),
  });

  const code = await run(["whoami"], deps);

  assert.equal(code, 1);
  assert.equal(requests.length, 0, "Codex must fail closed when its own profile is missing");
  assert.match(err.join("\n"), /profile.*codex|reconnect/i);
  assert.ok(!err.join("\n").includes("oak_opencode_token"));
});

test("whoami refuses a provider-token mismatch instead of letting runs be misattributed", async () => {
  const { deps, requests, err } = makeDeps({
    env: { CODEX_HOME: "1" },
    files: {
      [agentLocalPath(CWD, "codex")]: JSON.stringify({ token: "oak_codex_token_1234" }),
    },
    router: (url) => url.includes("/api/agent/whoami")
      ? jsonResponse(200, { agentKind: "opencode", workspaceId: "workspace-1", connectionId: "connection-1" })
      : jsonResponse(404, { error: "unexpected route" }),
  });

  const code = await run(["whoami"], deps);

  assert.equal(code, 1);
  assert.equal(requests.length, 1);
  assert.match(err.join("\n"), /identity mismatch.*codex.*opencode/i);
  assert.ok(!err.join("\n").includes("oak_codex_token_1234"));
});

test("whoami reports the authenticated provider when the scoped profile matches", async () => {
  const { deps, out } = makeDeps({
    env: { CODEX_HOME: "1" },
    files: {
      [agentLocalPath(CWD, "codex")]: JSON.stringify({ token: "oak_codex_token_5678" }),
    },
    router: (url) => url.includes("/api/agent/whoami")
      ? jsonResponse(200, { agentKind: "codex", workspaceId: "workspace-1", connectionId: "connection-1" })
      : jsonResponse(404, { error: "unexpected route" }),
  });

  const code = await run(["whoami"], deps);

  assert.equal(code, 0);
  assert.match(out.join("\n"), /authenticated agent: Codex \(codex\)/i);
});

test("Codex and Claude Code use isolated local identity profiles in one repository", () => {
  assert.equal(agentLocalPath(CWD, "codex"), join(CWD, ".oathlock", "agents", "codex", "local.json"));
  assert.equal(agentLocalPath(CWD, "claude-code"), join(CWD, ".oathlock", "agents", "claude-code", "local.json"));
  assert.notEqual(agentLocalPath(CWD, "codex"), agentLocalPath(CWD, "claude-code"));
  assert.notEqual(agentConfigPath(CWD, "codex"), agentConfigPath(CWD, "claude-code"));
});

test("submit-session cannot print conflicting candidate and recommended counts", async () => {
  const sessionPath = join(CWD, "oathlock-session.md");
  const { deps, out } = makeDeps({
    files: {
      [localPath(CWD)]: JSON.stringify({ token: "oak_tok_counts" }),
      [sessionPath]: "# session",
    },
    router: () =>
      jsonResponse(200, {
        ok: true,
        source_quality: "good",
        parser_confidence: { confidence: "high" },
        findings_count: 2,
        rules: {
          recommended: true,
          activeCount: 2,
          needsReviewCount: 0,
          ruleLikeFindingsCount: 2,
          message: "2 rule(s) recommended.",
        },
      }),
  });

  const code = await run(["submit-session", "--approved", "--file", "oathlock-session.md"], deps);
  const text = out.join("\n");

  assert.equal(code, 0);
  assert.match(text, /rule candidates: 0 for review/);
  assert.match(text, /rule-like findings: 2/);
  assert.match(text, /new recommended rules for review: 0/);
  assert.match(
    text,
    /rules message: No new rule candidates were created\. Rule-like findings were kept as findings only; review the active rule health before promoting anything\./,
  );
  assert.ok(!/rules message: 2 rule\(s\) recommended\./.test(text));
  assert.ok(!/new recommended rules for review: 2/.test(text));
  assert.ok(!/auto-recommended active/.test(text));
});

test("submit-session prints zero-candidate no-generated-rules message", async () => {
  const sessionPath = join(CWD, "oathlock-session.md");
  const { deps, out } = makeDeps({
    files: {
      [localPath(CWD)]: JSON.stringify({ token: "oak_tok_zero_msg" }),
      [sessionPath]: "# session",
    },
    router: () =>
      jsonResponse(200, {
        ok: true,
        source_quality: "good",
        parser_confidence: { confidence: "high" },
        findings_count: 0,
        rules: {
          recommended: false,
          activeCount: 0,
          needsReviewCount: 0,
          ruleLikeFindingsCount: 0,
          message: "No new workspace rule recommended from this session.",
        },
      }),
  });

  const code = await run(["submit-session", "--approved", "--file", "oathlock-session.md"], deps);
  const text = out.join("\n");

  assert.equal(code, 0);
  assert.match(text, /rule candidates: 0 for review/);
  assert.match(text, /new recommended rules for review: 0/);
  assert.match(text, /rules message: No new rule candidates were created from this session\./);
  assert.ok(!/recommended|active|auto|generated active|proved|guaranteed|caused|worked/i.test(text.match(/^rules message:.*$/m)?.[0] ?? ""));
});

test("submit-session prints singular candidate message", async () => {
  const sessionPath = join(CWD, "oathlock-session.md");
  const { deps, out } = makeDeps({
    files: {
      [localPath(CWD)]: JSON.stringify({ token: "oak_tok_one_msg" }),
      [sessionPath]: "# session",
    },
    router: () =>
      jsonResponse(200, {
        ok: true,
        source_quality: "good",
        parser_confidence: { confidence: "high" },
        findings_count: 1,
        rules: {
          recommended: true,
          activeCount: 0,
          needsReviewCount: 1,
          ruleLikeFindingsCount: 0,
          message: "1 rule(s) recommended.",
        },
      }),
  });

  const code = await run(["submit-session", "--approved", "--file", "oathlock-session.md"], deps);
  const text = out.join("\n");

  assert.equal(code, 0);
  assert.match(text, /rule candidates: 1 for review/);
  assert.match(text, /rules message: 1 rule candidate for review\./);
  assert.ok(!/rules message: 1 rule\(s\) recommended\./.test(text));
  assert.ok(!/active|auto|generated active|proved|guaranteed|caused|worked/i.test(text.match(/^rules message:.*$/m)?.[0] ?? ""));
});

test("extractLoadedRules handles both saved response shapes", () => {
  assert.equal(extractLoadedRules({ rules: [{ id: "a" }, { id: "b" }] }).length, 2);
  assert.equal(extractLoadedRules({ rules: { items: [{ id: "c" }] } }).length, 1);
  assert.equal(extractLoadedRules([{ id: "d" }]).length, 1);
  assert.deepEqual(extractLoadedRules({ rules: [] }), []);
  assert.deepEqual(extractLoadedRules(null), []);
  assert.deepEqual(extractLoadedRules({ mode: "baseline" }), []);
});

test("submit-session reads .oathlock/rules.json and sends rules_loaded", async () => {
  const sessionPath = join(CWD, "oathlock-session.md");
  const savedRules = {
    mode: "active",
    rules: [
      { id: "r1", title: "Inspect root cause before re-editing", rule_type: "edit_thrash_prevention" },
      { id: "r2", title: "Read each file once", rule_type: "context_control" },
    ],
  };
  const { deps, requests } = makeDeps({
    files: {
      [localPath(CWD)]: JSON.stringify({ token: "oak_tok_rl" }),
      [rulesPath(CWD)]: JSON.stringify(savedRules),
      [sessionPath]: "# session",
    },
    router: () => jsonResponse(200, { ok: true, rules: { recommended: false } }),
  });

  const code = await run(["submit-session", "oathlock-session.md", "--approved"], deps);
  assert.equal(code, 0);

  const body = JSON.parse(String(requests[0].init!.body));
  assert.equal(body.rules_loaded.length, 2);
  assert.equal(body.rules_loaded[0].id, "r1");
  assert.equal(body.rules_loaded[1].rule_type, "context_control");
  assert.deepEqual(body.rules_followed, []);
  assert.deepEqual(body.rules_violated, []);
});

test("submit-session sends rules_loaded:[] when rules.json is missing", async () => {
  const sessionPath = join(CWD, "oathlock-session.md");
  const { deps, requests } = makeDeps({
    files: {
      [localPath(CWD)]: JSON.stringify({ token: "oak_tok_nofile" }),
      [sessionPath]: "# session",
    },
    router: () => jsonResponse(200, { ok: true, rules: {} }),
  });

  const code = await run(["submit-session", "oathlock-session.md", "--approved"], deps);
  assert.equal(code, 0);

  const body = JSON.parse(String(requests[0].init!.body));
  assert.deepEqual(body.rules_loaded, []);
});

test("submit-session falls back to rules_loaded:[] on invalid rules.json without leaking token", async () => {
  const TOKEN = "oak_tok_INVALID_5555";
  const sessionPath = join(CWD, "oathlock-session.md");
  const { deps, requests, out, err } = makeDeps({
    files: {
      [localPath(CWD)]: JSON.stringify({ token: TOKEN }),
      [rulesPath(CWD)]: "{ this is not valid json",
      [sessionPath]: "# session",
    },
    router: () => jsonResponse(200, { ok: true, rules: {} }),
  });

  const code = await run(["submit-session", "oathlock-session.md", "--approved"], deps);
  assert.equal(code, 0);

  const body = JSON.parse(String(requests[0].init!.body));
  assert.deepEqual(body.rules_loaded, []);
  assert.ok(!out.join("\n").includes(TOKEN), "token must not leak to stdout");
  assert.ok(!err.join("\n").includes(TOKEN), "token must not leak to stderr");
});

test("submit-session without --approved still sends loaded rules and an honest false approval flag", async () => {
  const sessionPath = join(CWD, "oathlock-session.md");
  const { deps, requests } = makeDeps({
    env: { OATHLOCK_API_URL: "http://localhost:3000" },
    files: {
      [localPath(CWD)]: JSON.stringify({ token: "oak_x" }),
      [rulesPath(CWD)]: JSON.stringify({ rules: [{ id: "r1" }] }),
      [sessionPath]: "# session",
    },
    router: () => jsonResponse(200, { report_id: "r1", rule_health: { evaluated: false, items: [] } }),
  });

  const code = await run(["submit-session", "oathlock-session.md"], deps);
  assert.equal(code, 0);
  const body = JSON.parse(String(requests[0].init!.body));
  assert.deepEqual(body.rules_loaded, [{ id: "r1" }]);
  assert.equal(body.human_approved_submission, false);
});

test("parseLocalJson strips a leading UTF-8 BOM and returns one loaded rule", () => {
  const withBom = BOM + JSON.stringify({ rules: [{ id: "smoke-edit-thrash" }] });
  const parsed = parseLocalJson(withBom);
  assert.deepEqual(extractLoadedRules(parsed), [{ id: "smoke-edit-thrash" }]);
  // And invalid content still parses to null (safe fallback => [] downstream).
  assert.equal(parseLocalJson("{ not json"), null);
  assert.deepEqual(extractLoadedRules(parseLocalJson("{ not json")), []);
});

test("submit-session: BOM-prefixed rules.json (PowerShell UTF8) prints loaded rules: 1", async () => {
  const sessionPath = join(CWD, "oathlock-session.md");
  const bomRulesJson =
    BOM +
    JSON.stringify({
      rules: [
        {
          id: "smoke-edit-thrash",
          title: "Inspect root cause before re-editing the same file",
          rule_type: "edit_thrash_prevention",
        },
      ],
    });
  const { deps, requests, out } = makeDeps({
    files: {
      [localPath(CWD)]: JSON.stringify({ token: "oak_tok_bom" }),
      [rulesPath(CWD)]: bomRulesJson,
      [sessionPath]: "# session\nsecret session body",
    },
    router: () => jsonResponse(200, { ok: true, rules: {}, rule_health: { evaluated: false } }),
  });

  const code = await run(["submit-session", "oathlock-session.md", "--approved"], deps);
  assert.equal(code, 0);

  const body = JSON.parse(String(requests[0].init!.body));
  assert.equal(body.rules_loaded.length, 1);
  assert.equal(body.rules_loaded[0].id, "smoke-edit-thrash");

  const text = out.join("\n");
  assert.match(text, /loaded rules: 1/);
  assert.ok(!text.includes("oak_tok_bom"), "must not print the token");
  assert.ok(!text.includes("secret session body"), "must not print session contents");
});

test("submit-session: invalid rules.json still falls back to loaded rules: 0 without leaking", async () => {
  const TOKEN = "oak_tok_INVALID_BOM";
  const sessionPath = join(CWD, "oathlock-session.md");
  const { deps, requests, out, err } = makeDeps({
    files: {
      [localPath(CWD)]: JSON.stringify({ token: TOKEN }),
      [rulesPath(CWD)]: BOM + "{ this is : not valid json",
      [sessionPath]: "# session\nsecret body",
    },
    router: () => jsonResponse(200, { ok: true, rules: {}, rule_health: { evaluated: false } }),
  });

  const code = await run(["submit-session", "oathlock-session.md", "--approved"], deps);
  assert.equal(code, 0);

  const body = JSON.parse(String(requests[0].init!.body));
  assert.deepEqual(body.rules_loaded, []);

  const combined = out.join("\n") + err.join("\n");
  assert.match(out.join("\n"), /loaded rules: 0/);
  assert.ok(!combined.includes(TOKEN), "must not leak the token");
  assert.ok(!combined.includes("secret body"), "must not leak session contents");
});

test("submit-session: exact manual rules.json shape => loaded rules:1 + not_applicable block", async () => {
  // The exact file shape from the reported manual smoke.
  const manualRulesJson = JSON.stringify({
    rules: [
      {
        id: "smoke-edit-thrash",
        title: "Inspect root cause before re-editing the same file",
        rule_type: "edit_thrash_prevention",
      },
    ],
  });
  const sessionPath = join(CWD, "oathlock-session.md");
  const { deps, requests, out } = makeDeps({
    files: {
      [localPath(CWD)]: JSON.stringify({ token: "oak_tok_na" }),
      [rulesPath(CWD)]: manualRulesJson,
      [sessionPath]: "# session\nsome text",
    },
    // Mirrors the real production response: evaluated true, only not_applicable.
    router: () =>
      jsonResponse(200, {
        ok: true,
        source_quality: "fair",
        parser_confidence: { confidence: "low" },
        findings_count: 0,
        rules: { recommended: false },
        rule_health: {
          evaluated: true,
          summary: {
            followed: 0,
            violated: 0,
            not_applicable: 1,
            too_vague: 0,
            needs_review: 0,
            obsolete: 0,
          },
          items: [
            {
              rule_id: "smoke-edit-thrash",
              title: "Inspect root cause before re-editing the same file",
              status: "not_applicable",
              evidenceLevel: "Insufficient",
              reason:
                "The session did not touch edit-thrash-related behavior, so the rule could not be evaluated.",
            },
          ],
        },
        next_step: "ok",
      }),
  });

  const code = await run(["submit-session", "oathlock-session.md", "--approved"], deps);
  assert.equal(code, 0);

  // Request actually carried the one loaded rule.
  const body = JSON.parse(String(requests[0].init!.body));
  assert.equal(body.rules_loaded.length, 1);
  assert.equal(body.rules_loaded[0].id, "smoke-edit-thrash");

  const text = out.join("\n");
  assert.match(text, /loaded rules: 1/);
  assert.match(text, /rule health:/);
  assert.match(text, /not_applicable: 1/);
  assert.match(
    text,
    /- not_applicable: Inspect root cause before re-editing the same file — The session did not touch edit-thrash-related behavior/,
  );
  // Debug-safe: no token, no session contents.
  assert.ok(!text.includes("oak_tok_na"), "must not print the token");
  assert.ok(!text.includes("some text"), "must not print session contents");
});

test("submit-session prints loaded rules: 0 when no rules file is present", async () => {
  const sessionPath = join(CWD, "oathlock-session.md");
  const { deps, out } = makeDeps({
    files: {
      [localPath(CWD)]: JSON.stringify({ token: "oak_tok_zero" }),
      [sessionPath]: "# session",
    },
    router: () => jsonResponse(200, { ok: true, rules: {}, rule_health: { evaluated: false } }),
  });

  const code = await run(["submit-session", "oathlock-session.md", "--approved"], deps);
  assert.equal(code, 0);
  assert.match(out.join("\n"), /loaded rules: 0/);
});

test("submit-session prints rule_health summary and per-rule lines when present", async () => {
  const sessionPath = join(CWD, "oathlock-session.md");
  const { deps, out } = makeDeps({
    files: {
      [localPath(CWD)]: JSON.stringify({ token: "oak_tok_rh" }),
      [sessionPath]: "# session",
    },
    router: () =>
      jsonResponse(200, {
        ok: true,
        source_quality: "good",
        parser_confidence: { confidence: "high", reason: "ok" },
        findings_count: 1,
        rules: { recommended: false, message: "no new rules" },
        rule_health: {
          evaluated: true,
          summary: {
            followed: 1,
            violated: 1,
            not_applicable: 0,
            too_vague: 0,
            needs_review: 1,
            obsolete: 0,
          },
          items: [
            { rule_id: "r1", title: "Inspect root cause before re-editing", status: "violated", evidenceLevel: "Observed", reason: "edit-thrash recurred" },
            { rule_id: "r2", title: "Read each file once", status: "followed", evidenceLevel: "Inferred", reason: "no recurrence" },
          ],
        },
        next_step: "Review in dashboard.",
      }),
  });

  const code = await run(["submit-session", "oathlock-session.md", "--approved"], deps);
  assert.equal(code, 0);

  const text = out.join("\n");
  assert.ok(!text.includes("[object Object]"), "rule_health must be rendered, not stringified");
  assert.match(text, /rule health:/);
  assert.match(text, /followed: 1/);
  assert.match(text, /violated: 1/);
  assert.match(text, /needs_review: 1/);
  assert.match(text, /- violated: Inspect root cause before re-editing — edit-thrash recurred/);
  assert.match(text, /- followed: Read each file once — no recurrence/);
});

test("submit-session omits rule health when not evaluated", async () => {
  const sessionPath = join(CWD, "oathlock-session.md");
  const { deps, out } = makeDeps({
    files: {
      [localPath(CWD)]: JSON.stringify({ token: "oak_tok_rh2" }),
      [sessionPath]: "# session",
    },
    router: () =>
      jsonResponse(200, {
        ok: true,
        source_quality: "good",
        parser_confidence: { confidence: "high" },
        findings_count: 0,
        rules: { recommended: false },
        rule_health: { evaluated: false, items: [], summary: {} },
      }),
  });

  const code = await run(["submit-session", "oathlock-session.md", "--approved"], deps);
  assert.equal(code, 0);
  assert.ok(!out.join("\n").includes("rule health:"), "no rule health block when not evaluated");
});

// ---------------------------------------------------------------------------
// init: writes local token + non-secret config to .oathlock
// ---------------------------------------------------------------------------

test("init writes token to local.json and non-secret metadata to config.json", async () => {
  const TOKEN = "oak_issued_TOKEN_abcd";
  const { deps, files } = makeDeps({
    env: { OATHLOCK_API_URL: "http://localhost:3000" },
    router: (url) => {
      if (url.includes("/api/agent/register")) {
        return jsonResponse(201, {
          claim_url: "http://localhost:3000/claim/claim123",
          claim_id: "claim123",
          setup_code: "setup_secret_code",
          expires_at: "2030-01-01T00:00:00Z",
        });
      }
      if (url.includes("/api/agent/claim-status")) {
        return jsonResponse(200, { status: "approved", token: TOKEN, scopes: ["rules:read"] });
      }
      return jsonResponse(404, { error: "nope" });
    },
  });

  const code = await run(["init", "--repo", "me/demo", "--agent-kind", "codex"], deps);

  assert.equal(code, 0);

  const local = JSON.parse(files.get(agentLocalPath(CWD, "codex"))!);
  assert.equal(local.token, TOKEN);
  assert.deepEqual(local.scopes, ["rules:read"]);

  const config = JSON.parse(files.get(agentConfigPath(CWD, "codex"))!);
  assert.equal(config.repo_hint, "me/demo");
  assert.equal(config.api_url, "http://localhost:3000");
  assert.ok(!("token" in config), "config.json must never contain the token");
});

test("init makes .oathlock ignore itself so the token cannot be committed", async () => {
  const { deps, files } = makeDeps({
    env: { OATHLOCK_API_URL: "http://localhost:3000" },
    router: (url) => {
      if (url.includes("/api/agent/register")) return jsonResponse(201, { claim_url: "http://localhost:3000/claim/c1", claim_id: "c1", setup_code: "s", expires_at: "2030-01-01T00:00:00Z" });
      if (url.includes("/api/agent/claim-status")) return jsonResponse(200, { status: "approved", token: "oak_issued_TOKEN_abcd", scopes: [] });
      return jsonResponse(404, { error: "nope" });
    },
  });
  assert.equal(await run(["init", "--repo", "me/demo", "--agent-kind", "codex"], deps), 0);
  const ignore = files.get(join(CWD, ".oathlock", ".gitignore"));
  assert.ok(ignore && /^\*$/m.test(ignore));
});

test("init reuses an existing connection and creates no new claim", async () => {
  const TOKEN = "oak_existing_TOKEN_zzzz";
  const { deps, requests, out } = makeDeps({
    env: { CODEX_HOME: "1", OATHLOCK_API_URL: "http://localhost:3000" },
    files: { [agentLocalPath(CWD, "codex")]: JSON.stringify({ token: TOKEN, scopes: ["rules:read"] }) },
    router: (url) => url.includes("/api/agent/connection-status")
      ? jsonResponse(200, { agentKind: "codex", authenticated: true, lastUsedAt: "2030-01-01T00:00:00Z" })
      : jsonResponse(500, { error: "should not be called" }),
  });

  const code = await run(["init"], deps);

  assert.equal(code, 0);
  assert.equal(requests.length, 1, "reuse must make one read-only server status check");
  assert.match(requests[0].url, /\/api\/agent\/connection-status$/);
  const text = out.join("\n");
  assert.match(text, /connected to M9R/i);
  assert.match(text, /real provider authentication was observed/i);
  assert.match(text, /npx m9r-cli doctor/);
  assert.match(text, /npx m9r-cli rules/);
  assert.match(text, /--force/);
  assert.ok(!text.includes(TOKEN), "must not print the token");
});

test("init does not call an approved token connected until the server observes provider use", async () => {
  const TOKEN = "oak_registered_only_TOKEN_zzzz";
  const { deps, requests, out } = makeDeps({
    env: { CODEX_HOME: "1", OATHLOCK_API_URL: "http://localhost:3000" },
    files: { [agentLocalPath(CWD, "codex")]: JSON.stringify({ token: TOKEN }) },
    router: (url) => url.includes("/api/agent/connection-status")
      ? jsonResponse(200, { agentKind: "codex", authenticated: false, lastUsedAt: null })
      : jsonResponse(500, { error: "should not be called" }),
  });

  const code = await run(["init"], deps);

  assert.equal(code, 0);
  assert.equal(requests.length, 1);
  const text = out.join("\n");
  assert.match(text, /registered with M9R, but no provider process has authenticated/i);
  assert.doesNotMatch(text, /This workspace is connected to M9R\./);
});

test("init fails closed when a saved token is no longer active", async () => {
  const TOKEN = "oak_revoked_TOKEN_zzzz";
  const { deps, requests, err } = makeDeps({
    env: { CODEX_HOME: "1", OATHLOCK_API_URL: "http://localhost:3000" },
    files: { [agentLocalPath(CWD, "codex")]: JSON.stringify({ token: TOKEN }) },
    router: (url) => url.includes("/api/agent/connection-status")
      ? jsonResponse(401, { error: "Invalid or inactive agent token." })
      : jsonResponse(500, { error: "should not be called" }),
  });

  const code = await run(["init"], deps);

  assert.equal(code, 1);
  assert.equal(requests.length, 1, "an inactive token must not silently create a duplicate claim");
  assert.match(err.join("\n"), /could not verify it as active/i);
  assert.match(err.join("\n"), /--force --agent-kind codex/);
});

test("init --force starts a fresh claim even when a token already exists", async () => {
  const NEW_TOKEN = "oak_forced_TOKEN_5678";
  const { deps, requests, files } = makeDeps({
    env: { OATHLOCK_API_URL: "http://localhost:3000" },
    files: { [localPath(CWD)]: JSON.stringify({ token: "oak_old_TOKEN_1111" }) },
    router: (url) => {
      if (url.includes("/api/agent/register")) {
        return jsonResponse(201, {
          claim_url: "http://localhost:3000/claim/forced",
          claim_id: "forced",
          setup_code: "setup_forced",
          expires_at: "2030-01-01T00:00:00Z",
        });
      }
      if (url.includes("/api/agent/claim-status")) {
        return jsonResponse(200, { status: "approved", token: NEW_TOKEN, scopes: ["rules:read"] });
      }
      return jsonResponse(404, { error: "nope" });
    },
  });

  const code = await run(["init", "--force", "--agent-kind", "claude-code"], deps);

  assert.equal(code, 0);
  assert.ok(
    requests.some((r) => r.url.includes("/api/agent/register")),
    "--force must register a new claim",
  );
  assert.equal(JSON.parse(files.get(agentLocalPath(CWD, "claude-code"))!).token, NEW_TOKEN);
});

// ---------------------------------------------------------------------------
// rules: sends Bearer token
// ---------------------------------------------------------------------------

test("rules sends the Bearer token and writes rules.json", async () => {
  const TOKEN = "oak_rules_TOKEN_1234";
  const { deps, requests, files } = makeDeps({
    files: { [localPath(CWD)]: JSON.stringify({ token: TOKEN }) },
    router: () =>
      jsonResponse(200, {
        mode: "baseline",
        message: "No evidence-backed workspace rules exist yet.",
        rules: [],
        operating_instructions: ["Do not upload secrets."],
      }),
  });

  const code = await run(["rules"], deps);

  assert.equal(code, 0);
  assert.equal(requests.length, 1);
  const headers = requests[0].init!.headers as Record<string, string>;
  assert.equal(headers.authorization, `Bearer ${TOKEN}`);
  assert.ok(files.has(join(CWD, ".oathlock", "rules.json")));
});

test("inbox pulls Agent inbox instructions without writing local files", async () => {
  const TOKEN = "oak_inbox_TOKEN_1234";
  const { deps, requests, files, out } = makeDeps({
    files: { [localPath(CWD)]: JSON.stringify({ token: TOKEN }) },
    router: (url) => {
      if (url.includes("/api/agent/inbox")) {
        return jsonResponse(200, {
          ok: true,
          channel: "Agent inbox",
          message: "1 instruction(s) pulled from the Agent inbox.",
          instructions: [
            {
              id: "instruction-123456",
              instruction: "Read the failing test first. token=oak_should_not_print",
              status: "pulled",
              created_at: "2030-01-01T00:00:00Z",
              pulled_at: "2030-01-01T00:00:01Z",
            },
          ],
        });
      }
      if (url.includes("/api/agent/conversations")) {
        return jsonResponse(200, {
          conversations: [{ id: "conversation-abcdefgh", topic: "Task A handoff", status: "open", created_at: "2030-01-01T00:00:00Z" }],
        });
      }
      return jsonResponse(404, { error: "unexpected route" });
    },
  });

  const code = await run(["inbox"], deps);

  assert.equal(code, 0);
  assert.equal(requests.length, 2, "inbox checks both instructions and open conversations");
  assert.match(requests[0].url, /\/api\/agent\/inbox$/);
  assert.match(requests[1].url, /\/api\/agent\/conversations$/);
  assert.equal((requests[0].init!.headers as Record<string, string>).authorization, `Bearer ${TOKEN}`);
  assert.equal(files.size, 1, "inbox should not write local cache files");

  const text = out.join("\n");
  assert.match(text, /Agent inbox/);
  assert.match(text, /instructions: 1/);
  assert.match(text, /Read the failing test first/);
  assert.match(text, /open conversations: 1/);
  assert.match(text, /Task A handoff/);
  assert.ok(!text.includes(TOKEN), "inbox must not print the local token");
  assert.ok(!text.includes("oak_should_not_print"), "inbox must redact token-like instruction text");
});

test("inbox refuses without a local token and makes no request", async () => {
  const { deps, requests, err } = makeDeps({});

  const code = await run(["inbox"], deps);

  assert.equal(code, 1);
  assert.equal(requests.length, 0);
  assert.match(err.join("\n"), /No token found/);
});

test("assignments lists bounded work without writing local state", async () => {
  const TOKEN = "oak_assignment_TOKEN_1234";
  const { deps, requests, files, out } = makeDeps({
    files: { [localPath(CWD)]: JSON.stringify({ token: TOKEN }) },
    router: (url) => url.endsWith("/api/agent/assignments")
      ? jsonResponse(200, { assignments: [{ id: "assignment-123456", state: "requested", task: "Verify release", repository: "runleak", scope: ["src/lib"], prohibited_scope: [".env"], max_duration_ms: 3600000, max_estimated_tokens: 50000, approval_policy: "human_before_start", evidence_required: true, expires_at: "2030-01-01T00:00:00Z" }] })
      : jsonResponse(404, { error: "unexpected route" }),
  });
  const code = await run(["assignments"], deps);
  assert.equal(code, 0);
  assert.match(requests[0].url, /\/api\/agent\/assignments$/);
  assert.match(out.join("\n"), /Verify release/);
  assert.match(out.join("\n"), /requested/);
  assert.match(out.join("\n"), /allowed: src\/lib/);
  assert.match(out.join("\n"), /prohibited: \.env/);
  assert.match(out.join("\n"), /maximum duration: 60 minutes/);
  assert.match(out.join("\n"), /estimated-token budget: 50000 \(reported boundary; provider enforcement unknown\)/);
  assert.match(out.join("\n"), /human_before_start/);
  assert.match(out.join("\n"), /evidence required: yes/);
  assert.equal(files.size, 1);
});

test("assignment accept sends only the explicit decision", async () => {
  const TOKEN = "oak_assignment_TOKEN_1234";
  const { deps, requests } = makeDeps({
    files: { [localPath(CWD)]: JSON.stringify({ token: TOKEN }) },
    router: () => jsonResponse(200, { assignment: { id: "assignment-123456", state: "accepted" } }),
  });
  const code = await run(["assignment", "accept", "assignment-123456"], deps);
  assert.equal(code, 0);
  assert.match(requests[0].url, /\/api\/agent\/assignments\/assignment-123456$/);
  assert.deepEqual(JSON.parse(requests[0].init!.body as string), { decision: "accept" });
});

test("assignment complete requires run and evidence identifiers", async () => {
  const TOKEN = "oak_assignment_TOKEN_1234";
  const missing = makeDeps({ files: { [localPath(CWD)]: JSON.stringify({ token: TOKEN }) } });
  assert.equal(await run(["assignment", "complete", "assignment-123456"], missing.deps), 1);
  assert.equal(missing.requests.length, 0);

  const ready = makeDeps({
    files: { [localPath(CWD)]: JSON.stringify({ token: TOKEN }) },
    router: () => jsonResponse(200, { assignment: { id: "assignment-123456", state: "completed" } }),
  });
  assert.equal(await run(["assignment", "complete", "assignment-123456", "--run", "run-1", "--evidence-record", "evidence-1"], ready.deps), 0);
  assert.deepEqual(JSON.parse(ready.requests[0].init!.body as string), { decision: "complete", run_id: "run-1", evidence_record_id: "evidence-1" });
});

test("finding publish requires an active run and --title/--observed, and makes no request without them", async () => {
  const TOKEN = "oak_finding_TOKEN_1234";
  const noRun = makeDeps({ files: { [localPath(CWD)]: JSON.stringify({ token: TOKEN }) } });
  assert.equal(await run(["finding", "publish", "--title", "t", "--observed", "o"], noRun.deps), 1);
  assert.equal(noRun.requests.length, 0);

  const noFields = makeDeps({
    files: {
      [localPath(CWD)]: JSON.stringify({ token: TOKEN }),
      [join(CWD, ".oathlock", "run.json")]: JSON.stringify({ run_id: "run-1" }),
    },
  });
  assert.equal(await run(["finding", "publish"], noFields.deps), 1);
  assert.equal(noFields.requests.length, 0);
});

test("finding publish sends the active run id and required fields to /api/agent/findings", async () => {
  const TOKEN = "oak_finding_TOKEN_1234";
  const { deps, requests } = makeDeps({
    files: {
      [localPath(CWD)]: JSON.stringify({ token: TOKEN }),
      [join(CWD, ".oathlock", "run.json")]: JSON.stringify({ run_id: "run-1" }),
    },
    router: () => jsonResponse(200, { finding_id: "finding-123", review_state: "observed" }),
  });
  const code = await run([
    "finding", "publish",
    "--title", "Session cookie missing SameSite",
    "--observed", "Login response sets the cookie without SameSite=Lax",
    "--evidence-level", "inferred",
    "--suggested", "Add SameSite=Lax to the Set-Cookie header",
  ], deps);
  assert.equal(code, 0);
  assert.match(requests[0].url, /\/api\/agent\/findings$/);
  assert.equal((requests[0].init!.headers as Record<string, string>).authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(requests[0].init!.body as string), {
    run_id: "run-1",
    title: "Session cookie missing SameSite",
    applicable_environment: "",
    observed_behavior: "Login response sets the cookie without SameSite=Lax",
    evidence_level: "inferred",
    suggested_response: "Add SameSite=Lax to the Set-Cookie header",
    known_limitations: [],
  });
});

test("finding publish rejects an invalid --evidence-level before contacting the API", async () => {
  const TOKEN = "oak_finding_TOKEN_1234";
  const { deps, requests } = makeDeps({
    files: {
      [localPath(CWD)]: JSON.stringify({ token: TOKEN }),
      [join(CWD, ".oathlock", "run.json")]: JSON.stringify({ run_id: "run-1" }),
    },
  });
  const code = await run(["finding", "publish", "--title", "t", "--observed", "o", "--evidence-level", "definitely"], deps);
  assert.equal(code, 1);
  assert.equal(requests.length, 0);
});

test("heartbeat reports linked presence with a monotonic adapter sequence", async () => {
  const TOKEN = "oak_heartbeat_TOKEN_1234";
  const { deps, requests, files, out } = makeDeps({
    files: {
      [localPath(CWD)]: JSON.stringify({ token: TOKEN }),
      [join(CWD, ".oathlock", "config.json")]: JSON.stringify({ agent_kind: "codex" }),
    },
    router: () => jsonResponse(200, { lease_expires_at: "2030-01-01T00:01:30Z" }),
  });
  assert.equal(await run(["heartbeat"], deps), 0);
  const body = JSON.parse(requests[0].init!.body as string);
  assert.equal(body.protocolVersion, "m9r.presence.v1");
  assert.equal(body.executionOrigin, "linked");
  assert.equal(body.provider, "codex");
  assert.equal(body.sequence, 1);
  assert.ok(body.adapterInstanceId.length >= 8);
  assert.match(out.join("\n"), /lease accepted/i);
  assert.ok(files.has(join(CWD, ".oathlock", "adapter.json")));
});

// ---------------------------------------------------------------------------
// doctor: clean failure without a token
// ---------------------------------------------------------------------------

test("doctor fails cleanly when there is no token", async () => {
  const { deps, out, requests } = makeDeps({});

  const code = await run(["doctor"], deps);

  assert.equal(code, 1);
  const text = out.join("\n");
  assert.match(text, /\[FAIL\] .*local\.json exists/);
  assert.match(text, /\[FAIL\] token present/);
  assert.equal(requests.length, 0, "doctor must not call the API without a token");
});

// ---------------------------------------------------------------------------
// disconnect: server revocation + local cleanup
// ---------------------------------------------------------------------------

test("disconnect refuses cleanly without a local token", async () => {
  const { deps, err, requests } = makeDeps({});

  const code = await run(["disconnect"], deps);

  assert.equal(code, 1);
  assert.equal(err.join("\n"), "No local M9R connection found.");
  assert.equal(requests.length, 0, "disconnect must not contact the API without a token");
});

test("disconnect revokes the current server connection and removes local volatile files", async () => {
  const TOKEN = "oak_disconnect_TOKEN_1234";
  const { deps, files, requests, out, err } = makeDeps({
    files: {
      [localPath(CWD)]: JSON.stringify({ token: TOKEN, scopes: ["rules:read"] }),
      [rulesPath(CWD)]: JSON.stringify({ rules: [{ id: "r1" }] }),
      [join(CWD, ".oathlock", "run.json")]: JSON.stringify({ run_id: "run-1" }),
      [configPath(CWD)]: JSON.stringify({ api_url: "https://example.test" }),
    },
    router: (url) =>
      url.includes("/api/agent/disconnect")
        ? jsonResponse(200, { ok: true, status: "revoked", connection_id: "conn-1" })
        : jsonResponse(404, { error: "unexpected route" }),
  });

  const code = await run(["disconnect"], deps);

  assert.equal(code, 0);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/api\/agent\/disconnect$/);
  assert.equal((requests[0].init!.headers as Record<string, string>).authorization, `Bearer ${TOKEN}`);
  assert.equal(files.has(localPath(CWD)), false, "local token file must be removed");
  assert.equal(files.has(join(CWD, ".oathlock", "run.json")), false, "run cache must be removed");
  assert.equal(files.has(rulesPath(CWD)), false, "rules cache must be removed");
  assert.equal(files.has(configPath(CWD)), true, "non-secret config metadata is not volatile cleanup");

  const text = out.join("\n");
  assert.match(text, /server disconnected: yes/);
  assert.match(text, /local token removed: yes/);
  assert.match(text, /run cache removed: yes/);
  assert.match(text, /rules cache removed: yes/);
  assert.ok(!text.includes(TOKEN), "disconnect must not print the token");
  assert.ok(!err.join("\n").includes(TOKEN), "disconnect errors must not print the token");
});

test("disconnect revokes and removes only the current runtime agent profile", async () => {
  const CODEX_TOKEN = "oak_codex_disconnect_1234";
  const CLAUDE_TOKEN = "oak_claude_keep_5678";
  const { deps, files, requests } = makeDeps({
    env: { CODEX_HOME: "1" },
    files: {
      [agentLocalPath(CWD, "codex")]: JSON.stringify({ token: CODEX_TOKEN, scopes: ["rules:read"] }),
      [agentConfigPath(CWD, "codex")]: JSON.stringify({ agent_kind: "codex" }),
      [agentLocalPath(CWD, "claude-code")]: JSON.stringify({ token: CLAUDE_TOKEN, scopes: ["rules:read"] }),
      [agentConfigPath(CWD, "claude-code")]: JSON.stringify({ agent_kind: "claude-code" }),
    },
    router: () => jsonResponse(200, { ok: true, status: "revoked", connection_id: "conn-codex" }),
  });

  const code = await run(["disconnect"], deps);

  assert.equal(code, 0);
  assert.equal(requests.length, 1);
  assert.equal((requests[0].init?.headers as Record<string, string>).authorization, `Bearer ${CODEX_TOKEN}`);
  assert.equal(files.has(agentLocalPath(CWD, "codex")), false);
  assert.equal(files.has(agentLocalPath(CWD, "claude-code")), true);
  assert.match(files.get(agentLocalPath(CWD, "claude-code")) ?? "", new RegExp(CLAUDE_TOKEN));
});

test("Codex cannot disconnect a legacy profile recorded as Claude Code", async () => {
  const CLAUDE_TOKEN = "oak_legacy_claude_keep_9012";
  const { deps, files, requests } = makeDeps({
    env: { CODEX_HOME: "1" },
    files: {
      [localPath(CWD)]: JSON.stringify({ token: CLAUDE_TOKEN }),
      [configPath(CWD)]: JSON.stringify({ agent_kind: "claude-code" }),
    },
  });

  const code = await run(["disconnect"], deps);

  assert.equal(code, 1);
  assert.equal(requests.length, 0);
  assert.equal(files.has(localPath(CWD)), true);
});

test("disconnect reports server failure honestly while still removing local files", async () => {
  const TOKEN = "oak_disconnect_FAIL_5678";
  const { deps, files, out, err } = makeDeps({
    files: {
      [localPath(CWD)]: JSON.stringify({ token: TOKEN }),
      [rulesPath(CWD)]: JSON.stringify({ rules: [] }),
      [join(CWD, ".oathlock", "run.json")]: JSON.stringify({ run_id: "run-fail" }),
    },
    router: () => jsonResponse(500, { error: `server could not revoke ${TOKEN}` }),
  });

  const code = await run(["disconnect"], deps);

  assert.equal(code, 1);
  assert.equal(files.has(localPath(CWD)), false, "local token file should still be removed");
  assert.equal(files.has(join(CWD, ".oathlock", "run.json")), false, "run cache should still be removed");
  assert.equal(files.has(rulesPath(CWD)), false, "rules cache should still be removed");

  const output = out.join("\n");
  const errors = err.join("\n");
  assert.match(output, /server disconnected: no/);
  assert.doesNotMatch(output, /server disconnected: yes/);
  assert.match(output, /local token removed: yes/);
  assert.match(output, /run cache removed: yes/);
  assert.match(output, /rules cache removed: yes/);
  assert.match(errors, /server error: HTTP 500: server could not revoke oak_\*\*\*REDACTED\*\*\*/);
  assert.ok(!`${output}\n${errors}`.includes(TOKEN), "token must be redacted from all disconnect output");
});

test("CLI bearer commands fail safely when a revoked token is rejected by the server", async () => {
  const TOKEN = "oak_revoked_TOKEN_9999";
  const sessionPath = join(CWD, "session.md");
  const files = {
    [localPath(CWD)]: JSON.stringify({ token: TOKEN }),
    [join(CWD, ".oathlock", "run.json")]: JSON.stringify({ run_id: "run-revoked" }),
    [sessionPath]: "# redacted session",
  };

  const rejected: Router = () => jsonResponse(401, { error: "Invalid or missing agent token." });
  const cases: Array<{ argv: string[]; label: string }> = [
    { argv: ["rules"], label: "rules failed" },
    { argv: ["run", "start", "--task", "x"], label: "run start failed" },
    { argv: ["run", "status", "--phase", "reading"], label: "run status failed" },
    { argv: ["submit-session", "session.md", "--approved"], label: "submit-session failed" },
  ];

  for (const c of cases) {
    const { deps, err, out } = makeDeps({ files, router: rejected });
    const code = await run(c.argv, deps);
    const combined = `${out.join("\n")}\n${err.join("\n")}`;
    assert.equal(code, 1, `${c.argv.join(" ")} must fail when the server rejects the token`);
    assert.match(combined, new RegExp(`${c.label}: HTTP 401: Invalid or missing agent token\\.`));
    assert.ok(!combined.includes(TOKEN), `${c.argv.join(" ")} must not print the token`);
  }
});

test("run start exposes the server-issued cookie dashboard approval destination without exposing its bearer token", async () => {
  const TOKEN = "oak_pending_approval_1234";
  const requestId = "apr_0123456789abcdef01234567";
  const opened: string[] = [];
  const { deps, err } = makeDeps({
    files: { [localPath(CWD)]: JSON.stringify({ token: TOKEN }) },
    router: () => jsonResponse(403, {
      error: "approval_required",
      message: "Human approval is required before starting this run.",
      approvalRequestId: requestId,
      dashboardPath: `/dashboard/approvals/${requestId}`,
    }),
  });
  deps.openUrl = (url) => { opened.push(url); };

  const code = await run(["run", "start", "--task", "a narrowly scoped task"], deps);

  assert.equal(code, 1);
  assert.deepEqual(opened, [`https://app.m9r.workers.dev/dashboard/approvals/${requestId}`]);
  const output = err.join("\n");
  assert.match(output, new RegExp(`Human action required: approve this run at https://app\\.m9r\\.workers\\.dev/dashboard/approvals/${requestId}`));
  assert.match(output, new RegExp(`Approval request: ${requestId}`));
  assert.ok(!output.includes(TOKEN));
});

test("run start stays pending and resumes automatically after the human approves", async () => {
  const TOKEN = "oak_pending_then_approved_1234";
  const requestId = "apr_abcdef0123456789abcdef01";
  let attempts = 0;
  const { deps, out, files } = makeDeps({
    files: { [localPath(CWD)]: JSON.stringify({ token: TOKEN }) },
    router: () => {
      attempts += 1;
      if (attempts < 3) {
        return jsonResponse(403, {
          error: "approval_required",
          approvalRequestId: requestId,
          dashboardPath: `/dashboard/approvals/${requestId}`,
        });
      }
      return jsonResponse(201, {
        run_id: "run-resumed-after-approval",
        status: "started",
        started_at: "2026-07-28T12:00:00.000Z",
      });
    },
  });

  const code = await run(["run", "start", "--task", "resume after approval"], deps);

  assert.equal(code, 0);
  assert.equal(attempts, 3);
  assert.match(out.join("\n"), /Waiting for human approval/);
  assert.match(out.join("\n"), /Run started/);
  assert.ok([...files.values()].some((value) => value.includes("run-resumed-after-approval")));
});

// ---------------------------------------------------------------------------
// error handling: never leak the token
// ---------------------------------------------------------------------------

test("API errors are shown without leaking the token", async () => {
  const TOKEN = "oak_secret_LEAKME_5678";
  const { deps, err } = makeDeps({
    files: { [localPath(CWD)]: JSON.stringify({ token: TOKEN }) },
    // A hostile/echoing API that includes the token in its error body.
    router: () => jsonResponse(500, { error: `internal failure for ${TOKEN}` }),
  });

  const code = await run(["rules"], deps);

  assert.equal(code, 1);
  const text = err.join("\n");
  assert.ok(!text.includes(TOKEN), "token must not appear in error output");
  assert.match(text, /REDACTED/);
});

// ---------------------------------------------------------------------------
// compare: snapshot-unavailable rendering (no misleading "not evaluated"/0 → 0)
// ---------------------------------------------------------------------------

const SNAPSHOT_RH_LIMIT =
  "Rule Health snapshot unavailable for this run. This run was submitted before snapshot persistence or before the migration was applied. Run a fresh later run after deployment.";
const SNAPSHOT_BEHAVIOR_LIMIT =
  "Behavioral counts are unavailable for this comparison because a run's behavior snapshot was not recovered; zeroed counts are not meaningful here. Run a fresh later run after deployment.";

const ZERO_BEHAVIOR_DELTA = [
  { key: "retries", label: "Retry spirals", before: 0, after: 0, change: "unchanged" },
  { key: "repeatedCommands", label: "Repeated commands", before: 0, after: 0, change: "unchanged" },
  { key: "repeatedFileEdits", label: "Repeated file edits", before: 0, after: 0, change: "unchanged" },
  { key: "failedCommands", label: "Failed commands", before: 0, after: 0, change: "unchanged" },
  { key: "toolCalls", label: "Tool calls", before: 0, after: 0, change: "unchanged" },
  { key: "changedFiles", label: "Changed files", before: 0, after: 0, change: "unchanged" },
  { key: "verification", label: "Verification present", before: 0, after: 0, change: "unchanged" },
];

function compareRouter(comparison: Record<string, unknown>): Router {
  return (url) =>
    url.includes("/api/agent/compare")
      ? jsonResponse(200, { comparison })
      : jsonResponse(500, { error: "unexpected route" });
}

test("compare prints 'snapshot unavailable' (not 'not evaluated') when snapshot flags are present", async () => {
  const { deps, out } = makeDeps({
    files: { [localPath(CWD)]: JSON.stringify({ token: "oak_tok" }) },
    router: compareRouter({
      rule_health_result: null,
      rule_health_snapshot_available: false,
      behavior_snapshot_available: false,
      behavioral_delta: ZERO_BEHAVIOR_DELTA,
      usage_delta: { available: false, message: "Usage comparison unavailable because one or both sessions did not include token/cost metadata." },
      output_quality_delta: { judgeable: false, message: "Output quality comparison requires objective signals such as build result, test result, lint result, acceptance criteria, or human approval." },
      honest_verdict: `${SNAPSHOT_RH_LIMIT} ${SNAPSHOT_BEHAVIOR_LIMIT}`,
      limitations: [SNAPSHOT_RH_LIMIT, SNAPSHOT_BEHAVIOR_LIMIT],
    }),
  });

  const code = await run(["compare", "--baseline-run", "A", "--later-run", "B"], deps);
  const text = out.join("\n");

  assert.equal(code, 0);
  assert.match(text, /^rule health: snapshot unavailable \(see limitations\)$/m);
  assert.ok(!/rule health: not evaluated/.test(text));
  assert.match(text, /^behavior: snapshot unavailable$/m);
  assert.ok(!/behavior \(before → after\):/.test(text), "must not print the behavior table header");
  assert.ok(!/0 → 0/.test(text), "must not print fake-looking zero behavior counts");
  assert.ok(!/Retry spirals/.test(text));
  assert.match(text, /Run a fresh later run after deployment\./);
});

test("compare derives snapshot-unavailable from limitation text even when flags are absent (old deployment)", async () => {
  const { deps, out } = makeDeps({
    files: { [localPath(CWD)]: JSON.stringify({ token: "oak_tok" }) },
    // Mirrors an older deployed server: no flags, but the limitation IS present.
    router: compareRouter({
      rule_health_result: null,
      behavioral_delta: ZERO_BEHAVIOR_DELTA,
      usage_delta: { available: false, message: "Usage comparison unavailable because one or both sessions did not include token/cost metadata." },
      output_quality_delta: { judgeable: false, message: "Output quality comparison requires objective signals such as build result, test result, lint result, acceptance criteria, or human approval." },
      honest_verdict: SNAPSHOT_RH_LIMIT,
      limitations: [SNAPSHOT_RH_LIMIT, SNAPSHOT_BEHAVIOR_LIMIT],
    }),
  });

  const code = await run(["compare", "--baseline-run", "A", "--later-run", "B"], deps);
  const text = out.join("\n");

  assert.equal(code, 0);
  assert.match(text, /rule health: snapshot unavailable/);
  assert.ok(!/rule health: not evaluated/.test(text));
  assert.match(text, /behavior: snapshot unavailable/);
  assert.ok(!/0 → 0/.test(text));
});

test("compare treats behavior as unavailable when ONLY the Rule Health limitation is present (real old-server skew)", async () => {
  const { deps, out } = makeDeps({
    files: { [localPath(CWD)]: JSON.stringify({ token: "oak_tok" }) },
    // The currently-deployed server: no flags, no behavior limitation — only the
    // Rule Health snapshot limitation and a zeroed behavior table.
    router: compareRouter({
      rule_health_result: null,
      behavioral_delta: ZERO_BEHAVIOR_DELTA,
      usage_delta: { available: false, message: "Usage comparison unavailable because one or both sessions did not include token/cost metadata." },
      output_quality_delta: { judgeable: false, message: "not judged" },
      honest_verdict: SNAPSHOT_RH_LIMIT,
      limitations: [SNAPSHOT_RH_LIMIT],
    }),
  });

  const code = await run(["compare", "--baseline-run", "A", "--later-run", "B"], deps);
  const text = out.join("\n");

  assert.equal(code, 0);
  assert.match(text, /^rule health: snapshot unavailable \(see limitations\)$/m);
  assert.match(text, /^behavior: snapshot unavailable$/m);
  assert.ok(!/behavior \(before → after\):/.test(text), "must not print the behavior table header");
  assert.ok(!/0 → 0/.test(text), "must not print fake-looking zero behavior counts");
  for (const metric of ZERO_BEHAVIOR_DELTA) {
    assert.ok(!text.includes(String(metric.label)), `must not print zero row: ${metric.label}`);
  }
});

test("compare prints normal rule health and behavior table when snapshots exist", async () => {
  const { deps, out } = makeDeps({
    files: { [localPath(CWD)]: JSON.stringify({ token: "oak_tok" }) },
    router: compareRouter({
      rule_health_result: { evaluated: true, dominant: "needs_review" },
      rule_health_snapshot_available: true,
      behavior_snapshot_available: true,
      behavioral_delta: [
        { key: "repeatedFileEdits", label: "Repeated file edits", before: 4, after: 1, change: "improved" },
        { key: "toolCalls", label: "Tool calls", before: 10, after: 8, change: "decreased" },
      ],
      usage_delta: { available: false, message: "Usage comparison unavailable because one or both sessions did not include token/cost metadata." },
      output_quality_delta: { judgeable: false, message: "not judged" },
      honest_verdict: "Evidence is mixed or insufficient.",
      limitations: [],
    }),
  });

  const code = await run(["compare", "--baseline-run", "A", "--later-run", "B"], deps);
  const text = out.join("\n");

  assert.equal(code, 0);
  assert.match(text, /rule health: needs_review/);
  assert.ok(!/snapshot unavailable/.test(text));
  assert.match(text, /behavior \(before → after\):/);
  assert.match(text, /Repeated file edits: 4 → 1 \(improved\)/);
  assert.match(text, /Tool calls: 10 → 8 \(decreased\)/);
});

test("compare renders neutral activity increases without regression labels", async () => {
  const { deps, out } = makeDeps({
    files: { [localPath(CWD)]: JSON.stringify({ token: "oak_tok" }) },
    router: compareRouter({
      rule_health_result: { evaluated: true, dominant: "needs_review" },
      rule_health_snapshot_available: true,
      behavior_snapshot_available: true,
      behavioral_delta: [
        { key: "retries", label: "Retry spirals", before: 0, after: 0, change: "unchanged" },
        { key: "repeatedCommands", label: "Repeated commands", before: 0, after: 0, change: "unchanged" },
        { key: "repeatedFileEdits", label: "Repeated file edits", before: 0, after: 0, change: "unchanged" },
        { key: "failedCommands", label: "Failed commands", before: 0, after: 2, change: "increased" },
        { key: "toolCalls", label: "Tool calls", before: 0, after: 4, change: "increased" },
        { key: "changedFiles", label: "Changed files", before: 0, after: 1, change: "changed" },
        { key: "verification", label: "Verification present", before: 0, after: 1, change: "improved" },
      ],
      usage_delta: { available: false, message: "Usage comparison unavailable because one or both sessions did not include token/cost metadata." },
      output_quality_delta: { judgeable: true, message: "Both runs include objective verification signals." },
      honest_verdict: "Results are mixed: some patterns reduced while others increased. Insufficient evidence to attribute the change to the rules.",
      limitations: [],
    }),
  });

  const code = await run(["compare", "--baseline-run", "A", "--later-run", "B"], deps);
  const text = out.join("\n");

  assert.equal(code, 0);
  assert.match(text, /Failed commands: 0 → 2 \(increased; review manually\)/);
  assert.match(text, /Tool calls: 0 → 4 \(increased\)/);
  assert.match(text, /Changed files: 0 → 1 \(changed\)/);
  assert.match(text, /Verification present: 0 → 1 \(present in later run\)/);
  assert.ok(!/Failed commands: 0 → 2 \(worsened\)/.test(text));
  assert.ok(!/Tool calls: 0 → 4 \(worsened\)/.test(text));
  assert.ok(!/Changed files: 0 → 1 \(worsened\)/.test(text));
});

test("compare output never leaks the token", async () => {
  const TOKEN = "oak_compare_secret_4242";
  const { deps, out, err } = makeDeps({
    files: { [localPath(CWD)]: JSON.stringify({ token: TOKEN }) },
    router: compareRouter({
      rule_health_result: null,
      rule_health_snapshot_available: false,
      behavior_snapshot_available: false,
      behavioral_delta: ZERO_BEHAVIOR_DELTA,
      usage_delta: { available: false, message: "unavailable" },
      output_quality_delta: { judgeable: false, message: "not judged" },
      honest_verdict: SNAPSHOT_RH_LIMIT,
      limitations: [SNAPSHOT_RH_LIMIT],
    }),
  });

  await run(["compare", "--baseline-run", "A", "--later-run", "B"], deps);
  assert.ok(!out.join("\n").includes(TOKEN));
  assert.ok(!err.join("\n").includes(TOKEN));
});

// ---------------------------------------------------------------------------
// signal emit / replay / ack — Gate 3 generic CLI adapter surface
// ---------------------------------------------------------------------------

test("signal emit requires --type and --summary and makes no request without them", async () => {
  const { deps, requests, err } = makeDeps({
    files: { [localPath(CWD)]: JSON.stringify({ token: "oak_x" }) },
  });
  const code = await run(["signal", "emit", "--type", "WORKING"], deps);
  assert.equal(code, 1);
  assert.equal(requests.length, 0);
  assert.match(err.join("\n"), /Usage: m9r-cli signal emit/);
});

test("signal emit refuses without a local token and makes no request", async () => {
  const { deps, requests, err } = makeDeps({});
  const code = await run(["signal", "emit", "--type", "WORKING", "--summary", "doing work"], deps);
  assert.equal(code, 1);
  assert.equal(requests.length, 0);
  assert.match(err.join("\n"), /No token found/);
});

test("signal emit sends a versioned envelope with a generated adapter id and client sequence 1, then persists them", async () => {
  const TOKEN = "oak_signal_TOKEN_1234";
  const { deps, requests, files, out } = makeDeps({
    files: { [localPath(CWD)]: JSON.stringify({ token: TOKEN }) },
    router: (url) =>
      url.includes("/api/agent/signals")
        ? jsonResponse(200, { ok: true, signal: { id: "s1", server_sequence: 7 } })
        : jsonResponse(404, { error: "unexpected route" }),
  });

  const code = await run(["signal", "emit", "--type", "WORKING", "--summary", "Editing scoped files", "--repo", "org/repo", "--scope", "a.ts,b.ts"], deps);

  assert.equal(code, 0);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/api\/agent\/signals$/);
  const headers = requests[0].init!.headers as Record<string, string>;
  assert.equal(headers.authorization, `Bearer ${TOKEN}`);
  const body = JSON.parse(String(requests[0].init!.body)) as Record<string, unknown>;
  assert.equal(body.protocolVersion, "oathlock.work-signal.v1");
  assert.equal(body.clientSequence, 1);
  assert.equal(body.type, "WORKING");
  assert.equal(body.source, "reported");
  assert.equal(body.repo, "org/repo");
  assert.deepEqual(body.scope, ["a.ts", "b.ts"]);
  assert.ok(typeof body.adapterInstanceId === "string" && (body.adapterInstanceId as string).length >= 8);
  assert.ok(typeof body.idempotencyKey === "string" && (body.idempotencyKey as string).length >= 16);

  const saved = JSON.parse(files.get(join(CWD, ".oathlock", "adapter.json"))!) as Record<string, unknown>;
  assert.equal(saved.last_client_sequence, 1);
  assert.equal(saved.adapter_instance_id, body.adapterInstanceId);
  assert.match(out.join("\n"), /server_sequence 7/);
});

test("signal emit reuses the persisted adapter id and increments client sequence across calls", async () => {
  const TOKEN = "oak_signal_TOKEN_5678";
  const { deps, requests } = makeDeps({
    files: {
      [localPath(CWD)]: JSON.stringify({ token: TOKEN }),
      [join(CWD, ".oathlock", "adapter.json")]: JSON.stringify({ adapter_instance_id: "adapter-fixed-0001", last_client_sequence: 4 }),
    },
    router: () => jsonResponse(200, { ok: true, signal: { id: "s2", server_sequence: 12 } }),
  });

  const code = await run(["signal", "emit", "--type", "BLOCKED", "--summary", "waiting on review"], deps);
  assert.equal(code, 0);
  const body = JSON.parse(String(requests[0].init!.body)) as Record<string, unknown>;
  assert.equal(body.adapterInstanceId, "adapter-fixed-0001");
  assert.equal(body.clientSequence, 5);
});

test("signal replay defaults to this connection's own cursor and prints returned signals", async () => {
  const TOKEN = "oak_replay_TOKEN_1234";
  const { deps, requests, out } = makeDeps({
    files: { [localPath(CWD)]: JSON.stringify({ token: TOKEN }) },
    router: (url) =>
      url.includes("/api/agent/signals")
        ? jsonResponse(200, { ok: true, cursor: 9, signals: [{ server_sequence: 9, type: "WORKING", summary: "doing the thing" }] })
        : jsonResponse(404, { error: "unexpected route" }),
  });

  const code = await run(["signal", "replay"], deps);
  assert.equal(code, 0);
  assert.match(requests[0].url, /\/api\/agent\/signals$/);
  assert.match(out.join("\n"), /cursor: 9/);
  assert.match(out.join("\n"), /signals: 1/);
  assert.match(out.join("\n"), /doing the thing/);
});

test("signal replay forwards --since and --limit as query params", async () => {
  const TOKEN = "oak_replay_TOKEN_5678";
  const { deps, requests } = makeDeps({
    files: { [localPath(CWD)]: JSON.stringify({ token: TOKEN }) },
    router: () => jsonResponse(200, { ok: true, cursor: 20, signals: [] }),
  });

  await run(["signal", "replay", "--since", "10", "--limit", "5"], deps);
  assert.match(requests[0].url, /[?&]since=10/);
  assert.match(requests[0].url, /[?&]limit=5/);
});

test("signal ack requires --through and never sends a request without it", async () => {
  const { deps, requests, err } = makeDeps({
    files: { [localPath(CWD)]: JSON.stringify({ token: "oak_x" }) },
  });
  const code = await run(["signal", "ack"], deps);
  assert.equal(code, 1);
  assert.equal(requests.length, 0);
  assert.match(err.join("\n"), /Usage: m9r-cli signal ack/);
});

test("signal ack posts throughSequence and prints the server's acked_through", async () => {
  const TOKEN = "oak_ack_TOKEN_1234";
  const { deps, requests, out } = makeDeps({
    files: { [localPath(CWD)]: JSON.stringify({ token: TOKEN }) },
    router: (url) =>
      url.includes("/api/agent/signals/ack")
        ? jsonResponse(200, { ok: true, acked_through: 15 })
        : jsonResponse(404, { error: "unexpected route" }),
  });

  const code = await run(["signal", "ack", "--through", "15"], deps);
  assert.equal(code, 0);
  assert.match(requests[0].url, /\/api\/agent\/signals\/ack$/);
  const body = JSON.parse(String(requests[0].init!.body)) as Record<string, unknown>;
  assert.equal(body.throughSequence, 15);
  assert.match(out.join("\n"), /acked_through: 15/);
});

test("doctor negotiates its implemented actions against the live server contract and warns on drift", async () => {
  const TOKEN = "oak_doctor_TOKEN_1234";
  const { deps, out } = makeDeps({
    files: { [localPath(CWD)]: JSON.stringify({ token: TOKEN }) },
    router: (url) => {
      if (url.includes("/api/agent/contract")) {
        return jsonResponse(200, {
          protocolVersion: "oathlock.adapter-contract.v1",
          actions: [
            { id: "heartbeat" },
            { id: "rules_read" },
            { id: "inbox_read" },
            { id: "assignment_lifecycle" },
            { id: "run_lifecycle" },
            { id: "work_signal_emit" },
            { id: "work_signal_replay" },
            { id: "evidence_submit" },
            { id: "token_rotation" },
            // work_signal_ack intentionally dropped, to prove drift is reported.
          ],
        });
      }
      if (url.includes("/api/agent/rules")) return jsonResponse(200, { mode: "baseline", rules: [] });
      return jsonResponse(404, { error: "unexpected route" });
    },
  });

  const code = await run(["doctor"], deps);
  assert.equal(code, 0);
  const text = out.join("\n");
  assert.match(text, /adapter contract: 9 action\(s\) recognized by the server, 1 not/);
  assert.match(text, /"work_signal_ack" is not recognized/);
});

test("doctor reports a fully wired Claude Code capture hook as installed and active", async () => {
  const TOKEN = "oak_doctor_capture_TOKEN_1234";
  const { deps, out } = makeDeps({
    env: { OATHLOCK_AGENT_KIND: "claude-code" },
    files: {
      [agentLocalPath(CWD, "claude-code")]: JSON.stringify({ token: TOKEN }),
      [join(CWD, ".oathlock", "bin", "m9r-capture.mjs")]: "pending.jsonl",
      [join(CWD, ".claude", "settings.local.json")]: JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ command: "node m9r-capture.mjs claude-code" }] }] } }),
    },
    router: (url) => {
      if (url.includes("/api/agent/whoami")) return jsonResponse(200, { agentKind: "claude-code" });
      if (url.includes("/api/agent/rules")) return jsonResponse(200, { mode: "baseline", rules: [] });
      if (url.includes("/api/agent/contract")) return jsonResponse(200, { actions: [] });
      return jsonResponse(404, { error: "unexpected route" });
    },
  });

  const code = await run(["doctor"], deps);
  assert.equal(code, 0);
  const text = out.join("\n");
  assert.match(text, /memory capture installed: yes \(Claude\)/);
  assert.match(text, /memory capture active: yes/);
});

test("doctor distinguishes an installed Codex hook from activation trust", async () => {
  const TOKEN = "oak_doctor_codex_capture_TOKEN_1234";
  const { deps, out } = makeDeps({
    env: { OATHLOCK_AGENT_KIND: "codex" },
    files: {
      [agentLocalPath(CWD, "codex")]: JSON.stringify({ token: TOKEN }),
      [join(CWD, ".oathlock", "bin", "m9r-capture.mjs")]: "pending.jsonl",
      [join(CWD, ".codex", "hooks.json")]: JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ command: "node .oathlock/bin/m9r-capture.mjs codex" }] }] } }),
    },
    router: (url) => {
      if (url.includes("/api/agent/whoami")) return jsonResponse(200, { agentKind: "codex" });
      if (url.includes("/api/agent/rules")) return jsonResponse(200, { mode: "baseline", rules: [] });
      if (url.includes("/api/agent/contract")) return jsonResponse(200, { actions: [] });
      return jsonResponse(404, { error: "unexpected route" });
    },
  });

  const code = await run(["doctor"], deps);
  assert.equal(code, 0);
  const text = out.join("\n");
  assert.match(text, /memory capture installed: yes \(Codex\)/);
  assert.match(text, /memory capture active: not verified/);
  assert.match(text, /run \/hooks in Codex/);
});

test("doctor reports the OpenCode plugin and recovery path", async () => {
  const TOKEN = "oak_doctor_opencode_capture_TOKEN_1234";
  const { deps, out } = makeDeps({
    env: { OATHLOCK_AGENT_KIND: "opencode" },
    files: {
      [agentLocalPath(CWD, "opencode")]: JSON.stringify({ token: TOKEN }),
      [join(CWD, ".opencode", "plugins", "m9r-memory.js")]: "M9rMemoryPlugin; pending.jsonl",
    },
    router: (url) => {
      if (url.includes("/api/agent/whoami")) return jsonResponse(200, { agentKind: "opencode" });
      if (url.includes("/api/agent/rules")) return jsonResponse(200, { mode: "baseline", rules: [] });
      if (url.includes("/api/agent/contract")) return jsonResponse(200, { actions: [] });
      return jsonResponse(404, { error: "unexpected route" });
    },
  });

  const code = await run(["doctor"], deps);
  assert.equal(code, 0);
  const text = out.join("\n");
  assert.match(text, /memory capture installed: yes \(OpenCode\)/);
  assert.match(text, /memory capture active: yes/);
  assert.match(text, /resident backfill covers sessions/);
});

test("rotate-token refuses without a local token and makes no request", async () => {
  const { deps, requests, err } = makeDeps({});
  const code = await run(["rotate-token"], deps);
  assert.equal(code, 1);
  assert.equal(requests.length, 0);
  assert.match(err.join("\n"), /No token found/);
});

test("rotate-token saves the new token and reports the old one as revoked", async () => {
  const OLD_TOKEN = "oak_old_TOKEN_1234";
  const NEW_TOKEN = "oak_new_TOKEN_5678";
  const { deps, requests, files, out } = makeDeps({
    files: { [localPath(CWD)]: JSON.stringify({ token: OLD_TOKEN, scopes: ["session:submit"] }) },
    router: (url) =>
      url.includes("/api/agent/rotate-token")
        ? jsonResponse(200, { ok: true, token: NEW_TOKEN, scopes: ["session:submit"] })
        : jsonResponse(404, { error: "unexpected route" }),
  });

  const code = await run(["rotate-token"], deps);
  assert.equal(code, 0);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/api\/agent\/rotate-token$/);
  assert.equal((requests[0].init!.headers as Record<string, string>).authorization, `Bearer ${OLD_TOKEN}`);

  const saved = JSON.parse(files.get(localPath(CWD))!) as Record<string, unknown>;
  assert.equal(saved.token, NEW_TOKEN);
  assert.deepEqual(saved.scopes, ["session:submit"]);

  const text = out.join("\n");
  assert.match(text, /Token rotated/);
  assert.match(text, /old token is now revoked/);
  assert.ok(!text.includes(OLD_TOKEN) && !text.includes(NEW_TOKEN), "must never print a raw token, only the masked preview");
});

test("rotate-token reports a server failure honestly and never overwrites the saved token", async () => {
  const TOKEN = "oak_rotate_fail_TOKEN";
  const { deps, files, err } = makeDeps({
    files: { [localPath(CWD)]: JSON.stringify({ token: TOKEN }) },
    router: () => jsonResponse(500, { error: "rotate failed" }),
  });

  const code = await run(["rotate-token"], deps);
  assert.equal(code, 1);
  assert.match(err.join("\n"), /rotate-token failed/);
  const saved = JSON.parse(files.get(localPath(CWD))!) as Record<string, unknown>;
  assert.equal(saved.token, TOKEN);
});

test("signal command output never leaks the token", async () => {
  const TOKEN = "oak_signal_secret_9999";
  const { deps, out, err } = makeDeps({
    files: { [localPath(CWD)]: JSON.stringify({ token: TOKEN }) },
    router: () => jsonResponse(500, { error: `boom token=${TOKEN}` }),
  });
  await run(["signal", "emit", "--type", "WORKING", "--summary", "x"], deps);
  await run(["signal", "replay"], deps);
  await run(["signal", "ack", "--through", "1"], deps);
  assert.ok(!out.join("\n").includes(TOKEN));
  assert.ok(!err.join("\n").includes(TOKEN));
});

// ---------------------------------------------------------------------------
// connect: one command, multiple agent kinds
// ---------------------------------------------------------------------------

test("connect --agents registers every listed kind in one batch and uses one approval URL", async () => {
  // Claim status is looked up by claim_id/setup_code alone (no agent_kind in
  // that call), so the claim_id itself must encode which kind it belongs to
  // for this fake router to answer each poll with the right token.
  const { deps, files, requests, out } = makeDeps({
    env: { OATHLOCK_API_URL: "http://localhost:3000" },
    router: (url, init) => {
      if (url.includes("/api/agent/register-batch")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { agents?: Array<{ agent_kind?: string }> };
        const agents = body.agents ?? [];
        return jsonResponse(201, {
          batch_id: "batch-1",
          batch_url: "http://localhost:3000/claim/batch/batch-1",
          claims: agents.map((agent) => ({
            agent_kind: agent.agent_kind,
            claim_id: `claim-${agent.agent_kind}`,
            setup_code: `setup-${agent.agent_kind}`,
            expires_at: "2030-01-01T00:00:00Z",
          })),
        });
      }
      if (url.includes("/api/agent/claim-status")) {
        const claimId = new URL(url).searchParams.get("claim_id") ?? "";
        const kind = claimId.replace(/^claim-/, "");
        return jsonResponse(200, { status: "approved", token: `token-${kind}`, scopes: ["rules:read"] });
      }
      return jsonResponse(404, { error: "nope" });
    },
  });

  const code = await run(["connect", "--agents", "claude-code,codex"], deps);

  assert.equal(code, 0);
  assert.ok(files.has(agentLocalPath(CWD, "claude-code")), "claude-code must be connected");
  assert.ok(files.has(agentLocalPath(CWD, "codex")), "codex must be connected");
  const registerCalls = requests.filter((r) => r.url.includes("/api/agent/register-batch"));
  assert.equal(registerCalls.length, 1, "all new kinds use one grouped registration request");
  assert.equal(requests.filter((r) => r.url.includes("/api/agent/claim-status")).length, 2);
  const text = out.join("\n");
  assert.match(text, /Connecting 2 agents: claude-code, codex/);
  assert.match(text, /approve all new connections once/);
  assert.match(text, /claim\/batch\/batch-1/);
  assert.match(text, /claude-code: registered/);
  assert.match(text, /codex: registered/);
});

test("connect with no --agents and no probe support fails honestly instead of silently connecting nothing", async () => {
  const { deps, requests, err } = makeDeps({});
  const code = await run(["connect"], deps);
  assert.equal(code, 1);
  assert.equal(requests.length, 0);
  assert.match(err.join("\n"), /cannot probe for installed agents/);
});

test("connect auto-detects via probeVersion when --agents is omitted", async () => {
  const { deps, files, out } = makeDeps({
    env: { OATHLOCK_API_URL: "http://localhost:3000" },
    probeVersion: async (binary) => (binary === "opencode" ? "opencode, 1.2.3" : null),
    router: (url) => {
      if (url.includes("/api/agent/register-batch")) {
        return jsonResponse(201, { batch_id: "batch-oc", batch_url: "http://localhost:3000/claim/batch/batch-oc", claims: [{ agent_kind: "opencode", claim_id: "oc", setup_code: "oc-code", expires_at: "2030-01-01T00:00:00Z" }] });
      }
      if (url.includes("/api/agent/claim-status")) {
        return jsonResponse(200, { status: "approved", token: "oak_oc_token", scopes: ["rules:read"] });
      }
      return jsonResponse(404, { error: "nope" });
    },
  });

  const code = await run(["connect"], deps);

  assert.equal(code, 0);
  assert.ok(files.has(agentLocalPath(CWD, "opencode")));
  assert.ok(!files.has(agentLocalPath(CWD, "codex")), "only the detected kind should be connected");
  assert.match(out.join("\n"), /found OpenCode \(opencode\)/);
});

// ---------------------------------------------------------------------------
// connect / init: cross-agent memory-capture wiring (item #35)
// ---------------------------------------------------------------------------

test("capture install repairs a Claude Code hook from an existing M9R connection without opening a new claim", async () => {
  const { deps, files, out, requests } = makeDeps({
    env: { CODEX_HOME: "/codex" },
    files: { [agentLocalPath(CWD, "codex")]: JSON.stringify({ token: "oak_existing_connection" }) },
  });

  const code = await run(["capture", "install", "--agent-kind", "claude-code"], deps);

  assert.equal(code, 0);
  assert.equal(requests.length, 0, "repairing local capture must not create or poll a server-side claim");
  assert.ok(files.has(join(CWD, ".oathlock", "bin", "m9r-capture.mjs")));
  const settings = JSON.parse(files.get(join(CWD, ".claude", "settings.local.json"))!);
  assert.match(settings.hooks.SessionEnd[0].hooks[0].command, /claude-code/);
  assert.match(out.join("\n"), /Installed local capture for Claude Code/);
  assert.match(out.join("\n"), /does not register or authenticate Claude Code/);
});

test("capture install fails closed without an existing M9R connection", async () => {
  const { deps, files, err, requests } = makeDeps({ env: { CODEX_HOME: "/codex" } });

  const code = await run(["capture", "install", "--agent-kind", "claude-code"], deps);

  assert.equal(code, 1);
  assert.equal(requests.length, 0);
  assert.ok(!files.has(join(CWD, ".oathlock", "bin", "m9r-capture.mjs")));
  assert.ok(!files.has(join(CWD, ".claude", "settings.local.json")));
  assert.match(err.join("\n"), /requires an existing M9R connection/);
});

test("capture install rejects unknown provider kinds without writing a partial capture artifact", async () => {
  const { deps, files, err } = makeDeps({
    env: { CODEX_HOME: "/codex" },
    files: { [agentLocalPath(CWD, "codex")]: JSON.stringify({ token: "oak_existing_connection" }) },
  });

  const code = await run(["capture", "install", "--agent-kind", "aider"], deps);

  assert.equal(code, 1);
  assert.ok(!files.has(join(CWD, ".oathlock", "bin", "m9r-capture.mjs")));
  assert.match(err.join("\n"), /no local capture integration is available for aider/);
});

test("capture install honors an explicit OpenCode target when another provider identity is inherited", async () => {
  const { deps, files, out } = makeDeps({
    env: { CODEX_HOME: "/codex", OATHLOCK_AGENT_KIND: "opencode" },
    files: { [agentLocalPath(CWD, "opencode")]: JSON.stringify({ token: "oak_opencode_connection" }) },
  });

  const code = await run(["capture", "install", "--agent-kind", "opencode"], deps);

  assert.equal(code, 0);
  assert.ok(files.has(join(CWD, ".opencode", "plugins", "m9r-memory.js")));
  assert.match(out.join("\n"), /Installed local capture for OpenCode/);
});

test("capture drain drains the local capture spool without requiring a provider token", async () => {
  const { deps, out, requests } = makeDeps({
    drainCapture: async () => ({ drained: 2, failed: 1 }),
  });

  const code = await run(["capture", "drain"], deps);

  assert.equal(code, 1, "a failed spool record must be visible to scripts and operators");
  assert.equal(requests.length, 0, "local capture draining must not call the server");
  assert.match(out.join("\n"), /drained 2 captured session\(s\), 1 failed/);
});

test("capture drain reports when the local drain implementation is unavailable", async () => {
  const { deps, err, requests } = makeDeps({});

  const code = await run(["capture", "drain"], deps);

  assert.equal(code, 1);
  assert.equal(requests.length, 0);
  assert.match(err.join("\n"), /local capture drain is unavailable/);
});

function approvedRouter(): Router {
  return (url) => {
    if (url.includes("/api/agent/register")) {
      return jsonResponse(201, { claim_url: "http://localhost:3000/claim/c1", claim_id: "c1", setup_code: "sc1", expires_at: "2030-01-01T00:00:00Z" });
    }
    if (url.includes("/api/agent/claim-status")) {
      return jsonResponse(200, { status: "approved", token: "oak_capture_token", scopes: ["rules:read"] });
    }
    return jsonResponse(404, { error: "nope" });
  };
}

test("init for claude-code installs the SessionEnd hook script and merges .claude/settings.local.json", async () => {
  const { deps, files, out } = makeDeps({ env: { OATHLOCK_API_URL: "http://localhost:3000" }, router: approvedRouter() });

  const code = await run(["init", "--agent-kind", "claude-code", "--memory-capture"], deps);

  assert.equal(code, 0);
  const hookScript = files.get(join(CWD, ".oathlock", "bin", "m9r-capture.mjs"));
  assert.ok(hookScript, "the shared capture hook script must be written");
  assert.match(hookScript!, /pending\.jsonl/);
  const settings = JSON.parse(files.get(join(CWD, ".claude", "settings.local.json"))!);
  assert.match(settings.hooks.SessionEnd[0].hooks[0].command, /claude-code/);
  assert.match(out.join("\n"), /Claude Code sessions in this repo will now be captured/);
});

test("init for codex installs the SessionEnd hook script and writes .codex/hooks.json", async () => {
  const { deps, files, out } = makeDeps({ env: { OATHLOCK_API_URL: "http://localhost:3000" }, router: approvedRouter() });

  const code = await run(["init", "--agent-kind", "codex", "--memory-capture"], deps);

  assert.equal(code, 0);
  assert.ok(files.has(join(CWD, ".oathlock", "bin", "m9r-capture.mjs")));
  const hooks = JSON.parse(files.get(join(CWD, ".codex", "hooks.json"))!);
  assert.match(hooks.hooks.SessionEnd[0].hooks[0].command, /codex/);
  assert.match(out.join("\n"), /run \/hooks inside Codex/);
});

test("init for opencode writes the memory plugin, and does not write a Claude/Codex hook file", async () => {
  const { deps, files, out } = makeDeps({ env: { OATHLOCK_API_URL: "http://localhost:3000" }, router: approvedRouter() });

  const code = await run(["init", "--agent-kind", "opencode", "--memory-capture"], deps);

  assert.equal(code, 0);
  const plugin = files.get(join(CWD, ".opencode", "plugins", "m9r-memory.js"));
  assert.ok(plugin && plugin.includes("client.session.messages"));
  assert.ok(!files.has(join(CWD, ".oathlock", "bin", "m9r-capture.mjs")), "opencode has no SessionEnd hook, only the plugin");
  assert.match(out.join("\n"), /OpenCode sessions in this repo will now be captured/);
});

test("init --skip-memory-capture connects the agent without installing any capture artifact", async () => {
  const { deps, files, out } = makeDeps({ env: { OATHLOCK_API_URL: "http://localhost:3000" }, router: approvedRouter() });

  const code = await run(["init", "--agent-kind", "claude-code", "--skip-memory-capture"], deps);

  assert.equal(code, 0);
  assert.ok(!files.has(join(CWD, ".oathlock", "bin", "m9r-capture.mjs")));
  assert.ok(!files.has(join(CWD, ".claude", "settings.local.json")));
  assert.match(out.join("\n"), /Skipped shared-memory capture setup/);
});

test("init tells the user what leaves the machine and what stays", async () => {
  const { deps, out } = makeDeps({ env: { OATHLOCK_API_URL: "http://localhost:3000" }, router: approvedRouter() });
  assert.equal(await run(["init", "--agent-kind", "codex"], deps), 0);
  const text = out.join(String.fromCharCode(10));
  assert.match(text, /What leaves this machine:.*http:\/\/localhost:3000/);
  assert.match(text, /What stays: your repo files/);
});

test("init leaves session capture OFF unless asked, and says how to turn it on", async () => {
  const { deps, files, out } = makeDeps({ env: { OATHLOCK_API_URL: "http://localhost:3000" }, router: approvedRouter() });
  assert.equal(await run(["init", "--agent-kind", "claude-code"], deps), 0);
  assert.ok(!files.has(join(CWD, ".claude", "settings.local.json")));
  assert.match(out.join("\n"), /capture is OFF/);
});

test("capture uninstall removes only M9R's hook entry and script, keeping other hooks", async () => {
  const other = { type: "command", command: "echo mine" };
  const { deps, files } = makeDeps({
    env: { OATHLOCK_API_URL: "http://localhost:3000" },
    router: approvedRouter(),
    files: { [join(CWD, ".claude", "settings.local.json")]: JSON.stringify({ model: "x", hooks: { SessionEnd: [{ hooks: [other] }] } }) },
  });
  assert.equal(await run(["init", "--agent-kind", "claude-code", "--memory-capture"], deps), 0);
  assert.equal(await run(["capture", "uninstall"], deps), 0);
  const settings = JSON.parse(files.get(join(CWD, ".claude", "settings.local.json"))!);
  assert.equal(settings.model, "x");
  assert.deepEqual(settings.hooks.SessionEnd, [{ hooks: [other] }]);
  assert.ok(!files.has(join(CWD, ".oathlock", "bin", "m9r-capture.mjs")));
});

test("init for an agent kind with no capture mechanism (e.g. grok-build) connects cleanly with no capture files", async () => {
  const { deps, files } = makeDeps({ env: { OATHLOCK_API_URL: "http://localhost:3000" }, router: approvedRouter() });

  const code = await run(["init", "--agent-kind", "grok-build"], deps);

  assert.equal(code, 0);
  assert.ok(!files.has(join(CWD, ".oathlock", "bin", "m9r-capture.mjs")));
});

test("connect reports a failure summary and a non-zero exit when one of several agents fails to connect", async () => {
  const { deps, out, err } = makeDeps({
    env: { OATHLOCK_API_URL: "http://localhost:3000" },
    router: (url) => {
      if (url.includes("/api/agent/register-batch")) {
        return jsonResponse(201, {
          batch_id: "batch-mixed",
          batch_url: "http://localhost:3000/claim/batch/batch-mixed",
          claims: [
            { agent_kind: "claude-code", claim_id: "ok-claude", setup_code: "ok-code-claude", expires_at: "2030-01-01T00:00:00Z" },
            { agent_kind: "codex", claim_id: "ok-codex", setup_code: "ok-code-codex", expires_at: "2030-01-01T00:00:00Z" },
          ],
        });
      }
      if (url.includes("/api/agent/claim-status")) {
        const claimId = new URL(url).searchParams.get("claim_id");
        return claimId === "ok-codex"
          ? jsonResponse(200, { status: "rejected" })
          : jsonResponse(200, { status: "approved", token: "oak_ok_token", scopes: ["rules:read"] });
      }
      return jsonResponse(404, { error: "nope" });
    },
  });

  const code = await run(["connect", "--agents", "claude-code,codex"], deps);

  assert.equal(code, 1);
  assert.match(out.join("\n"), /claude-code: registered/);
  assert.match(out.join("\n"), /codex: failed/);
  assert.match(err.join("\n"), /1 of 2 agent connection\(s\) failed/);
});

test("init reports M9R registration without claiming that the provider process is ready", async () => {
  const { deps, out } = makeDeps({
    env: { OATHLOCK_API_URL: "http://localhost:3000" },
    router: approvedRouter(),
  });

  const code = await run(["init", "--agent-kind", "codex", "--skip-bootstrap", "--skip-memory-capture"], deps);

  assert.equal(code, 0);
  const text = out.join("\n");
  assert.match(text, /M9R registration approved\./);
  assert.match(text, /Runtime verification: pending/);
  assert.match(text, /does not prove provider sign-in or a running provider process/);
  assert.doesNotMatch(text, /Connected agent:/);
});

// ---------------------------------------------------------------------------
// ask: post to one connected agent from any session, optionally wait for the reply
// ---------------------------------------------------------------------------

function askRouter(opts: { replies?: Array<Record<string, unknown>>; onPost?: (body: Record<string, unknown>, headers: Record<string, string>) => void } = {}): Router {
  return (url, init) => {
    const method = init?.method ?? "GET";
    if (url.endsWith("/api/agent/connections")) {
      return jsonResponse(200, { connections: [{ connection_id: "conn-claude", agent_kind: "claude-code" }, { connection_id: "conn-opencode", agent_kind: "opencode" }] });
    }
    if (url.endsWith("/api/agent/conversations")) {
      return jsonResponse(200, { conversations: [
        { id: "conv-general", topic: "general", status: "open", channel_kind: "channel" },
        { id: "conv-dm", topic: "claude-code", status: "open", channel_kind: "dm" },
        { id: "conv-review", topic: "Review", status: "open", channel_kind: "channel" },
      ] });
    }
    if (url.includes("/api/agent/conversations/") && url.includes("/messages") && method === "POST") {
      opts.onPost?.(JSON.parse(String(init?.body)), init?.headers as Record<string, string>);
      return jsonResponse(201, { message: { id: "0a1b2c3d-0000-4000-8000-000000000001", created_at: "2026-09-19T05:00:00.000Z" } });
    }
    if (url.includes("/api/agent/conversations/") && url.includes("/messages")) {
      return jsonResponse(200, { messages: opts.replies ?? [] });
    }
    return jsonResponse(404, { error: "nope" });
  };
}

function askFiles(): Record<string, string> {
  return { [agentLocalPath(CWD, "codex")]: JSON.stringify({ token: "oak_codex_token_1234", scopes: [] }) };
}

test("ask posts to #general addressed to the agent, with a mention, and does not wait by default", async () => {
  let posted: Record<string, unknown> | null = null;
  let headers: Record<string, string> = {};
  const { deps, out, requests } = makeDeps({ env: { OATHLOCK_API_URL: "http://localhost:3000" }, files: askFiles(), router: askRouter({ onPost: (body, h) => { posted = body; headers = h; } }) });

  const code = await run(["ask", "@claude-code", "review", "the", "relay", "diff", "--agent-kind", "codex"], deps);

  assert.equal(code, 0);
  assert.deepEqual(posted, { kind: "message", body: "@claude-code review the relay diff", recipient_connection_id: "conn-claude" });
  assert.match(headers["idempotency-key"], /^ask:[0-9a-f]{40}$/);
  assert.match(out.join("\n"), /Sent to @claude-code in #general/);
  assert.equal(requests.some((r) => r.url.includes("since=")), false, "no polling without --wait");
});

test("ask --wait prints the target's threaded reply and exits 0", async () => {
  const replies = [{ id: "msg-2", parent_message_id: "0a1b2c3d-0000-4000-8000-000000000001", sender_connection_id: "conn-claude", kind: "result", body: "Looks fine.", created_at: "2026-09-19T05:00:05.000Z" }];
  const { deps, out, requests } = makeDeps({ env: { OATHLOCK_API_URL: "http://localhost:3000" }, files: askFiles(), router: askRouter({ replies }) });

  const code = await run(["ask", "claude-code", "is this ok?", "--wait", "--agent-kind", "codex"], deps);

  assert.equal(code, 0);
  assert.match(out.join("\n"), /@claude-code replied:/);
  assert.match(out.join("\n"), /Looks fine\./);
  assert.ok(requests.some((r) => r.url.includes("since=workspace-cursor.v1%3A") || r.url.includes("since=workspace-cursor.v1:")), "polls from the sent message's cursor");
});

test("ask --wait exits 2 when the agent does not answer in time, and says the message was still sent", async () => {
  const { deps, err } = makeDeps({ env: { OATHLOCK_API_URL: "http://localhost:3000" }, files: askFiles(), router: askRouter({ replies: [] }) });

  const code = await run(["ask", "claude-code", "hello?", "--wait", "--timeout", "1", "--agent-kind", "codex"], deps);

  assert.equal(code, 2);
  assert.match(err.join("\n"), /no reply from @claude-code within 1s.*was sent/);
});

test("ask names the connected agents when the target is unknown, and posts nothing", async () => {
  const { deps, err, requests } = makeDeps({ env: { OATHLOCK_API_URL: "http://localhost:3000" }, files: askFiles(), router: askRouter() });

  const code = await run(["ask", "gemini", "hi", "--agent-kind", "codex"], deps);

  assert.equal(code, 1);
  assert.match(err.join("\n"), /no connected agent matches "gemini".*claude-code, opencode/);
  assert.equal(requests.some((r) => r.init?.method === "POST"), false);
});

test("ask lists the open channels when the channel does not exist, ignoring DMs", async () => {
  const { deps, err } = makeDeps({ env: { OATHLOCK_API_URL: "http://localhost:3000" }, files: askFiles(), router: askRouter() });

  const code = await run(["ask", "claude-code", "hi", "--channel", "#nope", "--agent-kind", "codex"], deps);

  assert.equal(code, 1);
  assert.match(err.join("\n"), /no open channel named "nope".*#general, #Review/);
  assert.doesNotMatch(err.join("\n"), /#claude-code/);
});

test("ask can target a named channel, and refuses an empty or oversized message", async () => {
  let conversation = "";
  const router = askRouter();
  const { deps, err } = makeDeps({ env: { OATHLOCK_API_URL: "http://localhost:3000" }, files: askFiles(), router: (url, init) => { if (init?.method === "POST") conversation = url; return router(url, init); } });

  assert.equal(await run(["ask", "claude-code", "look", "--channel", "review", "--agent-kind", "codex"], deps), 0);
  assert.match(conversation, /conversations\/conv-review\/messages/);
  assert.equal(await run(["ask", "claude-code", "--agent-kind", "codex"], deps), 1);
  assert.equal(await run(["ask", "claude-code", "x".repeat(2_001), "--agent-kind", "codex"], deps), 1);
  assert.match(err.join("\n"), /over 2,000 characters/);
});

// ---------------------------------------------------------------------------
// resolve / endpoints: read-only view of the durable endpoints
// ---------------------------------------------------------------------------

const CODEX_ENDPOINT = {
  id: "ep_0a1b2c3d000040008000000000000001",
  address: "@codex",
  provider: "codex",
  alias: "codex",
  generation: 7,
  status: "active",
  reachability: "live",
  presence: { state: "idle", confidence: "inferred", lastSeenAt: new Date().toISOString() },
  fidelity: { level: "LIVE_NATIVE", basis: "m9r_hosted_session", note: "M9R runs this session." },
  mine: true,
};

test("resolve prints reachability, presence confidence and fidelity for one endpoint", async () => {
  let asked = "";
  const { deps, out } = makeDeps({
    env: { OATHLOCK_API_URL: "http://localhost:3000" },
    files: askFiles(),
    router: (url) => {
      if (url.includes("/api/agent/endpoints/resolve")) {
        asked = new URL(url).searchParams.get("address") ?? "";
        return jsonResponse(200, { endpoint: CODEX_ENDPOINT });
      }
      return jsonResponse(404, { error: "nope" });
    },
  });

  const code = await run(["resolve", "@codex", "--agent-kind", "codex"], deps);

  assert.equal(code, 0);
  assert.equal(asked, "@codex");
  const text = out.join("\n");
  assert.match(text, /@codex {2}\(ep_0a1b2c3d000040008000000000000001\)/);
  assert.match(text, /generation: 7 {3}yours/);
  assert.match(text, /reachability: live/);
  assert.match(text, /presence: idle \(inferred\)/);
  assert.match(text, /fidelity: LIVE_NATIVE \(m9r_hosted_session\)/);
});

test("resolve shows the server's reason and any ambiguous candidates, and exits 1", async () => {
  const { deps, err } = makeDeps({
    env: { OATHLOCK_API_URL: "http://localhost:3000" },
    files: askFiles(),
    router: () => jsonResponse(409, { error: "More than one @codex is connected in this workspace.", code: "AMBIGUOUS_ENDPOINT", candidates: ["ep_aaa", "ep_bbb"] }),
  });

  const code = await run(["resolve", "codex", "--agent-kind", "codex"], deps);

  assert.equal(code, 1);
  assert.match(err.join("\n"), /More than one @codex is connected/);
  assert.match(err.join("\n"), /candidate: ep_aaa/);
  assert.match(err.join("\n"), /candidate: ep_bbb/);
});

test("resolve without an address prints usage and makes no request", async () => {
  const { deps, err, requests } = makeDeps({ env: { OATHLOCK_API_URL: "http://localhost:3000" }, files: askFiles() });
  assert.equal(await run(["resolve", "--agent-kind", "codex"], deps), 1);
  assert.match(err.join("\n"), /Usage: m9r-cli resolve/);
  assert.equal(requests.length, 0);
});

test("endpoints lists every endpoint in the workspace", async () => {
  const { deps, out } = makeDeps({
    env: { OATHLOCK_API_URL: "http://localhost:3000" },
    files: askFiles(),
    router: (url) => url.endsWith("/api/agent/endpoints")
      ? jsonResponse(200, { endpoints: [CODEX_ENDPOINT, { ...CODEX_ENDPOINT, id: "ep_0a1b2c3d000040008000000000000002", address: "@claude-code", provider: "claude-code", mine: false, reachability: "queue", presence: { state: "offline", confidence: "unknown", lastSeenAt: null } }] })
      : jsonResponse(404, { error: "nope" }),
  });

  assert.equal(await run(["endpoints", "--agent-kind", "codex"], deps), 0);
  const text = out.join("\n");
  assert.match(text, /endpoints: 2/);
  assert.match(text, /@claude-code/);
  assert.match(text, /reachability: queue/);
  assert.match(text, /last seen never/);
});

// ---------------------------------------------------------------------------
// delivery: per-recipient timeline of one message
// ---------------------------------------------------------------------------

const DELIVERY_REPORT = {
  messageId: "0a1b2c3d-0000-4000-8000-000000000001",
  conversationId: "conv-general",
  createdAt: "2026-09-19T05:00:00.000Z",
  deliveries: [{
    recipient: { address: "@claude-code", endpointId: "ep_1", provider: "claude-code" },
    state: "completed", terminal: true, attempt: 1, viaConsultation: false, pendingUntilTurnBoundary: false, failureCode: null,
    timeline: [
      { state: "accepted", at: "2026-09-19T05:00:00.000Z", attempt: 1, basis: "derived", evidence: "message stored" },
      { state: "delivered_to_node", at: "2026-09-19T05:00:01.000Z", attempt: 1, basis: "observed", evidence: "message.received", persisted: false },
      { state: "completed", at: "2026-09-19T05:00:09.000Z", attempt: 1, basis: "observed", evidence: "turn.completed" },
    ],
  }],
};

test("delivery prints each recipient's state and timeline, and says when the receipt is not persisted", async () => {
  let asked = "";
  const { deps, out } = makeDeps({
    env: { OATHLOCK_API_URL: "http://localhost:3000" },
    files: askFiles(),
    router: (url) => { asked = url; return jsonResponse(200, DELIVERY_REPORT); },
  });

  const code = await run(["delivery", "0a1b2c3d-0000-4000-8000-000000000001", "--agent-kind", "codex"], deps);

  assert.equal(code, 0);
  assert.match(asked, /\/api\/agent\/messages\/0a1b2c3d-0000-4000-8000-000000000001\/delivery$/);
  const text = out.join("\n");
  assert.match(text, /@claude-code: completed \(attempt 1\)/);
  assert.match(text, /05:00:01 {2}delivered_to_node +observed +message\.received \(bridge memory only; not saved to a local ledger\)/);
  assert.match(text, /05:00:09 {2}completed +observed +turn\.completed/);
});

test("delivery for a message that addressed no agent says so, and a missing id prints usage", async () => {
  const { deps, out, err } = makeDeps({
    env: { OATHLOCK_API_URL: "http://localhost:3000" },
    files: askFiles(),
    router: () => jsonResponse(200, { ...DELIVERY_REPORT, deliveries: [] }),
  });
  assert.equal(await run(["delivery", "0a1b2c3d-0000-4000-8000-000000000001", "--agent-kind", "codex"], deps), 0);
  assert.match(out.join("\n"), /nothing to deliver/);
  assert.equal(await run(["delivery", "--agent-kind", "codex"], deps), 1);
  assert.match(err.join("\n"), /Usage: m9r-cli delivery/);
});

test("delivery surfaces the server's not-found without leaking the token", async () => {
  const { deps, err } = makeDeps({
    env: { OATHLOCK_API_URL: "http://localhost:3000" },
    files: askFiles(),
    router: () => jsonResponse(404, { error: "Message was not found." }),
  });
  assert.equal(await run(["delivery", "0a1b2c3d-0000-4000-8000-000000000009", "--agent-kind", "codex"], deps), 1);
  assert.match(err.join("\n"), /Message was not found\./);
  assert.doesNotMatch(err.join("\n"), /oak_codex_token/);
});

test("ask --wait appends the delivery timeline after the reply when the server can provide it", async () => {
  const replies = [{ id: "msg-2", parent_message_id: "0a1b2c3d-0000-4000-8000-000000000001", sender_connection_id: "conn-claude", kind: "result", body: "Done.", created_at: "2026-09-19T05:00:09.000Z" }];
  const base = askRouter({ replies });
  const { deps, out } = makeDeps({
    env: { OATHLOCK_API_URL: "http://localhost:3000" },
    files: askFiles(),
    router: (url, init) => url.includes("/delivery") ? jsonResponse(200, DELIVERY_REPORT) : base(url, init),
  });

  assert.equal(await run(["ask", "claude-code", "status?", "--wait", "--agent-kind", "codex"], deps), 0);
  const text = out.join("\n");
  assert.match(text, /Done\./);
  assert.match(text, /Delivery:\n@claude-code: completed/);
});

test("delivery says when the bridge saved the receipt to its local ledger first", async () => {
  const report = { ...DELIVERY_REPORT, deliveries: [{ ...DELIVERY_REPORT.deliveries[0], timeline: DELIVERY_REPORT.deliveries[0].timeline.map((entry) => entry.state === "delivered_to_node" ? { ...entry, persisted: true } : entry) }] };
  const { deps, out } = makeDeps({ env: { OATHLOCK_API_URL: "http://localhost:3000" }, files: askFiles(), router: () => jsonResponse(200, report) });
  assert.equal(await run(["delivery", "0a1b2c3d-0000-4000-8000-000000000001", "--agent-kind", "codex"], deps), 0);
  assert.match(out.join("\n"), /saved in the bridge's local ledger first/);
});
