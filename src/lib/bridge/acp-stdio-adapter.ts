import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { isAbsolute, relative, resolve, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { Readable, Writable } from "node:stream";

// The bare global `require` only exists here when this file happens to be
// loaded through a CJS-interop entry point (running the real bridge via the
// `tsx` CLI); the plain `node --import register-alias.mjs` test loader has
// no such global, so `require.resolve(...)` below would throw at test time.
// createRequire(import.meta.url) is the portable, ESM-native way to get the
// same `require.resolve` regardless of how this module was actually loaded.
const require = createRequire(import.meta.url);
import * as acp from "@agentclientprotocol/sdk";
import { isMissionFeatureEnabled } from "@/lib/mission/mission-feature-flags";
import type { ProviderAssignment, ProviderCapabilities } from "@/lib/mission/mission-provider-adapter";
import { allCapabilitiesFalse } from "@/lib/mission/mission-provider-adapter";
import { providerAdapterId, type ProviderAdapterConfig } from "@/lib/provider-adapter-config";
import { redactSession } from "@/lib/session-redaction";
// Type-only: message-todo-service reaches the Supabase client, which has no
// business being pulled into the provider adapter's runtime graph.
import type { MessageTodoEntry } from "./message-todo-service";
import type {
  AgentServerHandle,
  AgentServerHealth,
  AgentSessionHandle,
  InitializedAgent,
  InteractiveProviderAdapter,
  InteractiveProviderCapabilities,
  InteractiveProviderEvent,
} from "./interactive-provider-adapter";

const DEFAULT_PERMISSION_TIMEOUT_MS = 15 * 60 * 1_000;
const DEFAULT_MAX_READ_BYTES = 512 * 1_024;
/**
 * Confirmed live: with no bound at all, a provider CLI that never responds
 * to an ACP prompt request (e.g. its own subprocess spawn hangs -- observed
 * matching Windows CreateProcessAsUserW failures) hangs this generator
 * forever. bridge-runtime.ts's sessionBusy flag for that session is only
 * cleared in a `finally` block *after* this generator settles, so a single
 * unbounded hang doesn't just fail one turn -- it permanently locks that
 * agent out of that conversation until the whole bridge process restarts,
 * since every later message just queues behind a session that never frees.
 * 20 minutes is long enough for a real multi-tool-call turn, short enough
 * that a genuine hang recovers in reasonable time instead of never.
 */
const DEFAULT_PROMPT_TIMEOUT_MS = 20 * 60 * 1_000;
/** Mirrors MAX_MESSAGE_TODO_ENTRIES; duplicated as a literal so this file keeps a type-only dependency on the store. */
const MAX_PLAN_ENTRIES = 50;

type ActivityStatus = "started" | "succeeded" | "failed" | "waiting";

interface ActivityPayload {
  [key: string]: unknown;
  type: "provider.activity";
  activityKind: "file.read" | "file.changed" | "command.started" | "command.completed";
  status: ActivityStatus;
  summary: string;
  filePath: string | null;
  command: string | null;
  testName: null;
  testPassed: null;
  testFailed: null;
  testSkipped: null;
  reviewTarget: null;
  gitRef: null;
  /**
   * Real diff content, when the provider's own tool_call_update actually
   * carries it (confirmed live: Claude Code and OpenCode both send a
   * `{type:"diff", path, oldText, newText}` entry in `content` on a file
   * edit -- OpenCode additionally sends a ready-made unified-diff string
   * plus additions/deletions counts under `rawOutput.metadata.diff`).
   * `oldText` is null for a brand-new file, never a placeholder guess.
   * Never assumed present -- a provider that omits it just leaves these
   * null, and the caller falls back to filePath-only activity, same as
   * before this field existed.
   */
  oldText?: string | null;
  newText?: string | null;
  diffPatch?: string | null;
  additions?: number | null;
  deletions?: number | null;
}

interface Queue<T> {
  push(value: T): void;
  close(): void;
  [Symbol.asyncIterator](): AsyncIterator<T>;
}

class AsyncEventQueue<T> implements Queue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) this.waiters.shift()!({ done: true, value: undefined });
  }

  private next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolveNext) => this.waiters.push(resolveNext));
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => this.next() };
  }
}

interface PermissionRecord {
  requestId: string;
  params: acp.RequestPermissionRequest;
  approved: boolean;
  consumed: boolean;
  settled: boolean;
  resolve: (response: acp.RequestPermissionResponse) => void;
}

interface SessionState {
  handle: AgentSessionHandle;
  rawSessionId: string;
  queue: AsyncEventQueue<InteractiveProviderEvent> | null;
  permissions: Map<string, PermissionRecord>;
  /** The CONTROLLER-level session id (AcpSessionController.respondToPermission's own key), NOT this adapter's own internal handle.sessionId -- requestPermission needs this to report a pending permission the same way bridge-runtime.ts's poll loop will later look it up. Also carries missionId for the same report. */
  executionId: string;
  missionId: string;
}

interface ServerState {
  handle: AgentServerHandle;
  child: ChildProcessWithoutNullStreams;
  workingDirectory: string;
  connection: acp.ClientSideConnection | null;
  initialized: acp.InitializeResponse | null;
  sessions: Map<string, SessionState>;
  stderrTail: string;
  closed: boolean;
  /** This connection's own file-path DENY-list, snapshotted from
   * ProviderAssignment at launch time -- see requestPermission for the
   * actual enforcement. Empty means no restriction. */
  deniedFilePatterns: string[];
}

export interface AcpStdioAdapterOptions {
  id: string;
  command: string;
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
  permissionTimeoutMs?: number;
  promptTimeoutMs?: number;
  maxReadBytes?: number;
  now?: () => string;
  /**
   * Codex/Claude are spawned via process.execPath + a fixed .js path, which
   * never needs shell resolution. OpenCode is spawned by its bare command
   * name ("opencode"), an npm-global install that's a .cmd shim on Windows
   * -- and Windows' CreateProcess (what shell:false uses) does not do
   * PATHEXT resolution the way cmd.exe does, so it fails with ENOENT even
   * though the exact same command works fine typed into a real shell.
   * Confirmed live: crashed the whole bridge process with an unhandled
   * ChildProcess 'error' event, not just a graceful per-session failure.
   * Off by default (false) so Codex/Claude's behavior is unchanged; only
   * the OpenCode adapter opts in.
   */
  shell?: boolean;
  /**
   * Optional per-server environment additions. Some ACP providers (notably
   * OpenCode) load MCP servers from their own config instead of honoring the
   * ACP session descriptor, so their config must be assembled when the server
   * process is launched with the mission-specific assignment.
   */
  serverEnv?: (input: { assignment: ProviderAssignment; workingDirectory: string }) => Record<string, string | undefined>;
}

