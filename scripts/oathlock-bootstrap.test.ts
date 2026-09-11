/**
 * OathLock bootstrap — automatic agent workflow tests
 * ----------------------------------------------------------------------------
 * Covers the repo-native integration layer: init auto-bootstrap, the managed
 * block's idempotency and content boundaries, identity enforcement against the
 * approved connection, secrets discipline, and revocation behavior. Uses the
 * same in-memory deps harness as the CLI tests (no network, no repo writes).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync } from "node:fs";

import {
  run,
  localPath,
  configPath,
  type CliDeps,
} from "../src/lib/oathlock-cli-core.ts";
import {
  applyWorkflowBlock,
  bootstrapTargetFor,
  buildWorkflowBlock,
  inspectWorkflowBlock,
  removeWorkflowBlock,
  OATHLOCK_WORKFLOW_BLOCK_VERSION,
} from "../src/lib/oathlock-bootstrap-core.ts";

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
}) {
  const files = new Map<string, string>(Object.entries(opts.files ?? {}));
  const out: string[] = [];
  const err: string[] = [];

  const router: Router = opts.router ?? (() => jsonResponse(500, { error: "no router" }));

  const deps: CliDeps = {
    cwd: CWD,
    env: opts.env ?? {},
    fetch: (async (url: string | URL, init?: RequestInit) =>
      router(String(url), init)) as unknown as typeof fetch,
    readFile: async (p) => {
      if (files.has(p)) return files.get(p)!;
      throw new Error(`ENOENT: ${p}`);
    },
    writeFile: async (p, data) => {
      files.set(p, data);
    },
    removeFile: async (p) => {
      files.delete(p);
    },
    mkdir: async () => {},
    fileExists: async (p) => files.has(p),
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    pollIntervalMs: 0,
    maxPolls: 3,
    sleep: async () => {},
  };

  return { deps, files, out, err };
}

const TOKEN = "oak_bootstrap_secret_1234";

function connectedFiles(agentKind: string): Record<string, string> {
  return {
    [localPath(CWD)]: JSON.stringify({ token: TOKEN, scopes: ["rules:read"] }),
    [configPath(CWD)]: JSON.stringify({ agent_kind: agentKind, repo_hint: "repo" }),
  };
}

/** Router for a full init: register → approved claim with a token. */
function initRouter(): Router {
  return (url) => {
    if (url.includes("/api/agent/register")) {
      return jsonResponse(200, {
        claim_url: "https://oathlock.example/claim/abc",
        claim_id: "claim-1",
        setup_code: "setup-secret",
      });
    }
    if (url.includes("/api/agent/claim-status")) {
      return jsonResponse(200, { status: "approved", token: TOKEN, scopes: ["rules:read"] });
    }
    return jsonResponse(404, { error: "unknown" });
  };
}

// ---------------------------------------------------------------------------
// Bootstrap behavior
// ---------------------------------------------------------------------------

test("successful Codex init bootstraps AGENTS.md by default", async () => {
  const { deps, files, out } = makeDeps({ router: initRouter() });
  const code = await run(["init", "--agent-kind", "codex"], deps);
  assert.equal(code, 0);
  const agentsMd = files.get(join(CWD, "AGENTS.md"));
  assert.ok(agentsMd, "AGENTS.md must be created");
  assert.match(agentsMd!, /OATHLOCK:AUTOMATIC-WORKFLOW:START/);
  const text = out.join("\n");
  assert.match(text, /Connected agent: Codex/);
  assert.match(text, /Automatic M9R workflow installed in AGENTS\.md/);
  assert.match(text, /Agents can now use M9R during normal repo tasks\./);
});

