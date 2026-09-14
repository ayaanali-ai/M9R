import { spawn } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";
import { redactSession } from "@/lib/session-redaction";
import { extractCost, extractTokenUsage } from "@/lib/usage-normalization";
import type { AgentModelTier } from "@/lib/agent-task-routing";
import { providerLabel, type ProviderAdapterConfig } from "@/lib/provider-adapter-config";
import { createGrantWorktree, quarantineGrantWorktree, removeGrantWorktree, worktreeHeadCommit } from "@/lib/resident-write-isolation";

export type ProviderExecutionMode = "read_only" | "workspace_write";

export interface ProviderLaunchGrant {
  grantId: string;
  repositoryRoot: string;
  task: string;
  allowedPaths: string[];
  prohibitedPaths: string[];
  maxDurationMs: number;
  maxEstimatedTokens?: number | null;
  modelTier?: AgentModelTier;
  requestedModel?: string;
  executionMode: ProviderExecutionMode;
  acceptanceCriteria?: string[];
  contextRefs?: string[];
  maxContextFetches?: number;
}

export interface BoundedWorkPacket {
  protocolVersion: "oathlock.work-packet.v1";
  providerIdentity: string;
  grantId: string;
  task: string;
  acceptanceCriteria: string[];
  scope: {
    executionMode: ProviderExecutionMode;
    allowedPaths: string[];
    prohibitedPaths: string[];
  };
  contextRefs: string[];
  contextPolicy: { mode: "on_demand"; maxFetches: number };
  budget: { maxDurationMs: number; maxEstimatedTokens: number | null; modelTier: AgentModelTier | null };
  returnSchema: "oathlock.provider-result.v1";
}

export interface ProviderProcessSpec {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: string;
  shell: false;
}

export interface ProviderUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
}

export interface ProviderResult {
  resultText: string | null;
  sessionId: string | null;
  providerReportedError: boolean;
  /** Extracted from the provider's own JSON events. Null fields mean the provider never reported that value — never estimated. */
  usage: ProviderUsage | null;
  /** Present only when the provider's own event stream named the model. */
  reportedModel: string | null;
}

/**
 * The provider CLI's stream-json events already carry usage/cost — Claude
 * Code's final `result` event and Codex's `turn.completed`/`token_count`
 * events. Scans every event and keeps the last reported usage block (later
 * events report cumulative totals, so last-wins beats summing per-event
 * deltas and risking double count).
 */
function extractProviderUsage(events: Array<Record<string, unknown>>): ProviderUsage | null {
  const merged: ProviderUsage = { inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null };
  let sawAny = false;
  for (const event of events) {
    const tokens = extractTokenUsage(event);
    const cost = extractCost(event);
    if (tokens.usage === null && cost.costUsd === null) continue;
    sawAny = true;
    if (tokens.usage?.input != null) merged.inputTokens = tokens.usage.input;
    if (tokens.usage?.output != null) merged.outputTokens = tokens.usage.output;
    if (tokens.usage?.total != null) merged.totalTokens = tokens.usage.total;
    if (cost.costUsd != null) merged.costUsd = cost.costUsd;
  }
  return sawAny ? merged : null;
}

