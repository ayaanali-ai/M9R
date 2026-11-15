import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { StageCaptureRefreshError, StageInputNotDispatchedError, StageAuthorizationError, StageValidationError } from "./stage-errors";
import { DesktopInputNotDispatchedError } from "./desktop-input-errors";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { renameStateFile } from "./atomic-file";
import { isAgentContext } from "./approval-core";
import { normalizeHandle, type StageTimingPhase } from "./inbox-core";
import type { LocalStore } from "./local-store";
import { createWindowsDesktopStageManager, type WindowsStageDependencies } from "./windows-desktop-stage";
import { createCuaStageDriver, type CuaAgentCursorIdentity } from "./cua-stage-driver";
import { parseTaskStageAction, runTaskStageAction, stageClickNeedsApproval } from "./task-stage-actions";
import type { StageApprovalRequest } from "./web-broker-core";
import {
  desktopMutationTarget,
  desktopWindowMutationTarget,
  type MutationFenceTransaction,
  type MultiplayerDispatchFence,
} from "./multiplayer-dispatch-fence";
import {
  launchStageApp,
  ownedBrowserLaunch,
  resolveUnlistedStageApp,
  resolveStageLaunchApp,
  selectPersonalBrowserWindow,
  selectExistingPersonalBrowserWindow,
  selectTargetAppWindow,
  hasAmbiguousExistingPersonalBrowserWindow,
  stageAppLaunchCwd,
  stageBrowserKind,
  stageWindowMatchesApp,
  type BrowserWindowCandidate,
  type StageAppLaunchSpec,
} from "./task-stage-apps";
import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { discoverInstalledWindowsApp, discoverInstalledWindowExecutable } from "./windows-installed-apps";
import { createBrowserSpaceLedger, type BrowserSpaceLedger } from "./browser-space-ledger";
import { agentInputStreamId, createAgentInputStreams, type InputStreamContext, type InputStreamIdentity } from "./agent-input-stream";
import { uniqueActiveCursorIdentity } from "./multiplayer-cursor-chatter";
import { createOwnerWorkPolicy } from "./owner-work-mode";

export const TASK_STAGE_POLICY_FILE = "task-stage-policy.json";
export type TaskStageMode = "background" | "owner-preview";

/**
 * Result of the delivery-time visual cursor prime.  This is deliberately a
 * small, non-sensitive result: provider sessions must never receive session
 * ids, Cua session names, or broker credentials just because a cursor was
 * requested.
 */
export interface AgentCursorPrimeResult {
  shown: boolean;
  agent?: string;
  reason?: string;
}

/** Legacy policy values are parsed for migration but ignored for enabled agents. */
export type TaskStageAccessMode = "full" | "scoped" | "request";
const ACCESS_MODES: readonly TaskStageAccessMode[] = ["full", "scoped", "request"];

function stageMode(value: unknown): TaskStageMode {
  if (value === undefined || value === "owner-preview") return "owner-preview";
  if (value === "background") return "background";
  throw new Error("Invalid task stage mode.");
}

/**
 * Same-intent owner-preview work belongs to one logical window group even when
 * different provider sessions receive the request.  Keep the raw goal out of
 * the registry and derive a stable local key instead.  Background stages are
 * deliberately excluded: they are isolated by design.
 */
function stageCoordinationKey(goal: string): string {
  const normalized = goal.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 2_000);
  return createHash("sha256").update(`owner-preview\0${normalized}`).digest("hex");
}

/**
 * Coalesce duplicate launches only when agents share both the same task intent
 * and the same app. The intent key alone is not an execution lock: agents may
 * launch independent apps for one multiplayer task at the same time.
 */
export function ownerPreviewLaunchQueueKey(goal: string, appId: string): string {
  const coordinationKey = stageCoordinationKey(goal);
  const appKey = createHash("sha256").update(appId.trim().toLowerCase()).digest("hex");
  return `owner-preview-launch:${coordinationKey}:${appKey}`;
}

/**
 * `inspectStage`'s "anchor is unavailable" message is the one case where the native
 * helper actually could not find the window at all -- genuinely closed or crashed.
 * Every other inspectStage failure (a helper timeout or malformed response) means
 * the window may well still be alive; treating those as "gone" and relaunching a
 * replacement left a needless second instance running alongside a perfectly live one.
 */
function isStageWindowGoneError(error: unknown): boolean {
  return error instanceof Error && /anchor is unavailable/i.test(error.message);
}

