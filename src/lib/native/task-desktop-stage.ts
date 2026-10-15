import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { renameStateFile } from "./atomic-file";
import { isAgentContext } from "./approval-core";
import { normalizeHandle } from "./inbox-core";
import type { LocalStore } from "./local-store";
import { createWindowsDesktopStageManager, type WindowsStageDependencies } from "./windows-desktop-stage";
import { createCuaStageDriver, type CuaAgentCursorIdentity } from "./cua-stage-driver";
import { parseTaskStageAction, runTaskStageAction, stageClickNeedsApproval } from "./task-stage-actions";
import type { StageApprovalRequest } from "./web-broker-core";
import {
  launchStageApp,
  ownedBrowserLaunch,
  resolveUnlistedStageApp,
  selectPersonalBrowserWindow,
  selectExistingPersonalBrowserWindow,
  stageAppLaunchCwd,
  stageBrowserKind,
  stageWindowMatchesApp,
  type StageAppLaunchSpec,
  type BrowserLaunchMode,
} from "./task-stage-apps";
import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { discoverInstalledWindowsApp } from "./windows-installed-apps";

export const TASK_STAGE_POLICY_FILE = "task-stage-policy.json";
export type TaskStageMode = "background" | "owner-preview";

/** Legacy policy values are parsed for migration but ignored for enabled agents. */
export type TaskStageAccessMode = "full" | "scoped" | "request";
const ACCESS_MODES: readonly TaskStageAccessMode[] = ["full", "scoped", "request"];

