/**
 * Runs real Claude Code sessions (the official CLI on the user's own login) against the benchmark through the M9R
 * browser tools and message tools, one condition at a time, and measures wall time, correctness, tokens and messages.
 * Uses subscription quota, so it refuses to run without M9R_BENCH_ALLOW_SPEND=1, and refuses to run when an API key
 * is set so nothing is ever billed to an API account by accident.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalStore } from "@/lib/native/local-store";
import { brokerKeyPath } from "@/lib/native/web-broker-paths";
import { loadOrCreateBrokerKey, startWebBroker } from "@/lib/native/web-broker-server";
import type { TaskName } from "./bench-data";
import { startBenchSite } from "./bench-site";
import { startCdpDriver } from "./cdp-driver";
import { parseClaudeJson, startClaude, writeMcpConfig, type ClaudeJson, type ClaudeRun } from "./claude-cli";
import { CODEX_PREFACE, codexArgs, codexAsClaudeJson, codexCliPath, startCodex } from "./codex-cli";
import { ROLES, buildPrompt, rolesFor, type Role } from "./prompts";
import type { Condition } from "./strategies";

export type Vendor = "claude" | "codex";

export interface RealRunOptions {
  task: TaskName;
  condition: Condition;
  seed: number;
  model?: string;
  /** Which vendor runs each role; roles not listed run Claude Code. Codex agents report tokens but no dollar cost. */
  vendors?: Partial<Record<Role, Vendor>>;
  maxBudgetUsd?: number;
  maxTurns?: number;
  timeoutMs?: number;
  graceMs?: number;
}

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

