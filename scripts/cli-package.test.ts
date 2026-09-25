/**
 * CLI distribution — packaging tests
 * ----------------------------------------------------------------------------
 * Verifies the packaged CLI is shippable: correct package/bin shape, a built
 * distributable that runs from an EXTERNAL workspace cwd with no repo-only TS
 * loader, local files created under that external cwd (not the repo), the
 * approval + token-masking guarantees survive compilation, and the npm `files`
 * allowlist can't leak secrets/test artifacts.
 *
 * It compiles the CLI first (the same step `npm pack`'s prepack runs), then
 * imports the COMPILED JS — proving runtime imports work after packing.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const repoRoot = process.cwd();
const distDir = resolve(repoRoot, "cli", "dist");

// Build once before the suite (mirrors prepack).
execFileSync("node", [resolve(repoRoot, "scripts", "build-cli.mjs")], { stdio: "pipe" });

const pkg = JSON.parse(readFileSync(resolve(repoRoot, "cli", "package.json"), "utf8"));

// Import the COMPILED core (not the TS source) to prove packing works.
const core = await import(pathToFileURL(resolve(distDir, "oathlock-cli-core.js")).href);

const EXTERNAL_CWD = "/external/workspace";

async function removeTempWorkspace(workspace: string): Promise<void> {
  // The runtime deliberately detaches its watchdog so it can survive a
  // parent-shell teardown in production. In this isolated test workspace,
  // stop that known test-owned watchdog before removing the cwd; otherwise
  // Windows keeps the directory open and reports EPERM even though the main
  // child has exited.
  if (process.platform === "win32") {
    try {
      const lockPath = resolve(workspace, ".oathlock", "watchdog.lock");
      const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown };
      if (typeof lock.pid === "number" && Number.isInteger(lock.pid) && lock.pid > 0) {
        execFileSync("taskkill", ["/PID", String(lock.pid), "/T", "/F"], { stdio: "ignore" });
      }
    } catch {
      // No watchdog, or it already exited; normal cleanup below still applies.
    }
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      rmSync(workspace, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  if (existsSync(workspace) && lastError) throw lastError;
}

interface FakeResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}
function makeDeps(opts: { files?: Record<string, string>; router?: () => FakeResponse }) {
  const files = new Map<string, string>(Object.entries(opts.files ?? {}));
  const out: string[] = [];
  const err: string[] = [];
  const deps = {
    cwd: EXTERNAL_CWD,
    env: {},
    fetch: (async () => opts.router?.() ?? { ok: false, status: 500, text: async () => "{}" }) as unknown,
    readFile: async (p: string) => {
      if (files.has(p)) return files.get(p)!;
      throw new Error(`ENOENT ${p}`);
    },
    writeFile: async (p: string, data: string) => {
      files.set(p, data);
    },
    mkdir: async () => {},
    fileExists: async (p: string) => files.has(p),
    out: (l: string) => out.push(l),
    err: (l: string) => err.push(l),
    pollIntervalMs: 0,
    maxPolls: 2,
    sleep: async () => {},
  };
  return { deps, files, out, err };
}

// ---------------------------------------------------------------------------
// Package / bin shape
// ---------------------------------------------------------------------------

test("package.json has the publishable bin/metadata shape", () => {
  assert.equal(pkg.name, "m9r-cli");
  assert.ok(typeof pkg.version === "string" && /^\d+\.\d+\.\d+/.test(pkg.version));
  assert.ok(pkg.description && pkg.description.length > 10);
  assert.equal(pkg.bin["m9r-cli"], "dist/m9r.js");
  assert.equal(pkg.bin.m9r, "dist/m9r.js");
  assert.equal(pkg.bin.oathlock, "dist/oathlock.js");
  assert.ok(pkg.license, "license placeholder required");
  assert.ok(pkg.repository, "repository required for publishing");
  assert.deepEqual(pkg.files, ["dist/", "README.md"]);
  assert.ok(pkg.dependencies?.["node-pty"], "packaged terminal bridge requires node-pty");
  assert.ok(pkg.dependencies?.ws, "packaged terminal bridge requires ws");
});

test("npm files allowlist cannot leak secrets or test artifacts", () => {
  const banned = [".env", ".oathlock", "local.json", "rules.json", "scripts", "src", "test"];
  for (const entry of pkg.files as string[]) {
    for (const b of banned) {
      assert.ok(!entry.includes(b), `files entry "${entry}" must not include ${b}`);
    }
  }
});

test("built entry has the correct shebang and a relative core import", () => {
  const entry = readFileSync(resolve(distDir, "m9r.js"), "utf8");
  const compatibilityEntry = readFileSync(resolve(distDir, "oathlock.js"), "utf8");
  const builtCore = readFileSync(resolve(distDir, "oathlock-cli-core.js"), "utf8");
  const memoryExportCore = readFileSync(resolve(distDir, "memory-export-core.js"), "utf8");
  assert.ok(entry.startsWith("#!/usr/bin/env node\n"), "missing shebang");
  assert.match(entry, /from "\.\/oathlock-cli-core\.js"/);
  assert.ok(!entry.includes("@/lib/"), "alias import must be rewritten");
  assert.ok(!builtCore.includes("@/lib/"), "compiled core must not retain repository-only aliases");
  assert.ok(!memoryExportCore.includes("@/lib/"), "compiled memory exporter must not retain repository-only aliases");
  assert.match(builtCore, /from "\.\/adapter-contract\.js"/);
  assert.ok(existsSync(resolve(distDir, "oathlock-cli-core.js")));
  assert.equal(compatibilityEntry, entry, "legacy oathlock entry must remain the same compiled CLI");
  assert.ok(existsSync(resolve(distDir, "adapter-contract.js")));
  assert.ok(existsSync(resolve(distDir, "agent-task-routing.js")));
  assert.ok(existsSync(resolve(distDir, "opencode-capture-backfill-core.js")));
  assert.ok(!readFileSync(resolve(distDir, "resident-provider-adapters.js"), "utf8").includes("@/lib/"));
  assert.ok(!readFileSync(resolve(distDir, "oathlock-resident-core.js"), "utf8").includes("@/lib/"));
});

test("built CLI ships the local terminal bridge and routes terminal bridge to it", () => {
  const entry = readFileSync(resolve(distDir, "m9r.js"), "utf8");
  const bridgeFiles = [
    "local-terminal-protocol.js",
    "local-terminal-bridge-core.js",
    "local-terminal-session-manager.js",
    "local-mission-bridge-runner.js",
    "workspace-turn-timing.js",
    "mission-participant-ids.js",
    "workspace-cursor.js",
    "chat-evidence-schema.js",
    "resident-supervisor.js",
    "resident-profile-source.js",
    "oathlock-terminal-bridge.js",
    "opencode-capture-backfill-core.js",
  ];

  assert.match(entry, /\.\/oathlock-terminal-bridge\.js/);
  assert.match(entry, /\.\/resident-supervisor\.js/);
  assert.match(entry, /startTerminalRuntime/);
  for (const file of bridgeFiles) {
    const built = readFileSync(resolve(distDir, file), "utf8");
    assert.ok(!built.includes("@/lib/"), `${file} must not retain repository-only aliases`);
    assert.ok(!built.includes("../../../src/"), `${file} must not retain repository-relative imports`);
  }
});

test("built mission bridge runtime has no unresolved monorepo source imports", () => {
  const bridgeRuntime = readFileSync(resolve(distDir, "bridge-runtime.js"), "utf8");
  assert.doesNotMatch(bridgeRuntime, /\.\.\/\.\.\/\.\.\/src\/lib\//);
});

test("packed CLI entry boots the terminal runtime without printing a pairing secret", { timeout: 20_000 }, async () => {
  const port = 43_120;
  const child = spawn(process.execPath, [resolve(distDir, "m9r.js"), "terminal", "bridge"], {
    cwd: repoRoot,
    env: { ...process.env, OATHLOCK_BRIDGE_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });

  try {
    const output = await new Promise<string>((resolveOutput, reject) => {
      let stdout = "";
      const timer = setTimeout(() => reject(new Error(`Packaged bridge did not start: ${stderr}`)), 10_000);
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        if (stdout.includes(`Endpoint: ws://127.0.0.1:${port}/terminal`)) {
          clearTimeout(timer);
          resolveOutput(stdout);
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Packaged bridge exited early with ${code}: ${stderr}`));
      });
    });
    assert.match(output, /M9R local runtime is running/);
    assert.doesNotMatch(output, /Pairing token:/);
  } finally {
    child.kill();
  }
});

test("packed CLI runtime uses the compiled mission runner for connected providers", { timeout: 20_000 }, async () => {
  const port = 43_121;
  const workspace = mkdtempSync(resolve(tmpdir(), "oathlock-cli-runtime-"));
  const localTokenPath = resolve(workspace, ".oathlock", "agents", "codex", "local.json");
  mkdirSync(dirname(localTokenPath), { recursive: true });
  // The token only exercises provider discovery. ACP is disabled for this
  // fixture, so the child exits before making any network or provider call.
  writeFileSync(localTokenPath, JSON.stringify({ token: "oak_test_fixture_token" }), "utf8");

  const child = spawn(process.execPath, [resolve(distDir, "m9r.js"), "terminal", "runtime"], {
    cwd: workspace,
    // Keep the packaged-runtime test isolated from the developer's real
    // machine credentials and native-event store. The runtime starts its
    // metadata sync from the OS home directory, independently of cwd.
    // Do not let startup recovery discover or launch the developer's globally
    // installed provider CLIs while this packaging test is running.
    env: { ...process.env, HOME: workspace, USERPROFILE: workspace, PATH: workspace, ACP_BRIDGE_ENABLED: "false", M9R_TEST_DISABLE_WATCHDOG: "1", OATHLOCK_BRIDGE_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });

  try {
    await new Promise<void>((resolveOutput, reject) => {
      const timer = setTimeout(() => reject(new Error(`Packaged runtime did not start: ${stderr}`)), 10_000);
      const onData = () => {
        if (!stdout.includes(`Endpoint: ws://127.0.0.1:${port}/terminal`)) return;
        clearTimeout(timer);
        child.stdout.off("data", onData);
        // Give the asynchronous provider-child launch a moment to surface a
        // bad compiled entry before the assertions below run.
        setTimeout(resolveOutput, 250);
      };
      child.stdout.on("data", onData);
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Packaged runtime exited early with ${code}: ${stderr}`));
      });
    });
    assert.match(stdout, /M9R local runtime is running/);
    assert.doesNotMatch(`${stdout}\n${stderr}`, /Cannot find module ['"]tsx\/cli/);
    assert.doesNotMatch(`${stdout}\n${stderr}`, /ERR_MODULE_NOT_FOUND|Cannot find module/);
  } finally {
    // The connected runtime may start helper processes. Kill this test-owned
    // process tree before deleting its cwd; killing only the Node parent can
    // leave a child holding the temporary workspace open on Windows.
    if (process.platform === "win32" && child.pid !== undefined) {
      try {
        execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } catch {
        // The process may already have exited; removeTempWorkspace handles its watchdog too.
      }
    }
    if (child.exitCode === null) {
      child.kill();
      await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
    }
    await removeTempWorkspace(workspace);
  }
});

test("packed CLI local-only runtime starts without a hosted token or mission bridge", { timeout: 20_000 }, async () => {
  const port = 43_122;
  const workspace = mkdtempSync(resolve(tmpdir(), "m9r-cli-local-only-"));
  const child = spawn(process.execPath, [resolve(distDir, "m9r.js"), "terminal", "runtime", "--local-only"], {
    cwd: workspace,
    env: { ...process.env, OATHLOCK_BRIDGE_PORT: String(port), M9R_TEST_DISABLE_WATCHDOG: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });

  try {
    await new Promise<void>((resolveOutput, reject) => {
      const timer = setTimeout(() => reject(new Error(`Packaged local-only runtime did not start: ${stderr}`)), 10_000);
      const onData = () => {
        if (!stdout.includes(`Endpoint: ws://127.0.0.1:${port}/terminal`)) return;
        clearTimeout(timer);
        child.stdout.off("data", onData);
        setTimeout(resolveOutput, 250);
      };
      child.stdout.on("data", onData);
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Packaged local-only runtime exited early with ${code}: ${stderr}`));
      });
    });
    assert.match(stdout, /M9R local-only runtime/);
    assert.doesNotMatch(`${stdout}\n${stderr}`, /Mission ACP Bridge|fetch failed|ERR_MODULE_NOT_FOUND/);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
    }
    await removeTempWorkspace(workspace);
  }
});

// ---------------------------------------------------------------------------
// Compiled runtime behavior from an external cwd
// ---------------------------------------------------------------------------

test("compiled CLI: doctor fails cleanly without a token (external cwd)", async () => {
  const { deps, out } = makeDeps({});
  const code = await core.run(["doctor"], deps);
  assert.equal(code, 1);
  assert.match(out.join("\n"), /\[FAIL\] token present/);
});

test("compiled CLI help does not carry a hardcoded version label that can drift from npm", async () => {
  const { deps, out } = makeDeps({});
  const code = await core.run([], deps);
  assert.equal(code, 1);
  assert.doesNotMatch(out.join("\n"), /\(v0\)/);
  assert.match(out.join("\n"), /m9r-cli terminal runtime/);
});

test("compiled CLI: submit-session without --approved announces the UNREVIEWED path", async () => {
  // No session file exists in this fixture, so the command still fails at the
  // file read — but the honest UNREVIEWED disclosure must come first, and the
  // old hard refusal must be gone.
  const { deps, out, err } = makeDeps({
    files: { [core.localPath(EXTERNAL_CWD)]: JSON.stringify({ token: "oak_x" }) },
  });
  const code = await core.run(["submit-session", "session.md"], deps);
  assert.equal(code, 1);
  assert.match(out.join("\n"), /UNREVIEWED/);
  assert.doesNotMatch(err.join("\n"), /Refusing to submit without explicit approval/);
});

test("compiled CLI: init writes local files under the EXTERNAL cwd, not the repo", async () => {
  const TOKEN = "oak_packaged_TOKEN_wxyz";
  const { deps, files } = makeDeps({
    router: () => {
      // First call = register, second = claim-status (approved).
      return jsonResponse();
    },
  });
  // Route by URL: register vs claim-status.
  let calls = 0;
  deps.fetch = (async (url: string) => {
    calls++;
    if (String(url).includes("/api/agent/register")) {
      return jsonResponse(201, {
        claim_url: "https://oathlock.vercel.app/claim/c1",
        claim_id: "c1",
        setup_code: "setup_secret",
        expires_at: "2030-01-01T00:00:00Z",
      });
    }
    return jsonResponse(200, { status: "approved", token: TOKEN, scopes: ["rules:read"] });
  }) as unknown as typeof deps.fetch;

  const code = await core.run(["init", "--agent-kind", "codex"], deps);
  assert.equal(code, 0);
  assert.ok(calls >= 2);

  // Files must live under the external cwd, and never under the repo root.
  const localKey = core.agentLocalPath(EXTERNAL_CWD, "codex");
  const configKey = core.agentConfigPath(EXTERNAL_CWD, "codex");
  assert.ok(files.has(localKey), "Codex local.json must be under its external-cwd agent profile");
  assert.ok(files.has(configKey), "Codex config.json must be under its external-cwd agent profile");
  assert.ok(localKey.includes("external"), "path must be the external workspace");
  for (const key of files.keys()) {
    assert.ok(!key.includes("RunLeak"), `file written into repo cwd: ${key}`);
  }
  // Token saved to local.json; config carries no token.
  assert.equal(JSON.parse(files.get(localKey)!).token, TOKEN);
  assert.ok(!("token" in JSON.parse(files.get(configKey)!)));
});

test("compiled CLI: connect --agents runs through the real packaged agent-detection-core module, not a stub", async () => {
  const { deps, files } = makeDeps({});
  deps.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).includes("/api/agent/register-batch")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { agents?: Array<{ agent_kind?: string }> };
      return jsonResponse(201, {
        batch_id: "batch-packaged",
        batch_url: "https://oathlock.vercel.app/claim/batch/batch-packaged",
        claims: (body.agents ?? []).map((agent) => ({
          agent_kind: agent.agent_kind,
          claim_id: `claim-${agent.agent_kind}`,
          setup_code: `setup-${agent.agent_kind}`,
          expires_at: "2030-01-01T00:00:00Z",
        })),
      });
    }
    const claimId = new URL(String(url)).searchParams.get("claim_id") ?? "";
    return jsonResponse(200, { status: "approved", token: `token-${claimId}`, scopes: ["rules:read"] });
  }) as unknown as typeof deps.fetch;

  const code = await core.run(["connect", "--agents", "claude-code,opencode"], deps);
  assert.equal(code, 0, "the packaged agent-detection-core.js import must actually resolve");
  assert.ok(files.has(core.agentLocalPath(EXTERNAL_CWD, "claude-code")));
  assert.ok(files.has(core.agentLocalPath(EXTERNAL_CWD, "opencode")));
});

test("compiled CLI: connect installs cross-agent memory capture through the real packaged cross-agent-capture-setup-core module", async () => {
  const { deps, files } = makeDeps({});
  deps.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).includes("/api/agent/register-batch")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { agents?: Array<{ agent_kind?: string }> };
      return jsonResponse(201, {
        batch_id: "batch-capture",
        batch_url: "https://oathlock.vercel.app/claim/batch/batch-capture",
        claims: (body.agents ?? []).map((agent) => ({
          agent_kind: agent.agent_kind,
          claim_id: `claim-${agent.agent_kind}`,
          setup_code: `setup-${agent.agent_kind}`,
          expires_at: "2030-01-01T00:00:00Z",
        })),
      });
    }
    const claimId = new URL(String(url)).searchParams.get("claim_id") ?? "";
    return jsonResponse(200, { status: "approved", token: `token-${claimId}`, scopes: ["rules:read"] });
  }) as unknown as typeof deps.fetch;

  const code = await core.run(["connect", "--agents", "claude-code,codex,opencode", "--memory-capture"], deps);
  assert.equal(code, 0, "the packaged cross-agent-capture-setup-core.js import must actually resolve");
  assert.ok(files.has(join(EXTERNAL_CWD, ".oathlock", "bin", "m9r-capture.mjs")));
  assert.ok(files.has(join(EXTERNAL_CWD, ".claude", "settings.local.json")));
  assert.ok(files.has(join(EXTERNAL_CWD, ".codex", "hooks.json")));
  assert.ok(files.has(join(EXTERNAL_CWD, ".opencode", "plugins", "m9r-memory.js")));
});

test("compiled CLI: token masking never reveals the full token", () => {
  const masked = core.maskToken("oak_supersecretvalue1234");
  assert.equal(masked, "m9r_…1234");
  assert.ok(!masked.includes("supersecret"));
});

// ---------------------------------------------------------------------------

function jsonResponse(status = 200, body: unknown = {}): FakeResponse {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}
