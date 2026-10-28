import { spawn as nodeSpawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createClaudeManagedProviderConnection,
  createCodexAppServerManagedProviderConnection,
  createOpenCodeManagedProviderConnection,
} from "./managed-provider-adapters";
import {
  normalizeManagedProviderProfile,
  type ManagedProviderCapabilities,
  type ManagedProviderConnection,
  type ManagedProviderConnectionProfile,
  type ManagedProviderModelApply,
  type ManagedProviderStatus,
} from "./managed-provider-contract";
import { createFileManagedProviderContinuationStore, createManagedProviderSupervisor } from "./managed-provider-supervisor";
import { createFileManagedProviderModelSelectionStore, type ManagedProviderModelSelectionStore } from "./provider-model-selection-store";
import { validateProviderModelSelection, type ProviderModelSelection } from "./provider-model-core";
import { normCwd } from "./codex-delivery-core";
import { apiKeyLaunchBlock } from "./vendor-launch-core";
import {
  CODEX_WEB_PREFACE,
  opencodeExePath,
  projectRoomId,
  sharedProjectMemory,
  webAgentPrompt,
  webMcpServerCommand,
  writeWebMcpConfig,
  type WebAgentConfig,
  type WebLiveSessionsDeps,
} from "./web-live-sessions";
import { codexAppServerCommand } from "../bridge/codex-app-server-adapter";
import type { SessionEvent, SessionStatus, SessionsPort } from "./web-ui-bridge";
import { inboxMaxAgeMs, type StageTimingPhase, type Task } from "./inbox-core";
import { createLatencyTelemetry, type LatencyTelemetry, type LatencyTelemetrySnapshot, type LatencyTemperature } from "./latency-telemetry";
import { providerModelUiState, type ProviderModelUiState } from "./provider-model-picker";

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
  /** Visual-only owner cursor presentation. Durable task delivery never depends on this callback. */
  onOwnerTaskCreated?: (taskId: string) => void | Promise<void>;
  spawnClaude?: WebLiveSessionsDeps["spawnClaude"];
  spawnWorker?: WebLiveSessionsDeps["spawnWorker"];
  codexCli?: WebLiveSessionsDeps["codexCli"];
  opencodeExe?: WebLiveSessionsDeps["opencodeExe"];
  openCodeRuntime?: WebLiveSessionsDeps["openCodeRuntime"];
  /** Stable non-secret runtime/build identity used to invalidate readiness proofs after an update. */
  runtimeBuildFingerprint?: string;
  /** Optional injected bounded telemetry store; production creates one per owner. */
  latencyTelemetry?: LatencyTelemetry;
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
  /** Start every configured owner connection independently. One provider's
   * login/CLI failure must not prevent the broker or the other providers from
   * becoming usable. */
  start(): Promise<{ failures: Array<{ handle: string; error: string }> }>;
  /** Drain every owner connection before the broker closes its listener. */
  shutdown(): Promise<void>;
  close(): void;
  agents(): WebAgentConfig[];
  sessionIdOf(handle: string): string | undefined;
  /** Live, provider-reported model capabilities for the configured connections. */
  capabilities(handle?: string): readonly ManagedProviderCapabilities[];
  /** Persist and, when supported, apply a validated model choice for the next turn. */
  selectModel(handle: string, selection: ProviderModelSelection): Promise<ManagedProviderModelApply>;
  /** Bounded live model picker state for authenticated local UI consumers. */
  modelState(): ProviderModelUiState;
  deliverOwnerTask(taskId: string): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }>;
  latencySnapshot(): LatencyTelemetrySnapshot;
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

