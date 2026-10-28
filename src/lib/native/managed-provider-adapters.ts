import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import {
  startLiveSession,
  type LiveEvent,
  type LiveProcess,
  type LiveSession,
} from "./live-session-core";
import {
  CodexAppServerAdapter,
  classifyCodexAppServerFailure,
  type CodexAppServerAdapterOptions,
} from "../bridge/codex-app-server-adapter";
import type { AgentServerHandle, AgentSessionHandle, InteractiveProviderEvent } from "../bridge/interactive-provider-adapter";
import type { ProviderAssignment } from "../mission/mission-provider-adapter";
import { createOpenCodeAcpRuntime, type OpenCodeLiveRuntime, type OpenCodeLiveRuntimeOptions } from "./web-opencode-acp";
import type {
  ManagedProviderConnection,
  ManagedProviderCapabilities,
  ManagedProviderConnectionProfile,
  ManagedProviderConnectionSnapshot,
  ManagedProviderContinuation,
  ManagedProviderEvent,
  ManagedProviderModelApply,
  ManagedProviderReady,
  ManagedProviderReadiness,
  ManagedProviderStatus,
  ManagedProviderTask,
} from "./managed-provider-contract";
import {
  validateProviderModelCatalog,
  validateProviderModelSelection,
  type ProviderModelSelection,
} from "./provider-model-core";
import { redactSecrets } from "./inbox-core";

interface AsyncEventQueue<T> extends AsyncIterable<T> {
  push(value: T): void;
  end(): void;
}