function boundedText(value: unknown, maxLength: number, options?: { includeHeuristics?: boolean }): string {
  return redactSession(typeof value === "string" ? value : String(value ?? ""), options).redactedText.slice(0, maxLength);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

function field(value: unknown, key: string): unknown {
  return record(value)?.[key];
}

function statusForAcp(value: unknown): ActivityStatus {
  if (value === "completed") return "succeeded";
  if (value === "failed") return "failed";
  if (value === "pending") return "waiting";
  return "started";
}

function toolKind(value: unknown): "read" | "changed" | "execute" | null {
  if (value === "read") return "read";
  if (value === "edit" || value === "delete" || value === "move") return "changed";
  if (value === "execute") return "execute";
  return null;
}

function rawPath(update: Record<string, unknown>): string | null {
  const locations = update.locations;
  if (Array.isArray(locations)) {
    for (const location of locations) {
      const path = field(location, "path");
      if (typeof path === "string") return path;
    }
  }
  const input = record(update.rawInput);
  for (const key of ["path", "filePath", "file_path"]) {
    if (typeof input?.[key] === "string") return input[key] as string;
  }
  return null;
}

function rawCommand(update: Record<string, unknown>): string | null {
  const input = record(update.rawInput);
  for (const key of ["command", "cmd"]) {
    if (typeof input?.[key] === "string" && input[key].trim().length > 0) return boundedText(input[key], 512);
  }
  return null;
}

/**
 * Only workspace-relative paths can cross into the Mission activity stream.
 * `repositoryRoot`, when given, first strips the root prefix off an absolute
 * path -- live-caught: OpenCode's own ACP tool calls report the full
 * absolute path (`C:\RunLeak\runleak\foo.md`), which this function has
 * always rejected outright as "not relative," so filePath (and therefore
 * every diff/activity record keyed on it) silently went null for every
 * OpenCode file edit, never for Claude Code's already-relative paths. This
 * is relativizing, not weakening the check: a path outside the given root
 * is still rejected exactly as before.
 */
export function workspaceRelativeAcpPath(value: unknown, repositoryRoot?: string): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  let normalized = value.trim().replaceAll("\\", "/");
  if (repositoryRoot) {
    const rootNormalized = repositoryRoot.trim().replaceAll("\\", "/").replace(/\/$/, "");
    if (normalized.toLowerCase().startsWith(`${rootNormalized.toLowerCase()}/`)) {
      normalized = normalized.slice(rootNormalized.length + 1);
    } else if (normalized.toLowerCase() === rootNormalized.toLowerCase()) {
      normalized = "";
    }
  }
  if (/^(?:[a-z]:\/|\/|\\\\)/i.test(normalized)) return null;
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) return null;
  return boundedText(normalized.replace(/^\.\//, ""), 512);
}

/**
 * Minimal glob matcher for the file-permission deny-list -- deliberately not
 * a dependency, just `*` (any run of characters except `/`) and `**` (any
 * run of characters including `/`), which covers the two real cases a deny
 * pattern needs: a bare filename (".env") and a directory tree
 * ("secrets/**"). Matched against the same workspace-relative, forward-slash
 * path this codebase already normalizes everything to.
 */
export function matchesDenyPattern(path: string, pattern: string): boolean {
  const normalizedPath = path.trim().replaceAll("\\", "/").toLowerCase();
  const normalizedPattern = pattern.trim().replaceAll("\\", "/").toLowerCase();
  if (!normalizedPath || !normalizedPattern) return false;
  const escaped = normalizedPattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  // Placeholder swap, not a direct two-pass replace: converting "**" to
  // ".*" and then re-scanning for "*" would also match inside the ".*" this
  // pass just inserted. A sentinel unlikely to appear in a real glob
  // pattern protects the already-converted "**" from the single-"*" pass
  // that runs after it.
  const globstarSentinel = "@@OL_GLOBSTAR@@";
  const regexSource = `^${escaped.replace(/\*\*/g, globstarSentinel).replace(/\*/g, "[^/]*").split(globstarSentinel).join(".*")}$`;
  try {
    return new RegExp(regexSource).test(normalizedPath);
  } catch {
    return false;
  }
}

/**
 * Extracts path-like tokens from a shell command line and checks each
 * against the deny-list. Live-caught: an agent's structured edit tool call
 * always carries a real path field, but a shell command (`echo x >
 * denied.md`, `Set-Content denied.md ...`) carries only a command string --
 * a deny-check that only ever looked at rawPath() silently never fires for
 * any file write done this way, and OpenCode in particular reaches for its
 * shell tool constantly, not the edit tool. This is a heuristic, not a
 * sandbox: it tokenizes on whitespace/quotes/redirection/pipe/chaining
 * operators and matches each token, which catches a command that names the
 * denied path plainly (the realistic case -- an agent that doesn't know a
 * path is off-limits, not one deliberately obfuscating it) but not a path
 * built at runtime from string concatenation or a variable.
 */
export function commandTouchesDeniedPath(command: string, patterns: readonly string[]): string | null {
  if (!command.trim() || patterns.length === 0) return null;
  const tokens = command.split(/[\s"'`|&;()]+|>>?|<</).map((token) => token.trim()).filter(Boolean);
  for (const token of tokens) {
    for (const pattern of patterns) {
      if (matchesDenyPattern(token, pattern)) return pattern;
    }
  }
  return null;
}

/**
 * Translate only ACP's explicit structured tool updates. Agent prose is never
 * promoted to file, command, test, or review activity.
 */
export function mapAcpSessionUpdate(input: {
  sessionId: string;
  update: unknown;
  occurredAt?: string;
  repositoryRoot?: string;
}): InteractiveProviderEvent | null {
  const update = record(input.update);
  const updateKind = update?.sessionUpdate;
  if (updateKind !== "tool_call" && updateKind !== "tool_call_update") return null;
  if (!update) return null;

  const kind = toolKind(update.kind);
  if (!kind) return null;
  const command = kind === "execute" ? rawCommand(update) : null;
  if (kind === "execute" && command === null) return null;
  const status = statusForAcp(update.status);
  const activityKind = kind === "read"
    ? "file.read"
    : kind === "changed"
      ? "file.changed"
      : status === "started"
        ? "command.started"
        : "command.completed";
  const filePath = kind === "execute" ? null : workspaceRelativeAcpPath(rawPath(update), input.repositoryRoot);
  // A tool call's own title is a short structured UI label, not raw session
  // output -- the high-entropy/email heuristics have no real secret to catch
  // here and readily blank a legitimate dash-heavy label (a UUID, an id).
  const summary = boundedText(update.title ?? (kind === "read" ? "Provider read" : kind === "changed" ? "Provider changed a file" : "Provider executed a command"), 2_048, { includeHeuristics: false });
  // Real diff content, when the provider's own update actually carries it --
  // never assumed present (see ActivityPayload's doc comment for exactly
  // what's confirmed live per provider). `content` can mix a plain-text
  // entry with a diff entry in the same array (OpenCode does this), so the
  // diff entry is found by its own `type`, not by array position.
  const contentEntries = Array.isArray(update.content) ? update.content : [];
  const diffEntry = contentEntries.map((entry) => record(entry)).find((entry) => entry?.type === "diff");
  const oldText = typeof diffEntry?.oldText === "string" ? diffEntry.oldText : null;
  const newText = typeof diffEntry?.newText === "string" ? diffEntry.newText : null;
  const outputMetadata = record(record(update.rawOutput)?.metadata);
  const diffPatch = typeof outputMetadata?.diff === "string" ? outputMetadata.diff : null;
  const filediff = record(outputMetadata?.filediff);
  const additions = typeof filediff?.additions === "number" ? filediff.additions : null;
  const deletions = typeof filediff?.deletions === "number" ? filediff.deletions : null;
  const payload: ActivityPayload = {
    type: "provider.activity",
    activityKind,
    status,
    summary,
    filePath,
    command,
    testName: null,
    testPassed: null,
    testFailed: null,
    testSkipped: null,
    reviewTarget: null,
    gitRef: null,
    oldText,
    newText,
    diffPatch,
    additions,
    deletions,
  };
  return {
    type: "provider.activity",
    sessionId: input.sessionId,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    payload,
  };
}

/**
 * ACP PlanEntry[] -> the internal checklist shape, with ACP's own status and
 * priority vocabulary preserved verbatim (pending | in_progress | completed).
 * Deliberately not renamed into a parallel set of frontend status names:
 * a stored row and a live provider update then mean the same thing without
 * a translation step in between.
 *
 * `content` is a short structured UI label the same way a tool call's title
 * is, so it takes the same includeHeuristics:false treatment -- the entropy
 * heuristic readily blanks a legitimate dash-heavy todo line.
 */
export function planEntries(input: unknown): MessageTodoEntry[] {
  if (!Array.isArray(input)) return [];
  const entries: MessageTodoEntry[] = [];
  for (const raw of input) {
    const entry = record(raw);
    if (!entry) continue;
    if (typeof entry.content !== "string") continue;
    const content = boundedText(entry.content, 240, { includeHeuristics: false }).trim();
    if (!content) continue;
    const status = entry.status === "in_progress" || entry.status === "completed" ? entry.status : "pending";
    const priority = entry.priority === "high" || entry.priority === "low" ? entry.priority : "medium";
    entries.push({ content, status, priority });
    if (entries.length >= MAX_PLAN_ENTRIES) break;
  }
  return entries;
}

export function mapAcpUsageEvent(input: {
  sessionId: string;
  usage: unknown;
  occurredAt: string;
  usageBasis: "prompt_turn" | "context_window";
}): InteractiveProviderEvent | null {
  const usage = record(input.usage);
  if (!usage) return null;
  const inputTokens = typeof usage.inputTokens === "number" ? usage.inputTokens : typeof usage.input_tokens === "number" ? usage.input_tokens : null;
  const outputTokens = typeof usage.outputTokens === "number" ? usage.outputTokens : typeof usage.output_tokens === "number" ? usage.output_tokens : null;
  const totalTokens = typeof usage.totalTokens === "number" ? usage.totalTokens : typeof usage.total_tokens === "number" ? usage.total_tokens : null;
  const contextUsedTokens = typeof usage.used === "number" ? usage.used : null;
  const contextWindowTokens = typeof usage.size === "number" ? usage.size : null;
  const cost = record(usage.cost);
  const costUsd = typeof cost?.amount === "number" ? cost.amount : null;
  if (inputTokens === null && outputTokens === null && totalTokens === null && contextUsedTokens === null && costUsd === null) return null;
  return {
    type: "provider.usage_updated",
    sessionId: input.sessionId,
    occurredAt: input.occurredAt,
    payload: { inputTokens, outputTokens, totalTokens, contextUsedTokens, contextWindowTokens, costUsd, usageBasis: input.usageBasis },
  };
}

function usageEvent(input: { sessionId: string; update: Record<string, unknown>; occurredAt: string }): InteractiveProviderEvent | null {
  return mapAcpUsageEvent({ sessionId: input.sessionId, usage: record(input.update.usage) ?? input.update, occurredAt: input.occurredAt, usageBasis: "context_window" });
}

function pathWithinRoot(root: string, candidate: string): string {
  if (!isAbsolute(candidate)) throw new Error("ACP file paths must be absolute.");
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const distance = relative(resolvedRoot, resolvedCandidate);
  if (distance === "" || (distance !== ".." && !distance.startsWith(`..${sep}`) && !isAbsolute(distance))) return resolvedCandidate;
  throw new Error("ACP file path is outside the authorized worktree.");
}

function pathMatchesPermission(params: acp.RequestPermissionRequest, candidate: string, root: string): boolean {
  const toolCall = record(params.toolCall);
  const paths: string[] = [];
  const locations = toolCall?.locations;
  if (Array.isArray(locations)) {
    for (const location of locations) {
      const path = field(location, "path");
      if (typeof path === "string") paths.push(path);
    }
  }
  const input = record(toolCall?.rawInput);
  for (const key of ["path", "filePath", "file_path"]) {
    if (typeof input?.[key] === "string") paths.push(input[key] as string);
  }
  return paths.some((path) => {
    try { return pathWithinRoot(root, path) === candidate; } catch { return false; }
  });
}

export function shouldResetPermissionMode(currentModeId: string | undefined): boolean {
  return currentModeId === "bypassPermissions";
}

export function responseForPermission(params: acp.RequestPermissionRequest, approved: boolean): acp.RequestPermissionResponse {
  if (!approved || params.options.length === 0) return { outcome: { outcome: "cancelled" } };
  // Never fall back to options[0]: a provider may list "always allow" first, which would turn one
  // approval into a standing grant. No allow_once option means we cannot honor the approval safely.
  const allowOnce = params.options.find((option) => option.kind === "allow_once");
  if (!allowOnce) return { outcome: { outcome: "cancelled" } };
  return { outcome: { outcome: "selected", optionId: allowOnce.optionId } };
}

/**
 * Buzz-parity dev tool MCP server (crates/buzz-dev-mcp / dev-mcp-server.ts)
 * — a curated, OathLock-controlled tool surface given to every session
 * instead of the prior `mcpServers: []`. Spawned via tsx the same way
 * oathlock-terminal-bridge.ts spawns local-mission-bridge-runner.ts as a
 * SEPARATE process rather than importing it in-process: this keeps the
 * @modelcontextprotocol/sdk dependency tree out of anything that ends up in
 * the packaged CLI's hand-maintained whitelist (scripts/build-cli.mjs).
 * Feature-flagged off by default like every other Mission capability —
 * disabling it returns to the prior `mcpServers: []` behavior exactly, not
 * a broken session.
 */
/**
 * `missionId` becomes the dev-mcp subprocess's OATHLOCK_MISSION_ID (plus
 * OATHLOCK_APP_URL/OATHLOCK_AGENT_TOKEN, set once on THIS process's own env
 * by startMissionBridge -- see bridge-runtime.ts) via the ACP `env` field,
 * not left to implicit inheritance: this subprocess is spawned by the agent
 * CLI itself (Claude Code/Codex), not directly by the Bridge, so the ACP
 * protocol's own explicit env-passing is the only reliable path. This is
 * what makes send_message (dev-mcp-server.ts) work at all -- without it,
 * the tool exists but always refuses with "no channel connection."
 */
export function devMcpServerDescriptor(workingDirectory: string, missionId: string): acp.McpServer[] {
  if (!isMissionFeatureEnabled("devMcpTools")) return [];
  // Two contexts, same relative-sibling layout, different launch: the
  // monorepo runs this file as .ts source via tsx, with dev-mcp-server.ts
  // sitting right next to it in src/lib/bridge/ -- tsx/cli is a real
  // dependency there. The published CLI (build-cli.mjs) flattens both files
  // into cli/dist/*.js, already-compiled plain JS with no tsx in the
  // package at all, so it must invoke dev-mcp-server.js directly with node.
  // import.meta.url's own extension tells us which context this is,
  // without needing a separate build-time flag threaded through.
  const isCompiled = import.meta.url.endsWith(".js");
  const entryPoint = resolve(dirname(fileURLToPath(import.meta.url)), isCompiled ? "dev-mcp-server.js" : "dev-mcp-server.ts");
  const appUrl = process.env.OATHLOCK_APP_URL?.trim();
  const agentToken = process.env.OATHLOCK_AGENT_TOKEN?.trim();
  const env: acp.EnvVariable[] = [];
  if (appUrl) env.push({ name: "OATHLOCK_APP_URL", value: appUrl });
  if (agentToken) env.push({ name: "OATHLOCK_AGENT_TOKEN", value: agentToken });
  if (missionId) env.push({ name: "OATHLOCK_MISSION_ID", value: missionId });
  return [{
    name: "oathlock-dev-tools",
    command: process.execPath,
    args: isCompiled ? [entryPoint, workingDirectory] : [require.resolve("tsx/cli"), entryPoint, workingDirectory],
    env,
  }];
}

/**
 * OpenCode's ACP implementation supports MCP servers configured in its
 * OpenCode config, but does not reliably materialize the ACP `newSession`
 * `mcpServers` list. Keep the same governed dev server and inject it through
 * OpenCode's documented inline config channel instead. Environment
 * placeholders are intentional: the bearer token stays in the child process
 * environment and never gets serialized into config content or logs.
 */
/**
 * OpenCode defaults to allowing every edit/write/bash call without ever
 * asking -- confirmed live: launchServer received the right deniedFilePatterns,
 * but requestPermission was never invoked at all for a matching write, and
 * the file still landed on disk. Unlike Claude Code/Codex (wrapped through
 * @agentclientprotocol packages that always route file I/O through the
 * client), OpenCode is a real unsandboxed local process that only calls ACP's
 * session/request_permission when its own "permission" config says to ask
 * (https://opencode.ai/docs/permissions/). Forcing edit/write/bash to "ask"
 * here is what makes OathLock's existing human-approval flow AND the
 * file-permission deny-list apply to OpenCode at all -- this must be
 * unconditional (not gated behind devMcpTools like the dev-tools MCP block
 * below), since it's governance parity with the other two providers, not a
 * dev-tool extra.
 */
export function openCodeConfigContent(workingDirectory: string, missionId: string, baseContent = process.env.OPENCODE_CONFIG_CONTENT): string | null {
  let base: Record<string, unknown> = {};
  if (baseContent?.trim()) {
    try {
      const parsed = JSON.parse(baseContent) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) base = parsed as Record<string, unknown>;
    } catch {
      // OpenCode accepts JSONC in files, but OPENCODE_CONFIG_CONTENT is an
      // inline JSON override. If an operator supplied malformed content, keep
      // the governed bridge config usable rather than copying invalid JSON.
    }
  }
  const existingPermission = base.permission && typeof base.permission === "object" && !Array.isArray(base.permission)
    ? base.permission as Record<string, unknown>
    : {};
  const merged: Record<string, unknown> = {
    ...base,
    $schema: "https://opencode.ai/config.json",
    permission: { edit: "ask", write: "ask", bash: "ask", ...existingPermission },
  };
  if (isMissionFeatureEnabled("devMcpTools")) {
    const descriptor = devMcpServerDescriptor(workingDirectory, missionId)[0];
    if (descriptor && "command" in descriptor && Array.isArray(descriptor.args)) {
      const existingMcp = base.mcp && typeof base.mcp === "object" && !Array.isArray(base.mcp)
        ? base.mcp as Record<string, unknown>
        : {};
      merged.mcp = {
        ...existingMcp,
        "oathlock-dev-tools": {
          type: "local",
          command: [descriptor.command, ...descriptor.args],
          enabled: true,
          environment: {
            OATHLOCK_APP_URL: "{env:OATHLOCK_APP_URL}",
            OATHLOCK_AGENT_TOKEN: "{env:OATHLOCK_AGENT_TOKEN}",
            OATHLOCK_MISSION_ID: missionId,
          },
        },
      };
    }
  }
  return JSON.stringify(merged);
}

/**
 * Reports a newly-waiting permission request to the app (POST
 * /api/bridge/permissions, bridge-permission-service.ts) so a human can
 * actually see and decide it -- runs in the same process as
 * startMissionBridge (bridge-runtime.ts), unlike devMcpServerDescriptor's
 * subprocess, so OATHLOCK_APP_URL/OATHLOCK_AGENT_TOKEN are read straight
 * from process.env, no ACP env-passing needed. Best-effort: a failed report
 * still leaves the real requestPermission promise waiting (and visible as
 * provider.activity either way), it just means a human won't see it in the
 * dashboard's permission list until the poll loop's own retry -- never
 * silently drops the permission gate itself.
 */
/** A workspace/DM channel session's missionId is always the synthetic
 * `channel-${conversationId}` namespace (see workspaceMissionIdForConversation
 * in bridge-runtime.ts) -- a real Mission-based session's missionId is a
 * genuine mission id with no dashboard channel equivalent, so there is
 * nothing to recover there. Used to fix a real routing gap: the permission
 * notice below used to always land in this agent's own fixed 1:1 DM
 * regardless of which channel a human was actually chatting in when the
 * permission was requested -- a human sitting in a real multi-agent channel
 * never saw the card show up where they were looking. */
export function conversationIdForChannelMission(missionId: string): string | null {
  return missionId.startsWith("channel-") ? missionId.slice("channel-".length) : null;
}

export async function reportPendingPermissionToApp(input: { missionId: string; executionId: string; requestId: string; summary: string; command: string | null; filePath: string | null }): Promise<void> {
  const appUrl = process.env.OATHLOCK_APP_URL?.trim();
  const agentToken = process.env.OATHLOCK_AGENT_TOKEN?.trim();
  if (!appUrl || !agentToken) return;
  try {
    await fetch(`${appUrl.replace(/\/$/, "")}/api/bridge/permissions`, {
      method: "POST",
      headers: { authorization: `Bearer ${agentToken}`, "content-type": "application/json" },
      body: JSON.stringify({ ...input, conversationId: conversationIdForChannelMission(input.missionId) }),
    });
  } catch (error) {
    console.error(`Could not report pending permission ${input.requestId}: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Real file locking (item 4): ask the app to take the lock on one path
 * before an edit-shaped tool call is allowed through. Returns the conflict
 * when someone else holds it, null when this agent may proceed.
 *
 * Fails OPEN, deliberately: if the app is unreachable, a lock cannot be
 * confirmed either way, and refusing every edit would turn a backend blip
 * into "no agent can change any file." Overwrite protection is the goal, but
 * silently bricking all local work to achieve it is a worse failure than the
 * one being prevented. A dropped check is logged, never hidden.
 */
export async function requestFileLockFromApp(input: { path: string; conversationId: string | null }): Promise<{ holderConnectionId: string; heldSince: string } | null> {
  const appUrl = process.env.OATHLOCK_APP_URL?.trim();
  const agentToken = process.env.OATHLOCK_AGENT_TOKEN?.trim();
  if (!appUrl || !agentToken) return null;
  try {
    const res = await fetch(`${appUrl.replace(/\/$/, "")}/api/bridge/file-locks`, {
      method: "POST",
      headers: { authorization: `Bearer ${agentToken}`, "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; conflict?: { holderConnectionId?: string; heldSince?: string } };
    if (body.ok === false && body.conflict?.holderConnectionId) {
      return { holderConnectionId: body.conflict.holderConnectionId, heldSince: String(body.conflict.heldSince ?? "") };
    }
    return null;
  } catch (error) {
    console.error(`Could not check the file lock for ${input.path}: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

export class AcpStdioProviderAdapter implements InteractiveProviderAdapter {
  readonly id: string;
  private readonly command: string;
  private readonly args: readonly string[];
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly permissionTimeoutMs: number;
  private readonly promptTimeoutMs: number;
  private readonly maxReadBytes: number;
  private readonly now: () => string;
  private readonly shell: boolean;
  private readonly serverEnv: AcpStdioAdapterOptions["serverEnv"];
  private readonly servers = new Map<string, ServerState>();

  constructor(options: AcpStdioAdapterOptions) {
    this.id = options.id;
    this.command = options.command;
    this.args = options.args ?? [];
    this.env = options.env ?? {};
    this.permissionTimeoutMs = options.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
    this.promptTimeoutMs = options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
    this.maxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
    this.now = options.now ?? (() => new Date().toISOString());
    this.shell = options.shell ?? false;
    this.serverEnv = options.serverEnv;
  }

  async discoverCapabilities(): Promise<InteractiveProviderCapabilities> {
    const capabilities: InteractiveProviderCapabilities = allCapabilitiesFalse();
    capabilities.interactive_session = true;
    capabilities.streaming_output = true;
    capabilities.cancellation = true;
    capabilities.usage_reporting = true;
    capabilities.tool_event_reporting = true;
    capabilities.approval_requests = true;
    capabilities.repository_editing = true;
    capabilities.file_event_reporting = true;
    capabilities.command_event_reporting = true;
    capabilities.permission_event_reporting = true;
    capabilities.mid_turn_steering = false;
    capabilities.plan_event_reporting = false;
    capabilities.terminal_event_reporting = false;
    return capabilities;
  }

  async launchServer(input: { assignment: ProviderAssignment; environment: { workingDirectory: string; kind: "disposable" | "shared" } }): Promise<AgentServerHandle> {
    if (!isAbsolute(input.environment.workingDirectory)) throw new Error("ACP Bridge requires an absolute worktree path.");
    const serverId = `acp-server-${randomUUID()}`;
    const serverEnv = this.serverEnv?.({
      assignment: input.assignment,
      workingDirectory: input.environment.workingDirectory,
    }) ?? {};
    // Node deprecates (DEP0190) passing a separate args array alongside
    // shell: true -- with a shell, args are concatenated into the shell
    // command line unescaped, so a non-empty args array is a footgun even
    // when (as here) every element is a fixed literal, never user input.
    // Fold command+args into the single command string a shell expects
    // instead, and pass an empty args array, so the shell path stays
    // exactly as capable (still resolves opencode's Windows .cmd shim) but
    // without the deprecated shape.
    const [spawnCommand, spawnArgs] = this.shell
      ? [[this.command, ...this.args].join(" "), []]
      : [this.command, [...this.args]];
    const child = spawn(spawnCommand, spawnArgs, {
      cwd: input.environment.workingDirectory,
      env: { ...process.env, ...this.env, ...serverEnv },
      shell: this.shell,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    const handle: AgentServerHandle = { serverId, adapterId: this.id };
    const state: ServerState = {
      handle,
      child,
      workingDirectory: input.environment.workingDirectory,
      connection: null,
      initialized: null,
      sessions: new Map(),
      stderrTail: "",
      closed: false,
      deniedFilePatterns: (input.assignment.deniedFilePatterns ?? []).filter((pattern) => pattern.trim().length > 0),
    };
    child.stderr.on("data", (chunk: Buffer | string) => {
      state.stderrTail = `${state.stderrTail}${chunk.toString()}`.slice(-4_096);
    });
    child.once("exit", (code, signal) => {
      state.closed = true;
      // Closing the queue with no terminal event was previously
      // indistinguishable from a turn that simply produced no channel
      // result -- bridge-runtime.ts's `for await` loop just ends, no
      // provider.failed ever fires, and a crashed provider gets reported to
      // the human as "The bridge did not observe a provider failure," which
      // is actively misleading about what happened. Push the real reason
      // before closing so the fallback message names an actual crash.
      for (const session of state.sessions.values()) {
        session.queue?.push({
          type: "provider.failed",
          sessionId: session.handle.sessionId,
          occurredAt: this.now(),
          payload: { reason: `Provider process exited (code ${code ?? "null"}, signal ${signal ?? "null"}) mid-turn.` },
        });
        session.queue?.close();
      }
    });
    // A spawn failure (ENOENT, EACCES, ...) on ANY adapter used to crash
    // this whole bridge process -- Node throws an unhandled 'error' event
    // by default when nothing listens for it. Confirmed live: one provider
    // binary not being found on this machine took down every other live
    // session this bridge was running too. Now it just fails this one
    // server the same way a normal exit does.
    child.on("error", (error) => {
      state.stderrTail = `${state.stderrTail}spawn failed: ${error instanceof Error ? error.message : String(error)}`.slice(-4_096);
      state.closed = true;
      for (const session of state.sessions.values()) {
        session.queue?.push({
          type: "provider.failed",
          sessionId: session.handle.sessionId,
          occurredAt: this.now(),
          payload: { reason: `Provider process error: ${error instanceof Error ? error.message : String(error)}` },
        });
        session.queue?.close();
      }
    });
    this.servers.set(serverId, state);
    return handle;
  }

  getServerHealth(handle: AgentServerHandle): AgentServerHealth {
    const state = this.servers.get(handle.serverId);
    if (!state) return { state: "unknown", detail: "ACP server is not known to this adapter instance." };
    if (state.closed || state.child.exitCode !== null || state.child.killed) {
      return { state: "dead", detail: state.stderrTail || "ACP provider process exited." };
    }
    return { state: "alive", detail: "ACP provider process is running." };
  }

  async initialize(handle: AgentServerHandle): Promise<InitializedAgent> {
    const state = this.server(handle);
    if (state.connection && state.initialized) return this.initializedAgent(state.initialized);
    const client = {
      requestPermission: (params: acp.RequestPermissionRequest) => this.requestPermission(state, params),
      readTextFile: (params: acp.ReadTextFileRequest) => this.readTextFile(state, params),
      writeTextFile: (params: acp.WriteTextFileRequest) => this.writeTextFile(state, params),
      sessionUpdate: (params: acp.SessionNotification) => this.sessionUpdate(state, params),
    };
    const stdin = Writable.toWeb(state.child.stdin) as unknown as WritableStream<Uint8Array>;
    const stdout = Readable.toWeb(state.child.stdout) as unknown as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(stdin, stdout);
    const connection = new acp.ClientSideConnection(() => client, stream);
    const initialized = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, plan: {} },
      clientInfo: { name: "oathlock-bridge", version: "1.0.0" },
    });
    state.connection = connection;
    state.initialized = initialized;
    return this.initializedAgent(initialized);
  }

  async createSession(input: { server: AgentServerHandle; assignment: ProviderAssignment; executionId?: string }): Promise<AgentSessionHandle> {
    const state = this.server(input.server);
    const connection = this.connection(state);
    // Claude Code's ACP wrapper accepts a custom system-prompt append at
    // session creation (_meta.systemPrompt, confirmed in the installed
    // @agentclientprotocol/claude-agent-acp package) -- a real, persistent,
    // set-once mechanism, not re-sent every turn. Codex and OpenCode's ACP
    // wrappers expose no equivalent in the currently installed versions
    // (checked directly, not assumed), so their active rules still go
    // through per-turn prompt injection (buildWorkspaceTurnPrompt) instead.
    const rulesText = input.assignment.activeRulesText?.trim();
    // Item #16 Part A: appended AFTER rules, deliberately -- rules are
    // governance and must win any conflict with style/tone guidance, so
    // persona goes second in the combined append text.
    const personaText = input.assignment.personaText?.trim();
    const systemPromptAppend = [rulesText, personaText].filter(Boolean).join("\n\n") || null;
    const isClaudeAgentAcp = input.server.adapterId === "claude-agent-acp";
    const meta = isClaudeAgentAcp
      ? {
          ...(systemPromptAppend ? { systemPrompt: { append: systemPromptAppend } } : {}),
          // The Claude Agent SDK ships its own native cross-session
          // `SendMessage` tool (the same one this Claude Code harness itself
          // uses to talk to teammates) -- confirmed live: a session asked to
          // "ask @codex" reached for that tool instead of the real
          // OathLock `send_message` MCP tool (near-identical name, and the
          // request genuinely reads as a cross-agent-messaging task), got
          // its own generic "no agent named ... is reachable" failure since
          // no such local SDK teammate exists, and reported that honestly
          // as if it were an OathLock error. Disabling it removes the
          // ambiguity at the source instead of trying to out-word it in a
          // tool description -- send_message is the only way to reach
          // another OathLock-connected agent, so there is nothing lost.
          // claudeCode.options.disallowedTools confirmed against the
          // installed @agentclientprotocol/claude-agent-acp package, not
          // assumed from the SDK's own (unrelated) direct-query option shape.
          claudeCode: { options: { disallowedTools: ["SendMessage"] } },
        }
      : undefined;
    const created = await connection.newSession({
      cwd: state.workingDirectory,
      mcpServers: devMcpServerDescriptor(state.workingDirectory, input.assignment.missionId),
      ...(meta ? { _meta: meta } : {}),
    });
    await this.applyModelOverride(connection, created, input.assignment.model);
    await this.enforceGovernedPermissionMode(connection, created.sessionId, created);
    return this.registerSession(state, created.sessionId, input.executionId ?? created.sessionId, input.assignment.missionId, this.discoveredModelOptions(created));
  }

  /**
   * There is no CLI flag for this -- Codex and Claude Code are launched
   * through ACP wrapper packages (providerEntry below), not the raw CLI, and
   * confirmed live tonight that neither wrapper reads the underlying
   * provider's own local config file for its model choice either (editing
   * ~/.codex/config.toml's `model` field and restarting the bridge made no
   * difference). The real, protocol-level lever is a session config option
   * with category "model", returned in newSession's response and set via
   * session/set_config -- so that's what this does. Best-effort by design:
   * an agent whose ACP server doesn't expose a "model" config option (or
   * doesn't have the requested value available) must not have its session
   * blocked over this, only lose the override.
   */
  /**
   * The Claude wrapper starts sessions in whatever `permissions.defaultMode` the user's own settings
   * name. `bypassPermissions` never calls requestPermission, so M9R's deny-list, file locks and
   * human approvals would silently not apply. Put the session back in `default` and say so.
   */
  private async enforceGovernedPermissionMode(connection: acp.ClientSideConnection, sessionId: string, response: { modes?: { currentModeId?: string } | null } | null | undefined): Promise<void> {
    if (!shouldResetPermissionMode(response?.modes?.currentModeId)) return;
    try {
      await connection.setSessionMode({ sessionId, modeId: "default" });
      console.warn(`[permission-mode] session ${sessionId} started in bypassPermissions from the user's settings; reset to "default" so M9R approvals and the deny-list apply.`);
    } catch (error) {
      throw new Error(`Session ${sessionId} is in bypassPermissions and could not be reset to default, so M9R will not run it: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * The real, live model choices this session's own ACP server just
   * reported -- surfaced so the dashboard can render a real dropdown
   * (agent_connections.available_models) instead of a hardcoded, partially-
   * empty catalog or free text. Reuses the same flatten logic
   * applyModelOverride already needed (options is either a flat list, or
   * grouped "group" entries each carrying their own flat list -- never
   * mixed). Best-effort: an ACP server with no "model" config option
   * (or an empty one) yields null, never an invented list.
   */
  private discoveredModelOptions(created: acp.NewSessionResponse): { id: string; label: string }[] | null {
    const modelOption = created.configOptions?.find((option) => option.category === "model" && option.type === "select");
    if (!modelOption || modelOption.type !== "select") return null;
    const flatOptions = modelOption.options.flatMap((entry) => "group" in entry ? entry.options : [entry]);
    if (flatOptions.length === 0) return null;
    return flatOptions.map((choice) => ({ id: choice.value, label: choice.name || choice.value }));
  }

  private async applyModelOverride(connection: acp.ClientSideConnection, created: acp.NewSessionResponse, model: string | null | undefined): Promise<void> {
    const wanted = model?.trim();
    if (!wanted) return;
    const modelOption = created.configOptions?.find((option) => option.category === "model" && option.type === "select");
    if (!modelOption || modelOption.type !== "select") {
      console.warn(`[model-override] session ${created.sessionId} has no "model" config option; ignoring requested model "${wanted}".`);
      return;
    }
    // `options` is either a flat list, or grouped ("group" entries each
    // carrying their own flat option list) -- never mixed. Flatten both
    // shapes into one list before searching.
    const flatOptions = modelOption.options.flatMap((entry) => "group" in entry ? entry.options : [entry]);
    const match = flatOptions.find((choice) => choice.value === wanted || choice.name === wanted);
    if (!match) {
      console.warn(`[model-override] session ${created.sessionId}: requested model "${wanted}" is not in this agent's available options (${flatOptions.map((choice) => choice.value).join(", ")}); ignoring.`);
      return;
    }
    try {
      await connection.setSessionConfigOption({ sessionId: created.sessionId, configId: modelOption.id, value: match.value });
      console.log(`[model-override] session ${created.sessionId}: set model to "${match.value}".`);
    } catch (error) {
      console.warn(`[model-override] session ${created.sessionId}: setSessionConfigOption failed, continuing without the override:`, error instanceof Error ? error.message : error);
    }
  }

  async resumeSession(input: { server: AgentServerHandle; providerSessionRef: string; assignment: ProviderAssignment; executionId?: string }): Promise<AgentSessionHandle> {
    const state = this.server(input.server);
    const connection = this.connection(state);
    // Same disallowedTools reasoning as createSession above -- a resumed
    // session whose fingerprint (cwd/mcpServers/_meta) changed from what's
    // cached gets torn down and recreated by the wrapper, in which case this
    // _meta is what actually takes effect; an unchanged session returns the
    // cached one, whose _meta was already set at its original creation.
    const meta = input.server.adapterId === "claude-agent-acp"
      ? { _meta: { claudeCode: { options: { disallowedTools: ["SendMessage"] } } } }
      : {};
    const resumed = await connection.resumeSession({ sessionId: input.providerSessionRef, cwd: state.workingDirectory, mcpServers: devMcpServerDescriptor(state.workingDirectory, input.assignment.missionId), ...meta });
    await this.enforceGovernedPermissionMode(connection, input.providerSessionRef, resumed);
    return this.registerSession(state, input.providerSessionRef, input.executionId ?? input.providerSessionRef, input.assignment.missionId);
  }

  async *prompt(input: { session: AgentSessionHandle; text: string }): AsyncIterable<InteractiveProviderEvent> {
    const { state, session } = this.session(input.session);
    if (session.queue) throw new Error("ACP session already has an active prompt.");
    const queue = new AsyncEventQueue<InteractiveProviderEvent>();
    session.queue = queue;
    const prompt = this.connection(state).prompt({ sessionId: session.rawSessionId, prompt: [{ type: "text", text: input.text.slice(0, 32_000) }] });
    // settled guards against the timeout and a late real response racing
    // each other -- only the first to happen may push/close the queue.
    let settled = false;
    const timeoutHandle = setTimeout(() => {
      if (settled) return;
      settled = true;
      queue.push({ type: "provider.failed", sessionId: session.handle.sessionId, occurredAt: this.now(), payload: { reason: `Provider did not respond within ${this.promptTimeoutMs}ms; the turn was abandoned.` } });
      queue.close();
      // Best-effort: tell the provider to actually stop, not just let this
      // caller stop listening. Never let a cancel failure mask the timeout
      // itself, which is already reported above.
      void this.connection(state).cancel({ sessionId: session.rawSessionId }).catch(() => undefined);
    }, this.promptTimeoutMs);
    void prompt.then((result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      const usage = mapAcpUsageEvent({ sessionId: session.handle.sessionId, usage: result.usage, occurredAt: this.now(), usageBasis: "prompt_turn" });
      if (usage) session.queue?.push(usage);
      queue.push({ type: "provider.completed", sessionId: session.handle.sessionId, occurredAt: this.now(), payload: { stopReason: result.stopReason } });
      queue.close();
    }).catch((error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      // The ACP protocol error itself is often a generic wrapper ("Internal
      // error") with no detail -- confirmed live: Codex reported a real,
      // actionable reason (a usage-limit message naming the exact reset
      // date) as the RequestError's own `.data` field, and this used to
      // read only `.message`, so the human saw nothing but "Internal
      // error" for something Codex had already explained precisely.
      // RequestError.data is arbitrary per-provider content (jsonrpc.js),
      // so read it defensively: a string is used as-is, an object with its
      // own `.message` (the shape Codex sends) is preferred over generic
      // sub-fields, and a real API error frequently has neither and instead
      // has its detail in the process's own stderr -- append that too when
      // present rather than choosing one source over the other.
      const rpcMessage = boundedText(error instanceof Error ? error.message : error, 1_024);
      let dataDetail: string | null = null;
      const errorData = error instanceof Object && "data" in error ? (error as { data?: unknown }).data : undefined;
      if (typeof errorData === "string" && errorData.trim()) {
        dataDetail = errorData.trim();
      } else if (errorData && typeof errorData === "object") {
        const dataRecord = errorData as Record<string, unknown>;
        if (typeof dataRecord.message === "string" && dataRecord.message.trim()) dataDetail = dataRecord.message.trim();
      }
      const stderrSnippet = state.stderrTail.trim();
      const parts = [dataDetail && dataDetail !== rpcMessage ? dataDetail : rpcMessage];
      if (dataDetail && dataDetail !== rpcMessage) parts.push(`(${rpcMessage})`);
      if (stderrSnippet) parts.push(`-- provider stderr: ${boundedText(stderrSnippet, 1_024)}`);
      const reason = boundedText(parts.join(" ").trim(), 2_048);
      queue.push({ type: "provider.failed", sessionId: session.handle.sessionId, occurredAt: this.now(), payload: { reason } });
      queue.close();
    });
    try {
      for await (const event of queue) yield event;
    } finally {
      clearTimeout(timeoutHandle);
      session.queue = null;
    }
  }

  async cancelTurn(input: { session: AgentSessionHandle }): Promise<void> {
    const { state, session } = this.session(input.session);
    // Live-caught: this used to just send the real ACP cancel() RPC and
    // await the provider's response -- which depends on the same process
    // that a caller is cancelling BECAUSE it stopped responding. For a
    // truly dead/hung provider (not merely slow), that await never
    // resolves, `session.queue` (see AsyncEventQueue above) never gets
    // closed, and every consumer stuck in a `for await` over it -- all the
    // way up through AcpSessionController.prompt()'s own for-await in
    // acp-client.ts -- can never reach the `finally` that resets
    // `session.queue = null`. That's what produced "ACP session already has
    // an active prompt" on the very next turn for that session, even after
    // the caller had already given up on the stalled one and moved on.
    // Racing the real RPC against a bounded fallback that force-closes the
    // queue directly means a healthy cancel still gets its clean ACP
    // "cancelled" stopReason (the queue closes naturally, via the provider's
    // own prompt.then()/.catch() handlers, before this fallback fires), while
    // a truly dead provider's session still gets unstuck for the next turn
    // instead of being wedged forever. `close()` is idempotent (checks
    // `this.closed` first), so it's harmless if the real cancel does
    // complete a moment later.
    const realCancel = this.connection(state).cancel({ sessionId: session.rawSessionId }).catch((error: unknown) => {
      console.error(`[acp-stdio-adapter] cancel() RPC failed for session ${session.handle.sessionId}:`, error instanceof Error ? error.message : error);
    });
    const forceUnblock = new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        if (session.queue) console.error(`[acp-stdio-adapter] session ${session.handle.sessionId} did not acknowledge cancel within 10s -- force-closing its event queue so the next turn is not blocked behind a dead provider.`);
        session.queue?.close();
        resolve();
      }, 10_000);
      t.unref?.();
    });
    await Promise.race([realCancel, forceUnblock]);
  }

  async respondToPermission(input: { session: AgentSessionHandle; requestId: string; approved: boolean }): Promise<void> {
    const { session } = this.session(input.session);
    const permission = session.permissions.get(input.requestId);
    if (!permission) throw new Error("ACP permission request is unknown or expired.");
    if (permission.settled) throw new Error("ACP permission request has already been resolved.");
    permission.settled = true;
    permission.approved = input.approved;
    permission.resolve(responseForPermission(permission.params, input.approved));
  }

  async closeSession(input: { session: AgentSessionHandle }): Promise<void> {
    const { state, session } = this.session(input.session);
    if (state.initialized?.agentCapabilities?.sessionCapabilities?.close) {
      await this.connection(state).closeSession({ sessionId: session.rawSessionId });
    } else {
      await this.connection(state).cancel({ sessionId: session.rawSessionId });
    }
    session.queue?.close();
    state.sessions.delete(session.handle.sessionId);
  }

  async shutdown(handle: AgentServerHandle): Promise<void> {
    const state = this.servers.get(handle.serverId);
    if (!state) return;
    state.closed = true;
    for (const session of [...state.sessions.values()]) {
      session.queue?.close();
      state.sessions.delete(session.handle.sessionId);
    }
    if (state.child.exitCode === null && !state.child.killed) {
      state.child.kill();
      await new Promise<void>((resolveExit) => {
        const timeout = setTimeout(resolveExit, 5_000);
        state.child.once("exit", () => { clearTimeout(timeout); resolveExit(); });
      });
    }
    this.servers.delete(handle.serverId);
  }

  private server(handle: AgentServerHandle): ServerState {
    const state = this.servers.get(handle.serverId);
    if (!state || state.closed) throw new Error("ACP server is not active.");
    return state;
  }

  private connection(state: ServerState): acp.ClientSideConnection {
    if (!state.connection) throw new Error("ACP server is not initialized.");
    return state.connection;
  }

  private initializedAgent(initialized: acp.InitializeResponse): InitializedAgent {
    const capabilities: ProviderCapabilities = allCapabilitiesFalse();
    capabilities.interactive_session = true;
    capabilities.streaming_output = true;
    capabilities.cancellation = true;
    capabilities.session_resume = initialized.agentCapabilities?.sessionCapabilities?.resume != null;
    capabilities.usage_reporting = true;
    capabilities.tool_event_reporting = true;
    capabilities.approval_requests = true;
    capabilities.repository_editing = true;
    const interactive: InteractiveProviderCapabilities = {
      ...capabilities,
      file_event_reporting: true,
      command_event_reporting: true,
      plan_event_reporting: false,
      terminal_event_reporting: false,
      permission_event_reporting: true,
    };
    return {
      protocolVersion: String(initialized.protocolVersion),
      agentName: initialized.agentInfo?.name ?? this.id,
      capabilities: interactive,
    };
  }

  private registerSession(state: ServerState, rawSessionId: string, executionId: string, missionId: string, availableModels: { id: string; label: string }[] | null = null): AgentSessionHandle {
    const handle: AgentSessionHandle = { sessionId: `acp-session-${randomUUID()}`, providerSessionRef: rawSessionId, availableModels };
    state.sessions.set(handle.sessionId, { handle, rawSessionId, queue: null, permissions: new Map(), executionId, missionId });
    return handle;
  }

  private session(handle: AgentSessionHandle): { state: ServerState; session: SessionState } {
    for (const state of this.servers.values()) {
      const session = state.sessions.get(handle.sessionId);
      if (session) return { state, session };
    }
    throw new Error("ACP session is not active.");
  }

  private async sessionUpdate(state: ServerState, params: acp.SessionNotification): Promise<void> {
    const session = [...state.sessions.values()].find((candidate) => candidate.rawSessionId === params.sessionId);
    if (!session || !session.queue) return;
    const occurredAt = this.now();
    const update = record(params.update);
    // Root cause of "Turn completed, but no channel result was posted": the
    // model's actual prose answer arrives as agent_message_chunk, and until
    // this branch existed it matched neither the usage_update check below
    // nor mapAcpSessionUpdate (which only recognizes tool_call/
    // tool_call_update -- see its own doc comment). It fell through both and
    // was discarded with no trace. The bridge only ever got a reply into the
    // channel when the model happened to call the send_message tool itself;
    // a model that just answers normally, which is the default behavior,
    // had its entire response thrown away. bridge-runtime.ts accumulates
    // these chunks per turn and posts them as the real fallback body instead
    // of the old generic "no channel result" text.
    if (update?.sessionUpdate === "agent_message_chunk") {
      const content = record(update.content);
      const text = content?.type === "text" && typeof content.text === "string" ? content.text : null;
      if (text) {
        session.queue.push({
          type: "provider.reply_text",
          sessionId: session.handle.sessionId,
          occurredAt,
          payload: { text },
        });
      }
      return;
    }
    if (update?.sessionUpdate === "usage_update") {
      const event = usageEvent({ sessionId: session.handle.sessionId, update, occurredAt });
      if (event) session.queue.push(event);
      return;
    }
    // ACP's native `plan` update -- the literal checklist mechanism, not
    // something inferred from tool-call traffic. claude-agent-acp converts
    // its own TodoWrite calls into exactly this (its planEntries()), and
    // ACP's contract is that each update carries the COMPLETE entry list and
    // replaces the previous plan wholesale, which is why the event below
    // carries the whole array rather than a delta.
    if (update?.sessionUpdate === "plan") {
      const entries = planEntries(update.entries);
      // An empty/unusable plan is not a plan -- pushing it would blank a
      // checklist a human is currently reading over a malformed frame.
      if (entries.length > 0) {
        session.queue.push({
          type: "provider.plan",
          sessionId: session.handle.sessionId,
          occurredAt,
          payload: { entries },
        });
      }
      return;
    }
    const event = mapAcpSessionUpdate({ sessionId: session.handle.sessionId, update: params.update, occurredAt, repositoryRoot: state.workingDirectory });
    if (event) {
      if (event.payload && typeof event.payload === "object" && "activityKind" in event.payload) {
        if (event.payload.activityKind === "file.read" || event.payload.activityKind === "file.changed") {
          // Capability is runtime-observed, not assumed during initialization.
        }
      }
      session.queue.push(event);
    }
  }

  private async requestPermission(state: ServerState, params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const session = [...state.sessions.values()].find((candidate) => candidate.rawSessionId === params.sessionId);
    if (!session) return { outcome: { outcome: "cancelled" } };
    const requestId = `permission-${randomUUID()}`;
    // Same absolute-path relativization the file-activity path already
    // needed (see workspaceRelativeAcpPath's own doc comment) -- without
    // repositoryRoot here, this filePath (and therefore both the deny-list
    // check below and the human-facing approval card) went null for every
    // OpenCode permission request, same bug, different call site.
    const filePath = workspaceRelativeAcpPath(rawPath(record(params.toolCall) ?? {}), state.workingDirectory);
    const command = rawCommand(record(params.toolCall) ?? {});
    // Policy deny-list, checked BEFORE a human is ever asked -- a matching
    // path is refused outright, not surfaced as a pending approval card at
    // all. Checked two ways, live-caught as both necessary: a structured
    // edit tool call always carries filePath directly, but a shell command
    // (which OpenCode in particular reaches for constantly) carries only a
    // command string -- see commandTouchesDeniedPath's own doc comment for
    // why that needs its own, separate check, not a filePath fallback.
    // See ownDeniedFilePatterns' doc comment (bridge-runtime.ts) for why
    // absence of any pattern means no restriction, never a lockout.
    const deniedPattern = (filePath ? state.deniedFilePatterns.find((pattern) => matchesDenyPattern(filePath, pattern)) : undefined)
      ?? (command ? commandTouchesDeniedPath(command, state.deniedFilePatterns) ?? undefined : undefined);
    if (deniedPattern) {
      session.queue?.push({
        type: "provider.activity",
        sessionId: session.handle.sessionId,
        occurredAt: this.now(),
        payload: {
          type: "provider.activity",
          activityKind: "permission.requested",
          status: "failed",
          summary: `Denied by file-permission policy: ${filePath ?? command} matches "${deniedPattern}"`,
          filePath,
          command,
          testName: null,
          testPassed: null,
          testFailed: null,
          testSkipped: null,
          reviewTarget: null,
          gitRef: null,
          requestId: `permission-${randomUUID()}`,
        },
      });
      return responseForPermission(params, false);
    }
    // Real file locking (item 4): only edit-shaped calls with a resolved path
    // are gated. Reads never pay this round-trip, and a shell command isn't
    // gated either -- its target path isn't reliably knowable from the command
    // string, and guessing wrong would either block legitimate work or give
    // false confidence. That gap is real and stated, not papered over.
    const toolCallKind = toolKind(field(params.toolCall, "kind"));
    if (toolCallKind === "changed" && filePath) {
      const conflict = await requestFileLockFromApp({
        path: filePath,
        conversationId: conversationIdForChannelMission(session.missionId),
      });
      if (conflict) {
        session.queue?.push({
          type: "provider.activity",
          sessionId: session.handle.sessionId,
          occurredAt: this.now(),
          payload: {
            type: "provider.activity",
            activityKind: "permission.requested",
            status: "failed",
            summary: `${filePath} is being edited by another agent right now — not overwriting it.`,
            filePath,
            command,
            testName: null,
            testPassed: null,
            testFailed: null,
            testSkipped: null,
            reviewTarget: null,
            gitRef: null,
            requestId: `permission-${randomUUID()}`,
          },
        });
        return responseForPermission(params, false);
      }
    }
    const permissionEvent: InteractiveProviderEvent = {
      type: "provider.activity",
      sessionId: session.handle.sessionId,
      occurredAt: this.now(),
      payload: {
        type: "provider.activity",
        activityKind: "permission.requested",
        status: "waiting",
        // Same reasoning as the activity summary above: this is the title a
        // human reads to decide approve/deny, not a transcript that might
        // leak a credential -- don't let the entropy heuristic blank it.
        summary: boundedText(field(params.toolCall, "title") ?? "Provider permission requested", 2_048, { includeHeuristics: false }),
        filePath,
        command,
        testName: null,
        testPassed: null,
        testFailed: null,
        testSkipped: null,
        reviewTarget: null,
        gitRef: null,
        requestId,
      },
    };
    session.queue?.push(permissionEvent);
    void reportPendingPermissionToApp({
      missionId: session.missionId,
      executionId: session.executionId,
      requestId,
      summary: String(permissionEvent.payload.summary),
      command: permissionEvent.payload.command as string | null,
      filePath: permissionEvent.payload.filePath as string | null,
    });
    return new Promise((resolvePermission) => {
      const permission: PermissionRecord = { requestId, params, approved: false, consumed: false, settled: false, resolve: resolvePermission };
      session.permissions.set(requestId, permission);
      setTimeout(() => {
        if (session.permissions.get(requestId) !== permission) return;
        session.permissions.delete(requestId);
        permission.settled = true;
        resolvePermission({ outcome: { outcome: "cancelled" } });
      }, this.permissionTimeoutMs);
    });
  }

  private async readTextFile(state: ServerState, params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    const path = pathWithinRoot(state.workingDirectory, params.path);
    const content = await fs.readFile(path, "utf8");
    if (Buffer.byteLength(content, "utf8") > this.maxReadBytes) throw new Error("ACP file exceeds the bounded read size.");
    const lines = content.split(/\r?\n/);
    const start = Math.max(0, (params.line ?? 1) - 1);
    const selected = params.limit == null ? lines.slice(start) : lines.slice(start, start + Math.max(0, params.limit));
    return { content: selected.join("\n") };
  }

  private async writeTextFile(state: ServerState, params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
    const path = pathWithinRoot(state.workingDirectory, params.path);
    const matches = [...state.sessions.values()]
      .flatMap((session) => [...session.permissions.values()])
      .filter((candidate) => candidate.approved && !candidate.consumed && !candidate.settled && pathMatchesPermission(candidate.params, path, state.workingDirectory));
    if (matches.length !== 1) throw new Error("ACP write requires exactly one approved, path-scoped permission.");
    const permission = matches[0];
    permission.consumed = true;
    await fs.writeFile(path, params.content, "utf8");
    return {};
  }
}

function providerEntry(provider: "codex" | "claude"): string {
  const pkg = provider === "codex" ? "@agentclientprotocol/codex-acp" : "@agentclientprotocol/claude-agent-acp";
  // Resolve from where this code is installed, not from the process's working directory:
  // the packaged CLI runs inside the user's own repo, which has no such node_modules.
  try {
    return resolve(dirname(require.resolve(`${pkg}/package.json`)), "dist/index.js");
  } catch {
    return resolve(process.cwd(), `node_modules/${pkg}/dist/index.js`);
  }
}

/**
 * `codex-acp` falls back to the Codex binary bundled inside its own npm
 * package when CODEX_PATH is absent. On Windows that bundle does not share
 * the authentication state of a user's installed Codex CLI, so a perfectly
 * healthy desktop/CLI session can look unauthenticated to M9R. Prefer the
 * installed npm shim when it exists; an explicit CODEX_PATH always wins.
 */
export function codexAcpServerEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform = process.platform,
  pathExists: (path: string) => boolean = existsSync,
): Record<string, string> {
  const explicit = env.CODEX_PATH?.trim();
  if (explicit) return { CODEX_PATH: explicit };
  if (platform !== "win32") return {};
  const appData = env.APPDATA?.trim();
  if (!appData) return {};
  const npmCodexShim = resolve(appData, "npm", "codex.cmd");
  return pathExists(npmCodexShim) ? { CODEX_PATH: npmCodexShim } : {};
}

