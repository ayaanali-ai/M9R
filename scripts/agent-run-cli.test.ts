/**
 * OathLock CLI — run lifecycle tests
 * ----------------------------------------------------------------------------
 * Covers `run start` / `run status`, the `.oathlock/run.json` active-run file,
 * and the wiring of `rules` (rules_loaded_count) and `submit-session` (run_id)
 * into the active run. In-memory fs + fake fetch; no real network.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { run, localPath, runPath, rulesPath, type CliDeps } from "../src/lib/oathlock-cli-core.ts";

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

function makeDeps(opts: { router?: Router; files?: Record<string, string> }) {
  const files = new Map<string, string>(Object.entries(opts.files ?? {}));
  const out: string[] = [];
  const err: string[] = [];
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const router: Router = opts.router ?? (() => jsonResponse(500, { error: "no router" }));

  const deps: CliDeps = {
    cwd: CWD,
    env: {},
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
    mkdir: async () => {},
    fileExists: async (p) => files.has(p),
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  };
  return { deps, files, out, err, requests };
}

const TOKEN_FILE = (token = "oak_tok_run") => ({ [localPath(CWD)]: JSON.stringify({ token }) });

// ---------------------------------------------------------------------------
// run start
// ---------------------------------------------------------------------------

test("run start writes the active run id to .oathlock/run.json", async () => {
  const { deps, files, requests } = makeDeps({
    files: TOKEN_FILE(),
    router: (url) =>
      url.includes("/api/agent/run/start")
        ? jsonResponse(201, { run_id: "run-123", status: "started" })
        : jsonResponse(404, {}),
  });

  const code = await run(["run", "start", "--task", "Fix the build"], deps);
  assert.equal(code, 0);

  const saved = JSON.parse(files.get(runPath(CWD))!);
  assert.equal(saved.run_id, "run-123");
  assert.equal(saved.task_title, "Fix the build");

  // The request carried the task title and used the Bearer token.
  const body = JSON.parse(String(requests[0].init!.body));
  assert.equal(body.task_title, "Fix the build");
  const headers = requests[0].init!.headers as Record<string, string>;
  assert.match(headers.authorization, /^Bearer /);
});

test("run start requires an existing local token", async () => {
  const { deps, err, requests } = makeDeps({ files: {} });
  const code = await run(["run", "start", "--task", "x"], deps);
  assert.equal(code, 1);
  assert.equal(requests.length, 0, "must not contact the API without a token");
  assert.match(err.join("\n"), /No token found/);
});

// ---------------------------------------------------------------------------
// run status
// ---------------------------------------------------------------------------

test("run status refuses without an active run", async () => {
  const { deps, err, requests } = makeDeps({ files: TOKEN_FILE() });
  const code = await run(["run", "status", "--phase", "reading files"], deps);
  assert.equal(code, 1);
  assert.equal(requests.length, 0, "must not contact the API without an active run");
  assert.match(err.join("\n"), /No active run/);
});

test("run status posts the phase for the active run", async () => {
  const { deps, requests } = makeDeps({
    files: { ...TOKEN_FILE(), [runPath(CWD)]: JSON.stringify({ run_id: "run-77" }) },
    router: () => jsonResponse(200, { ok: true, status: "working" }),
  });
  const code = await run(["run", "status", "--phase", "editing files"], deps);
  assert.equal(code, 0);
  const body = JSON.parse(String(requests[0].init!.body));
  assert.equal(body.run_id, "run-77");
  assert.equal(body.current_phase, "editing files");
});

// ---------------------------------------------------------------------------
// rules → rules_loaded_count
// ---------------------------------------------------------------------------

test("rules updates the active run with rules_loaded_count", async () => {
  const { deps, requests } = makeDeps({
    files: { ...TOKEN_FILE(), [runPath(CWD)]: JSON.stringify({ run_id: "run-9" }) },
    router: (url) => {
      if (url.includes("/api/agent/rules")) {
        return jsonResponse(200, {
          mode: "active",
          rules: [{ id: "r1", title: "A" }, { id: "r2", title: "B" }],
        });
      }
      return jsonResponse(200, { ok: true, status: "working" });
    },
  });

  const code = await run(["rules"], deps);
  assert.equal(code, 0);

  const statusReq = requests.find((r) => r.url.includes("/api/agent/run/status"));
  assert.ok(statusReq, "rules should post a run status update when a run is active");
  const body = JSON.parse(String(statusReq!.init!.body));
  assert.equal(body.run_id, "run-9");
  assert.equal(body.rules_loaded_count, 2);
});

test("rules does not post a run update when no run is active", async () => {
  const { deps, requests } = makeDeps({
    files: TOKEN_FILE(),
    router: () => jsonResponse(200, { mode: "baseline", rules: [] }),
  });
  const code = await run(["rules"], deps);
  assert.equal(code, 0);
  assert.ok(!requests.some((r) => r.url.includes("/api/agent/run/status")));
});

// ---------------------------------------------------------------------------
// submit-session → link to run
// ---------------------------------------------------------------------------

test("submit-session links to the active run via run_id when run.json exists", async () => {
  const sessionPath = join(CWD, "oathlock-session.md");
  const { deps, requests } = makeDeps({
    files: {
      ...TOKEN_FILE(),
      [runPath(CWD)]: JSON.stringify({ run_id: "run-link" }),
      [sessionPath]: "# session",
    },
    router: () => jsonResponse(200, { ok: true, rules: {} }),
  });

  const code = await run(["submit-session", "oathlock-session.md", "--approved"], deps);
  assert.equal(code, 0);
  const sessionReq = requests.find((r) => r.url.includes("/api/agent/session"));
  const body = JSON.parse(String(sessionReq!.init!.body));
  assert.equal(body.run_id, "run-link");
});

test("submit-session surfaces run linkage + snapshot persistence status", async () => {
  const sessionPath = join(CWD, "oathlock-session.md");
  const { deps, out } = makeDeps({
    files: {
      ...TOKEN_FILE(),
      [runPath(CWD)]: JSON.stringify({ run_id: "run-ok" }),
      [sessionPath]: "# session",
    },
    router: () =>
      jsonResponse(200, {
        ok: true,
        rules: {},
        rule_health: { evaluated: true, summary: { needs_review: 1 }, items: [{ status: "needs_review", title: "Stop retrying" }] },
        run_linked: true,
        linked_run_id: "run-ok",
        snapshots_persisted: true,
        warnings: [],
      }),
  });

  const code = await run(["submit-session", "oathlock-session.md", "--approved"], deps);
  assert.equal(code, 0);
  const text = out.join("\n");
  assert.match(text, /run linked: true/);
  assert.match(text, /linked run id: run-ok/);
  assert.match(text, /snapshots persisted: true/);
});

test("submit-session warns (does not silently pass) when the run could not be linked", async () => {
  const sessionPath = join(CWD, "oathlock-session.md");
  const { deps, out, err } = makeDeps({
    files: {
      ...TOKEN_FILE(),
      [runPath(CWD)]: JSON.stringify({ run_id: "run-foreign" }),
      [sessionPath]: "# session",
    },
    // Server evaluated Rule Health but could not link the run (e.g. FORBIDDEN).
    router: () =>
      jsonResponse(200, {
        ok: true,
        rules: {},
        rule_health: { evaluated: true, summary: { needs_review: 1 }, items: [] },
        run_linked: false,
        linked_run_id: null,
        snapshots_persisted: false,
        warnings: ["Run could not be linked to this session (FORBIDDEN). Two-run proof will not be available for this run; start the later run with the same connected workspace and resubmit."],
      }),
  });

  const code = await run(["submit-session", "oathlock-session.md", "--approved"], deps);
  assert.equal(code, 0);
  assert.match(out.join("\n"), /run linked: false/);
  const errText = err.join("\n");
  assert.match(errText, /Two-run proof will not be available/);
  assert.match(errText, /not linked/);
});

test("submit-session reports migration-required without faking proof readiness", async () => {
  const sessionPath = join(CWD, "oathlock-session.md");
  const { deps, out, err } = makeDeps({
    files: {
      ...TOKEN_FILE(),
      [runPath(CWD)]: JSON.stringify({ run_id: "run-nomig" }),
      [sessionPath]: "# session",
    },
    router: () =>
      jsonResponse(200, {
        ok: true,
        rules: {},
        rule_health: { evaluated: true, summary: { needs_review: 1 }, items: [] },
        run_linked: true,
        linked_run_id: "run-nomig",
        snapshots_persisted: false,
        migration_required: true,
        warnings: ["Run snapshot columns are missing in the deployed schema (migration required: apply supabase-agent-runs.sql). The session snapshot was still saved, so compare can hydrate from it."],
      }),
  });

  const code = await run(["submit-session", "oathlock-session.md", "--approved"], deps);
  assert.equal(code, 0);
  assert.match(out.join("\n"), /snapshots persisted: false/);
  assert.match(err.join("\n"), /migration required/i);
});

// ---------------------------------------------------------------------------
// compare / proof
// ---------------------------------------------------------------------------

test("compare requires both run ids and prints the server's conservative report", async () => {
  const { deps: noArgs, err } = makeDeps({ files: TOKEN_FILE() });
  assert.equal(await run(["compare"], noArgs), 1);
  assert.match(err.join("\n"), /--baseline-run <id> --later-run <id>/);

  const { deps, out, requests } = makeDeps({
    files: TOKEN_FILE(),
    router: () =>
      jsonResponse(200, {
        comparison: {
          baseline_run_id: "a",
          later_run_id: "b",
          rule_health_result: { evaluated: true, dominant: "followed" },
          behavioral_delta: [{ key: "repeatedFileEdits", label: "Repeated file edits", before: 3, after: 0, change: "improved" }],
          usage_delta: { available: false, message: "Usage comparison unavailable because one or both sessions did not include token/cost metadata." },
          output_quality_delta: { judgeable: false, message: "Output quality comparison requires external acceptance criteria or human review." },
          honest_verdict: "Evidence suggests this rule held in the later run.",
          limitations: ["This compares two sessions; an observed change is not proof that a rule caused it."],
        },
      }),
  });
  const code = await run(["compare", "--baseline-run", "a", "--later-run", "b"], deps);
  assert.equal(code, 0);
  assert.match(requests[0].url, /\/api\/agent\/compare\?baseline=a&later=b/);
  const text = out.join("\n");
  assert.match(text, /rule health: followed/);
  assert.match(text, /Repeated file edits: 3 → 0 \(improved\)/);
  assert.match(text, /Usage comparison unavailable/);
  // proof is an alias for compare.
  void rulesPath;
});

test("submit-session omits run_id when there is no active run", async () => {
  const sessionPath = join(CWD, "oathlock-session.md");
  const { deps, requests } = makeDeps({
    files: { ...TOKEN_FILE(), [sessionPath]: "# session" },
    router: () => jsonResponse(200, { ok: true, rules: {} }),
  });

  const code = await run(["submit-session", "oathlock-session.md", "--approved"], deps);
  assert.equal(code, 0);
  const sessionReq = requests.find((r) => r.url.includes("/api/agent/session"));
  const body = JSON.parse(String(sessionReq!.init!.body));
  assert.ok(!("run_id" in body));
  // unused import guard
  void rulesPath;
});
