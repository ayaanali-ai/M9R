/**
 * M9R CLI v0 — testable core
 * ----------------------------------------------------------------------------
 * A small, repo-local CLI that lets a developer or coding agent:
 *   - `m9r init`                       connect a workspace (human-approved)
 *   - `m9r connect`                    detect installed agent CLIs (Claude Code, Codex,
 *                                       OpenCode) on this machine and connect all of them
 *                                       in one command, instead of re-running `init` from
 *                                       inside each agent's own terminal. `--agents
 *                                       <kind,kind,...>` connects a specific list instead
 *                                       of detecting.
 *   - `m9r disconnect`                 revoke connection + clear local volatile files
 *   - `m9r rules`                      fetch active workspace rules
 *   - `m9r inbox`                      pull dashboard instructions
 *   - `m9r submit-session <f> --approved`  submit an approved/redacted session
 *   - `m9r doctor`                     check local setup + API reachability
 *
 * It is a thin client over the EXISTING Agent Join API. It does not change API
 * behavior, schema, or the human-approval contract. All IO (network, fs, env,
 * stdout) is injected via `CliDeps` so the command logic is unit-testable with
 * no real network and no writes outside a temp dir.
 *
 * Secrets discipline:
 *  - Each runtime's scoped token is written once to its gitignored agent profile.
 *  - The full token is never printed after saving — only a masked preview.
 *  - Any token value is redacted from error output before it is shown.
 */

import { createHash, randomUUID } from "node:crypto";
import { join, extname, basename, dirname } from "node:path";
import {
  agentKindLabel,
  applyWorkflowBlock,
  bootstrapTargetFor,
  inspectWorkflowBlock,
  removeWorkflowBlock,
} from "@/lib/oathlock-bootstrap-core";
import { negotiateAdapterActions, type AdapterAction } from "@/lib/adapter-contract";
import { parseProviderAdapterConfig, type ProviderAdapterConfig } from "@/lib/provider-adapter-config";
import { detectInstalledAgents, parseAgentsFlag, type VersionProbe } from "@/lib/agent-detection-core";
import {
  mergeClaudeCodeLocalSettings,
  mergeCodexHooks,
  buildOpenCodeMemoryPlugin,
  CAPTURE_HOOK_SCRIPT_SOURCE,
  CAPTURE_HOOK_RELATIVE_PATH,
  CAPTURE_HOOK_MARKER,
  OPENCODE_CAPTURE_MARKER,
  removeCaptureHook,
} from "@/lib/cross-agent-capture-setup-core";
import { HEARTBEAT_PROTOCOL_VERSION } from "@/lib/agent-heartbeat";
import { printNativeStatus, runNativeCommand, type NativeIo } from "@/lib/native/native-commands";
import { runMemory } from "@/lib/native/memory-command";

/** Actions this CLI currently implements. */
const CLI_IMPLEMENTED_ACTIONS = ["heartbeat", "rules_read", "inbox_read", "assignment_lifecycle", "run_lifecycle", "work_signal_emit", "work_signal_replay", "work_signal_ack", "evidence_submit", "token_rotation"];

export const DEFAULT_API_URL = "https://app.m9r.workers.dev";
// NOT renamed to ".m9r" -- confirmed live against a real connected repo that
// the actual persisted directory on disk is still ".oathlock" (real token,
// config.json, run.json all present there). The master plan explicitly
// scopes the directory/CLI-binary rename as a separate, riskier project not
// yet started -- this constant briefly said ".m9r" anyway (unclear origin,
// possibly an earlier pass in this same repo), which silently broke every
// already-connected repo's CLI: `m9r doctor` reported "no token" against a
// repo that has a real one, because it was looking in a directory that was
// never actually created. Reverted to match reality, not the aspiration.
export const M9R_DIR = ".oathlock";

/** Non-secret defaults used when registering a workspace connection. */
const DEFAULT_RULE_TARGETS = ["CLAUDE.md", "AGENTS.md", ".cursor/rules"];
const DEFAULT_CAPABILITIES = ["rules:read", "session:submit", "instructions:read"];
export const SUPPORTED_AGENT_KINDS = ["codex", "claude-code", "grok-build", "opencode", "other"] as const;
export type SupportedAgentKind = (typeof SUPPORTED_AGENT_KINDS)[number];

// ---------------------------------------------------------------------------
// Injected dependencies
// ---------------------------------------------------------------------------

export interface CliDeps {
  cwd: string;
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  removeFile?(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  fileExists(path: string): Promise<boolean>;
  out(line: string): void;
  err(line: string): void;
  /** Best-effort browser open (no-op in tests). */
  openUrl?(url: string): void | Promise<void>;
  /** Test knobs for the init poll loop. */
  pollIntervalMs?: number;
  maxPolls?: number;
  sleep?(ms: number): Promise<void>;
  /**
   * Real-machine agent-CLI detection for `connect` (runs `<binary>
   * --version`, resolves to its stdout on success or null otherwise).
   * Omitted in tests and in any runtime that can't safely spawn child
   * processes -- `connect` requires an explicit --agents list in that case
   * rather than silently reporting nothing installed.
   */
  probeVersion?: VersionProbe;
  /** Interactive yes/no for setup and uninstall; absent without a terminal. */
  confirm?(question: string): Promise<boolean>;
  /** Local-only capture spool drain, wired by the real entrypoint and injected in tests. */
  drainCapture?(): Promise<{ drained: number; failed: number }>;
}

// ---------------------------------------------------------------------------
// Small helpers (pure)
// ---------------------------------------------------------------------------

/** Resolve the API base URL: OATHLOCK_API_URL overrides the public default. */
export function apiBase(env: Record<string, string | undefined>): string {
  const raw = (env.OATHLOCK_API_URL || "").trim();
  return (raw || DEFAULT_API_URL).replace(/\/+$/, "");
}

export function localPath(cwd: string): string {
  return join(cwd, M9R_DIR, "local.json");
}
export function configPath(cwd: string): string {
  return join(cwd, M9R_DIR, "config.json");
}
export function agentLocalPath(cwd: string, agentKind: string): string {
  return join(cwd, M9R_DIR, "agents", agentKind, "local.json");
}
export function agentConfigPath(cwd: string, agentKind: string): string {
  return join(cwd, M9R_DIR, "agents", agentKind, "config.json");
}
export function agentRunPath(cwd: string, agentKind: string): string {
  return join(cwd, M9R_DIR, "agents", agentKind, "run.json");
}
export function agentAdapterPath(cwd: string, agentKind: string): string {
  return join(cwd, M9R_DIR, "agents", agentKind, "adapter.json");
}
export function rulesPath(cwd: string): string {
  return join(cwd, M9R_DIR, "rules.json");
}
export function runPath(cwd: string): string {
  return join(cwd, M9R_DIR, "run.json");
}
export function adapterPath(cwd: string): string {
  return join(cwd, M9R_DIR, "adapter.json");
}

/** Map a session file extension to the API's session_format value. */
export function inferSessionFormat(filename: string): string {
  switch (extname(filename).toLowerCase()) {
    case ".md":
      return "markdown_export";
    case ".json":
      return "json";
    case ".jsonl":
      return "jsonl";
    case ".txt":
    case ".log":
      return "text_log";
    default:
      return "text_log";
  }
}

/** A non-reversible preview of a token, e.g. `m9r_…a1b2`. Never the full value. */
export function maskToken(token: string | undefined | null): string {
  if (!token) return "(none)";
  const tail = token.slice(-4);
  return `m9r_…${tail}`;
}

/** Remove any occurrence of the live token from text shown to the user. */
export function redactToken(text: string, token: string | undefined | null): string {
  if (!token) return text;
  return text.split(token).join("oak_***REDACTED***");
}

const AGENT_KIND_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/**
 * Accepts any well-formed provider name, not just the fixed list a name
 * happens to have real ACP adapter code for today. SUPPORTED_AGENT_KINDS
 * still matters -- those are the kinds with actual integration (automatic
 * AGENTS.md/CLAUDE.md bootstrap, a real ACP adapter for @mention-triggered
 * sessions) -- but gatekeeping the connection itself on that list was the
 * wrong layer: it blocked even registering a new tool's identity before any
 * integration work could exist for it. Anything outside the known list
 * falls back to the same manual "other" treatment that literal word used to
 * mean, just keeping the real name instead of discarding it.
 */
export function resolveAgentKind(
  explicit: string | undefined,
  env: Record<string, string | undefined>,
): { kind?: string; error?: string } {
  const detected = env.CODEX_HOME || env.CODEX_THREAD_ID ? "codex" : env.CLAUDE_CODE || env.CLAUDECODE ? "claude-code" : env.GROK_BUILD || env.GROK_CLI ? "grok-build" : undefined;
  const requested = (explicit ?? env.OATHLOCK_AGENT_KIND)?.trim().toLowerCase();
  if (detected && requested && detected !== requested) {
    return { error: `Agent identity mismatch: this runtime identifies as ${detected}, not ${requested}. Connect Codex from Codex and Claude Code from Claude Code.` };
  }
  const value = requested ?? detected;
  if (!value) return { error: `Could not determine agent kind. Re-run with --agent-kind <name> (e.g. ${SUPPORTED_AGENT_KINDS.join(", ")}, or any other agent's name).` };
  if (!AGENT_KIND_SLUG_PATTERN.test(value)) return { error: "agent kind must be lowercase letters, numbers, and hyphens only (1-40 characters, no leading/trailing hyphen)." };
  return { kind: value };
}

function redactCliText(text: string, token: string | undefined | null): string {
  return redactToken(text, token)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{6,}|oak_[A-Za-z0-9_-]{6,}|ghp_[A-Za-z0-9_-]{6,}|github_pat_[A-Za-z0-9_-]{6,})\b/g, "[redacted]")
    .replace(/\b(api[_-]?key|authorization|credential|password|secret|token)\s*[:=]\s*("[^"]+"|'[^']+'|[^\s,;]+)/gi, "$1=[redacted]");
}

function safeCliLine(value: unknown, token: string | undefined | null, maxLength = 1000): string {
  if (value == null) return "";
  return redactCliText(String(value), token)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, maxLength)
    .trim();
}

interface LocalState {
  token?: string;
  scopes?: string[];
  claim_id?: string;
  saved_at?: string;
}

interface PreRegisteredClaim {
  claim_id: string;
  setup_code: string;
  expires_at?: string;
}

// ---------------------------------------------------------------------------
// IO helpers (use injected deps)
// ---------------------------------------------------------------------------

/**
 * Parse JSON written by a local tool. Strips a leading UTF-8 BOM first —
 * Windows PowerShell `Set-Content -Encoding UTF8` prepends one (U+FEFF),
 * which makes a raw `JSON.parse` throw. Returns null on any parse failure so
 * callers keep their safe fallback (never throws).
 */