test("successful Claude Code init bootstraps CLAUDE.md", async () => {
  const { deps, files, out } = makeDeps({ router: initRouter() });
  const code = await run(["init", "--agent-kind", "claude-code"], deps);
  assert.equal(code, 0);
  assert.ok(files.get(join(CWD, "CLAUDE.md")));
  assert.ok(!files.has(join(CWD, "AGENTS.md")), "Claude Code must not write AGENTS.md");
  assert.match(out.join("\n"), /Connected agent: Claude/);
  assert.match(out.join("\n"), /Automatic M9R workflow installed in CLAUDE\.md/);
});

test("--skip-bootstrap connects without touching instruction files", async () => {
  const { deps, files, out } = makeDeps({ router: initRouter() });
  const code = await run(["init", "--agent-kind", "codex", "--skip-bootstrap"], deps);
  assert.equal(code, 0);
  assert.ok(!files.has(join(CWD, "AGENTS.md")));
  assert.match(out.join("\n"), /Skipped automatic workflow install/);
  assert.match(out.join("\n"), /npx m9r-cli bootstrap --agent-kind codex/);
});

test("bootstrap --agent-kind codex writes the managed block into AGENTS.md", async () => {
  const { deps, files, out } = makeDeps({ files: connectedFiles("codex") });
  const code = await run(["bootstrap", "--agent-kind", "codex"], deps);
  assert.equal(code, 0);
  const content = files.get(join(CWD, "AGENTS.md"))!;
  assert.match(content, /OATHLOCK:AUTOMATIC-WORKFLOW:START v\d+/);
  assert.match(content, /OATHLOCK:AUTOMATIC-WORKFLOW:END/);
  assert.match(out.join("\n"), /installed in AGENTS\.md/);
});

test("running bootstrap twice is idempotent — one block, 'no changes' report", async () => {
  const { deps, files, out } = makeDeps({ files: connectedFiles("codex") });
  assert.equal(await run(["bootstrap"], deps), 0);
  const first = files.get(join(CWD, "AGENTS.md"))!;
  assert.equal(await run(["bootstrap"], deps), 0);
  const second = files.get(join(CWD, "AGENTS.md"))!;
  assert.equal(first, second);
  assert.equal(second.match(/OATHLOCK:AUTOMATIC-WORKFLOW:START/g)?.length, 1);
  assert.match(out.join("\n"), /No changes needed/);
});

test("existing user content is preserved exactly around the managed block", async () => {
  const userContent = "# My project rules\n\nAlways use tabs.\n";
  const { deps, files } = makeDeps({
    files: { ...connectedFiles("codex"), [join(CWD, "AGENTS.md")]: userContent },
  });
  assert.equal(await run(["bootstrap"], deps), 0);
  const content = files.get(join(CWD, "AGENTS.md"))!;
  assert.ok(content.startsWith(userContent), "user content must stay byte-identical at the top");
  assert.match(content, /OATHLOCK:AUTOMATIC-WORKFLOW:START/);
});

test("an existing managed block (older version) is updated in place, not duplicated", () => {
  const stale = [
    "# User heading",
    "",
    "<!-- OATHLOCK:AUTOMATIC-WORKFLOW:START v0 -->",
    "old instructions",
    "<!-- OATHLOCK:AUTOMATIC-WORKFLOW:END -->",
    "",
    "trailing user notes",
    "",
  ].join("\n");
  const result = applyWorkflowBlock(stale, "codex");
  assert.equal(result.action, "updated");
  assert.equal(result.content.match(/OATHLOCK:AUTOMATIC-WORKFLOW:START/g)?.length, 1);
  assert.ok(result.content.startsWith("# User heading"));
  assert.ok(result.content.includes("trailing user notes"));
  assert.ok(!result.content.includes("old instructions"));
});

test("'other' agent kind never claims guaranteed automatic loading", async () => {
  const target = bootstrapTargetFor("other");
  assert.equal(target.file, "OATHLOCK.md");
  assert.equal(target.automatic, false);
  assert.match(buildWorkflowBlock("other"), /Automatic loading is NOT assured/);

  const { deps, out } = makeDeps({ files: connectedFiles("other") });
  assert.equal(await run(["bootstrap"], deps), 0);
  assert.match(out.join("\n"), /automatic loading is not assured/i);
});

