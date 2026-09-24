/**
 * Runs the Codex CLI on the user's normal ChatGPT login for one agent role, with only the M9R MCP server available.
 * No API key is accepted. Codex reports token usage but no dollar cost, so cost stays 0 for these agents.
 * Flags verified on codex-cli 0.153.4: MCP tools are exposed through the exec "tools" gateway, and non-interactive
 * runs need default_tools_approval_mode="approve" on the server or every MCP call is refused.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClaudeJson, ClaudeRun } from "./claude-cli";

export function codexCliPath(): string | null {
  const candidates = [
    process.env.M9R_CODEX_CLI_JS,
    process.env.APPDATA ? join(process.env.APPDATA, "npm", "node_modules", "@openai", "codex", "bin", "codex.js") : undefined,
    join(homedir(), ".npm-global", "lib", "node_modules", "@openai", "codex", "bin", "codex.js"),
    "/usr/local/lib/node_modules/@openai/codex/bin/codex.js",
  ].filter((path): path is string => Boolean(path));
  return candidates.find((path) => existsSync(path)) ?? null;
}

/** Shown to Codex because its MCP tools are deferred behind the exec gateway rather than listed directly. */
export const CODEX_PREFACE =
  "M9R tools may only be reachable as deferred tools through your exec/code gateway (the `tools` object, named like mcp__m9r__m9r_web_open): use it only to call M9R tools. Do not run shell commands, read or write files, or reach the network any other way.";

export function codexArgs(options: { prompt: string; cwd: string; launcher: string; storeRoot: string; brokerPort: number; lastMessagePath: string; model?: string }): string[] {
  const toml = (value: string) => JSON.stringify(value);
  const mcpConfig = `mcp_servers={m9r={command=${toml(process.execPath)},args=[${toml(options.launcher)}],env={M9R_HOME=${toml(options.storeRoot)},M9R_WEB_BROKER_PORT=${toml(String(options.brokerPort))}},default_tools_approval_mode="approve"}}`;
  return [
    "exec", options.prompt,
    "--cd", options.cwd,
    "--ephemeral",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--sandbox", "read-only",
    "--json",
    "--output-last-message", options.lastMessagePath,
    "-c", mcpConfig,
    "-c", 'web_search="disabled"',
    ...(options.model ? ["--model", options.model] : []),
  ];
}

export function startCodex(cli: string, args: string[], cwd: string): ClaudeRun {
  const child = spawn(process.execPath, [cli, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const promise = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
  return { promise, kill: () => void child.kill() };
}

/** Adds up every turn.completed usage block; falls back to any usage object found in the event stream. */
export function usageFromJsonl(stdout: string): { input: number; cached: number; output: number } | null {
  let input = 0;
  let cached = 0;
  let output = 0;
  let found = false;
  for (const line of stdout.split(/\r?\n/)) {
    let event: { type?: string; usage?: Record<string, unknown> };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type !== "turn.completed" || !event.usage) continue;
    found = true;
    input += Number(event.usage.input_tokens) || 0;
    cached += Number(event.usage.cached_input_tokens) || 0;
    output += Number(event.usage.output_tokens) || 0;
  }
  return found ? { input, cached, output } : null;
}

/** Shapes a Codex run like Claude's json output so the runner can report both the same way. */
export function codexAsClaudeJson(stdout: string, exitCode: number | null, lastMessagePath: string): ClaudeJson | null {
  const usage = usageFromJsonl(stdout);
  let result = "";
  try {
    result = existsSync(lastMessagePath) ? readFileSync(lastMessagePath, "utf8").trim() : "";
  } catch {
    // The final message is optional; usage and exit code still tell the story.
  }
  if (!usage && !result) return null;
  return {
    result,
    is_error: exitCode !== 0,
    num_turns: 0,
    total_cost_usd: 0,
    usage: {
      // Codex counts cached tokens inside input_tokens; report them separately like Claude so totals do not double count.
      input_tokens: Math.max(0, (usage?.input ?? 0) - (usage?.cached ?? 0)),
      output_tokens: usage?.output ?? 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: usage?.cached ?? 0,
    },
  } as ClaudeJson;
}
