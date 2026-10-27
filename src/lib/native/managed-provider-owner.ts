import { spawn as nodeSpawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import {
  createClaudeManagedProviderConnection,
  createCodexManagedProviderConnection,
  createOpenCodeManagedProviderConnection,
  type CodexWorkerProcess,
} from "./managed-provider-adapters";
import {
  normalizeManagedProviderProfile,
  type ManagedProviderConnection,
  type ManagedProviderConnectionProfile,
  type ManagedProviderStatus,
} from "./managed-provider-contract";
import { createFileManagedProviderContinuationStore, createManagedProviderSupervisor } from "./managed-provider-supervisor";
import { nodeForCodex, normCwd } from "./codex-delivery-core";
import { apiKeyLaunchBlock } from "./vendor-launch-core";
import {
  CODEX_WEB_PREFACE,
  codexCliPath,
  codexWorkerArgs,
  opencodeExePath,
  projectRoomId,
  sharedProjectMemory,
  webAgentPrompt,
  webMcpServerCommand,
  writeWebMcpConfig,
  type WebAgentConfig,
  type WebLiveSessionsDeps,
} from "./web-live-sessions";
import type { SessionEvent, SessionStatus, SessionsPort } from "./web-ui-bridge";
import { inboxMaxAgeMs, type Task } from "./inbox-core";

/**
 * The desktop owner boundary. M9R creates this once per broker and owns every
 * provider connection below it. Provider processes are never discovered by
 * PID or selected from a provider-wide session list.
 */
export interface ManagedProviderOwnerDeps {
  agents: WebAgentConfig[];
  storeRoot: string;
  repoRoot: string;
  brokerPort: number;
  store: WebLiveSessionsDeps["store"];
  env?: Record<string, string | undefined>;
  allowApiKey?: boolean;
  now?: () => Date;
  ownerDeliveryTimeoutMs?: number;
  onEvent?: (event: SessionEvent) => void;
  spawnClaude?: WebLiveSessionsDeps["spawnClaude"];
  spawnWorker?: WebLiveSessionsDeps["spawnWorker"];
  codexCli?: WebLiveSessionsDeps["codexCli"];
  opencodeExe?: WebLiveSessionsDeps["opencodeExe"];
  openCodeRuntime?: WebLiveSessionsDeps["openCodeRuntime"];
  /** Test seam. Production uses the provider adapters below. */
  createConnection?: (profile: ManagedProviderConnectionProfile, context: ManagedProviderOwnerConnectionContext) => ManagedProviderConnection;
}

export interface ManagedProviderOwnerConnectionContext {
  readonly profile: ManagedProviderConnectionProfile;
  readonly sessionId: string;
  readonly token: string;
  readonly mcpConfigPath: string;
  readonly launcher: string;
  readonly prompt: string;
  readonly environment: Record<string, string | undefined>;
}

export type ManagedProviderOwner = SessionsPort & {
  close(): void;
  agents(): WebAgentConfig[];
  sessionIdOf(handle: string): string | undefined;
  deliverOwnerTask(taskId: string): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }>;
};

type ActiveTask = { taskId: string; kind: "owner" | "room" | "internal"; sessionId: string };
type PendingAcceptance = {
  resolve(result: { ok: true; sessionId: string } | { ok: false; error: string }): void;
  settled: boolean;
  timer?: ReturnType<typeof setTimeout>;
};

const ACTIVE_PROVIDER_STATUSES = new Set<ManagedProviderStatus>(["ready", "working", "starting", "paused", "draining"]);

function safeHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24);
}