function createAsyncEventQueue<T>(): AsyncEventQueue<T> {
  const values: T[] = [];
  const waiters: ((result: IteratorResult<T>) => void)[] = [];
  let ended = false;
  return {
    push(value) {
      if (ended) return;
      const waiter = waiters.shift();
      if (waiter) waiter({ done: false, value });
      else values.push(value);
    },
    end() {
      if (ended) return;
      ended = true;
      while (waiters.length) waiters.shift()!({ done: true, value: undefined });
    },
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<T>> {
          if (values.length) return Promise.resolve({ done: false, value: values.shift()! });
          if (ended) return Promise.resolve({ done: true, value: undefined });
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
  };
}

function assertProvider(profile: ManagedProviderConnectionProfile, provider: string): void {
  if (profile.provider !== provider) throw new Error(`managed provider adapter ${provider} cannot own ${profile.provider}`);
}

const MAX_CODEX_WORKER_DIAGNOSTIC_CHARS = 1_200;

function boundedWorkerDiagnostic(value: string): string {
  const clean = redactSecrets(value).replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  if (!clean) return "";
  return clean.length > MAX_CODEX_WORKER_DIAGNOSTIC_CHARS
    ? `${clean.slice(0, MAX_CODEX_WORKER_DIAGNOSTIC_CHARS - 15)} [truncated]`
    : clean;
}

function publicSnapshot(input: {
  profile: ManagedProviderConnectionProfile;
  status: ManagedProviderStatus;
  generation: number;
  activeTaskId?: string;
  doing?: string;
}): ManagedProviderConnectionSnapshot {
  return {
    connectionId: input.profile.connectionId,
    handle: input.profile.handle,
    provider: input.profile.provider,
    cwd: input.profile.cwd,
    status: input.status,
    generation: input.generation,
    ...(input.activeTaskId ? { activeTaskId: input.activeTaskId } : {}),
    ...(input.doing ? { doing: input.doing } : {}),
  };
}

abstract class ManagedProviderConnectionBase implements ManagedProviderConnection {
  readonly profile: ManagedProviderConnectionProfile;
  protected statusValue: ManagedProviderStatus = "stopped";
  protected generationValue = 0;
  protected activeTaskId?: string;
  protected doingValue = "Stopped";
  protected paused = false;
  protected draining = false;
  protected stopping = false;
  protected providerSessionRef?: string;
  private activeDone?: Promise<void>;
  private resolveActiveDone?: () => void;

  constructor(profile: ManagedProviderConnectionProfile) {
    this.profile = profile;
  }

  protected beginStart(): number {
    if (this.activeTaskId) throw new Error(`@${this.profile.handle} cannot start while task ${this.activeTaskId} is active`);
    this.generationValue += 1;
    this.statusValue = "starting";
    this.doingValue = "Starting";
    this.paused = false;
    this.draining = false;
    this.stopping = false;
    return this.generationValue;
  }

  protected requireTask(task: ManagedProviderTask): void {
    if (this.paused) throw new Error(`@${this.profile.handle} is paused`);
    if (this.draining || this.stopping) throw new Error(`@${this.profile.handle} is draining`);
    if (task.generation !== this.generationValue) throw new Error("managed provider task runtime generation is stale");
    if (task.connectionId !== this.profile.connectionId || task.handle !== this.profile.handle || task.provider !== this.profile.provider || task.cwd !== this.profile.cwd) {
      throw new Error("managed provider task does not match its selected connection");
    }
    if (!task.taskId.trim() || !task.prompt.trim()) throw new Error("managed provider task must include an ID and prompt");
    if (this.activeTaskId && this.activeTaskId !== task.taskId) throw new Error(`@${this.profile.handle} is already handling task ${this.activeTaskId}`);
  }

  protected beginTask(taskId: string): void {
    if (this.activeTaskId && this.activeTaskId !== taskId) throw new Error(`@${this.profile.handle} is already handling task ${this.activeTaskId}`);
    this.activeTaskId = taskId;
    this.activeDone = new Promise((resolve) => { this.resolveActiveDone = resolve; });
    this.statusValue = "working";
    this.doingValue = "Working";
  }

  protected finishTask(): void {
    this.activeTaskId = undefined;
    this.resolveActiveDone?.();
    this.resolveActiveDone = undefined;
    this.activeDone = undefined;
  }

  protected ready(doing = "Ready"): ManagedProviderReady {
    this.statusValue = "ready";
    this.doingValue = doing;
    return {
      connectionId: this.profile.connectionId,
      generation: this.generationValue,
      ...(this.providerSessionRef ? { continuation: { providerSessionRef: this.providerSessionRef } } : {}),
    };
  }

  protected fail(doing: string): void {
    this.statusValue = "failed";
    this.doingValue = doing;
  }

  protected stopped(doing = "Stopped by you"): void {
    this.generationValue += 1;
    this.statusValue = "stopped";
    this.doingValue = doing;
    this.stopping = true;
    this.paused = false;
    this.draining = false;
    this.finishTask();
  }

  status(): ManagedProviderConnectionSnapshot {
    return publicSnapshot({
      profile: this.profile,
      status: this.statusValue,
      generation: this.generationValue,
      activeTaskId: this.activeTaskId,
      doing: this.doingValue,
    });
  }

  readiness(): ManagedProviderReadiness {
    if (this.generationValue < 1) return { healthy: false, detail: "provider connection has not started" };
    if (this.stopping || this.statusValue === "stopped" || this.statusValue === "failed" || this.statusValue === "draining") {
      return { healthy: false, detail: `provider connection is ${this.statusValue}` };
    }
    if (this.statusValue !== "ready" && this.statusValue !== "working" && this.statusValue !== "paused") {
      return { healthy: false, detail: `provider connection is ${this.statusValue}` };
    }
    return { healthy: true };
  }

  capabilities(): ManagedProviderCapabilities {
    return {
      connectionId: this.profile.connectionId,
      provider: this.profile.provider,
      generation: this.generationValue,
      models: null,
      currentModel: this.profile.model ?? null,
      currentEffort: this.profile.effort ?? null,
    };
  }

  async applyModelSelection(selection: ProviderModelSelection): Promise<ManagedProviderModelApply> {
    return {
      ok: false,
      applies: "next-restart",
      error: "this provider connection does not expose live model configuration",
    };
  }

  async pause(): Promise<void> {
    if (this.activeTaskId) throw new Error(`@${this.profile.handle} cannot pause while task ${this.activeTaskId} is active`);
    if (this.statusValue === "stopped") throw new Error(`@${this.profile.handle} is stopped`);
    this.paused = true;
    this.statusValue = "paused";
    this.doingValue = "Paused";
  }

  async resume(): Promise<void> {
    if (!this.paused) return;
    this.paused = false;
    this.statusValue = "ready";
    this.doingValue = "Ready";
  }

  async drain(): Promise<void> {
    if (this.statusValue === "stopped") return;
    this.draining = true;
    this.statusValue = "draining";
    this.doingValue = "Draining";
    if (this.activeDone) await this.activeDone;
  }

  continuation(): ManagedProviderContinuation | undefined {
    return this.providerSessionRef ? { providerSessionRef: this.providerSessionRef } : undefined;
  }

  abstract start(continuation?: ManagedProviderContinuation): Promise<ManagedProviderReady>;
  abstract send(task: ManagedProviderTask): AsyncIterable<ManagedProviderEvent>;
  abstract cancel(taskId: string): Promise<void>;
  abstract stop(): Promise<void>;
}

export interface ClaudeManagedProviderConnectionOptions {
  profile: ManagedProviderConnectionProfile;
  mcpConfigPath: string;
  environment?: Record<string, string | undefined>;
  allowApiKey?: boolean;
  profileMode?: "web-only" | "hands";
  appendSystemPrompt?: string;
  model?: string;
  effort?: string;
  allowedTools?: string[];
  spawn?: (command: string, args: string[], cwd: string) => LiveProcess;
}

function defaultClaudeSpawn(command: string, args: string[], cwd: string): LiveProcess {
  const child: ChildProcess = nodeSpawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  child.stdin?.on("error", () => undefined);
  return child as unknown as LiveProcess;
}

class ClaudeManagedProviderConnection extends ManagedProviderConnectionBase {
  private readonly options: ClaudeManagedProviderConnectionOptions;
  private live?: LiveSession;
  private startup?: Promise<ManagedProviderReady>;
  private queue?: AsyncEventQueue<ManagedProviderEvent>;

  constructor(options: ClaudeManagedProviderConnectionOptions) {
    super(options.profile);
    assertProvider(options.profile, "claude-code");
    this.options = options;
  }

  readiness(): ManagedProviderReadiness {
    const base = super.readiness();
    if (!base.healthy) return base;
    try {
      if (!this.live || this.live.state().status === "exited") {
        return { healthy: false, detail: "Claude provider process is no longer live" };
      }
    } catch {
      return { healthy: false, detail: "Claude provider liveness could not be confirmed" };
    }
    return { healthy: true };
  }

  async start(continuation?: ManagedProviderContinuation): Promise<ManagedProviderReady> {
    if (this.live && this.live.state().status !== "exited" && (this.statusValue === "ready" || this.statusValue === "working")) return this.ready();
    if (this.startup) return this.startup;
    const expectedResumeId = continuation?.providerSessionRef ?? this.providerSessionRef;
    const generation = this.beginStart();
    let resolveReady!: (ready: ManagedProviderReady) => void;
    let rejectReady!: (error: Error) => void;
    let settled = false;
    let handshakeSeen = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      this.fail(error instanceof Error ? error.message : String(error));
      rejectReady(error instanceof Error ? error : new Error(String(error)));
    };
    const promise = new Promise<ManagedProviderReady>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    this.startup = promise;
    try {
      this.live = startLiveSession({
        config: {
          cwd: this.profile.cwd,
          profile: this.options.profileMode ?? "web-only",
          mcpConfigPath: this.options.mcpConfigPath,
          resumeSessionId: expectedResumeId,
          model: this.options.model ?? this.profile.model,
          effort: this.options.effort ?? this.profile.effort,
          allowedTools: this.options.allowedTools,
          appendSystemPrompt: this.options.appendSystemPrompt,
        },
        spawn: this.options.spawn ?? defaultClaudeSpawn,
        env: this.options.environment,
        allowApiKey: this.options.allowApiKey,
        onEvent: (event: LiveEvent) => {
          if (generation !== this.generationValue || this.stopping) return;
          if (event.kind === "init") {
            handshakeSeen = true;
            if (expectedResumeId && event.sessionId !== expectedResumeId) {
              const error = new Error("Claude resumed a different provider conversation");
              this.live?.stop();
              fail(error);
              return;
            }
            this.providerSessionRef = event.sessionId;
            if (!settled) {
              settled = true;
              resolveReady(this.ready());
            } else if (!this.activeTaskId) this.ready();
            return;
          }
          if (event.kind === "tool") this.queue?.push({ kind: "tool", name: event.name, summary: event.summary });
          else if (event.kind === "text") this.queue?.push({ kind: "text", text: event.text });
          else if (event.kind === "result") {
            if (event.sessionId) this.providerSessionRef = event.sessionId;
            this.queue?.push({ kind: "result", text: event.text, isError: event.isError });
            this.finishTask();
            if (event.isError) this.fail("Claude reported a provider failure");
            else if (!this.draining) this.ready();
            this.queue?.push({ kind: "status", status: this.statusValue, doing: this.doingValue });
            this.queue?.end();
          }
        },
        onExit: (code) => {
          if (generation !== this.generationValue) return;
          this.live = undefined;
          if (!settled) fail(new Error(`Claude exited before readiness (exit ${code ?? "unknown"})`));
          else if (!handshakeSeen && !this.activeTaskId) this.fail(`Claude exited before its initialization handshake (exit ${code ?? "unknown"})`);
          if (this.activeTaskId) {
            this.queue?.push({ kind: "error", error: `Claude exited with code ${code ?? "unknown"}`, retryable: true });
            this.finishTask();
            this.queue?.end();
          }
          if (!this.stopping && !this.draining) this.fail(`Claude exited with code ${code ?? "unknown"}`);
        },
      });
      // Claude Code's stream-json CLI can keep the process open without
      // emitting its `system/init` line until it receives the first user
      // message. The owner broker must be able to send that first task; if we
      // wait for init during eager startup, the provider remains "Starting"
      // forever and the first task can never reach stdin. Resume requests are
      // different: they must still wait for and verify the requested session.
      if (!expectedResumeId && !settled) {
        settled = true;
        resolveReady(this.ready());
      }
    } catch (error) {
      fail(error);
    }
    try {
      return await promise;
    } finally {
      if (this.startup === promise) this.startup = undefined;
    }
  }

  async *send(task: ManagedProviderTask): AsyncIterable<ManagedProviderEvent> {
    this.requireTask(task);
    if (!this.live || this.live.state().status === "exited") throw new Error("Claude provider connection is not ready");
    const queue = createAsyncEventQueue<ManagedProviderEvent>();
    this.queue = queue;
    this.beginTask(task.taskId);
    queue.push({ kind: "status", status: "working", doing: "Working" });
    try {
      if (this.live.state().status === "working") this.live.interrupt(task.prompt);
      else this.live.send(task.prompt);
      queue.push({ kind: "accepted" });
    } catch (error) {
      queue.push({ kind: "error", error: error instanceof Error ? error.message : String(error), retryable: true });
      this.finishTask();
      this.fail("Could not send task");
      queue.end();
    }
    yield* queue;
    if (this.queue === queue) this.queue = undefined;
  }

  async cancel(taskId: string): Promise<void> {
    if (this.activeTaskId !== taskId) return;
    await this.stop("Task canceled");
  }

  async stop(doing = "Stopped by you"): Promise<void> {
    const queue = this.queue;
    if (queue) {
      queue.push({ kind: "error", error: doing, retryable: true });
      queue.end();
    }
    const live = this.live;
    this.live = undefined;
    this.stopped(doing);
    live?.stop();
  }
}