export function createCodexAcpAdapter(options: Partial<Omit<AcpStdioAdapterOptions, "id" | "command" | "args">> = {}): AcpStdioProviderAdapter {
  return new AcpStdioProviderAdapter({
    id: "codex-acp",
    command: process.execPath,
    args: [providerEntry("codex")],
    serverEnv: () => codexAcpServerEnv(),
    ...options,
  });
}

export function createClaudeAcpAdapter(options: Partial<Omit<AcpStdioAdapterOptions, "id" | "command" | "args">> = {}): AcpStdioProviderAdapter {
  return new AcpStdioProviderAdapter({ id: "claude-agent-acp", command: process.execPath, args: [providerEntry("claude")], ...options });
}

/**
 * Codex and Claude Code don't speak ACP natively, so they're launched
 * through a dedicated wrapper package (providerEntry above), via
 * process.execPath + a real .js file -- no shell needed. OpenCode is
 * different -- it implements ACP itself (`opencode acp` starts it as a real
 * ACP server over stdio, confirmed against `opencode --help`), so this
 * spawns the real `opencode` binary directly, no wrapper package needed.
 * shell: true is required here specifically: an npm-global install of
 * opencode is a .cmd shim on Windows, and spawn() without a shell doesn't
 * do the PATHEXT resolution a real shell does -- confirmed live, this
 * failed with ENOENT even though `opencode acp` runs fine typed directly
 * into a terminal. args stay a fixed literal (["acp"]), never
 * user-controlled, so there's no shell-injection surface here.
 */