function ownerSessionId(profile: ManagedProviderConnectionProfile): string {
  return `m9r-owner-${profile.handle}-${safeHash(profile.connectionId)}-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function killTree(child: { pid?: number; kill(): unknown }): void {
  if (process.platform === "win32" && child.pid) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill();
}

function defaultClaudeSpawn(command: string, args: string[], cwd: string) {
  const child: ChildProcess = nodeSpawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  child.stdin?.on("error", () => undefined);
  (child as unknown as { kill(): unknown }).kill = () => killTree(child);
  return child as never;
}

function defaultCodexSpawn(command: string, args: string[], options: { cwd: string; env: Record<string, string | undefined> }): CodexWorkerProcess {
  const child = nodeSpawn(command, args, { cwd: options.cwd, env: options.env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  (child as unknown as { kill(): unknown }).kill = () => killTree(child);
  return child as unknown as CodexWorkerProcess;
}

function sessionStatus(status: ManagedProviderStatus): SessionStatus {
  if (status === "ready") return "idle";
  if (status === "stopped") return "stopped";
  if (status === "failed") return "failed";
  if (status === "starting") return "starting";
  return "working";
}

function statusIsActive(status: ManagedProviderStatus | undefined): boolean {
  return status !== undefined && ACTIVE_PROVIDER_STATUSES.has(status);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isFreshTask(task: Task, now: () => Date): boolean {
  const created = Date.parse(task.createdAt);
  return Number.isFinite(created) && created <= now().getTime() && now().getTime() - created < inboxMaxAgeMs();
}

function contextForProfile(
  deps: ManagedProviderOwnerDeps,
  config: WebAgentConfig,
  profile: ManagedProviderConnectionProfile,
  teammates: string[],
  roomStartedAt: number,
): ManagedProviderOwnerConnectionContext {
  const directory = join(deps.storeRoot, "managed-provider-sessions", safeHash(profile.connectionId));
  const sessionId = ownerSessionId(profile);
  const token = deps.store.issueIdentity(profile.handle, profile.provider, sessionId).token;
  const { configPath, launcher } = writeWebMcpConfig(directory, {
    repoRoot: deps.repoRoot,
    storeRoot: deps.storeRoot,
    brokerPort: deps.brokerPort,
    roomStartedAt,
    provider: profile.provider,
    projectCwd: profile.cwd,
    sessionId,
  });
  const environment = {
    ...(deps.env ?? process.env),
    M9R_HOME: deps.storeRoot,
    M9R_WEB_BROKER_PORT: String(deps.brokerPort),
    M9R_ROOM_STARTED_AT: String(roomStartedAt),
    M9R_PROVIDER: profile.provider,
    M9R_PROJECT_ROOT: profile.cwd,
    M9R_PROVIDER_SESSION_ID: sessionId,
  };
  const prompt = `${webAgentPrompt(profile.handle, token, teammates, projectRoomId(deps.repoRoot))}\n\n${sharedProjectMemory(deps.storeRoot, projectRoomId(deps.repoRoot))}`;
  return { profile, sessionId, token, mcpConfigPath: configPath, launcher, prompt, environment };
}

function openCodeEnvironment(context: ManagedProviderOwnerConnectionContext): Record<string, string | undefined> {
  const xdg = join(dirname(context.mcpConfigPath), "xdg");
  mkdirSync(join(xdg, "opencode"), { recursive: true });
  const server = webMcpServerCommand(context.launcher);
  const disabledTools = Object.fromEntries([
    "bash", "edit", "write", "read", "grep", "glob", "list", "webfetch", "websearch", "task", "todowrite", "todoread", "patch", "codesearch", "skill",
  ].map((tool) => [tool, false]));
  writeFileSync(join(xdg, "opencode", "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    mcp: {
      m9r: {
        type: "local",
        command: [server.command, ...server.args],
        environment: {
          M9R_HOME: context.environment.M9R_HOME,
          M9R_WEB_BROKER_PORT: context.environment.M9R_WEB_BROKER_PORT,
          M9R_ROOM_STARTED_AT: context.environment.M9R_ROOM_STARTED_AT,
          M9R_PROVIDER: context.profile.provider,
          M9R_PROJECT_ROOT: context.profile.cwd,
          M9R_PROVIDER_SESSION_ID: context.sessionId,
        },
        enabled: true,
      },
    },
    tools: disabledTools,
  }));
  return {
    ...context.environment,
    XDG_CONFIG_HOME: xdg,
    XDG_DATA_HOME: join(xdg, "data"),
    XDG_CACHE_HOME: join(xdg, "cache"),
  };
}

function withIdentity(base: ManagedProviderConnection): ManagedProviderConnection {
  // Identity revocation belongs to owner shutdown, not a provider turn or a
  // temporary stop. This lets the same logical connection restart with the
  // same exact MCP identity and without rediscovering a provider session.
  return {
    profile: base.profile,
    start: (continuation) => base.start(continuation),
    send: (task) => base.send(task),
    cancel: (taskId) => base.cancel(taskId),
    pause: () => base.pause(),
    resume: () => base.resume(),
    status: () => base.status(),
    continuation: () => base.continuation(),
    drain: () => base.drain(),
    stop: () => base.stop(),
  };
}

export function createManagedProviderOwner(deps: ManagedProviderOwnerDeps): ManagedProviderOwner {
  const now = deps.now ?? (() => new Date());
  const env = deps.env ?? process.env;
  const roomStartedAt = now().getTime();
  const configs = new Map(deps.agents.map((config) => [config.handle, config] as const));
  const profiles = deps.agents.map((config) => normalizeManagedProviderProfile({
    handle: config.handle,
    provider: config.provider,
    cwd: config.folder,
    ...(config.connectionId ? { connectionId: config.connectionId } : {}),
    ...(config.model ? { model: config.model } : {}),
    ...(config.effort ? { effort: config.effort } : {}),
  }));
  const byHandle = new Map(profiles.map((profile) => [profile.handle, profile] as const));
  const contexts = new Map<string, ManagedProviderOwnerConnectionContext>();
  const connections = new Map<string, ManagedProviderConnection>();
  const active = new Map<string, ActiveTask>();
  const pendingAcceptance = new Map<string, PendingAcceptance>();
  const fenced = new Set<string>();
  const halted = { value: false };
  let closed = false;

  const emit = (event: SessionEvent): void => {
    try { deps.onEvent?.(event); } catch { /* UI listeners never own provider lifecycle. */ }
  };
  const emitState = (profile: ManagedProviderConnectionProfile): void => emit({ kind: "state", handle: profile.handle });
  const teammates = (profile: ManagedProviderConnectionProfile): string[] => profiles.filter((candidate) => candidate.handle !== profile.handle).map((candidate) => candidate.handle);

  const contextFor = (profile: ManagedProviderConnectionProfile): ManagedProviderOwnerConnectionContext => {
    const existing = contexts.get(profile.connectionId);
    if (existing) return existing;
    const config = configs.get(profile.handle);
    if (!config) throw new Error(`No configured agent exists for @${profile.handle}.`);
    const context = contextForProfile(deps, config, profile, teammates(profile), roomStartedAt);
    contexts.set(profile.connectionId, context);
    return context;
  };

  const createConnection = (profile: ManagedProviderConnectionProfile): ManagedProviderConnection => {
    const context = contextFor(profile);
    let connection: ManagedProviderConnection;
    if (deps.createConnection) connection = deps.createConnection(profile, context);
    else if (profile.provider === "claude-code") {
      const config = configs.get(profile.handle)!;
      connection = createClaudeManagedProviderConnection({
        profile,
        mcpConfigPath: context.mcpConfigPath,
        environment: context.environment,
        allowApiKey: deps.allowApiKey,
        profileMode: config.profile,
        appendSystemPrompt: context.prompt,
        model: profile.model,
        effort: profile.effort,
        allowedTools: config.allowedTools,
        spawn: deps.spawnClaude ?? defaultClaudeSpawn,
      });
    } else if (profile.provider === "codex") {
      const cli = (deps.codexCli ?? (() => codexCliPath(env)))();
      if (!cli) throw new Error("the Codex CLI was not found (set M9R_CODEX_CLI_JS)");
      const command = nodeForCodex(process.execPath, (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean), existsSync);
      const spawnWorker = deps.spawnWorker ?? defaultCodexSpawn;
      connection = createCodexManagedProviderConnection({
        profile,
        command,
        environment: context.environment,
        buildArgs: ({ task, continuation }) => [cli, ...codexWorkerArgs({
          prompt: `${CODEX_WEB_PREFACE}\n\nThe owner says:\n${task.prompt}`,
          folder: profile.cwd,
          launcher: context.launcher,
          storeRoot: deps.storeRoot,
          brokerPort: deps.brokerPort,
          roomStartedAt,
          threadId: continuation?.providerSessionRef,
          model: profile.model,
          effort: profile.effort,
          projectCwd: profile.cwd,
          sessionId: context.sessionId,
        })],
        spawnWorker,
      });
    } else if (profile.provider === "opencode") {
      const exe = (deps.opencodeExe ?? (() => opencodeExePath(env)))();
      if (!exe) throw new Error("OpenCode was not found (set M9R_OPENCODE_EXE)");
      const runtimeFactory = deps.openCodeRuntime;
      connection = createOpenCodeManagedProviderConnection({
        profile,
        exe,
        environment: openCodeEnvironment(context),
        missionId: projectRoomId(profile.cwd),
        ...(runtimeFactory ? { runtimeFactory: runtimeFactory as never } : {}),
      });
    } else {
      throw new Error(`No managed provider adapter is installed for ${profile.provider}.`);
    }
    const owned = withIdentity(connection);
    connections.set(profile.connectionId, owned);
    return owned;
  };

  const supervisor = createManagedProviderSupervisor({
    createConnection,
    continuationStore: createFileManagedProviderContinuationStore(join(deps.storeRoot, "managed-provider-continuations")),
  });

  function resolveProfile(handle: string): ManagedProviderConnectionProfile | undefined {
    return byHandle.get(handle.replace(/^@/, "").trim().toLowerCase());
  }

  function accept(taskId: string, result: { ok: true; sessionId: string } | { ok: false; error: string }): void {
    const waiter = pendingAcceptance.get(taskId);
    if (!waiter || waiter.settled) return;
    waiter.settled = true;
    if (waiter.timer) clearTimeout(waiter.timer);
    pendingAcceptance.delete(taskId);
    waiter.resolve(result);
  }

  function markQueued(profile: ManagedProviderConnectionProfile, taskId: string, kind: ActiveTask["kind"], context: ManagedProviderOwnerConnectionContext): void {
    if (kind === "owner") {
      const current = deps.store.getTask?.(taskId);
      const queued = deps.store.setDelivery?.(taskId, {
        state: "queued",
        attempts: current?.delivery?.attempts ?? 1,
        threadId: context.sessionId,
        queuedAt: now().toISOString(),
        correlation: "internal-context",
      });
      if (!queued || (!["queued", "done"].includes(queued.delivery?.state ?? "") && !queued.resultSummary)) {
        deps.store.setDelivery?.(taskId, {
          state: "uncertain",
          attempts: current?.delivery?.attempts ?? 1,
          threadId: context.sessionId,
          uncertainAt: now().toISOString(),
          correlation: "internal-context",
          error: "The provider prompt started, but M9R could not confirm the durable delivery receipt.",
        });
        accept(taskId, { ok: false, error: "M9R could not confirm the durable owner-delivery receipt." });
        throw new Error("M9R could not confirm the durable owner-delivery receipt.");
      }
      accept(taskId, { ok: true, sessionId: context.sessionId });
    } else if (kind === "room") {
      deps.store.markDelivered?.([taskId], context.sessionId);
    }
  }

  async function runTask(profile: ManagedProviderConnectionProfile, taskId: string, text: string, kind: ActiveTask["kind"]): Promise<void> {
    const context = contextFor(profile);
    if (active.has(profile.connectionId)) throw new Error(`@${profile.handle} is already handling another turn.`);
    const running: ActiveTask = { taskId, kind, sessionId: context.sessionId };
    active.set(profile.connectionId, running);
    let accepted = false;
    try {
      emitState(profile);
      const connection = await supervisor.ensureConnection(profile);
      emitState(profile);
      if (fenced.has(taskId)) {
        await connection.stop();
        throw new Error("The owner-delivery window expired before the provider accepted the task; M9R did not send it.");
      }
      const generation = connection.status().generation;
      const task = { taskId, connectionId: profile.connectionId, handle: profile.handle, provider: profile.provider, cwd: profile.cwd, generation, prompt: text } as const;
      for await (const event of supervisor.dispatch(task)) {
        // A status event only describes the adapter's local state. It is not a
        // receipt: OpenCode, for example, can report "working" before its ACP
        // prompt has been submitted. Accept only an explicit transport receipt
        // (or a result, which proves the provider accepted the turn).
        if (!accepted && (event.kind === "accepted" || event.kind === "result")) {
          markQueued(profile, taskId, kind, context);
          accepted = true;
        }
        if (event.kind === "accepted") continue;
        if (event.kind === "status") emitState(profile);
        else if (event.kind === "text") emit({ kind: "say", handle: profile.handle, provider: profile.provider, text: event.text });
        else if (event.kind === "tool") emit({ kind: "tool", handle: profile.handle, provider: profile.provider, name: event.name });
        else if (event.kind === "result") {
          emit({ kind: "result", handle: profile.handle, provider: profile.provider, text: event.text, isError: event.isError });
          if (kind === "owner" && !event.isError) {
            const result = deps.store.recordTaskResult?.(context.token, taskId, event.text);
            if (!result?.ok && !result?.alreadyRecorded) emit({ kind: "system", handle: profile.handle, provider: profile.provider, text: `M9R could not record ${taskId}: ${result?.error ?? "result storage is unavailable"}` });
          }
        } else if (event.kind === "error") {
          const reason = event.error || "provider execution failed";
          emit({ kind: "system", handle: profile.handle, provider: profile.provider, text: reason });
          if (kind === "owner" && !fenced.has(taskId)) {
            deps.store.setDelivery?.(taskId, { state: "failed", threadId: context.sessionId, failedAt: now().toISOString(), correlation: "internal-context", error: reason });
            deps.store.setResult?.(taskId, `Provider session failed: ${reason}`);
          } else if (kind === "room") {
            deps.store.setResult?.(taskId, `Provider session failed: ${reason}`);
          }
          accept(taskId, { ok: false, error: reason });
        }
      }
    } catch (error) {
      const reason = errorText(error);
      emit({ kind: "system", handle: profile.handle, provider: profile.provider, text: reason });
      const current = deps.store.getTask?.(taskId);
      if (kind === "owner" && !fenced.has(taskId) && current?.delivery?.state !== "uncertain") {
        deps.store.setDelivery?.(taskId, { state: "failed", threadId: context.sessionId, failedAt: now().toISOString(), correlation: "internal-context", error: reason });
        deps.store.setResult?.(taskId, `Provider session failed: ${reason}`);
      } else if (kind === "room") {
        deps.store.setResult?.(taskId, `Provider session failed: ${reason}`);
      }
      accept(taskId, { ok: false, error: reason });
    } finally {
      active.delete(profile.connectionId);
      fenced.delete(taskId);
      emitState(profile);
    }
  }

  function deliver(handle: string, text: string, taskId?: string): ReturnType<SessionsPort["deliver"]> {
    if (halted.value) return { ok: false, error: "The M9R owner supervisor is stopped." };
    const profile = resolveProfile(handle);
    if (!profile) return { ok: false, error: `no agent called @${handle}` };
    if (apiKeyLaunchBlock(env, deps.allowApiKey === true)) return { ok: false, error: apiKeyLaunchBlock(env, deps.allowApiKey === true)! };
    if (active.has(profile.connectionId)) return { ok: false, error: `@${profile.handle} is already handling another turn; M9R did not replace it.` };
    const id = taskId ?? `m9r-internal-${randomUUID()}`;
    const kind: ActiveTask["kind"] = taskId ? "room" : "internal";
    const context = contextFor(profile);
    const prompt = `${context.prompt}\n\nThe owner says:\n${text}`;
    void runTask(profile, id, prompt, kind);
    const current = supervisor.snapshots().find((snapshot) => snapshot.connectionId === profile.connectionId);
    return { ok: true, mode: statusIsActive(current?.status) ? "sent" : "started" };
  }

  async function deliverOwnerTask(taskId: string): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> {
    const task = deps.store.getTask?.(taskId);
    if (!/^T[0-9]{1,12}$/.test(taskId) || !task || task.id !== taskId) return { ok: false, error: "No matching M9R owner task was found." };
    if (task.from !== "you" || task.origin !== "human_typed" || task.delivery?.state !== "deferred" || task.resultSummary || task.deliveredAt || task.deliveredSession || task.targetSession) {
      return { ok: false, error: "Only fresh, approved, untargeted owner tasks can start a managed provider connection." };
    }
    if (!isFreshTask(task, now)) return { ok: false, error: "This owner task is stale and will not be replayed into a managed provider connection." };
    const profile = resolveProfile(task.to);
    if (!profile) return { ok: false, error: `No managed provider connection is configured for @${task.to}.` };
    if (task.cwd && normCwd(task.cwd) !== normCwd(profile.cwd)) return { ok: false, error: "This task belongs to a different project folder than the configured managed connection." };
    if (!deps.store.claimProviderDelivery || !deps.store.setDelivery || !deps.store.recordTaskResult || !deps.store.setResult) return { ok: false, error: "The managed provider owner lacks the required atomic task-state operations." };
    if (active.has(profile.connectionId)) return { ok: false, error: `@${profile.handle} is already handling another turn; M9R did not replace it.` };
    const context = contextFor(profile);
    const claimed = deps.store.claimProviderDelivery(taskId, context.token, { handle: profile.handle, provider: profile.provider, cwd: profile.cwd });
    if (!claimed) return { ok: false, error: "Another provider path already owns this task, or the task is no longer eligible." };
    const acceptance = new Promise<{ ok: true; sessionId: string } | { ok: false; error: string }>((resolve) => {
      const waiter: PendingAcceptance = { resolve, settled: false };
      waiter.timer = setTimeout(() => {
        fenced.add(taskId);
        const current = deps.store.getTask?.(taskId);
        deps.store.setDelivery?.(taskId, {
          state: "uncertain",
          attempts: current?.delivery?.attempts ?? 1,
          threadId: context.sessionId,
          uncertainAt: now().toISOString(),
          correlation: "internal-context",
          error: "Provider startup or prompt submission exceeded the owner-delivery window.",
        });
        accept(taskId, { ok: false, error: "The managed provider did not confirm receipt in time; M9R will not replay this task." });
      }, Math.max(1, Math.min(120_000, Math.floor(deps.ownerDeliveryTimeoutMs ?? 60_000))));
      waiter.timer.unref?.();
      pendingAcceptance.set(taskId, waiter);
    });
    const prompt = `The owner sent M9R task ${taskId}. Treat this as the active request. When finished, record the concise outcome with m9r_result for task ${taskId}.\n\n${task.goal}`;
    void runTask(profile, taskId, prompt, "owner");
    return acceptance;
  }

  async function bridgeOnce(): Promise<void> {
    if (halted.value || !deps.store.tasksFor || !deps.store.markDelivered) return;
    const sessionIds = new Set([...contexts.values()].map((context) => context.sessionId));
    for (const profile of profiles) {
      if (active.has(profile.connectionId)) continue;
      const candidate = deps.store.tasksFor(profile.handle).find((task) => task.origin === "agent_initiated"
        && task.fromSession && sessionIds.has(task.fromSession)
        && !task.deliveredAt && !task.dismissedAt && !task.resultSummary
        && (task.approval === "approved" || task.approval === "not_needed")
        && isFreshTask(task, now));
      if (!candidate) continue;
      if (candidate.approval === "pending") deps.store.setApproval?.(candidate.id, "approved");
      const fromContext = candidate.fromSession ? [...contexts.values()].find((context) => context.sessionId === candidate.fromSession) : undefined;
      if (!fromContext) continue;
      const prompt = `@${fromContext.profile.handle} messaged you (${candidate.id}): ${candidate.goal}\n\nAnswer with m9r_result for ${candidate.id}, in a sentence or two, so @${fromContext.profile.handle} sees it right away.`;
      deliver(profile.handle, prompt, candidate.id);
    }
  }

  const bridgeTimer = setInterval(() => { void bridgeOnce().catch(() => undefined); }, 700);
  bridgeTimer.unref?.();

  const owner: ManagedProviderOwner = {
    handles: () => profiles.map((profile) => profile.handle),
    snapshot: () => profiles.map((profile) => {
      const snapshot = supervisor.snapshots().find((entry) => entry.connectionId === profile.connectionId);
      return {
        handle: profile.handle,
        provider: profile.provider,
        folder: profile.cwd,
        status: sessionStatus(snapshot?.status ?? "ready"),
        doing: snapshot?.doing ?? "Ready",
      };
    }),
    deliver,
    stop(handle) {
      const profile = resolveProfile(handle);
      if (!profile) return false;
      const connection = connections.get(profile.connectionId);
      if (!connection) return false;
      const task = active.get(profile.connectionId);
      if (task) void connection.cancel(task.taskId).catch(() => undefined);
      void connection.stop().then(() => emitState(profile)).catch(() => undefined);
      return true;
    },
    stopAll() {
      halted.value = true;
      for (const profile of profiles) {
        const connection = connections.get(profile.connectionId);
        if (!connection) continue;
        const task = active.get(profile.connectionId);
        if (task) void connection.cancel(task.taskId).catch(() => undefined);
        void connection.stop().then(() => emitState(profile)).catch(() => undefined);
      }
    },
    secrets: () => [...contexts.values()].map((context) => context.token),
    close() {
      if (closed) return;
      closed = true;
      halted.value = true;
      clearInterval(bridgeTimer);
      void supervisor.stop().finally(() => {
        for (const context of contexts.values()) {
          try { deps.store.revokeIdentity(context.sessionId); } catch { /* shutdown is best effort */ }
        }
      });
    },
    agents: () => deps.agents.map((config) => ({ ...config })),
    sessionIdOf: (handle) => resolveProfile(handle) ? contextFor(resolveProfile(handle)!).sessionId : undefined,
    deliverOwnerTask,
  };
  return owner;
}