export function parseLocalJson(raw: string): unknown {
  try {
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function detectedAgentKind(env: Record<string, string | undefined>): string | null {
  const resolved = resolveAgentKind(undefined, env);
  return resolved.kind ?? null;
}

async function resolvedLocalPath(deps: CliDeps, explicit?: string): Promise<string> {
  const kind = explicit ?? detectedAgentKind(deps.env);
  // A runtime with a known identity must never borrow the shared legacy
  // profile. That fallback was the concrete path by which a Codex process
  // could authenticate with an OpenCode token and have every run attributed
  // to OpenCode on the server. Missing scoped profiles fail closed instead.
  if (kind) return agentLocalPath(deps.cwd, kind);
  return localPath(deps.cwd);
}

async function readLocal(deps: CliDeps, explicit?: string): Promise<LocalState | null> {
  try {
    const path = await resolvedLocalPath(deps, explicit);
    if (!(await deps.fileExists(path))) return null;
    const raw = await deps.readFile(path);
    return parseLocalJson(raw) as LocalState | null;
  } catch {
    return null;
  }
}

async function writeJson(deps: CliDeps, path: string, value: unknown): Promise<void> {
  await deps.mkdir(dirname(path));
  await deps.writeFile(path, JSON.stringify(value, null, 2) + "\n");
}

async function ensureSelfIgnoredDir(deps: CliDeps): Promise<void> {
  const path = join(deps.cwd, M9R_DIR, ".gitignore");
  if (await deps.fileExists(path)) return;
  await deps.mkdir(dirname(path));
  await deps.writeFile(path, "# Local M9R state: tokens and runtime files. Never commit.\n*\n");
}

async function removeExistingFile(deps: CliDeps, path: string): Promise<boolean> {
  try {
    if (!(await deps.fileExists(path))) return false;
    if (!deps.removeFile) return false;
    await deps.removeFile(path);
    return true;
  } catch {
    return false;
  }
}

interface RunState {
  run_id?: string;
  task_title?: string;
  started_at?: string;
  /** Stamped on write so a legacy shared run.json can never be claimed by a different agent kind. */
  agent_kind?: string;
}

/**
 * Where this runtime's active run is persisted. Per-agent when the agent kind
 * is known (two agents in one repo must never fight over one run.json — the
 * same collision the per-agent token profiles fixed); legacy shared path only
 * for undetectable runtimes.
 */
function runStatePath(deps: CliDeps): string {
  const kind = detectedAgentKind(deps.env);
  return kind ? agentRunPath(deps.cwd, kind) : runPath(deps.cwd);
}

/**
 * Persist the active run pointer for THIS runtime, stamped with the local
 * agent kind so the legacy shared file can never be claimed cross-kind.
 * Local file only — run attribution to the SERVER always comes from the
 * Bearer connection, never from anything written here.
 */
async function persistActiveRun(deps: CliDeps, runId: string, taskTitle: string | null): Promise<string> {
  const kind = detectedAgentKind(deps.env);
  await writeJson(deps, runStatePath(deps), {
    run_id: runId,
    task_title: taskTitle,
    started_at: new Date().toISOString(),
    ...(kind ? { agent_kind: kind } : {}),
  });
  return kind ? `${M9R_DIR}/agents/${kind}/run.json` : `${M9R_DIR}/run.json`;
}

/**
 * Read the active run for THIS agent kind. Prefers the per-agent run.json;
 * never falls back to the legacy shared file for a detected runtime. The
 * shared pointer is only readable when the caller has no detectable provider
 * identity, which is the explicit legacy/manual integration case.
 */
async function readRun(deps: CliDeps): Promise<RunState | null> {
  try {
    const kind = detectedAgentKind(deps.env);
    if (kind) {
      const preferred = agentRunPath(deps.cwd, kind);
      if (await deps.fileExists(preferred)) {
        return parseLocalJson(await deps.readFile(preferred)) as RunState | null;
      }
      return null;
    }
    if (!(await deps.fileExists(runPath(deps.cwd)))) return null;
    const legacy = parseLocalJson(await deps.readFile(runPath(deps.cwd))) as RunState | null;
    // Trust the legacy shared file only when it's unstamped (old, single-agent
    // era) or stamped for the SAME kind this call detected. Previously this
    // check only fired when `kind` was itself known -- if detection silently
    // failed (env vars like CODEX_HOME not inherited by whatever invoked this
    // command), a legacy file stamped for a DIFFERENT agent still got handed
    // back as if it belonged here, pointing coordinate/dispatch calls at a
    // stale run started by a different agent kind entirely.
    if (legacy?.agent_kind && legacy.agent_kind !== kind) return null;
    return legacy;
  } catch {
    return null;
  }
}

interface AdapterState {
  adapter_instance_id?: string;
  last_client_sequence?: number;
}

/** A fresh, bounded adapter-instance id. Uniqueness-only, not a security token. */
export function generateAdapterInstanceId(): string {
  return `adapter-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Where this runtime's Work Signal adapter identity/sequence lives. Per-agent
 * when the kind is known — two agents sharing one adapter identity would
 * corrupt each other's client sequences and idempotency keys. A per-agent
 * runtime never inherits the legacy shared adapter.json; it mints a fresh
 * adapter instance instead.
 */
function adapterStatePath(deps: CliDeps): string {
  const kind = detectedAgentKind(deps.env);
  return kind ? agentAdapterPath(deps.cwd, kind) : adapterPath(deps.cwd);
}

/** Read this runtime's persisted Work Signal adapter identity/sequence. Missing/invalid → null. */
async function readAdapterState(deps: CliDeps): Promise<AdapterState | null> {
  try {
    const path = adapterStatePath(deps);
    if (!(await deps.fileExists(path))) return null;
    const raw = await deps.readFile(path);
    return parseLocalJson(raw) as AdapterState | null;
  } catch {
    return null;
  }
}

/** Load (or lazily create) this runtime's adapter identity, and the next client sequence to use. */
async function nextAdapterSequence(deps: CliDeps): Promise<{ adapterInstanceId: string; clientSequence: number }> {
  const existing = await readAdapterState(deps);
  let lastSequence = typeof existing?.last_client_sequence === "number" ? existing.last_client_sequence : 0;
  const adapterInstanceId = existing?.adapter_instance_id && existing.adapter_instance_id.length >= 8
    ? existing.adapter_instance_id
    : generateAdapterInstanceId();
  // First per-agent use on a workspace that emitted through the legacy shared
  // adapter: seed the sequence from the legacy file so this connection's
  // counter never moves backwards (the server rejects that as a replay).
  const path = adapterStatePath(deps);
  if (!existing && path !== adapterPath(deps.cwd)) {
    try {
      if (await deps.fileExists(adapterPath(deps.cwd))) {
        const legacy = parseLocalJson(await deps.readFile(adapterPath(deps.cwd))) as AdapterState | null;
        if (typeof legacy?.last_client_sequence === "number") lastSequence = legacy.last_client_sequence;
      }
    } catch {
      /* unreadable legacy state — start fresh */
    }
  }
  const clientSequence = lastSequence + 1;
  await writeJson(deps, path, { adapter_instance_id: adapterInstanceId, last_client_sequence: clientSequence });
  return { adapterInstanceId, clientSequence };
}

/**
 * Pull the rule array out of a saved `/api/agent/rules` response, tolerating
 * both `{ rules: [...] }` and `{ rules: { items: [...] } }` (and a bare array).
 * Returns [] for anything unrecognized.
 */
export function extractLoadedRules(saved: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(saved)) return saved.filter((r) => r && typeof r === "object");
  if (!saved || typeof saved !== "object") return [];
  const obj = saved as Record<string, unknown>;
  const rules = obj.rules;
  if (Array.isArray(rules)) return rules.filter((r) => r && typeof r === "object");
  if (rules && typeof rules === "object") {
    const items = (rules as Record<string, unknown>).items;
    if (Array.isArray(items)) return items.filter((r) => r && typeof r === "object");
  }
  return [];
}

/**
 * Read `.oathlock/rules.json` (written by `m9r-cli rules`) and return the saved
 * rules. Missing/invalid/empty file → []. Never throws.
 */
async function readSavedRules(deps: CliDeps): Promise<Array<Record<string, unknown>>> {
  try {
    if (!(await deps.fileExists(rulesPath(deps.cwd)))) return [];
    const raw = await deps.readFile(rulesPath(deps.cwd));
    return extractLoadedRules(parseLocalJson(raw));
  } catch {
    return [];
  }
}

interface ApiResult {
  ok: boolean;
  status: number;
  json: Record<string, unknown> | null;
  text: string;
  networkError?: string;
}

interface AuthenticatedIdentity {
  agentKind: string;
  workspaceId?: string;
  connectionId?: string;
}

function localProfileDisplay(deps: CliDeps): string {
  const kind = detectedAgentKind(deps.env);
  return kind ? `${M9R_DIR}/agents/${kind}/local.json` : `${M9R_DIR}/local.json`;
}

/**
 * Ask the server which connection the bearer token actually represents.
 * Provider identity is a server-side property of the token, never a value
 * supplied by the CLI. Known runtimes fail closed on a mismatch so a stale or
 * copied token cannot silently create an OpenCode run from a Codex process.
 */
async function authenticatedIdentity(
  deps: CliDeps,
  local: LocalState,
): Promise<{ identity?: AuthenticatedIdentity; error?: string }> {
  const result = await apiFetch(deps, `${apiBase(deps.env)}/api/agent/whoami`, {
    headers: { authorization: `Bearer ${local.token}` },
  });
  if (!result.ok || !result.json) {
    return { error: `whoami failed: ${describeFailure(result, local.token)}` };
  }
  const agentKindValue = result.json.agentKind ?? result.json.agent_kind;
  if (typeof agentKindValue !== "string" || !agentKindValue.trim()) {
    return { error: "whoami failed: the server did not return an authenticated agent identity." };
  }
  const identity: AuthenticatedIdentity = {
    agentKind: agentKindValue.trim().toLowerCase(),
    workspaceId: typeof result.json.workspaceId === "string" ? result.json.workspaceId : undefined,
    connectionId: typeof result.json.connectionId === "string" ? result.json.connectionId : undefined,
  };
  const expected = detectedAgentKind(deps.env);
  if (expected && identity.agentKind !== expected) {
    return {
      error: `identity mismatch: this runtime is ${expected}, but its token authenticates as ${identity.agentKind}. Use ${M9R_DIR}/agents/${expected}/local.json or reconnect that provider; the shared ${M9R_DIR}/local.json is not used for detected runtimes.`,
    };
  }
  return { identity };
}

async function apiFetch(
  deps: CliDeps,
  url: string,
  init?: RequestInit,
): Promise<ApiResult> {
  try {
    const res = await deps.fetch(url, init);
    const text = await res.text();
    let json: Record<string, unknown> | null = null;
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, json, text };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      json: null,
      text: "",
      networkError: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Build a one-line, token-safe description of a failed API result. */
function describeFailure(result: ApiResult, token?: string | null): string {
  if (result.networkError) {
    return `network error: ${redactToken(result.networkError, token)}`;
  }
  const apiMsg =
    (result.json && typeof result.json.error === "string" && result.json.error) ||
    result.text ||
    "(no response body)";
  return `HTTP ${result.status}: ${redactToken(String(apiMsg), token)}`;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  positionals: string[];
  approved: boolean;
  force: boolean;
  skipBootstrap: boolean;
  skipMemoryCapture: boolean;
  withMemoryCapture: boolean;
  channel: string | undefined;
  wait: boolean;
  timeoutSeconds: number | undefined;
  file?: string;
  repo?: string;
  agentKind?: string;
  agents?: string;
  task?: string;
  phase?: string;
  baselineRun?: string;
  laterRun?: string;
  type?: string;
  summary?: string;
  scope?: string;
  correlationId?: string;
  parentEventId?: string;
  since?: string;
  limit?: string;
  through?: string;
  run?: string;
  evidenceRecord?: string;
  evidenceContract?: string;
  mode?: string;
  need?: string;
  intent?: string;
  criteria?: string;
  binding?: string;
  allow?: string;
  deny?: string;
  capability?: string;
  preferredProvider?: string;
  maxTokens?: string;
  maxDurationMs?: string;
  maxLatencyMs?: string;
  decision?: string;
  rationale?: string;
  planEffect?: string;
  topic?: string;
  with?: string;
  to?: string;
  text?: string;
  conversation?: string;
  title?: string;
  environment?: string;
  observed?: string;
  evidenceLevel?: string;
  suggested?: string;
  limitations?: string;
  adapterCommand?: string;
  adapterArgs?: string;
  adapterProtocol?: string;
  adapterShell: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  let approved = false;
  let force = false;
  let skipBootstrap = false;
  let skipMemoryCapture = false;
  let withMemoryCapture = false;
  let channel: string | undefined;
  let wait = false;
  let timeoutSeconds: number | undefined;
  let file: string | undefined;
  let repo: string | undefined;
  let agentKind: string | undefined;
  let agents: string | undefined;
  let task: string | undefined;
  let phase: string | undefined;
  let baselineRun: string | undefined;
  let laterRun: string | undefined;
  let type: string | undefined;
  let summary: string | undefined;
  let scope: string | undefined;
  let correlationId: string | undefined;
  let parentEventId: string | undefined;
  let since: string | undefined;
  let limit: string | undefined;
  let through: string | undefined;
  let run: string | undefined;
  let evidenceRecord: string | undefined;
  let evidenceContract: string | undefined;
  let mode: string | undefined;
  let need: string | undefined;
  let intent: string | undefined;
  let criteria: string | undefined;
  let binding: string | undefined;
  let allow: string | undefined;
  let deny: string | undefined;
  let capability: string | undefined;
  let preferredProvider: string | undefined;
  let maxTokens: string | undefined;
  let maxDurationMs: string | undefined;
  let maxLatencyMs: string | undefined;
  let decision: string | undefined;
  let rationale: string | undefined;
  let planEffect: string | undefined;
  let topic: string | undefined;
  let withArg: string | undefined;
  let to: string | undefined;
  let text: string | undefined;
  let conversation: string | undefined;
  let title: string | undefined;
  let environment: string | undefined;
  let observed: string | undefined;
  let evidenceLevel: string | undefined;
  let suggested: string | undefined;
  let limitations: string | undefined;
  let adapterCommand: string | undefined;
  let adapterArgs: string | undefined;
  let adapterProtocol: string | undefined;
  let adapterShell = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--approved") {
      approved = true;
    } else if (a === "--force") {
      force = true;
    } else if (a === "--skip-bootstrap") {
      skipBootstrap = true;
    } else if (a === "--skip-memory-capture") {
      skipMemoryCapture = true;
    } else if (a === "--memory-capture") {
      withMemoryCapture = true;
    } else if (a === "--wait") {
      wait = true;
    } else if (a === "--channel" || a.startsWith("--channel=")) {
      channel = a.includes("=") ? a.split("=").slice(1).join("=") : args[++i];
    } else if (a === "--timeout" || a.startsWith("--timeout=")) {
      const raw = a.includes("=") ? a.split("=").slice(1).join("=") : args[++i];
      const seconds = Number(raw);
      timeoutSeconds = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 900) : undefined;
    } else if (a === "--file" || a.startsWith("--file=")) {
      file = a.includes("=") ? a.split("=").slice(1).join("=") : args[++i];
    } else if (a === "--repo" || a.startsWith("--repo=")) {
      repo = a.includes("=") ? a.split("=").slice(1).join("=") : args[++i];
    } else if (a === "--agent-kind" || a.startsWith("--agent-kind=")) {
      agentKind = a.includes("=") ? a.split("=").slice(1).join("=") : args[++i];
    } else if (a === "--agents" || a.startsWith("--agents=")) {
      agents = a.includes("=") ? a.split("=").slice(1).join("=") : args[++i];
    } else if (a === "--task" || a.startsWith("--task=")) {
      task = a.includes("=") ? a.split("=").slice(1).join("=") : args[++i];
    } else if (a === "--phase" || a.startsWith("--phase=")) {
      phase = a.includes("=") ? a.split("=").slice(1).join("=") : args[++i];
    } else if (a === "--baseline-run" || a.startsWith("--baseline-run=")) {
      baselineRun = a.includes("=") ? a.split("=").slice(1).join("=") : args[++i];
    } else if (a === "--later-run" || a.startsWith("--later-run=")) {
      laterRun = a.includes("=") ? a.split("=").slice(1).join("=") : args[++i];
    } else if (a === "--type" || a.startsWith("--type=")) {
      type = a.includes("=") ? a.split("=").slice(1).join("=") : args[++i];
    } else if (a === "--summary" || a.startsWith("--summary=")) {
      summary = a.includes("=") ? a.split("=").slice(1).join("=") : args[++i];
    } else if (a === "--scope" || a.startsWith("--scope=")) {
      scope = a.includes("=") ? a.split("=").slice(1).join("=") : args[++i];
    } else if (a === "--correlation-id" || a.startsWith("--correlation-id=")) {
      correlationId = a.includes("=") ? a.split("=").slice(1).join("=") : args[++i];
    } else if (a === "--parent-event-id" || a.startsWith("--parent-event-id=")) {
      parentEventId = a.includes("=") ? a.split("=").slice(1).join("=") : args[++i];
    } else if (a === "--since" || a.startsWith("--since=")) {
      since = a.includes("=") ? a.split("=").slice(1).join("=") : args[++i];
    } else if (a === "--limit" || a.startsWith("--limit=")) {
      limit = a.includes("=") ? a.split("=").slice(1).join("=") : args[++i];
    } else if (a === "--through" || a.startsWith("--through=")) {
      through = a.includes("=") ? a.split("=").slice(1).join("=") : args[++i];
    } else if (a === "--run" || a.startsWith("--run=")) {
      run = a.includes("=") ? a.split("=").slice(1).join("=") : args[++i];
    } else if (a === "--evidence-record" || a.startsWith("--evidence-record=")) {
      evidenceRecord = a.includes("=") ? a.split("=").slice(1).join("=") : args[++i];
    } else if (a === "--evidence-contract" || a.startsWith("--evidence-contract=")) {
      evidenceContract = a.includes("=") ? a.split("=").slice(1).join("=") : args[++i];
    } else if (a === "--mode" || a.startsWith("--mode=")) {
      mode = a.includes("=") ? a.split("=").slice(1).join("=") : args[++i];
    } else if (a === "--need" || a.startsWith("--need=")) {
      need = a.includes("=") ? a.split("=").slice(1).join("=") : args[++i];
    } else if (a === "--intent" || a.startsWith("--intent=")) {
      intent = a.includes("=") ? a.split("=").slice(1).join("=") : args[++i];
    } else if (a === "--criteria" || a.startsWith("--criteria=")) {
      criteria = a.includes("=") ? a.split("=").slice(1).join("=") : args[++i];
    } else if (a === "--binding" || a.startsWith("--binding=")) {
      binding = a.includes("=") ? a.split("=").slice(1).join("=") : args[++i];
    } else if (a === "--allow" || a.startsWith("--allow=")) {
      allow = a.includes("=") ? a.split("=").slice(1).join("=") : args[++i];
    } else if (a === "--deny" || a.startsWith("--deny=")) {
      deny = a.includes("=") ? a.split("=").slice(1).join("=") : args[++i];
    } else if (a === "--capability" || a.startsWith("--capability=")) {
      capability = a.includes("=") ? a.split("=").slice(1).join("=") : args[++i];
    } else if (a === "--preferred-provider" || a.startsWith("--preferred-provider=")) {
      preferredProvider = a.includes("=") ? a.split("=").slice(1).join("=") : args[++i];
    } else if (a === "--max-tokens" || a.startsWith("--max-tokens=")) {
      maxTokens = a.includes("=") ? a.split("=").slice(1).join("=") : args[++i];
    } else if (a === "--max-duration-ms" || a.startsWith("--max-duration-ms=")) {
      maxDurationMs = a.includes("=") ? a.split("=").slice(1).join("=") : args[++i];
    } else if (a === "--max-latency-ms" || a.startsWith("--max-latency-ms=")) {
      maxLatencyMs = a.includes("=") ? a.split("=").slice(1).join("=") : args[++i];
    } else if (a === "--decision" || a.startsWith("--decision=")) {
      decision = a.includes("=") ? a.split("=").slice(1).join("=") : args[++i];
    } else if (a === "--rationale" || a.startsWith("--rationale=")) {
      rationale = a.includes("=") ? a.split("=").slice(1).join("=") : args[++i];
    } else if (a === "--plan-effect" || a.startsWith("--plan-effect=")) {
      planEffect = a.includes("=") ? a.split("=").slice(1).join("=") : args[++i];
    } else if (a === "--topic" || a.startsWith("--topic=")) {
      topic = a.includes("=") ? a.split("=").slice(1).join("=") : args[++i];
    } else if (a === "--with" || a.startsWith("--with=")) {
      withArg = a.includes("=") ? a.split("=").slice(1).join("=") : args[++i];
    } else if (a === "--to" || a.startsWith("--to=")) {
      to = a.includes("=") ? a.split("=").slice(1).join("=") : args[++i];
    } else if (a === "--text" || a.startsWith("--text=")) {
      text = a.includes("=") ? a.split("=").slice(1).join("=") : args[++i];
    } else if (a === "--conversation" || a.startsWith("--conversation=")) {
      conversation = a.includes("=") ? a.split("=").slice(1).join("=") : args[++i];
    } else if (a === "--title" || a.startsWith("--title=")) {
      title = a.includes("=") ? a.split("=").slice(1).join("=") : args[++i];
    } else if (a === "--environment" || a.startsWith("--environment=")) {
      environment = a.includes("=") ? a.split("=").slice(1).join("=") : args[++i];
    } else if (a === "--observed" || a.startsWith("--observed=")) {
      observed = a.includes("=") ? a.split("=").slice(1).join("=") : args[++i];
    } else if (a === "--evidence-level" || a.startsWith("--evidence-level=")) {
      evidenceLevel = a.includes("=") ? a.split("=").slice(1).join("=") : args[++i];
    } else if (a === "--suggested" || a.startsWith("--suggested=")) {
      suggested = a.includes("=") ? a.split("=").slice(1).join("=") : args[++i];
    } else if (a === "--limitations" || a.startsWith("--limitations=")) {
      limitations = a.includes("=") ? a.split("=").slice(1).join("=") : args[++i];
    } else if (a === "--adapter-command" || a.startsWith("--adapter-command=")) {
      adapterCommand = a.includes("=") ? a.split("=").slice(1).join("=") : args[++i];
    } else if (a === "--adapter-args" || a.startsWith("--adapter-args=")) {
      adapterArgs = a.includes("=") ? a.split("=").slice(1).join("=") : args[++i];
    } else if (a === "--adapter-protocol" || a.startsWith("--adapter-protocol=")) {
      adapterProtocol = a.includes("=") ? a.split("=").slice(1).join("=") : args[++i];
    } else if (a === "--adapter-shell") {
      adapterShell = true;
    } else if (!a.startsWith("--")) {
      positionals.push(a);
    }
    // Unknown --flags are ignored on purpose (forward-compatible).
  }
  return { positionals, approved, force, skipBootstrap, skipMemoryCapture, withMemoryCapture, channel, wait, timeoutSeconds, file, repo, agentKind, agents, task, phase, baselineRun, laterRun, type, summary, scope, correlationId, parentEventId, since, limit, through, run, evidenceRecord, evidenceContract, mode, need, intent, criteria, binding, allow, deny, capability, preferredProvider, maxTokens, maxDurationMs, maxLatencyMs, decision, rationale, planEffect, topic, with: withArg, to, text, conversation, title, environment, observed, evidenceLevel, suggested, limitations, adapterCommand, adapterArgs, adapterProtocol, adapterShell };
}

// ---------------------------------------------------------------------------
// Bootstrap — install the automatic agent workflow into repo instructions
// ---------------------------------------------------------------------------

interface WorkspaceConfig {
  agent_kind?: string;
}

/** Read non-secret workspace metadata written by init. Missing/invalid → null. */
async function readConfig(deps: CliDeps, explicit?: string): Promise<WorkspaceConfig | null> {
  try {
    const kind = explicit ?? detectedAgentKind(deps.env);
    const preferred = kind ? agentConfigPath(deps.cwd, kind) : null;
    if (preferred && await deps.fileExists(preferred)) {
      return parseLocalJson(await deps.readFile(preferred)) as WorkspaceConfig | null;
    }
    if (kind) return null;
    if (!(await deps.fileExists(configPath(deps.cwd)))) return null;
    const legacy = parseLocalJson(await deps.readFile(configPath(deps.cwd))) as WorkspaceConfig | null;
    return kind && legacy?.agent_kind && legacy.agent_kind !== kind ? null : legacy;
  } catch {
    return null;
  }
}

/**
 * Resolve the agent kind bootstrap should install for. The approved
 * connection's stored kind (config.json, written at init) is authoritative;
 * an explicit --agent-kind may only confirm it, never override it.
 */
async function resolveBootstrapKind(
  deps: CliDeps,
  requested: string | undefined,
): Promise<{ kind?: string; error?: string }> {
  const config = await readConfig(deps);
  const stored = (config?.agent_kind ?? "").trim().toLowerCase();
  const asked = (requested ?? "").trim().toLowerCase();

  if (asked && !AGENT_KIND_SLUG_PATTERN.test(asked)) {
    return { error: "agent kind must be lowercase letters, numbers, and hyphens only (1-40 characters, no leading/trailing hyphen)." };
  }
  if (stored && !AGENT_KIND_SLUG_PATTERN.test(stored)) {
    return { error: `stored connection has an unsupported agent kind. Reconnect with: npx m9r-cli init --force --agent-kind <kind>` };
  }
  if (stored && asked && stored !== asked) {
    return {
      error: `this workspace's approved connection is ${agentKindLabel(stored)} (${stored}), not ${asked}. The approved connection identity is authoritative — run without --agent-kind, or reconnect with: npx m9r-cli init --force --agent-kind ${asked}`,
    };
  }
  const kind = stored || asked;
  if (!kind) {
    return { error: "could not determine the connected agent kind. Pass --agent-kind <name> (e.g. codex, claude-code, opencode, or any other agent's name)." };
  }
  return { kind };
}

/**
 * Installs whichever provider-specific capture artifact makes a locally-
 * launched (not M9R-bridge-spawned) session of this agent kind flow into
 * `.oathlock/memory/local/<kind>/` -- see cross-agent-capture-core.ts for
 * the drain side and cross-agent-capture-setup-core.ts for what's written.
 * A no-op, honestly, for any kind other than the three with a real,
 * verified per-repo hook/plugin mechanism (item #35's research). Never
 * throws -- a capture-install failure must not invalidate an otherwise
 * successful agent connection, same posture `installWorkflow` already has.
 */