function timingStamp(value: number): string {
  return new Date(value).toISOString();
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

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Build only the M9R-owned app-server overrides. The authenticated Codex home
 * is deliberately inherited from the owner process: replacing CODEX_HOME with
 * an empty directory would make a valid user login look missing. These dotted
 * `-c` overrides are scoped to this app-server process, so they do not mutate
 * the user's Codex UI configuration and cannot make provider sessions the M9R
 * source of truth.
 */
function managedCodexAppServerArgs(context: ManagedProviderOwnerConnectionContext): string[] {
  const server = webMcpServerCommand(context.launcher);
  const mcpEnvironmentKeys = new Set([
    "M9R_HOME", "M9R_WEB_BROKER_PORT", "M9R_ROOM_STARTED_AT", "M9R_PROVIDER",
    "M9R_PROJECT_ROOT", "M9R_PROVIDER_SESSION_ID",
  ]);
  const mcpEnvironment = Object.entries(context.environment)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && mcpEnvironmentKeys.has(entry[0]))
    .sort(([left], [right]) => left.localeCompare(right));
  const disabledFeatures = [
    "computer_use", "browser_use", "browser_use_external", "browser_use_full_cdp_access",
    "in_app_browser", "in_app_local_automation", "apps", "plugins", "remote_plugin",
    "multi_agent", "image_generation", "view_image", "tool_suggest", "skill_search", "shell_tool",
  ];
  const mcp = `mcp_servers={m9r={command=${tomlString(server.command)},args=[${server.args.map(tomlString).join(", ")}],env={${mcpEnvironment.map(([key, value]) => `${key}=${tomlString(value)}`).join(",")}},default_tools_approval_mode="approve"}}`;
  const disabled = disabledFeatures.flatMap((feature) => ["-c", `features.${feature}=false`]);
  return ["app-server", "-c", mcp, "-c", 'web_search="disabled"', "-c", 'sandbox_mode="read-only"', ...disabled];
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
    readiness: () => base.readiness(),
    capabilities: () => base.capabilities(),
    applyModelSelection: (selection) => base.applyModelSelection(selection),
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
  const modelSelectionStore: ManagedProviderModelSelectionStore = createFileManagedProviderModelSelectionStore(join(deps.storeRoot, "managed-provider-model-selections"));
  const active = new Map<string, ActiveTask>();
  const pendingAcceptance = new Map<string, PendingAcceptance>();
  const fenced = new Set<string>();
  const halted = { value: false };
  const latencyTelemetry = deps.latencyTelemetry ?? createLatencyTelemetry();
  let closed = false;

  const emit = (event: SessionEvent): void => {
    try { deps.onEvent?.(event); } catch { /* UI listeners never own provider lifecycle. */ }
  };
  const emitState = (profile: ManagedProviderConnectionProfile): void => {
    const snapshot = connections.get(profile.connectionId)?.status();
    emit({ kind: "state", handle: profile.handle, ...(snapshot ? { status: sessionStatus(snapshot.status), doing: snapshot.doing } : {}) });
  };
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
      const appServer = codexAppServerCommand(env, process.platform, existsSync);
      connection = createCodexAppServerManagedProviderConnection({
        profile,
        command: appServer.command,
        args: managedCodexAppServerArgs(context),
        shell: appServer.shell,
        environment: {
          ...context.environment,
          // The app-server is the single M9R-owned process for this profile.
          // It may inherit the user's authenticated Codex home, but its M9R
          // identity and resumable thread are supplied only by this context.
          M9R_PROVIDER: "codex",
        },
        missionId: projectRoomId(profile.cwd),
        promptPrefix: CODEX_WEB_PREFACE,
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
    buildFingerprint: deps.runtimeBuildFingerprint ?? env.M9R_RUNTIME_BUILD_ID,
  });

  async function applyPersistedModelSelection(profile: ManagedProviderConnectionProfile, connection: ManagedProviderConnection): Promise<void> {
    const persisted = modelSelectionStore.load(profile.connectionId, profile);
    if (!persisted) return;
    const validation = validateProviderModelSelection(connection.capabilities(), persisted);
    if (!validation.ok) return;
    // A provider may expose a catalog but not a live reconfiguration method.
    // In that case the persisted choice remains durable for a later restart;
    // it never blocks startup or changes authentication/browser routing.
    await connection.applyModelSelection(validation.selection).catch(() => undefined);
  }

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

  /** Timing is diagnostic only; a broken state write must never change provider control flow. */
  function recordTurnTiming(taskId: string, phase: StageTimingPhase, startedMs: number, endedMs: number,
    status: "ok" | "error", detail?: string): void {
    try {
      deps.store.recordStageTiming?.(taskId, {
        phase,
        startedAt: timingStamp(startedMs),
        endedAt: timingStamp(Math.max(startedMs, endedMs)),
        durationMs: Math.max(0, endedMs - startedMs),
        status,
        operationId: taskId,
        ...(detail ? { detail } : {}),
      });
    } catch {
      // Timing is postmortem evidence, never a reason to fail or replay a task.
    }
  }

  async function runTask(profile: ManagedProviderConnectionProfile, taskId: string, text: string, kind: ActiveTask["kind"]): Promise<void> {
    const context = contextFor(profile);
    // Every provider turn gets a short-lived UI fence. The provider may emit
    // late events while a stop/restart is unwinding; tagging the live turn
    // prevents those fragments from being merged into a later turn from the
    // same agent while the active-task fence below drops them entirely.
    const runId = randomUUID();
    if (active.has(profile.connectionId)) throw new Error(`@${profile.handle} is already handling another turn.`);
    const running: ActiveTask = { taskId, kind, sessionId: context.sessionId };
    active.set(profile.connectionId, running);
    let accepted = false;
    let acceptanceRecorded = false;
    let firstVisibleAction = false;
    let completionRecorded = false;
    let terminalObserved = false;
    let dispatchStartedMs: number | undefined;
    let latencyTemperature: LatencyTemperature = "cold";
    const turnStartedMs = Date.now();
    let runtimeStartedMs = turnStartedMs;
    const storedTask = deps.store.getTask?.(taskId);
    const createdMs = storedTask ? Date.parse(storedTask.createdAt) : Number.NaN;
    if (Number.isFinite(createdMs) && createdMs <= turnStartedMs) {
      recordTurnTiming(taskId, "queue_wait", createdMs, turnStartedMs, "ok");
    }
    const recordCompletion = (status: "ok" | "error", detail?: string): void => {
      if (completionRecorded) return;
      completionRecorded = true;
      recordTurnTiming(taskId, "completion", turnStartedMs, Date.now(), status, detail);
      if (dispatchStartedMs !== undefined) {
        latencyTelemetry.record({
          kind: "action_completion",
          temperature: latencyTemperature,
          durationMs: Date.now() - dispatchStartedMs,
          status,
        });
      }
    };
    try {
      emitState(profile);
      runtimeStartedMs = Date.now();
      let connection: ManagedProviderConnection;
      try {
        const prior = supervisor.snapshots().find((candidate) => candidate.connectionId === profile.connectionId);
        latencyTemperature = prior && ["ready", "working", "paused"].includes(prior.status) ? "warm" : "cold";
        connection = await supervisor.ensureConnection(profile);
        recordTurnTiming(taskId, "runtime-acquire", runtimeStartedMs, Date.now(), "ok");
      } catch (error) {
        const detail = errorText(error);
        recordTurnTiming(taskId, "runtime-acquire", runtimeStartedMs, Date.now(), "error", detail);
        throw error;
      }
      emitState(profile);
      if (fenced.has(taskId)) {
        await connection.stop();
        throw new Error("The owner-delivery window expired before the provider accepted the task; M9R did not send it.");
      }
      const generation = connection.status().generation;
      const task = { taskId, connectionId: profile.connectionId, handle: profile.handle, provider: profile.provider, cwd: profile.cwd, generation, prompt: text } as const;
      const dispatchStart = Date.now();
      dispatchStartedMs = dispatchStart;
      for await (const event of supervisor.dispatch(task)) {
        // A stopped/replaced turn may still yield one queued provider event
        // while its transport is shutting down. Only the currently fenced
        // task may publish state, text, tools, or results into the pill.
        // Stop/stop-all fences the logical run before asking the provider to
        // cancel. A provider can still flush one queued event while its
        // transport is unwinding; that event must not reach the pill or close
        // a canceled task.
        if (fenced.has(taskId) || active.get(profile.connectionId)?.taskId !== taskId) continue;
        // A status event only describes the adapter's local state. It is not a
        // receipt: OpenCode, for example, can report "working" before its ACP
        // prompt has been submitted. Accept only an explicit transport receipt
        // (or a result, which proves the provider accepted the turn).
        if (!accepted && (event.kind === "accepted" || event.kind === "result")) {
          try {
            markQueued(profile, taskId, kind, context);
          } catch (error) {
            recordTurnTiming(taskId, "provider-acceptance", dispatchStart, Date.now(), "error", errorText(error));
            acceptanceRecorded = true;
            throw error;
          }
          recordTurnTiming(taskId, "provider-acceptance", dispatchStart, Date.now(), "ok");
          acceptanceRecorded = true;
          accepted = true;
        }
        if (event.kind === "accepted") continue;
        if (event.kind === "status") emitState(profile);
        else if (event.kind === "text") {
          if (!firstVisibleAction) {
            firstVisibleAction = true;
            recordTurnTiming(taskId, "first-visible-action", dispatchStart, Date.now(), "ok");
            latencyTelemetry.record({ kind: "dispatch_to_first_action", temperature: latencyTemperature, durationMs: Date.now() - dispatchStart, status: "ok" });
          }
          emit({ kind: "say", handle: profile.handle, provider: profile.provider, text: event.text, runId });
        } else if (event.kind === "tool") {
          if (!firstVisibleAction) {
            firstVisibleAction = true;
            recordTurnTiming(taskId, "first-visible-action", dispatchStart, Date.now(), "ok");
            latencyTelemetry.record({ kind: "dispatch_to_first_action", temperature: latencyTemperature, durationMs: Date.now() - dispatchStart, status: "ok" });
          }
          emit({ kind: "tool", handle: profile.handle, provider: profile.provider, name: event.name, runId });
        }
        else if (event.kind === "result") {
          terminalObserved = true;
          if (!firstVisibleAction) {
            firstVisibleAction = true;
            recordTurnTiming(taskId, "first-visible-action", dispatchStart, Date.now(), "ok");
            latencyTelemetry.record({ kind: "dispatch_to_first_action", temperature: latencyTemperature, durationMs: Date.now() - dispatchStart, status: event.isError ? "error" : "ok" });
          }
          emit({ kind: "result", handle: profile.handle, provider: profile.provider, text: event.text, isError: event.isError, runId });
          recordCompletion(event.isError ? "error" : "ok", event.isError ? "provider returned an error result" : undefined);
          if (kind === "owner" && !event.isError) {
            const result = deps.store.recordTaskResult?.(context.token, taskId, event.text);
            if (!result?.ok && !result?.alreadyRecorded) emit({ kind: "system", handle: profile.handle, provider: profile.provider, text: `M9R could not record ${taskId}: ${result?.error ?? "result storage is unavailable"}` });
          }
        } else if (event.kind === "error") {
          terminalObserved = true;
          const reason = event.error || "provider execution failed";
          recordCompletion("error", reason);
          emit({ kind: "system", handle: profile.handle, provider: profile.provider, text: reason, runId });
          if (kind === "owner" && !fenced.has(taskId)) {
            if (deps.store.recordTaskFailure) deps.store.recordTaskFailure(taskId, `Provider session failed: ${reason}`);
            else deps.store.setDelivery?.(taskId, { state: "failed", threadId: context.sessionId, failedAt: now().toISOString(), correlation: "internal-context", error: reason });
          } else if (kind === "room") {
            if (deps.store.recordTaskFailure) deps.store.recordTaskFailure(taskId, `Provider session failed: ${reason}`);
          }
          accept(taskId, { ok: false, error: reason });
        }
      }
    } catch (error) {
      terminalObserved = true;
      const reason = errorText(error);
      if (!acceptanceRecorded) {
        recordTurnTiming(taskId, "provider-acceptance", dispatchStartedMs ?? runtimeStartedMs, Date.now(), "error", reason);
        acceptanceRecorded = true;
      }
      recordCompletion("error", reason);
      if (!fenced.has(taskId)) emit({ kind: "system", handle: profile.handle, provider: profile.provider, text: reason, runId });
      const current = deps.store.getTask?.(taskId);
      if (kind === "owner" && !fenced.has(taskId) && current?.delivery?.state !== "uncertain") {
        if (deps.store.recordTaskFailure) deps.store.recordTaskFailure(taskId, `Provider session failed: ${reason}`);
        else deps.store.setDelivery?.(taskId, { state: "failed", threadId: context.sessionId, failedAt: now().toISOString(), correlation: "internal-context", error: reason });
      } else if (kind === "room") {
        if (deps.store.recordTaskFailure) deps.store.recordTaskFailure(taskId, `Provider session failed: ${reason}`);
      }
      accept(taskId, { ok: false, error: reason });
    } finally {
      if (!acceptanceRecorded) {
        recordTurnTiming(taskId, "provider-acceptance", dispatchStartedMs ?? runtimeStartedMs, Date.now(), "error", "provider ended before acceptance");
      }
      recordCompletion(!fenced.has(taskId) && terminalObserved ? "ok" : "error",
        fenced.has(taskId) ? "task was fenced before completion" : terminalObserved ? undefined : "provider ended without a terminal event");
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
    const context = contextFor(profile);
    let id = taskId;
    let kind: ActiveTask["kind"] = taskId ? "room" : "owner";
    if (!id) {
      // A direct owner-pill command is still governed M9R work. The managed
      // adapter must not receive a free-floating prompt: stage tools resolve
      // their omitted taskId from this durable record, and result recording
      // uses the same record to close the turn. The old internal UUID path
      // skipped the store entirely, which produced "no pending task ID" as
      // soon as Codex/Claude tried native desktop control.
      if (!deps.store.addTask || !deps.store.setDelivery || !deps.store.claimProviderDelivery) {
        return { ok: false, error: "M9R owner-task state is unavailable; the managed provider turn was not started." };
      }
      try {
        const created = deps.store.addTask({
          from: "you",
          to: profile.handle,
          goal: text,
          origin: "human_typed",
          cwd: profile.cwd,
          idempotencyKey: `owner:${profile.connectionId}:${Date.now()}:${randomUUID()}`,
        });
        id = created.task.id;
        // claimProviderDelivery requires the explicit deferred state. It then
        // binds the task to this exact owner-launched provider session before
        // the prompt can call any M9R MCP tool.
        deps.store.setDelivery(id, { state: "deferred" });
        const claimed = deps.store.claimProviderDelivery(id, context.token, {
          handle: profile.handle,
          provider: profile.provider,
          cwd: profile.cwd,
        });
        if (!claimed) {
          deps.store.setDelivery(id, { state: "failed", error: "M9R could not bind the owner task to its managed provider session." });
          return { ok: false, error: "M9R could not bind the owner task to its managed provider session." };
        }
        // The cursor is best effort and intentionally cannot veto delivery.
        void Promise.resolve(deps.onOwnerTaskCreated?.(id)).catch(() => undefined);
      } catch (error) {
        return { ok: false, error: errorText(error) };
      }
    }
    // `id` is a durable task for owner turns and an existing task for room
    // turns. The old no-task internal path is intentionally gone.
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
  let shutdownPromise: Promise<void> | undefined;

  function capabilitySnapshot(handle?: string): readonly ManagedProviderCapabilities[] {
    const selected = handle === undefined
      ? profiles
      : (() => {
          const profile = resolveProfile(handle);
          return profile ? [profile] : [];
        })();
    return selected.map((profile) => connections.get(profile.connectionId)?.capabilities() ?? {
      connectionId: profile.connectionId,
      provider: profile.provider,
      generation: 0,
      models: null,
      currentModel: profile.model ?? null,
      currentEffort: profile.effort ?? null,
    });
  }

  async function selectModel(handle: string, selection: ProviderModelSelection): Promise<ManagedProviderModelApply> {
    const profile = resolveProfile(handle);
    if (!profile) return { ok: false, applies: "next-restart", error: `no agent called @${handle}` };
    try {
      const connection = await supervisor.ensureConnection(profile);
      const validation = validateProviderModelSelection(connection.capabilities(), selection);
      if (!validation.ok) return { ok: false, applies: "next-restart", error: validation.reason };
      modelSelectionStore.save(profile.connectionId, profile, validation.selection);
      const applied = await connection.applyModelSelection(validation.selection);
      return applied.ok
        ? applied
        : { ok: true, applies: "next-restart", detail: `Selection persisted for the next restart; live apply was unavailable: ${applied.error}` };
    } catch (error) {
      return { ok: false, applies: "next-restart", error: errorText(error) };
    }
  }

  const owner: ManagedProviderOwner = {
    async start() {
      const failures: Array<{ handle: string; error: string }> = [];
      // A prior broker may have died after claiming a task but before the
      // provider acknowledged it. Fence those claims before any new provider
      // connection is started; never replay them automatically.
      try { deps.store.reconcileStaleDeliveries?.(); } catch (error) {
        emit({ kind: "system", handle: "m9r", provider: "m9r", text: `M9R could not reconcile stale provider deliveries: ${errorText(error)}` });
      }
      // Do not use supervisor.restore() here: its all-or-nothing contract is
      // correct for a transactional restore, but the desktop broker must keep
      // Claude, Codex, and OpenCode isolated at startup. A missing login or
      // provider executable is a per-connection failure, not a broker failure.
      await Promise.all(profiles.map(async (profile) => {
        try {
          const connection = await supervisor.ensureConnection(profile);
          await applyPersistedModelSelection(profile, connection);
          emitState(profile);
        } catch (error) {
          const reason = errorText(error);
          failures.push({ handle: profile.handle, error: reason });
          emit({ kind: "system", handle: profile.handle, provider: profile.provider, text: reason });
          emitState(profile);
        }
      }));
      return { failures };
    },
    handles: () => profiles.map((profile) => profile.handle),
    modelState: () => providerModelUiState(capabilitySnapshot(), supervisor.snapshots()),
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
      if (task) {
        fenced.add(task.taskId);
        deps.store.cancelTask?.(task.taskId, "Task canceled by the owner.");
        accept(task.taskId, { ok: false, error: "Task canceled by the owner." });
        void connection.cancel(task.taskId).catch(() => undefined);
      }
      void connection.stop().then(() => emitState(profile)).catch(() => undefined);
      return true;
    },
    stopAll() {
      halted.value = true;
      for (const profile of profiles) {
        const connection = connections.get(profile.connectionId);
        if (!connection) continue;
        const task = active.get(profile.connectionId);
        if (task) {
          fenced.add(task.taskId);
          deps.store.cancelTask?.(task.taskId, "All provider tasks canceled by the owner.");
          accept(task.taskId, { ok: false, error: "All provider tasks canceled by the owner." });
          void connection.cancel(task.taskId).catch(() => undefined);
        }
        void connection.stop().then(() => emitState(profile)).catch(() => undefined);
      }
    },
    async shutdown() {
      if (shutdownPromise) return shutdownPromise;
      closed = true;
      halted.value = true;
      clearInterval(bridgeTimer);
      shutdownPromise = (async () => {
        // Shutdown is also a task-wide stop boundary. Fence and cancel the
        // durable task before draining provider transports so no late event
        // from an app close can complete work after the owner has gone away.
        for (const task of active.values()) {
          fenced.add(task.taskId);
          deps.store.cancelTask?.(task.taskId, "All provider tasks canceled by shutdown.");
          accept(task.taskId, { ok: false, error: "All provider tasks canceled by shutdown." });
        }
        await supervisor.stop();
        for (const context of contexts.values()) {
          try { deps.store.revokeIdentity(context.sessionId); } catch { /* shutdown is best effort */ }
        }
      })();
      return shutdownPromise;
    },
    secrets: () => [...contexts.values()].map((context) => context.token),
    close() {
      void owner.shutdown();
    },
    agents: () => deps.agents.map((config) => ({ ...config })),
    sessionIdOf: (handle) => resolveProfile(handle) ? contextFor(resolveProfile(handle)!).sessionId : undefined,
    capabilities: capabilitySnapshot,
    selectModel,
    deliverOwnerTask,
    latencySnapshot: () => latencyTelemetry.snapshot(),
  };
  return owner;
}
