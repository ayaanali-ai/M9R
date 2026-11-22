import type { ClaudeJson } from "./claude-cli";
import type { Role } from "./prompts";

export type Vendor = "claude" | "codex";

export interface AgentReport {
  role: Role;
  vendor?: Vendor;
  exitCode: number | null;
  killed: boolean;
  turns: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  reply: string;
  error?: string;
}

export function reportFrom(role: Role, code: number | null, killed: boolean, json: ClaudeJson | null, stderr: string, vendor?: Vendor): AgentReport {
  const usage = json?.usage ?? {};
  return {
    role,
    ...(vendor ? { vendor } : {}),
    exitCode: code,
    killed,
    turns: json?.num_turns ?? 0,
    costUsd: json?.total_cost_usd ?? 0,
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    reply: (json?.result ?? "").slice(0, 300),
    error: json ? (json.is_error ? json.result : undefined) : killed ? "killed before it finished, so its usage is missing" : stderr.slice(0, 300) || "no output",
  };
}

export function totalsOf(agents: readonly AgentReport[]): { turns: number; costUsd: number; tokens: number } {
  return {
    turns: agents.reduce((n, agent) => n + agent.turns, 0),
    costUsd: agents.reduce((n, agent) => n + agent.costUsd, 0),
    tokens: agents.reduce((n, agent) => n + agent.inputTokens + agent.outputTokens + agent.cacheCreationTokens + agent.cacheReadTokens, 0),
  };
}