const MAX_CAPTURE_BYTES = 1024 * 1024;
const CONTEXT_REF = /^(?:diff|rule|decision|file|finding):\/\/[a-zA-Z0-9._~:/#-]{1,500}$/;

// Codex treats zero as "do not load project instructions". Keep the normal
// bounded project-doc budget explicit for resident launches so AGENTS.md stays
// available without allowing unbounded instruction growth.
const CODEX_PROJECT_DOC_MAX_BYTES = 32_768;

function normalizedBoundedList(values: unknown, options: { name: string; maxItems: number; maxLength: number }): string[] {
  if (!Array.isArray(values) || values.length > options.maxItems) throw new Error(`${options.name} must be a bounded list.`);
  const normalized = values.map((value) => {
    if (typeof value !== "string") throw new Error(`${options.name} must contain strings.`);
    const item = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    if (!item || item.length > options.maxLength) throw new Error(`${options.name} contains an invalid item.`);
    return item;
  });
  return [...new Set(normalized)];
}

function validateGrant(grant: ProviderLaunchGrant): ProviderLaunchGrant & { repositoryRoot: string } {
  const repositoryRoot = resolve(grant.repositoryRoot);
  if (!/^[a-zA-Z0-9._:-]{8,100}$/.test(grant.grantId)) throw new Error("Provider grant id is invalid.");
  const task = grant.task.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!task || task.length > 1_000) throw new Error("Provider task is invalid.");
  if (!Number.isSafeInteger(grant.maxDurationMs) || grant.maxDurationMs < 1_000 || grant.maxDurationMs > 86_400_000) throw new Error("Provider duration is invalid.");
  if (grant.maxEstimatedTokens != null && (!Number.isSafeInteger(grant.maxEstimatedTokens) || grant.maxEstimatedTokens < 1 || grant.maxEstimatedTokens > 1_000_000)) {
    throw new Error("Provider token budget is invalid.");
  }
  const tiers: AgentModelTier[] = ["economy", "balanced", "frontier"];
  if (grant.modelTier !== undefined && !tiers.includes(grant.modelTier)) throw new Error("Provider model tier is invalid.");
  if (grant.requestedModel && !/^[a-zA-Z0-9._:/-]{1,200}$/.test(grant.requestedModel)) throw new Error("Provider model mapping is invalid.");
  if (!grant.modelTier && grant.requestedModel) throw new Error("Provider model cannot be selected without a tier.");
  const normalizePaths = (paths: string[], required: boolean) => {
    if (!Array.isArray(paths) || (required && paths.length === 0) || paths.length > 100) throw new Error("Provider path bounds are invalid.");
    return [...new Set(paths.map((path) => {
      if (typeof path !== "string" || !path.trim() || path.length > 500 || isAbsolute(path)) throw new Error("Provider paths must be bounded repository-relative paths.");
      const normalized = path.replace(/\\/g, "/");
      if (normalized.split("/").includes("..")) throw new Error("Provider paths must remain inside the repository.");
      return normalized;
    }))];
  };
  return { ...grant, repositoryRoot, task, allowedPaths: normalizePaths(grant.allowedPaths, true), prohibitedPaths: normalizePaths(grant.prohibitedPaths, false) };
}

export function compileBoundedWorkPacket(
  grantInput: ProviderLaunchGrant,
  providerIdentity: string = "codex",
): BoundedWorkPacket {
  const grant = validateGrant(grantInput);
  const acceptanceCriteria = grant.acceptanceCriteria === undefined
    ? ["Complete the assigned task within scope and support every claim with observed evidence."]
    : normalizedBoundedList(grant.acceptanceCriteria, { name: "Acceptance criteria", maxItems: 20, maxLength: 500 });
  if (acceptanceCriteria.length === 0) throw new Error("Acceptance criteria must not be empty.");
  const contextRefs = grant.contextRefs === undefined
    ? []
    : normalizedBoundedList(grant.contextRefs, { name: "Context references", maxItems: 50, maxLength: 500 });
  if (contextRefs.some((ref) => !CONTEXT_REF.test(ref))) throw new Error("Context reference is invalid or unsupported.");
  const maxContextFetches = grant.maxContextFetches ?? 8;
  if (!Number.isSafeInteger(maxContextFetches) || maxContextFetches < 0 || maxContextFetches > 100) {
    throw new Error("Context fetch budget must be between 0 and 100.");
  }
  return {
    protocolVersion: "oathlock.work-packet.v1",
    providerIdentity,
    grantId: grant.grantId,
    task: grant.task,
    acceptanceCriteria,
    scope: {
      executionMode: grant.executionMode,
      allowedPaths: grant.allowedPaths,
      prohibitedPaths: grant.prohibitedPaths,
    },
    contextRefs,
    contextPolicy: { mode: "on_demand", maxFetches: maxContextFetches },
    budget: { maxDurationMs: grant.maxDurationMs, maxEstimatedTokens: grant.maxEstimatedTokens ?? null, modelTier: grant.modelTier ?? null },
    returnSchema: "oathlock.provider-result.v1",
  };
}

