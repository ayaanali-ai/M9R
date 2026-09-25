/**
 * Launching the official Claude Code CLI for benchmark runs. Always the real `claude` binary on the user's own login;
 * nothing here reads or reuses credentials. Enforcement flags (verified in claude-smoke.ts): --tools removes built-in
 * tools, --strict-mcp-config loads only our M9R server, --setting-sources project ignores the user's hooks and settings.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ClaudeOutput {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface ClaudeRun {
  promise: Promise<ClaudeOutput>;
  kill: () => void;
}

export function startClaude(args: string[], cwd: string): ClaudeRun {
  const child = spawn("claude", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const promise = new Promise<ClaudeOutput>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
  return { promise, kill: () => void child.kill() };
}

/**
 * The M9R MCP server must run from the repo root (path alias and TypeScript loader), so a small launcher sets the cwd.
 * Returns the path of the MCP config file to pass to --mcp-config.
 */
export function writeMcpConfig(dir: string, options: { repo: string; storeRoot: string; brokerPort: number }): string {
  const launcher = join(dir, "launch-m9r-mcp.cjs");
  writeFileSync(
    launcher,
    `const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "./scripts/register-alias.mjs", "scripts/m9r-mcp.ts"], { cwd: ${JSON.stringify(options.repo)}, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
`,
  );
  const configPath = join(dir, "mcp.json");
  writeFileSync(
    configPath,
    JSON.stringify({ mcpServers: { m9r: { command: process.execPath, args: [launcher], env: { M9R_HOME: options.storeRoot, M9R_WEB_BROKER_PORT: String(options.brokerPort) } } } }),
  );
  return configPath;
}

export interface ClaudeJson {
  result?: string;
  is_error?: boolean;
  num_turns?: number;
  duration_ms?: number;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export function parseClaudeJson(stdout: string): ClaudeJson | null {
  try {
    return JSON.parse(stdout) as ClaudeJson;
  } catch {
    return null;
  }
}