async function installCrossAgentCapture(deps: CliDeps, kind: string): Promise<{ installed: boolean; note: string }> {
  if (kind !== "claude-code" && kind !== "codex" && kind !== "opencode") {
    return { installed: false, note: "" };
  }
  try {
    if (kind === "claude-code" || kind === "codex") {
      const hookPath = join(deps.cwd, CAPTURE_HOOK_RELATIVE_PATH);
      await deps.mkdir(dirname(hookPath));
      await deps.writeFile(hookPath, CAPTURE_HOOK_SCRIPT_SOURCE);
    }
    if (kind === "claude-code") {
      const settingsPath = join(deps.cwd, ".claude", "settings.local.json");
      const existing = (await deps.fileExists(settingsPath)) ? await deps.readFile(settingsPath) : null;
      const { content, changed } = mergeClaudeCodeLocalSettings(existing);
      if (changed) {
        await deps.mkdir(dirname(settingsPath));
        await deps.writeFile(settingsPath, content);
      }
      return {
        installed: true,
        note: changed
          ? "Claude Code sessions in this repo will now be captured into shared memory (.claude/settings.local.json, gitignored, per-developer)."
          : "Claude Code memory capture was already installed.",
      };
    }
    if (kind === "codex") {
      const hooksPath = join(deps.cwd, ".codex", "hooks.json");
      const existing = (await deps.fileExists(hooksPath)) ? await deps.readFile(hooksPath) : null;
      const { content, changed } = mergeCodexHooks(existing);
      if (changed) {
        await deps.mkdir(dirname(hooksPath));
        await deps.writeFile(hooksPath, content);
      }
      return {
        installed: true,
        note: changed
          ? "Codex memory capture written to .codex/hooks.json -- run /hooks inside Codex once in this repo to review and trust it."
          : "Codex memory capture was already installed.",
      };
    }
    // opencode
    const pluginPath = join(deps.cwd, ".opencode", "plugins", "m9r-memory.js");
    await deps.mkdir(dirname(pluginPath));
    await deps.writeFile(pluginPath, buildOpenCodeMemoryPlugin());
    return {
      installed: true,
      note: "OpenCode sessions in this repo will now be captured into shared memory (.opencode/plugins/m9r-memory.js).",
    };
  } catch {
    return { installed: false, note: "Memory capture could not be installed for this agent -- connection is still valid." };
  }
}

/** Removes every capture artifact `capture install` can write in this repo, touching nothing else. */
async function uninstallCrossAgentCapture(deps: CliDeps): Promise<number> {
  const removed: string[] = [];
  for (const rel of [join(".claude", "settings.local.json"), join(".codex", "hooks.json")]) {
    const path = join(deps.cwd, rel);
    if (!(await deps.fileExists(path))) continue;
    const { content, changed } = removeCaptureHook(await deps.readFile(path));
    if (!changed) continue;
    await deps.writeFile(path, content);
    removed.push(`${rel} (M9R hook entry)`);
  }
  const pluginPath = join(deps.cwd, ".opencode", "plugins", "m9r-memory.js");
  if (deps.removeFile && (await deps.fileExists(pluginPath)) && (await deps.readFile(pluginPath)).includes(OPENCODE_CAPTURE_MARKER)) {
    await deps.removeFile(pluginPath);
    removed.push(join(".opencode", "plugins", "m9r-memory.js"));
  }
  const scriptPath = join(deps.cwd, CAPTURE_HOOK_RELATIVE_PATH);
  if (deps.removeFile && (await deps.fileExists(scriptPath))) {
    await deps.removeFile(scriptPath);
    removed.push(CAPTURE_HOOK_RELATIVE_PATH);
  }
  if (removed.length === 0) deps.out("Nothing to remove: no M9R capture integration found in this repo.");
  else {
    deps.out("Removed M9R session capture:");
    for (const item of removed) deps.out(`  ${item}`);
    deps.out("Already-captured memory under .oathlock/memory is left in place; delete it yourself if you want it gone.");
  }
  return 0;
}

/**
 * Repair the local capture integration without repeating the human approval
 * claim. This deliberately authorizes from the *current runtime's* existing
 * local M9R token, while allowing an explicitly named target provider: the
 * operation only writes repo-local hook/plugin files and never represents the
 * target as registered or authenticated with the M9R service.
 */
async function cmdCapture(deps: CliDeps, parsed: ParsedArgs): Promise<number> {
  const sub = parsed.positionals[0];
  if (sub === "drain" && parsed.positionals.length === 1 && !parsed.agentKind) {
    if (!deps.drainCapture) {
      deps.err("capture drain: local capture drain is unavailable in this CLI build.");
      return 1;
    }
    try {
      const result = await deps.drainCapture();
      deps.out(`drained ${result.drained} captured session(s)${result.failed > 0 ? `, ${result.failed} failed` : ""}`);
      return result.failed > 0 ? 1 : 0;
    } catch (error) {
      deps.err(`capture drain: ${error instanceof Error ? error.message : "local capture drain failed"}`);
      return 1;
    }
  }
  if (sub === "uninstall" && parsed.positionals.length === 1) return uninstallCrossAgentCapture(deps);
  if (sub !== "install" || parsed.positionals.length !== 1) {
    deps.err("Usage: m9r-cli capture install [--agent-kind claude-code|codex|opencode]\n       m9r-cli capture uninstall\n       m9r-cli capture drain");
    return 1;
  }

  const requested = parsed.agentKind?.trim().toLowerCase();
  if (requested && !AGENT_KIND_SLUG_PATTERN.test(requested)) {
    deps.err("agent kind must be lowercase letters, numbers, and hyphens only (1-40 characters, no leading/trailing hyphen).");
    return 1;
  }
  // An explicit target may be a sibling provider in the same repo. Prefer its
  // scoped profile when present, then fall back to the current runtime's
  // profile so `codex capture install --agent-kind claude-code` remains a
  // valid local repair operation without creating a new claim.
  const local = await readLocal(deps, requested) ?? await readLocal(deps);
  if (!local?.token) {
    deps.err("capture install requires an existing M9R connection for this runtime. Reconnect with: npx m9r-cli init");
    return 1;
  }

  const inferred = requested ? { kind: requested } : resolveAgentKind(undefined, deps.env);
  if (!inferred.kind) {
    deps.err(`capture install: ${inferred.error}`);
    return 1;
  }
  if (inferred.kind !== "claude-code" && inferred.kind !== "codex" && inferred.kind !== "opencode") {
    deps.err(`capture install: no local capture integration is available for ${inferred.kind}. Supported providers: claude-code, codex, opencode.`);
    return 1;
  }

  const capture = await installCrossAgentCapture(deps, inferred.kind);
  if (!capture.installed) {
    deps.err("capture install: local capture could not be installed. The existing M9R connection was not changed.");
    return 1;
  }
  const providerLabel = inferred.kind === "claude-code"
    ? "Claude Code"
    : inferred.kind === "opencode"
      ? "OpenCode"
      : "Codex";
  deps.out(`Installed local capture for ${providerLabel}.`);
  if (capture.note) deps.out(capture.note);
  deps.out(`This local setup does not register or authenticate ${providerLabel} with M9R.`);
  return 0;
}

/** Install/update the managed workflow block. Shared by bootstrap and init. */
async function installWorkflow(deps: CliDeps, kind: string): Promise<{ ok: boolean; file: string; action: string }> {
  const target = bootstrapTargetFor(kind);
  const path = join(deps.cwd, target.file);
  const existing = (await deps.fileExists(path)) ? await deps.readFile(path) : null;
  const result = applyWorkflowBlock(existing, kind);
  if (!result.changed) return { ok: true, file: target.file, action: "unchanged" };
  const dir = dirname(path);
  if (dir && dir !== deps.cwd) await deps.mkdir(dir);
  await deps.writeFile(path, result.content);
  return { ok: true, file: target.file, action: result.action };
}

async function cmdBootstrap(deps: CliDeps, parsed: ParsedArgs): Promise<number> {
  const sub = parsed.positionals[0];
  const local = await readLocal(deps);
  const connected = Boolean(local?.token);

  if (sub === "status") {
    const identity = await resolveBootstrapKind(deps, parsed.agentKind);
    if (!identity.kind) {
      deps.err(`bootstrap status: ${identity.error}`);
      return 1;
    }
    const target = bootstrapTargetFor(identity.kind);
    const path = join(deps.cwd, target.file);
    const content = (await deps.fileExists(path)) ? await deps.readFile(path) : null;
    const status = inspectWorkflowBlock(content, identity.kind);
    deps.out(`agent kind: ${agentKindLabel(identity.kind)} (${identity.kind})`);
    deps.out(`integration file: ${target.file}`);
    deps.out(`workflow: ${!status.present ? "missing" : status.current ? "installed" : "outdated"}`);
    deps.out(`managed block version: ${status.version ?? "(none)"}`);
    deps.out(`automatic loading: ${target.automatic ? "supported for this agent" : "not assured — manual integration required"}`);
    deps.out(`connection: ${connected ? "active token present" : "inactive (no local token) — the workflow file may exist, but M9R commands will fail until a human reconnects"}`);
    if (!status.present) {
      deps.out(`Install it with: npx m9r-cli bootstrap${parsed.agentKind ? ` --agent-kind ${identity.kind}` : ""}`);
    } else if (!status.current) {
      deps.out("Update it with: npx m9r-cli bootstrap");
    }
    return status.present && status.current ? 0 : 1;
  }

  if (sub === "remove") {
    const identity = await resolveBootstrapKind(deps, parsed.agentKind);
    if (!identity.kind) {
      deps.err(`bootstrap remove: ${identity.error}`);
      return 1;
    }
    const target = bootstrapTargetFor(identity.kind);
    const path = join(deps.cwd, target.file);
    if (!(await deps.fileExists(path))) {
      deps.out(`No changes: ${target.file} does not exist.`);
      return 0;
    }
    const existing = await deps.readFile(path);
    const result = removeWorkflowBlock(existing);
    if (!result.changed) {
      deps.out(`No changes: no M9R-managed block found in ${target.file}.`);
      return 0;
    }
    await deps.writeFile(path, result.content);
    deps.out(`Removed the M9R-managed workflow block from ${target.file}.`);
    deps.out("User-authored content was preserved.");
    return 0;
  }

  if (sub !== undefined && sub !== "install") {
    deps.err("Usage: m9r-cli bootstrap [--agent-kind <kind>] | m9r-cli bootstrap status | m9r-cli bootstrap remove");
    return 1;
  }

  if (!connected) {
    deps.err("bootstrap failed: no approved connection found. Run: npx m9r-cli init");
    return 1;
  }
  const identity = await resolveBootstrapKind(deps, parsed.agentKind);
  if (!identity.kind) {
    deps.err(`bootstrap failed: ${identity.error}`);
    return 1;
  }

  const target = bootstrapTargetFor(identity.kind);
  const installed = await installWorkflow(deps, identity.kind);
  if (installed.action === "unchanged") {
    deps.out(`No changes needed: ${installed.file} already has the current M9R workflow block.`);
  } else {
    deps.out(`Automatic M9R workflow ${installed.action === "updated" ? "updated" : "installed"} in ${installed.file}`);
  }
  if (!target.automatic) {
    deps.out("Note: automatic loading is not assured for this agent kind. Point the agent at the file manually.");
  } else {
    deps.out(`${agentKindLabel(identity.kind)} reads ${installed.file} automatically — agents can now use M9R during normal repo tasks.`);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdInit(deps: CliDeps, parsed: ParsedArgs): Promise<number> {
  const identity = resolveAgentKind(parsed.agentKind, deps.env);
  if (!identity.kind) {
    deps.err(`init failed: ${identity.error}`);
    return 1;
  }
  return connectOneAgent(deps, identity.kind, parsed);
}

/**
 * The full register -> human-approve -> poll -> save -> bootstrap sequence
 * for exactly one agent kind. Extracted out of `cmdInit` (which still does
 * exactly this, for the one env-detected/--agent-kind kind) so `cmdConnect`
 * can run the identical, unweakened path for several kinds in one command --
 * per the explicit security research on this: `resolveAgentKind`'s env
 * check is a UX guardrail, not what `authenticateAgent` relies on
 * downstream (that's the one-time-consume claim token, unchanged here), so
 * looping this same sequence per detected kind introduces no new bypass.
 */
async function connectOneAgent(
  deps: CliDeps,
  agentKind: string,
  parsed: ParsedArgs,
  preRegistered?: PreRegisteredClaim,
  options: { showApprovalPrompt?: boolean } = {},
): Promise<number> {
  let adapterConfig: ProviderAdapterConfig | null = null;
  if (parsed.adapterCommand || parsed.adapterArgs || parsed.adapterShell) {
    let args: unknown = [];
    if (parsed.adapterArgs) {
      try {
        args = JSON.parse(parsed.adapterArgs);
      } catch {
        deps.err('init failed: --adapter-args must be a JSON array, for example ["acp"].');
        return 1;
      }
    }
    const validated = parseProviderAdapterConfig({
      provider: agentKind,
      command: parsed.adapterCommand,
      args,
      shell: parsed.adapterShell,
      ...(parsed.adapterProtocol ? { protocol: parsed.adapterProtocol } : {}),
    }, agentKind);
    if (!validated.ok) {
      deps.err(`init failed: generic adapter configuration is invalid (${validated.error}).`);
      return 1;
    }
    adapterConfig = validated.value;
  }

  // init is a one-time setup step. If this workspace is already connected
  // (a token exists in this runtime's agent profile), reuse it instead of creating a
  // new claim — unless the human explicitly passes --force. The token is never
  // printed here.
  if (!parsed.force) {
    const existing = await readLocal(deps, agentKind);
    if (existing?.token) {
      const activity = await readConnectionActivity(deps, existing.token, agentKind);
      if (!activity.ok) {
        deps.err(`This workspace has a local ${agentKindLabel(agentKind)} token, but M9R could not verify it as active.`);
        deps.err(`No new claim was created. Reconnect explicitly with: npx m9r-cli init --force --agent-kind ${agentKind}`);
        return 1;
      }
      if (activity.authenticated) {
        deps.out("This workspace is connected to M9R.");
        deps.out("  (a real provider authentication was observed by the server)");
      } else {
        deps.out("This workspace is registered with M9R, but no provider process has authenticated yet.");
        deps.out("  (the local token exists; the server has not observed its first provider use)");
      }
      deps.out("No new claim was created. To use the existing connection:");
      deps.out("  npx m9r-cli doctor   # verify setup + API reachability");
      deps.out("  npx m9r-cli rules    # fetch active workspace rules");
      deps.out(`To force a brand-new connection: npx m9r-cli init --force --agent-kind ${agentKind}`);
      return 0;
    }
  }

  const base = apiBase(deps.env);
  const repoHint = parsed.repo || deps.env.OATHLOCK_REPO_HINT || basename(deps.cwd) || "workspace";

  deps.out(`M9R init — API ${base}`);

  const registerBody = {
    agent_kind: agentKind,
    repo_hint: repoHint,
    rule_targets: DEFAULT_RULE_TARGETS,
    capabilities: DEFAULT_CAPABILITIES,
    consent_mode: "human_required",
  };

  const reg: ApiResult = preRegistered
    ? { ok: true, status: 201, json: preRegistered as unknown as Record<string, unknown>, text: "" }
    : await apiFetch(deps, `${base}/api/agent/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(registerBody),
      });
  if (!reg.ok || !reg.json) {
    deps.err(`init failed: ${describeFailure(reg)}`);
    return 1;
  }

  const claimUrl = String(reg.json.claim_url || "");
  const claimId = String(reg.json.claim_id || "");
  const setupCode = String(reg.json.setup_code || ""); // secret, kept in memory only
  if ((!preRegistered && !claimUrl) || !claimId || !setupCode) {
    deps.err("init failed: register response missing claim_url/claim_id/setup_code.");
    return 1;
  }

  if (options.showApprovalPrompt !== false) {
    deps.out("");
    deps.out("Have the repo owner approve this connection:");
    deps.out(`  ${claimUrl}`);
    if (reg.json.expires_at) deps.out(`  (expires ${String(reg.json.expires_at)})`);
    deps.out("");
    if (deps.openUrl && claimUrl) {
      try {
        await deps.openUrl(claimUrl);
      } catch {
        /* opening the browser is best-effort */
      }
    }
  }

  // Poll claim status until approved (setup_code is required and stays secret).
  const interval = deps.pollIntervalMs ?? 2000;
  const maxPolls = deps.maxPolls ?? 150;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const statusUrl = `${base}/api/agent/claim-status?claim_id=${encodeURIComponent(
    claimId,
  )}&setup_code=${encodeURIComponent(setupCode)}`;

  deps.out("Waiting for human approval…");
  for (let i = 0; i < maxPolls; i++) {
    await sleep(interval);
    const poll = await apiFetch(deps, statusUrl);
    if (!poll.ok || !poll.json) {
      deps.err(`init failed while polling: ${describeFailure(poll, setupCode)}`);
      return 1;
    }
    const status = String(poll.json.status || "");
    if (status === "pending") continue;
    if (status === "rejected") {
      deps.err("init failed: the connection was rejected. Run init again to retry.");
      return 1;
    }
    if (status === "expired") {
      deps.err("init failed: the claim expired before approval. Run init again.");
      return 1;
    }
    if (status === "approved") {
      const token = typeof poll.json.token === "string" ? poll.json.token : "";
      if (!token) {
        deps.err(
          "init failed: approved, but the token was already retrieved. Delete .oathlock and run init again.",
        );
        return 1;
      }
      const scopes = Array.isArray(poll.json.scopes) ? (poll.json.scopes as string[]) : [];

      // Self-ignoring directory: `.oathlock/.gitignore` ignores everything inside, so the plaintext
      // token can never be committed even if the repo's own .gitignore says nothing about it.
      await ensureSelfIgnoredDir(deps);

      // Store the token ONCE in the gitignored local.json. Never printed in full.
      await writeJson(deps, agentLocalPath(deps.cwd, agentKind), {
        token,
        scopes,
        claim_id: claimId,
        saved_at: new Date().toISOString(),
      } satisfies LocalState);

      // Store non-secret workspace metadata separately.
      await writeJson(deps, agentConfigPath(deps.cwd, agentKind), {
        api_url: base,
        agent_kind: agentKind,
        repo_hint: repoHint,
        rule_targets: DEFAULT_RULE_TARGETS,
        capabilities: DEFAULT_CAPABILITIES,
      });
      if (adapterConfig) {
        await writeJson(deps, agentAdapterPath(deps.cwd, agentKind), adapterConfig);
        deps.out(`Generic ACP adapter saved to ${M9R_DIR}/agents/${agentKind}/adapter.json`);
      }

      deps.out("");
      deps.out("M9R registration approved.");
      deps.out(`  token  ${maskToken(token)} (saved to ${M9R_DIR}/agents/${agentKind}/local.json)`);
      deps.out(`  scopes ${scopes.join(", ") || "(none)"}`);
      deps.out(`Registered agent: ${agentKindLabel(agentKind)}`);
      deps.out(`What leaves this machine: workspace messages and agent replies (including anything an agent quotes from your files), activity and permission events, and heartbeats, sent to ${base}.`);
      deps.out("What stays: your repo files, your provider logins, and finished-session transcripts (unless you turn on capture).");
      deps.out("Runtime verification: pending — this confirms the M9R registration; it does not prove provider sign-in or a running provider process.");

      // Install the repo-native automatic workflow so the connected agent uses
      // M9R during normal tasks. Opt out with --skip-bootstrap. A bootstrap
      // failure never invalidates the approved connection.
      if (parsed.skipBootstrap) {
        deps.out("Skipped automatic workflow install (--skip-bootstrap).");
        deps.out(`Install it later with: npx m9r-cli bootstrap --agent-kind ${agentKind}`);
      } else {
        try {
          const installed = await installWorkflow(deps, agentKind);
          if (installed.action === "unchanged") {
            deps.out(`Automatic M9R workflow already current in ${installed.file}`);
          } else {
            deps.out(`Automatic M9R workflow installed in ${installed.file}`);
          }
          deps.out("Agents can now use M9R during normal repo tasks.");
        } catch {
          deps.out("The connection is approved, but the automatic workflow could not be installed.");
          deps.out(`Install it manually with: npx m9r-cli bootstrap --agent-kind ${agentKind}`);
        }
      }

      if (parsed.skipMemoryCapture) {
        deps.out("Skipped shared-memory capture setup (--skip-memory-capture).");
      } else if (!parsed.withMemoryCapture) {
        deps.out("Session-transcript capture is OFF. To upload finished sessions from this repo into shared memory, run: m9r-cli capture install");
      } else {
        const capture = await installCrossAgentCapture(deps, agentKind);
        if (capture.note) deps.out(capture.note);
      }
      deps.out("");
      deps.out("M9R browser multiplayer is ready after this connection is approved.");
      deps.out("The local terminal runtime is optional and experimental; it is not part of the public launch offer.");
      deps.out("If you are explicitly testing that local capability, start it with: npx m9r-cli terminal runtime");
      deps.out("Turn the experimental bridge off entirely with ACP_BRIDGE_ENABLED=false.");
      return 0;
    }
    deps.err(`init failed: unexpected status "${status}".`);
    return 1;
  }

  deps.err("init failed: timed out waiting for approval. Run init again once approved.");
  return 1;
}

/**
 * `m9r connect` — one command that discovers which coding-agent CLIs are
 * actually installed on this machine (Claude Code, Codex, OpenCode) and
 * connects every one the human wants, instead of requiring `init` to be
 * re-run separately from inside each agent's own terminal. New providers are
 * grouped into one human approval page; their provider tokens remain separate.
 *
 * Honest about what this does and does not prove: detection (a real
 * `--version` probe finding the binary on PATH) only means that CLI is
 * installed, not that it is logged in, and not that any process of it will
 * ever run in this repo. Each detected kind still goes through the exact
 * same register -> human-approve -> one-time-consume claim cycle `init`
 * always used (connectOneAgent, shared code, unchanged security path) --
 * this command removes the friction of re-invoking that per agent, it does
 * not skip the step that actually proves a connection works.
 */
async function cmdConnect(deps: CliDeps, parsed: ParsedArgs): Promise<number> {
  const explicitKinds = parsed.agents ? parseAgentsFlag(parsed.agents) : null;

  let kinds: string[];
  if (explicitKinds && explicitKinds.length > 0) {
    kinds = explicitKinds;
  } else {
    if (!deps.probeVersion) {
      deps.err(
        "connect failed: this runtime cannot probe for installed agents. Pass --agents <kind,kind,...> explicitly (e.g. --agents claude-code,codex).",
      );
      return 1;
    }
    deps.out("Looking for installed coding-agent CLIs on this machine…");
    const detected = await detectInstalledAgents(deps.probeVersion);
    if (detected.length === 0) {
      deps.err(
        "connect failed: no known agent CLI (Claude Code, Codex, OpenCode) was found on PATH. " +
          "Install one first, or pass --agents <kind,kind,...> to connect a CLI this runtime can't detect.",
      );
      return 1;
    }
    for (const agent of detected) {
      deps.out(`  found ${agent.label} (${agent.binary})${agent.versionLine ? ` — ${agent.versionLine}` : ""}`);
    }
    kinds = detected.map((a) => a.kind);
  }

  kinds = [...new Set(kinds)];

  deps.out("");
  deps.out(`Connecting ${kinds.length} agent${kinds.length === 1 ? "" : "s"}: ${kinds.join(", ")}`);

  // Keep already-connected providers on their existing connection. Only new
  // providers enter the grouped claim flow, so reconnecting one provider does
  // not unexpectedly create a new claim for every other provider in the repo.
  const results: Array<{ kind: string; code: number }> = [];
  const pendingKinds: string[] = [];
  for (const kind of kinds) {
    if (!parsed.force && (await readLocal(deps, kind))?.token) {
      deps.out("");
      deps.out(`--- ${agentKindLabel(kind)} (${kind}) ---`);
      results.push({ kind, code: await connectOneAgent(deps, kind, parsed) });
    } else {
      pendingKinds.push(kind);
    }
  }

  if (pendingKinds.length > 0) {
    const base = apiBase(deps.env);
    const repoHint = parsed.repo || deps.env.OATHLOCK_REPO_HINT || basename(deps.cwd) || "workspace";
    const registerBodies = pendingKinds.map((agentKind) => ({
      agent_kind: agentKind,
      repo_hint: repoHint,
      rule_targets: DEFAULT_RULE_TARGETS,
      capabilities: DEFAULT_CAPABILITIES,
      consent_mode: "human_required",
    }));
    deps.out("");
    deps.out(`Creating one approval page for ${pendingKinds.length} new provider connection${pendingKinds.length === 1 ? "" : "s"}…`);
    const reg = await apiFetch(deps, `${base}/api/agent/register-batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agents: registerBodies }),
    });
    if (!reg.ok || !reg.json) {
      deps.err(`connect failed while creating the approval batch: ${describeFailure(reg)}`);
      for (const kind of pendingKinds) results.push({ kind, code: 1 });
    } else {
      const batchUrl = String(reg.json.batch_url || "");
      const claims = Array.isArray(reg.json.claims) ? reg.json.claims as Array<Record<string, unknown>> : [];
      const claimByKind = new Map<string, PreRegisteredClaim>();
      for (const claim of claims) {
        const kind = String(claim.agent_kind || "");
        const claimId = String(claim.claim_id || "");
        const setupCode = String(claim.setup_code || "");
        if (kind && claimId && setupCode) claimByKind.set(kind, { claim_id: claimId, setup_code: setupCode, expires_at: String(claim.expires_at || "") });
      }
      if (!batchUrl || claimByKind.size !== pendingKinds.length) {
        deps.err("connect failed: batch registration returned incomplete approval data.");
        for (const kind of pendingKinds) results.push({ kind, code: 1 });
      } else {
        deps.out("");
        deps.out("Have the repo owner approve all new connections once:");
        deps.out(`  ${batchUrl}`);
        if (reg.json.expires_at) deps.out(`  (claims expire ${String(reg.json.expires_at)})`);
        deps.out("");
        if (deps.openUrl) {
          try {
            await deps.openUrl(batchUrl);
          } catch {
            /* opening the browser is best-effort */
          }
        }
        for (const kind of pendingKinds) {
          deps.out("");
          deps.out(`--- ${agentKindLabel(kind)} (${kind}) ---`);
          const claim = claimByKind.get(kind);
          results.push({ kind, code: claim ? await connectOneAgent(deps, kind, parsed, claim, { showApprovalPrompt: false }) : 1 });
        }
      }
    }
  }

  deps.out("");
  deps.out("Summary:");
  for (const result of results) {
    deps.out(`  ${result.kind}: ${result.code === 0 ? "registered" : "failed"}`);
  }
  const failures = results.filter((r) => r.code !== 0);
  if (failures.length > 0) {
    deps.err(`${failures.length} of ${results.length} agent connection(s) failed. See output above for details.`);
    return 1;
  }
  return 0;
}