export function createClaudeManagedProviderConnection(options: ClaudeManagedProviderConnectionOptions): ManagedProviderConnection {
  return new ClaudeManagedProviderConnection(options);
}

export interface CodexWorkerProcess {
  stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown };
  stderr?: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown };
  on(event: "exit", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(): unknown;
}

export interface CodexManagedProviderConnectionOptions {
  profile: ManagedProviderConnectionProfile;
  command: string;
  environment: Record<string, string | undefined>;
  buildArgs(input: { task: ManagedProviderTask; continuation?: ManagedProviderContinuation }): string[];
  spawnWorker: (command: string, args: string[], options: { cwd: string; env: Record<string, string | undefined> }) => CodexWorkerProcess;
}

function parseCodexLine(line: string): Array<{ kind: "thread"; id: string } | { kind: "say"; text: string } | { kind: "tool"; name: string } | { kind: "done" }> {
  let event: { type?: string; thread_id?: string; item?: Record<string, unknown> };
  try { event = JSON.parse(line); } catch { return []; }
  if (event.type === "thread.started" && typeof event.thread_id === "string") return [{ kind: "thread", id: event.thread_id }];
  if (event.type === "turn.completed") return [{ kind: "done" }];
  const item = event.item ?? {};
  if (event.type === "item.completed" && item.type === "agent_message" && typeof item.text === "string") return [{ kind: "say", text: item.text }];
  if (event.type === "item.started") {
    const tool = /m9r_[a-z_]+/.exec(JSON.stringify(item))?.[0];
    if (tool) return [{ kind: "tool", name: tool }];
  }
  return [];
}

