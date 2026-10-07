import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isAgentContext } from "./approval-core";
import { normalizeHandle } from "./inbox-core";
import type { LocalStore } from "./local-store";
import { createWindowsDesktopStageManager, type WindowsStageDependencies } from "./windows-desktop-stage";
import { createCuaStageDriver, type CuaAgentCursorIdentity } from "./cua-stage-driver";
import { parseTaskStageAction, runTaskStageAction, stageClickNeedsApproval } from "./task-stage-actions";
import type { StageApprovalRequest } from "./web-broker-core";
import {
  launchApprovedStageApp,
  listApprovedStageApps,
  ownedBrowserLaunch,
  readApprovedStageApp,
  resolveUnlistedStageApp,
  selectPersonalBrowserWindow,
  stageBrowserKind,
  type ApprovedStageApp,
  type BrowserLaunchMode,
} from "./task-stage-apps";
import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export const TASK_STAGE_POLICY_FILE = "task-stage-policy.json";
export type TaskStageMode = "background" | "owner-preview";

/**
 * Per-agent access mode. `scoped` is the historical behavior (catalog apps only; control iff listed).
 * `full` additionally allows broker-resolved or absolute-path apps with fixed empty args, hash-recorded
 * at launch. `request` resolves the same set but holds unlisted launches for owner approval. The money
 * carve-out holds in every mode. Absent entries behave as `scoped`.
 */
export type TaskStageAccessMode = "full" | "scoped" | "request";
const ACCESS_MODES: readonly TaskStageAccessMode[] = ["full", "scoped", "request"];

function stageMode(value: unknown): TaskStageMode {
  return value === "owner-preview" ? "owner-preview" : "background";
}

export function setTaskStagePermission(root: string, handle: string, enabled: boolean, context: { terminal: boolean; env: Record<string, string | undefined> }, control = false, mode?: TaskStageAccessMode) {
  if (!context.terminal || isAgentContext(context.env)) throw new Error("Only the owner can change agent stage permissions.");
  handle = normalizeHandle(handle);
  if (!/^[a-z0-9_-]{1,40}$/.test(handle)) throw new Error("Invalid agent handle.");
  if (mode !== undefined && !ACCESS_MODES.includes(mode)) throw new Error("Invalid stage access mode.");
  mkdirSync(root, { recursive: true });
  const file = join(root, TASK_STAGE_POLICY_FILE);
  const lock = `${file}.lock`;
  mkdirSync(lock);
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    const policy = readTaskStagePolicy(root);
    const handles = policy.handles.filter((value) => value !== handle);
    const controlHandles = (policy.controlHandles ?? []).filter((value) => value !== handle);
    const modes = { ...(policy.modes ?? {}) } as Record<string, TaskStageAccessMode>;
    delete modes[handle];
    // Deterministic mapping: each grant writes the full triple, so the file always says what it means.
    // allow-agent -> scoped without control; allow-control -> scoped with control; allow-full -> full with control.
    // "scoped" is the default and is never persisted, so legacy files read back unchanged.
    if (enabled) {
      handles.push(handle);
      if (control || policy.controlHandles?.includes(handle)) controlHandles.push(handle);
      if (mode !== undefined && mode !== "scoped") modes[handle] = mode;
      if (mode === "full" && !controlHandles.includes(handle)) controlHandles.push(handle);
    }
    if (handles.length > 16) throw new Error("At most 16 agents may use task stages.");
    const sortedModes: Record<string, TaskStageAccessMode> = {};
    for (const key of Object.keys(modes).sort()) sortedModes[key] = modes[key]!;
    writeFileSync(temporary, JSON.stringify({ version: 1, handles: handles.sort(), controlHandles: controlHandles.sort(), ...(Object.keys(sortedModes).length ? { modes: sortedModes } : {}) }) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
    return { handles };
  } finally {
    rmSync(temporary, { force: true });
    rmSync(lock, { recursive: true, force: true });
  }
}