export interface RealRunResult {
  task: TaskName;
  condition: Condition;
  seed: number;
  submitted: boolean;
  correct: boolean;
  wallMs: number | null;
  totalMs: number;
  agents: AgentReport[];
  totals: { turns: number; costUsd: number; tokens: number };
  messages: number;
  pageLoads: number;
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

export function totalsOf(agents: readonly AgentReport[]): RealRunResult["totals"] {
  return {
    turns: agents.reduce((n, a) => n + a.turns, 0),
    costUsd: agents.reduce((n, a) => n + a.costUsd, 0),
    tokens: agents.reduce((n, a) => n + a.inputTokens + a.outputTokens + a.cacheCreationTokens + a.cacheReadTokens, 0),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runReal(options: RealRunOptions): Promise<RealRunResult> {
  if (process.env.M9R_BENCH_ALLOW_SPEND !== "1") throw new Error("this uses subscription quota; set M9R_BENCH_ALLOW_SPEND=1 to run it");
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"]) {
    if (process.env[key]) throw new Error(`${key} is set, so runs could be billed to an API account; unset it and log in with your subscription`);
  }

  const repo = process.cwd();
  const roles = rolesFor(options.condition);
  const vendorOf = (role: Role): Vendor => options.vendors?.[role] ?? "claude";
  const usesCodex = roles.some((role) => vendorOf(role) === "codex");
  if (usesCodex && process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is set, so Codex runs could be billed to an API account; unset it and use the ChatGPT login");
  const codexCli = usesCodex ? codexCliPath() : null;
  if (usesCodex && !codexCli) throw new Error("Codex CLI entry point not found; set M9R_CODEX_CLI_JS to its path");
  const root = mkdtempSync(join(tmpdir(), "m9r-real-"));
  const store = createLocalStore(root);
  for (const from of ROLES) for (const to of ROLES) if (from !== to) store.addRule({ from, to, ttlMs: 2 * 60 * 60_000, note: "benchmark" });
  const tokens = new Map(roles.map((role) => [role, store.issueIdentity(role, vendorOf(role) === "codex" ? "codex-cli" : "claude-code", `real-${role}`).token]));

  const broker = await startWebBroker({ key: loadOrCreateBrokerKey(brokerKeyPath(root)), port: 0, timeoutMs: 30_000, allowAnyExtension: true });
  const site = await startBenchSite({ seed: options.seed });
  const driver = await startCdpDriver({ brokerPort: broker.port });
  const scratchDirs: string[] = [];

  try {
    const configPath = writeMcpConfig(root, { repo, storeRoot: root, brokerPort: broker.port });
    site.reset();
    const started = Date.now();
    const running = new Map<Role, ClaudeRun>();
    const killed = new Set<Role>();
    const finished = new Map<Role, AgentReport>();

    for (const role of roles) {
      const scratch = mkdtempSync(join(tmpdir(), `m9r-real-${role}-`));
      scratchDirs.push(scratch);
      const vendor = vendorOf(role);
      const basePrompt = buildPrompt({ task: options.task, condition: options.condition, role, token: tokens.get(role) as string, baseUrl: site.url("") });
      if (vendor === "codex") {
        const lastMessagePath = join(scratch, "codex-last-message.txt");
        const args = codexArgs({ prompt: `${CODEX_PREFACE}

${basePrompt}`, cwd: scratch, launcher: join(root, "launch-m9r-mcp.cjs"), storeRoot: root, brokerPort: broker.port, lastMessagePath, model: options.model === "sonnet" ? undefined : options.model });
        const run = startCodex(codexCli as string, args, scratch);
        running.set(role, run);
        void run.promise.then(
          (out) => finished.set(role, reportFrom(role, out.code, killed.has(role), codexAsClaudeJson(out.stdout, out.code, lastMessagePath), out.stderr, "codex")),
          (error: Error) => finished.set(role, reportFrom(role, null, killed.has(role), null, error.message, "codex")),
        );
        continue;
      }
      const prompt = basePrompt;
      const args = [
        "-p", prompt,
        "--tools", "",
        "--strict-mcp-config", "--mcp-config", configPath,
        "--allowedTools", "mcp__m9r",
        "--setting-sources", "project",
        "--max-turns", String(options.maxTurns ?? 90),
        "--max-budget-usd", String(options.maxBudgetUsd ?? 2),
        "--model", options.model ?? "sonnet",
        "--output-format", "json",
      ];
      const run = startClaude(args, scratch);
      running.set(role, run);
      void run.promise.then(
        (out) => finished.set(role, reportFrom(role, out.code, killed.has(role), parseClaudeJson(out.stdout), out.stderr, "claude")),
        (error: Error) => finished.set(role, reportFrom(role, null, killed.has(role), null, error.message, "claude")),
      );
    }

    const deadline = started + (options.timeoutMs ?? 10 * 60_000);
    let submittedAt: number | null = null;
    while (finished.size < roles.length && Date.now() < deadline) {
      if (submittedAt === null && site.submissions().length > 0) submittedAt = Date.now();
      if (submittedAt !== null && Date.now() - submittedAt > (options.graceMs ?? 60_000)) break;
      await sleep(500);
    }
    for (const [role, run] of running) {
      if (!finished.has(role)) {
        killed.add(role);
        run.kill();
      }
    }
    for (let i = 0; i < 40 && finished.size < roles.length; i++) await sleep(250);
    for (const role of roles) if (!finished.has(role)) finished.set(role, reportFrom(role, null, true, null, "did not exit"));

    const agents = roles.map((role) => finished.get(role) as AgentReport);
    const submission = site.submissions().find((s) => s.task === options.task);
    const handles = new Set<string>(ROLES);
    return {
      task: options.task,
      condition: options.condition,
      seed: options.seed,
      submitted: Boolean(submission),
      correct: submission?.score.allCorrect ?? false,
      wallMs: submission?.at ?? null,
      totalMs: Date.now() - started,
      agents,
      totals: totalsOf(agents),
      messages: store.snapshot().tasks.filter((t) => handles.has(t.from)).length,
      pageLoads: site.loads().length,
    };
  } finally {
    await driver.close();
    await site.close();
    await broker.close();
    rmSync(root, { recursive: true, force: true });
    for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
  }
}