test("a conflicting requested kind fails clearly — the approved connection is authoritative", async () => {
  const { deps, files, err } = makeDeps({ files: connectedFiles("codex") });
  const code = await run(["bootstrap", "--agent-kind", "claude-code"], deps);
  assert.equal(code, 1);
  assert.ok(!files.has(join(CWD, "CLAUDE.md")));
  assert.ok(!files.has(join(CWD, "AGENTS.md")));
  assert.match(err.join("\n"), /approved connection is Codex/);
  assert.match(err.join("\n"), /authoritative/);
});

test("a malformed --agent-kind fails clearly (not just an unrecognized one)", async () => {
  const { deps, err } = makeDeps({ files: connectedFiles("codex") });
  const code = await run(["bootstrap", "--agent-kind", "Skynet Prime!"], deps);
  assert.equal(code, 1);
  assert.match(err.join("\n"), /lowercase letters, numbers, and hyphens/);
});

test("bootstrap without a connection fails and points at init", async () => {
  const { deps, err } = makeDeps({});
  const code = await run(["bootstrap", "--agent-kind", "codex"], deps);
  assert.equal(code, 1);
  assert.match(err.join("\n"), /no approved connection found/);
  assert.match(err.join("\n"), /npx m9r-cli init/);
});

test("bootstrap remove strips only the managed block and preserves user content", async () => {
  const userContent = "# Keep me\n";
  const { deps, files, out } = makeDeps({
    files: { ...connectedFiles("codex"), [join(CWD, "AGENTS.md")]: userContent },
  });
  assert.equal(await run(["bootstrap"], deps), 0);
  assert.equal(await run(["bootstrap", "remove"], deps), 0);
  const content = files.get(join(CWD, "AGENTS.md"))!;
  assert.ok(content.includes("# Keep me"));
  assert.ok(!content.includes("OATHLOCK:AUTOMATIC-WORKFLOW"));
  assert.match(out.join("\n"), /User-authored content was preserved/);
});

test("an agent kind with no specific integration (e.g. cursor) falls back to the same manual OATHLOCK.md path 'other' used to mean, under its real name", async () => {
  const target = bootstrapTargetFor("cursor");
  assert.equal(target.file, "OATHLOCK.md");
  assert.equal(target.automatic, false);

  const { deps, out, files } = makeDeps({ files: connectedFiles("cursor") });
  assert.equal(await run(["bootstrap"], deps), 0);
  assert.match(out.join("\n"), /automatic loading is not assured/i);
  // No Cursor-specific integration file exists, so none gets written --
  // it lands on the generic OATHLOCK.md path, not a fabricated Cursor one.
  assert.equal(files.get(join(CWD, ".cursor/rules/oathlock.mdc")), undefined);
});

test("grok build bootstrap targets AGENTS.md", () => {
  assert.equal(bootstrapTargetFor("grok-build").file, "AGENTS.md");
  assert.equal(bootstrapTargetFor("codex").file, "AGENTS.md");
  assert.equal(bootstrapTargetFor("claude-code").file, "CLAUDE.md");
});

// ---------------------------------------------------------------------------
// Status reporting
// ---------------------------------------------------------------------------

