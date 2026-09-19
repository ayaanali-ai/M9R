import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ProviderAssignment } from "@/lib/mission/mission-provider-adapter";
import { allCapabilitiesFalse } from "@/lib/mission/mission-provider-adapter";
import { redactSession } from "@/lib/session-redaction";
import {
  commandTouchesDeniedPath,
  conversationIdForChannelMission,
  matchesDenyPattern,
  reportPendingPermissionToApp,
  requestFileLockFromApp,
  workspaceRelativeAcpPath,
} from "./acp-stdio-adapter";
import { CodexAppServerClient, CodexRpcError } from "./codex-app-server-client";
import type {
  AgentServerHandle,
  AgentServerHealth,
  AgentSessionHandle,
  InitializedAgent,
  InteractiveProviderAdapter,
  InteractiveProviderCapabilities,
  InteractiveProviderEvent,
} from "./interactive-provider-adapter";

/**
 * Codex through its own `codex app-server` (JSONL over stdio) instead of the ACP wrapper. The
 * difference that matters: threads are real Codex threads, and the protocol has native
 * turn/steer, turn/interrupt and approval requests. Same governance as the ACP adapter (deny-list,
 * file locks, human approval) and the same event shapes, so the bridge does not change.
 */

const DEFAULT_PERMISSION_TIMEOUT_MS = 15 * 60 * 1_000;
const DEFAULT_PROMPT_TIMEOUT_MS = 20 * 60 * 1_000;
const CANCEL_FORCE_CLOSE_MS = 10_000;
const MAX_PROMPT_CHARS = 32_000;

type Outcome = "accept" | "decline" | "cancel";
type ApprovalKind = "command" | "file" | "permissions" | "legacy-exec" | "legacy-patch";

interface PermissionRecord {
  requestId: string;
  approved: boolean;
  settled: boolean;
  resolve: (outcome: Outcome) => void;
}

interface SessionState {
  handle: AgentSessionHandle;
  threadId: string;
  queue: EventQueue | null;
  activeTurnId: string | null;
  permissions: Map<string, PermissionRecord>;
  executionId: string;
  missionId: string;
  /** Paths of fileChange items seen so far: a later approval request carries only the item id, so this is how it gets checked against the deny-list and file locks. */
  itemPaths: Map<string, string | null>;
  lastError: string | null;
  lastUsage: { inputTokens: number; outputTokens: number; totalTokens: number } | null;
}

interface ServerState {
  handle: AgentServerHandle;
  child: ChildProcessWithoutNullStreams;
  client: CodexAppServerClient;
  workingDirectory: string;
  sessions: Map<string, SessionState>;
  stderrTail: string;
  closed: boolean;
  deniedFilePatterns: string[];
  agentName: string;
  initialized: boolean;
}

class EventQueue {
  private readonly values: InteractiveProviderEvent[] = [];
  private readonly waiters: Array<(result: IteratorResult<InteractiveProviderEvent>) => void> = [];
  private closed = false;

  push(value: InteractiveProviderEvent): void {
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

  get isClosed(): boolean {
    return this.closed;
  }

  [Symbol.asyncIterator](): AsyncIterator<InteractiveProviderEvent> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ done: false, value });
        if (this.closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolveNext) => this.waiters.push(resolveNext));
      },
    };
  }
}

export interface CodexAppServerAdapterOptions {
  id?: string;
  command: string;
  args?: readonly string[];
  /** Needed for the Windows `codex.cmd` npm shim. */
  shell?: boolean;
  env?: NodeJS.ProcessEnv;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  /** How often Codex asks before acting. `on-request` (default) lets Codex decide; `untrusted` asks for anything not known to be safe. */
  approvalPolicy?: "untrusted" | "on-request";
  permissionTimeoutMs?: number;
  promptTimeoutMs?: number;
  requestTimeoutMs?: number;
  now?: () => string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown, max: number, includeHeuristics = true): string {
  return redactSession(typeof value === "string" ? value : String(value ?? ""), { includeHeuristics }).redactedText.slice(0, max);
}