async function cmdRules(deps: CliDeps): Promise<number> {
  const base = apiBase(deps.env);
  const local = await readLocal(deps);
  if (!local?.token) {
    deps.err("No token found. Run: m9r-cli init");
    return 1;
  }

  const res = await apiFetch(deps, `${base}/api/agent/rules`, {
    headers: { authorization: `Bearer ${local.token}` },
  });
  if (!res.ok || !res.json) {
    deps.err(`rules failed: ${describeFailure(res, local.token)}`);
    return 1;
  }

  const body = res.json;
  deps.out(`mode: ${String(body.mode ?? "(unknown)")}`);
  if (body.message) deps.out(`message: ${String(body.message)}`);

  const instructions = Array.isArray(body.operating_instructions)
    ? (body.operating_instructions as string[])
    : [];
  if (instructions.length) {
    deps.out("operating instructions:");
    for (const ins of instructions) deps.out(`  - ${ins}`);
  }

  const rules = Array.isArray(body.rules) ? (body.rules as Array<Record<string, unknown>>) : [];
  deps.out(`rules: ${rules.length}`);
  for (const r of rules) {
    const title = r.title ?? r.name ?? r.id ?? "(untitled rule)";
    deps.out(`  - ${String(title)}`);
  }

  await writeJson(deps, rulesPath(deps.cwd), body);
  deps.out(`Saved full response to ${M9R_DIR}/rules.json`);

  // If a run is active, report how many rules were loaded so the dashboard shows
  // it. Best-effort and telemetry-only — never sends rule contents or the token.
  const run = await readRun(deps);
  if (run?.run_id && local.token) {
    await apiFetch(deps, `${base}/api/agent/run/status`, {
      method: "POST",
      headers: { authorization: `Bearer ${local.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        run_id: run.run_id,
        current_phase: "rules loaded",
        rules_loaded_count: rules.length,
      }),
    });
    deps.out(`Updated active run with rules_loaded_count: ${rules.length}`);
  }
  return 0;
}

async function cmdInbox(deps: CliDeps): Promise<number> {
  const base = apiBase(deps.env);
  const local = await readLocal(deps);
  if (!local?.token) {
    deps.err("No token found. Run: m9r-cli init");
    return 1;
  }

  const res = await apiFetch(deps, `${base}/api/agent/inbox`, {
    headers: { authorization: `Bearer ${local.token}` },
  });
  if (!res.ok || !res.json) {
    deps.err(`inbox failed: ${describeFailure(res, local.token)}`);
    return 1;
  }

  const body = res.json;
  const instructions = Array.isArray(body.instructions)
    ? (body.instructions as Array<Record<string, unknown>>)
    : [];

  deps.out("Agent inbox");
  if (body.message) deps.out(`message: ${safeCliLine(body.message, local.token)}`);
  deps.out(`instructions: ${instructions.length}`);
  for (const item of instructions) {
    const id = safeCliLine(item.id, local.token, 80);
    const instruction = safeCliLine(item.instruction ?? item.message, local.token);
    deps.out(`  - ${id ? `${id.slice(0, 8)}: ` : ""}${instruction || "(empty instruction)"}`);
  }

  // Open conversations are checked at the same inbox checkpoint as human
  // instructions -- a peer agent's message surfaces here, not only in a
  // separate command the connected agent has to remember to run.
  const conversationsRes = await apiFetch(deps, `${base}/api/agent/conversations`, {
    headers: { authorization: `Bearer ${local.token}` },
  });
  if (conversationsRes.ok && conversationsRes.json && Array.isArray(conversationsRes.json.conversations)) {
    const conversations = conversationsRes.json.conversations as Array<Record<string, unknown>>;
    deps.out(`open conversations: ${conversations.length}`);
    for (const conversation of conversations) {
      const id = safeCliLine(String(conversation.id ?? "unknown"), local.token, 100);
      const topic = safeCliLine(String(conversation.topic ?? ""), local.token, 200);
      deps.out(`  - ${id.slice(0, 8)}: ${topic} (m9r-cli conversation messages --conversation ${id})`);
    }

    // A handoff addressed to this connection auto-starts a run right here --
    // surface it plainly so it doesn't read as a silent side effect.
    const spawnedRuns = Array.isArray(conversationsRes.json.spawned_runs)
      ? (conversationsRes.json.spawned_runs as Array<Record<string, unknown>>)
      : [];
    for (const spawned of spawnedRuns) {
      const runId = safeCliLine(String(spawned.run_id ?? "unknown"), local.token, 80);
      const taskTitle = safeCliLine(String(spawned.task_title ?? ""), local.token, 200);
      deps.out(`  -> started run ${runId.slice(0, 8)} from a peer handoff: ${taskTitle}`);
    }
  }

  return 0;
}

async function cmdAssignments(deps: CliDeps): Promise<number> {
  const local = await readLocal(deps);
  if (!local?.token) {
    deps.err("No token found. Run: m9r-cli init");
    return 1;
  }
  const res = await apiFetch(deps, `${apiBase(deps.env)}/api/agent/assignments`, {
    headers: { authorization: `Bearer ${local.token}` },
  });
  if (!res.ok || !res.json) {
    deps.err(`assignments failed: ${describeFailure(res, local.token)}`);
    return 1;
  }
  const assignments = Array.isArray(res.json.assignments) ? res.json.assignments as Array<Record<string, unknown>> : [];
  deps.out("Agent assignments");
  deps.out(`assignments: ${assignments.length}`);
  for (const item of assignments) {
    const id = safeCliLine(item.id, local.token, 80);
    const state = safeCliLine(item.state, local.token, 20);
    const task = safeCliLine(item.task, local.token, 500);
    const repository = safeCliLine(item.repository, local.token, 300);
    deps.out(`  - ${id}: ${state} | ${repository} | ${task}`);
    const allowed = Array.isArray(item.scope) ? item.scope.map((value) => safeCliLine(value, local.token, 300)).filter(Boolean) : [];
    const prohibited = Array.isArray(item.prohibited_scope) ? item.prohibited_scope.map((value) => safeCliLine(value, local.token, 300)).filter(Boolean) : [];
    const durationMs = typeof item.max_duration_ms === "number" ? item.max_duration_ms : null;
    const estimatedTokens = typeof item.max_estimated_tokens === "number" ? item.max_estimated_tokens : null;
    deps.out(`    allowed: ${allowed.length ? allowed.join(", ") : "none declared"}`);
    deps.out(`    prohibited: ${prohibited.length ? prohibited.join(", ") : "none declared"}`);
    deps.out(`    maximum duration: ${durationMs ? Math.ceil(durationMs / 60_000) : "unknown"} minutes`);
    deps.out(`    estimated-token budget: ${estimatedTokens ?? "unknown"} (reported boundary; provider enforcement unknown)`);
    deps.out(`    approval: ${safeCliLine(item.approval_policy, local.token, 80) || "unknown"}`);
    deps.out(`    evidence required: ${item.evidence_required === true ? "yes" : "no"}`);
  }
  return 0;
}

async function cmdHeartbeat(deps: CliDeps): Promise<number> {
  const local = await readLocal(deps);
  if (!local?.token) {
    deps.err("No token found. Run: m9r-cli init");
    return 1;
  }
  const config = await readConfig(deps);
  const provider = config?.agent_kind || "other";
  const { adapterInstanceId, clientSequence } = await nextAdapterSequence(deps);
  const res = await apiFetch(deps, `${apiBase(deps.env)}/api/agent/presence/heartbeat`, {
    method: "POST",
    headers: { authorization: `Bearer ${local.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      protocolVersion: HEARTBEAT_PROTOCOL_VERSION,
      adapterInstanceId,
      sequence: clientSequence,
      executionOrigin: "linked",
      provider,
      idempotencyKey: `heartbeat:${adapterInstanceId}:${clientSequence}`,
    }),
  });
  if (!res.ok || !res.json) {
    deps.err(`heartbeat failed: ${describeFailure(res, local.token)}`);
    return 1;
  }
  const leaseExpiresAt = res.json.lease_expires_at;
  deps.out(`Heartbeat lease accepted${leaseExpiresAt ? ` until ${safeCliLine(leaseExpiresAt, local.token, 80)}` : "."}`);
  return 0;
}

async function cmdAssignment(deps: CliDeps, parsed: ParsedArgs): Promise<number> {
  const [decision, id] = parsed.positionals;
  if (!id || !["accept", "reject", "complete"].includes(decision ?? "")) {
    deps.err("Usage: m9r-cli assignment <accept|reject|complete> <id> [--run <id> --evidence-record <id>]");
    return 1;
  }
  if (decision === "complete" && (!parsed.run || !parsed.evidenceRecord)) {
    deps.err("Completing an assignment requires --run and --evidence-record.");
    return 1;
  }
  const local = await readLocal(deps);
  if (!local?.token) {
    deps.err("No token found. Run: m9r-cli init");
    return 1;
  }
  const body: Record<string, string> = { decision };
  if (decision === "complete") {
    body.run_id = parsed.run!;
    body.evidence_record_id = parsed.evidenceRecord!;
  }
  const res = await apiFetch(deps, `${apiBase(deps.env)}/api/agent/assignments/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${local.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.json) {
    deps.err(`assignment ${decision} failed: ${describeFailure(res, local.token)}`);
    return 1;
  }
  deps.out(`Assignment ${safeCliLine(id, local.token, 80)}: ${decision === "complete" ? "completed" : `${decision}ed`}`);
  return 0;
}

async function cmdRunStart(deps: CliDeps, parsed: ParsedArgs): Promise<number> {
  const base = apiBase(deps.env);
  const local = await readLocal(deps);
  if (!local?.token) {
    deps.err("No token found. Run: m9r-cli init");
    return 1;
  }

  if (detectedAgentKind(deps.env)) {
    const identity = await authenticatedIdentity(deps, local);
    if (!identity.identity) {
      deps.err(`run start failed: ${identity.error ?? "authenticated identity unavailable"}`);
      return 1;
    }
  }

  const repoHint = parsed.repo || deps.env.OATHLOCK_REPO_HINT || basename(deps.cwd) || "workspace";
  const runMode = parsed.mode ?? "solo";
  if (runMode !== "solo" && runMode !== "coordinated" && runMode !== "assurance" && runMode !== "collaborative") {
    deps.err("run start failed: --mode must be solo, coordinated, assurance, or collaborative.");
    return 1;
  }

  const startUrl = `${base}/api/agent/run/start`;
  const startInit: RequestInit = {
    method: "POST",
    headers: { authorization: `Bearer ${local.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      task_title: parsed.task ?? null,
      repo_hint: repoHint,
      run_mode: runMode,
    }),
  };
  let res = await apiFetch(deps, startUrl, startInit);
  if (!res.ok || !res.json) {
    // A bearer CLI cannot make the approval decision. It can, however, give
    // the signed-in human the exact first-party dashboard destination returned
    // by the server. Previously this structured 403 body was discarded,
    // leaving the human with no discoverable approval surface.
    if (res.status === 403 && res.json && res.json.error === "approval_required") {
      const dashboardPath = typeof res.json.dashboardPath === "string" ? res.json.dashboardPath : null;
      const approvalRequestId = typeof res.json.approvalRequestId === "string" ? res.json.approvalRequestId : null;
      if (dashboardPath && /^\/dashboard\/approvals\/apr_[a-f0-9]{24}$/.test(dashboardPath)) {
        const approvalUrl = `${base}${dashboardPath}`;
        deps.err(`Human action required: approve this run at ${approvalUrl}`);
        if (approvalRequestId) deps.err(`Approval request: ${approvalRequestId}`);
        await deps.openUrl?.(approvalUrl);
      }
      const interval = deps.pollIntervalMs ?? 2_000;
      const maxPolls = deps.maxPolls ?? 450;
      const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
      deps.out("Waiting for human approval… the run will start automatically after approval.");
      for (let pollIndex = 0; pollIndex < maxPolls; pollIndex += 1) {
        await sleep(interval);
        res = await apiFetch(deps, startUrl, startInit);
        if (res.ok && res.json) break;
        if (res.status === 403 && res.json?.error === "approval_required") continue;
        if (res.status === 403 && res.json?.error === "approval_rejected") {
          deps.err("run start failed: the human rejected this approval request.");
          return 1;
        }
        deps.err(`run start failed while waiting for approval: ${describeFailure(res, local.token)}`);
        return 1;
      }
      if (!res.ok || !res.json) {
        deps.err("run start failed: approval was not completed before the request expired.");
        return 1;
      }
    } else {
      deps.err(`run start failed: ${describeFailure(res, local.token)}`);
      return 1;
    }
  }

  const runId = typeof res.json.run_id === "string" ? res.json.run_id : "";
  if (!runId) {
    deps.err("run start failed: response missing run_id.");
    return 1;
  }

  const savedTo = await persistActiveRun(deps, runId, parsed.task ?? null);

  deps.out(`Run started — your agent is now visible in the M9R dashboard.`);
  if (parsed.task) deps.out(`  task: ${parsed.task}`);
  deps.out(`  run id saved to ${savedTo}`);
  if (runMode === "assurance") {
    deps.out("  assurance: a secondary result decision is required before this run can complete");
  } else if (runMode === "collaborative") {
    deps.out("  collaboration: bounded secondary assignments are allowed throughout this run; scope, value, token, and latency gates remain enforced");
  }
  return 0;
}