/** Owner-written policy. A task approval alone never grants computer access. */
export function readTaskStagePolicy(root: string): { handles: string[]; controlHandles?: string[]; modes?: Record<string, TaskStageAccessMode> } {
  const file = join(root, TASK_STAGE_POLICY_FILE);
  if (!existsSync(file)) return { handles: [] };
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

/** Effective access mode. Legacy entries without a modes record behave as scoped. */
export function stageAccessMode(policy: { handles: string[]; modes?: Record<string, TaskStageAccessMode> }, handle: string): TaskStageAccessMode {
  const mode = policy.modes?.[normalizeHandle(handle)];
  return mode === "full" || mode === "request" ? mode : "scoped";
}

export interface StageLaunchTarget {
  app: ApprovedStageApp;
  /** Set when the owner's yes is required before spawning (request mode, unlisted app). */
  needsApproval?: { step: string; targetLabel: string };
}

/**
 * Pure launch decision: catalog hit, full-mode broker resolution, or request-mode hold. Scoped
 * misses refuse exactly as before. No process is started here; launch() owns spawning and custody.
 */
export function resolveLaunchTarget(root: string, policy: { handles: string[]; modes?: Record<string, TaskStageAccessMode> }, handle: string, appId: string, opts: { env?: Record<string, string | undefined>; exists?: (path: string) => boolean } = {}): StageLaunchTarget {
  try {
    return { app: readApprovedStageApp(root, appId) };
  } catch {
    const access = stageAccessMode(policy, handle);
    // Catalog miss: full mode resolves broker-fixed ids (and absolute paths, audited); request mode
    // holds the same resolution for the owner; scoped keeps the historical refusal.
    if (access === "scoped") throw new Error("This app has not been approved for task stages.");
    const resolved = resolveUnlistedStageApp(appId, { allowAbsolutePath: access === "full", ...(opts.env ? { env: opts.env } : {}), ...(opts.exists ? { exists: opts.exists } : {}) });
    if (access === "full") return { app: resolved };
    return { app: resolved, needsApproval: { step: `Launching ${appId} on the stage`, targetLabel: resolved.executable } };
  }
}

/** This service belongs to the owner-launched broker, never an agent's MCP child process. */
export function createTaskDesktopStageService(input: {
  store: LocalStore;
  stage?: WindowsStageDependencies;
  readPolicy?: () => { handles: string[]; controlHandles?: string[]; modes?: Record<string, TaskStageAccessMode> };
  /** Test seam: replaces the Cua driver (production always constructs the real one). */
  driver?: ReturnType<typeof createCuaStageDriver>;
  /** Owner-selected browser policy. Personal profile is the safe product default. */
  browserLaunchMode?: BrowserLaunchMode;
  /**
   * Owner-approval route for the money carve-out, resolved lazily because the broker that owns the
   * approval list is constructed after this service. Absent in tests and in brokers without one.
   */
  approvals?: () => { requestApproval(request: StageApprovalRequest): Promise<boolean> } | undefined;
}) {
  const root = input.store.root;
  const bundledHost = join(dirname(process.execPath), "m9r-native-input-host.exe");
  const stageDeps = { nativeHostPath: existsSync(bundledHost) ? bundledHost : undefined, ...input.stage, root, terminal: true };
  const manager = createWindowsDesktopStageManager(stageDeps);
  const driver = input.driver ?? createCuaStageDriver({ stage: stageDeps });
  const readPolicy = input.readPolicy ?? (() => readTaskStagePolicy(root));
  // Serialize preparations so duplicate deliveries cannot create duplicate desktops.
  let pending: Promise<unknown> = Promise.resolve();
  const browserLaunchMode = input.browserLaunchMode ?? "personal";
  const ownedApps = new Map<string, {
    taskId: string;
    appId: string;
    pid: number;
    process?: ChildProcess;
    ownsProcess: boolean;
    windowId: string;
  }>();
  const activeAgentCursors = new Map<string, CuaAgentCursorIdentity>();
  let cursorReaperQueued = false;

  function cursorIdentityKey(identity: CuaAgentCursorIdentity): string {
    return `${normalizeHandle(identity.handle)}\0${identity.sessionId}`;
  }

  function authorize(token: string, taskId: string, mode: TaskStageMode = "background") {
    if (isAgentContext(stageDeps.env ?? process.env)) {
      throw new Error("Task stages require the owner-launched M9R broker; an agent process cannot host this service.");
    }
    const identity = input.store.verifyIdentity(token);
    if (!identity) throw new Error("Stage request identity is invalid or revoked.");
    if (!readPolicy().handles.includes(normalizeHandle(identity.handle))) throw new Error("The owner has not enabled task stages for this agent.");
    const task = input.store.getTask(taskId);
    const handle = normalizeHandle(identity.handle);
    const addressedHandle = identity.sessionId.startsWith("web-") && !handle.startsWith("web-") ? `web-${handle}` : handle;
    if (!task || normalizeHandle(task.to) !== addressedHandle
      || (task.targetSession && task.targetSession !== identity.sessionId)
      || (task.deliveredSession && task.deliveredSession !== identity.sessionId)
      || (task.delivery?.threadId && task.delivery.threadId !== identity.sessionId)) {
      throw new Error("This task does not belong to the requesting agent session.");
    }
    if (!(["approved", "not_needed"] as string[]).includes(task.approval)
      || task.resultSummary !== undefined || task.delivery?.state === "done") {
      throw new Error("Only an approved, unfinished task can use an agent stage.");
    }
    activeAgentCursors.set(cursorIdentityKey(identity), { handle, sessionId: identity.sessionId });
    // Session-scoped reuse bounds desktop creation; task text never becomes a desktop name.
    const prefix = mode === "owner-preview" ? "preview-agent" : "agent";
    const name = `${prefix}-${createHash("sha256").update(`${identity.handle}\0${identity.sessionId}`).digest("hex").slice(0, 24)}`;
    return { identity, task, name, mode };
  }

  async function prepare(token: string, taskId: string, requestedMode: TaskStageMode = "background") {
    const mode = stageMode(requestedMode);
    const run = async () => {
      const { name, identity } = authorize(token, taskId, mode);
      const sessionTag = createHash("sha256").update(`${normalizeHandle(identity.handle)}\0${identity.sessionId}`).digest("hex").slice(0, 8);
      const existing = manager.list().find((stage) => stage.name === name);
      let assignedStage: ReturnType<typeof manager.assignAgent> | undefined;
      if (mode === "background") {
        if (existing) await manager.inspectStage(name);
        else await manager.create(name);
        assignedStage = manager.assignAgent(name, { handle: normalizeHandle(identity.handle), sessionTag });
      } else if (existing) {
        const inspected = await manager.inspectStage(name);
        if (!inspected.desktop.isCurrent) throw new Error("The owner-visible preview stage is not on the owner's current desktop.");
        assignedStage = manager.assignAgent(name, { handle: normalizeHandle(identity.handle), sessionTag });
      }
      // Return opaque coordination IDs only, never desktop GUIDs or owner-window identifiers.
      return { name, mode, agent: normalizeHandle(identity.handle), sessionTag, taskId, hasAnchor: Boolean(assignedStage?.anchor),
        ...(assignedStage ? { roomDesktopId: assignedStage.roomDesktopId } : {}),
        controlEnabled: readPolicy().controlHandles?.includes(normalizeHandle(identity.handle)) === true,
        approvedApps: listApprovedStageApps(root) };
    };
    const result = pending.then(run, run);
    pending = result.catch(() => undefined);
    return result;
  }

  async function act(token: string, taskId: string, value: unknown, requestedMode: TaskStageMode = "background") {
    const mode = stageMode(requestedMode);
    const action = parseTaskStageAction(value);
    const run = async () => {
      const { name, identity } = authorize(token, taskId, mode);
      if (!readPolicy().controlHandles?.includes(normalizeHandle(identity.handle))) throw new Error("The owner has not enabled stage computer control for this agent.");
      const inspected = await manager.inspectStage(name);
      if (mode === "owner-preview" && !inspected.desktop.isCurrent) throw new Error("The owner-visible preview stage is not on the owner's current desktop.");
      // Recheck after inspection and at dequeue time: queued work cannot survive revocation.
      authorize(token, taskId, mode);
      if (!readPolicy().controlHandles?.includes(normalizeHandle(identity.handle))) throw new Error("Stage computer control was revoked.");
      if (action.kind === "click") await moneyGate(name, identity, action.x, action.y);
      // The approval wait above can outlast a revocation: recheck before anything executes.
      authorize(token, taskId, mode);
      if (!readPolicy().controlHandles?.includes(normalizeHandle(identity.handle))) throw new Error("Stage computer control was revoked.");
      const result = await runTaskStageAction(driver, name, action, identity);
      authorize(token, taskId, mode);
      if (!readPolicy().controlHandles?.includes(normalizeHandle(identity.handle))) throw new Error("Stage computer control was revoked.");
      return result;
    };
    const result = pending.then(run, run);
    pending = result.catch(() => undefined);
    return result;
  }

  /**
   * Money carve-out: a click whose target looks like it moves or commits money always waits for the
   * owner, no matter what standing approvals exist. Anything else proceeds to the normal action path.
   * Fail-closed when the target cannot be described: an unidentified control is never assumed harmless.
   */
  async function moneyGate(name: string, identity: { handle: string; sessionId: string; provider: string }, x: number, y: number): Promise<void> {
    let described;
    try {
      described = await driver.describeTarget(name, x, y, identity);
    } catch (error) {
      // No registered window means the click itself will fail below with the anchor error; anything
      // else (unreadable snapshot, missing accessibility tree) holds for the owner instead of guessing.
      if (error instanceof Error && /no registered app window/.test(error.message)) throw error;
      described = undefined;
    }
    const gate = stageClickNeedsApproval(described);
    if (!gate.hold) return;
    const approvals = input.approvals?.();
    const target = gate.label ? `“${gate.label}”` : "an unidentified control";
    if (!approvals) throw new Error(`This click targets ${target}, which looks like it moves or commits money, and this broker has no owner approval route attached; the action was refused.`);
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
    if (!approved) throw new Error(`The owner did not approve clicking ${target}; the action was not sent. Ask them to approve it in the pill, then try again.`);
  }

  async function launch(token: string, taskId: string, appId: string, requestedMode: TaskStageMode = "background") {
    const mode = stageMode(requestedMode);
    const run = async () => {
      const { name, identity } = authorize(token, taskId, mode);
      if (!readPolicy().controlHandles?.includes(normalizeHandle(identity.handle))) throw new Error("The owner has not enabled stage computer control for this agent.");
      const target = resolveLaunchTarget(root, readPolicy(), identity.handle, appId);
      let approved: ApprovedStageApp;
      if (!target.needsApproval) {
        approved = target.app;
      } else {
        const approvals = input.approvals?.();
        if (!approvals) throw new Error(`Launching ${target.needsApproval.targetLabel} needs owner approval, and this broker has no approval route attached; the app was not started.`);
        const allowed = await approvals.requestApproval({
          action: "launch",
          risk: "launch",
          agent: normalizeHandle(identity.handle),
          provider: identity.provider,
          sessionId: identity.sessionId,
          step: target.needsApproval.step,
          targetLabel: target.needsApproval.targetLabel,
          timeoutMs: 55_000,
        });
        if (!allowed) throw new Error(`The owner did not approve launching ${appId}; the app was not started.`);
        authorize(token, taskId, mode);
        if (!readPolicy().controlHandles?.includes(normalizeHandle(identity.handle))) throw new Error("Stage computer control was revoked.");
        approved = target.app;
      }
      const prior = ownedApps.get(name);
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
          if (prior.taskId !== taskId || prior.appId !== appId) throw new Error("This session already has an unfinished stage app.");
          return { name, taskId, appId, running: true };
        }
        ownedApps.delete(name);
      }
      if (mode === "background" && !manager.list().some((stage) => stage.name === name)) await manager.create(name);
      authorize(token, taskId, mode);
      if (!readPolicy().controlHandles?.includes(normalizeHandle(identity.handle))) throw new Error("Stage computer control was revoked.");
      const browserKind = stageBrowserKind(approved.executable);
      const personalBrowser = browserKind !== undefined && browserLaunchMode === "personal";
      const beforeBrowserWindows = personalBrowser
        ? new Set((await driver.listVisibleWindows({ onScreenOnly: mode === "owner-preview" })).map((window) => `${window.pid}:${window.windowId}`))
        : undefined;
      const child = launchApprovedStageApp(ownedBrowserLaunch(root, name, approved, { mode: browserLaunchMode }), { windowsHide: mode !== "owner-preview" });
      let spawnError: Error | undefined;
      child.on("error", (error) => { spawnError = error; });
      let adoptedPersonalBrowser = false;
      try {
        for (let attempt = 0; attempt < 40; attempt++) {
          authorize(token, taskId, mode);
          if (!readPolicy().controlHandles?.includes(normalizeHandle(identity.handle))) throw new Error("Stage computer control was revoked.");
          // Personal Chromium commonly exits its launcher PID immediately after
          // handing the request to the already-running browser process. The
          // Cua window list, not that transient PID, is the ownership proof.
          if (spawnError || child.killed || !child.pid || (!personalBrowser && child.exitCode !== null)) {
            throw new Error("The approved app did not start a persistent owned process.");
          }
          let selectedPid = child.pid;
          let selectedWindowId: string | undefined;
          let candidateWindows: Array<{ pid: number; windowId: string; title?: string; width?: number; height?: number }>;
          if (personalBrowser) {
            const visible = await driver.listVisibleWindows({ onScreenOnly: mode === "owner-preview" });
            const candidate = selectPersonalBrowserWindow(browserKind!, visible, beforeBrowserWindows!);
            if (!candidate) {
              await delay(100);
              continue;
            }
            adoptedPersonalBrowser = true;
            selectedPid = candidate.pid;
            selectedWindowId = candidate.windowId;
            candidateWindows = [candidate];
          } else {
            candidateWindows = mode === "owner-preview"
              ? await manager.listOwnedWindowsForProcess(child.pid)
              : await manager.listOwnedWindows(name, child.pid);
          }
          if (candidateWindows.length > 1) throw new Error("The approved app has multiple candidate windows; owner selection is required.");
          if (candidateWindows.length === 1) {
            authorize(token, taskId, mode);
            if (!readPolicy().controlHandles?.includes(normalizeHandle(identity.handle))) throw new Error("Stage computer control was revoked.");
            selectedWindowId = candidateWindows[0]!.windowId;
            if (mode === "background") await manager.moveOwnedWindow(name, selectedPid, selectedWindowId);
            if (mode === "owner-preview") {
              // Windows can enumerate a newly-created top-level HWND before the
              // shell has attached its virtual-desktop application view.  A
              // single immediate registration then fails with
              // "could not read the window's virtual desktop id".  Retry only
              // that transient readiness boundary; all other errors remain
              // fail-closed and are reported immediately.
              let registered = false;
              let lastRegistrationError: unknown;
              for (let attempt = 0; attempt < 20; attempt++) {
                try {
                  await manager.register(name, String(selectedPid), selectedWindowId);
                  registered = true;
                  break;
                } catch (error) {
                  lastRegistrationError = error;
                  const detail = error instanceof Error ? error.message : String(error);
                  if (!detail.includes("could not read the window's virtual desktop id")
                    && !detail.includes("could not check the window's current virtual desktop")) {
                    throw error;
                  }
                  await delay(100);
                }
              }
              if (!registered) throw lastRegistrationError instanceof Error
                ? lastRegistrationError
                : new Error("Windows did not expose the owner-preview window's virtual desktop view in time.");
              const preview = await manager.inspectStage(name);
              if (!preview.desktop.isCurrent) {
                manager.clearOwnedAnchor(name, selectedPid, selectedWindowId);
                throw new Error("The approved app did not open on the owner's current desktop for the preview stage.");
              }
              const sessionTag = createHash("sha256").update(`${normalizeHandle(identity.handle)}\0${identity.sessionId}`).digest("hex").slice(0, 8);
              await manager.assignAgent(name, { handle: normalizeHandle(identity.handle), sessionTag });
            } else await manager.attachWindow(name, String(selectedPid), selectedWindowId);
            try {
              authorize(token, taskId, mode);
              if (!readPolicy().controlHandles?.includes(normalizeHandle(identity.handle))) throw new Error("Stage computer control was revoked.");
              if (mode === "background") await manager.showOwnedWindow(name);
              authorize(token, taskId, mode);
              if (!readPolicy().controlHandles?.includes(normalizeHandle(identity.handle))) throw new Error("Stage computer control was revoked.");
            }
            catch (error) { manager.clearOwnedAnchor(name, selectedPid, selectedWindowId); throw error; }
            ownedApps.set(name, {
              taskId,
              appId,
              pid: selectedPid,
              ...(personalBrowser ? {} : { process: child }),
              ownsProcess: !personalBrowser,
              windowId: selectedWindowId,
            });
            return { name, taskId, appId, running: true };
          }
          await delay(100);
        }
        throw new Error(personalBrowser
          ? `Personal ${browserKind === "chrome" ? "Chrome" : "Edge"} did not expose a new task window; the existing personal window was left untouched.`
          : "The app exposes no supported exact-process window; it requires an app-specific launch adapter.");
      } catch (error) {
        if (!adoptedPersonalBrowser && child.exitCode === null && !child.killed) child.kill();
        throw error;
      }
    };
    const result = pending.then(run, run); pending = result.catch(() => undefined); return result;
  }

  async function closeApp(token: string, taskId: string, requestedMode: TaskStageMode = "background") {
    const mode = stageMode(requestedMode);
    const run = async () => {
      const { name } = authorize(token, taskId, mode);
      const app = ownedApps.get(name);
      if (!app || app.taskId !== taskId) throw new Error("This task has no broker-owned app to discard.");
      manager.clearOwnedAnchor(name, app.pid, app.windowId);
      // Personal Chrome belongs to the user. Discarding a task detaches the
      // stage anchor but never closes the user's browser process.
      if (app.ownsProcess && app.process && app.process.exitCode === null && !app.process.killed) app.process.kill();
      ownedApps.delete(name);
      return { name, taskId, closed: true };
    };
    const result = pending.then(run, run); pending = result.catch(() => undefined); return result;
  }

  const cursorReaper = setInterval(() => {
    if (activeAgentCursors.size === 0 || cursorReaperQueued) return;
    cursorReaperQueued = true;
    const reconcile = async () => {
      for (const [key, identity] of activeAgentCursors) {
        let authorized = false;
        try {
          const token = input.store.identityTokenFor(identity.handle, identity.sessionId);
          const current = token ? input.store.verifyIdentity(token) : null;
          const policy = readPolicy();
          authorized = Boolean(current && current.sessionId === identity.sessionId
            && normalizeHandle(current.handle) === normalizeHandle(identity.handle)
            && policy.handles.includes(normalizeHandle(identity.handle))
            && policy.controlHandles?.includes(normalizeHandle(identity.handle)));
        } catch { /* policy or identity storage failure revokes the visual agent session */ }
        if (!authorized) {
          try {
            await driver.closeAgentCursor(identity);
            activeAgentCursors.delete(key);
          } catch { /* retry revocation on the next tick; Driver idle-hide is the fail-safe */ }
        }
      }
    };
    const result = pending.then(reconcile, reconcile);
    pending = result.catch(() => undefined).finally(() => { cursorReaperQueued = false; });
  }, 2000);
  cursorReaper.unref();

  async function close() {
    clearInterval(cursorReaper);
    await pending;
    activeAgentCursors.clear();
    await driver.shutdown();
  }

  return { prepare, act, launch, closeApp, close };
}