export function resolveProviderModel(
  provider: string,
  tier: AgentModelTier,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const suffix = tier.toUpperCase();
  const envPrefix = provider === "codex" ? "CODEX" : provider === "claude-code" ? "CLAUDE" : provider.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const configured = env[`OATHLOCK_${envPrefix}_MODEL_${suffix}`]?.trim();
  const claudeDefaults: Record<AgentModelTier, string> = { economy: "haiku", balanced: "sonnet", frontier: "opus" };
  // Codex's authenticated CLI default follows the provider's current coding
  // model. Keep that moving default unless the operator pins a mapping; the
  // abstract tier is still enforced through reasoning effort below and the
  // actual provider-reported model is retained with the result.
  const model = configured || (provider === "claude-code" ? claudeDefaults[tier] : null);
  if (model && !/^[a-zA-Z0-9._:/-]{1,200}$/.test(model)) throw new Error(`A valid ${provider} model mapping is required for the ${tier} tier.`);
  return model;
}

function providerPrompt(grant: ProviderLaunchGrant, provider: string): string {
  const packet = compileBoundedWorkPacket(grant, provider);
  const label = providerLabel(provider);
  return [
    "You are executing a bounded M9R launch grant.",
    `Delegated provider identity: ${label}.`,
    "Resident child launch marker: OATHLOCK_RESIDENT_CHILD=1. The parent controlled run owns M9R governance for this assignment.",
    "The parent controlled run already owns M9R governance for this assignment.",
    "Do not run the repository's normal M9R automatic workflow, start another run, or produce an M9R Evidence Draft.",
    "Work packet (authoritative JSON):",
    JSON.stringify(packet),
    "Do not read or reveal credentials, .env files, or .oathlock/local.json.",
    "Stay inside the repository and allowed path scope. You may request bounded work from authorized Mission participants through M9R's collaboration protocol; do not launch another provider directly.",
    packet.scope.executionMode === "read_only" ? "Do not modify files." : "Modify only allowed paths.",
    "Use the supplied context references first. Retrieve additional context only when necessary and within the context fetch budget.",
    "If required context is unavailable, return status `needs_context` with the exact missing references or questions; do not guess.",
    "Return only concise JSON matching oathlock.provider-result.v1: status, summary, findings, evidence_refs, verification, failures, and limitations.",
    packet.budget.maxEstimatedTokens === null
      ? "Keep the response minimal."
      : `The provider-reported total usage must not exceed ${packet.budget.maxEstimatedTokens} tokens; minimize reads and output. M9R rejects over-budget results.`,
    "Do not return hidden reasoning or a transcript. Do not claim success without observed evidence.",
  ].join("\n");
}

function selectedEnvironment(provider: string): NodeJS.ProcessEnv {
  const common = ["PATH", "Path", "SystemRoot", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "HTTPS_PROXY", "HTTP_PROXY", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"];
  const providerKeys = provider === "codex"
    ? ["CODEX_HOME", "OPENAI_API_KEY"]
    : provider === "claude-code"
      ? ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_GIT_BASH_PATH"]
      : [];
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV ?? "production", OATHLOCK_RESIDENT_CHILD: "1" };
  for (const key of [...common, ...providerKeys]) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}

function providerResultJsonSchema(maxEstimatedTokens: number | null | undefined): string {
  // Keep the visible answer substantially below the whole-run ceiling so the
  // provider still has room for the bounded prompt and file/tool observations.
  const responseChars = Math.max(600, Math.min(2_400, Math.floor((maxEstimatedTokens ?? 1_200) * 1.5)));
  const shortText = { type: "string", maxLength: Math.min(600, Math.floor(responseChars / 3)) };
  const list = { type: "array", maxItems: 4, items: { type: "string", maxLength: Math.min(400, Math.floor(responseChars / 5)) } };
  return JSON.stringify({
    type: "object",
    additionalProperties: false,
    properties: {
      status: { type: "string", enum: ["completed", "needs_context", "failed"] },
      summary: shortText,
      findings: list,
      evidence_refs: list,
      verification: list,
      failures: list,
      limitations: list,
    },
    required: ["status", "summary", "findings", "evidence_refs", "verification", "failures", "limitations"],
  });
}