async function cmdRunStatus(deps: CliDeps, parsed: ParsedArgs): Promise<number> {
  const base = apiBase(deps.env);
  const local = await readLocal(deps);
  if (!local?.token) {
    deps.err("No token found. Run: m9r-cli init");
    return 1;
  }

  const run = await readRun(deps);
  if (!run?.run_id) {
    deps.err("No active run. Start one first: m9r-cli run start --task \"...\"");
    return 1;
  }

  const phase = parsed.phase;
  if (!phase) {
    deps.err('Usage: m9r-cli run status --phase "reading files"');
    return 1;
  }

  const res = await apiFetch(deps, `${base}/api/agent/run/status`, {
    method: "POST",
    headers: { authorization: `Bearer ${local.token}`, "content-type": "application/json" },
    body: JSON.stringify({ run_id: run.run_id, current_phase: phase }),
  });
  if (!res.ok || !res.json) {
    deps.err(`run status failed: ${describeFailure(res, local.token)}`);
    return 1;
  }

  deps.out(`phase: ${phase}`);
  deps.out(`status: ${String(res.json.status ?? "working")}`);
  return 0;
}

async function cmdRun(deps: CliDeps, parsed: ParsedArgs): Promise<number> {
  const sub = parsed.positionals[0];
  switch (sub) {
    case "start":
      return cmdRunStart(deps, parsed);
    case "status":
      return cmdRunStatus(deps, parsed);
    default:
      deps.err('Usage: m9r-cli run start --task "..."  |  m9r-cli run status --phase "..."');
      return 1;
  }
}

// Must match src/lib/finding.ts's FINDING_EVIDENCE_LEVELS exactly -- that's
// what the server actually validates against (see /api/agent/findings/route.ts).
// This previously listed five different values (observed/correlated/claimed/
// inferred/unprovable) that were never the real domain model -- three of
// them 400'd on submit, and "command_tied" (the one meant for command-tied
// evidence) couldn't be produced by the CLI at all.
const FINDING_EVIDENCE_LEVELS = ["inferred", "correlated", "command_tied"] as const;

async function cmdFinding(deps: CliDeps, parsed: ParsedArgs): Promise<number> {
  const sub = parsed.positionals[0];
  switch (sub) {
    case "publish":
      return cmdFindingPublish(deps, parsed);
    default:
      deps.err('Usage: m9r-cli finding publish --title "..." --observed "..." [--environment "..."] [--evidence-level inferred|correlated|command_tied] [--suggested "..."] [--limitations "a,b"] [--run <run-id>]');
      return 1;
  }
}

/**
 * Publishes a Finding — a deliberate report that something during this run is
 * worth a human's attention, not an automatic scan result. A published
 * finding starts in review_state "observed"; it stays invisible to other
 * runs until an Operator reviews it in the dashboard (see
 * /api/agent/findings/route.ts's own header comment).
 */
async function cmdFindingPublish(deps: CliDeps, parsed: ParsedArgs): Promise<number> {
  const base = apiBase(deps.env);
  const local = await readLocal(deps);
  if (!local?.token) {
    deps.err("No token found. Run: m9r-cli init");
    return 1;
  }

  const runId = parsed.run || (await readRun(deps))?.run_id || "";
  if (!runId) {
    deps.err("finding publish failed: no active run and no --run <run-id> given. Start a run first: m9r-cli run start --task \"...\"");
    return 1;
  }
  if (!parsed.title || !parsed.observed) {
    deps.err('finding publish failed: --title and --observed are required.');
    return 1;
  }
  const evidenceLevel = parsed.evidenceLevel ?? "inferred";
  if (!(FINDING_EVIDENCE_LEVELS as readonly string[]).includes(evidenceLevel)) {
    deps.err(`finding publish failed: --evidence-level must be one of: ${FINDING_EVIDENCE_LEVELS.join(", ")}.`);
    return 1;
  }

  const res = await apiFetch(deps, `${base}/api/agent/findings`, {
    method: "POST",
    headers: { authorization: `Bearer ${local.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      run_id: runId,
      title: parsed.title,
      applicable_environment: parsed.environment ?? "",
      observed_behavior: parsed.observed,
      evidence_level: evidenceLevel,
      suggested_response: parsed.suggested ?? "",
      known_limitations: commaList(parsed.limitations),
    }),
  });
  if (!res.ok || !res.json) {
    deps.err(`finding publish failed: ${describeFailure(res, local.token)}`);
    return 1;
  }

  deps.out("Finding published — awaiting operator review before other runs can see it.");
  if (typeof res.json.finding_id === "string") deps.out(`  finding id: ${res.json.finding_id}`);
  return 0;
}

function commaList(value: string | undefined): string[] {
  return value ? [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))] : [];
}

function positiveInteger(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

async function coordinateContext(deps: CliDeps): Promise<{ token: string; runId: string } | null> {
  const local = await readLocal(deps);
  if (!local?.token) {
    deps.err("No token found. Run: m9r-cli init");
    return null;
  }
  const active = await readRun(deps);
  if (!active?.run_id) {
    deps.err('No active run. Start a coordinated, assurance, or collaborative run first: m9r-cli run start --task "..." --mode coordinated');
    return null;
  }
  return { token: local.token, runId: active.run_id };
}

async function cmdCoordinateRequest(deps: CliDeps, parsed: ParsedArgs): Promise<number> {
  const requestType = parsed.type === "help" ? "HELP_REQUESTED" : parsed.type === "check" ? "CHECK_REQUESTED" : null;
  const intent = parsed.intent === "distinct_capability" || parsed.intent === "independent_assurance" ? parsed.intent : null;
  const criteria = commaList(parsed.criteria);
  const allowedPaths = commaList(parsed.allow);
  const prohibitedPaths = commaList(parsed.deny);
  const capabilities = commaList(parsed.capability);
  const maxEstimatedTokens = positiveInteger(parsed.maxTokens);
  const maxDurationMs = positiveInteger(parsed.maxDurationMs);
  const maxAddedLatencyMs = positiveInteger(parsed.maxLatencyMs);
  if (!requestType || !parsed.need || !intent || criteria.length === 0 || !parsed.binding || allowedPaths.length === 0
    || prohibitedPaths.length === 0 || capabilities.length === 0 || !maxEstimatedTokens || !maxDurationMs || !maxAddedLatencyMs) {
    deps.err("coordinate request requires --type help|check, --need, --intent, --criteria, --binding, --allow, --deny, --capability, --max-tokens, --max-duration-ms, and --max-latency-ms.");
    return 1;
  }
  // Without an explicit target, the server's classifier guesses a provider
  // preference from the task text, and falls back to a load/alphabetical
  // tie-break across every resident authorized for this binding -- including
  // any stale/unrelated authorization for a provider never meant to receive
  // this request. --preferred-provider makes the intended recipient explicit
  // instead of leaving it to a guess.
  if (parsed.preferredProvider && !AGENT_KIND_SLUG_PATTERN.test(parsed.preferredProvider)) {
    deps.err("--preferred-provider must be a lowercase provider slug (for example codex, claude-code, or gemini-cli).");
    return 1;
  }
  const context = await coordinateContext(deps);
  if (!context) return 1;
  const res = await apiFetch(deps, `${apiBase(deps.env)}/api/agent/runs/${encodeURIComponent(context.runId)}/request-help`, {
    method: "POST",
    headers: { authorization: `Bearer ${context.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      type: requestType,
      need: parsed.need,
      coordination_intent: intent,
      objective_success_criteria: criteria,
      repository_binding_id: parsed.binding,
      required_capabilities: capabilities,
      allowed_paths: allowedPaths,
      prohibited_paths: prohibitedPaths,
      max_estimated_tokens: maxEstimatedTokens,
      max_duration_ms: maxDurationMs,
      max_added_latency_ms: maxAddedLatencyMs,
      preferred_provider: parsed.preferredProvider ?? null,
    }),
  });
  if (!res.ok || !res.json) {
    if (res.status === 404) {
      deps.err(`coordinate request failed: the active run ${context.runId} no longer exists on M9R. Start a fresh coordinated run, then retry.`);
      return 1;
    }
    deps.err(`coordinate request failed: ${describeFailure(res, context.token)}`);
    // The 422 value-gate rejection (decideCoordinationValue) is about THIS
    // request's declared intent/criteria/budgets, not the run's mode -- the
    // generic error string alone reads as a mode/persistence failure and has
    // repeatedly misled agents into re-checking run_mode instead of the flags
    // that actually failed. Surface the server's specific reason codes.
    if (Array.isArray(res.json?.reasons) && res.json.reasons.length > 0) {
      deps.err(`  reasons: ${res.json.reasons.join(", ")}`);
    }
    return 1;
  }
  deps.out(`Coordination request recorded — dispatch ${safeCliLine(String(res.json.dispatch_id ?? "unknown"), context.token, 100)}`);
  deps.out(`  routing: ${safeCliLine(String(res.json.routing_status ?? "unknown"), context.token, 80)}`);
  const routing = res.json.routing && typeof res.json.routing === "object"
    ? res.json.routing as Record<string, unknown>
    : null;
  if (routing?.routingReason) {
    deps.out(`  reason: ${safeCliLine(String(routing.routingReason), context.token, 120)}`);
  }
  if (res.json.routing_status === "no_eligible_resident") {
    deps.out(`  next: authorize a live resident for ${safeCliLine(parsed.binding, context.token, 100)} in Watchfloor → Resident authorization.`);
  }
  const route = res.json.task_route as Record<string, unknown> | undefined;
  if (route) deps.out(`  route: ${String(route.model_tier ?? "unknown")} tier · ${String(route.provider_preference ?? "provider selected by policy")} · ceiling ${String(route.max_estimated_tokens ?? "unknown")} tokens`);
  return 0;
}

async function cmdCoordinateResults(deps: CliDeps): Promise<number> {
  const context = await coordinateContext(deps);
  if (!context) return 1;
  const res = await apiFetch(deps, `${apiBase(deps.env)}/api/agent/runs/${encodeURIComponent(context.runId)}/results`, {
    headers: { authorization: `Bearer ${context.token}` },
  });
  if (!res.ok || !res.json) {
    if (res.status === 404) {
      deps.err(`coordinate results failed: the active run ${context.runId} no longer exists on M9R. Start a fresh coordinated run to retrieve results.`);
      return 1;
    }
    deps.err(`coordinate results failed: ${describeFailure(res, context.token)}`);
    return 1;
  }
  const results = Array.isArray(res.json.results) ? res.json.results as Array<Record<string, unknown>> : [];
  const statuses = Array.isArray(res.json.statuses) ? res.json.statuses as Array<Record<string, unknown>> : [];
  deps.out(`returned results: ${results.length}`);
  for (const result of results) {
    const usage = result.usage && typeof result.usage === "object" ? result.usage as Record<string, unknown> : null;
    deps.out(`- ${safeCliLine(String(result.launch_grant_id ?? "unknown"), context.token, 100)} · ${String(result.provider ?? "unknown provider")} · ${String(result.model_tier ?? "unknown")} tier`);
    deps.out(`  requested model: ${String(result.requested_model ?? "unknown")}`);
    deps.out(`  provider-reported model: ${String(result.reported_model ?? "unknown")}`);
    deps.out(`  tokens: ${String(usage?.totalTokens ?? "unknown")}`);
    deps.out(`  result: ${safeCliLine(String(result.result_text ?? ""), context.token, 500)}`);
  }
  if (statuses.length > 0) {
    deps.out("launch statuses:");
    for (const status of statuses) {
      const failure = typeof status.failure_code === "string" ? ` · ${status.failure_code}` : "";
      deps.out(`- ${safeCliLine(String(status.launch_grant_id ?? "unknown"), context.token, 100)} · ${String(status.provider ?? "unknown provider")} · ${String(status.state ?? "unknown")}${failure}`);
    }
  }
  return 0;
}

async function cmdCoordinateDecide(deps: CliDeps, parsed: ParsedArgs): Promise<number> {
  const grantId = parsed.positionals[1];
  if (!grantId || !["adopted", "rejected", "challenged"].includes(parsed.decision ?? "") || !parsed.rationale || !parsed.planEffect) {
    deps.err("coordinate decide requires <launch-grant-id>, --decision adopted|rejected|challenged, --rationale, and --plan-effect.");
    return 1;
  }
  const context = await coordinateContext(deps);
  if (!context) return 1;
  const res = await apiFetch(deps, `${apiBase(deps.env)}/api/agent/runs/${encodeURIComponent(context.runId)}/adopt-result`, {
    method: "POST",
    headers: { authorization: `Bearer ${context.token}`, "content-type": "application/json" },
    body: JSON.stringify({ launch_grant_id: grantId, decision: parsed.decision, rationale: parsed.rationale, plan_effect: parsed.planEffect }),
  });
  if (!res.ok || !res.json) {
    deps.err(`coordinate decide failed: ${describeFailure(res, context.token)}`);
    return 1;
  }
  deps.out(`Provider result ${safeCliLine(grantId, context.token, 100)}: ${parsed.decision}`);
  return 0;
}

async function cmdCoordinate(deps: CliDeps, parsed: ParsedArgs): Promise<number> {
  switch (parsed.positionals[0]) {
    case "request": return cmdCoordinateRequest(deps, parsed);
    case "results": return cmdCoordinateResults(deps);
    case "decide": return cmdCoordinateDecide(deps, parsed);
    default:
      deps.err("Usage: m9r-cli coordinate <request|results|decide> ...");
      return 1;
  }
}

// ---------------------------------------------------------------------------
// Conversation — real multi-turn, multi-party agent talk (Gate 14). Distinct
// from `coordinate request`'s one-shot bounded ask: a conversation is an
// open, ongoing channel where any participant can send a message, handoff,
// ack, or result at any time, and every other participant's own Inbox check
// (the same checkpoint already mandated for human instructions) surfaces it.
// ---------------------------------------------------------------------------

const CONVERSATION_MESSAGE_KINDS = ["message", "handoff", "ack", "result", "notice"] as const;
function isConversationMessageKind(value: string): boolean {
  return (CONVERSATION_MESSAGE_KINDS as readonly string[]).includes(value);
}

interface PeerConnection {
  connection_id: string;
  agent_kind: string;
}