test("bootstrap status reports missing, installed, and outdated safely", async () => {
  const { deps, files, out } = makeDeps({ files: connectedFiles("codex") });
  assert.equal(await run(["bootstrap", "status"], deps), 1);
  assert.match(out.join("\n"), /workflow: missing/);

  out.length = 0;
  assert.equal(await run(["bootstrap"], deps), 0);
  out.length = 0;
  assert.equal(await run(["bootstrap", "status"], deps), 0);
  const text = out.join("\n");
  assert.match(text, /agent kind: Codex \(codex\)/);
  assert.match(text, /integration file: AGENTS\.md/);
  assert.match(text, /workflow: installed/);
  assert.match(text, new RegExp(`managed block version: ${OATHLOCK_WORKFLOW_BLOCK_VERSION}`));

  // Outdated: rewrite the block with a stale version marker.
  const path = join(CWD, "AGENTS.md");
  files.set(path, files.get(path)!.replace(/START v\d+/, "START v0").replace("## OathLock", "## Old OathLock"));
  out.length = 0;
  assert.equal(await run(["bootstrap", "status"], deps), 1);
  assert.match(out.join("\n"), /workflow: outdated/);
});

test("bootstrap status on a revoked connection reports the file but an inactive connection", async () => {
  // Workflow file exists, but no local token (disconnect removed it).
  const { deps, out } = makeDeps({
    files: {
      [configPath(CWD)]: JSON.stringify({ agent_kind: "codex" }),
      [join(CWD, "AGENTS.md")]: applyWorkflowBlock(null, "codex").content,
    },
  });
  assert.equal(await run(["bootstrap", "status"], deps), 0);
  const text = out.join("\n");
  assert.match(text, /workflow: installed/);
  assert.match(text, /connection: inactive \(no local token\)/);
  assert.match(text, /human reconnects/);
});

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

test("managed files contain no tokens, claim URLs, config values, or secrets", async () => {
  const { deps, files } = makeDeps({ router: initRouter() });
  assert.equal(await run(["init", "--agent-kind", "codex"], deps), 0);
  const content = files.get(join(CWD, "AGENTS.md"))!;
  assert.ok(!content.includes(TOKEN));
  assert.ok(!content.includes("setup-secret"));
  assert.ok(!content.includes("claim_url"));
  assert.ok(!content.includes("oathlock.example/claim"));
  assert.ok(!/oak_[A-Za-z0-9]/.test(content));
  assert.ok(!/Bearer/i.test(content));
  // The block warns against reading local config rather than referencing values from it.
  assert.match(content, /`\.oathlock\/local\.json`/);
});

test("bootstrap error output never reveals local config contents", async () => {
  const { deps, err } = makeDeps({
    files: {
      [localPath(CWD)]: JSON.stringify({ token: TOKEN }),
      [configPath(CWD)]: JSON.stringify({ agent_kind: "codex" }),
    },
  });
  await run(["bootstrap", "--agent-kind", "claude-code"], deps);
  const text = err.join("\n");
  assert.ok(!text.includes(TOKEN));
});

test("a revoked connection cannot continue OathLock-controlled work", async () => {
  // After disconnect, the token is gone; workflow-required commands fail safely
  // and instruct reconnection rather than proceeding.
  const { deps, err } = makeDeps({});
  assert.equal(await run(["rules"], deps), 1);
  assert.equal(await run(["inbox"], deps), 1);
  assert.equal(await run(["run", "start", "--task", "x"], deps), 1);
  assert.match(err.join("\n"), /No token found\. Run: m9r-cli init/);
});

test("bootstrap and remove never touch historical run or connection records", async () => {
  const runJson = JSON.stringify({ run_id: "run-1" });
  const { deps, files } = makeDeps({
    files: { ...connectedFiles("codex"), [join(CWD, ".oathlock/run.json")]: runJson },
  });
  assert.equal(await run(["bootstrap"], deps), 0);
  assert.equal(await run(["bootstrap", "remove"], deps), 0);
  assert.equal(files.get(join(CWD, ".oathlock/run.json")), runJson);
  assert.ok(files.has(localPath(CWD)), "local connection must be preserved");
});

// ---------------------------------------------------------------------------
// Managed workflow content — the operational contract
// ---------------------------------------------------------------------------