class CodexManagedProviderConnection extends ManagedProviderConnectionBase {
  private readonly options: CodexManagedProviderConnectionOptions;
  private worker?: CodexWorkerProcess;
  private queue?: AsyncEventQueue<ManagedProviderEvent>;

  constructor(options: CodexManagedProviderConnectionOptions) {
    super(options.profile);
    assertProvider(options.profile, "codex");
    this.options = options;
  }

  async start(continuation?: ManagedProviderContinuation): Promise<ManagedProviderReady> {
    if (this.statusValue === "ready" || this.statusValue === "working") return this.ready();
    this.providerSessionRef = continuation?.providerSessionRef ?? this.providerSessionRef;
    this.beginStart();
    return this.ready("Ready (Codex worker resumes its thread per turn)");
  }

  async *send(task: ManagedProviderTask): AsyncIterable<ManagedProviderEvent> {
    this.requireTask(task);
    if (this.worker) throw new Error("Codex provider connection already has a worker");
    const generation = this.generationValue;
    const queue = createAsyncEventQueue<ManagedProviderEvent>();
    this.queue = queue;
    this.beginTask(task.taskId);
    queue.push({ kind: "status", status: "working", doing: "Working" });
    let answer = "";
    let terminal = false;
    try {
      const child = this.options.spawnWorker(this.options.command, this.options.buildArgs({ task, continuation: this.continuation() }), { cwd: this.profile.cwd, env: this.options.environment });
      this.worker = child;
      let buffer = "";
      let stderr = "";
      child.stderr?.on("data", (chunk) => {
        // Keep only a bounded, redacted diagnostic. The worker's stdout is
        // protocol data; stderr is the only place the app-server can explain
        // a non-zero exit, so dropping it made exit code 1 impossible to
        // diagnose after the process was reaped.
        if (stderr.length >= MAX_CODEX_WORKER_DIAGNOSTIC_CHARS * 2) return;
        stderr += chunk.toString();
      });
      child.stdout.on("data", (chunk) => {
        if (generation !== this.generationValue) return;
        buffer += chunk.toString();
        let at: number;
        while ((at = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, at);
          buffer = buffer.slice(at + 1);
          for (const event of parseCodexLine(line)) {
            if (event.kind === "thread") this.providerSessionRef = event.id;
            else if (event.kind === "say") { answer = event.text; queue.push({ kind: "text", text: event.text }); }
            else if (event.kind === "tool") queue.push({ kind: "tool", name: event.name });
            else if (event.kind === "done") void event;
          }
        }
      });
      child.on("exit", (code) => {
        if (terminal || generation !== this.generationValue) return;
        terminal = true;
        this.worker = undefined;
        if (code === 0) {
          queue.push({ kind: "result", text: answer, isError: false });
          this.finishTask();
          if (!this.draining) this.ready("Ready (Codex worker resumes its thread per turn)");
          queue.push({ kind: "status", status: this.statusValue, doing: this.doingValue });
        } else {
          const diagnostic = boundedWorkerDiagnostic(stderr);
          const reason = `Codex worker exited with code ${code ?? "unknown"}${diagnostic ? `: ${diagnostic}` : ""}`;
          queue.push({ kind: "error", error: reason, retryable: true });
          this.finishTask();
          this.fail(diagnostic ? `Codex worker failed: ${diagnostic}` : "Codex worker failed");
        }
        queue.end();
      });
      child.on("error", (error) => {
        if (terminal || generation !== this.generationValue) return;
        terminal = true;
        this.worker = undefined;
        queue.push({ kind: "error", error: error.message, retryable: true });
        this.finishTask();
        this.fail("Could not start Codex worker");
        queue.end();
      });
      // The worker receives its prompt as process arguments. Once spawn has
      // returned and the listeners are attached, the owner has a concrete
      // transport handoff receipt; later process failure is execution failure,
      // not an invitation to replay the task.
      queue.push({ kind: "accepted" });
    } catch (error) {
      queue.push({ kind: "error", error: error instanceof Error ? error.message : String(error), retryable: true });
      this.finishTask();
      this.fail("Could not start Codex worker");
      queue.end();
    }
    yield* queue;
    if (this.queue === queue) this.queue = undefined;
  }