async function listPeerConnections(deps: CliDeps, token: string, options: { includeSelf?: boolean } = {}): Promise<PeerConnection[] | null> {
  const res = await apiFetch(deps, `${apiBase(deps.env)}/api/agent/connections`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok || !res.json || !Array.isArray(res.json.connections)) return null;
  const peers = [...res.json.connections] as PeerConnection[];
  if (options.includeSelf) {
    // /api/agent/connections intentionally returns peers only.  Conversation
    // creation always includes the caller, so allow an explicit self alias
    // (for example Codex starting a Codex+Claude+OpenCode conversation) by
    // resolving the authenticated connection separately.
    const identity = await apiFetch(deps, `${apiBase(deps.env)}/api/agent/whoami`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const connectionId = typeof identity.json?.connectionId === "string" ? identity.json.connectionId : null;
    const agentKind = typeof identity.json?.agentKind === "string"
      ? identity.json.agentKind
      : typeof identity.json?.agent_kind === "string"
        ? identity.json.agent_kind
        : null;
    if (connectionId && agentKind && !peers.some((peer) => peer.connection_id === connectionId)) {
      peers.unshift({ connection_id: connectionId, agent_kind: agentKind });
    }
  }
  return peers;
}

/** Resolve "codex" / "claude-code" / "grok-build" / "other" or a raw connection id to a connection id. */
function resolveConnectionId(peers: PeerConnection[], reference: string): string | null {
  const exact = peers.find((peer) => peer.connection_id === reference);
  if (exact) return exact.connection_id;
  const byKind = peers.find((peer) => peer.agent_kind === reference);
  return byKind?.connection_id ?? null;
}

/**
 * `ask` is the "out" path for a session M9R did not start: it posts to the workspace from whatever
 * agent runs it, addressed to one connected agent, and can wait for that agent's reply. It only uses
 * the agent-facing API this connection already has a token for.
 */
const ASK_DEFAULT_TIMEOUT_SECONDS = 120;
const ASK_POLL_INTERVAL_MS = 2_000;

function askCursor(createdAt: string, messageId: string): string | null {
  // Same shape as workspace-cursor.ts (kept inline: the CLI build transpiles files one by one).
  if (!Number.isFinite(Date.parse(createdAt)) || !/^[0-9a-f-]{1,128}$/i.test(messageId)) return null;
  return `workspace-cursor.v1:${Buffer.from(JSON.stringify({ createdAt, messageId }), "utf8").toString("base64url")}`;
}

async function cmdAsk(deps: CliDeps, parsed: ParsedArgs): Promise<number> {
  const usage = 'Usage: m9r-cli ask <agent> "<message>" [--channel general] [--wait] [--timeout <seconds>] [--agent-kind <your kind>]';
  const requested = parsed.agentKind?.trim().toLowerCase();
  if (requested && !AGENT_KIND_SLUG_PATTERN.test(requested)) {
    deps.err("agent kind must be lowercase letters, numbers, and hyphens only (1-40 characters, no leading/trailing hyphen).");
    return 1;
  }
  const local = await readLocal(deps, requested);
  if (!local?.token) {
    deps.err("No token found. Run: m9r-cli init");
    return 1;
  }
  const target = (parsed.positionals[0] ?? "").replace(/^@/, "").trim();
  const message = (parsed.text ?? parsed.positionals.slice(1).join(" ")).trim();
  if (!target || !message) {
    deps.err(usage);
    return 1;
  }
  if (message.length > 2_000) {
    deps.err("ask: the message is over 2,000 characters; send a shorter question and point to a file instead.");
    return 1;
  }

  const peers = await listPeerConnections(deps, local.token);
  if (!peers) {
    deps.err("ask failed: could not list the connected agents in this workspace.");
    return 1;
  }
  const recipientConnectionId = resolveConnectionId(peers, target);
  if (!recipientConnectionId) {
    const known = [...new Set(peers.map((peer) => peer.agent_kind))].join(", ") || "none connected";
    deps.err(`ask failed: no connected agent matches "${target}". Connected agents: ${known}.`);
    return 1;
  }

  const base = apiBase(deps.env);
  const conversations = await apiFetch(deps, `${base}/api/agent/conversations`, { headers: { authorization: `Bearer ${local.token}` } });
  if (!conversations.ok || !conversations.json || !Array.isArray(conversations.json.conversations)) {
    deps.err(`ask failed: could not list channels (${describeFailure(conversations, local.token)}).`);
    return 1;
  }
  const channels = (conversations.json.conversations as Array<Record<string, unknown>>)
    .filter((conversation) => conversation.channel_kind === "channel" && conversation.status === "open" && typeof conversation.id === "string");
  const wanted = (parsed.channel ?? "general").replace(/^#/, "").trim().toLowerCase();
  const channel = channels.find((candidate) => String(candidate.topic ?? "").trim().toLowerCase() === wanted);
  if (!channel) {
    const names = channels.map((candidate) => `#${String(candidate.topic ?? "").trim()}`).join(", ") || "none";
    deps.err(`ask failed: no open channel named "${wanted}". Open channels: ${names}. Pass --channel <name>.`);
    return 1;
  }
  const conversationId = String(channel.id);

  // Same words to the same agent inside five minutes are one message (a retried tool call must not post twice).
  const idempotencyKey = `ask:${createHash("sha256").update([conversationId, recipientConnectionId, message, Math.floor(Date.now() / 300_000)].join(String.fromCharCode(0))).digest("hex").slice(0, 40)}`;
  const posted = await apiFetch(deps, `${base}/api/agent/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${local.token}`, "content-type": "application/json", "idempotency-key": idempotencyKey },
    body: JSON.stringify({ kind: "message", body: `@${target} ${message}`, recipient_connection_id: recipientConnectionId }),
  });
  const sent = posted.json?.message as Record<string, unknown> | undefined;
  if (!posted.ok || !sent || typeof sent.id !== "string") {
    deps.err(`ask failed: ${describeFailure(posted, local.token)}`);
    return 1;
  }
  deps.out(`Sent to @${target} in #${wanted}.`);
  if (!parsed.wait) {
    deps.out(`Their reply will appear in #${wanted}. Add --wait to wait for it here, or track it: m9r-cli delivery ${sent.id}`);
    return 0;
  }

  const cursor = typeof sent.created_at === "string" ? askCursor(sent.created_at, sent.id) : null;
  const timeoutSeconds = parsed.timeoutSeconds ?? ASK_DEFAULT_TIMEOUT_SECONDS;
  const deadline = Date.now() + timeoutSeconds * 1_000;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms)));
  while (Date.now() < deadline) {
    const url = new URL(`${base}/api/agent/conversations/${encodeURIComponent(conversationId)}/messages`);
    if (cursor) url.searchParams.set("since", cursor);
    const poll = await apiFetch(deps, url.toString(), { headers: { authorization: `Bearer ${local.token}` } });
    const messages = poll.ok && Array.isArray(poll.json?.messages) ? (poll.json!.messages as Array<Record<string, unknown>>) : [];
    const reply = messages.find((candidate) => candidate.id !== sent.id
      && (candidate.parent_message_id === sent.id
        || (candidate.sender_connection_id === recipientConnectionId && candidate.kind === "result" && String(candidate.created_at ?? "") > String(sent.created_at ?? ""))));
    if (reply) {
      deps.out(`@${target} replied:`);
      deps.out(safeCliLine(reply.body, local.token, 4_000));
      const report = await fetchDelivery(deps, local.token, sent.id);
      if (report) {
        deps.out("");
        deps.out("Delivery:");
        for (const line of deliveryLines(report, local.token)) deps.out(line);
      }
      return reply.outcome === "failed" ? 1 : 0;
    }
    await sleep(ASK_POLL_INTERVAL_MS);
  }
  deps.err(`ask: no reply from @${target} within ${timeoutSeconds}s. The message was sent; the reply will appear in #${wanted}.`);
  return 2;
}

function endpointLines(endpoint: Record<string, unknown>, token: string): string[] {
  const presence = (endpoint.presence ?? {}) as Record<string, unknown>;
  const fidelity = (endpoint.fidelity ?? {}) as Record<string, unknown>;
  const seen = typeof presence.lastSeenAt === "string" ? Date.parse(presence.lastSeenAt) : NaN;
  const ago = Number.isFinite(seen) ? `${Math.max(0, Math.round((Date.now() - seen) / 1000))}s ago` : "never";
  return [
    `${safeCliLine(endpoint.address, token, 60)}  (${safeCliLine(endpoint.id, token, 60)})`,
    `  provider: ${safeCliLine(endpoint.provider, token, 60)}   generation: ${safeCliLine(endpoint.generation, token, 12)}${endpoint.mine ? "   yours" : ""}`,
    `  reachability: ${safeCliLine(endpoint.reachability, token, 20)}`,
    `  presence: ${safeCliLine(presence.state, token, 20)} (${safeCliLine(presence.confidence, token, 20)}), last seen ${ago}`,
    `  fidelity: ${safeCliLine(fidelity.level, token, 30)} (${safeCliLine(fidelity.basis, token, 40)}) - ${safeCliLine(fidelity.note, token, 300)}`,
  ];
}

/** `resolve <address>`: what M9R knows about one endpoint, read-only. */
async function cmdResolve(deps: CliDeps, parsed: ParsedArgs): Promise<number> {
  const requested = parsed.agentKind?.trim().toLowerCase();
  const local = await readLocal(deps, requested && AGENT_KIND_SLUG_PATTERN.test(requested) ? requested : undefined);
  if (!local?.token) {
    deps.err("No token found. Run: m9r-cli init");
    return 1;
  }
  const address = parsed.positionals[0];
  if (!address) {
    deps.err("Usage: m9r-cli resolve <@agent | endpoint id> [--agent-kind <your kind>]");
    return 1;
  }
  const url = new URL(`${apiBase(deps.env)}/api/agent/endpoints/resolve`);
  url.searchParams.set("address", address);
  const res = await apiFetch(deps, url.toString(), { headers: { authorization: `Bearer ${local.token}` } });
  if (!res.ok || !res.json) {
    const detail = typeof res.json?.error === "string" ? safeCliLine(res.json.error, local.token, 300) : describeFailure(res, local.token);
    deps.err(`resolve failed: ${detail}`);
    const candidates = Array.isArray(res.json?.candidates) ? (res.json!.candidates as unknown[]) : [];
    for (const candidate of candidates) deps.err(`  candidate: ${safeCliLine(candidate, local.token, 60)}`);
    return 1;
  }
  for (const line of endpointLines((res.json.endpoint ?? {}) as Record<string, unknown>, local.token)) deps.out(line);
  return 0;
}

/** `endpoints`: every endpoint in this workspace. */
async function cmdEndpoints(deps: CliDeps, parsed: ParsedArgs): Promise<number> {
  const requested = parsed.agentKind?.trim().toLowerCase();
  const local = await readLocal(deps, requested && AGENT_KIND_SLUG_PATTERN.test(requested) ? requested : undefined);
  if (!local?.token) {
    deps.err("No token found. Run: m9r-cli init");
    return 1;
  }
  const res = await apiFetch(deps, `${apiBase(deps.env)}/api/agent/endpoints`, { headers: { authorization: `Bearer ${local.token}` } });
  if (!res.ok || !res.json || !Array.isArray(res.json.endpoints)) {
    deps.err(`endpoints failed: ${describeFailure(res, local.token)}`);
    return 1;
  }
  const endpoints = res.json.endpoints as Array<Record<string, unknown>>;
  deps.out(`endpoints: ${endpoints.length}`);
  for (const endpoint of endpoints) {
    for (const line of endpointLines(endpoint, local.token)) deps.out(line);
  }
  return 0;
}

function deliveryLines(report: Record<string, unknown>, token: string): string[] {
  const deliveries = Array.isArray(report.deliveries) ? (report.deliveries as Array<Record<string, unknown>>) : [];
  if (deliveries.length === 0) return ["No agent was addressed by this message, so there is nothing to deliver."];
  const lines: string[] = [];
  for (const delivery of deliveries) {
    const recipient = (delivery.recipient ?? {}) as Record<string, unknown>;
    const flags = [delivery.viaConsultation ? "via consultation" : null, delivery.pendingUntilTurnBoundary ? "waiting for the turn boundary" : null, delivery.failureCode ? `failure: ${safeCliLine(delivery.failureCode, token, 40)}` : null].filter(Boolean);
    lines.push(`${safeCliLine(recipient.address, token, 60)}: ${safeCliLine(delivery.state, token, 30)} (attempt ${safeCliLine(delivery.attempt, token, 6)})${flags.length ? ` - ${flags.join(", ")}` : ""}`);
    const timeline = Array.isArray(delivery.timeline) ? (delivery.timeline as Array<Record<string, unknown>>) : [];
    for (const entry of timeline) {
      const time = typeof entry.at === "string" && Number.isFinite(Date.parse(entry.at)) ? new Date(entry.at).toISOString().slice(11, 19) : "--:--:--";
      const note = entry.persisted === false ? " (bridge memory only; not saved to a local ledger)" : entry.persisted === true ? " (saved in the bridge's local ledger first)" : "";
      lines.push(`  ${time}  ${safeCliLine(entry.state, token, 24).padEnd(22)} ${safeCliLine(entry.basis, token, 10).padEnd(9)} ${safeCliLine(entry.evidence, token, 80)}${note}`);
    }
    const notes = Array.isArray(delivery.notes) ? (delivery.notes as Array<Record<string, unknown>>) : [];
    if (notes.length > 0) {
      lines.push(`  note: the Bridge declined to run this ${notes.length} time${notes.length === 1 ? "" : "s"} (${safeCliLine(notes[0].evidence, token, 40)}): ${safeCliLine(notes[0].meaning, token, 200)}`);
    }
    if (delivery.declined) lines.push("  waiting: the latest evidence is a decline and nothing has progressed since; check the channel for a notice.");
  }
  return lines;
}

async function fetchDelivery(deps: CliDeps, token: string, messageId: string): Promise<Record<string, unknown> | null> {
  const res = await apiFetch(deps, `${apiBase(deps.env)}/api/agent/messages/${encodeURIComponent(messageId)}/delivery`, { headers: { authorization: `Bearer ${token}` } });
  return res.ok && res.json ? res.json : null;
}

/** `delivery <message id>`: how far one message got, per recipient. Read-only. */
async function cmdDelivery(deps: CliDeps, parsed: ParsedArgs): Promise<number> {
  const requested = parsed.agentKind?.trim().toLowerCase();
  const local = await readLocal(deps, requested && AGENT_KIND_SLUG_PATTERN.test(requested) ? requested : undefined);
  if (!local?.token) {
    deps.err("No token found. Run: m9r-cli init");
    return 1;
  }
  const messageId = parsed.positionals[0];
  if (!messageId) {
    deps.err("Usage: m9r-cli delivery <message id> [--agent-kind <your kind>]");
    return 1;
  }
  const res = await apiFetch(deps, `${apiBase(deps.env)}/api/agent/messages/${encodeURIComponent(messageId)}/delivery`, { headers: { authorization: `Bearer ${local.token}` } });
  if (!res.ok || !res.json) {
    deps.err(`delivery failed: ${typeof res.json?.error === "string" ? safeCliLine(res.json.error, local.token, 300) : describeFailure(res, local.token)}`);
    return 1;
  }
  for (const line of deliveryLines(res.json, local.token)) deps.out(line);
  return 0;
}

async function cmdConversationStart(deps: CliDeps, parsed: ParsedArgs): Promise<number> {
  const local = await readLocal(deps);
  if (!local?.token) {
    deps.err("No token found. Run: m9r-cli init");
    return 1;
  }
  if (!parsed.topic || !parsed.with) {
    deps.err('Usage: m9r-cli conversation start --topic "..." --with codex[,grok-build]');
    return 1;
  }
  const peers = await listPeerConnections(deps, local.token, { includeSelf: true });
  if (!peers) {
    deps.err("conversation start failed: could not list connections in this workspace.");
    return 1;
  }
  const references = commaList(parsed.with);
  const participantConnectionIds: string[] = [];
  for (const reference of references) {
    const id = resolveConnectionId(peers, reference);
    if (!id) {
      deps.err(`conversation start failed: no active connection matching "${reference}" in this workspace.`);
      return 1;
    }
    participantConnectionIds.push(id);
  }

  const res = await apiFetch(deps, `${apiBase(deps.env)}/api/agent/conversations`, {
    method: "POST",
    headers: { authorization: `Bearer ${local.token}`, "content-type": "application/json" },
    body: JSON.stringify({ topic: parsed.topic, participant_connection_ids: participantConnectionIds }),
  });
  if (!res.ok || !res.json) {
    deps.err(`conversation start failed: ${describeFailure(res, local.token)}`);
    return 1;
  }
  const conversation = res.json.conversation as Record<string, unknown> | undefined;
  deps.out(`Conversation started — id ${safeCliLine(String(conversation?.id ?? "unknown"), local.token, 100)}`);
  deps.out(`  topic: ${safeCliLine(parsed.topic, local.token, 200)}`);
  deps.out(`  participants: ${references.join(", ")}`);
  return 0;
}

async function cmdConversationSend(deps: CliDeps, parsed: ParsedArgs): Promise<number> {
  const local = await readLocal(deps);
  if (!local?.token) {
    deps.err("No token found. Run: m9r-cli init");
    return 1;
  }
  const kind = parsed.type ?? "message";
  if (!parsed.conversation || !parsed.text || !isConversationMessageKind(kind)) {
    deps.err('Usage: m9r-cli conversation send --conversation <id> --text "..." [--to codex] [--type message|handoff|ack|result]');
    return 1;
  }
  let recipientConnectionId: string | null = null;
  if (parsed.to) {
    const peers = await listPeerConnections(deps, local.token);
    if (!peers) {
      deps.err("conversation send failed: could not list connections in this workspace.");
      return 1;
    }
    recipientConnectionId = resolveConnectionId(peers, parsed.to);
    if (!recipientConnectionId) {
      deps.err(`conversation send failed: no active connection matching "${parsed.to}" in this workspace.`);
      return 1;
    }
  }

  const res = await apiFetch(deps, `${apiBase(deps.env)}/api/agent/conversations/${encodeURIComponent(parsed.conversation)}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${local.token}`, "content-type": "application/json", "idempotency-key": randomUUID() },
    body: JSON.stringify({ recipient_connection_id: recipientConnectionId, kind, body: parsed.text }),
  });
  if (!res.ok || !res.json) {
    deps.err(`conversation send failed: ${describeFailure(res, local.token)}`);
    return 1;
  }
  deps.out(`Sent — ${kind}${parsed.to ? ` to ${parsed.to}` : " (broadcast)"}`);
  return 0;
}

async function cmdConversationMessages(deps: CliDeps, parsed: ParsedArgs): Promise<number> {
  const local = await readLocal(deps);
  if (!local?.token) {
    deps.err("No token found. Run: m9r-cli init");
    return 1;
  }
  if (!parsed.conversation) {
    deps.err("Usage: m9r-cli conversation messages --conversation <id> [--since <ISO timestamp>]");
    return 1;
  }
  const peers = (await listPeerConnections(deps, local.token)) ?? [];
  const kindByConnectionId = new Map(peers.map((peer) => [peer.connection_id, peer.agent_kind]));

  const url = new URL(`${apiBase(deps.env)}/api/agent/conversations/${encodeURIComponent(parsed.conversation)}/messages`);
  if (parsed.since) url.searchParams.set("since", parsed.since);
  const res = await apiFetch(deps, url.toString(), {
    headers: { authorization: `Bearer ${local.token}` },
  });
  if (!res.ok || !res.json) {
    deps.err(`conversation messages failed: ${describeFailure(res, local.token)}`);
    return 1;
  }
  const messages = Array.isArray(res.json.messages) ? (res.json.messages as Array<Record<string, unknown>>) : [];
  deps.out(`messages: ${messages.length}`);
  for (const message of messages) {
    const sender = kindByConnectionId.get(String(message.sender_connection_id)) ?? "you";
    const recipient = message.recipient_connection_id
      ? kindByConnectionId.get(String(message.recipient_connection_id)) ?? "you"
      : "everyone";
    const kind = safeCliLine(String(message.kind ?? "message"), local.token, 20);
    const body = safeCliLine(String(message.body ?? ""), local.token, 500);
    deps.out(`  [${kind}] ${sender} -> ${recipient}: ${body}`);
  }
  return 0;
}

async function cmdConversation(deps: CliDeps, parsed: ParsedArgs): Promise<number> {
  switch (parsed.positionals[0]) {
    case "start": return cmdConversationStart(deps, parsed);
    case "send": return cmdConversationSend(deps, parsed);
    case "messages": return cmdConversationMessages(deps, parsed);
    default:
      deps.err("Usage: m9r-cli conversation <start|send|messages> ...");
      return 1;
  }
}

const WORK_SIGNAL_PROTOCOL_VERSION = "oathlock.work-signal.v1";