export function buildCodexLaunchSpec(input: ProviderLaunchGrant, executable = "codex"): ProviderProcessSpec {
  const grant = validateGrant(input);
  const reasoningEffort: Record<AgentModelTier, "low" | "medium" | "xhigh"> = {
    economy: "low",
    balanced: "medium",
    frontier: "xhigh",
  };
  const windowsNpmEntry = process.platform === "win32" && executable === "codex" && process.env.APPDATA
    ? join(process.env.APPDATA, "npm", "node_modules", "@openai", "codex", "bin", "codex.js")
    : null;
  return {
    executable: windowsNpmEntry ? process.execPath : executable,
    args: [
      ...(windowsNpmEntry ? [windowsNpmEntry] : []),
      "exec",
      "--ignore-user-config",
      "-c", "mcp_servers={}",
      "-c", `project_doc_max_bytes=${CODEX_PROJECT_DOC_MAX_BYTES}`,
      ...(grant.modelTier ? ["-c", `model_reasoning_effort=${JSON.stringify(reasoningEffort[grant.modelTier])}`] : []),
      ...(grant.requestedModel ? ["--model", grant.requestedModel] : []),
      "--json", "--ephemeral", "--sandbox", grant.executionMode === "read_only" ? "read-only" : "workspace-write", "-C", grant.repositoryRoot, "-",
    ],
    cwd: grant.repositoryRoot,
    env: selectedEnvironment("codex"),
    stdin: providerPrompt(grant, "codex"),
    shell: false,
  };
}

export function buildClaudeCodeLaunchSpec(input: ProviderLaunchGrant, executable = "claude"): ProviderProcessSpec {
  const grant = validateGrant(input);
  const tools = grant.executionMode === "read_only" ? "Read,Grep,Glob" : "Read,Edit,Write,Grep,Glob";
  return {
    executable,
    args: [
      "--print", "--verbose", "--output-format", "stream-json", "--input-format", "text",
      "--safe-mode",
      "--no-session-persistence", "--disable-slash-commands",
      "--system-prompt", "You are Claude Code executing one bounded delegated M9R assignment. Follow only the supplied work packet and return its requested JSON result.",
      "--json-schema", providerResultJsonSchema(grant.maxEstimatedTokens),
      ...(grant.requestedModel ? ["--model", grant.requestedModel] : []),
      "--permission-mode", grant.executionMode === "read_only" ? "dontAsk" : "acceptEdits",
      "--tools", tools,
    ],
    cwd: grant.repositoryRoot,
    env: selectedEnvironment("claude-code"),
    stdin: providerPrompt(grant, "claude-code"),
    shell: false,
  };
}

/**
 * One-shot adapter for providers that do not expose one of the bundled
 * Codex/Claude result streams. The configured command receives the bounded
 * work packet on stdin and must emit one JSON object (or a JSON string) on
 * stdout. This keeps resident execution provider-neutral without guessing a
 * third-party CLI's flags or credentials.
 */
export function buildGenericJsonStdioLaunchSpec(input: ProviderLaunchGrant, adapter: ProviderAdapterConfig): ProviderProcessSpec {
  const grant = validateGrant(input);
  if (adapter.protocol !== "oathlock-json-stdio") throw new Error("Generic resident providers require an oathlock-json-stdio adapter.");
  return {
    executable: adapter.command,
    args: adapter.args,
    cwd: grant.repositoryRoot,
    env: selectedEnvironment(adapter.provider),
    stdin: providerPrompt(grant, adapter.provider),
    shell: false,
  };
}

/** Exported additively for `mission-provider-adapter-codex.ts`'s incremental event parsing — the same line-delimited-JSON parsing `parseCodexResult`/`parseClaudeCodeResult` already use, reused rather than reimplemented. */
export function jsonLines(raw: string): Array<Record<string, unknown>> {
  return raw.split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const parsed = JSON.parse(line) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? [parsed as Record<string, unknown>] : [];
    } catch { return []; }
  });
}