  async cancel(taskId: string): Promise<void> {
    if (this.activeTaskId !== taskId) return;
    await this.stop("Task canceled");
  }

  async stop(doing = "Stopped by you"): Promise<void> {
    const queue = this.queue;
    if (queue) {
      queue.push({ kind: "error", error: doing, retryable: true });
      queue.end();
    }
    const worker = this.worker;
    this.worker = undefined;
    this.stopped(doing);
    worker?.kill();
  }
}

export function createCodexManagedProviderConnection(options: CodexManagedProviderConnectionOptions): ManagedProviderConnection {
  return new CodexManagedProviderConnection(options);
}

/**
 * M9R-owned persistent Codex app-server connection.
 *
 * The older worker adapter above remains available for isolated compatibility
 * fixtures, but the desktop owner uses this connection: one app-server per
 * managed provider profile and one resumable Codex thread across turns. The
 * provider process is never rediscovered from the user's Codex UI session.
 */
export interface CodexAppServerManagedProviderConnectionOptions {
  profile: ManagedProviderConnectionProfile;
  command: string;
  /** Complete app-server argv, including the `app-server` subcommand. */
  args?: readonly string[];
  shell?: boolean;
  environment: Record<string, string | undefined>;
  missionId: string;
  promptPrefix: string;
  deniedFilePatterns?: string[];
  adapterFactory?: (options: CodexAppServerAdapterOptions) => CodexAppServerAdapter;
}

function managedCodexAssignment(options: CodexAppServerManagedProviderConnectionOptions): ProviderAssignment {
  return {
    missionId: options.missionId,
    dispatchKey: `m9r-${options.profile.connectionId}`,
    goal: `Work for @${options.profile.handle} through M9R's managed desktop route.`,
    executionConstraints: { profile: "web-only" },
    model: options.profile.model ?? null,
    effort: options.profile.effort ?? null,
    deniedFilePatterns: options.deniedFilePatterns ?? [],
  };
}

function managedCodexPrompt(options: CodexAppServerManagedProviderConnectionOptions, task: ManagedProviderTask): string {
  return `${options.promptPrefix}\n\nThe owner says:\n${task.prompt}`;
}

class CodexAppServerManagedProviderConnection extends ManagedProviderConnectionBase {
  private readonly options: CodexAppServerManagedProviderConnectionOptions;
  private adapter?: CodexAppServerAdapter;
  private server?: AgentServerHandle;
  private session?: AgentSessionHandle;
  private startup?: Promise<ManagedProviderReady>;
  private cancelledTask?: string;

  constructor(options: CodexAppServerManagedProviderConnectionOptions) {
    super(options.profile);
    assertProvider(options.profile, "codex");
    this.options = options;
  }

  readiness(): ManagedProviderReadiness {
    const base = super.readiness();
    if (!base.healthy) return base;
    try {
      if (!this.adapter || !this.server || !this.session) {
        return { healthy: false, detail: "Codex app-server connection has no live server/session binding" };
      }
      const health = this.adapter.getServerHealth(this.server);
      return health.state === "alive"
        ? { healthy: true }
        : { healthy: false, detail: health.detail || "Codex app-server process is not alive" };
    } catch {
      return { healthy: false, detail: "Codex app-server liveness could not be confirmed" };
    }
  }