test("managed instructions cover the full workflow with the real CLI commands", () => {
  const block = buildWorkflowBlock("codex");
  assert.match(block, /npx m9r-cli doctor/);
  assert.match(block, /npx m9r-cli rules/);
  assert.match(block, /npx m9r-cli run start --task/);
  assert.match(block, /explicitly asks.*collaborat/i);
  assert.match(block, /--mode coordinated/);
  assert.match(block, /Normal single-agent work remains `solo`/);
  assert.match(block, /npx m9r-cli inbox/);
  assert.match(block, /npx m9r-cli run status --phase/);
  assert.match(block, /waiting for human review/);
  assert.match(block, /M9R Evidence Draft/);
  assert.match(block, /submit-session <file> --approved/);
});

test("shared AGENTS instructions never pin the repository to one provider identity", () => {
  for (const kind of ["codex", "opencode"] as const) {
    const block = buildWorkflowBlock(kind);
    assert.match(block, /shared repository workflow for multiple agent identities/i);
    assert.match(block, /authenticated M9R connection/i);
    assert.doesNotMatch(block, /Connected agent identity:/i);
  }
});

test("every integration requires the structured redacted evidence draft", () => {
  const fields = [
    "Agent:",
    "Task:",
    "Controlled run:",
    "Active rules loaded:",
    "Inbox status:",
    "Scope changes:",
    "Changes (files):",
    "Verification (command/result):",
    "Failed commands:",
    "Limitations:",
    "Sensitive areas:",
    "Status: Awaiting human approval",
  ];

  for (const kind of ["codex", "claude-code", "grok-build", "other"] as const) {
    const block = buildWorkflowBlock(kind);
    assert.match(block, /redacted `M9R Evidence Draft`/);
    for (const field of fields) {
      assert.ok(block.includes(field), `${kind} block must require ${field}`);
    }
    assert.match(block, /actual verification commands and actual pass\/fail results/);
    assert.match(block, /Never claim a command passed unless it was run/);
    assert.match(block, /limitations or `None identified`/);
    assert.match(block, /tokens, cookies, claim URLs, environment values, private keys/);
    assert.match(block, /raw local configuration or `\.oathlock` config contents/);
  }
});

test("evidence draft is prepared before waiting status and cannot be self-approved or auto-submitted", () => {
  const block = buildWorkflowBlock("codex");
  assert.ok(
    block.indexOf("M9R Evidence Draft") < block.indexOf("waiting for human review"),
    "the draft must be prepared before the run moves to waiting",
  );
  assert.match(block, /Do not submit, approve, or record the draft/);
  assert.match(block, /human explicitly approves that exact draft/);
  assert.match(block, /temporary submission artifact/);
  assert.match(block, /must not be committed or staged/);
  assert.match(block, /must materially match the approved draft/);
  assert.match(block, /Never mark your own work reviewed or accepted/);
  assert.ok(!block.includes("approved evidence"), "the unreviewed draft must not call itself approved evidence");
});

test("managed instructions enforce the human approval boundary", () => {
  const block = buildWorkflowBlock("codex");
  assert.match(block, /only\s+after a human has approved/);
  assert.match(block, /Never mark your\s+own work reviewed or accepted/);
  assert.match(block, /never record a human review decision/);
  assert.match(block, /never claim human approval/i);
  assert.match(block, /Never reconnect on\s+your own/);
  assert.match(block, /Do not commit, push, deploy, publish, stage files, or run migrations/);
});

test("managed instructions apply automatically without 'use OathLock' prompting", () => {
  const block = buildWorkflowBlock("codex");
  assert.match(block, /does not need to say "use M9R"/);
  assert.ok(!/ask the user whether/i.test(block));
});

test("managed instructions scope the workflow to repo tasks only", () => {
  const block = buildWorkflowBlock("codex");
  assert.match(block, /modifies or analyzes this\s+repo/);
  assert.match(block, /Do NOT start a controlled run for\s+casual conversation/);
  assert.match(block, /tasks unrelated to\s+this repo/);
});

