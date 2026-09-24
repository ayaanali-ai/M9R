/**
 * One normal-login Codex CLI pass through the M9R browser tools. The run is opt-in because it consumes ChatGPT plan
 * quota. No API key is accepted: this deliberately exercises Codex CLI's existing ChatGPT login.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalStore } from "@/lib/native/local-store";
import { brokerKeyPath } from "@/lib/native/web-broker-paths";
import { loadOrCreateBrokerKey, startWebBroker } from "@/lib/native/web-broker-server";
import { startBenchSite } from "./bench-site";
import { startCdpDriver } from "./cdp-driver";
import { codexLoginStatusIsAuthenticated } from "./codex-auth-core";

interface CodexRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

function codexCliPath(): string | null {
  const candidates = [
    process.env.M9R_CODEX_CLI_JS,
    process.env.APPDATA ? join(process.env.APPDATA, "npm", "node_modules", "@openai", "codex", "bin", "codex.js") : undefined,
    join(homedir(), ".npm-global", "lib", "node_modules", "@openai", "codex", "bin", "codex.js"),
    "/usr/local/lib/node_modules/@openai/codex/bin/codex.js",
  ].filter((path): path is string => Boolean(path));
  return candidates.find((path) => existsSync(path)) ?? null;
}

function run(command: string, args: string[], cwd: string, timeoutMs: number): Promise<CodexRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Codex did not finish within ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function findUsage(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const usage = record.usage;
  if (usage && typeof usage === "object") {
    const numbers = Object.fromEntries(Object.entries(usage).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
    if (Object.keys(numbers).length) return numbers;
  }
  for (const child of Object.values(record)) {
    const found = findUsage(child);
    if (found) return found;
  }
  return undefined;
}

function usageFromJsonl(stdout: string): Record<string, number> | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const usage = findUsage(JSON.parse(line) as unknown);
      if (usage) return usage;
    } catch {
      // Ignore non-JSON diagnostics and continue looking for structured usage events.
    }
  }
  return undefined;
}

function mcpNames(stdout: string): string[] {
  const names = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const visit = (value: unknown): void => {
        if (!value || typeof value !== "object") return;
        const record = value as Record<string, unknown>;
        if (typeof record.name === "string" && record.name.startsWith("m9r_")) names.add(record.name);
        for (const child of Object.values(record)) visit(child);
      };
      visit(JSON.parse(line) as unknown);
    } catch {
      // Non-JSON CLI diagnostics are kept out of the tool inventory.
    }
  }
  return [...names].sort();
}

async function main(): Promise<void> {
  if (process.env.M9R_BENCH_ALLOW_SPEND !== "1") {
    process.stdout.write("This runs one real Codex session and uses ChatGPT plan quota. Set M9R_BENCH_ALLOW_SPEND=1 to run it.\n");
    process.exitCode = 2;
    return;
  }
  if (process.env.OPENAI_API_KEY !== undefined) {
    process.stdout.write("Refusing to run: OPENAI_API_KEY is set. This smoke test must use the normal Codex ChatGPT login, not an API key.\n");
    process.exitCode = 2;
    return;
  }

  const cli = codexCliPath();
  if (!cli) throw new Error("Codex CLI JavaScript entry point not found; set M9R_CODEX_CLI_JS to its path");
  const login = spawnSync(process.execPath, [cli, "login", "status"], { encoding: "utf8", timeout: 10_000 });
  const loginOutput = `${login.stdout}\n${login.stderr}`;
  if (!codexLoginStatusIsAuthenticated(login.status, loginOutput)) {
    const authStore = process.env.CODEX_HOME ? "the CODEX_HOME override" : "the default Codex CLI auth store";
    process.stdout.write(`Codex CLI login status: ${(loginOutput.trim() || "no status text").slice(0, 240)} (CLI: ${cli}; auth source: ${authStore}). This is the npm Codex CLI check, not a check of the desktop app session. No model run was started; no token quota was used.\n`);
    process.exitCode = 2;
    return;
  }

  const repo = process.cwd();
  const root = mkdtempSync(join(tmpdir(), "m9r-codex-smoke-"));
  const scratch = mkdtempSync(join(tmpdir(), "m9r-codex-smoke-cwd-"));
  const store = createLocalStore(root);
  const token = store.issueIdentity("codex", "codex-cli", "smoke").token;
  const broker = await startWebBroker({ key: loadOrCreateBrokerKey(brokerKeyPath(root)), port: 0, timeoutMs: 30_000, allowAnyExtension: true });
  const site = await startBenchSite({ seed: 1 });
  const driver = await startCdpDriver({ brokerPort: broker.port });

  try {
    const launcher = join(root, "launch-m9r-mcp.cjs");
    writeFileSync(
      launcher,
      `const { spawn } = require("node:child_process");\nconst child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "./scripts/register-alias.mjs", "scripts/m9r-mcp.ts"], { cwd: ${JSON.stringify(repo)}, stdio: "inherit" });\nchild.on("exit", (code) => process.exit(code ?? 0));\n`,
    );
    const lastMessage = join(scratch, "codex-last-message.txt");
    const toml = (value: string) => JSON.stringify(value);
    const mcpConfig = `mcp_servers={m9r={command=${toml(process.execPath)},args=[${toml(launcher)}],env={M9R_HOME=${toml(root)},M9R_WEB_BROKER_PORT=${toml(String(broker.port))}},default_tools_approval_mode="approve"}}`;
    const prompt = [
      "This is a bounded M9R browser-tool smoke test. M9R tools may only be reachable as deferred tools through your exec/code gateway (the `tools` object): use it only to call M9R tools. Do not run shell commands, read or write files, or reach the network any other way.",
      `Your M9R session token is ${token}; pass it to every M9R browser tool call.`,
      `Call m9r_web_open for ${site.url("/search/spec")}, then call m9r_web_read with selector #code.`,
      "Report the exact code returned by m9r_web_read and list the callable tool names exposed to you. State whether a web search/browser tool is available.",
    ].join("\n");
    const args = [
      "exec", prompt,
      "--cd", scratch,
      "--ephemeral",
      "--skip-git-repo-check",
      "--ignore-user-config",
      "--sandbox", "read-only",
      "--json",
      "--output-last-message", lastMessage,
      "-c", mcpConfig,
      "-c", 'web_search="disabled"',
    ];
    const started = Date.now();
    const out = await run(process.execPath, [cli, ...args], scratch, 240_000);
    const message = existsSync(lastMessage) ? readFileSync(lastMessage, "utf8").trim() : "";
    const loads = site.loads().map((entry) => entry.path);
    const tools = mcpNames(out.stdout);
    process.stdout.write(`codex exited ${out.code} after ${Math.round((Date.now() - started) / 1000)}s\n`);
    process.stdout.write(`M9R tools observed in event stream: ${JSON.stringify(tools)}\n`);
    process.stdout.write(`expected code: ${site.data.search.targetCode}\nagent final message: ${message || "(no final message captured)"}\n`);
    process.stdout.write(`pages the bench site actually loaded: ${JSON.stringify(loads)}\n`);
    process.stdout.write(`token usage: ${JSON.stringify(usageFromJsonl(out.stdout) ?? null)}\n`);
    process.stdout.write("flags: exec --cd <scratch> --ephemeral --skip-git-repo-check --ignore-user-config --sandbox read-only --json --output-last-message <file> -c <single M9R mcp_servers table> -c web_search=disabled\n");
    process.stdout.write("profile assessment: web_search=disabled leaves Codex coding tools enabled; M9R is the only MCP configured. Shell tools may still reach the network, so this is not a hard network sandbox.\n");
    process.stdout.write(`smoke checks: open=${loads.includes("/search/spec")}, read=${message.includes(site.data.search.targetCode)}, m9r-tools=${tools.join(",")}\n`);
    if (out.code !== 0 || !loads.includes("/search/spec") || !message.includes(site.data.search.targetCode) || !tools.includes("m9r_web_read")) {
      process.exitCode = 1;
      if (out.stderr) process.stdout.write(`Codex stderr (first 800 chars): ${out.stderr.slice(0, 800)}\n`);
    }
  } finally {
    await driver.close();
    await site.close();
    await broker.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