  capabilities(): ManagedProviderCapabilities {
    const models = validateProviderModelCatalog(this.session?.availableModels ?? null);
    return {
      connectionId: this.profile.connectionId,
      provider: this.profile.provider,
      generation: this.generationValue,
      models,
      currentModel: this.session?.model ?? this.profile.model ?? null,
      currentEffort: this.session?.effort ?? this.profile.effort ?? null,
    };
  }

  async applyModelSelection(selection: ProviderModelSelection): Promise<ManagedProviderModelApply> {
    const adapter = this.adapter;
    const session = this.session;
    const capabilities = this.capabilities();
    const validation = validateProviderModelSelection(capabilities, selection);
    if (!validation.ok) return { ok: false, applies: "next-restart", error: validation.reason };
    if (!adapter || !session) return { ok: false, applies: "next-restart", error: "Codex app-server session is not live" };
    try {
      await adapter.configureSession({ session, model: validation.selection.model ?? null, effort: validation.selection.effort ?? null });
      return { ok: true, applies: "next-turn" };
    } catch (error) {
      return { ok: false, applies: "next-restart", error: error instanceof Error ? error.message : String(error) };
    }
  }

  private assignment(): ProviderAssignment {
    return managedCodexAssignment(this.options);
  }

  private createAdapter(): CodexAppServerAdapter {
    const resolved: CodexAppServerAdapterOptions = {
      id: `m9r-codex-${this.profile.connectionId}`,
      command: this.options.command,
      args: this.options.args ?? ["app-server"],
      shell: this.options.shell ?? false,
      env: this.options.environment as NodeJS.ProcessEnv,
      sandbox: "read-only",
      approvalPolicy: "on-request",
    };
    return this.options.adapterFactory?.(resolved) ?? new CodexAppServerAdapter(resolved);
  }

  private async closeRuntime(): Promise<void> {
    const adapter = this.adapter;
    const server = this.server;
    this.adapter = undefined;
    this.server = undefined;
    this.session = undefined;
    if (adapter && server) await adapter.shutdown(server).catch(() => undefined);
  }

  async start(continuation?: ManagedProviderContinuation): Promise<ManagedProviderReady> {
    const existingServer = this.server;
    if (this.adapter && existingServer && this.session
      && this.adapter.getServerHealth(existingServer).state === "alive"
      && (this.statusValue === "ready" || this.statusValue === "working")) {
      return this.ready("Ready (Codex app-server session)");
    }
    if (this.startup) return this.startup;
    await this.closeRuntime();
    const generation = this.beginStart();
    const adapter = this.createAdapter();
    const assignment = this.assignment();
    const promise = (async () => {
      const server = await adapter.launchServer({
        assignment,
        environment: { workingDirectory: this.profile.cwd, kind: "shared" },
      });
      try {
        await adapter.initialize(server);
        if (generation !== this.generationValue || this.stopping) throw new Error("Codex app-server connection was stopped while starting");
        const providerSessionRef = continuation?.providerSessionRef ?? this.providerSessionRef;
        const session = providerSessionRef
          ? await adapter.resumeSession({ server, providerSessionRef, assignment })
          : await adapter.createSession({ server, assignment, executionId: this.profile.connectionId });
        if (generation !== this.generationValue || this.stopping) throw new Error("Codex app-server connection was stopped while starting");
        this.adapter = adapter;
        this.server = server;
        this.session = session;
        this.providerSessionRef = session.providerSessionRef ?? undefined;
        return this.ready("Ready (Codex app-server session)");
      } catch (error) {
        await adapter.shutdown(server).catch(() => undefined);
        throw error;
      }
    })().catch((error: unknown) => {
      this.fail(error instanceof Error ? classifyCodexAppServerFailure(error.message) : classifyCodexAppServerFailure(String(error)));
      throw error instanceof Error ? error : new Error(String(error));
    });
    this.startup = promise;
    try {
      return await promise;
    } finally {
      if (this.startup === promise) this.startup = undefined;
    }
  }