test("managed instructions prevent duplicate and misattached runs", () => {
  const block = buildWorkflowBlock("codex");
  assert.match(block, /current runtime's scoped\s+run pointer/);
  assert.match(block, /\.oathlock\/agents\/<authenticated-kind>\/run\.json/);
  assert.match(block, /never\s+read another provider's pointer/);
  assert.match(block, /attach to it/);
  assert.match(block, /Never create a second\s+run for the same task/);
  assert.match(block, /never attach to an\s+unrelated or historical run/);
  assert.match(block, /old runs are history, not current work/);
});

test("managed instructions carry no overclaiming or control language", () => {
  for (const kind of ["codex", "claude-code", "grok-build", "other"] as const) {
    const block = buildWorkflowBlock(kind).toLowerCase();
    for (const banned of ["remote control", "forced compliance", "proof of correctness", "guaranteed safety", "intercept"]) {
      assert.ok(!block.includes(banned), `${kind} block must not contain "${banned}"`);
    }
  }
});

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

test("workflow blocks defer identity to the authenticated connection", () => {
  assert.match(buildWorkflowBlock("codex"), /shared repository workflow for multiple agent identities/);
  assert.match(buildWorkflowBlock("claude-code"), /authenticated M9R connection/);
  assert.match(buildWorkflowBlock("codex"), /never claim a different agent identity/);
  assert.doesNotMatch(buildWorkflowBlock("codex"), /Connected agent identity:/);
});

test("run start attribution comes from the connection, not caller input", () => {
  // The CLI no longer sends agent_kind on run start; the server derives it from
  // the Bearer connection. Structural check on the current source.
  const core = readFileSync("src/lib/oathlock-cli-core.ts", "utf8");
  const runStart = core.slice(core.indexOf("async function cmdRunStart"), core.indexOf("async function cmdRunStatus"));
  assert.ok(!/agent_kind/.test(runStart), "run start must not send caller-supplied agent_kind");
  const service = readFileSync("src/lib/agent-run-service.ts", "utf8");
  assert.match(service, /const agentKind = agent\.agentKind \?\? null;/);
  const route = readFileSync("src/app/api/agent/run/start/route.ts", "utf8");
  assert.ok(!/agentKind: typeof body\.agent_kind/.test(route), "the route must not forward caller-supplied agent_kind");
});

test("inspectWorkflowBlock reports presence, version, and currency", () => {
  assert.deepEqual(inspectWorkflowBlock(null, "codex"), { present: false, version: null, current: false });
  const fresh = applyWorkflowBlock(null, "codex").content;
  const status = inspectWorkflowBlock(fresh, "codex");
  assert.equal(status.present, true);
  assert.equal(status.version, OATHLOCK_WORKFLOW_BLOCK_VERSION);
  assert.equal(status.current, true);
  const stale = fresh.replace("## M9R", "## Tampered");
  assert.equal(inspectWorkflowBlock(stale, "codex").current, false);
});

test("removeWorkflowBlock is a no-op without a block", () => {
  const result = removeWorkflowBlock("# just user content\n");
  assert.equal(result.changed, false);
  assert.equal(result.content, "# just user content\n");
});

// ---------------------------------------------------------------------------
// CLI surface
// ---------------------------------------------------------------------------

test("help documents the bootstrap commands and the honest limitation", async () => {
  const { deps, out } = makeDeps({});
  await run(["help"], deps);
  const text = out.join("\n");
  assert.match(text, /m9r-cli bootstrap \[--agent-kind <kind>\]/);
  assert.match(text, /m9r-cli bootstrap status/);
  assert.match(text, /m9r-cli bootstrap remove/);
  assert.match(text, /--skip-bootstrap/);
  assert.match(text, /agents prepare a redacted M9R Evidence Draft automatically/);
  assert.match(text, /humans approve that exact draft/);
  assert.match(text, /M9R records it only after approval/);
  assert.match(text, /does not intercept arbitrary external\s*\n?agent sessions/);
});