function stageMode(value: unknown): TaskStageMode {
  if (value === undefined || value === "owner-preview") return "owner-preview";
  if (value === "background") return "background";
  throw new Error("Invalid task stage mode.");
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

/** Enabled agents can resolve any installed app; the owner grant is per agent, never per app. */
export function stageAccessMode(policy: { handles: string[]; modes?: Record<string, TaskStageAccessMode> }, handle: string): TaskStageAccessMode {
  const normalized = normalizeHandle(handle);
  if (!policy.handles.includes(normalized)) return "scoped";
  return "full";
}

export interface StageLaunchTarget { app: StageAppLaunchSpec }

/** Resolve an installed executable after the one-time agent computer-control grant. */
export function resolveLaunchTarget(policy: { handles: string[]; modes?: Record<string, TaskStageAccessMode> }, handle: string, appId: string, opts: { env?: Record<string, string | undefined>; exists?: (path: string) => boolean } = {}): StageLaunchTarget {
  if (stageAccessMode(policy, handle) !== "full") throw new Error("This agent has not been granted task-stage access.");
  return { app: resolveUnlistedStageApp(appId, { allowAbsolutePath: true, ...(opts.env ? { env: opts.env } : {}), ...(opts.exists ? { exists: opts.exists } : {}) }) };
}

/** This service belongs to the owner-launched broker, never an agent's MCP child process. */
export function createTaskDesktopStageService(input: {
  store: LocalStore;
  stage?: WindowsStageDependencies;
  readPolicy?: () => { handles: string[]; controlHandles?: string[]; modes?: Record<string, TaskStageAccessMode> };
  /** Test seam: replaces the Cua driver (production always constructs the real one). */
  driver?: ReturnType<typeof createCuaStageDriver>;
  /** Test seam for harmless local fixtures with fixed launch arguments. */
  resolveStageAppForTest?: (appId: string) => StageAppLaunchSpec;
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

  function authorize(token: string, taskId: string, mode: TaskStageMode) {
    if (isAgentContext(stageDeps.env ?? process.env)) {
      throw new Error("Task stages require the owner-launched M9R broker; an agent process cannot host this service.");
    }
    const identity = input.store.verifyIdentity(token);
    if (!identity) {
      throw new Error("The owner-launched stage broker cannot verify this session identity in its configured M9R store. The agent MCP server and broker may have different M9R_HOME values, or the token was revoked. Run M9R setup to synchronize their M9R_HOME settings, then restart the broker and reconnect the agent.");
    }
    if (!readPolicy().handles.includes(normalizeHandle(identity.handle))) throw new Error("The owner has not enabled task stages for this agent.");
    const task = input.store.getTask(taskId);
    const handle = normalizeHandle(identity.handle);
    const addressedHandle = identity.sessionId.startsWith("web-") && !handle.startsWith("web-") ? `web-${handle}` : handle;
    if (!task || normalizeHandle(task.to) !== addressedHandle
      || ((task.targetSession ?? task.deliveredSession) && (task.targetSession ?? task.deliveredSession) !== identity.sessionId)
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

  async function prepare(token: string, taskId: string, requestedMode?: TaskStageMode) {
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
      } else {
        // Owner preview is desktop-wide, follows the desktop the user is
        // viewing now, and detaches only stale registry HWND metadata. It never
        // creates, activates, moves, or closes a desktop or user window.
        const selected = ownedApps.get(name);
        let retainSelection = false;
        if (selected?.taskId === taskId && existing?.anchor?.pid === selected.pid
          && existing.anchor.windowId === selected.windowId.toString()) {
          try {
            const inspected = await manager.inspectStage(name);
            retainSelection = inspected.desktop.isCurrent;
          } catch {
            // A closed or moved window must be rebound to the owner's desktop.
          }
        }
        if (!retainSelection) {
          await manager.adoptCurrentDesktop(name);
          ownedApps.delete(name);
        }
        assignedStage = manager.assignAgent(name, { handle: normalizeHandle(identity.handle), sessionTag });
      }
      // Return opaque coordination IDs only, never desktop GUIDs or owner-window identifiers.
      return { name, mode, agent: normalizeHandle(identity.handle), sessionTag, taskId, hasAnchor: Boolean(assignedStage?.anchor),
        ...(mode === "background" && assignedStage ? { roomDesktopId: assignedStage.roomDesktopId } : {}),
        controlEnabled: readPolicy().controlHandles?.includes(normalizeHandle(identity.handle)) === true };
    };
    const result = pending.then(run, run);
    pending = result.catch(() => undefined);
    return result;
  }

  async function act(token: string, taskId: string, value: unknown, requestedMode?: TaskStageMode, operationId?: string) {
    const mode = stageMode(requestedMode);
    const action = parseTaskStageAction(value);
    if (operationId !== undefined && !/^[a-zA-Z0-9._:-]{1,128}$/.test(operationId)) throw new Error("Invalid desktop-stage operation ID.");
    const run = async () => {
      const { name, identity } = authorize(token, taskId, mode);
      if (!readPolicy().controlHandles?.includes(normalizeHandle(identity.handle))) throw new Error("The owner has not enabled stage computer control for this agent.");
      let inspected = await manager.inspectStage(name);
      const selected = ownedApps.get(name);
      // The selected app is the default target after launch. Explicit desktop
      // actions detach only the view anchor; the selected app remains available.
      const effectiveAction: typeof action = action.kind === "read_structure"
        ? action
        : { ...action, view: action.view ?? (selected?.taskId === taskId ? "app" : "desktop") };
      if (mode === "owner-preview" && effectiveAction.view === "desktop" && inspected.anchor) {
        await manager.adoptCurrentDesktop(name);
        inspected = await manager.inspectStage(name);
      } else if (mode === "owner-preview" && effectiveAction.view === "app" && !inspected.anchor && selected?.taskId === taskId) {
        await manager.attachWindow(name, String(selected.pid), selected.windowId);
        inspected = await manager.inspectStage(name);
      }
      if (effectiveAction.view === "app" && (selected?.taskId !== taskId || !inspected.anchor)) {
        throw new Error("This task has no selected application window. Open the requested app before using the app view.");
      }
      if (mode === "owner-preview" && !inspected.desktop.isCurrent) throw new Error("The owner-visible preview stage is not on the owner's current desktop.");
      // Recheck after inspection and at dequeue time: queued work cannot survive revocation.
      authorize(token, taskId, mode);
      if (!readPolicy().controlHandles?.includes(normalizeHandle(identity.handle))) throw new Error("Stage computer control was revoked.");
      if (action.kind === "click" || action.kind === "double_click" || action.kind === "right_click") {
        await moneyGate(name, identity, action.x, action.y, effectiveAction.view === "app" ? "background" : mode);
      }
      // The approval wait above can outlast a revocation: recheck before anything executes.
      authorize(token, taskId, mode);
      if (!readPolicy().controlHandles?.includes(normalizeHandle(identity.handle))) throw new Error("Stage computer control was revoked.");
      const mutating = action.kind !== "capture" && action.kind !== "read_structure";
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
      try {
        result = await runTaskStageAction(driver, name, effectiveAction, identity, mode);
      } catch (error) {
        if (receiptInput) {
          try { input.store.settleStageOperation({ ...receiptInput, state: "uncertain" }); } catch { /* the durable running claim still blocks a replay */ }
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(`The desktop input outcome is uncertain; the operation will not be replayed automatically. Capture the stage before issuing a new action. ${detail}`, { cause: error });
        }
        throw error;
      }
      if (!receiptInput) return result;
      try {
        const settled = input.store.settleStageOperation({ ...receiptInput, state: "applied" });
        return settled
          ? { ...(result && typeof result === "object" ? result : { result }), operationReceipt: { operationId, status: "applied", driverReturned: true }, actionExecuted: true }
          : { ...(result && typeof result === "object" ? result : { result }), operationReceipt: { operationId, status: "uncertain", driverReturned: true }, actionExecuted: true,
            nextStep: "The input was sent, but its receipt could not be finalized; capture and inspect before issuing another action." };
      } catch (error) {
        return { ...(result && typeof result === "object" ? result : { result }), operationReceipt: { operationId, status: "uncertain", driverReturned: true }, actionExecuted: true,
          receiptError: error instanceof Error ? error.message.slice(0, 180) : "The durable operation receipt could not be finalized.",
          nextStep: "The input was sent; capture and inspect before issuing another action." };
      }
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
  async function moneyGate(name: string, identity: { handle: string; sessionId: string; provider: string }, x: number, y: number, mode: TaskStageMode): Promise<void> {
    const described = mode === "owner-preview"
        ? await driver.describeDesktopTarget(name, x, y, identity)
        : await driver.describeTarget(name, x, y, identity);
    // A failed driver inspection is not an unknown but successfully inspected
    // control. Preserve the failure immediately rather than hiding it behind a
    // 55-second approval wait that the owner cannot use to repair the driver.
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

  async function launch(token: string, taskId: string, appId: string, requestedMode?: TaskStageMode) {
    const mode = stageMode(requestedMode);
    const run = async () => {
      const { name, identity, task } = authorize(token, taskId, mode);
      if (!readPolicy().controlHandles?.includes(normalizeHandle(identity.handle))) throw new Error("The owner has not enabled stage computer control for this agent.");
      let target: StageLaunchTarget;
      if (input.resolveStageAppForTest) {
        target = { app: input.resolveStageAppForTest(appId) };
      } else {
        try { target = resolveLaunchTarget(readPolicy(), identity.handle, appId); }
        catch (error) {
          if (stageAccessMode(readPolicy(), identity.handle) !== "full") throw error;
          const installed = await discoverInstalledWindowsApp(appId);
          if (!installed) throw error;
          target = { app: installed };
        }
      }
      const approved = target.app;
      if (mode === "owner-preview") {
        await manager.adoptCurrentDesktop(name);
        const before = await driver.listVisibleWindows({ onScreenOnly: false });
        const kind = stageBrowserKind(approved.executable);
        const existing = kind ? selectExistingPersonalBrowserWindow(kind, before) : undefined;
        if (existing) {
          authorize(token, taskId, mode);
          if (!readPolicy().controlHandles?.includes(normalizeHandle(identity.handle))) throw new Error("Desktop computer control was revoked.");
          await manager.presentOwnerWindow(name, existing.pid, existing.windowId);
          await manager.attachWindow(name, String(existing.pid), existing.windowId);
          ownedApps.set(name, { taskId, appId, pid: existing.pid, windowId: existing.windowId, ownsProcess: false });
          return { name, taskId, appId, running: true, reused: true, view: "app", capture: await driver.capture(name, identity) };
        }
        // Normal profile, normal executable, fixed owner-resolved arguments.
        // Never manufacture --new-window, --user-data-dir or about:blank here.
        const beforeKeys = new Set(before.map((window) => `${window.pid}:${window.windowId}`));
        const child = launchStageApp(kind ? { ...approved, args: [] } : approved, { windowsHide: false, cwd: stageAppLaunchCwd(task.cwd) });
        let launchError: Error | undefined;
        child.on("error", (error) => { launchError = error; });
        for (let attempt = 0; attempt < 60; attempt++) {
          authorize(token, taskId, mode);
          if (!readPolicy().controlHandles?.includes(normalizeHandle(identity.handle))) throw new Error("Desktop computer control was revoked.");
          if (launchError) throw launchError;
          const windows = await driver.listVisibleWindows({ onScreenOnly: false });
          // Windows packaged apps may delegate to another PID. Select the new
          // exact window of the resolved executable, never the launcher stub.
          const matches = windows.filter((window) => !beforeKeys.has(`${window.pid}:${window.windowId}`)
            && stageWindowMatchesApp(window, approved));
          if (matches.length > 1) throw new Error("The requested application opened multiple windows; select the intended window before continuing.");
          if (matches.length === 1) {
            await manager.presentOwnerWindow(name, matches[0]!.pid, matches[0]!.windowId);
            await manager.attachWindow(name, String(matches[0]!.pid), matches[0]!.windowId);
            ownedApps.set(name, { taskId, appId, pid: matches[0]!.pid, windowId: matches[0]!.windowId, ownsProcess: false });
            return { name, taskId, appId, running: true, reused: false, view: "app", capture: await driver.capture(name, identity) };
          }
          await delay(100);
        }
        throw new Error("The requested application did not expose a new exact window. Its launcher response is not proof it opened.");
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
      if (!manager.list().some((stage) => stage.name === name)) await manager.create(name);
      authorize(token, taskId, mode);
      if (!readPolicy().controlHandles?.includes(normalizeHandle(identity.handle))) throw new Error("Stage computer control was revoked.");
      const browserKind = stageBrowserKind(approved.executable);
      const personalBrowser = browserKind !== undefined && browserLaunchMode === "personal";
      const beforeBrowserWindows = personalBrowser
        ? new Set((await driver.listVisibleWindows({ onScreenOnly: false })).map((window) => `${window.pid}:${window.windowId}`))
        : undefined;
      const child = launchStageApp(ownedBrowserLaunch(root, name, approved, { mode: browserLaunchMode }), { windowsHide: true, cwd: stageAppLaunchCwd(task.cwd) });
      let spawnError: Error | undefined;
      child?.on("error", (error) => { spawnError = error; });
      try {
        for (let attempt = 0; attempt < 40; attempt++) {
          authorize(token, taskId, mode);
          if (!readPolicy().controlHandles?.includes(normalizeHandle(identity.handle))) throw new Error("Stage computer control was revoked.");
          // Personal Chromium commonly exits its launcher PID immediately after
          // handing the request to the already-running browser process. The
          // Cua window list, not that transient PID, is the ownership proof.
          const processPid = child?.pid;
          if (!child || spawnError || child.killed || !processPid || (!personalBrowser && child.exitCode !== null)) {
            throw new Error("The approved app did not start a persistent owned process.");
          }
          let selectedPid = child.pid;
          let selectedWindowId: string | undefined;
          let candidateWindows: Array<{ pid: number; windowId: string; title?: string; width?: number; height?: number }>;
          if (personalBrowser) {
            const candidate = selectPersonalBrowserWindow(browserKind!, await driver.listVisibleWindows({ onScreenOnly: false }), beforeBrowserWindows!);
            if (!candidate) {
              await delay(100);
              continue;
            }
            selectedPid = candidate.pid;
            selectedWindowId = candidate.windowId;
            candidateWindows = [candidate];
          } else {
            if (!processPid) throw new Error("The approved app did not expose a process id.");
            candidateWindows = await manager.listOwnedWindows(name, processPid);
          }
          if (candidateWindows.length > 1) throw new Error("The approved app has multiple candidate windows; owner selection is required.");
          if (candidateWindows.length === 1) {
            authorize(token, taskId, mode);
            if (!readPolicy().controlHandles?.includes(normalizeHandle(identity.handle))) throw new Error("Stage computer control was revoked.");
            selectedWindowId = candidateWindows[0]!.windowId;
            if (selectedPid === undefined) throw new Error("The approved app did not expose a process id.");
            const ownedPid = selectedPid;
            await manager.moveOwnedWindow(name, ownedPid, selectedWindowId);
            await manager.attachWindow(name, String(ownedPid), selectedWindowId);
            try {
              authorize(token, taskId, mode);
              if (!readPolicy().controlHandles?.includes(normalizeHandle(identity.handle))) throw new Error("Stage computer control was revoked.");
              await manager.showOwnedWindow(name);
              authorize(token, taskId, mode);
              if (!readPolicy().controlHandles?.includes(normalizeHandle(identity.handle))) throw new Error("Stage computer control was revoked.");
            }
            catch (error) { manager.clearOwnedAnchor(name, ownedPid, selectedWindowId); throw error; }
            ownedApps.set(name, {
              taskId,
              appId,
              pid: ownedPid,
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
        if (child && child.exitCode === null && !child.killed) child.kill();
        throw error;
      }
    };
    const result = pending.then(run, run); pending = result.catch(() => undefined); return result;
  }

  async function closeApp(token: string, taskId: string, requestedMode?: TaskStageMode) {
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
