import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isAgentContext } from "./approval-core";
import { normalizeHandle } from "./inbox-core";
import type { LocalStore } from "./local-store";
import { createWindowsDesktopStageManager, type WindowsStageDependencies } from "./windows-desktop-stage";
import { createCuaStageDriver, type CuaAgentCursorIdentity } from "./cua-stage-driver";
import { parseTaskStageAction, runTaskStageAction } from "./task-stage-actions";
import { launchApprovedStageApp, listApprovedStageApps, readApprovedStageApp } from "./task-stage-apps";
import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export const TASK_STAGE_POLICY_FILE = "task-stage-policy.json";

export function setTaskStagePermission(root: string, handle: string, enabled: boolean, context: { terminal: boolean; env: Record<string, string | undefined> }, control = false) {
  if (!context.terminal || isAgentContext(context.env)) throw new Error("Only the owner can change agent stage permissions.");
  handle = normalizeHandle(handle);
  if (!/^[a-z0-9_-]{1,40}$/.test(handle)) throw new Error("Invalid agent handle.");
  mkdirSync(root, { recursive: true });
  const file = join(root, TASK_STAGE_POLICY_FILE);
  const lock = `${file}.lock`;
  mkdirSync(lock);
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    const policy = readTaskStagePolicy(root);
    const handles = policy.handles.filter((value) => value !== handle);
    const controlHandles = (policy.controlHandles ?? []).filter((value) => value !== handle);
    if (enabled) { handles.push(handle); if (control || policy.controlHandles?.includes(handle)) controlHandles.push(handle); }
    if (handles.length > 16) throw new Error("At most 16 agents may use task stages.");
    writeFileSync(temporary, JSON.stringify({ version: 1, handles: handles.sort(), controlHandles: controlHandles.sort() }) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
    return { handles };
  } finally {
    rmSync(temporary, { force: true });
    rmSync(lock, { recursive: true, force: true });
  }
}

/** Owner-written policy. A task approval alone never grants computer access. */
export function readTaskStagePolicy(root: string): { handles: string[]; controlHandles?: string[] } {
  const file = join(root, TASK_STAGE_POLICY_FILE);
  if (!existsSync(file)) return { handles: [] };
  const raw = readFileSync(file, "utf8");
  if (Buffer.byteLength(raw) > 4096) throw new Error("Stage permission settings exceed their size limit.");
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid stage permission settings.");
  const policy = value as { version?: unknown; handles?: unknown; controlHandles?: unknown };
  if (policy.version !== 1 || !Array.isArray(policy.handles) || policy.handles.length > 16
    || policy.handles.some((handle) => typeof handle !== "string" || !/^[a-z0-9_-]{1,40}$/.test(handle))) {
    throw new Error("Invalid stage permission settings.");
  }
  const handles = [...new Set(policy.handles as string[])];
  if (policy.controlHandles !== undefined && (!Array.isArray(policy.controlHandles) || policy.controlHandles.length > 16
    || policy.controlHandles.some((handle) => typeof handle !== "string" || !handles.includes(handle)))) throw new Error("Invalid stage control permissions.");
  return { handles, ...(Array.isArray(policy.controlHandles) && policy.controlHandles.length ? { controlHandles: [...new Set(policy.controlHandles as string[])] } : {}) };
}