/** Emit a Work Signal: this connection's own, versioned, replay-safe activity event. */
async function cmdSignalEmit(deps: CliDeps, parsed: ParsedArgs): Promise<number> {
  const base = apiBase(deps.env);
  const local = await readLocal(deps);
  if (!local?.token) {
    deps.err("No token found. Run: m9r-cli init");
    return 1;
  }
  if (!parsed.type || !parsed.summary) {
    deps.err('Usage: m9r-cli signal emit --type WORKING --summary "..." [--repo <repo>] [--scope a,b] [--correlation-id <id>] [--parent-event-id <id>]');
    return 1;
  }
  const run = await readRun(deps);
  const { adapterInstanceId, clientSequence } = await nextAdapterSequence(deps);
  const repo = parsed.repo || deps.env.OATHLOCK_REPO_HINT || basename(deps.cwd) || "workspace";
  const scope = parsed.scope ? parsed.scope.split(",").map((s) => s.trim()).filter(Boolean) : [];

  const res = await apiFetch(deps, `${base}/api/agent/signals`, {
    method: "POST",
    headers: { authorization: `Bearer ${local.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      protocolVersion: WORK_SIGNAL_PROTOCOL_VERSION,
      adapterInstanceId,
      clientSequence,
      idempotencyKey: `${adapterInstanceId}:${clientSequence}`,
      type: parsed.type,
      source: "reported",
      summary: parsed.summary,
      scope,
      repo,
      correlationId: parsed.correlationId,
      parentEventId: parsed.parentEventId,
      runId: run?.run_id ?? null,
    }),
  });
  if (!res.ok || !res.json) {
    deps.err(`signal emit failed: ${describeFailure(res, local.token)}`);
    return 1;
  }
  const signal = (res.json.signal ?? {}) as Record<string, unknown>;
  deps.out(`Work Signal recorded — server_sequence ${String(signal.server_sequence ?? "?")}`);
  return 0;
}

/** Replay Work Signals for this workspace since a cursor (defaults to this connection's own persisted cursor). */
async function cmdSignalReplay(deps: CliDeps, parsed: ParsedArgs): Promise<number> {
  const base = apiBase(deps.env);
  const local = await readLocal(deps);
  if (!local?.token) {
    deps.err("No token found. Run: m9r-cli init");
    return 1;
  }
  const query = new URLSearchParams();
  if (parsed.since) query.set("since", parsed.since);
  if (parsed.limit) query.set("limit", parsed.limit);
  const qs = query.toString();

  const res = await apiFetch(deps, `${base}/api/agent/signals${qs ? `?${qs}` : ""}`, {
    headers: { authorization: `Bearer ${local.token}` },
  });
  if (!res.ok || !res.json) {
    deps.err(`signal replay failed: ${describeFailure(res, local.token)}`);
    return 1;
  }
  const signals = Array.isArray(res.json.signals) ? (res.json.signals as Array<Record<string, unknown>>) : [];
  deps.out(`cursor: ${String(res.json.cursor ?? "0")}`);
  deps.out(`signals: ${signals.length}`);
  for (const s of signals) {
    deps.out(`  - [${String(s.server_sequence)}] ${String(s.type)}: ${safeCliLine(s.summary, local.token)}`);
  }
  return 0;
}

/** Self-acknowledge Work Signals through a server sequence: confirms this connection durably has them. */
async function cmdSignalAck(deps: CliDeps, parsed: ParsedArgs): Promise<number> {
  const base = apiBase(deps.env);
  const local = await readLocal(deps);
  if (!local?.token) {
    deps.err("No token found. Run: m9r-cli init");
    return 1;
  }
  const throughSequence = Number(parsed.through);
  if (!parsed.through || !Number.isSafeInteger(throughSequence) || throughSequence < 0) {
    deps.err("Usage: m9r-cli signal ack --through <serverSequence>");
    return 1;
  }
  const res = await apiFetch(deps, `${base}/api/agent/signals/ack`, {
    method: "POST",
    headers: { authorization: `Bearer ${local.token}`, "content-type": "application/json" },
    body: JSON.stringify({ throughSequence }),
  });
  if (!res.ok || !res.json) {
    deps.err(`signal ack failed: ${describeFailure(res, local.token)}`);
    return 1;
  }
  deps.out(`acked_through: ${String(res.json.acked_through ?? throughSequence)}`);
  return 0;
}

async function cmdSignal(deps: CliDeps, parsed: ParsedArgs): Promise<number> {
  const sub = parsed.positionals[0];
  switch (sub) {
    case "emit":
      return cmdSignalEmit(deps, parsed);
    case "replay":
      return cmdSignalReplay(deps, parsed);
    case "ack":
      return cmdSignalAck(deps, parsed);
    default:
      deps.err('Usage: m9r-cli signal emit --type <TYPE> --summary "..."  |  m9r-cli signal replay [--since N]  |  m9r-cli signal ack --through N');
      return 1;
  }
}

/**
 * Fetch and print the conservative two-run comparison. Prints exactly what the
 * server returns — it never fabricates token/cost or quality gains. Usage is
 * shown only when both runs recorded metadata; quality only when judged.
 */
async function cmdCompare(deps: CliDeps, parsed: ParsedArgs): Promise<number> {
  const base = apiBase(deps.env);
  const local = await readLocal(deps);
  if (!local?.token) {
    deps.err("No token found. Run: m9r-cli init");
    return 1;
  }
  const baseline = parsed.baselineRun;
  const later = parsed.laterRun;
  if (!baseline || !later) {
    deps.err("Usage: m9r-cli compare --baseline-run <id> --later-run <id>");
    return 1;
  }

  const url = `${base}/api/agent/compare?baseline=${encodeURIComponent(baseline)}&later=${encodeURIComponent(later)}`;
  const res = await apiFetch(deps, url, { headers: { authorization: `Bearer ${local.token}` } });
  if (!res.ok || !res.json) {
    deps.err(`compare failed: ${describeFailure(res, local.token)}`);
    return 1;
  }

  const c = (res.json.comparison ?? {}) as Record<string, unknown>;
  deps.out(`Two-run comparison: ${baseline} → ${later}`);

  // Snapshot-availability is derived robustly: prefer the explicit flags, but fall
  // back to the limitation text so an older deployment (that emits the limitation
  // but not the flags) still renders honestly instead of "not evaluated"/"0 → 0".
  const limitations = Array.isArray(c.limitations) ? (c.limitations as string[]) : [];
  const limitationsText = limitations.join("\n");
  const verdictText = typeof c.honest_verdict === "string" ? c.honest_verdict : "";
  const ruleHealthSnapshotUnavailable =
    c.rule_health_snapshot_available === false ||
    /Rule Health snapshot unavailable for this run/i.test(`${limitationsText}\n${verdictText}`);
  const behaviorSnapshotUnavailable =
    c.behavior_snapshot_available === false ||
    /Behavioral counts are unavailable|behavior snapshot was not recovered/i.test(limitationsText) ||
    // Deployment skew: an older server may emit only the Rule Health limitation.
    // For an unrecoverable old run the behavior snapshot is gone too, so its
    // zeroed counts are equally meaningless — never present them as real.
    ruleHealthSnapshotUnavailable;

  const rh = c.rule_health_result as { evaluated?: boolean; dominant?: string | null } | null;
  if (rh?.evaluated) deps.out(`rule health: ${String(rh.dominant ?? "(evaluated)")}`);
  else if (ruleHealthSnapshotUnavailable) deps.out("rule health: snapshot unavailable (see limitations)");
  else deps.out("rule health: not evaluated");

  // Zeroed behavior counts are misleading when a snapshot could not be recovered;
  // show an honest note instead of "0 → 0".
  const behavioral = Array.isArray(c.behavioral_delta)
    ? (c.behavioral_delta as Array<Record<string, unknown>>)
    : [];
  if (behaviorSnapshotUnavailable) {
    deps.out("behavior: snapshot unavailable");
  } else if (behavioral.length) {
    deps.out("behavior (before → after):");
    for (const m of behavioral) {
      deps.out(`  ${String(m.label)}: ${String(m.before)} → ${String(m.after)} (${formatBehaviorChange(m)})`);
    }
  }

  const usage = (c.usage_delta ?? {}) as Record<string, unknown>;
  if (usage.available) {
    deps.out(`tokens: ${String(usage.totalTokensBefore)} → ${String(usage.totalTokensAfter)}`);
    deps.out(`cost: ${String(usage.costBefore)} → ${String(usage.costAfter)}`);
  } else {
    deps.out(`usage: ${String(usage.message ?? "unavailable")}`);
  }

  const quality = (c.output_quality_delta ?? {}) as Record<string, unknown>;
  // Always surface the quality message: presence-only when both runs supplied
  // signals, an honest "not compared" when asymmetric, and the unjudgeable copy
  // (with a measurable hint) when neither did. Never a quality-improvement claim.
  if (quality.message) deps.out(`output quality: ${String(quality.message)}`);
  if (!quality.judgeable) {
    const hint = Array.isArray(quality.hint) ? (quality.hint as string[]) : [];
    if (hint.length) {
      deps.out("  How to make this measurable:");
      for (const h of hint) deps.out(`    - ${h}`);
    }
  }

  if (c.honest_verdict) deps.out(`verdict: ${String(c.honest_verdict)}`);
  for (const l of limitations) deps.out(`  - ${l}`);
  return 0;
}

/** Print the rule_health section of a session result, if present and evaluated. */
function printRuleHealth(deps: CliDeps, raw: unknown): void {
  if (!raw || typeof raw !== "object") return;
  const rh = raw as Record<string, unknown>;
  if (rh.evaluated !== true) return;

  const summary = (rh.summary && typeof rh.summary === "object" ? rh.summary : {}) as Record<
    string,
    unknown
  >;
  deps.out("rule health:");
  // Only print non-zero buckets to keep output focused; order is stable.
  for (const key of [
    "followed",
    "violated",
    "needs_review",
    "not_applicable",
    "too_vague",
    "obsolete",
  ]) {
    const n = Number(summary[key] ?? 0);
    if (n > 0) deps.out(`  ${key}: ${n}`);
  }

  const items = Array.isArray(rh.items) ? (rh.items as Array<Record<string, unknown>>) : [];
  for (const it of items) {
    const status = String(it.status ?? "needs_review");
    const title = String(it.title ?? it.rule_id ?? "(untitled rule)");
    const reason = String(it.reason ?? "");
    deps.out(`  - ${status}: ${title}${reason ? ` — ${reason}` : ""}`);
  }
}

function rulesMessageForCli(candidateCount: number, ruleLikeFindingsCount: number): string {
  if (candidateCount <= 0) {
    return ruleLikeFindingsCount > 0
      ? "No new rule candidates were created. Rule-like findings were kept as findings only; review the active rule health before promoting anything."
      : "No new rule candidates were created from this session.";
  }
  return candidateCount === 1
    ? "1 rule candidate for review."
    : `${candidateCount} rule candidates for review.`;
}

function formatBehaviorChange(m: Record<string, unknown>): string {
  const key = String(m.key ?? "");
  const before = Number(m.before);
  const after = Number(m.after);
  const change = String(m.change ?? "unchanged");
  if (key === "failedCommands" && after > before && change !== "worsened") {
    return `${change}; review manually`;
  }
  if (key === "verification") {
    if (before === 0 && after === 1) return "present in later run";
    if (before === 1 && after === 0) return "missing in later run; review manually";
    if (before === 1 && after === 1) return "present in both";
    if (before === 0 && after === 0) return "absent in both";
  }
  return change;
}

async function cmdSubmitSession(deps: CliDeps, parsed: ParsedArgs): Promise<number> {
  const file = parsed.file || parsed.positionals[0];
  if (!file) {
    deps.err("Usage: m9r-cli submit-session <file> --approved");
    return 1;
  }

  // Without --approved the submission still goes through, but lands honestly
  // as UNREVIEWED: the run stays awaiting a human review decision on the
  // Watchfloor and never completes on the agent's own claim.
  if (!parsed.approved) {
    deps.out("Submitting as UNREVIEWED evidence — a human reviews and decides on the Watchfloor.");
  }

  const base = apiBase(deps.env);
  const local = await readLocal(deps);
  if (!local?.token) {
    deps.err("No token found. Run: m9r-cli init");
    return 1;
  }

  let sessionText: string;
  try {
    sessionText = await deps.readFile(join(deps.cwd, file));
  } catch {
    // Allow absolute / already-resolved paths too.
    try {
      sessionText = await deps.readFile(file);
    } catch {
      deps.err(`submit-session failed: could not read file "${file}".`);
      return 1;
    }
  }

  let evidenceContract: unknown;
  if (parsed.evidenceContract) {
    let contractText: string;
    try {
      contractText = await deps.readFile(join(deps.cwd, parsed.evidenceContract));
    } catch {
      try {
        contractText = await deps.readFile(parsed.evidenceContract);
      } catch {
        deps.err(`submit-session failed: could not read Evidence Contract "${parsed.evidenceContract}".`);
        return 1;
      }
    }
    try {
      evidenceContract = JSON.parse(contractText);
    } catch {
      deps.err("submit-session failed: Evidence Contract must be valid JSON.");
      return 1;
    }
  }

  // Send the rules this workspace currently has loaded (from `m9r-cli rules`)
  // so the server can evaluate rule health. We do NOT self-report followed/
  // violated — observed evidence is the source of truth, not the agent's claim.
  const rulesLoaded = await readSavedRules(deps);

  // Debug-safe signal: shows whether .oathlock/rules.json was picked up. Prints
  // only a count — never tokens, never file/session contents.
  deps.out(`loaded rules: ${rulesLoaded.length}`);

  // Link to the active run (if any) so the dashboard can attach the session and
  // mark the run completed. We send only the run id — never run/session content.
  const run = await readRun(deps);

  const sessionFormat = inferSessionFormat(file);
  const res = await apiFetch(deps, `${base}/api/agent/session`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${local.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      session_format: sessionFormat,
      redaction_status: parsed.approved ? "human_reviewed" : "agent_submitted",
      human_approved_submission: Boolean(parsed.approved),
      session_text: sessionText,
      rules_loaded: rulesLoaded,
      rules_followed: [],
      rules_violated: [],
      ...(evidenceContract !== undefined ? { evidence_contract: evidenceContract } : {}),
      ...(run?.run_id ? { run_id: run.run_id } : {}),
    }),
  });
  if (!res.ok || !res.json) {
    deps.err(`submit-session failed: ${describeFailure(res, local.token)}`);
    return 1;
  }

  const body = res.json;
  const rules = (body.rules && typeof body.rules === "object" ? body.rules : {}) as Record<
    string,
    unknown
  >;
  deps.out(`ok: ${String(body.ok ?? false)}`);
  deps.out(`source_quality: ${String(body.source_quality ?? "(unknown)")}`);

  // parser_confidence is an object from the API; print its fields, not [object Object].
  const pc =
    body.parser_confidence && typeof body.parser_confidence === "object"
      ? (body.parser_confidence as Record<string, unknown>)
      : null;
  if (pc) {
    deps.out(`parser_confidence: ${String(pc.confidence ?? "(unknown)")}`);
    if (pc.reason !== undefined) deps.out(`parser_reason: ${String(pc.reason)}`);
    if (pc.turnsDetected !== undefined) deps.out(`turns_detected: ${String(pc.turnsDetected)}`);
    if (pc.commandsDetected !== undefined)
      deps.out(`commands_detected: ${String(pc.commandsDetected)}`);
    if (pc.filesEdited !== undefined) deps.out(`files_edited: ${String(pc.filesEdited)}`);
    if (pc.usageFieldsDetected !== undefined)
      deps.out(`usage_fields_detected: ${String(pc.usageFieldsDetected)}`);
  } else {
    // Fallback for a scalar confidence value.
    deps.out(`parser_confidence: ${String(body.parser_confidence ?? "(unknown)")}`);
  }

  deps.out(`findings_count: ${String(body.findings_count ?? 0)}`);
  if (typeof body.evidence_contract_id === "string" && body.evidence_contract_id) {
    deps.out(`evidence contract id: ${body.evidence_contract_id}`);
  }

  // Measurability block — the objective signals OathLock could extract from the
  // session. Printed only when at least one signal exists; never invents one.
  const ms =
    body.measurable_signals && typeof body.measurable_signals === "object"
      ? (body.measurable_signals as Record<string, unknown>)
      : null;
  if (ms && ms.hasObjectiveSignals === true) {
    deps.out("measurable signals:");
    deps.out(`  changed files: ${String(ms.changedFiles ?? 0)}`);
    deps.out(`  tests: ${String(ms.tests ?? "not supplied")}`);
    deps.out(`  build: ${String(ms.build ?? "not supplied")}`);
    deps.out(`  lint: ${String(ms.lint ?? "not supplied")}`);
    deps.out(`  human approval: ${String(ms.humanApproval ?? "not supplied")}`);
  }

  const needsReviewCount = Number.isFinite(Number(rules.needsReviewCount))
    ? Number(rules.needsReviewCount)
    : 0;
  const ruleLikeFindingsCount = Number.isFinite(Number(rules.ruleLikeFindingsCount))
    ? Number(rules.ruleLikeFindingsCount)
    : 0;
  deps.out(`rule candidates: ${needsReviewCount} for review`);
  if (ruleLikeFindingsCount > 0 && needsReviewCount === 0) {
    deps.out(`rule-like findings: ${ruleLikeFindingsCount}`);
  }
  // Rules are NEVER auto-activated — every candidate requires human promotion.
  deps.out(`new recommended rules for review: ${needsReviewCount}`);
  const coordinationRuleCandidates = Number(body.coordination_rule_candidates_created ?? 0);
  if (Number.isSafeInteger(coordinationRuleCandidates) && coordinationRuleCandidates > 0) {
    deps.out(`coordination-derived rule candidates: ${coordinationRuleCandidates} for review`);
  }
  deps.out(`rules message: ${rulesMessageForCli(needsReviewCount, ruleLikeFindingsCount)}`);

  printRuleHealth(deps, body.rule_health);

  // Run linkage status — surfaced so a submission is never treated as proof-ready
  // when the run could not be linked or its snapshot was not persisted.
  if (run?.run_id) {
    const linked = body.run_linked === true;
    deps.out(`run linked: ${linked ? "true" : "false"}`);
    if (typeof body.linked_run_id === "string" && body.linked_run_id) {
      deps.out(`linked run id: ${String(body.linked_run_id)}`);
    }
    deps.out(`snapshots persisted: ${body.snapshots_persisted === true ? "true" : "false"}`);
    const warnings = Array.isArray(body.warnings) ? (body.warnings as string[]) : [];
    for (const w of warnings) deps.err(`warning: ${redactToken(w, local.token)}`);
    if (!linked) {
      deps.err(
        "Two-run proof will not be available for this run because the submission was not linked. Ensure the run was started by this connected workspace, then resubmit.",
      );
    }
  }

  if (body.next_step) deps.out(`next_step: ${String(body.next_step)}`);
  return 0;
}

async function cmdDoctor(deps: CliDeps): Promise<number> {
  if (deps.env.USERPROFILE ?? deps.env.HOME) printNativeStatus(nativeIo(deps));
  const base = apiBase(deps.env);
  let failed = false;
  const check = (ok: boolean, label: string) => {
    if (!ok) failed = true;
    deps.out(`[${ok ? "PASS" : "FAIL"}] ${label}`);
  };

  const profilePath = await resolvedLocalPath(deps);
  const hasLocal = await deps.fileExists(profilePath);
  check(hasLocal, `${localProfileDisplay(deps)} exists`);

  const local = hasLocal ? await readLocal(deps) : null;
  const hasToken = Boolean(local?.token);
  check(hasToken, "token present");

  await reportCaptureStatus(deps);

  // API base is informational, but always reported.
  deps.out(`[INFO] API base: ${base}`);

  if (!hasToken) {
    deps.out("[SKIP] /api/agent/rules (no token)");
    deps.err(`doctor: no token in ${localProfileDisplay(deps)}. Run: m9r-cli init`);
    return 1;
  }

  // Known provider runtimes must prove that their bearer belongs to the
  // process that is about to run work. Undetectable legacy/manual profiles
  // continue to use the shared file without this provider comparison.
  if (detectedAgentKind(deps.env)) {
    const identity = await authenticatedIdentity(deps, local!);
    if (!identity.identity) {
      check(false, identity.error ?? "authenticated identity unavailable");
      deps.err(`doctor: ${identity.error ?? "could not verify authenticated identity"}`);
      return 1;
    }
    check(true, `authenticated identity: ${agentKindLabel(identity.identity.agentKind)} (${identity.identity.agentKind})`);
  }

  const res = await apiFetch(deps, `${base}/api/agent/rules`, {
    headers: { authorization: `Bearer ${local!.token}` },
  });
  if (res.ok) {
    check(true, "/api/agent/rules reachable and authorized");
  } else {
    check(false, `/api/agent/rules — ${describeFailure(res, local!.token)}`);
  }

  // Capability negotiation (Gate 3): compare what this CLI implements against
  // the server's live adapter contract, not a bundled copy that can drift.
  const contractRes = await apiFetch(deps, `${base}/api/agent/contract`);
  if (contractRes.ok && contractRes.json && Array.isArray(contractRes.json.actions)) {
    const serverActions = contractRes.json.actions as AdapterAction[];
    const { supported, unsupported } = negotiateAdapterActions(CLI_IMPLEMENTED_ACTIONS, serverActions);
    deps.out(`[INFO] adapter contract: ${supported.length} action(s) recognized by the server, ${unsupported.length} not`);
    for (const id of unsupported) deps.out(`[WARN] "${id}" is not recognized by the server's current adapter contract`);
  } else {
    deps.out("[INFO] adapter contract: unreachable, skipping capability negotiation");
  }

  return failed ? 1 : 0;
}

async function readConnectionActivity(
  deps: CliDeps,
  token: string,
  expectedAgentKind: string,
): Promise<{ ok: boolean; authenticated: boolean }> {
  const res = await apiFetch(deps, `${apiBase(deps.env)}/api/agent/connection-status`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok || !res.json) return { ok: false, authenticated: false };
  const actualKind = typeof res.json.agentKind === "string" ? res.json.agentKind.trim().toLowerCase() : "";
  if (actualKind !== expectedAgentKind.trim().toLowerCase()) {
    deps.err(`connection status refused: this token authenticates as ${actualKind || "an unknown provider"}, not ${expectedAgentKind}.`);
    return { ok: false, authenticated: false };
  }
  return { ok: true, authenticated: res.json.authenticated === true && typeof res.json.lastUsedAt === "string" };
}

type CaptureDoctorStatus = {
  kind: string;
  installed: boolean;
  active: "yes" | "no" | "unknown";
  detail: string;
};

async function fileContains(deps: CliDeps, path: string, marker: string): Promise<boolean> {
  if (!(await deps.fileExists(path))) return false;
  try {
    return (await deps.readFile(path)).includes(marker);
  } catch {
    return false;
  }
}

/**
 * Inspect only the current runtime's provider artifact. Capture is an
 * additive convenience, so a missing artifact is a warning rather than a
 * failed authentication/connection check. "Active" is deliberately honest:
 * Codex exposes a local hook trust gate that cannot be inferred from the
 * presence of hooks.json alone.
 */
async function inspectCaptureStatus(deps: CliDeps): Promise<CaptureDoctorStatus | null> {
  const kind = detectedAgentKind(deps.env);
  if (!kind) return null;

  if (kind === "claude-code") {
    const script = await fileContains(deps, join(deps.cwd, CAPTURE_HOOK_RELATIVE_PATH), "pending.jsonl");
    const settings = await fileContains(deps, join(deps.cwd, ".claude", "settings.local.json"), CAPTURE_HOOK_MARKER);
    return {
      kind,
      installed: script && settings,
      active: script && settings ? "yes" : "no",
      detail: script && settings
        ? "SessionEnd hook configured in .claude/settings.local.json"
        : "SessionEnd hook or shared capture script is missing",
    };
  }

  if (kind === "codex") {
    const script = await fileContains(deps, join(deps.cwd, CAPTURE_HOOK_RELATIVE_PATH), "pending.jsonl");
    const hooks = await fileContains(deps, join(deps.cwd, ".codex", "hooks.json"), CAPTURE_HOOK_MARKER);
    const installed = script && hooks;
    return {
      kind,
      installed,
      active: installed ? "unknown" : "no",
      detail: installed
        ? "SessionEnd hook configured; run /hooks in Codex once to review and trust it"
        : "SessionEnd hook or shared capture script is missing",
    };
  }

  if (kind === "opencode") {
    const plugin = await fileContains(deps, join(deps.cwd, ".opencode", "plugins", "m9r-memory.js"), OPENCODE_CAPTURE_MARKER);
    return {
      kind,
      installed: plugin,
      active: plugin ? "yes" : "no",
      detail: plugin
        ? "memory plugin configured; resident backfill covers sessions that miss an idle event"
        : "memory plugin is missing",
    };
  }

  return null;
}

async function reportCaptureStatus(deps: CliDeps): Promise<void> {
  const kind = detectedAgentKind(deps.env);
  const status = await inspectCaptureStatus(deps);
  if (!kind) {
    deps.out("[INFO] memory capture: runtime provider not detected; use --agent-kind with capture install to configure it");
    return;
  }
  if (!status) {
    deps.out(`[INFO] memory capture: no local integration for ${kind}`);
    return;
  }
  if (!status.installed) {
    deps.out(`[WARN] memory capture installed: no (${agentKindLabel(status.kind)} — ${status.detail}; run m9r-cli capture install --agent-kind ${status.kind})`);
    deps.out(`[WARN] memory capture active: no`);
    return;
  }
  deps.out(`[PASS] memory capture installed: yes (${agentKindLabel(status.kind)})`);
  if (status.active === "yes") {
    deps.out(`[PASS] memory capture active: yes — ${status.detail}`);
  } else if (status.active === "unknown") {
    deps.out(`[WARN] memory capture active: not verified — ${status.detail}`);
  } else {
    deps.out(`[WARN] memory capture active: no — ${status.detail}`);
  }
}

async function cmdWhoami(deps: CliDeps): Promise<number> {
  const local = await readLocal(deps);
  if (!local?.token) {
    deps.err(`No token found for the detected runtime profile (${localProfileDisplay(deps)}). Run: m9r-cli init`);
    return 1;
  }
  const result = await authenticatedIdentity(deps, local);
  if (!result.identity) {
    deps.err(result.error ?? "whoami failed: authenticated identity unavailable");
    return 1;
  }
  deps.out(`authenticated agent: ${agentKindLabel(result.identity.agentKind)} (${result.identity.agentKind})`);
  deps.out("identity source: server-authenticated M9R connection");
  return 0;
}

/**
 * Rotate this connection's own token: the server mints a new one and revokes
 * the old one, with a brief overlap so there's never a window with zero valid
 * tokens. Unlike disconnect/init, this never re-triggers human approval — the
 * connection identity and history are untouched, only the credential changes.
 */
async function cmdRotateToken(deps: CliDeps): Promise<number> {
  const base = apiBase(deps.env);
  const local = await readLocal(deps);
  if (!local?.token) {
    deps.err("No token found. Run: m9r-cli init");
    return 1;
  }

  const res = await apiFetch(deps, `${base}/api/agent/rotate-token`, {
    method: "POST",
    headers: { authorization: `Bearer ${local.token}` },
  });
  if (!res.ok || !res.json || typeof res.json.token !== "string") {
    deps.err(`rotate-token failed: ${describeFailure(res, local.token)}`);
    return 1;
  }

  const path = await resolvedLocalPath(deps);
  await writeJson(deps, path, { ...local, token: res.json.token, saved_at: new Date().toISOString() });
  deps.out(`Token rotated — new token saved to its agent profile (${maskToken(res.json.token)}). The old token is now revoked.`);
  return 0;
}

async function cmdDisconnect(deps: CliDeps): Promise<number> {
  const base = apiBase(deps.env);
  const local = await readLocal(deps);
  if (!local?.token) {
    deps.err("No local M9R connection found.");
    return 1;
  }

  const res = await apiFetch(deps, `${base}/api/agent/disconnect`, {
    method: "POST",
    headers: { authorization: `Bearer ${local.token}` },
  });
  const serverDisconnected = res.ok;
  deps.out(`server disconnected: ${serverDisconnected ? "yes" : "no"}`);
  if (!serverDisconnected) {
    deps.err(`server error: ${describeFailure(res, local.token)}`);
  }

  const localTokenRemoved = await removeExistingFile(deps, await resolvedLocalPath(deps));
  // Remove this runtime's run pointer. The legacy shared run.json is only
  // removed when it does not belong to a DIFFERENT agent kind — disconnecting
  // one agent must never delete a sibling agent's active run pointer.
  const agentRunRemoved = await removeExistingFile(deps, runStatePath(deps));
  const disconnectKind = detectedAgentKind(deps.env);
  let legacyRunRemoved = false;
  try {
    if (await deps.fileExists(runPath(deps.cwd))) {
      const legacy = parseLocalJson(await deps.readFile(runPath(deps.cwd))) as RunState | null;
      if (!disconnectKind || !legacy?.agent_kind || legacy.agent_kind === disconnectKind) {
        legacyRunRemoved = await removeExistingFile(deps, runPath(deps.cwd));
      }
    }
  } catch {
    /* leave the legacy pointer in place when unreadable */
  }
  const runCacheRemoved = agentRunRemoved || legacyRunRemoved;
  const rulesCacheRemoved = await removeExistingFile(deps, rulesPath(deps.cwd));

  deps.out(`local token removed: ${localTokenRemoved ? "yes" : "no"}`);
  deps.out(`run cache removed: ${runCacheRemoved ? "yes" : "no"}`);
  deps.out(`rules cache removed: ${rulesCacheRemoved ? "yes" : "no"}`);

  return serverDisconnected && localTokenRemoved ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

const USAGE = `m9r-cli — local CLI for M9R Agent Join

Usage:
  m9r-cli init                              Connect this workspace (one-time, human-approved)
  m9r-cli init --agent-kind <name> --adapter-command <cmd> [--adapter-args '["acp"]'] [--adapter-protocol <protocol>]
                                           Connect any provider with an ACP or M9R JSON stdio adapter
  m9r-cli init --force                      Force a new claim even if already connected
  m9r-cli init --skip-bootstrap             Connect without installing the automatic workflow
  m9r-cli bootstrap [--agent-kind <kind>]   Install/update the automatic agent workflow in repo instructions
  m9r-cli bootstrap status                  Report integration file, installed/missing/outdated, block version
  m9r-cli bootstrap remove                  Remove only the M9R-managed block (user content preserved)
  m9r-cli connect [--agents claude-code,codex,opencode]
                                         Detect installed agents and start one human-approved connection
  m9r-cli setup [--dry-run] [--yes] [--status]
                                         Set up this machine locally (no account): hooks and a standing instruction, with backups
  m9r-cli uninstall [--yes] [--purge]       Remove everything setup added and restore your files exactly
  m9r-cli tasks                             List tasks and what is waiting for your approval
  m9r-cli feed [--watch]                    Write the overlay feed (~/.m9r/feed.json); --watch keeps it current
  m9r-cli dismiss <task id>...              Clear items from the overlay list (changes nothing else)
  m9r-cli sessions [@agent]                 List the sessions of an agent seen on this machine (aim a task with send --session)
  m9r-cli approve|deny <task id>            Approve or deny a task an agent started (needs you at a terminal)
  m9r-cli allow @<from> @<to> [--for 2h]    Let one agent hand work to another without asking, for a limited time
  m9r-cli standing | revoke <rule id>       List or remove standing rules
  m9r-cli memory [--rebuild]                Show where shared memory lives; --rebuild writes summaries and the index
  m9r-cli send @<agent> "<message>" [--from <name>] [--session <id>]
                                         Send a task to an agent on this machine (shows at its next prompt)
  m9r-cli capture install [--agent-kind <kind>]
                                         Install/repair local Claude Code, Codex, or OpenCode memory capture without a new approval claim
  m9r-cli delivery <message id>              Show how far a message got, per recipient (read-only)
  m9r-cli resolve <@agent>                   Show one endpoint: reachability, presence, fidelity (read-only)
  m9r-cli endpoints                          List the endpoints in this workspace
  m9r-cli ask <agent> "<message>" [--wait]   Ask a connected agent (for example codex) in #general; --wait prints its reply
  m9r-cli capture uninstall                  Remove the capture hooks/plugin from this repo
  m9r-cli capture drain                      Drain locally captured sessions into the shared memory catalog (no network call)
  m9r-cli doctor                            Check local setup + API reachability
  m9r-cli whoami                            Show the server-authenticated provider identity
  m9r-cli rotate-token                      Rotate this connection's token (no re-approval needed)
  m9r-cli disconnect                        Revoke this connection and remove local volatile files
  m9r-cli run start --task "..." [--mode solo|coordinated|assurance|collaborative]
  m9r-cli inbox                             Pull instructions with the CLI
  m9r-cli heartbeat                         Report one authenticated linked-agent lease
  m9r-cli assignments                       List bounded assignments for this agent
  m9r-cli assignment <decision> <id>         Accept, reject, or complete an assignment
  m9r-cli rules                             Fetch active workspace rules
  m9r-cli run status --phase "..."          Report the current phase to the dashboard
  m9r-cli finding publish --title "..." --observed "..." [--environment "..."] [--evidence-level inferred|correlated|command_tied] [--suggested "..."] [--limitations "a,b"]
                                         Publish a Finding for the active run — awaiting operator review, not an automatic scan result
  m9r-cli submit-session <file> --approved [--evidence-contract <json>]
                                         Submit an approved, redacted session and optional structured contract
  m9r-cli compare --baseline-run <id> --later-run <id>   Conservative two-run proof
  m9r-cli signal emit --type <TYPE> --summary "..."      Record a Work Signal for this connection
  m9r-cli signal replay [--since N] [--limit N]          Replay Work Signals for this workspace
  m9r-cli signal ack --through N                         Self-acknowledge signals through a sequence
  m9r-cli coordinate request ...                        Request bounded help/check for the active run
  m9r-cli coordinate results                            List returned provider results for the active run
  m9r-cli coordinate decide <grant-id> ...              Adopt, reject, or challenge a returned result
  m9r-cli conversation start --topic "..." --with <agent>[,<agent>]
                                         Start a real multi-turn conversation with other connected agents
  m9r-cli conversation send --conversation <id> --text "..." [--to <agent>] [--type message|handoff|ack|result]
                                         Post into an open conversation (a handoff auto-starts a run for the recipient)
  m9r-cli conversation messages --conversation <id> [--since <ISO timestamp>]
                                         Read a conversation's messages
  m9r-cli terminal runtime                              Start the persistent loopback-only M9R Runtime
  m9r-cli terminal runtime --local-only                 Start local PTYs without M9R Cloud or a hosted token
  m9r-cli terminal state <idle|working|blocked>         Report local agent state without a model call
  m9r-cli service install|uninstall|status              Manage M9R Runtime's login-startup registration (Windows)

Recommended: after init, use the M9R browser workspace for multiplayer
coordination, shared messages, and human review. The local terminal runtime
is optional and experimental, and is not part of the public launch offer.
Run npx m9r-cli terminal runtime only when explicitly testing that local
capability. Set ACP_BRIDGE_ENABLED=false to disable the experimental bridge
and use the manual inbox/assignments flow above instead.

First-time setup runs init once; after approval it installs a repo-native
workflow (AGENTS.md for Codex/Grok Build, CLAUDE.md for Claude Code) so
supported agents use M9R during normal tasks without
"use M9R" in every prompt. M9R does not intercept arbitrary external
agent sessions — automatic behavior depends on the agent reading those repo
instructions. A returning workspace (where .oathlock/local.json already has a
token) should use doctor then rules.

In every governed task, agents prepare a redacted M9R Evidence Draft automatically;
humans approve that exact draft; M9R records it only after approval.
Every agent run: doctor → run start → inbox → rules → (work) → evidence draft → waiting status.
run telemetry is status-only; it never uploads source code or secrets.

Environment:
  OATHLOCK_API_URL   API base (default ${DEFAULT_API_URL}; use http://localhost:3000 for local dev)
  --agent-kind <kind>  Claim identity: any lowercase provider slug (for example codex, gemini-cli, aider)
  --agents <list>      connect: comma-separated kinds to connect instead of auto-detecting
  --adapter-command <cmd>  Local command for a non-bundled provider adapter
  --adapter-args <json>    JSON argv array for that provider command
  --adapter-protocol       acp-stdio (default) or oathlock-json-stdio for resident one-shot grants
  --adapter-shell           Resolve the adapter command through the local shell
  OATHLOCK_AGENT_KIND  Agent-kind fallback when --agent-kind is omitted
  OATHLOCK_REPO_HINT   Override repo hint for init`;

/** Adapts the CLI's dependencies for the native front-door commands; undefined without a home directory (tests). */
function nativeIo(deps: CliDeps): NativeIo {
  const homeDir = deps.env.USERPROFILE ?? deps.env.HOME ?? "";
  return { env: deps.env, homeDir, out: (l) => deps.out(l), err: (l) => deps.err(l), confirm: deps.confirm };
}

/** Run the CLI. Returns a process exit code. */
export async function run(argv: string[], deps: CliDeps): Promise<number> {
  const [command, ...rest] = argv;
  const parsed = parseArgs(rest);

  switch (command) {
    case "init":
      return cmdInit(deps, parsed);
    case "connect":
      return cmdConnect(deps, parsed);
    case "setup":
    case "uninstall":
    case "send":
    case "tasks":
    case "feed":
    case "dismiss":
    case "sessions":
    case "approve":
    case "deny":
    case "allow":
    case "standing":
    case "revoke":
      return runNativeCommand(command, rest, nativeIo(deps));
    case "memory":
      return runMemory(rest, { cwd: deps.cwd, out: (l) => deps.out(l), err: (l) => deps.err(l) });
    case "bootstrap":
      return cmdBootstrap(deps, parsed);
    case "capture":
      return cmdCapture(deps, parsed);
    case "rules":
      return cmdRules(deps);
    case "inbox":
      return cmdInbox(deps);
    case "heartbeat":
      return cmdHeartbeat(deps);
    case "assignments":
      return cmdAssignments(deps);
    case "assignment":
      return cmdAssignment(deps, parsed);
    case "run":
      return cmdRun(deps, parsed);
    case "finding":
      return cmdFinding(deps, parsed);
    case "signal":
      return cmdSignal(deps, parsed);
    case "coordinate":
      return cmdCoordinate(deps, parsed);
    case "ask":
      return cmdAsk(deps, parsed);
    case "delivery":
      return cmdDelivery(deps, parsed);
    case "resolve":
      return cmdResolve(deps, parsed);
    case "endpoints":
      return cmdEndpoints(deps, parsed);
    case "conversation":
      return cmdConversation(deps, parsed);
    case "compare":
    case "proof":
      return cmdCompare(deps, parsed);
    case "submit-session":
      return cmdSubmitSession(deps, parsed);
    case "doctor":
      return cmdDoctor(deps);
    case "whoami":
      return cmdWhoami(deps);
    case "rotate-token":
      return cmdRotateToken(deps);
    case "disconnect":
      return cmdDisconnect(deps);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      deps.out(USAGE);
      return command ? 0 : 1;
    default:
      deps.err(`Unknown command: ${command}`);
      deps.out(USAGE);
      return 1;
  }
}
