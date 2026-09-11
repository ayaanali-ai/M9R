/**
 * OathLock CLI — per-agent run/adapter isolation tests
 * ----------------------------------------------------------------------------
 * Two agents in one repo must never fight over `.oathlock/run.json` or
 * `.oathlock/adapter.json` (the collision that broke coordinated dogfooding
 * on 2026-07-16: Codex's `run start` overwrote Claude Code's active run, and
 * signal emit then failed with "Run was not found for this connection").
 * In-memory fs + fake fetch; no real network.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  run,
  localPath,
  runPath,
  adapterPath,
  agentLocalPath,
  agentRunPath,
  agentAdapterPath,
  type CliDeps,
} from "../src/lib/oathlock-cli-core.ts";

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

function makeDeps(opts: { router?: Router; files?: Record<string, string>; env?: Record<string, string> }) {
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
    mkdir: async () => {},
    fileExists: async (p) => files.has(p),
    removeFile: async (p) => {
      files.delete(p);
    },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  };
  return { deps, files, out, err, requests };
}

const startRouter: Router = (url) =>
  url.includes("/api/agent/whoami")
    ? jsonResponse(200, { agentKind: "claude-code", workspaceId: "workspace-1", connectionId: "connection-1" })
    : url.includes("/api/agent/run/start")
    ? jsonResponse(201, { run_id: "run-claude", status: "started" })
    : url.includes("/api/agent/signals")
      ? jsonResponse(201, { signal: { server_sequence: 42 } })
      : url.includes("/api/agent/run/status")
        ? jsonResponse(200, { status: "working" })
        : jsonResponse(404, {});

test("run start under a detected agent kind writes the per-agent run.json, not the shared one", async () => {
  const { deps, files } = makeDeps({
    env: { OATHLOCK_AGENT_KIND: "claude-code" },
    files: { [agentLocalPath(CWD, "claude-code")]: JSON.stringify({ token: "oak_cc" }) },
    router: startRouter,
  });

  assert.equal(await run(["run", "start", "--task", "Isolated task"], deps), 0);
  const saved = JSON.parse(files.get(agentRunPath(CWD, "claude-code"))!);
  assert.equal(saved.run_id, "run-claude");
  assert.equal(saved.agent_kind, "claude-code");
  assert.ok(!files.has(runPath(CWD)), "the shared run.json must not be written for a detected agent kind");
});

test("a sibling agent's shared run.json is never claimed by a different kind", async () => {
  const { deps, err } = makeDeps({
    env: { OATHLOCK_AGENT_KIND: "claude-code" },
    files: {
      [agentLocalPath(CWD, "claude-code")]: JSON.stringify({ token: "oak_cc" }),
      // Codex's run sits in the legacy shared file, stamped with its kind.
      [runPath(CWD)]: JSON.stringify({ run_id: "run-codex", agent_kind: "codex" }),
    },
    router: startRouter,
  });

  const code = await run(["run", "status", "--phase", "testing"], deps);
  assert.equal(code, 1);
  assert.ok(err.some((line) => line.includes("No active run")), "must not report status against another agent's run");
});

test("a stale stamped legacy run.json is never used when kind detection itself fails", async () => {
  // Reproduces the 2026-07-19 bug: coordinate request ran in an environment
  // where CODEX_HOME/etc weren't inherited, so detectedAgentKind returned
  // null. The legacy file was still stamped "claude-code" from an earlier
  // session -- it must not be silently handed back as this call's run.
  const { deps, err } = makeDeps({
    env: {},
    files: {
      [localPath(CWD)]: JSON.stringify({ token: "oak_shared" }),
      [runPath(CWD)]: JSON.stringify({ run_id: "run-old-solo", agent_kind: "claude-code" }),
    },
    router: startRouter,
  });

  const code = await run(["run", "status", "--phase", "testing"], deps);
  assert.equal(code, 1);
  assert.ok(err.some((line) => line.includes("No active run")), "must not fall back to a stamped-for-another-kind run when kind detection fails");
});

test("a detected agent never claims an unstamped shared run.json", async () => {
  const { deps, err } = makeDeps({
    env: { OATHLOCK_AGENT_KIND: "claude-code" },
    files: {
      [agentLocalPath(CWD, "claude-code")]: JSON.stringify({ token: "oak_cc" }),
      [runPath(CWD)]: JSON.stringify({ run_id: "run-legacy" }),
    },
    router: startRouter,
  });

  assert.equal(await run(["run", "status", "--phase", "testing"], deps), 1);
  assert.ok(err.some((line) => line.includes("No active run")));
});

test("signal emit uses the per-agent run and a per-agent adapter sequence", async () => {
  const { deps, files, requests } = makeDeps({
    env: { OATHLOCK_AGENT_KIND: "claude-code" },
    files: {
      [agentLocalPath(CWD, "claude-code")]: JSON.stringify({ token: "oak_cc" }),
      [agentRunPath(CWD, "claude-code")]: JSON.stringify({ run_id: "run-claude", agent_kind: "claude-code" }),
      // A sibling's shared adapter state must not be inherited.
      [adapterPath(CWD)]: JSON.stringify({ adapter_instance_id: "adapter-codex-1", last_client_sequence: 7 }),
    },
    router: startRouter,
  });

  assert.equal(await run(["signal", "emit", "--type", "WORKING", "--summary", "isolated"], deps), 0);
  const body = JSON.parse(String(requests.find((r) => r.url.includes("/api/agent/signals"))?.init?.body));
  assert.equal(body.runId, "run-claude");
  assert.notEqual(body.adapterInstanceId, "adapter-codex-1");
  // A fresh per-agent adapter seeds its sequence from the legacy shared file so
  // this connection's counter never moves backwards (server replay protection).
  assert.equal(body.clientSequence, 8);
  assert.ok(files.has(agentAdapterPath(CWD, "claude-code")), "adapter state persists per-agent");
  assert.equal(JSON.parse(files.get(adapterPath(CWD))!).last_client_sequence, 7, "the sibling's adapter state is untouched");
});

test("disconnect never deletes a sibling agent's shared run pointer", async () => {
  const { deps, files } = makeDeps({
    env: { OATHLOCK_AGENT_KIND: "claude-code" },
    files: {
      [agentLocalPath(CWD, "claude-code")]: JSON.stringify({ token: "oak_cc" }),
      [agentRunPath(CWD, "claude-code")]: JSON.stringify({ run_id: "run-claude", agent_kind: "claude-code" }),
      [runPath(CWD)]: JSON.stringify({ run_id: "run-codex", agent_kind: "codex" }),
    },
    router: (url) => (url.includes("/api/agent/disconnect") ? jsonResponse(200, {}) : jsonResponse(404, {})),
  });

  assert.equal(await run(["disconnect"], deps), 0);
  assert.ok(!files.has(agentRunPath(CWD, "claude-code")), "own run pointer removed");
  assert.ok(files.has(runPath(CWD)), "the sibling's run pointer survives");
});