/** This service belongs to the owner-launched broker, never an agent's MCP child process. */
export function createTaskDesktopStageService(input: {
  store: LocalStore;
  stage?: WindowsStageDependencies;
  readPolicy?: () => { handles: string[]; controlHandles?: string[] };
}) {
  const root = input.store.root;
  const bundledHost = join(dirname(process.execPath), "m9r-native-input-host.exe");
  const stageDeps = { nativeHostPath: existsSync(bundledHost) ? bundledHost : undefined, ...input.stage, root, terminal: true };
  const manager = createWindowsDesktopStageManager(stageDeps);
  const driver = createCuaStageDriver({ stage: stageDeps });
  const readPolicy = input.readPolicy ?? (() => readTaskStagePolicy(root));
  // Serialize preparations so duplicate deliveries cannot create duplicate desktops.
  let pending: Promise<unknown> = Promise.resolve();
  const ownedApps = new Map<string, { taskId: string; appId: string; process: ChildProcess; windowId: string }>();
  const activeAgentCursors = new Map<string, CuaAgentCursorIdentity>();
  let cursorReaperQueued = false;

  function cursorIdentityKey(identity: CuaAgentCursorIdentity): string {
    return `${normalizeHandle(identity.handle)}\0${identity.sessionId}`;
  }

  function authorize(token: string, taskId: string) {
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
    const name = `agent-${createHash("sha256").update(`${identity.handle}\0${identity.sessionId}`).digest("hex").slice(0, 24)}`;
    return { identity, task, name };
  }

  async function prepare(token: string, taskId: string) {
    const run = async () => {
      const { name, identity } = authorize(token, taskId);
      const existing = manager.list().find((stage) => stage.name === name);
      if (existing) await manager.inspectStage(name);
      else await manager.create(name);
      const sessionTag = createHash("sha256").update(`${normalizeHandle(identity.handle)}\0${identity.sessionId}`).digest("hex").slice(0, 8);
      const assignedStage = manager.assignAgent(name, { handle: normalizeHandle(identity.handle), sessionTag });
      // Return opaque coordination IDs only, never desktop GUIDs or owner-window identifiers.
      return { name: assignedStage.name, agent: normalizeHandle(identity.handle), sessionTag, taskId, hasAnchor: assignedStage.anchor !== null,
        roomDesktopId: assignedStage.roomDesktopId, controlEnabled: readPolicy().controlHandles?.includes(normalizeHandle(identity.handle)) === true,
        approvedApps: listApprovedStageApps(root) };
    };
    const result = pending.then(run, run);
    pending = result.catch(() => undefined);
    return result;
  }

  async function act(token: string, taskId: string, value: unknown) {
    const action = parseTaskStageAction(value);
    const run = async () => {
      const { name, identity } = authorize(token, taskId);
      if (!readPolicy().controlHandles?.includes(normalizeHandle(identity.handle))) throw new Error("The owner has not enabled stage computer control for this agent.");
      await manager.inspectStage(name);
      // Recheck after inspection and at dequeue time: queued work cannot survive revocation.
      authorize(token, taskId);
      if (!readPolicy().controlHandles?.includes(normalizeHandle(identity.handle))) throw new Error("Stage computer control was revoked.");
      const result = await runTaskStageAction(driver, name, action, identity);
      authorize(token, taskId);
      if (!readPolicy().controlHandles?.includes(normalizeHandle(identity.handle))) throw new Error("Stage computer control was revoked.");
      return result;
    };
    const result = pending.then(run, run);
    pending = result.catch(() => undefined);
    return result;
  }

  async function launch(token: string, taskId: string, appId: string) {
    const run = async () => {
      const { name, identity } = authorize(token, taskId);
      if (!readPolicy().controlHandles?.includes(normalizeHandle(identity.handle))) throw new Error("The owner has not enabled stage computer control for this agent.");
      const approved = readApprovedStageApp(root, appId);
      const prior = ownedApps.get(name);
      if (prior && prior.process.exitCode === null && !prior.process.killed) {
        if (prior.taskId !== taskId || prior.appId !== appId) throw new Error("This session already has an unfinished stage app.");
        await manager.inspectStage(name);
        return { name, taskId, appId, running: true };
      }
      if (!manager.list().some((stage) => stage.name === name)) await manager.create(name);
      authorize(token, taskId);
      if (!readPolicy().controlHandles?.includes(normalizeHandle(identity.handle))) throw new Error("Stage computer control was revoked.");
      const child = launchApprovedStageApp(approved);
      let spawnError: Error | undefined;
      child.on("error", (error) => { spawnError = error; });
      try {
        for (let attempt = 0; attempt < 40; attempt++) {
          authorize(token, taskId);
          if (!readPolicy().controlHandles?.includes(normalizeHandle(identity.handle))) throw new Error("Stage computer control was revoked.");
          if (spawnError || child.exitCode !== null || child.killed || !child.pid) throw new Error("The approved app did not start a persistent owned process.");
          const windows = await manager.listOwnedWindows(name, child.pid);
          if (windows.length > 1) throw new Error("The approved app has multiple candidate windows; owner selection is required.");
          if (windows.length === 1) {
            authorize(token, taskId);
            if (!readPolicy().controlHandles?.includes(normalizeHandle(identity.handle))) throw new Error("Stage computer control was revoked.");
            await manager.moveOwnedWindow(name, child.pid, windows[0]!.windowId);
            await manager.attachWindow(name, String(child.pid), windows[0]!.windowId);
            try {
              authorize(token, taskId);
              if (!readPolicy().controlHandles?.includes(normalizeHandle(identity.handle))) throw new Error("Stage computer control was revoked.");
              await manager.showOwnedWindow(name);
              authorize(token, taskId);
              if (!readPolicy().controlHandles?.includes(normalizeHandle(identity.handle))) throw new Error("Stage computer control was revoked.");
            }
            catch (error) { manager.clearOwnedAnchor(name, child.pid, windows[0]!.windowId); throw error; }
            ownedApps.set(name, { taskId, appId, process: child, windowId: windows[0]!.windowId });
            return { name, taskId, appId, running: true };
          }
          await delay(100);
        }
        throw new Error("The app exposes no supported exact-process window; it requires an app-specific launch adapter.");
      } catch (error) { if (child.exitCode === null && !child.killed) child.kill(); throw error; }
    };
    const result = pending.then(run, run); pending = result.catch(() => undefined); return result;
  }

  async function closeApp(token: string, taskId: string) {
    const run = async () => {
      const { name } = authorize(token, taskId);
      const app = ownedApps.get(name);
      if (!app || app.taskId !== taskId) throw new Error("This task has no broker-owned app to discard.");
      if (!app.process.pid) throw new Error("The task app process identity is missing.");
      manager.clearOwnedAnchor(name, app.process.pid, app.windowId);
      if (app.process.exitCode === null && !app.process.killed) app.process.kill();
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