  async *send(task: ManagedProviderTask): AsyncIterable<ManagedProviderEvent> {
    this.requireTask(task);
    const adapter = this.adapter;
    const session = this.session;
    const health = adapter && this.server ? adapter.getServerHealth(this.server) : undefined;
    if (!adapter || !session || !this.server || health?.state !== "alive") {
      const reason = health?.detail || "Codex app-server connection is not ready";
      // A server can exit between turns without having an active queue to
      // receive a provider.failed event. Marking the logical connection
      // failed here lets the supervisor relaunch it on the next dispatch
      // instead of leaving a permanently-ready, dead runtime behind.
      this.fail(reason);
      throw new Error(reason);
    }
    const generation = this.generationValue;
    this.beginTask(task.taskId);
    this.cancelledTask = undefined;
    yield { kind: "status", status: "working", doing: "Working" };
    let answer = "";
    let completed = false;
    let failure: string | undefined;
    try {
      const iterator = adapter.prompt({ session, text: managedCodexPrompt(this.options, task) })[Symbol.asyncIterator]();
      const first = iterator.next();
      yield { kind: "accepted" };
      let next = await first;
      while (!next.done) {
        if (generation !== this.generationValue || this.stopping) return;
        const event: InteractiveProviderEvent = next.value;
        if (event.type === "provider.reply_text" && typeof event.payload.text === "string") {
          answer += event.payload.text;
          yield { kind: "text", text: event.payload.text };
        } else if (event.type === "provider.activity") {
          const name = typeof event.payload.summary === "string"
            ? event.payload.summary
            : typeof event.payload.activityKind === "string" ? event.payload.activityKind : "Codex activity";
          yield { kind: "tool", name, summary: typeof event.payload.status === "string" ? event.payload.status : undefined };
        } else if (event.type === "provider.failed") {
          failure = typeof event.payload.reason === "string" ? event.payload.reason : "Codex app-server reported a provider failure";
        } else if (event.type === "provider.completed") {
          completed = true;
        }
        next = await iterator.next();
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (this.cancelledTask === task.taskId) failure = "Task canceled";
    if (failure || !completed) {
      this.finishTask();
      const classified = classifyCodexAppServerFailure(failure ?? "Codex app-server ended the turn without a completion event");
      this.fail(classified);
      yield { kind: "error", error: classified, retryable: true };
      return;
    }
    this.finishTask();
    if (!this.draining) this.ready("Ready (Codex app-server session)");
    else {
      this.statusValue = "draining";
      this.doingValue = "Draining";
    }
    yield { kind: "result", text: answer.trim(), isError: false };
    yield { kind: "status", status: this.statusValue, doing: this.doingValue };
  }

  async cancel(taskId: string): Promise<void> {
    if (this.activeTaskId !== taskId || !this.adapter || !this.session) return;
    this.cancelledTask = taskId;
    await this.adapter.cancelTurn({ session: this.session });
  }

  async stop(doing = "Stopped by you"): Promise<void> {
    this.cancelledTask = undefined;
    this.stopped(doing);
    await this.closeRuntime();
  }
}

export function createCodexAppServerManagedProviderConnection(options: CodexAppServerManagedProviderConnectionOptions): ManagedProviderConnection {
  return new CodexAppServerManagedProviderConnection(options);
}

export interface OpenCodeManagedProviderConnectionOptions {
  profile: ManagedProviderConnectionProfile;
  exe: string;
  environment: Record<string, string | undefined>;
  missionId: string;
  runtimeFactory?: (options: OpenCodeLiveRuntimeOptions) => OpenCodeLiveRuntime;
}

class OpenCodeManagedProviderConnection extends ManagedProviderConnectionBase {
  private readonly options: OpenCodeManagedProviderConnectionOptions;
  private runtime?: OpenCodeLiveRuntime;
  private startup?: Promise<ManagedProviderReady>;
  private cancelledTask?: string;
  private availableModels: ManagedProviderCapabilities["models"] = null;
  private currentModel?: string | null;
  private currentEffort?: string | null;

  constructor(options: OpenCodeManagedProviderConnectionOptions) {
    super(options.profile);
    assertProvider(options.profile, "opencode");
    this.options = options;
  }

  readiness(): ManagedProviderReadiness {
    const base = super.readiness();
    if (!base.healthy) return base;
    try {
      if (!this.runtime || this.runtime.alive?.() === false) {
        return { healthy: false, detail: "OpenCode ACP runtime is no longer live" };
      }
    } catch {
      return { healthy: false, detail: "OpenCode ACP liveness could not be confirmed" };
    }
    return { healthy: true };
  }

  capabilities(): ManagedProviderCapabilities {
    return {
      connectionId: this.profile.connectionId,
      provider: this.profile.provider,
      generation: this.generationValue,
      models: this.availableModels,
      currentModel: this.currentModel ?? this.profile.model ?? null,
      currentEffort: this.currentEffort ?? this.profile.effort ?? null,
    };
  }

  async applyModelSelection(selection: ProviderModelSelection): Promise<ManagedProviderModelApply> {
    const runtime = this.runtime;
    const validation = validateProviderModelSelection(this.capabilities(), selection);
    if (!validation.ok) return { ok: false, applies: "next-restart", error: validation.reason };
    if (!runtime?.configureModel) return { ok: false, applies: "next-restart", error: "OpenCode ACP does not expose live model configuration" };
    try {
      await runtime.configureModel(validation.selection.model ?? null, validation.selection.effort ?? null);
      this.currentModel = validation.selection.model ?? null;
      this.currentEffort = validation.selection.effort ?? null;
      return { ok: true, applies: "next-turn" };
    } catch (error) {
      return { ok: false, applies: "next-restart", error: error instanceof Error ? error.message : String(error) };
    }
  }

  async start(continuation?: ManagedProviderContinuation): Promise<ManagedProviderReady> {
    if (this.runtime && this.runtime.alive?.() !== false && (this.statusValue === "ready" || this.statusValue === "working")) return this.ready();
    if (this.startup) return this.startup;
    if (this.runtime && this.runtime.alive?.() === false) {
      this.runtime.close();
      this.runtime = undefined;
    }
    const generation = this.beginStart();
    const runtimeFactory = this.options.runtimeFactory ?? createOpenCodeAcpRuntime;
    const promise = (async () => {
      const runtime = runtimeFactory({
        exe: this.options.exe,
        cwd: this.profile.cwd,
        env: this.options.environment,
        handle: this.profile.handle,
        missionId: this.options.missionId,
        model: this.profile.model,
        effort: this.profile.effort,
        // Continuation metadata is a hint, not a liveness guarantee. OpenCode
        // can prune a session or reset its local store while M9R is stopped;
        // let the ACP runtime fall back to a fresh owner session and persist
        // the replacement instead of leaving this provider permanently red.
        ...(continuation?.providerSessionRef ? { resumeId: continuation.providerSessionRef, strictResume: false } : {}),
      });
      this.runtime = runtime;
      const ready = await runtime.ready();
      if (generation !== this.generationValue || this.stopping) {
        runtime.close();
        throw new Error("OpenCode provider connection was stopped while starting");
      }
      this.providerSessionRef = ready.sessionId;
      this.availableModels = validateProviderModelCatalog(ready.availableModels ?? null);
      this.currentModel = this.profile.model ?? null;
      this.currentEffort = this.profile.effort ?? null;
      return this.ready("Ready (OpenCode ACP session)");
    })().catch((error: unknown) => {
      this.fail(error instanceof Error ? error.message : String(error));
      throw error instanceof Error ? error : new Error(String(error));
    });
    this.startup = promise;
    try {
      return await promise;
    } finally {
      if (this.startup === promise) this.startup = undefined;
    }
  }

  async *send(task: ManagedProviderTask): AsyncIterable<ManagedProviderEvent> {
    this.requireTask(task);
    if (!this.runtime || this.runtime.alive?.() === false) throw new Error("OpenCode provider connection is not ready");
    const runtime = this.runtime;
    this.beginTask(task.taskId);
    this.cancelledTask = undefined;
    yield { kind: "status", status: "working", doing: "Working" };
    let answer = "";
    let completed = false;
    let failure: string | undefined;
    let requestSubmitted = false;
    try {
      const response = runtime.prompt(task.prompt, { onRequestSubmitted: () => { requestSubmitted = true; } });
      const iterator = response[Symbol.asyncIterator]();
      let next = await iterator.next();
      while (!next.done) {
        if (requestSubmitted) {
          requestSubmitted = false;
          yield { kind: "accepted" };
        }
        const event = next.value;
        if (event.type === "provider.reply_text" && typeof event.payload.text === "string") {
          answer += event.payload.text;
          yield { kind: "text", text: event.payload.text };
        } else if (event.type === "provider.activity") {
          const name = typeof event.payload.summary === "string" ? event.payload.summary : typeof event.payload.activityKind === "string" ? event.payload.activityKind : "OpenCode activity";
          yield { kind: "tool", name };
        } else if (event.type === "provider.failed") {
          failure = typeof event.payload.reason === "string" ? event.payload.reason : "OpenCode reported a provider failure";
        } else if (event.type === "provider.completed") {
          completed = true;
        }
        next = await iterator.next();
      }
      if (requestSubmitted) {
        yield { kind: "accepted" };
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (this.cancelledTask === task.taskId) failure = "Task canceled";
    if (failure || !completed) {
      this.finishTask();
      this.fail(failure ?? "OpenCode ended the turn without a completion event");
      yield { kind: "error", error: failure ?? "OpenCode ended the turn without a completion event", retryable: true };
      return;
    }
    this.finishTask();
    if (!this.draining) this.ready("Ready (OpenCode ACP session)");
    else {
      this.statusValue = "draining";
      this.doingValue = "Draining";
    }
    yield { kind: "result", text: answer.trim(), isError: false };
    yield { kind: "status", status: "ready", doing: "Ready (OpenCode ACP session)" };
  }

  async cancel(taskId: string): Promise<void> {
    if (this.activeTaskId !== taskId || !this.runtime) return;
    this.cancelledTask = taskId;
    await this.runtime.cancelTurn();
  }

  async stop(doing = "Stopped by you"): Promise<void> {
    const runtime = this.runtime;
    this.runtime = undefined;
    this.stopped(doing);
    runtime?.close();
  }
}

export function createOpenCodeManagedProviderConnection(options: OpenCodeManagedProviderConnectionOptions): ManagedProviderConnection {
  return new OpenCodeManagedProviderConnection(options);
}