function diffCounts(diff: unknown): { additions: number; deletions: number } | null {
  if (typeof diff !== "string") return null;
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

function activityStatus(status: unknown): "started" | "succeeded" | "failed" {
  if (status === "completed") return "succeeded";
  if (status === "failed" || status === "declined") return "failed";
  return "started";
}

function outcomeResponse(kind: ApprovalKind, outcome: Outcome, params: Record<string, unknown> | null): unknown {
  switch (kind) {
    case "command":
    case "file":
      // Never "acceptForSession": one approval is one action.
      return { decision: outcome };
    case "permissions":
      return outcome === "accept"
        ? { permissions: params?.permissions ?? {}, scope: "turn" }
        : { permissions: {}, scope: "turn" };
    case "legacy-exec":
    case "legacy-patch":
      return { decision: outcome === "accept" ? "approved" : outcome === "cancel" ? "abort" : { denied: { rejection: "Declined by M9R." } } };
  }
}

/**
 * On Windows the Codex npm shim runs through cmd.exe, so `child.kill()` only stops the shell and leaves `codex.exe
 * app-server` running, still holding its threads: the next server then cannot resume them ("already has an active
 * writer"). Kill the whole tree there.
 */
function killProcessTree(child: ChildProcessWithoutNullStreams): void {
  if (process.platform === "win32" && child.pid) {
    try {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      return;
    } catch {
      /* already gone, or taskkill unavailable: fall through to a plain kill */
    }
  }
  try { child.kill(); } catch { /* already exited */ }
}

/** The Windows npm shim needs a shell; everywhere else the plain binary name works. An explicit CODEX_PATH always wins. */
export function codexAppServerCommand(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  pathExists: (path: string) => boolean = existsSync,
): { command: string; shell: boolean } {
  const explicit = env.CODEX_PATH?.trim();
  if (explicit) return { command: explicit, shell: /\.(cmd|bat)$/i.test(explicit) };
  if (platform === "win32") {
    const appData = env.APPDATA?.trim();
    const shim = appData ? resolve(appData, "npm", "codex.cmd") : null;
    if (shim && pathExists(shim)) return { command: shim, shell: true };
    return { command: "codex", shell: true };
  }
  return { command: "codex", shell: false };
}

export class CodexAppServerAdapter implements InteractiveProviderAdapter {
  readonly id: string;
  private readonly servers = new Map<string, ServerState>();
  private readonly options: CodexAppServerAdapterOptions;
  private readonly now: () => string;

  constructor(options: CodexAppServerAdapterOptions) {
    this.options = options;
    this.id = options.id ?? "codex-app-server";
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async discoverCapabilities(): Promise<InteractiveProviderCapabilities> {
    const capabilities: InteractiveProviderCapabilities = allCapabilitiesFalse();
    capabilities.interactive_session = true;
    capabilities.streaming_output = true;
    capabilities.cancellation = true;
    capabilities.session_resume = true;
    capabilities.usage_reporting = true;
    capabilities.tool_event_reporting = true;
    capabilities.approval_requests = true;
    capabilities.repository_editing = true;
    capabilities.file_event_reporting = true;
    capabilities.command_event_reporting = true;
    capabilities.permission_event_reporting = true;
    capabilities.mid_turn_steering = true;
    capabilities.plan_event_reporting = false;
    capabilities.terminal_event_reporting = false;
    return capabilities;
  }

  async launchServer(input: { assignment: ProviderAssignment; environment: { workingDirectory: string; kind: "disposable" | "shared" } }): Promise<AgentServerHandle> {
    if (!isAbsolute(input.environment.workingDirectory)) throw new Error("The Codex app-server adapter requires an absolute working directory.");
    const serverId = `codex-server-${randomUUID()}`;
    const args = [...(this.options.args ?? [])];
    // With a shell, fold command and args into one string (same reason as the ACP adapter: DEP0190).
    const [spawnCommand, spawnArgs] = this.options.shell
      ? [[/\s/.test(this.options.command) ? `"${this.options.command}"` : this.options.command, ...args].join(" "), []]
      : [this.options.command, args];
    const child = spawn(spawnCommand, spawnArgs, {
      cwd: input.environment.workingDirectory,
      env: { ...process.env, ...this.options.env },
      shell: this.options.shell ?? false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    const handle: AgentServerHandle = { serverId, adapterId: this.id };
    const client = new CodexAppServerClient(child.stdin, child.stdout, this.options.requestTimeoutMs);
    const state: ServerState = {
      handle,
      child,
      client,
      workingDirectory: input.environment.workingDirectory,
      sessions: new Map(),
      stderrTail: "",
      closed: false,
      deniedFilePatterns: (input.assignment.deniedFilePatterns ?? []).filter((pattern) => pattern.trim().length > 0),
      agentName: "codex",
      initialized: false,
    };
    child.stderr.on("data", (chunk: Buffer | string) => {
      state.stderrTail = `${state.stderrTail}${chunk.toString()}`.slice(-4_096);
    });
    const failSessions = (reason: string) => {
      state.closed = true;
      client.fail(reason);
      for (const session of state.sessions.values()) {
        this.settleAllPermissions(session, "cancel");
        session.queue?.push({ type: "provider.failed", sessionId: session.handle.sessionId, occurredAt: this.now(), payload: { reason } });
        session.queue?.close();
      }
    };
    child.once("exit", (code, signal) => failSessions(`Provider process exited (code ${code ?? "null"}, signal ${signal ?? "null"}) mid-turn.`));
    child.on("error", (error) => {
      state.stderrTail = `${state.stderrTail}spawn failed: ${error.message}`.slice(-4_096);
      failSessions(`Provider process error: ${error.message}`);
    });
    client.setHandlers({
      notification: (method, params) => this.onNotification(state, method, params),
      serverRequest: (method, params) => this.onServerRequest(state, method, params),
    });
    this.servers.set(serverId, state);
    return handle;
  }

  getServerHealth(handle: AgentServerHandle): AgentServerHealth {
    const state = this.servers.get(handle.serverId);
    if (!state) return { state: "unknown", detail: "Codex app-server is not known to this adapter instance." };
    if (state.closed || state.child.exitCode !== null || state.child.killed) return { state: "dead", detail: state.stderrTail || "Codex app-server process exited." };
    return { state: "alive", detail: "Codex app-server process is running." };
  }

  async initialize(handle: AgentServerHandle): Promise<InitializedAgent> {
    const state = this.server(handle);
    if (!state.initialized) {
      const response = record(await state.client.request("initialize", { clientInfo: { name: "oathlock-bridge", title: "M9R Bridge", version: "1.0.0" }, capabilities: null }));
      state.client.notify("initialized");
      state.initialized = true;
      state.agentName = typeof response?.userAgent === "string" ? response.userAgent : "codex";
    }
    return { protocolVersion: "codex-app-server", agentName: state.agentName, capabilities: await this.discoverCapabilities() };
  }

  async createSession(input: { server: AgentServerHandle; assignment: ProviderAssignment; executionId?: string }): Promise<AgentSessionHandle> {
    const state = this.server(input.server);
    const response = record(await state.client.request("thread/start", {
      cwd: state.workingDirectory,
      approvalPolicy: this.options.approvalPolicy ?? "on-request",
      sandbox: this.options.sandbox ?? "workspace-write",
      serviceName: "m9r",
      ...(input.assignment.model ? { model: input.assignment.model } : {}),
    }));
    const thread = record(response?.thread);
    const threadId = typeof thread?.id === "string" ? thread.id : null;
    if (!threadId) throw new Error("Codex did not return a thread id.");
    return this.registerSession(state, threadId, input.executionId ?? threadId, input.assignment.missionId);
  }

  async resumeSession(input: { server: AgentServerHandle; providerSessionRef: string; assignment: ProviderAssignment; executionId?: string }): Promise<AgentSessionHandle> {
    const state = this.server(input.server);
    await state.client.request("thread/resume", {
      threadId: input.providerSessionRef,
      cwd: state.workingDirectory,
      approvalPolicy: this.options.approvalPolicy ?? "on-request",
      sandbox: this.options.sandbox ?? "workspace-write",
      ...(input.assignment.model ? { model: input.assignment.model } : {}),
    });
    return this.registerSession(state, input.providerSessionRef, input.executionId ?? input.providerSessionRef, input.assignment.missionId);
  }

  async *prompt(input: { session: AgentSessionHandle; text: string }): AsyncIterable<InteractiveProviderEvent> {
    const { state, session } = this.session(input.session);
    if (session.queue) throw new Error("Codex session already has an active prompt.");
    const queue = new EventQueue();
    session.queue = queue;
    session.lastError = null;
    const fail = (reason: string) => {
      queue.push({ type: "provider.failed", sessionId: session.handle.sessionId, occurredAt: this.now(), payload: { reason: text(reason, 2_048) } });
      queue.close();
    };
    const timeoutMs = this.options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
    const timeoutHandle = setTimeout(() => {
      if (queue.isClosed) return;
      fail(`Provider did not finish within ${timeoutMs}ms; the turn was abandoned.`);
      if (session.activeTurnId) void state.client.request("turn/interrupt", { threadId: session.threadId, turnId: session.activeTurnId }).catch(() => undefined);
    }, timeoutMs);
    timeoutHandle.unref?.();
    state.client.request("turn/start", { threadId: session.threadId, input: [{ type: "text", text: input.text.slice(0, MAX_PROMPT_CHARS), text_elements: [] }] })
      .then((response) => {
        const turnId = record(record(response)?.turn)?.id;
        if (typeof turnId === "string") session.activeTurnId = turnId;
      })
      .catch((error: unknown) => {
        const stderr = state.stderrTail.trim();
        fail(`${error instanceof Error ? error.message : String(error)}${stderr ? ` -- provider stderr: ${stderr.slice(-512)}` : ""}`);
      });
    try {
      for await (const event of queue) yield event;
    } finally {
      clearTimeout(timeoutHandle);
      session.queue = null;
      session.activeTurnId = null;
    }
  }

  /** Native mid-turn steering: adds input to the turn that is already running. */
  async steer(input: { session: AgentSessionHandle; text: string }): Promise<void> {
    const { state, session } = this.session(input.session);
    if (!session.activeTurnId) throw new Error("There is no active turn to steer.");
    await state.client.request("turn/steer", {
      threadId: session.threadId,
      expectedTurnId: session.activeTurnId,
      input: [{ type: "text", text: input.text.slice(0, MAX_PROMPT_CHARS), text_elements: [] }],
    });
  }

  async cancelTurn(input: { session: AgentSessionHandle }): Promise<void> {
    const { state, session } = this.session(input.session);
    this.settleAllPermissions(session, "cancel");
    const turnId = session.activeTurnId;
    const interrupt = turnId
      ? state.client.request("turn/interrupt", { threadId: session.threadId, turnId }).catch((error: unknown) => {
          console.error(`[codex-app-server] turn/interrupt failed for ${session.handle.sessionId}:`, error instanceof Error ? error.message : error);
        })
      : Promise.resolve();
    // A hung server never acknowledges the interrupt; free the session anyway so the next turn is not blocked.
    const forceUnblock = new Promise<void>((resolveUnblock) => {
      const timer = setTimeout(() => {
        if (session.queue && !session.queue.isClosed) console.error(`[codex-app-server] ${session.handle.sessionId} did not acknowledge the interrupt within ${CANCEL_FORCE_CLOSE_MS / 1000}s; force-closing its event queue.`);
        session.queue?.close();
        resolveUnblock();
      }, CANCEL_FORCE_CLOSE_MS);
      timer.unref?.();
    });
    await Promise.race([interrupt, forceUnblock]);
  }

  async respondToPermission(input: { session: AgentSessionHandle; requestId: string; approved: boolean }): Promise<void> {
    const { session } = this.session(input.session);
    const permission = session.permissions.get(input.requestId);
    if (!permission) throw new Error("Codex permission request is unknown or expired.");
    if (permission.settled) throw new Error("Codex permission request has already been resolved.");
    permission.settled = true;
    permission.approved = input.approved;
    permission.resolve(input.approved ? "accept" : "decline");
  }

  async closeSession(input: { session: AgentSessionHandle }): Promise<void> {
    const { state, session } = this.session(input.session);
    this.settleAllPermissions(session, "cancel");
    await state.client.request("thread/unsubscribe", { threadId: session.threadId }).catch(() => undefined);
    session.queue?.close();
    state.sessions.delete(session.handle.sessionId);
  }

  async shutdown(handle: AgentServerHandle): Promise<void> {
    const state = this.servers.get(handle.serverId);
    if (!state) return;
    state.closed = true;
    for (const session of [...state.sessions.values()]) {
      this.settleAllPermissions(session, "cancel");
      session.queue?.close();
      state.sessions.delete(session.handle.sessionId);
    }
    state.client.fail("The Codex app-server was shut down.");
    if (state.child.exitCode === null && !state.child.killed) {
      killProcessTree(state.child);
      await new Promise<void>((resolveExit) => {
        const timeout = setTimeout(resolveExit, 5_000);
        state.child.once("exit", () => { clearTimeout(timeout); resolveExit(); });
      });
    }
    this.servers.delete(handle.serverId);
  }

  // ---- internals ----

  private server(handle: AgentServerHandle): ServerState {
    const state = this.servers.get(handle.serverId);
    if (!state || state.closed) throw new Error("Codex app-server is not active.");
    return state;
  }

  private session(handle: AgentSessionHandle): { state: ServerState; session: SessionState } {
    for (const state of this.servers.values()) {
      const session = state.sessions.get(handle.sessionId);
      if (session) return { state, session };
    }
    throw new Error("Codex session is not active.");
  }

  private registerSession(state: ServerState, threadId: string, executionId: string, missionId: string): AgentSessionHandle {
    const handle: AgentSessionHandle = { sessionId: `codex-session-${randomUUID()}`, providerSessionRef: threadId, availableModels: null };
    state.sessions.set(handle.sessionId, { handle, threadId, queue: null, activeTurnId: null, permissions: new Map(), executionId, missionId, itemPaths: new Map(), lastError: null, lastUsage: null });
    return handle;
  }

  private sessionForThread(state: ServerState, threadId: unknown): SessionState | null {
    if (typeof threadId !== "string") return null;
    for (const session of state.sessions.values()) if (session.threadId === threadId) return session;
    return null;
  }

  private settleAllPermissions(session: SessionState, outcome: Outcome): void {
    for (const permission of session.permissions.values()) {
      if (permission.settled) continue;
      permission.settled = true;
      permission.resolve(outcome);
    }
    session.permissions.clear();
  }

  private activity(session: SessionState, activityKind: string, status: string, summary: string, extra: { filePath?: string | null; command?: string | null; requestId?: string; diffPatch?: string | null; additions?: number | null; deletions?: number | null } = {}): InteractiveProviderEvent {
    return {
      type: "provider.activity",
      sessionId: session.handle.sessionId,
      occurredAt: this.now(),
      payload: {
        type: "provider.activity",
        activityKind,
        status,
        summary: text(summary, 2_048, false),
        filePath: extra.filePath ?? null,
        command: extra.command ?? null,
        testName: null,
        testPassed: null,
        testFailed: null,
        testSkipped: null,
        reviewTarget: null,
        gitRef: null,
        ...(extra.requestId ? { requestId: extra.requestId } : {}),
        ...(extra.diffPatch !== undefined ? { diffPatch: extra.diffPatch, additions: extra.additions ?? null, deletions: extra.deletions ?? null, oldText: null, newText: null } : {}),
      },
    };
  }

  private onNotification(state: ServerState, method: string, rawParams: unknown): void {
    const params = record(rawParams);
    if (!params) return;
    const session = this.sessionForThread(state, params.threadId);
    if (!session) return;
    switch (method) {
      case "item/agentMessage/delta": {
        if (session.queue && typeof params.delta === "string" && params.delta) {
          session.queue.push({ type: "provider.reply_text", sessionId: session.handle.sessionId, occurredAt: this.now(), payload: { text: params.delta } });
        }
        return;
      }
      case "item/started":
      case "item/completed": {
        const item = record(params.item);
        if (!item || typeof item.type !== "string") return;
        const started = method === "item/started";
        if (item.type === "commandExecution" && typeof item.command === "string" && item.command.trim()) {
          const command = text(item.command, 512);
          session.queue?.push(this.activity(session, started ? "command.started" : "command.completed", started ? "started" : activityStatus(item.status), command, { command }));
        } else if (item.type === "fileChange" && Array.isArray(item.changes)) {
          const paths = item.changes.map((change) => workspaceRelativeAcpPath(record(change)?.path, state.workingDirectory));
          if (typeof item.id === "string") session.itemPaths.set(item.id, paths.find((path) => path !== null) ?? null);
          if (!started) {
            item.changes.forEach((change, index) => {
              const diff = record(change)?.diff;
              const counts = diffCounts(diff);
              const path = paths[index];
              session.queue?.push(this.activity(session, "file.changed", activityStatus(item.status), `Changed ${path ?? "a file"}`, {
                filePath: path,
                diffPatch: typeof diff === "string" ? diff : null,
                additions: counts?.additions ?? null,
                deletions: counts?.deletions ?? null,
              }));
            });
          }
        }
        return;
      }
      case "thread/tokenUsage/updated": {
        const usage = record(params.tokenUsage);
        const last = record(usage?.last);
        const total = record(usage?.total);
        if (!usage || !last || !total) return;
        const num = (value: unknown) => typeof value === "number" ? value : 0;
        session.lastUsage = { inputTokens: num(last.inputTokens), outputTokens: num(last.outputTokens), totalTokens: num(last.totalTokens) };
        session.queue?.push({
          type: "provider.usage_updated",
          sessionId: session.handle.sessionId,
          occurredAt: this.now(),
          payload: { inputTokens: null, outputTokens: null, totalTokens: null, contextUsedTokens: num(total.totalTokens), contextWindowTokens: typeof usage.modelContextWindow === "number" ? usage.modelContextWindow : null, costUsd: null, usageBasis: "context_window" },
        });
        return;
      }
      case "error": {
        if (typeof params.message === "string") session.lastError = params.message;
        return;
      }
      case "turn/completed": {
        const turn = record(params.turn);
        if (!turn || !session.queue) return;
        this.settleAllPermissions(session, "cancel");
        if (turn.status === "failed") {
          const error = record(turn.error);
          const message = typeof error?.message === "string" && error.message.trim() ? error.message : session.lastError ?? "The Codex turn failed.";
          const details = typeof error?.additionalDetails === "string" && error.additionalDetails.trim() ? ` (${error.additionalDetails.trim()})` : "";
          session.queue.push({ type: "provider.failed", sessionId: session.handle.sessionId, occurredAt: this.now(), payload: { reason: text(`${message}${details}`, 2_048) } });
        } else {
          if (session.lastUsage) {
            session.queue.push({ type: "provider.usage_updated", sessionId: session.handle.sessionId, occurredAt: this.now(), payload: { inputTokens: session.lastUsage.inputTokens, outputTokens: session.lastUsage.outputTokens, totalTokens: session.lastUsage.totalTokens, contextUsedTokens: null, contextWindowTokens: null, costUsd: null, usageBasis: "prompt_turn" } });
          }
          session.queue.push({ type: "provider.completed", sessionId: session.handle.sessionId, occurredAt: this.now(), payload: { stopReason: turn.status === "interrupted" ? "cancelled" : "end_turn" } });
        }
        session.lastUsage = null;
        session.queue.close();
        return;
      }
      default:
        return;
    }
  }

  /** Every server request is answered, including ones M9R does not support, so Codex never waits forever. */
  private async onServerRequest(state: ServerState, method: string, rawParams: unknown): Promise<unknown> {
    const params = record(rawParams);
    switch (method) {
      case "item/commandExecution/requestApproval": return this.handleApproval(state, "command", params, params?.threadId);
      case "item/fileChange/requestApproval": return this.handleApproval(state, "file", params, params?.threadId);
      case "item/permissions/requestApproval": return this.handleApproval(state, "permissions", params, params?.threadId);
      case "execCommandApproval": return this.handleApproval(state, "legacy-exec", params, params?.conversationId);
      case "applyPatchApproval": return this.handleApproval(state, "legacy-patch", params, params?.conversationId);
      case "mcpServer/elicitation/request": return { action: "decline", content: null, _meta: null };
      case "item/tool/requestUserInput": return { answers: {} };
      default: throw new CodexRpcError(method, -32601, "not supported by M9R");
    }
  }

  private async handleApproval(state: ServerState, kind: ApprovalKind, params: Record<string, unknown> | null, threadId: unknown): Promise<unknown> {
    const session = this.sessionForThread(state, threadId);
    if (!session) return outcomeResponse(kind, "decline", params);
    const command = kind === "command" && typeof params?.command === "string"
      ? text(params.command, 512)
      : kind === "legacy-exec" && Array.isArray(params?.command) ? text(params.command.join(" "), 512) : null;
    const filePath = kind === "file" && typeof params?.itemId === "string" ? session.itemPaths.get(params.itemId) ?? null : null;
    const reason = typeof params?.reason === "string" && params.reason.trim() ? params.reason.trim() : null;

    const deniedPattern = (filePath ? state.deniedFilePatterns.find((pattern) => matchesDenyPattern(filePath, pattern)) : undefined)
      ?? (command ? commandTouchesDeniedPath(command, state.deniedFilePatterns) ?? undefined : undefined);
    if (deniedPattern) {
      session.queue?.push(this.activity(session, "permission.requested", "failed", `Denied by file-permission policy: ${filePath ?? command} matches "${deniedPattern}"`, { filePath, command, requestId: `permission-${randomUUID()}` }));
      return outcomeResponse(kind, "decline", params);
    }
    if (kind === "file" && filePath) {
      const conflict = await requestFileLockFromApp({ path: filePath, conversationId: conversationIdForChannelMission(session.missionId) });
      if (conflict) {
        session.queue?.push(this.activity(session, "permission.requested", "failed", `${filePath} is being edited by another agent right now — not overwriting it.`, { filePath, command, requestId: `permission-${randomUUID()}` }));
        return outcomeResponse(kind, "decline", params);
      }
    }

    const requestId = `permission-${randomUUID()}`;
    const summary = text(reason ?? (command ? `Run: ${command}` : filePath ? `Change ${filePath}` : "Provider permission requested"), 2_048, false);
    session.queue?.push(this.activity(session, "permission.requested", "waiting", summary, { filePath, command, requestId }));
    void reportPendingPermissionToApp({ missionId: session.missionId, executionId: session.executionId, requestId, summary, command, filePath });
    const outcome = await new Promise<Outcome>((resolveOutcome) => {
      const permission: PermissionRecord = { requestId, approved: false, settled: false, resolve: resolveOutcome };
      session.permissions.set(requestId, permission);
      const timer = setTimeout(() => {
        if (session.permissions.get(requestId) !== permission || permission.settled) return;
        session.permissions.delete(requestId);
        permission.settled = true;
        resolveOutcome("cancel");
      }, this.options.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS);
      timer.unref?.();
    });
    session.permissions.delete(requestId);
    return outcomeResponse(kind, outcome, params);
  }
}

export function createCodexAppServerAdapter(options: Partial<CodexAppServerAdapterOptions> = {}): CodexAppServerAdapter {
  const resolved = codexAppServerCommand();
  return new CodexAppServerAdapter({
    id: "codex-app-server",
    command: resolved.command,
    args: ["app-server"],
    shell: resolved.shell,
    ...options,
  });
}
