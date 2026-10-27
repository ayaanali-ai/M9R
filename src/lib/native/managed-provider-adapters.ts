import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import {
  startLiveSession,
  type LiveEvent,
  type LiveProcess,
  type LiveSession,
} from "./live-session-core";
import { createOpenCodeAcpRuntime, type OpenCodeLiveRuntime, type OpenCodeLiveRuntimeOptions } from "./web-opencode-acp";
import type {
  ManagedProviderConnection,
  ManagedProviderConnectionProfile,
  ManagedProviderConnectionSnapshot,
  ManagedProviderContinuation,
  ManagedProviderEvent,
  ManagedProviderReady,
  ManagedProviderStatus,
  ManagedProviderTask,
} from "./managed-provider-contract";

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

  async start(continuation?: ManagedProviderContinuation): Promise<ManagedProviderReady> {
    if (this.live && this.live.state().status !== "exited" && (this.statusValue === "ready" || this.statusValue === "working")) return this.ready();
    if (this.startup) return this.startup;
    const expectedResumeId = continuation?.providerSessionRef ?? this.providerSessionRef;
    const generation = this.beginStart();
    let resolveReady!: (ready: ManagedProviderReady) => void;
    let rejectReady!: (error: Error) => void;
    let settled = false;
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
          if (this.activeTaskId) {
            this.queue?.push({ kind: "error", error: `Claude exited with code ${code ?? "unknown"}`, retryable: true });
            this.finishTask();
            this.queue?.end();
          }
          if (!this.stopping && !this.draining) this.fail(`Claude exited with code ${code ?? "unknown"}`);
        },
      });
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
          queue.push({ kind: "error", error: `Codex worker exited with code ${code ?? "unknown"}`, retryable: true });
          this.finishTask();
          this.fail("Codex worker failed");
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

  constructor(options: OpenCodeManagedProviderConnectionOptions) {
    super(options.profile);
    assertProvider(options.profile, "opencode");
    this.options = options;
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
        ...(continuation?.providerSessionRef ? { resumeId: continuation.providerSessionRef, strictResume: true } : {}),
      });
      this.runtime = runtime;
      const ready = await runtime.ready();
      if (generation !== this.generationValue || this.stopping) {
        runtime.close();
        throw new Error("OpenCode provider connection was stopped while starting");
      }
      this.providerSessionRef = ready.sessionId;
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