export function setTaskStagePermission(root: string, handle: string, enabled: boolean, context: { terminal: boolean; env: Record<string, string | undefined> }, control = false, mode?: TaskStageAccessMode) {
  if (!context.terminal || isAgentContext(context.env)) throw new Error("Only the owner can change agent stage permissions.");
  handle = normalizeHandle(handle);
  if (!/^[a-z0-9_-]{1,40}$/.test(handle)) throw new Error("Invalid agent handle.");
  if (mode !== undefined && !ACCESS_MODES.includes(mode)) throw new Error("Invalid stage access mode.");
  mkdirSync(root, { recursive: true });
  const file = join(root, TASK_STAGE_POLICY_FILE);
  const lock = `${file}.lock`;
  // Same bug, same fix as the Windows stage registry lock: no PID, no age limit,
  // no staleness check meant a process killed while holding this lock (a forced
  // restart, in particular) broke every future permission change until someone
  // deleted the lock directory by hand, with only a raw EEXIST error to show for
  // it. Self-heal a lock old enough to be certain nothing legitimate still holds it.
  try {
    mkdirSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let ageMs: number;
    try { ageMs = Date.now() - statSync(lock).mtimeMs; } catch { ageMs = Infinity; }
    if (ageMs < 30_000) throw new Error("Another stage permission change is already running; retry after it finishes.");
    try { rmSync(lock, { recursive: true, force: true }); } catch { /* another process may have just cleared it too; proceed to retry regardless */ }
    try {
      mkdirSync(lock);
    } catch (retryError) {
      if ((retryError as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Another stage permission change is already running; retry after it finishes.");
      throw retryError;
    }
  }
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    const policy = readTaskStagePolicy(root);
    const handles = policy.handles.filter((value) => value !== handle);
    const controlHandles = (policy.controlHandles ?? []).filter((value) => value !== handle);
    const modes = { ...(policy.modes ?? {}) } as Record<string, TaskStageAccessMode>;
    delete modes[handle];
    // App catalog/request modes are legacy. Keep reading them so existing policy
    // files migrate safely, but new grants only store agent access and control.
    if (enabled) {
      handles.push(handle);
      if (control || policy.controlHandles?.includes(handle)) controlHandles.push(handle);
      if (mode === "full" && !controlHandles.includes(handle)) controlHandles.push(handle);
    }
    if (handles.length > 16) throw new Error("At most 16 agents may use task stages.");
    const sortedModes: Record<string, TaskStageAccessMode> = {};
    for (const key of Object.keys(modes).sort()) sortedModes[key] = modes[key]!;
    const serializedPolicy = JSON.stringify({ version: 1, handles: handles.sort(), controlHandles: controlHandles.sort(), ...(Object.keys(sortedModes).length ? { modes: sortedModes } : {}) }) + "\n";
    // Repeated grants are common during task setup. Avoid replacing an identical
    // policy file: on Windows, a needless rename can collide with a short-lived
    // reader and fail with EPERM.
    if (existsSync(file) && readFileSync(file, "utf8") === serializedPolicy) return { handles };
    writeFileSync(temporary, serializedPolicy, { mode: 0o600, flag: "wx" });
    renameStateFile(temporary, file);
    return { handles };
  } finally {
    rmSync(temporary, { force: true });
    rmSync(lock, { recursive: true, force: true });
  }
}

type TaskStagePolicy = { handles: string[]; controlHandles?: string[]; modes?: Record<string, TaskStageAccessMode> };
// This is read synchronously on every single stage input action (click, type,
// drag, scroll, ...), not just occasionally -- an uncached readFileSync +
// JSON.parse on every action is the same class of bug as local-store.ts's
// readState() before its mtime+size cache fix earlier this session. The
// policy is owner-written and changes rarely, so cache it keyed by an
// mtime+size fingerprint and only re-read/re-parse when the file actually
// changed. The returned object is read-only everywhere it is used (property
// reads and .includes() checks, never mutated), so it is safe to hand back
// the same cached object on a hit.
let cachedTaskStagePolicyRoot: string | undefined;
let cachedTaskStagePolicyFingerprint: string | undefined;
let cachedTaskStagePolicy: TaskStagePolicy | undefined;

/** Owner-written policy. A task approval alone never grants computer access. */
export function readTaskStagePolicy(root: string): TaskStagePolicy {
  const file = join(root, TASK_STAGE_POLICY_FILE);
  let stat: ReturnType<typeof statSync>;
  try { stat = statSync(file); }
  catch {
    cachedTaskStagePolicyRoot = undefined;
    cachedTaskStagePolicyFingerprint = undefined;
    cachedTaskStagePolicy = undefined;
    return { handles: [] };
  }
  const fingerprint = `${stat.mtimeMs}:${stat.size}`;
  if (cachedTaskStagePolicyRoot === root && cachedTaskStagePolicyFingerprint === fingerprint && cachedTaskStagePolicy) {
    return cachedTaskStagePolicy;
  }
  const raw = readFileSync(file, "utf8");
  if (Buffer.byteLength(raw) > 4096) throw new Error("Stage permission settings exceed their size limit.");
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid stage permission settings.");
  const policy = value as { version?: unknown; handles?: unknown; controlHandles?: unknown; modes?: unknown };
  if (policy.version !== 1 || !Array.isArray(policy.handles) || policy.handles.length > 16
    || policy.handles.some((handle) => typeof handle !== "string" || !/^[a-z0-9_-]{1,40}$/.test(handle))) {
    throw new Error("Invalid stage permission settings.");
  }
  const handles = [...new Set(policy.handles as string[])];
  if (policy.controlHandles !== undefined && (!Array.isArray(policy.controlHandles) || policy.controlHandles.length > 16
    || policy.controlHandles.some((handle) => typeof handle !== "string" || !handles.includes(handle)))) throw new Error("Invalid stage control permissions.");
  let modes: Record<string, TaskStageAccessMode> | undefined;
  if (policy.modes !== undefined) {
    if (!policy.modes || typeof policy.modes !== "object" || Array.isArray(policy.modes)
      || Object.keys(policy.modes).length > 16
      || Object.entries(policy.modes).some(([handle, mode]) => !handles.includes(handle) || !ACCESS_MODES.includes(mode as TaskStageAccessMode))) {
      throw new Error("Invalid stage access modes.");
    }
    modes = { ...(policy.modes as Record<string, TaskStageAccessMode>) };
  }
  return { handles, ...(Array.isArray(policy.controlHandles) && policy.controlHandles.length ? { controlHandles: [...new Set(policy.controlHandles as string[])] } : {}), ...(modes && Object.keys(modes).length ? { modes } : {}) };
}

/** Enabled agents can resolve any installed app; the owner grant is per agent, never per app. */
export function stageAccessMode(policy: { handles: string[]; modes?: Record<string, TaskStageAccessMode> }, handle: string): TaskStageAccessMode {
  const normalized = normalizeHandle(handle);
  if (!policy.handles.includes(normalized)) return "scoped";
  return "full";
}

export interface StageLaunchTarget { app: StageAppLaunchSpec }

interface StageLaunchResult {
  name?: string;
  taskId?: string;
  appId?: string;
  running?: boolean;
  reused?: boolean;
  foregroundConfirmed?: boolean;
  view?: "app";
  capture?: unknown;
  operationReceipt?: { operationId?: string; status: "already_applied" | "in_progress" | "applied" | "uncertain"; updatedAt?: string; driverReturned?: boolean };
  actionExecuted?: boolean;
  nextStep?: string;
}

/** Resolve an installed executable after the one-time agent computer-control grant. */
export function resolveLaunchTarget(policy: { handles: string[]; modes?: Record<string, TaskStageAccessMode> }, handle: string, appId: string, opts: { env?: Record<string, string | undefined>; exists?: (path: string) => boolean } = {}): StageLaunchTarget {
  if (stageAccessMode(policy, handle) !== "full") throw new Error("This agent has not been granted task-stage access.");
  return { app: resolveUnlistedStageApp(appId, { allowAbsolutePath: true, ...(opts.env ? { env: opts.env } : {}), ...(opts.exists ? { exists: opts.exists } : {}) }) };
}

/** This service belongs to the owner-launched broker, never an agent's MCP child process. */
export function createTaskDesktopStageService(input: {
  store: LocalStore;
  stage?: WindowsStageDependencies;
  /**
   * Reuse an already-created broker stage manager when a caller owns one
   * (for example the owner-proof harness). Production creates the manager
   * here and therefore owns its native helper lifecycle.
   */
  manager?: ReturnType<typeof createWindowsDesktopStageManager>;
  readPolicy?: () => { handles: string[]; controlHandles?: string[]; modes?: Record<string, TaskStageAccessMode> };
  /** Test seam: replaces the Cua driver (production always constructs the real one). */
  driver?: ReturnType<typeof createCuaStageDriver>;
  /** Test seam for harmless local fixtures with fixed launch arguments. */
  resolveStageAppForTest?: (appId: string) => StageAppLaunchSpec;
  /** Read-only OS identity evidence for launcher/renderer delegation. */
  resolveWindowExecutable?: (executable: string) => Promise<string | undefined>;
  /**
   * Owner-approval route for the money carve-out, resolved lazily because the broker that owns the
   * approval list is constructed after this service. Absent in tests and in brokers without one.
   */
  approvals?: () => { requestApproval(request: StageApprovalRequest): Promise<boolean> } | undefined;
  /**
   * The same owner-broker fence the browser route uses. It closes the gap the
   * per-operation stage receipt cannot: two different operations aimed at one
   * verified HWND must contend on one lease. Absent keeps the current behavior.
   */
  mutationFence?: MultiplayerDispatchFence;
  /** Test seam: overrides the stuck-task cursor safety net's bound (production default is 30 minutes). */
  cursorMaxLifetimeMsForTest?: number;
}) {
  const root = input.store.root;
  const ownerWorkPolicy = createOwnerWorkPolicy(root, () => input.approvals?.(), { isTaskActive: (taskId) => {
    const task = input.store.getTask(taskId);
    return Boolean(task) && task!.resultSummary === undefined && task!.receipt?.state !== "canceled"
      && task!.receipt?.state !== "paused" && task!.delivery?.state !== "done"
      && task!.lifecycle?.state !== "completed" && task!.lifecycle?.state !== "failed";
  }, onTaskRevoked: (owner, leaseKey) => {
    const streamId = agentInputStreamId({ handle: owner.agent, sessionId: owner.sessionId });
    void manager.releaseOwnerInputMonitor(leaseKey, streamId).catch(() => {
      // Revocation remains effective in policy even if the OS monitor needs the
      // helper to exit; closing the stream/task tears down its hook as fallback.
    });
  }, onAuthorizationDecision: (event) => {
    // This receipt closes the evidence gap between a foreground request and a
    // subsequent action: it records whether approval was new, reused, refused,
    // or invalidated. It contains only bounded operation labels and policy
    // reasons; never a window handle, title, input text, or provider payload.
    const endedMs = Date.now();
    recordStageTiming(event.taskId, {
      phase: "foreground-lease",
      startedAt: new Date(endedMs - event.durationMs).toISOString(),
      endedAt: new Date(endedMs).toISOString(),
      durationMs: event.durationMs,
      status: event.status,
      ...(event.operationId ? { operationId: event.operationId } : {}),
      ...(event.stageName ? { stageName: event.stageName } : {}),
      detail: `authorization=${event.decision};operation=${event.operation};reason=${event.reason}`,
    });
  } });
  const browserSpaces: BrowserSpaceLedger = createBrowserSpaceLedger(root);
  function bindBrowserSpace(stageName: string, executable: string, pid: number, windowId: string): void {
    const browser = stageBrowserKind(executable);
    if (!browser) return;
    // A space is a durable logical label for one exact owner-profile HWND;
    // it never selects a different window on recovery.
    browserSpaces.bind({ spaceId: `space-${stageName}`, stageName, browser, pid, windowId });
  }
  const bundledHost = join(dirname(process.execPath), "m9r-native-input-host.exe");
  // A window host like explorer.exe or chrome.exe outlives any one task, so a dead-process
  // check alone never frees a finished task's claim on it (see assertWindowUnclaimed()).
  // This mirrors the exact same "is this task still unfinished" check resolveCursorTarget()
  // already uses to decide whether a task may still receive a delivered agent cursor.
  const taskActive = (taskId: string): boolean => {
    const task = input.store.getTask(taskId);
    // "failed"/"uncertain"/"paused" are receipt outcomes the system itself has already decided
    // are done -- RECEIPT_TRANSITIONS (inbox-core.ts) only ever lets "uncertain" and "paused" move
    // on to "completed"/"canceled", never back to active work, and retireStaleTasks closes an
    // unresolved receipt out as "uncertain" for exactly this reason ("it can no longer ever be
    // resolved"). Confirmed live on 2026-11-13 (task T296): none of those three stopped this check
    // from returning true, so a task left in one of them kept its cursor/window claim until the
    // unrelated 30-minute CURSOR_MAX_LIFETIME_MS backstop, not when the task actually stopped
    // progressing. "retryable" is deliberately left out -- it can still be re-dispatched.
    return Boolean(task) && task!.resultSummary === undefined
      && task!.lifecycle?.state !== "completed" && task!.lifecycle?.state !== "failed"
      && !["canceled", "failed", "uncertain", "paused"].includes(task!.receipt?.state ?? "");
  };
  const stageDeps = { nativeHostPath: existsSync(bundledHost) ? bundledHost : undefined, taskActive, ...input.stage, root, terminal: true };
  const ownsManager = !input.manager;
  const manager = input.manager ?? createWindowsDesktopStageManager({ ...stageDeps, sharedWindowFence: input.mutationFence });
  let nativeStageWarmPromise: Promise<void> | undefined;
  const warmNativeStageHost = (): Promise<void> => {
    if (isAgentContext(stageDeps.env ?? process.env)) return Promise.resolve();
    // An injected native transport is already owned by its caller (and is
    // commonly a deterministic test seam). Only warm the manager's bundled
    // persistent helper; sending an unsolicited ping through an injected
    // transport can itself be an observable desktop operation.
    if (stageDeps.invokeNative) return Promise.resolve();
    if (typeof manager.warm !== "function") return Promise.resolve();
    if (!nativeStageWarmPromise) {
      nativeStageWarmPromise = manager.warm().catch((error) => {
        nativeStageWarmPromise = undefined;
        throw error;
      });
    }
    return nativeStageWarmPromise;
  };
  if (ownsManager && stageDeps.nativeHostPath && !isAgentContext(stageDeps.env ?? process.env)) {
    // Start the persistent helper during broker initialization so the first
    // owner task does not pay process startup and UIA DLL load latency.
    void warmNativeStageHost().catch((error) => {
      process.stderr.write(`[native-stage-host-warm] ${error instanceof Error ? error.message : String(error)}\n`);
    });
  }
  const activeTimingTasks = new Map<string, { taskId: string; operationId?: string }>();
  const driver = input.driver ?? createCuaStageDriver({
    stage: stageDeps,
    manager,
    // Keep the next live latency trace phase-correlated without logging
    // provider tokens, task text, or session identifiers. This is diagnostic
    // only; it must never affect stage control or recovery.
    onTiming: (event) => {
      process.stderr.write(`[stage-timing] ${JSON.stringify(event)}\n`);
      const activeTimingTask = event.stageName ? activeTimingTasks.get(event.stageName) : undefined;
      if (!activeTimingTask) return;
      recordStageTiming(activeTimingTask.taskId, {
        phase: event.phase,
        startedAt: event.startedAt,
        endedAt: event.endedAt,
        durationMs: event.durationMs,
        status: event.status,
        ...(activeTimingTask.operationId ? { operationId: activeTimingTask.operationId } : {}),
        ...(event.stageName ? { stageName: event.stageName } : {}),
        ...(event.cached === undefined ? {} : { cached: event.cached }),
        ...(event.detail ? { detail: event.detail } : {}),
      });
    },
  });
  const activeInputs = new Map<string, { controller: AbortController; taskId: string }>();
  const inputStreams = createAgentInputStreams();
  const stoppedTaskInputs = new Set<string>();
  const listVisibleWindows = async () => {
    try {
      const native = await manager.listVisibleWindows();
      return native.map((window) => ({
        pid: window.pid,
        windowId: window.windowId,
        // Match the owning process image, not only the Win32 class. UWP
        // views are commonly hosted by ApplicationFrameHost.exe while their
        // top-level class is only ApplicationFrameWindow.
        appName: window.processName ?? window.className ?? "",
        processPath: window.processPath ?? undefined,
        appUserModelId: window.appUserModelId ?? undefined,
        zOrder: window.zOrder,
        title: window.title,
        width: window.width,
        height: window.height,
        isOnScreen: true,
        minimized: false,
      }));
    } catch (error) {
      // App launch matching must use one authoritative identity source. The
      // retired Cua inventory does not expose the packaged app identity and
      // can turn generic ApplicationFrameHost HWNDs into false candidates.
      // Surface native inventory failure instead of silently mixing engines.
      throw new Error(`Native Windows window inventory failed; no app window was selected from a fallback inventory. ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  };
  const windowIdentityKey = (window: { pid: number; windowId: string }) => `${window.pid}:${window.windowId.toLowerCase()}`;
  const readPolicy = input.readPolicy ?? (() => readTaskStagePolicy(root));
  // Serialize preparations so duplicate deliveries cannot create duplicate desktops --
  // but ONE queue per stage name, not one for the whole broker. A single shared queue
  // meant any agent's up-to-55s money-gate owner-approval wait, or any agent's up-to-60-
  // attempt launch poll, stalled every OTHER agent's and session's queued action behind
  // it, often past the 70s client timeout. `name` already partitions identity/session
  // (see authorize()), so queuing per name keeps the original duplicate-desktop
  // protection for one stage while letting unrelated stages run fully concurrently.
  const stageQueues = new Map<string, Promise<unknown>>();
  function enqueueStage<T>(name: string, run: () => Promise<T>): Promise<T> {
    const previous = stageQueues.get(name) ?? Promise.resolve();
    const result = previous.then(run, run);
    stageQueues.set(name, result.catch(() => undefined));
    return result;
  }

  /**
   * Durable timing is intentionally orthogonal to the driver timing logger. The latter is useful
   * for a live diagnostic, while these events let a later result reconcile queue and execution
   * phases from the task record after the broker has gone away. A timing write is never allowed to
   * change the action's outcome.
   */
  function recordStageTiming(taskId: string, event: {
    phase: StageTimingPhase;
    startedAt: string;
    endedAt: string;
    durationMs: number;
    status: "ok" | "error";
    operationId?: string;
    stageName?: string;
    detail?: string;
  }): void {
    try { input.store.recordStageTiming(taskId, event); } catch { /* telemetry must not alter control flow */ }
  }

  async function withActiveTimingTask<T>(stageName: string, taskId: string, operationId: string | undefined, run: () => Promise<T>): Promise<T> {
    const prior = activeTimingTasks.get(stageName);
    activeTimingTasks.set(stageName, { taskId, ...(operationId ? { operationId } : {}) });
    try { return await run(); }
    finally {
      if (prior === undefined) activeTimingTasks.delete(stageName);
      else activeTimingTasks.set(stageName, prior);
    }
  }

  async function timedStagePhase<T>(taskId: string, phase: Exclude<StageTimingPhase, "queue_wait">,
    operationId: string | undefined, run: () => Promise<T>): Promise<T> {
    const startedMs = Date.now();
    const startedTick = performance.now();
    const startedAt = new Date(startedMs).toISOString();
    try {
      const result = await run();
      const endedMs = Date.now();
      recordStageTiming(taskId, { phase, operationId, startedAt, endedAt: new Date(endedMs).toISOString(),
        durationMs: performance.now() - startedTick, status: "ok" });
      return result;
    } catch (error) {
      const endedMs = Date.now();
      recordStageTiming(taskId, { phase, operationId, startedAt, endedAt: new Date(endedMs).toISOString(), durationMs: performance.now() - startedTick,
        status: "error", detail: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  function enqueueTimedStage<T>(name: string, taskId: string, phase: Exclude<StageTimingPhase, "queue_wait" | "stop">,
    operationId: string | undefined, run: () => Promise<T>, timingStageName = name): Promise<T> {
    const requestedMs = Date.now();
    const requestedTick = performance.now();
    return enqueueStage(name, async () => {
      const dequeuedMs = Date.now();
      recordStageTiming(taskId, { phase: "queue_wait", startedAt: new Date(requestedMs).toISOString(), endedAt: new Date(dequeuedMs).toISOString(),
        durationMs: performance.now() - requestedTick, status: "ok", operationId });
      return withActiveTimingTask(timingStageName, taskId, operationId, () => timedStagePhase(taskId, phase, operationId, run));
    });
  }

  function inInputStream<T>(identity: InputStreamIdentity & { provider?: string }, taskId: string, kind: string,
    run: (context: InputStreamContext) => Promise<T>, correlation?: { stageName?: string; operationId?: string }): Promise<T> {
    return inputStreams.run(identity, { taskId, kind }, async (context) => {
      recordStageTiming(taskId, { phase: "queue_wait", startedAt: new Date(context.queuedAt).toISOString(),
        endedAt: new Date(context.startedAt).toISOString(), durationMs: context.startedAt - context.queuedAt,
        status: "ok", detail: `input-stream=${context.streamId};sequence=${context.sequence};kind=${kind}` });
      context.signal.throwIfAborted();
      // The native protocol remains sequential within a process. A stream gets
      // its own persistent helper, so a blocked UIA call cannot queue other agents
      // behind that helper's one active request.
      const operation = () => ownerWorkPolicy.run({ agent: identity.handle, provider: identity.provider ?? identity.handle,
        sessionId: identity.sessionId, taskId, signal: context.signal,
        ...(correlation?.stageName ? { stageName: correlation.stageName } : {}),
        ...(correlation?.operationId ? { operationId: correlation.operationId } : {}),
        readOwnerInputEpoch: () => manager.physicalInputEpoch(),
        captureOwnerInputEpoch: (leaseKey) => manager.captureOwnerInputEpoch(leaseKey),
        releaseOwnerInputMonitor: (leaseKey) => manager.releaseOwnerInputMonitor(leaseKey),
        assertActive: () => {
          const credential = input.store.identityCredentialForSession(identity.provider ?? identity.handle, identity.sessionId);
          if (!credential || normalizeHandle(credential.identity.handle) !== normalizeHandle(identity.handle)) throw new DesktopInputNotDispatchedError("This agent turn is no longer active; no foreground input was sent.", "foreground-approval");
          authorize(credential.token, taskId, "owner-preview");
          if (!readPolicy().controlHandles?.includes(normalizeHandle(identity.handle))) throw new DesktopInputNotDispatchedError("Computer control was revoked; no foreground input was sent.", "foreground-approval");
        } }, () =>
        manager.withForegroundAuthorization(ownerWorkPolicy.authorize, () => run(context)));
      const result = typeof manager.withInputStream === "function"
        ? await manager.withInputStream(context.streamId, operation)
        : await operation();
      return result && typeof result === "object"
        ? { ...result, inputStream: { id: context.streamId } } as T
        : result;
    });
  }
  // The cursor reaper is broker-wide housekeeping unrelated to any one stage's actions;
  // it must never queue behind (or make another agent's action queue behind) a stage
  // it has nothing to do with.
  let reaperPending: Promise<unknown> = Promise.resolve();
  type OwnedStageApp = {
    taskId: string;
    appId: string;
    pid: number;
    process?: ChildProcess;
    ownsProcess: boolean;
    windowId: string;
    /** Best-effort, in-memory only: the most recent window title this stage observed, for an honest
     * recovery notice after a relaunch. Never persisted and never used to re-dispatch anything automatically. */
    lastKnownWindowTitle?: string;
  };
  const ownedApps = new Map<string, OwnedStageApp>();
  const observedRegionRevisions = new Map<string, { surfaceId: string; surfaceRevision: number; regions: Map<string, number> }>();
  const activeAgentCursors = new Map<string, { identity: CuaAgentCursorIdentity; taskId: string; primedAt: number }>();
  const cursorPresentationPending = new Set<string>();
  const cursorPresentationTask = new Map<string, string>();
  // A single failed identity/policy lookup is far more likely to be a transient
  // token-refresh or policy-reload race than a genuinely revoked session. Only
  // tear the cursor down after several consecutive failed ticks.
  const cursorAuthFailures = new Map<string, number>();
  const CURSOR_REVOKE_AFTER_FAILURES = 3;
  // Safety net, independent of task state: a task that never reaches a terminal lifecycle (stuck at
  // "acknowledged" forever, say) would otherwise keep its cursor alive indefinitely, since the normal
  // reap path below only fires once taskActive() goes false. This bounds that worst case regardless of
  // cause. Generous on purpose -- it must never cut off a genuinely long-running, still-progressing task.
  const CURSOR_MAX_LIFETIME_MS = input.cursorMaxLifetimeMsForTest ?? 30 * 60 * 1000;
  let cursorReaperQueued = false;

  function recoverPersistedApp(name: string, taskId: string): OwnedStageApp | undefined {
    const stage = manager.list().find((item) => item.name === name);
    if (!stage?.anchor) return undefined;
    const selected = {
      taskId,
      appId: stage.appId ?? "",
      pid: stage.anchor.pid,
      windowId: stage.anchor.windowId,
      ownsProcess: false,
    };
    ownedApps.set(name, selected);
    return selected;
  }

  function cursorIdentityKey(identity: CuaAgentCursorIdentity): string {
    return `${normalizeHandle(identity.handle)}\0${identity.sessionId}`;
  }

  function cursorStageName(identity: CuaAgentCursorIdentity, mode: TaskStageMode = "owner-preview"): string {
    const prefix = mode === "owner-preview" ? "preview-agent" : "agent";
    return `${prefix}-${createHash("sha256").update(`${identity.handle}\0${identity.sessionId}`).digest("hex").slice(0, 24)}`;
  }

  type CursorTarget = { identity: CuaAgentCursorIdentity; taskId: string; stageName: string };

  /**
   * Resolve the recipient session for a delivery-time cursor without guessing.
   * The bearer may be either the authenticated sender (the task-creation path)
   * or the authenticated recipient (the reconnect/session-start path).  The
   * owner-only variant is used only by the local owner pipe for a human task.
   */
  function resolveCursorTarget(token: string | undefined, taskId: string, ownerOnly = false): CursorTarget | undefined {
    const task = input.store.getTask(taskId);
    if (!task || task.resultSummary || task.receipt?.state === "canceled" || task.approval === "pending" || task.approval === "denied" || task.approval === "expired"
      || task.lifecycle?.state === "completed" || task.lifecycle?.state === "failed") return undefined;
    if (ownerOnly && (task.origin !== "human_typed" || normalizeHandle(task.from) !== "you")) return undefined;
    const bearer = token ? input.store.verifyIdentity(token) : null;
    if (!ownerOnly && !bearer) return undefined;
    const targetHandle = normalizeHandle(task.to);
    if (!targetHandle || targetHandle.startsWith("web-")) return undefined;

    const targetSessions = input.store.sessionsWithIdentity(targetHandle, task.cwd);
    const requestedSession = task.targetSession ?? task.deliveredSession;
    const targetSession = requestedSession
      ? targetSessions.find((session) => session.sessionId === requestedSession)
      : targetSessions.length === 1 ? targetSessions[0] : undefined;
    if (!targetSession) return undefined;

    if (!ownerOnly && bearer) {
      const bearerHandle = normalizeHandle(bearer.handle);
      const sourceAuthorized = bearerHandle === normalizeHandle(task.from)
        && (!task.fromSession || task.fromSession === bearer.sessionId);
      const targetAuthorized = bearerHandle === targetHandle
        && (!requestedSession || requestedSession === bearer.sessionId);
      if (!sourceAuthorized && !targetAuthorized) return undefined;
    }
    const policy = readPolicy();
    if (!policy.handles.includes(targetHandle)) return undefined;
    const identity: CuaAgentCursorIdentity = { handle: targetHandle, sessionId: targetSession.sessionId };
    return { identity, taskId, stageName: cursorStageName(identity) };
  }

  async function primeCursor(token: string, taskId: string): Promise<AgentCursorPrimeResult> {
    const target = resolveCursorTarget(token, taskId);
    if (!target) return { shown: false, reason: "The recipient session is not connected, authorized, or eligible for a cursor." };
    return primeResolvedCursor(target);
  }

  async function primeCursorForOwner(taskId: string): Promise<AgentCursorPrimeResult> {
    const target = resolveCursorTarget(undefined, taskId, true);
    if (!target) return { shown: false, reason: "The owner task has no one eligible recipient session for a cursor." };
    return primeResolvedCursor(target);
  }

  async function primeResolvedCursor(target: CursorTarget): Promise<AgentCursorPrimeResult> {
    const key = cursorIdentityKey(target.identity);
    const priorCursor = activeAgentCursors.get(key);
    const primedAt = priorCursor && priorCursor.taskId === target.taskId ? priorCursor.primedAt : Date.now();
    if (priorCursor?.taskId !== target.taskId) {
      // One key per agent identity means every prime overwrites whatever taskId was
      // there before -- if that new taskId is an ephemeral/internal one that never
      // reaches a terminal state in the task store, the reaper (below) can never fire
      // for it again, and the marker/bubble sticks on screen indefinitely even though
      // the task the owner actually sees as "done" already finished. Confirmed live:
      // a Claude cursor stayed on screen long after its real task completed. Log every
      // handoff so a stuck marker's actual owning taskId is visible, not guessed.
      // Unconditional (no env-var gate): a debug flag that isn't threaded through
      // the real install path never actually gets set on a properly-installed
      // broker, so the only honest way to get this evidence is to ship it baked
      // into the build and go through the real build/tag/install flow once.
      console.error(`[cursor-lifecycle] prime key=${key} from-task=${priorCursor?.taskId ?? "(none)"} to-task=${target.taskId}`);
    }
    activeAgentCursors.set(key, { identity: target.identity, taskId: target.taskId, primedAt });
    if (cursorPresentationTask.get(key) === target.taskId) return { shown: true, agent: target.identity.handle };
    if (cursorPresentationPending.has(key)) return { shown: false, reason: "The local cursor surface is already starting." };
    const showAgentCursor = (driver as ReturnType<typeof createCuaStageDriver> & {
      showAgentCursor?: (stageName: string, cursorIdentity: CuaAgentCursorIdentity) => Promise<unknown>;
    }).showAgentCursor;
    if (typeof showAgentCursor !== "function") {
      activeAgentCursors.delete(key);
      return { shown: false, reason: "The installed desktop runtime has no cursor presentation capability." };
    }
    cursorPresentationPending.add(key);
    try {
      // Cursor rendering has its own compositor queue and does not mutate the
      // desktop. Keep it out of the per-stage action queue so it can appear at
      // delivery time instead of waiting for app discovery or a long action.
      const result = await showAgentCursor(target.stageName, target.identity);
      if (result && typeof result === "object" && "visible" in result && result.visible !== true) {
        if (activeAgentCursors.get(key)?.taskId === target.taskId) activeAgentCursors.delete(key);
        return { shown: false, reason: "The local cursor surface did not confirm its first frame." };
      }
      // The entry was added to activeAgentCursors optimistically, before this
      // await -- the 250ms cursorReaper (below) can run concurrently and,
      // seeing taskActive() already false for a task that completed/failed
      // fast, delete that entry and hide the cursor while showAgentCursor was
      // still in flight. If this just set cursorPresentationTask unconditionally
      // once show resolved, the cursor would come back visible with nothing
      // left in activeAgentCursors to ever reap it again -- the reaper only
      // iterates keys present in that map. Restore the entry only if nothing
      // else has since claimed this identity key; if a newer task's prime call
      // already overwrote it, that task now legitimately owns the key and must
      // not be clobbered by this stale one.
      const current = activeAgentCursors.get(key);
      if (!current) activeAgentCursors.set(key, { identity: target.identity, taskId: target.taskId, primedAt });
      else if (current.taskId !== target.taskId) return { shown: true, agent: target.identity.handle };
      cursorPresentationTask.set(key, target.taskId);
      return { shown: true, agent: target.identity.handle };
    } catch {
      if (activeAgentCursors.get(key)?.taskId === target.taskId) activeAgentCursors.delete(key);
      return { shown: false, reason: "The local cursor surface could not be shown." };
    } finally {
      cursorPresentationPending.delete(key);
    }
  }

  /**
   * Render only a real A2A summary from one uniquely active roster identity.
   * Bubble presentation is best-effort and never changes message delivery.
   */
  // taskId is M9R's own internal "T<number>" task id, used only to disambiguate when a handle has more
  // than one concurrently active cursor; it is NOT the free-form, model-chosen A2A room label a teammate
  // message's own taskId field carries (those never match a real task id, which silently failed every
  // chatter-bubble lookup before this was optional). Omit it when the caller only knows that room label.
  async function sayAgentCursor(fromHandle: string, toHandle: string, text: string, taskId?: string): Promise<boolean> {
    const from = uniqueActiveCursorIdentity(activeAgentCursors.values(), fromHandle, taskActive, taskId);
    if (!from) return false;
    const to = uniqueActiveCursorIdentity(activeAgentCursors.values(), toHandle, taskActive, taskId);
    const targetIdentity = to ?? { handle: normalizeHandle(toHandle), sessionId: from.sessionId };
    const driverWithCursor = driver as ReturnType<typeof createCuaStageDriver> & {
      sayAgentCursor?: (sender: CuaAgentCursorIdentity, recipient: CuaAgentCursorIdentity, summary: string) => Promise<boolean> | boolean;
    };
    if (typeof driverWithCursor.sayAgentCursor !== "function") return false;
    try { return await driverWithCursor.sayAgentCursor(from, targetIdentity, text); }
    catch { return false; }
  }

  async function ensureCursorPrimed(stageName: string, identity: CuaAgentCursorIdentity, taskId: string): Promise<void> {
    const showAgentCursor = (driver as ReturnType<typeof createCuaStageDriver> & {
      showAgentCursor?: (stageName: string, cursorIdentity: CuaAgentCursorIdentity) => Promise<unknown>;
    }).showAgentCursor;
    // Test-only drivers may omit the visual seam. The production Cua driver
    // always implements it, so absence here preserves the provider-neutral
    // stage contract without inventing a fake cursor result in tests.
    if (typeof showAgentCursor !== "function") return;
    const key = cursorIdentityKey(identity);
    if (cursorPresentationTask.get(key) === taskId) return;
    if (cursorPresentationPending.has(key)) return;
    cursorPresentationPending.add(key);
    // The compositor is presentation only. Its latency or failure must not
    // delay an observation, launch, mutation fence, or target dispatch.
    void Promise.resolve().then(() => showAgentCursor(stageName, identity)).then((result) => {
      if (result && typeof result === "object" && "visible" in result && result.visible !== true) return;
      const active = activeAgentCursors.get(key);
      if (active) {
        if (taskActive(active.taskId)) cursorPresentationTask.set(key, active.taskId);
        return;
      }
      // Nothing currently owns this identity key: the 250ms cursorReaper (below) can run
      // while showAgentCursor above was still in flight and, seeing taskActive(taskId)
      // already false, delete the activeAgentCursors entry and hide the cursor before this
      // call ever resolved. Leaving nothing recorded here (the prior behavior) made the
      // cursor that just came back visible from this call untracked -- the reaper only
      // iterates keys present in activeAgentCursors, so it could never reap this marker
      // again. Restore the entry (for whichever taskId this call primed) so the very next
      // reaper tick picks it up and correctly hides it, instead of leaving it on screen.
      activeAgentCursors.set(key, { identity, taskId, primedAt: Date.now() });
      cursorPresentationTask.set(key, taskId);
    }).catch(() => undefined).finally(() => {
      cursorPresentationPending.delete(key);
      const active = activeAgentCursors.get(key);
      // If a follow-up task arrived while the first frame was pending, reuse
      // that visible marker for the new task instead of losing its arrival.
      if (active && active.taskId !== taskId && taskActive(active.taskId)
        && cursorPresentationTask.get(key) !== active.taskId) {
        void ensureCursorPrimed(stageName, active.identity, active.taskId);
      }
    });
  }

  function authorize(token: string, taskId: string, mode: TaskStageMode) {
    if (isAgentContext(stageDeps.env ?? process.env)) {
      throw new StageAuthorizationError("Task stages require the owner-launched M9R broker; an agent process cannot host this service.");
    }
    const identity = input.store.verifyIdentity(token);
    if (!identity) {
      // Keep the failure useful in raw diagnostics without exposing internal
      // identity mechanics or asking the owner to repair M9R's own process setup.
      throw new StageAuthorizationError("M9R could not authorize this desktop action. No desktop input was sent.", undefined, "agent_identity_unavailable");
    }
    if (!readPolicy().handles.includes(normalizeHandle(identity.handle))) throw new StageAuthorizationError("The owner has not enabled task stages for this agent.");
    const task = input.store.getTask(taskId);
    const handle = normalizeHandle(identity.handle);
    const addressedHandle = identity.sessionId.startsWith("web-") && !handle.startsWith("web-") ? `web-${handle}` : handle;
    if (!task || normalizeHandle(task.to) !== addressedHandle
      || ((task.targetSession ?? task.deliveredSession) && (task.targetSession ?? task.deliveredSession) !== identity.sessionId)
      || (task.delivery?.threadId && task.delivery.threadId !== identity.sessionId)) {
      throw new StageAuthorizationError("This task does not belong to the requesting agent session.");
    }
    if (!(["approved", "not_needed"] as string[]).includes(task.approval)
      || task.resultSummary !== undefined || task.delivery?.state === "done") {
      throw new StageAuthorizationError("Only an unfinished owner-authorized or approved task can use an agent stage.");
    }
    if (task.receipt?.state === "canceled") {
      throw new StageAuthorizationError("This task was canceled; no desktop work is allowed.");
    }
    if (task.receipt?.state === "paused") {
      throw new StageAuthorizationError("This task is paused; no desktop work is allowed for that turn.");
    }
    {
      const authKey = cursorIdentityKey(identity);
      const priorCursor = activeAgentCursors.get(authKey);
      const primedAt = priorCursor && priorCursor.taskId === taskId ? priorCursor.primedAt : Date.now();
      activeAgentCursors.set(authKey, { identity: { handle, sessionId: identity.sessionId }, taskId, primedAt });
    }
    // Session-scoped reuse bounds desktop creation; task text never becomes a desktop name.
    const name = cursorStageName(identity, mode);
    return { identity, task, name, mode };
  }

  async function prepare(token: string, taskId: string, requestedMode?: TaskStageMode, options: { bindForeground?: boolean } = {}) {
    const mode = stageMode(requestedMode);
    // Only used to route this call to its own stage's queue; run() below re-authorizes
    // at dequeue time, exactly as before this call existed.
    const { name: queueName, identity: streamIdentity } = authorize(token, taskId, mode);
    const run = async () => {
      const { name, identity } = authorize(token, taskId, mode);
      const sessionTag = createHash("sha256").update(`${normalizeHandle(identity.handle)}\0${identity.sessionId}`).digest("hex").slice(0, 8);
      const existing = manager.list().find((stage) => stage.name === name);
      let assignedStage: ReturnType<typeof manager.assignAgent> | undefined;
      if (options.bindForeground) {
          if (typeof manager.currentForegroundWindow !== "function") throw new Error("The native stage helper cannot bind the current foreground window.");
          const foreground = await manager.currentForegroundWindow();
          // Never bind M9R's own overlay or a hidden/minimized window. This
          // keeps "look at my screen" from targeting the control surface that
          // is issuing the request.
          if (!foreground.visible || foreground.minimized) {
            throw new Error("The current foreground window is not visible.");
          }
          if (/\bm9r\b|m9r[-_ ]?(?:overlay|pill|broker)/i.test(`${foreground.title} ${foreground.className}`)) {
            throw new Error("The current foreground window is M9R's own overlay; focus the app you want the agent to inspect.");
          }
          await manager.ensureStage(name);
          assignedStage = manager.assignAgent(name, { handle: normalizeHandle(identity.handle), sessionTag, taskId });
          const attached = input.mutationFence
            ? await manager.attachSharedWindow(name, String(foreground.pid), foreground.windowId)
            : await manager.attachWindow(name, String(foreground.pid), foreground.windowId);
          assignedStage = attached.stage;
          ownedApps.set(name, { taskId, appId: "", pid: foreground.pid, windowId: foreground.windowId, ownsProcess: false });
          if (!attached.window || attached.window.pid !== foreground.pid || attached.window.windowId !== foreground.windowId) {
            throw new Error("Windows did not confirm the current foreground window binding.");
          }
      } else {
        // Owner preview binds to the owner's current screen and keeps an exact
        // HWND anchor. It never creates, moves, or closes a Windows desktop.
        recoverPersistedApp(name, taskId);
        // `name` is one stage per authenticated identity/session (see authorize()), so
        // `ownedApps.get(name)` holds at most one entry regardless of which taskId that
        // session is currently using -- the real continuation boundary is "this stage
        // already has a selected app", not "the exact same taskId selected it". A real
        // session naturally issues a fresh taskId per request even mid-task.
        if (!existing) await manager.ensureStage(name);
        // Keep the durable exact-window anchor when inspection fails. act()
        // distinguishes a genuinely gone window (recover once) from an unknown
        // inspection outcome (do not spawn). Clearing it here destroys evidence,
        // including for a fresh broker that must recover from disk.
        assignedStage = manager.assignAgent(name, { handle: normalizeHandle(identity.handle), sessionTag, taskId });
      }
      // Publish the agent's labeled overlay before launch or the first input
      // action. The native cursor is visual-only here: it does not focus a
      // window or move the owner's physical pointer. Test drivers may omit the
      // optional visual seam; the production driver always provides it.
      await ensureCursorPrimed(name, identity, taskId);
      // Return opaque coordination IDs only, never desktop GUIDs or owner-window identifiers.
      return { name, mode, agent: normalizeHandle(identity.handle), taskId, hasAnchor: Boolean(assignedStage?.anchor),
        ...(mode === "background" && assignedStage ? { roomDesktopId: assignedStage.roomDesktopId } : {}),
        controlEnabled: readPolicy().controlHandles?.includes(normalizeHandle(identity.handle)) === true };
    };
    return inInputStream(streamIdentity, taskId, "prepare", () => enqueueTimedStage(queueName, taskId, "prepare", undefined, run, queueName));
  }

  async function act(token: string, taskId: string, value: unknown, requestedMode?: TaskStageMode, operationId?: string, expectedMutationRevision?: number) {
    const mode = stageMode(requestedMode);
    let action: ReturnType<typeof parseTaskStageAction>;
    try { action = parseTaskStageAction(value); }
    catch (error) { throw new StageValidationError(error instanceof Error ? error.message : "Invalid stage action.", { cause: error }); }
    if (operationId !== undefined && !/^[a-zA-Z0-9._:-]{1,128}$/.test(operationId)) throw new Error("Invalid desktop-stage operation ID.");
    // Only used to route this call to its own stage's queue; run() below re-authorizes
    // at dequeue time, exactly as before this call existed.
    const { name: stageName, identity: streamIdentity } = authorize(token, taskId, mode);
    // A coordination key groups app discovery, never input streams. Two agents
    // collaborating on one goal retain independent action lanes; the target fence
    // below arbitrates only their actual conflicting mutations.
    const queueName = stageName;
    let streamSignal: AbortSignal | undefined;
    if (action.kind === "stop") {
      const startedMs = Date.now();
      stoppedTaskInputs.add(`${stageName}\0${taskId}`);
      ownerWorkPolicy.revokeTask({ agent: streamIdentity.handle, provider: streamIdentity.provider ?? streamIdentity.handle,
        sessionId: streamIdentity.sessionId, taskId });
      const active = activeInputs.get(stageName);
      if (active?.taskId === taskId) active.controller.abort(new Error("Explicit desktop stop requested."));
      inputStreams.cancelTask(streamIdentity, taskId, new Error("Explicit desktop stop requested."));
      let cursorClosed = true;
      try { await driver.closeAgentCursor(streamIdentity); } catch { cursorClosed = false; /* stop remains effective even if marker cleanup fails */ }
      const cursorKey = cursorIdentityKey(streamIdentity);
      if (cursorClosed) {
        activeAgentCursors.delete(cursorKey);
        cursorPresentationTask.delete(cursorKey);
      }
      // Leaving the entry in activeAgentCursors on failure is deliberate: the
      // cursor reaper below polls every 250ms and will see this task is no
      // longer active, retrying closeAgentCursor itself instead of this stop
      // path's single best-effort attempt orphaning the marker for good.
      const endedMs = Date.now();
      recordStageTiming(taskId, { phase: "stop", startedAt: new Date(startedMs).toISOString(), endedAt: new Date(endedMs).toISOString(),
        durationMs: endedMs - startedMs, status: "ok" });
      // Stop is an interruption boundary, not a destructive cancellation. The
      // receipt stays paused so late input from this turn is fenced, while a
      // subsequent owner message can create a fresh redirect task.
      input.store.pauseTask(taskId);
      return { stopped: active?.taskId === taskId, paused: true, cancellationRequested: false };
    }
    let recoveryNotice: string | undefined;
    let dispatchStarted = false;
    const run = async () => {
      const { name, identity } = authorize(token, taskId, mode);
      if (stoppedTaskInputs.has(`${name}\0${taskId}`)) throw new DesktopInputNotDispatchedError("This task was explicitly stopped; no input was sent.");
      if (!readPolicy().controlHandles?.includes(normalizeHandle(identity.handle))) throw new Error("The owner has not enabled stage computer control for this agent.");
      // A prior native action may have hidden the cursor after a transport or
      // verification failure. Re-prime immediately before the first real
      // desktop operation so cursor visibility is a current invariant, not a
      // stale promise from prepare().
      await ensureCursorPrimed(name, identity, taskId);
      if (action.kind === "window_status") {
        const selected = ownedApps.get(name) ?? recoverPersistedApp(name, taskId);
        if (!selected) throw new Error("This session has no selected application window.");
        const windowState = await manager.windowStatus(selected.pid, selected.windowId);
        return windowState === "closed" || windowState === "minimized"
          ? { windowState }
          : { windowState, frame: await manager.windowRect(selected.pid, selected.windowId) };
      }
      const rePresentLiveWindow = async (selected: OwnedStageApp): Promise<Awaited<ReturnType<typeof manager.inspectStage>>> => {
        const previousStage = manager.list().find((stage) => stage.name === name);
        const coordinationKey = previousStage?.coordinationKey;
        let windowId = selected.windowId;
        try {
          // Verify the exact saved window first. If it is still valid, never
          // retarget it. HWNDs can, however, be recreated by a normal app
          // restart/update while the owning PID survives; in that case the
          // same-process discovery below repairs the anchor without launching
          // a duplicate app instance.
          await manager.inspectWindow(String(selected.pid), windowId);
        } catch (error) {
          const rebindStartedAt = Date.now();
          const rebindStartedTick = performance.now();
          const rebindStartedAtIso = new Date(rebindStartedAt).toISOString();
          const replacement = await manager.resolveWindowReplacement(name);
          if (!replacement) {
            throw new Error("The selected window cannot be rebound to one verified process generation; refresh the exact window target before sending input.", { cause: error });
          }
          windowId = replacement.windowId;
          process.stderr.write(`[stage-recovery] ${taskId}: stale window handle ${selected.windowId}; rebinding same-process window ${windowId}\n`);
          const recoveredAt = new Date().toISOString();
          recordStageTiming(taskId, {
            phase: "stage-recovery",
            startedAt: rebindStartedAtIso,
            endedAt: recoveredAt,
            durationMs: performance.now() - rebindStartedTick,
            status: "ok",
            ...(operationId ? { operationId } : {}),
            detail: "outcome=rebound;same-process-window=true",
          });
        }
        await manager.presentOwnerWindow(name, selected.pid, windowId, coordinationKey);
        await manager.attachWindow(name, String(selected.pid), windowId, selected.appId || undefined, coordinationKey);
        if (windowId !== selected.windowId) {
          ownedApps.set(name, { ...selected, windowId });
        }
        return manager.inspectStage(name);
      };
      let inspected: Awaited<ReturnType<typeof manager.inspectStage>>;
      try {
        inspected = await manager.inspectStage(name);
      } catch (error) {
        // Only a genuinely closed/gone window justifies launching a replacement.
        // A helper timeout or malformed response remains an error; it is never
        // guessed to be a closed app.
        const ownedBeforeFailure = ownedApps.get(name) ?? recoverPersistedApp(name, taskId);
        // A helper timeout or other inspection failure means a live window may
        // still exist; do not create a needless second instance alongside it.
        if (!isStageWindowGoneError(error)) throw error;
        // The window this stage previously owned is gone -- closed, crashed, or
        // otherwise invalid. Relaunch the exact same app once and retry, instead
        // of failing the whole action just because the target disappeared since
        // it was last observed. Generic: works for any appId, not a per-app fix.
        //
        // `name` is already derived from the authenticated identity + session
        // (see authorize() above), not from taskId -- it is the same stage for
        // every task a given agent session sends, by design. A real agent
        // session naturally issues a fresh taskId per request even when it is
        // continuing the exact same piece of work (launch an app, then act on
        // it), so gating recovery on an exact taskId match broke recovery for
        // precisely the normal, continuous case it exists to handle -- requiring
        // the original taskId to be re-supplied is not something a real caller
        // does or should have to do. authorize() above has already proven this
        // request belongs to the same identity/session that owns this stage;
        // that is the actual ownership boundary, not which taskId is attached.
        const replacement = ownedBeforeFailure && mode === "owner-preview" ? await manager.resolveWindowReplacement(name) : undefined;
        if (replacement && ownedBeforeFailure) {
          const rebound = { ...ownedBeforeFailure, windowId: replacement.windowId };
          ownedApps.set(name, rebound);
          inspected = await rePresentLiveWindow(rebound);
          recoveryNotice = "The application's window was recreated in the same verified process generation. Inspect its fresh state before choosing the next action.";
        } else if (ownedBeforeFailure?.appId) {
          const recoveryStartedAt = Date.now();
          const recoveryStartedTick = performance.now();
          const recoveryStartedAtIso = new Date(recoveryStartedAt).toISOString();
          process.stderr.write(`[stage-recovery] ${taskId}: inspectStage failed (${error instanceof Error ? error.message : String(error)}), relaunching ${ownedBeforeFailure.appId}\n`);
          try {
            await launch(token, taskId, ownedBeforeFailure.appId, mode, undefined, { skipQueue: true });
            process.stderr.write(`[stage-recovery] ${taskId}: relaunch completed after ${Date.now() - recoveryStartedAt}ms, re-inspecting\n`);
            inspected = await manager.inspectStage(name);
            const recoveredAt = new Date().toISOString();
            recordStageTiming(taskId, {
              phase: "stage-recovery",
              startedAt: recoveryStartedAtIso,
              endedAt: recoveredAt,
              durationMs: performance.now() - recoveryStartedTick,
              status: "ok",
              detail: "trigger=window-gone;recovery=relaunch;outcome=ready",
            });
          } catch (recoveryError) {
            const failedAt = new Date().toISOString();
            recordStageTiming(taskId, {
              phase: "stage-recovery",
              startedAt: recoveryStartedAtIso,
              endedAt: failedAt,
              durationMs: performance.now() - recoveryStartedTick,
              status: "error",
              detail: `trigger=window-gone;recovery=relaunch;error=${recoveryError instanceof Error ? recoveryError.name : "unknown"}`,
            });
            throw recoveryError;
          }
          // Lightweight, no added latency: this reuses the title already known from the
          // owned app record (stashed opportunistically below, never a dedicated fetch) to
          // tell the agent honestly that on-screen state was lost, instead of pretending the
          // relaunched window continues where the old one left off.
          recoveryNotice = ownedBeforeFailure.lastKnownWindowTitle
            ? `The application window was closed and relaunched; it previously had "${ownedBeforeFailure.lastKnownWindowTitle}" open, which this relaunch did not restore. Re-open or re-navigate to that state if the task still needs it.`
            : "The application window was closed and relaunched; its on-screen state (open file, search, scroll position) was not restored.";
        } else {
          throw error;
        }
      }
      const selected = ownedApps.get(name) ?? recoverPersistedApp(name, taskId);
      // The selected app is the default target after launch. Explicit screen
      // observation can detach only the view anchor; the selected app remains available.
      // `name` is one stage per identity/session (see authorize()): `selected`, if
      // present, already belongs to this exact request's session regardless of
      // which taskId originally selected it -- a real session naturally issues a
      // fresh taskId per request even mid-task, so gating on an exact match here
      // breaks the normal, continuous case (launch under one task, act under the
      // next) that this is meant to support.
      const effectiveAction: typeof action = action.kind === "read_structure" || action.view === "app"
        ? action
        : { ...action, view: action.view ?? (selected ? "app" : "desktop") };
      if (mode === "owner-preview" && effectiveAction.view === "desktop" && inspected.anchor) {
        await manager.clearOwnedAnchor(name, inspected.anchor.pid, inspected.anchor.windowId);
        inspected = await manager.inspectStage(name);
      } else if (mode === "owner-preview" && (effectiveAction.view === "app" || effectiveAction.view === "popup") && !inspected.anchor && selected) {
        // Owned dialogs are discovered from their selected parent app. A
        // desktop observation detaches the stage anchor, so restore that app
        // binding before resolving a popup rather than sending popup-local
        // coordinates through the desktop-wide route.
        await manager.attachWindow(name, String(selected.pid), selected.windowId, selected.appId || undefined);
        inspected = await manager.inspectStage(name);
      }
      if ((effectiveAction.view === "app" || effectiveAction.view === "popup") && (!selected || !inspected.anchor)) {
        throw new Error(`This task has no selected application window. Open the requested app before using the ${effectiveAction.view} view.`);
      }
      if (recoveryNotice && action.kind !== "capture" && action.kind !== "read_structure") {
        // Rebinding invalidates the old observation. Ask the caller to re-plan
        // against the refreshed state before delivering any target input.
        const capture = effectiveAction.view === "app" || effectiveAction.view === "popup"
          ? await driver.capture(name, identity) : await driver.captureDesktop(name, identity);
        throw new StageCaptureRefreshError(capture,
          recoveryNotice + " Inspect the refreshed capture and choose the next action; no input was sent.");
      }
      // Recheck after inspection and at dequeue time: queued work cannot survive revocation.
      authorize(token, taskId, mode);
      if (!readPolicy().controlHandles?.includes(normalizeHandle(identity.handle))) throw new Error("Stage computer control was revoked.");
      if (action.kind === "click" || action.kind === "double_click" || action.kind === "right_click" || action.kind === "middle_click") {
        await moneyGate(name, identity, { x: action.x, y: action.y }, effectiveAction.view === "app" ? "background" : mode,
          effectiveAction.view === "popup");
      } else if (action.kind === "click_element") {
        await moneyGate(name, identity, { ref: action.ref, expectedRole: action.expectedRole, expectedLabel: action.expectedLabel }, effectiveAction.view === "app" ? "background" : mode);
      }
      // The approval wait above can outlast a revocation: recheck before anything executes.
      authorize(token, taskId, mode);
      if (!readPolicy().controlHandles?.includes(normalizeHandle(identity.handle))) throw new Error("Stage computer control was revoked.");
      const mutating = action.kind !== "capture" && action.kind !== "read_structure" && action.kind !== "read_value";
      if (mutating && inspected.stage.fencedBinding && !input.mutationFence) {
        throw new DesktopInputNotDispatchedError("This shared app target requires the owner broker's mutation fence; no input was sent.", "dispatch-gate");
      }
      const receiptInput = mutating && operationId ? {
        handle: identity.handle,
        sessionId: identity.sessionId,
        taskId,
        operationId,
        fingerprint: createHash("sha256").update(JSON.stringify({ mode, action: effectiveAction })).digest("hex"),
      } : undefined;
      if (receiptInput) {
        const claim = input.store.claimStageOperation(receiptInput);
        if (claim.state === "conflict") throw new Error("This desktop-stage operation ID already belongs to a different stage action; no input was sent.");
        if (claim.state === "in_progress") return { operationReceipt: { operationId, status: "in_progress", updatedAt: claim.updatedAt }, actionExecuted: false };
        if (claim.state === "applied") return { operationReceipt: { operationId, status: "already_applied", updatedAt: claim.updatedAt }, actionExecuted: false };
        if (claim.state === "uncertain") return { operationReceipt: { operationId, status: "uncertain", updatedAt: claim.updatedAt }, actionExecuted: false,
          nextStep: "Capture the stage and inspect the current state before issuing a new action." };
      }
      let result: unknown;
      let mutationRevision: number | undefined;
      let mutationSurfaceId: string | undefined;
      let mutationRegionId: string | undefined;
      let fenceTransaction: MutationFenceTransaction | undefined;
      if (input.mutationFence) {
        if (effectiveAction.kind === "replace_element" && effectiveAction.view === "app" && selected
          && typeof driver.valueMutationRegion === "function") {
          mutationRegionId = await driver.valueMutationRegion(name, effectiveAction.ref,
            { role: effectiveAction.expectedRole, label: effectiveAction.expectedLabel }, identity);
        }
        const fenceTarget = action.kind !== "system_control" && effectiveAction.view === "app" && selected
          ? desktopWindowMutationTarget({ pid: selected.pid, windowId: selected.windowId, processGeneration: inspected.anchor?.processGeneration,
            ...(mutationRegionId ? { regionId: mutationRegionId } : {}) })
          : desktopMutationTarget();
        mutationSurfaceId = fenceTarget.surfaceId;
        if (mutating) {
          const observedRegions = observedRegionRevisions.get(name);
          const expectedRegionRevision = mutationRegionId && observedRegions?.surfaceId === fenceTarget.surfaceId
            ? observedRegions.regions.get(mutationRegionId) : undefined;
          if (mutationRegionId && expectedRegionRevision === undefined) {
            if (receiptInput) input.store.releaseStageOperation(receiptInput);
            throw new DesktopInputNotDispatchedError("Read the app structure before independently changing this control; no input was sent.", "mutation-revision");
          }
          const begun = input.mutationFence.begin({
            agent: identity.handle,
            provider: identity.provider,
            sessionId: identity.sessionId,
            operationId: operationId ?? `stage-${randomUUID()}`,
            target: fenceTarget,
            ...((expectedMutationRevision ?? (mutationRegionId ? observedRegions?.surfaceRevision : undefined)) === undefined ? {}
              : { expectedMutationRevision: expectedMutationRevision ?? observedRegions?.surfaceRevision }),
            ...(expectedRegionRevision === undefined ? {} : { expectedRegionRevision }),
          });
          if (!begun.ok) {
            // A typed pre-dispatch refusal may release the stage claim: no input reached the OS.
            if (receiptInput) input.store.releaseStageOperation(receiptInput);
            throw new DesktopInputNotDispatchedError(
              begun.error,
              begun.code === "stale-revision" || begun.code === "surface-unresolved" || begun.code === "already-claimed" ? "mutation-revision"
                : begun.code === "lease-unavailable" ? "mutation-lease"
                  : begun.code === "target-identity-conflict" ? "target-identity"
                    : "dispatch-gate",
            );
          }
          if (begun.duplicate) {
            // A still-claimed duplicate is another in-flight call for this exact
            // operation; leave its durable stage claim in place. Only a terminal
            // duplicate is safe to release, because no input is in flight then.
            if (receiptInput && begun.receipt.status !== "claimed") input.store.releaseStageOperation(receiptInput);
            throw new DesktopInputNotDispatchedError(
              `This operation already has a ${begun.receipt.status} mutation receipt; it will not be replayed automatically.`,
              "dispatch-gate",
            );
          }
          fenceTransaction = begun.transaction;
          mutationRevision = begun.surfaceRevision;
        } else {
          mutationRevision = input.mutationFence.surfaceRevision(fenceTarget.surfaceId);
        }
      }
      const withMutationRevision = (value: unknown): unknown => mutationRevision === undefined
        ? value
        : { ...(value && typeof value === "object" ? value : { result: value }), mutationRevision };
      const controller = new AbortController();
      const streamAborted = () => controller.abort(streamSignal?.reason);
      if (streamSignal?.aborted) streamAborted();
      else streamSignal?.addEventListener("abort", streamAborted, { once: true });
      activeInputs.set(name, { controller, taskId });
      const cancellationPoll = setInterval(() => {
        try {
          authorize(token, taskId, mode);
          if (!readPolicy().controlHandles?.includes(normalizeHandle(identity.handle))) controller.abort(new Error("Desktop control revoked."));
        } catch (error) { controller.abort(error); }
      }, 50);
      cancellationPoll.unref();
      try {
        dispatchStarted = mutating;
        result = await runTaskStageAction(driver, name, effectiveAction, identity, mode, controller.signal,
          { semanticOnly: Boolean(mutationRegionId) });
        if (fenceTransaction) {
          const committed = fenceTransaction.commit({ status: "applied" });
          mutationRevision = committed.surfaceRevision;
          if (committed.status !== "committed") {
            throw new Error("Desktop input may have been sent, but its mutation receipt is unresolved. Capture and inspect the target before another action.");
          }
        } else if (mutationSurfaceId && input.mutationFence
          && (effectiveAction.kind === "capture" || effectiveAction.kind === "read_structure")) {
          mutationRevision = input.mutationFence.observeSurface(mutationSurfaceId);
        }
        if (effectiveAction.kind === "read_structure" && effectiveAction.view === "app" && selected
          && input.mutationFence && mutationSurfaceId && typeof driver.observedValueMutationRegions === "function") {
          const regions = await driver.observedValueMutationRegions(name, identity);
          observedRegionRevisions.set(name, { surfaceId: mutationSurfaceId, surfaceRevision: mutationRevision ?? 0,
            regions: new Map(regions.map((region) => [region, input.mutationFence!.regionRevision(mutationSurfaceId!, region)])) });
        }
        // Opportunistic, free: a read_structure result already carries the window title
        // in memory (CuaStageStructure.windowTitle); stash it in case a future action in
        // this same stage needs to relaunch and give an honest recovery notice. No
        // dedicated fetch, no added latency.
        const resultRecord = result && typeof result === "object" ? result as Record<string, unknown> : undefined;
        const observedTitle = resultRecord?.windowTitle
          ?? (resultRecord?.capture && typeof resultRecord.capture === "object" ? (resultRecord.capture as Record<string, unknown>).windowTitle : undefined);
        if (typeof observedTitle === "string" && observedTitle.length > 0) {
          const current = ownedApps.get(name);
          if (current) ownedApps.set(name, { ...current, lastKnownWindowTitle: observedTitle });
        }
      } catch (error) {
        if (error instanceof StageInputNotDispatchedError || error instanceof DesktopInputNotDispatchedError) {
          // This typed gate proves the OS input driver was never called. Remove
          // the claim so the exact same operation ID can retry after the gate is fixed.
          fenceTransaction?.release(error.message);
          if (receiptInput) input.store.releaseStageOperation(receiptInput);
          throw error;
        }
        const detail = error instanceof Error ? error.message : String(error);
        const aborted = fenceTransaction?.abort(detail, { status: "uncertain" });
        if (aborted) mutationRevision = aborted.surfaceRevision;
        if (receiptInput) {
          try { input.store.settleStageOperation({ ...receiptInput, state: "uncertain" }); } catch { /* the durable running claim still blocks a replay */ }
          throw new Error(`The desktop input outcome is uncertain; the operation will not be replayed automatically. Capture the stage before issuing a new action. ${detail}`, { cause: error });
        }
        throw error;
      } finally {
        streamSignal?.removeEventListener("abort", streamAborted);
        clearInterval(cancellationPoll);
        if (activeInputs.get(name)?.controller === controller) activeInputs.delete(name);
      }
      if (!receiptInput) return withMutationRevision(result);
      try {
        const settled = input.store.settleStageOperation({ ...receiptInput, state: "applied" });
        return settled
          ? { ...(result && typeof result === "object" ? result : { result }), operationReceipt: { operationId, status: "applied", driverReturned: true }, actionExecuted: true, ...(mutationRevision === undefined ? {} : { mutationRevision }) }
          : { ...(result && typeof result === "object" ? result : { result }), operationReceipt: { operationId, status: "uncertain", driverReturned: true }, actionExecuted: true, ...(mutationRevision === undefined ? {} : { mutationRevision }),
            nextStep: "The input was sent, but its receipt could not be finalized; capture and inspect before issuing another action." };
      } catch (error) {
        return { ...(result && typeof result === "object" ? result : { result }), operationReceipt: { operationId, status: "uncertain", driverReturned: true }, actionExecuted: true, ...(mutationRevision === undefined ? {} : { mutationRevision }),
          receiptError: error instanceof Error ? error.message.slice(0, 180) : "The durable operation receipt could not be finalized.",
          nextStep: "The input was sent; capture and inspect before issuing another action." };
      }
    };
    const guardedRun = async () => {
      try { return await run(); }
      catch (error) {
        if (!dispatchStarted && !(error instanceof StageInputNotDispatchedError) && !(error instanceof DesktopInputNotDispatchedError)) {
          throw new StageInputNotDispatchedError(error instanceof Error ? error.message : "The stage refused before dispatch.", { cause: error });
        }
        throw error;
      }
    };
    const outcome = await inInputStream(streamIdentity, taskId, "action", (context) => {
      streamSignal = context.signal;
      return enqueueTimedStage(queueName, taskId, "action", operationId, guardedRun, stageName);
    }, { stageName, ...(operationId ? { operationId } : {}) });
    if (!recoveryNotice) return outcome;
    return { ...(outcome && typeof outcome === "object" ? outcome : { result: outcome }), recoveryNotice };
  }

  /**
   * Money carve-out: a click whose target looks like it moves or commits money always waits for the
   * owner, no matter what standing approvals exist. Anything else proceeds to the normal action path.
   * The signal is the control's readable label. A control with no label (icons, thumbnails, canvases)
   * carries no money signal, so it is not held; holding every one stalled ordinary media and app work.
   */
  async function moneyGate(name: string, identity: { handle: string; sessionId: string; provider: string },
    clickTarget: { x: number; y: number } | { ref: string; expectedRole?: string; expectedLabel?: string }, mode: TaskStageMode,
    popupTargeted = false): Promise<void> {
    const described = "ref" in clickTarget
      // click_element has no coordinates at all -- it was skipping this gate
      // entirely before, a real security gap, not just a reliability one.
      ? await driver.describeElementTarget(name, clickTarget.ref, { role: clickTarget.expectedRole, label: clickTarget.expectedLabel }, identity)
      : popupTargeted
        ? await driver.describePopupTarget(name, clickTarget.x, clickTarget.y)
      : mode === "owner-preview"
        ? await driver.describeDesktopTarget(name, clickTarget.x, clickTarget.y, identity)
        : await driver.describeTarget(name, clickTarget.x, clickTarget.y, identity);
    // An element reference that no longer resolves is stale: the click itself would miss, so refuse
    // and let the provider look again. A point that cannot be described is simply unlabeled.
    if (!described && "ref" in clickTarget) throw new DesktopInputNotDispatchedError(
      "The stage click target could not be resolved from the current observation; refresh the exact app structure or capture and try again. No input was sent.",
    );
    const gate = stageClickNeedsApproval(described);
    if (!gate.hold) return;
    const approvals = input.approvals?.();
    const target = gate.label ? `“${gate.label}”` : "the unlabeled control in the exact current visual observation";
    if (!approvals) throw new DesktopInputNotDispatchedError(`This click targets ${target}, which requires owner review, and this broker has no owner approval route attached; no input was sent.`);
    const approved = await approvals.requestApproval({
      agent: normalizeHandle(identity.handle),
      provider: identity.provider,
      sessionId: identity.sessionId,
      step: `Clicking ${target} on the stage`,
      ...(gate.label ? { targetLabel: gate.label } : {}),
      // Below the MCP client's own transport timeout, so a slow owner resolves to a clean denial here
      // instead of a proof that is lost in flight. Denial is retryable: it simply asks again.
      timeoutMs: 55_000,
    });
    if (!approved) throw new DesktopInputNotDispatchedError(`The owner did not approve clicking ${target}; the action was not sent. Ask them to approve it in the pill, then try again.`);
  }

  async function launch(token: string, taskId: string, appId: string, requestedMode?: TaskStageMode, operationId?: string, options?: { skipQueue?: boolean }): Promise<StageLaunchResult> {
    const mode = stageMode(requestedMode);
    if (operationId !== undefined && !/^[a-zA-Z0-9._:-]{1,128}$/.test(operationId)) throw new Error("Invalid desktop-stage operation ID.");
    // Only used to route this call to its own stage's queue; run() below re-authorizes
    // at dequeue time, exactly as before this call existed.
    const initial = authorize(token, taskId, mode);
    if (manager.list().find((stage) => stage.name === initial.name)?.fencedBinding && !input.mutationFence) {
      throw new DesktopInputNotDispatchedError("This app target requires the owner broker's mutation fence; no launch or focus action was sent.", "dispatch-gate");
    }
    const queueName = mode === "owner-preview" ? ownerPreviewLaunchQueueKey(initial.task.goal, appId) : initial.name;
    const run = async () => {
      const { name, identity, task } = authorize(token, taskId, mode);
      const coordinationKey = mode === "owner-preview" ? stageCoordinationKey(task.goal) : undefined;
      if (!readPolicy().controlHandles?.includes(normalizeHandle(identity.handle))) throw new Error("The owner has not enabled stage computer control for this agent.");
      // Broker startup warming is intentionally asynchronous, but app launch
      // must not race that warm-up and accidentally make the first task pay
      // cold helper startup while other desktop requests are already queued.
      await warmNativeStageHost();
      // m9r_stage_app is itself a desktop operation and may be the first tool
      // call in a task. Establish the provider's visible overlay before any
      // window discovery, launch, or focus-related work begins.
      await ensureCursorPrimed(name, identity, taskId);
      const receiptInput = operationId ? {
        handle: identity.handle,
        sessionId: identity.sessionId,
        taskId,
        operationId,
        fingerprint: createHash("sha256").update(JSON.stringify({ mode, appId })).digest("hex"),
      } : undefined;
      const finishLaunch = (result: StageLaunchResult): StageLaunchResult => {
        if (!receiptInput) return result;
        const settled = input.store.settleStageOperation({ ...receiptInput, state: "applied" });
        return settled
          ? { ...result, operationReceipt: { operationId, status: "applied", driverReturned: true }, actionExecuted: true }
          : { ...result, operationReceipt: { operationId, status: "uncertain", driverReturned: true }, actionExecuted: true,
            nextStep: "The launch completed, but its durable receipt could not be finalized; inspect the stage before issuing another launch." };
      };
      const presentAndFocusOwnerWindow = async (pid: number, windowId: string, coordinationKey?: string, launched = false) => {
        authorize(token, taskId, mode);
        if (!readPolicy().controlHandles?.includes(normalizeHandle(identity.handle))) throw new Error("Desktop computer control was revoked.");
        await manager.presentOwnerWindow(name, pid, windowId, coordinationKey);
        await manager.attachWindow(name, String(pid), windowId, appId, coordinationKey);
        if (launched) ownerWorkPolicy.carryLaunchGrant(appId, pid, windowId);
        const focused = await driver.focusWindow(name, identity);
        return focused.capture;
      };
      if (receiptInput) {
        const claim = input.store.claimStageOperation(receiptInput);
        if (claim.state === "conflict") throw new Error("This desktop-stage operation ID already belongs to a different launch; no app was started.");
        if (claim.state === "in_progress") return { operationReceipt: { operationId, status: "in_progress", updatedAt: claim.updatedAt }, actionExecuted: false };
        if (claim.state === "applied") return { operationReceipt: { operationId, status: "already_applied", updatedAt: claim.updatedAt }, actionExecuted: false };
        if (claim.state === "uncertain") return { operationReceipt: { operationId, status: "uncertain", updatedAt: claim.updatedAt }, actionExecuted: false,
          nextStep: "Inspect the stage before issuing another launch; the previous launch outcome is not replayable." };
      }
      let launchAttempted = false;
      try {
      let target: StageLaunchTarget;
      if (input.resolveStageAppForTest) {
        target = { app: input.resolveStageAppForTest(appId) };
      } else {
        if (stageAccessMode(readPolicy(), identity.handle) !== "full") {
          throw new Error("This agent has not been granted task-stage access.");
        }
        target = { app: await resolveStageLaunchApp(appId, {
          env: input.stage?.env ?? process.env,
          resolveDirect: () => resolveLaunchTarget(readPolicy(), identity.handle, appId, { env: input.stage?.env ?? process.env }).app,
          discoverInstalledApp: (name) => discoverInstalledWindowsApp(name),
        }) };
      }
      let approved = target.app;
      let rendererLookupAttempted = Boolean(approved.windowExecutable);
      const matchesLaunchedWindows = async (windows: Parameters<typeof stageWindowMatchesApp>[0][]) => {
        let matches = windows.filter((window) => stageWindowMatchesApp(window, approved));
        if (!matches.length && windows.length && !rendererLookupAttempted) {
          rendererLookupAttempted = true;
          // Test launchers never consult the host's installed app inventory.
          const resolveRenderer = input.resolveWindowExecutable
            ?? (input.resolveStageAppForTest ? undefined : discoverInstalledWindowExecutable);
          const windowExecutable = await resolveRenderer?.(approved.executable);
          if (windowExecutable) {
            approved = { ...approved, windowExecutable };
            matches = windows.filter((window) => stageWindowMatchesApp(window, approved));
          }
        }
        return matches;
      };
      // The "same app already running" reuse check previously only ran for the
      // background-mode branch below -- owner-preview launches skipped it
      // entirely, so a follow-up launch of the same app under a new taskId
      // (the normal case for a continuing session) always opened a second
      // window instead of reusing the one already open, regardless of mode.
      const priorOwned = ownedApps.get(name) ?? recoverPersistedApp(name, taskId);
      if (priorOwned && priorOwned.appId === appId) {
        let sameWindowIsRunning = false;
        try {
          // A PID/HWND/process-generation match only proves that the same
          // process still owns that numeric window handle. ApplicationFrameHost
          // can reuse one long-lived HWND for a different packaged app, so a
          // persisted stage anchor is not proof that this is still the app the
          // task selected. Recheck the app identity from the live native
          // inventory before treating a saved anchor as an already-open app.
          const liveWindows = await manager.listOwnedWindowsForProcess(priorOwned.pid);
          const live = liveWindows.find((window) => window.windowId.toLowerCase() === priorOwned.windowId.toLowerCase());
          sameWindowIsRunning = Boolean(live && stageWindowMatchesApp({
            pid: live.pid,
            windowId: live.windowId,
            appName: live.processName ?? live.className ?? "",
            processName: live.processName,
            processPath: live.processPath,
            appUserModelId: live.appUserModelId,
            title: live.title,
          }, approved));
        } catch (error) {
          if (!isStageWindowGoneError(error)) {
            // Timeouts and malformed inspection responses never imply that
            // the prior app is gone, and must not trigger a duplicate launch.
            throw error;
          }
        }
        if (sameWindowIsRunning) {
          if (mode === "owner-preview") {
            const capture = await presentAndFocusOwnerWindow(priorOwned.pid, priorOwned.windowId, coordinationKey);
            return finishLaunch({ name, taskId, appId, running: true, reused: true, view: "app", foregroundConfirmed: true, capture });
          }
          return finishLaunch({ name, taskId, appId, running: true });
        }
        // The numeric handle still existed but now belongs to another app.
        // Retire only this stale identity mapping; never close or mutate the
        // window that currently occupies it.
        manager.clearOwnedAnchor(name, priorOwned.pid, priorOwned.windowId);
        ownedApps.delete(name);
        browserSpaces.remove(`space-${name}`);
      }
      if (mode === "owner-preview") {
        const preLoopStartedAt = Date.now();
        const preLoopStartedTick = performance.now();
        await manager.ensureStage(name);
        const before = await listVisibleWindows();
        process.stderr.write(`[stage-launch-pre] ${taskId}: listVisibleWindows done after ${Date.now() - preLoopStartedAt}ms total, found ${before.length} windows\n`);
        const preLoopEndedAt = new Date().toISOString();
        recordStageTiming(taskId, {
          phase: "launch-preflight",
          startedAt: new Date(preLoopStartedAt).toISOString(),
          endedAt: preLoopEndedAt,
          durationMs: performance.now() - preLoopStartedTick,
          status: "ok",
          ...(operationId ? { operationId } : {}),
          detail: `visibleWindows=${before.length}`,
        });
        const kind = stageBrowserKind(approved.executable);
        // A same-intent task from another provider may already have selected
        // this exact window. Join that durable coordination group instead of
        // launching a second Calculator/Notepad/Explorer window. The registry
        // lease is shared only for the same hashed intent; unrelated stages
        // remain isolated and cannot silently adopt one another's HWND.
        if (coordinationKey) {
          const coordinated = [] as Array<Parameters<typeof selectTargetAppWindow>[0][number]>;
          for (const candidate of manager.list().filter((stage) => stage.name !== name
            && stage.appId === appId && stage.coordinationKey === coordinationKey && stage.anchor)) {
            try {
              const inspected = await manager.inspectStage(candidate.name);
              if (!inspected.anchor) continue;
              // Cross-check against the live window inventory before trusting another
              // stage's anchor: a coordination group can carry forward a stale anchor
              // (e.g. a shell/desktop window mistakenly captured by an earlier launch)
              // that stageWindowMatchesApp would otherwise have refused to join.
              const live = before.find((window) => window.pid === inspected.anchor!.pid
                && window.windowId.toLowerCase() === inspected.anchor!.windowId.toLowerCase());
              // A durable registry anchor is only a hint. It must still exist
              // in the current native inventory and match this app's exact
              // identity before it can be joined.
              if (!live || !stageWindowMatchesApp(live, approved)) continue;
              coordinated.push(live);
            } catch { /* stale groups are retained as recovery evidence, not adopted */ }
          }
          if (coordinated.length > 0) {
            let foreground: Awaited<ReturnType<typeof manager.currentForegroundWindow>> | undefined;
            if (coordinated.length > 1) {
              try { foreground = await manager.currentForegroundWindow(); } catch { /* Win32 z-order remains the fallback among exact matches. */ }
            }
            const selected = selectTargetAppWindow(coordinated, foreground);
            if (!selected) throw new Error("The coordinated app window disappeared before it could be joined.");
            authorize(token, taskId, mode);
            if (!readPolicy().controlHandles?.includes(normalizeHandle(identity.handle))) throw new Error("Desktop computer control was revoked.");
            ownedApps.set(name, { taskId, appId, pid: selected.pid, windowId: selected.windowId, ownsProcess: false });
            bindBrowserSpace(name, approved.executable, selected.pid, selected.windowId);
            const capture = await presentAndFocusOwnerWindow(selected.pid, selected.windowId, coordinationKey);
            return finishLaunch({ name, taskId, appId, running: true, reused: true, view: "app", foregroundConfirmed: true, capture });
          }
        }
        const existingMatches = kind ? undefined : await matchesLaunchedWindows(before);
        let foreground: Awaited<ReturnType<typeof manager.currentForegroundWindow>> | undefined;
        if ((existingMatches?.length ?? 0) > 1 || (kind && hasAmbiguousExistingPersonalBrowserWindow(kind, before))) {
          try { foreground = await manager.currentForegroundWindow(); } catch { /* Exact candidates and native Z order remain available. */ }
        }
        // Windows can recycle an ApplicationFrameWindow HWND while switching
        // the hosted app view. Track the target app identity before launch,
        // rather than every HWND, so a reused frame can still prove that the
        // requested app appeared with its exact AUMID after activation.
        const beforeTargetWindowKeys = new Set((existingMatches ?? []).map(windowIdentityKey));
        const existing = kind
          ? selectExistingPersonalBrowserWindow(kind, before, foreground)
          : selectTargetAppWindow(existingMatches ?? [], foreground);
        if (existing) {
          authorize(token, taskId, mode);
          if (!readPolicy().controlHandles?.includes(normalizeHandle(identity.handle))) throw new Error("Desktop computer control was revoked.");
          ownedApps.set(name, { taskId, appId, pid: existing.pid, windowId: existing.windowId, ownsProcess: false });
          bindBrowserSpace(name, approved.executable, existing.pid, existing.windowId);
          const capture = await presentAndFocusOwnerWindow(existing.pid, existing.windowId, coordinationKey);
          return finishLaunch({ name, taskId, appId, running: true, reused: true, view: "app", foregroundConfirmed: true, capture });
        }
        // Normal profile, normal executable, fixed owner-resolved arguments.
        // If no existing personal browser window was discoverable, open a fresh same-profile
        // window with no forced start URL, so it looks like Chrome actually opening -- its own
        // real new-tab page, the way a human opening Chrome sees it. Existing personal windows
        // are adopted above and are never replaced by this fallback.
        const beforeKeys = new Set(before.map(windowIdentityKey));
        const launchSpec = kind
          ? ownedBrowserLaunch(root, name, approved)
          : approved;
        await ownerWorkPolicy.authorize({ op: "launch", windowId: `app:${appId}` });
        launchAttempted = true;
        const child = launchStageApp(launchSpec, { windowsHide: false, cwd: stageAppLaunchCwd(task.cwd) });
        let launchError: Error | undefined;
        child.on("error", (error) => { launchError = error; });
        try {
          const pollStartedAt = Date.now();
          // Window enumeration can be slow while Windows is creating a packaged
          // ApplicationFrameHost view or delegating a browser launch. Use an
          // elapsed-time budget rather than a fixed number of probes, and leave
          // a small margin below the broker mutation/transport deadlines. The
          // budget is shared by every app; no app-specific timeout is needed.
          const LAUNCH_POLL_BUDGET_MS = 55_000;
          const LAUNCH_POLL_ATTEMPTS = 120;
          const discoveryStartedAtMs = Date.now();
          const discoveryStartedTick = performance.now();
          let discoveryAttempts = 0;
          let slowPollCount = 0;
          let maxPollMs = 0;
          const slowPollAttempts: number[] = [];
          let discoveryCompletedAt: { atMs: number; tick: number } | undefined;
          try {
          for (let attempt = 0; attempt < LAUNCH_POLL_ATTEMPTS && Date.now() - pollStartedAt < LAUNCH_POLL_BUDGET_MS; attempt++) {
            discoveryAttempts = attempt + 1;
            authorize(token, taskId, mode);
            if (!readPolicy().controlHandles?.includes(normalizeHandle(identity.handle))) throw new Error("Desktop computer control was revoked.");
            if (launchError) throw launchError;
            const iterationStartedAt = Date.now();
            const windows = await listVisibleWindows();
            const iterationMs = Date.now() - iterationStartedAt;
            maxPollMs = Math.max(maxPollMs, iterationMs);
            if (iterationMs > 500) {
              slowPollCount += 1;
              if (slowPollAttempts.length < 4) slowPollAttempts.push(attempt);
            }
            if (iterationMs > 500 || attempt % 10 === 0) {
              process.stderr.write(`[stage-launch-poll] ${taskId}: attempt ${attempt} took ${iterationMs}ms (${Date.now() - pollStartedAt}ms elapsed total)\n`);
            }
            // Windows packaged apps may delegate to another PID. Select the new
            // exact window of the resolved executable, never the launcher stub.
            const appMatches = await matchesLaunchedWindows(windows);
            const matches = appMatches.filter((window) => !beforeTargetWindowKeys.has(windowIdentityKey(window)));
            // Chromium can briefly expose several delegated HWND records for
            // one --new-window launch (renderer/helper/host). Use the same
            // eligibility/ranking policy as existing-browser adoption instead
            // of treating the broad launch inventory as user ambiguity.
            let currentForeground: Awaited<ReturnType<typeof manager.currentForegroundWindow>> | undefined;
            if (matches.length > 1) {
              try { currentForeground = await manager.currentForegroundWindow(); } catch { /* Exact identity and z-order determine the fallback. */ }
            }
            const selected = kind
              ? selectPersonalBrowserWindow(kind, matches, beforeKeys)
              : selectTargetAppWindow(matches, currentForeground);
            if (selected) {
              discoveryCompletedAt = { atMs: Date.now(), tick: performance.now() };
              ownedApps.set(name, { taskId, appId, pid: selected.pid, windowId: selected.windowId, ownsProcess: false });
              bindBrowserSpace(name, approved.executable, selected.pid, selected.windowId);
              // An explicit owner-preview app launch owns this focus transition:
              // activate the exact new HWND once, verify its PID/HWND natively, and
              // return that same capture. No taskbar hunt or extra observe round trip.
              const capture = await presentAndFocusOwnerWindow(selected.pid, selected.windowId, coordinationKey, true);
              return finishLaunch({ name, taskId, appId, running: true, reused: false, view: "app", foregroundConfirmed: true, capture });
            }
            // Start responsive, then back off slightly under a busy desktop so
            // polling does not starve the window-creation work it is waiting for.
            await delay(Math.min(400, 100 + attempt * 5));
          }
          throw new Error("The requested application did not expose a new exact window. Its launcher response is not proof it opened.");
          } finally {
            recordStageTiming(taskId, {
              phase: "launch-discovery",
              startedAt: new Date(discoveryStartedAtMs).toISOString(),
              endedAt: new Date(discoveryCompletedAt?.atMs ?? Date.now()).toISOString(),
              durationMs: (discoveryCompletedAt?.tick ?? performance.now()) - discoveryStartedTick,
              status: discoveryCompletedAt ? "ok" : "error",
              ...(operationId ? { operationId } : {}),
              detail: `path=owner-preview;pollAttempts=${discoveryAttempts};pollBudgetMs=${LAUNCH_POLL_BUDGET_MS};window=${discoveryCompletedAt ? "found" : "not-found"};slowPolls=${slowPollCount};maxPollMs=${maxPollMs};slowAttempts=${slowPollAttempts.join(",") || "none"}`,
            });
          }
        } catch (error) {
          // A failed owner-preview launch must not leave a task-created ordinary
          // app behind. Personal browser launches are delegation stubs and are
          // safe to leave only when they have already exited; never terminate a
          // pre-existing owner browser process.
          if (child.exitCode === null && !child.killed && !kind) child.kill();
          throw error;
        }
      }
      const prior = ownedApps.get(name) ?? recoverPersistedApp(name, taskId);
      if (prior) {
        let running = false;
        if (prior.process) {
          running = prior.process.exitCode === null && !prior.process.killed;
        } else {
          try {
            const inspected = await manager.inspectStage(name);
            running = inspected.anchor?.pid === prior.pid && inspected.anchor.windowId === prior.windowId;
          } catch { /* the personal browser window may have been closed; launch a fresh one */ }
        }
        if (running) {
          // Same stage, same identity/session (see authorize()) -- a real session
          // naturally issues a fresh taskId for a follow-up launch of the app it
          // already has running. Only a genuinely different app is a real conflict.
          if (prior.appId !== appId) throw new Error("This session already has an unfinished stage app.");
          return finishLaunch({ name, taskId, appId, running: true });
        }
        ownedApps.delete(name);
        browserSpaces.remove(`space-${name}`);
      }
      if (!manager.list().some((stage) => stage.name === name)) {
        // The stage is a broker-side identity map. It does not create or
        // switch Windows desktops as a side effect of app launch.
        await manager.ensureStage(name);
      }
      authorize(token, taskId, mode);
      if (!readPolicy().controlHandles?.includes(normalizeHandle(identity.handle))) throw new Error("Stage computer control was revoked.");
      const browserKind = stageBrowserKind(approved.executable);
      const personalBrowser = browserKind !== undefined;
      // Snapshot every visible window before launch. Packaged Windows apps and
      // launcher-style apps (Explorer, Notepad, Calculator, etc.) are allowed
      // to hand the request to another process and exit immediately; the new
      // window, not the launcher PID, is the durable ownership signal.
      const beforeLaunchWindows = await listVisibleWindows();
      const beforeLaunchWindowKeys = new Set(beforeLaunchWindows.map(windowIdentityKey));
      const beforeTargetWindows = await matchesLaunchedWindows(beforeLaunchWindows);
      const beforeTargetWindowKeys = new Set(beforeTargetWindows.map(windowIdentityKey));
      const beforeBrowserWindows = personalBrowser ? beforeLaunchWindowKeys : undefined;
      // A new process can activate itself even with STARTUPINFO's hidden hint.
      // Until a specific launcher proves otherwise, ask before that side effect.
      await ownerWorkPolicy.authorize({ op: "launch", windowId: `app:${appId}` });
      launchAttempted = true;
      const child = launchStageApp(ownedBrowserLaunch(root, name, approved), { windowsHide: true, cwd: stageAppLaunchCwd(task.cwd) });
      let spawnError: Error | undefined;
      child?.on("error", (error) => { spawnError = error; });
      try {
        const discoveryStartedAtMs = Date.now();
        const discoveryStartedTick = performance.now();
        let discoveryAttempts = 0;
        let discoveryCompletedAt: { atMs: number; tick: number } | undefined;
        try {
        for (let attempt = 0; attempt < 40; attempt++) {
          discoveryAttempts = attempt + 1;
          authorize(token, taskId, mode);
          if (!readPolicy().controlHandles?.includes(normalizeHandle(identity.handle))) throw new Error("Stage computer control was revoked.");
          // Personal Chromium commonly exits its launcher PID immediately after
          // handing the request to the already-running browser process. The
          // Cua window list, not that transient PID, is the ownership proof.
          const processPid = child?.pid;
          if (!child || spawnError || child.killed || !processPid) {
            throw new Error("The approved app did not start a persistent owned process.");
          }
          let selectedPid = child.pid;
          let selectedWindowId: string | undefined;
          let candidateWindows: BrowserWindowCandidate[];
          if (personalBrowser) {
            const candidate = selectPersonalBrowserWindow(browserKind!, await listVisibleWindows(), beforeBrowserWindows!);
            if (!candidate) {
              await delay(100);
              continue;
            }
            selectedPid = candidate.pid;
            selectedWindowId = candidate.windowId;
            candidateWindows = [candidate];
          } else {
            // Prefer exact child-process windows, but keep polling after the
            // launcher exits: many ordinary Windows apps hand off to an
            // existing/app-model process before the child receives its exit
            // event. The pre-launch snapshot prevents adopting an unrelated
            // already-open window.
            let exactProcessWindows: BrowserWindowCandidate[] = [];
            try {
              exactProcessWindows = (await manager.listOwnedWindowsForProcess(processPid)).map((window) => ({
                ...window,
                appName: window.processName ?? window.className ?? "",
                ...(window.processPath ? { processPath: window.processPath } : {}),
                ...(window.appUserModelId ? { appUserModelId: window.appUserModelId } : {}),
              })).filter((window) => stageWindowMatchesApp(window, approved));
            } catch {
              // A launcher can disappear before its transient process can be
              // enumerated. The desktop-wide window snapshot below remains
              // the safe hand-off path.
            }
            // A launcher PID is not automatically the app window identity.
            // AppsFolder and other delegated launches can use Explorer as a
            // dispatcher; only keep same-process HWNDs that also prove the
            // resolved target's exact app identity.
            const visibleWindows = await listVisibleWindows();
            const delegatedWindows = (await matchesLaunchedWindows(visibleWindows))
              .filter((window) => !beforeTargetWindowKeys.has(windowIdentityKey(window)));
            const candidates = [...exactProcessWindows, ...delegatedWindows.filter((window) =>
              !exactProcessWindows.some((exact) => exact.pid === window.pid && exact.windowId === window.windowId))];
            candidateWindows = candidates;
            const selected = selectTargetAppWindow(candidateWindows);
            if (selected) selectedPid = selected.pid;
          }
          const selectedWindow = selectTargetAppWindow(candidateWindows);
          if (selectedWindow) {
            discoveryCompletedAt = { atMs: Date.now(), tick: performance.now() };
            authorize(token, taskId, mode);
            if (!readPolicy().controlHandles?.includes(normalizeHandle(identity.handle))) throw new Error("Stage computer control was revoked.");
            selectedWindowId = selectedWindow.windowId;
            selectedPid = selectedWindow.pid;
            if (selectedPid === undefined) throw new Error("The approved app did not expose a process id.");
            const ownedPid = selectedPid;
            // App launch binds the exact HWND on the owner's visible desktop.
            // The retired background-stage path moved this window through
            // private virtual-desktop APIs, which made ordinary launches slow
            // and could leave the owner unable to see or target the app.
            await manager.presentOwnerWindow(name, ownedPid, selectedWindowId);
            await manager.attachWindow(name, String(ownedPid), selectedWindowId, appId);
            ownedApps.set(name, {
              taskId,
              appId,
              pid: ownedPid,
              ...(personalBrowser ? {} : { process: child }),
              ownsProcess: !personalBrowser,
              windowId: selectedWindowId,
            });
            bindBrowserSpace(name, approved.executable, ownedPid, selectedWindowId);
            return finishLaunch({ name, taskId, appId, running: true });
          }
          await delay(100);
        }
        throw new Error(personalBrowser
          ? `Personal ${browserKind === "chrome" ? "Chrome" : "Edge"} did not expose a new task window; the existing personal window was left untouched.`
          : "The app exposes no supported exact-process window; it requires an app-specific launch adapter.");
          } finally {
            recordStageTiming(taskId, {
              phase: "launch-discovery",
              startedAt: new Date(discoveryStartedAtMs).toISOString(),
              endedAt: new Date(discoveryCompletedAt?.atMs ?? Date.now()).toISOString(),
              durationMs: (discoveryCompletedAt?.tick ?? performance.now()) - discoveryStartedTick,
              status: discoveryCompletedAt ? "ok" : "error",
              ...(operationId ? { operationId } : {}),
              detail: `path=stage-launch;pollAttempts=${discoveryAttempts};maxAttempts=40;window=${discoveryCompletedAt ? "found" : "not-found"}`,
            });
          }
      } catch (error) {
        if (child && child.exitCode === null && !child.killed) child.kill();
        throw error;
      }
      } catch (error) {
        if (receiptInput) {
          if (error instanceof DesktopInputNotDispatchedError && !launchAttempted) {
            input.store.releaseStageOperation(receiptInput);
            throw error;
          }
          try { input.store.settleStageOperation({ ...receiptInput, state: "uncertain" }); } catch { /* preserve the running receipt to block replay */ }
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(`The desktop launch outcome is uncertain; inspect the stage before issuing another launch. ${detail}`, { cause: error });
        }
        throw error;
      }
      };
    // `act()`'s own window-recovery path calls this function from inside its own
    // currently-executing turn on this same stage's queue -- queuing again here
    // would wait for that exact turn to finish before running, which cannot happen
    // because that turn is itself awaiting this call. A real, silent deadlock, not
    // slowness: this is what the ~70s timeouts actually were. skipQueue lets an
    // already-queued caller run this launch immediately instead of behind itself.
    if (options?.skipQueue) return withActiveTimingTask(initial.name, taskId, operationId,
      () => timedStagePhase(taskId, "launch", operationId, run)) as Promise<StageLaunchResult>;
    return inInputStream(initial.identity, taskId, "launch", () =>
      enqueueTimedStage(queueName, taskId, "launch", operationId, run, initial.name)) as Promise<StageLaunchResult>;
  }

  async function closeApp(token: string, taskId: string, requestedMode?: TaskStageMode) {
    const mode = stageMode(requestedMode);
    // Only used to route this call to its own stage's queue; run() below re-authorizes
    // at dequeue time, exactly as before this call existed.
    const { name: queueName, identity: streamIdentity } = authorize(token, taskId, mode);
    const run = async () => {
      const { name } = authorize(token, taskId, mode);
      const app = ownedApps.get(name);
      // Same stage, same identity/session (see authorize()) -- not gated on the exact
      // taskId that originally launched it, for the same reason as elsewhere in this file.
      if (!app) throw new Error("This task has no broker-owned app to discard.");
      manager.clearOwnedAnchor(name, app.pid, app.windowId);
      // Personal Chrome belongs to the user. Discarding a task detaches the
      // stage anchor but never closes the user's browser process.
      const sharedWithAnotherTask = manager.list().some((stage) => stage.name !== name
        && stage.anchor?.pid === app.pid && stage.anchor.windowId === app.windowId
        && stage.agentAssignment?.taskId && taskActive(stage.agentAssignment.taskId));
      if (!sharedWithAnotherTask && app.ownsProcess && app.process && app.process.exitCode === null && !app.process.killed) app.process.kill();
      ownedApps.delete(name);
      browserSpaces.remove(`space-${name}`);
      return { name, taskId, closed: true };
    };
    return inInputStream(streamIdentity, taskId, "close", () => enqueueTimedStage(queueName, taskId, "close", undefined, run, queueName));
  }

  // Foreground approvals carry a native physical-input hook while they are
  // valid. Reap paused/completed tasks and mode revisions even when no cursor
  // happens to be registered (for example after an owner closes the pill).
  // This does its own synchronous file read (readOwnerWorkPreference) every
  // tick, so it keeps its own slower, independent cadence rather than sharing
  // one with the cursor reconcile below -- tightening cursor-hide latency
  // must not multiply this unrelated file-I/O cost.
  const grantReaper = setInterval(() => { ownerWorkPolicy.reapRevokedGrants(); }, 2000);
  grantReaper.unref();

  const cursorReaper = setInterval(() => {
    if (activeAgentCursors.size === 0 || cursorReaperQueued) return;
    cursorReaperQueued = true;
    const reconcile = async () => {
      for (const [key, active] of activeAgentCursors) {
        // A task stuck forever in a non-terminal lifecycle state (never completed, never failed, never
        // canceled) would otherwise hold its cursor indefinitely -- taskActive() alone never goes false
        // for it. Force the same cleanup once the cursor has clearly outlived any legitimate task.
        const expired = Date.now() - active.primedAt >= CURSOR_MAX_LIFETIME_MS;
        console.error(`[cursor-lifecycle] reap-check key=${key} task=${active.taskId} taskActive=${taskActive(active.taskId)} expired=${expired} ageMs=${Date.now() - active.primedAt}`);
        if (!taskActive(active.taskId) || expired) {
          ownerWorkPolicy.revokeTask({ agent: active.identity.handle, provider: active.identity.handle,
            sessionId: active.identity.sessionId, taskId: active.taskId });
          try {
            await driver.closeAgentCursor(active.identity);
            // The visible marker is task-scoped; the native input host is
            // agent-session-scoped and must survive a completed task so the
            // next task keeps the same independent stream identity/process.
            activeAgentCursors.delete(key);
            cursorPresentationTask.delete(key);
            cursorAuthFailures.delete(key);
          } catch { /* retry terminal-task cleanup on the next tick */ }
          continue;
        }
        let authorized = false;
        try {
          const token = input.store.identityTokenFor(active.identity.handle, active.identity.sessionId);
          const current = token ? input.store.verifyIdentity(token) : null;
          const policy = readPolicy();
          authorized = Boolean(current && current.sessionId === active.identity.sessionId
            && normalizeHandle(current.handle) === normalizeHandle(active.identity.handle)
            && policy.handles.includes(normalizeHandle(active.identity.handle)));
        } catch { /* policy or identity storage failure counts as a failed tick below */ }
        if (authorized) {
          cursorAuthFailures.delete(key);
          continue;
        }
        const failures = (cursorAuthFailures.get(key) ?? 0) + 1;
        cursorAuthFailures.set(key, failures);
        if (failures < CURSOR_REVOKE_AFTER_FAILURES) continue;
        try {
          await driver.closeAgentCursor(active.identity);
          manager.closeInputStream?.(agentInputStreamId(active.identity));
          activeAgentCursors.delete(key);
          cursorPresentationTask.delete(key);
          cursorAuthFailures.delete(key);
        } catch { /* retry revocation on the next tick; Driver idle-hide is the fail-safe */ }
      }
    };
    const result = reaperPending.then(reconcile, reconcile);
    reaperPending = result.catch(() => undefined).finally(() => { cursorReaperQueued = false; });
  }, 250);
  cursorReaper.unref();

  async function close() {
    clearInterval(grantReaper);
    clearInterval(cursorReaper);
    for (const active of activeInputs.values()) active.controller.abort(new Error("Stage service closing."));
    await inputStreams.close();
    await Promise.all([...stageQueues.values(), reaperPending]);
    activeAgentCursors.clear();
    cursorPresentationTask.clear();
    observedRegionRevisions.clear();
    try {
      await driver.shutdown();
    } finally {
      // The task service owns the shared Windows stage manager.  Closing it
      // here prevents the persistent native helper from surviving a broker
      // restart and guarantees the next service starts with one clean host.
      if (ownsManager) manager.close?.();
    }
  }

  return { prepare, primeCursor, primeCursorForOwner, act, launch, closeApp, sayAgentCursor, close, inputStreamSnapshot: inputStreams.snapshot };
}