export function parseCodexResult(raw: string): ProviderResult {
  let resultText: string | null = null;
  let sessionId: string | null = null;
  let providerReportedError = false;
  let reportedModel: string | null = null;
  const events = jsonLines(raw);
  for (const event of events) {
    if (event.type === "thread.started" && typeof event.thread_id === "string") sessionId = event.thread_id;
    if (event.type === "error" || event.type === "turn.failed") providerReportedError = true;
    if (typeof event.model === "string") reportedModel = event.model.slice(0, 200);
    const item = event.item && typeof event.item === "object" ? event.item as Record<string, unknown> : null;
    if (event.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") resultText = item.text.slice(0, 100_000);
  }
  return { resultText, sessionId, providerReportedError, usage: extractProviderUsage(events), reportedModel };
}

export function parseClaudeCodeResult(raw: string): ProviderResult {
  let resultText: string | null = null;
  let sessionId: string | null = null;
  let providerReportedError = false;
  let reportedModel: string | null = null;
  const events = jsonLines(raw);
  for (const event of events) {
    if (typeof event.session_id === "string") sessionId = event.session_id;
    if (typeof event.model === "string") reportedModel = event.model.slice(0, 200);
    if (event.type === "result") {
      if (typeof event.result === "string") resultText = event.result.slice(0, 100_000);
      providerReportedError = event.is_error === true;
    }
  }
  return { resultText, sessionId, providerReportedError, usage: extractProviderUsage(events), reportedModel };
}

export function parseGenericJsonResult(raw: string): ProviderResult {
  const events = jsonLines(raw);
  const event = events.at(-1) ?? null;
  if (!event) return { resultText: null, sessionId: null, providerReportedError: false, usage: null, reportedModel: null };
  const result = typeof event.result === "string" ? event.result : JSON.stringify(event);
  return {
    resultText: result?.slice(0, 100_000) ?? null,
    sessionId: typeof event.session_id === "string" ? event.session_id : null,
    providerReportedError: event.status === "failed" || event.status === "error" || event.is_error === true,
    usage: extractProviderUsage(events),
    reportedModel: typeof event.model === "string" ? event.model.slice(0, 200) : null,
  };
}

export interface ProviderProcessOutcome {
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export function runProviderProcess(
  spec: ProviderProcessSpec,
  timeoutMs: number,
  signal?: AbortSignal,
  onSpawn?: () => Promise<void>,
  onOutput?: (stream: "stdout" | "stderr", data: string) => void,
  /**
   * Additive — every existing caller omits this. Lets a caller that needs
   * to POLL this process later (rather than only await this Promise's
   * eventual resolution) capture the OS pid at spawn time without this
   * function's request/response shape changing for anyone else. See
   * `mission-process-host-node.ts`, the only current caller.
   */
  onProcessId?: (pid: number | undefined) => void,
): Promise<ProviderProcessOutcome> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 86_400_000) throw new Error("Provider timeout is invalid.");
  return new Promise((resolveResult, reject) => {
    const child = spawn(spec.executable, spec.args, { cwd: spec.cwd, env: spec.env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    onProcessId?.(child.pid);
    let stdout = "", stderr = "", stdoutTruncated = false, stderrTruncated = false, timedOut = false, cancelled = false, settled = false;
    const append = (current: string, chunk: Buffer, mark: () => void) => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") > MAX_CAPTURE_BYTES) { mark(); return next.slice(-MAX_CAPTURE_BYTES); }
      return next;
    };
    const stop = () => { if (!child.killed) child.kill(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const onAbort = () => { cancelled = true; stop(); };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      const data = chunk.toString("utf8");
      stdout = append(stdout, chunk, () => { stdoutTruncated = true; });
      onOutput?.("stdout", data);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const data = chunk.toString("utf8");
      stderr = append(stderr, chunk, () => { stderrTruncated = true; });
      onOutput?.("stderr", data);
    });
    child.once("spawn", () => {
      Promise.resolve(onSpawn?.()).then(() => child.stdin.end(spec.stdin, "utf8")).catch((error) => {
        stop();
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      });
    });
    child.once("error", (error) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort); reject(error); });
    child.once("close", (exitCode) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort); resolveResult({ exitCode, timedOut, cancelled, stdout, stderr, stdoutTruncated, stderrTruncated }); });
  });
}

type RecordedProviderEvent = { event: "launch" | "acknowledge_process" | "return_result" | "fail_launch" | "fail_provider" | "timeout"; sequence: number; resultText?: string; usage?: ProviderUsage; modelTier?: AgentModelTier; requestedModel?: string; reportedModel?: string; failureCode?: "timeout" | "nonzero_exit" | "provider_reported_error" | "missing_structured_result" | "provider_exception" | "token_budget_exceeded" };

export interface WorktreeIsolation {
  repositoryRoot: string;
  worktreeRoot: string;
  branch: string;
  baseCommit: string;
}