export function createOpenCodeAcpAdapter(options: Partial<Omit<AcpStdioAdapterOptions, "id" | "command" | "args">> = {}): AcpStdioProviderAdapter {
  return new AcpStdioProviderAdapter({
    id: "opencode-acp",
    command: "opencode",
    args: ["acp"],
    shell: true,
    serverEnv: ({ assignment, workingDirectory }) => {
      const content = openCodeConfigContent(workingDirectory, assignment.missionId);
      return content ? { OPENCODE_CONFIG_CONTENT: content } : {};
    },
    ...options,
  });
}

/**
 * Generic ACP adapter for a provider that is not bundled with OathLock.
 *
 * The adapter deliberately reuses the same bounded ACP implementation as the
 * first-party providers. OathLock does not guess a provider's binary or claim
 * provider-specific features; the operator supplies an approved local
 * adapter.json and the generic protocol provides messaging, permissions,
 * activity, usage, and evidence routing.
 */
export function createGenericAcpAdapter(
  config: ProviderAdapterConfig,
  options: Partial<Omit<AcpStdioAdapterOptions, "id" | "command" | "args" | "shell">> = {},
): AcpStdioProviderAdapter {
  if (config.protocol !== "acp-stdio") throw new Error("The generic ACP adapter requires an acp-stdio configuration.");
  return new AcpStdioProviderAdapter({
    id: providerAdapterId(config.provider),
    command: config.command,
    args: config.args,
    shell: config.shell,
    ...options,
  });
}