export async function executeProviderLaunch(
  input: { provider: string; adapter?: ProviderAdapterConfig | null; grant: ProviderLaunchGrant; firstSequence: number; signal?: AbortSignal },
  deps: {
    recordEvent(event: RecordedProviderEvent): Promise<void>;
    runProcess?: typeof runProviderProcess;
    resolveModel?: typeof resolveProviderModel;
    observeOutput?: (stream: "stdout" | "stderr", data: string) => void;
    createWorktree?: typeof createGrantWorktree;
    worktreeHead?: typeof worktreeHeadCommit;
    quarantineWorktree?: typeof quarantineGrantWorktree;
    removeWorktree?: typeof removeGrantWorktree;
  },
): Promise<{ status: "returned" | "launch_failed" | "provider_failed" | "budget_exceeded" | "timed_out" | "cancelled"; result: ProviderResult | null; worktree: WorktreeIsolation | null }> {
  let sequence = input.firstSequence;
  let processAcknowledged = false;
  await deps.recordEvent({ event: "launch", sequence: sequence++ });
  // workspace_write grants run entirely inside a disposable, grant-bound git
  // worktree instead of the real repository -- the same isolation primitive
  // the ACP/Mission execution path already uses (mission-process-host-node.ts's
  // NodeProcessExecutionHost.prepare). A resident process never touches the
  // real repository until a human approves its reported diff (see
  // resident-write-isolation.ts's canEnableWriteMode/reconcilePendingWorktrees
  // in oathlock-resident-core.ts, which performs the actual merge).
  let worktree: WorktreeIsolation | null = null;
  try {
    if (input.grant.executionMode === "workspace_write") {
      const spec = await (deps.createWorktree ?? createGrantWorktree)({ repositoryRoot: input.grant.repositoryRoot, grantId: input.grant.grantId, baseRef: "HEAD" });
      const baseCommit = await (deps.worktreeHead ?? worktreeHeadCommit)(spec.worktreeRoot);
      worktree = { repositoryRoot: resolve(input.grant.repositoryRoot), worktreeRoot: spec.worktreeRoot, branch: spec.branch, baseCommit };
    }
    const requestedModel = input.grant.requestedModel
      ?? (input.grant.modelTier ? (deps.resolveModel ?? resolveProviderModel)(input.provider, input.grant.modelTier) : undefined);
    const effectiveGrant = {
      ...input.grant,
      ...(requestedModel ? { requestedModel } : {}),
      ...(worktree ? { repositoryRoot: worktree.worktreeRoot } : {}),
    };
    const spec = input.provider === "codex"
      ? buildCodexLaunchSpec(effectiveGrant)
      : input.provider === "claude-code"
        ? buildClaudeCodeLaunchSpec(effectiveGrant)
        : input.adapter
          ? buildGenericJsonStdioLaunchSpec(effectiveGrant, input.adapter)
          : (() => { throw new Error(`Provider ${input.provider} has no configured resident adapter.`); })();
    const outcome = await (deps.runProcess ?? runProviderProcess)(spec, input.grant.maxDurationMs, input.signal, async () => {
      await deps.recordEvent({ event: "acknowledge_process", sequence: sequence++ });
      processAcknowledged = true;
    }, deps.observeOutput);
    if (outcome.cancelled) {
      await quarantineOrRemove(input.grant.repositoryRoot, worktree, deps, false);
      return { status: "cancelled", result: null, worktree: null };
    }
    if (outcome.timedOut) {
      await deps.recordEvent({ event: "timeout", sequence: sequence++, failureCode: "timeout" });
      await quarantineOrRemove(input.grant.repositoryRoot, worktree, deps, true);
      return { status: "timed_out", result: null, worktree: null };
    }
    const parsed = input.provider === "codex"
      ? parseCodexResult(outcome.stdout)
      : input.provider === "claude-code"
        ? parseClaudeCodeResult(outcome.stdout)
        : parseGenericJsonResult(outcome.stdout);
    if (outcome.exitCode !== 0 || parsed.providerReportedError || !parsed.resultText) {
      const failureCode = outcome.exitCode !== 0
        ? "nonzero_exit"
        : parsed.providerReportedError
          ? "provider_reported_error"
          : "missing_structured_result";
      await deps.recordEvent({ event: "fail_provider", sequence: sequence++, failureCode });
      await quarantineOrRemove(input.grant.repositoryRoot, worktree, deps, true);
      return { status: "provider_failed", result: parsed, worktree: null };
    }
    const reportedTotalTokens = parsed.usage?.totalTokens
      ?? (parsed.usage?.inputTokens != null && parsed.usage?.outputTokens != null
        ? parsed.usage.inputTokens + parsed.usage.outputTokens
        : null);
    if (effectiveGrant.maxEstimatedTokens != null
      && reportedTotalTokens != null
      && reportedTotalTokens > effectiveGrant.maxEstimatedTokens) {
      // The actual overage was previously invisible -- every budget rejection
      // looked identical regardless of whether it missed the ceiling by 10
      // tokens or 10x, which made the ceiling impossible to size correctly.
      console.error(`[resident] ${input.provider} token_budget_exceeded: reported ${reportedTotalTokens}, ceiling ${effectiveGrant.maxEstimatedTokens}`);
      await deps.recordEvent({ event: "fail_provider", sequence: sequence++, failureCode: "token_budget_exceeded" });
      await quarantineOrRemove(input.grant.repositoryRoot, worktree, deps, true);
      return { status: "budget_exceeded", result: null, worktree: null };
    }
    const redacted = redactSession(parsed.resultText).redactedText;
    // The server's event validator requires modelTier and requestedModel
    // together or not at all (resident-service-contract.ts). Codex has no
    // default model mapping (resolveProviderModel returns null for it unless
    // an operator sets OATHLOCK_CODEX_MODEL_<TIER>), so effectiveGrant often
    // has a modelTier with no requestedModel -- sending modelTier alone in
    // that case got every successful Codex result rejected with a 400 that
    // then looked identical to a real launch crash.
    const modelMetadata = effectiveGrant.modelTier && effectiveGrant.requestedModel
      ? { modelTier: effectiveGrant.modelTier, requestedModel: effectiveGrant.requestedModel }
      : {};
    await deps.recordEvent({
      event: "return_result",
      sequence: sequence++,
      resultText: redacted,
      ...(parsed.usage ? { usage: parsed.usage } : {}),
      ...modelMetadata,
      ...(parsed.reportedModel ? { reportedModel: parsed.reportedModel } : {}),
    });
    // The worktree is deliberately NOT cleaned up here on success -- it stays
    // pending until a human decides the reported diff review (see
    // reconcilePendingWorktrees in oathlock-resident-core.ts), which is the
    // only thing allowed to merge it into the real repository or discard it.
    return { status: "returned", result: { ...parsed, resultText: redacted }, worktree };
  } catch (error) {
    // Never silence this: a bare catch here previously made every pre-spawn
    // failure indistinguishable ("provider_exception" with no message),
    // which made a real config/validation bug look identical to a crash.
    console.error(`[resident] ${input.provider} launch exception:`, error instanceof Error ? error.stack ?? error.message : error);
    await deps.recordEvent({ event: processAcknowledged ? "fail_provider" : "fail_launch", sequence: sequence++, failureCode: "provider_exception" });
    await quarantineOrRemove(input.grant.repositoryRoot, worktree, deps, Boolean(processAcknowledged));
    return { status: processAcknowledged ? "provider_failed" : "launch_failed", result: null, worktree: null };
  }
}

/** Failure/cancellation cleanup for a workspace_write grant's worktree: quarantine (keep, moved aside) when the process actually started running -- there may be partial work worth inspecting -- otherwise just remove it, since nothing ever ran inside it. A no-op for read_only grants, which never create a worktree. */
async function quarantineOrRemove(
  repositoryRoot: string,
  worktree: WorktreeIsolation | null,
  deps: { quarantineWorktree?: typeof quarantineGrantWorktree; removeWorktree?: typeof removeGrantWorktree },
  keepForInspection: boolean,
): Promise<void> {
  if (!worktree) return;
  try {
    if (keepForInspection) await (deps.quarantineWorktree ?? quarantineGrantWorktree)(repositoryRoot, worktree.worktreeRoot);
    else await (deps.removeWorktree ?? removeGrantWorktree)(repositoryRoot, worktree.worktreeRoot);
  } catch (error) {
    // Never let worktree cleanup failure mask the real launch failure that's
    // already being returned to the caller -- log and move on.
    console.error(`[resident] worktree cleanup failed for ${worktree.worktreeRoot}:`, error instanceof Error ? error.message : error);
  }
}
