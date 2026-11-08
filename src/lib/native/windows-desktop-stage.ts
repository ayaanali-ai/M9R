import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { renameStateFile } from "./atomic-file";
import { isAgentContext } from "./approval-core";
import { DesktopInputNotDispatchedError, DesktopInputOutcomeUnknownError } from "./desktop-input-errors";
import { defaultStoreRoot } from "./local-store";
import { AsyncLocalStorage } from "node:async_hooks";
import type { MultiplayerDispatchFence } from "./multiplayer-dispatch-fence";

const STAGE_REGISTRY_VERSION = 6;
const MAX_STAGE_REGISTRY_BYTES = 1024 * 1024;
// A just-created empty stage is assigned immediately by task preparation. Keep
// recent empty mappings through that handoff, then reclaim old cursor-only
// entries because they contain no HWND or durable app state.
const EMPTY_OWNER_PREVIEW_STAGE_TTL_MS = 60_000;
const MAX_NATIVE_RESPONSE_BYTES = 8 * 1024 * 1024;
const OWNER_PREVIEW_STAGE_PREFIX = "preview-agent-";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WINDOW_ID_RE = /^(?:0[xX][0-9a-f]+|[0-9]+)$/;
const MACHINE_ID_FILE = "windows-stage-machine-id";
const COORDINATION_KEY_RE = /^[a-f0-9]{64}$/;

export interface WindowsStageRecord {
  name: string;
  /** Stable logical app reference used to recover the selected window after a broker restart. */
  appId?: string;
  /** Stable, local-only intent group. Stages in one group may share a window. */
  coordinationKey?: string;
  /** Explicitly shared identity mapping; mutating service callers must supply the broker fence. */
  sharedBinding?: true;
  /** This anchor was established by the broker that fences every target mutation. */
  fencedBinding?: true;
  /** Random local identity for the owner's visible-screen coordination surface. */
  roomDesktopId: string;
  /** Exact visible-window binding; null for a desktop-wide owner view. */
  anchor: { pid: number; windowId: string; processGeneration?: string } | null;
  /** Random identity rotated whenever the registered anchor window changes. */
  roomWindowId: string | null;
  /** Local-only owner mapping; never included in room coordination events.
   * `taskId` is the task that most recently used this session's stage -- stages are
   * one per authenticated session (see cursorStageName() in task-desktop-stage.ts), so
   * this is overwritten on every prepare() call and never scopes identity, only staleness. */
  agentAssignment?: { handle: string; sessionTag: string; taskId?: string };
  registeredAt: string;
}

interface StageRegistry {
  version: 6;
  stages: WindowsStageRecord[];
}

interface NativeWindowStageInfo {
  pid: number;
  windowId: string;
  processGeneration?: string;
}

export interface NativeDispatchEvidence {
  readonly helperPid: number;
  readonly startedUnixNanos: string;
  readonly endedUnixNanos: string;
  readonly streamId?: string;
}

interface NativeStageResponse {
  ok: boolean;
  dispatchState?: "not-dispatched" | "uncertain";
  type?: string;
  error?: string;
  window?: NativeWindowStageInfo;
  desktopStructure?: NativeDesktopStructure;
  windowStructure?: NativeWindowStructure;
  semanticAction?: { dispatched: boolean; mechanism?: string; reason?: string; valueConfirmed?: boolean;
    read?: boolean; value?: string; truncated?: boolean; redacted?: boolean;
    scrollBefore?: NativeScrollPosition; scrollAfter?: NativeScrollPosition; moved?: boolean | null;
    nativeDispatch?: NativeDispatchEvidence };
  capture?: { dataUrl: string; width: number; height: number; originX?: number; originY?: number };
  input?: { childWindowId: string };
  pointWindow?: { pid: number; windowId: string; shell?: boolean; keyboardWindow?: boolean; screenOrigin?: { x: number; y: number } };
  control?: NativePointControl;
  windows?: { pid: number; windowId: string; title: string; width: number; height: number; x?: number; y?: number; zOrder?: number; className?: string; processName?: string | null; processPath?: string | null; appUserModelId?: string | null }[];
  position?: { x: number; y: number };
  windowState?: "closed" | "minimized" | "occluded" | "hidden" | "visible";
  foregroundWindow?: { pid: number; windowId: string; title?: string; className?: string; visible?: boolean; minimized?: boolean };
  result?: unknown;
  state?: "minimized" | "maximized" | "restored";
  processGeneration?: string;
  rect?: { x?: number; y?: number; width?: number; height?: number };
  text?: string;
  childWindowId?: string;
  classes?: string[];
}

function throwNativeInputFailure(result: NativeStageResponse, fallback: string): never {
  const detail = result.error ?? fallback;
  if (result.dispatchState === "not-dispatched") {
    throw new DesktopInputNotDispatchedError(`${detail} No target input was sent.`, "native-dispatch-unavailable");
  }
  // Missing dispatchState is treated conservatively. This can happen when an
  // older helper is still running or a malformed response is received; neither
  // case proves that SendInput accepted zero events.
  throw new DesktopInputOutcomeUnknownError(
    `${detail} The native helper did not prove that this input sequence sent zero events; inspect the target before retrying.`,
  );
}

export interface NativePointControl {
  label: string;
  pid: number;
  windowId: string;
  windowPid: number;
  rect: { x: number; y: number; width: number; height: number };
  invoked: boolean;
  confirmed?: boolean;
}

export interface WindowsSystemControlRequest {
  control: "display_brightness" | "output_audio" | "media" | "microphone";
  action: "get" | "set" | "increase" | "decrease" | "mute" | "unmute" | "play_pause" | "next" | "previous";
  value?: number;
  step?: number;
}

/** Public, handle-free result from the native Windows UI Automation desktop snapshot. */
export interface NativeDesktopStructureElement {
  ref: string;
  label: string;
  role: string;
  className: string;
  rect: { x: number; y: number; width: number; height: number };
  depth: number;
  enabled: boolean;
  focused: boolean;
}

export interface NativeDesktopStructure {
  scope: "desktop";
  status: "complete" | "partial";
  screen: { x: number; y: number; width: number; height: number };
  elements: NativeDesktopStructureElement[];
  truncated: boolean;
}

export interface NativeWindowStructureElement extends NativeDesktopStructureElement {
  ref: string;
  /** Control View child-index path used for immediate native re-resolution. */
  path: number[];
  automationId: string;
  /** Live UIA identity, independent of generated snapshot refs and tree position. */
  runtimeId?: number[] | null;
  actions?: { invoke: boolean; select: boolean; toggle: boolean; legacy: boolean; setValue: boolean; readValue?: boolean; scroll?: boolean };
  /** UIA ScrollPattern progress when this element is a scroll container. Percent can be null when the provider omits it. */
  scroll?: {
    horizontal: { scrollable: boolean; percent: number | null; viewSize: number | null };
    vertical: { scrollable: boolean; percent: number | null; viewSize: number | null };
  } | null;
}

interface NativeScrollPosition { horizontal: number | null; vertical: number | null }

export interface NativeWindowStructure {
  scope: "window";
  windowId: string;
  status: "complete" | "partial";
  elements: NativeWindowStructureElement[];
  truncated: boolean;
}

export interface WindowsStageDependencies {
  platform?: NodeJS.Platform;
  root?: string;
  nativeHostPath?: string;
  terminal?: boolean;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  invokeNative?: (request: Record<string, unknown>) => Promise<NativeStageResponse>;
  /** The owner broker supplies the real shared mutation fence before allowing shared HWND mappings. */
  sharedWindowFence?: Pick<MultiplayerDispatchFence, "begin">;
  /** Test-only transport seam; production creates one persistent native process per stream. */
  nativeHostFactory?: (streamId?: string) => { invoke(request: Record<string, unknown>): Promise<NativeStageResponse>; close(): void };
  /** Internal API-call evidence. This callback never changes an action's outcome. */
  onNativeDispatch?: (evidence: NativeDispatchEvidence) => void;
  /** Whether a process id still exists; injectable for tests. */
  processAlive?: (pid: number) => boolean;
  /** Whether the task that most recently used a stage is still unfinished. Used only to
   * decide whether another session may take over an already-claimed window: a window
   * process like explorer.exe or chrome.exe outlives any one task, so processAlive() alone
   * never frees a finished task's claim on it. Defaults to always-active (preserves prior
   * behavior) when the caller has no task store to check against, e.g. in tests. */
  taskActive?: (taskId: string) => boolean;
}

function defaultProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/**
 * Owner-preview stages are local identity maps onto the owner's visible
 * Windows surface; removing a record never closes or moves a window. Compact
 * dead anchors and dormant empty cursor mappings without disturbing a live
 * app binding or an in-flight task preparation.
 */
function withoutStaleOwnerPreviewStages(
  stages: WindowsStageRecord[],
  alive: (pid: number) => boolean,
  taskActive: (taskId: string) => boolean,
  nowMs: number,
): WindowsStageRecord[] {
  return stages.filter((stage) => {
    if (!stage.name.startsWith(OWNER_PREVIEW_STAGE_PREFIX)) return true;
    const taskId = stage.agentAssignment?.taskId;
    // A task may intentionally close its current app before selecting or
    // launching the next one. Preserve that active stage identity even when
    // the old HWND's process has exited; launch recovery clears only the dead
    // anchor while retaining the in-flight assignment and coordination IDs.
    if (taskId && taskActive(taskId)) return true;
    if (stage.anchor) return alive(stage.anchor.pid);
    if (taskId) return false;
    // Cursor priming can create a stage before there is an app/window to bind.
    // Preserve the short prepare→assign handoff, but don't retain empty session
    // records indefinitely after the task has moved on or the provider closed.
    const registeredAt = Date.parse(stage.registeredAt);
    return Number.isFinite(registeredAt) && nowMs - registeredAt < EMPTY_OWNER_PREVIEW_STAGE_TTL_MS;
  });
}

function normalizedName(value: string): string {
  const name = value.trim().toLowerCase().replace(/\s+/g, "-");
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(name)) {
    throw new Error("Stage names must be 1–40 lowercase letters, numbers, hyphens, or underscores, and start with a letter or number.");
  }
  return name;
}

function isPersistedAppId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

function isCoordinationKey(value: unknown): value is string {
  return typeof value === "string" && COORDINATION_KEY_RE.test(value);
}

function parseRegistry(raw: string): StageRegistry {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("The local Windows stage registry is corrupt; it was left unchanged."); }
  const version = parsed && typeof parsed === "object" ? (parsed as { version?: unknown }).version : undefined;
  if (!parsed || typeof parsed !== "object" || typeof version !== "number"
    || ![1, 2, 3, 4, 5, STAGE_REGISTRY_VERSION].includes(version) || !Array.isArray((parsed as { stages?: unknown }).stages)) {
    throw new Error("The local Windows stage registry has an unsupported format; it was left unchanged.");
  }
  const stages = (parsed as { stages: unknown[] }).stages;
  const names = new Set<string>();
  const records = stages.map((item): WindowsStageRecord => {
    if (!item || typeof item !== "object") throw new Error("The local Windows stage registry contains an invalid record; it was left unchanged.");
    const record = item as Partial<WindowsStageRecord>;
    const name = normalizedName(typeof record.name === "string" ? record.name : "");
    if (names.has(name)) throw new Error("The local Windows stage registry contains duplicate names; it was left unchanged.");
    names.add(name);
    if (record.appId !== undefined && (!isPersistedAppId(record.appId))) throw new Error("The local Windows stage registry contains an invalid app reference; it was left unchanged.");
    if (record.coordinationKey !== undefined && !isCoordinationKey(record.coordinationKey)) throw new Error("The local Windows stage registry contains an invalid coordination key; it was left unchanged.");
    if (record.sharedBinding !== undefined && record.sharedBinding !== true) throw new Error("The local Windows stage registry contains an invalid shared binding.");
    if (record.fencedBinding !== undefined && record.fencedBinding !== true) throw new Error("The local Windows stage registry contains an invalid fenced binding.");
    if (record.sharedBinding && !record.fencedBinding) throw new Error("The local Windows stage registry has a shared target without mutation fencing.");
    let anchor: WindowsStageRecord["anchor"] = null;
    if (record.anchor !== undefined && record.anchor !== null) {
      if (!Number.isInteger(record.anchor.pid) || (record.anchor.pid ?? 0) < 1 || typeof record.anchor.windowId !== "string" || !WINDOW_ID_RE.test(record.anchor.windowId)) {
        throw new Error("The local Windows stage registry contains an invalid anchor window; it was left unchanged.");
      }
      if (record.anchor.processGeneration !== undefined && !/^[a-f0-9]{16}$/i.test(record.anchor.processGeneration)) throw new Error("The local Windows stage registry contains an invalid process generation.");
      anchor = { pid: record.anchor.pid!, windowId: record.anchor.windowId,
        ...(record.anchor.processGeneration ? { processGeneration: record.anchor.processGeneration } : {}) };
    } else if (version === 1) {
      throw new Error("The local Windows stage registry contains an invalid anchor window; it was left unchanged.");
    }
    if (typeof record.registeredAt !== "string" || !Number.isFinite(Date.parse(record.registeredAt))) throw new Error("The local Windows stage registry contains an invalid registration time; it was left unchanged.");
    const roomDesktopId = record.roomDesktopId ?? (version < STAGE_REGISTRY_VERSION ? randomUUID() : null);
    const roomWindowId = record.roomWindowId ?? (version < STAGE_REGISTRY_VERSION && anchor ? randomUUID() : null);
    if (typeof roomDesktopId !== "string" || !UUID_RE.test(roomDesktopId)
      || (roomWindowId !== null && (typeof roomWindowId !== "string" || !UUID_RE.test(roomWindowId)))
      || (anchor === null && roomWindowId !== null) || (anchor !== null && roomWindowId === null)) {
      throw new Error("The local Windows stage registry contains an invalid room coordination identity; it was left unchanged.");
    }
    let agentAssignment: WindowsStageRecord["agentAssignment"];
    if (record.agentAssignment !== undefined) {
      const value = record.agentAssignment as { handle?: unknown; sessionTag?: unknown; taskId?: unknown } | null;
      if (value !== null && (!value || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).some((key) => key !== "handle" && key !== "sessionTag" && key !== "taskId")
        || typeof value.handle !== "string" || !/^[a-z0-9_-]{1,40}$/.test(value.handle)
        || typeof value.sessionTag !== "string" || !/^[a-f0-9]{8}$/.test(value.sessionTag)
        || (value.taskId !== undefined && (typeof value.taskId !== "string" || value.taskId.length < 1 || value.taskId.length > 100)))) {
        throw new Error("The local Windows stage registry contains an invalid agent assignment; it was left unchanged.");
      }
      if (value) {
        agentAssignment = { handle: value.handle as string, sessionTag: value.sessionTag as string };
        if (value.taskId !== undefined) agentAssignment.taskId = value.taskId as string;
      }
    }
    return {
      name,
      ...(record.appId !== undefined ? { appId: record.appId } : {}),
      ...(record.coordinationKey !== undefined ? { coordinationKey: record.coordinationKey } : {}),
      ...(record.sharedBinding ? { sharedBinding: true as const } : {}),
      ...(record.fencedBinding ? { fencedBinding: true as const } : {}),
      roomDesktopId: roomDesktopId.toLowerCase(),
      anchor,
      roomWindowId: roomWindowId?.toLowerCase() ?? null,
      ...(agentAssignment ? { agentAssignment } : {}),
      registeredAt: record.registeredAt,
    };
  });
  return { version: STAGE_REGISTRY_VERSION, stages: records };
}

function registryPath(root: string): string {
  return join(root, "windows-stages.json");
}

/** Stable random namespace for room-visible stage keys; contains no hardware identity. */
function readOrCreateStageMachineId(root: string): string {
  const path = join(root, MACHINE_ID_FILE);
  const read = () => {
    const value = readFileSync(path, "utf8").trim();
    if (!UUID_RE.test(value)) throw new Error("The local stage machine id is invalid; it was left unchanged.");
    return value.toLowerCase();
  };
  if (existsSync(path)) return read();
  mkdirSync(root, { recursive: true });
  const value = randomUUID();
  try {
    writeFileSync(path, `${value}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return read();
    throw error;
  }
}

function readRegistry(root: string): StageRegistry {
  const path = registryPath(root);
  if (!existsSync(path)) return { version: STAGE_REGISTRY_VERSION, stages: [] };
  const raw = readFileSync(path, "utf8");
  if (Buffer.byteLength(raw, "utf8") > MAX_STAGE_REGISTRY_BYTES) throw new Error("The local Windows stage registry is too large; it was left unchanged.");
  return parseRegistry(raw);
}

export function formatWindowsStageRoomKeys(machineId: string, stage: Pick<WindowsStageRecord, "roomDesktopId" | "roomWindowId">): { desktop: string; window?: string } {
  if (!UUID_RE.test(machineId) || !UUID_RE.test(stage.roomDesktopId)
    || (stage.roomWindowId !== null && !UUID_RE.test(stage.roomWindowId))) {
    throw new Error("The local Windows stage room identifiers are invalid.");
  }
  return {
    desktop: `desktop:${machineId.toLowerCase()}:${stage.roomDesktopId.toLowerCase()}`,
    ...(stage.roomWindowId ? { window: `window:${machineId.toLowerCase()}:${stage.roomWindowId.toLowerCase()}` } : {}),
  };
}

// No legitimate registry update holds this lock for anywhere close to this
// long -- it exists only to make the handful of synchronous filesystem calls
// in writeRegistryWhileLocked atomic as a group. A lock older than this was
// left behind by a process that no longer exists (the broker has been killed
// and restarted many times across one session), not one still working.
const STALE_LOCK_MS = 30_000;

export function acquireRegistryLock(root: string): () => void {
  mkdirSync(root, { recursive: true });
  const target = registryPath(root);
  const lock = `${target}.lock`;
  const token = randomUUID();
  const ownerPath = join(lock, "owner.json");
  const readOwner = (): { pid?: number; token?: string } => {
    try { return JSON.parse(readFileSync(ownerPath, "utf8")); } catch { return {}; }
  };
  try {
    mkdirSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // A lock with no PID, no age limit, and no staleness check meant that any
    // process killed or crashed while holding it (a forced restart, in
    // particular) permanently broke every future registry operation until
    // someone deleted the lock directory by hand. Self-heal instead: a lock
    // old enough to be certain nothing legitimate still holds it is removed
    // and re-acquired, exactly once, before giving up for real.
    let ageMs: number;
    try { ageMs = Date.now() - statSync(lock).mtimeMs; } catch { ageMs = Infinity; }
    if (ageMs < STALE_LOCK_MS) throw new Error("Another Windows stage registry update is already running; retry after it finishes.");
    const owner = readOwner();
    if (Number.isSafeInteger(owner.pid) && owner.pid! > 0) {
      try { process.kill(owner.pid!, 0); throw new Error("Another Windows stage registry update is already running; its owner is alive."); }
      catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== "ESRCH") throw failure;
      }
    }
    try { rmSync(lock, { recursive: true, force: true }); } catch { /* another process may have just cleared it too; proceed to retry regardless */ }
    try {
      mkdirSync(lock);
    } catch (retryError) {
      if ((retryError as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Another Windows stage registry update is already running; retry after it finishes.");
      throw retryError;
    }
  }
  try { writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, token }), { flag: "wx", mode: 0o600 }); }
  catch (error) { rmSync(lock, { recursive: true, force: true }); throw error; }
  return () => {
    if (readOwner().token === token) rmSync(lock, { recursive: true, force: true });
  };
}

function writeRegistryWhileLocked(root: string, registry: StageRegistry): void {
  const target = registryPath(root);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    const serialized = `${JSON.stringify(registry, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_STAGE_REGISTRY_BYTES) {
      throw new Error("The local Windows stage registry would exceed its 1 MiB storage budget; no stage update was saved.");
    }
    writeFileSync(temporary, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameStateFile(temporary, target);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* preserve the original write error */ }
    throw error;
  }
}

/** Normalize a live HWND identity. Legacy OS desktop fields are ignored:
 * stages bind to the owner's visible Windows surface and never switch virtual
 * desktops. */
function normalizeWindowInfo(value: unknown): NativeWindowStageInfo {
  if (!value || typeof value !== "object") throw new Error("The native Windows stage helper returned no window result.");
  const item = value as Partial<NativeWindowStageInfo>;
  if (!Number.isInteger(item.pid) || (item.pid ?? 0) < 1 || typeof item.windowId !== "string" || !WINDOW_ID_RE.test(item.windowId)
      || !/[^0]/.test(item.windowId.replace(/^0[xX]/, ""))) {
    throw new Error("The native Windows stage helper returned an invalid window result.");
  }
  if (item.processGeneration !== undefined && !/^[a-f0-9]{16}$/i.test(item.processGeneration)) throw new Error("The native helper returned an invalid process generation.");
  return {
    pid: item.pid!, windowId: item.windowId,
    ...(item.processGeneration ? { processGeneration: item.processGeneration } : {}),
  };
}

export function createWindowsDesktopStageManager(deps: WindowsStageDependencies = {}) {
  const platform = deps.platform ?? process.platform;
  const root = deps.root ?? defaultStoreRoot(homedir(), deps.env ?? process.env);
  const now = deps.now ?? (() => new Date());
  const processAlive = deps.processAlive ?? defaultProcessAlive;
  const taskActive = deps.taskActive ?? (() => true);
  /** Compact dead anchors and expired empty cursor-stage records before adding one. */
  function compactRegistryStages(registry: { stages: WindowsStageRecord[] }): WindowsStageRecord[] {
    return withoutStaleOwnerPreviewStages(registry.stages, processAlive, taskActive, now().getTime());
  }
  const streamContext = new AsyncLocalStorage<string>();
  const foregroundAuthority = new AsyncLocalStorage<(request: Record<string, unknown>) => Promise<void>>();
  const foregroundOperations = new Set(["bringToForeground", "setWindowState", "setWindowFrame", "sendClick", "sendDrag", "sendScroll", "sendKeyCombo", "sendText", "restoreCursorPosition"]);
  const hostFactory = deps.nativeHostFactory ?? (() => createPersistentWindowsStageHost(
    deps.nativeHostPath ?? join(root, "bin", "m9r-native-input-host.exe")));
  const persistentHost = deps.invokeNative ? undefined : hostFactory();
  const streamHosts = new Map<string, ReturnType<typeof hostFactory>>();
  let managerClosed = false;
  const invokeNative = async (request: Record<string, unknown>): Promise<NativeStageResponse> => {
    if (managerClosed) return Promise.reject(new Error("The native desktop-stage manager is closed."));
    if (foregroundOperations.has(String(request.op))) {
      const authorize = foregroundAuthority.getStore();
      if (!authorize) throw new DesktopInputNotDispatchedError("Foreground dispatch requires an owner-authorized task turn; no input was sent.", "foreground-approval");
      await authorize(request);
    }
    if (deps.invokeNative) return deps.invokeNative(request);
    const streamId = streamContext.getStore();
    if (!streamId) return persistentHost!.invoke(request);
    let host = streamHosts.get(streamId);
    if (!host) { host = hostFactory(streamId); streamHosts.set(streamId, host); }
    return host.invoke(request);
  };
  function withInputStream<T>(streamId: string, operation: () => Promise<T>): Promise<T> {
    if (!/^stream-[a-f0-9]{24}$/.test(streamId)) throw new Error("Invalid native input-stream identity.");
    if (managerClosed) throw new Error("The native desktop-stage manager is closed.");
    return streamContext.run(streamId, operation);
  }
  function withForegroundAuthorization<T>(authorize: (request: Record<string, unknown>) => Promise<void>, operation: () => Promise<T>): Promise<T> {
    return foregroundAuthority.run(authorize, operation);
  }
  function closeInputStream(streamId: string): void {
    streamHosts.get(streamId)?.close();
    streamHosts.delete(streamId);
  }
  function closeManager(): void {
    if (managerClosed) return;
    managerClosed = true;
    persistentHost?.close();
    for (const host of streamHosts.values()) host.close();
    streamHosts.clear();
    process.removeListener("exit", closeManager);
  }
  if (!deps.invokeNative) process.once("exit", closeManager);
  function verifiedWindowInfo(value: unknown) {
    const window = normalizeWindowInfo(value);
    if (!deps.invokeNative && !window.processGeneration) throw new Error("The native runtime cannot verify process generations; stage input requires the current verified candidate.");
    return window;
  }

  function assertWindows(): void {
    if (platform !== "win32") throw new Error("The Windows desktop stage is available only on Windows.");
  }

  function assertOwner(): void {
    if (!deps.terminal && !(process.stdin.isTTY && process.stdout.isTTY)) throw new Error("Windows stage changes require the owner at an interactive terminal.");
    if (isAgentContext(deps.env ?? process.env)) throw new Error("Agents cannot change owner desktop-stage bindings; ask the owner to manage the local stage in a terminal.");
  }

  async function inspectWindow(pidInput: string, windowId: string): Promise<NativeWindowStageInfo> {
    assertWindows();
    assertOwner();
    const pid = parsePid(pidInput);
    const handle = parseWindowId(windowId);
    const result = await invokeNative({ op: "inspect", pid, windowId: handle });
    if (!result.ok) throw new Error(result.error ?? "Windows could not inspect that window.");
    const window = verifiedWindowInfo(result.window);
    if (window.pid !== pid || window.windowId !== handle) throw new Error("Windows returned a different window identity; no retargeting is allowed.");
    return window;
  }

  async function windowAtPoint(x: number, y: number): Promise<{ pid: number; windowId: bigint; shell?: boolean; keyboardWindow?: boolean; screenOrigin?: { x: number; y: number } }> {
    assertWindows();
    assertOwner();
    if (![x, y].every((value) => Number.isSafeInteger(value) && value >= -32768 && value <= 32767)) {
      throw new Error("Invalid desktop hit-test coordinates.");
    }
    const result = await invokeNative({ op: "windowAtPoint", x, y });
    if (!result.ok) throw new Error(result.error ?? "Windows could not identify the input window at that point.");
    const window = result.pointWindow;
    if (!window || !Number.isSafeInteger(window.pid) || window.pid < 1
      || typeof window.windowId !== "string" || !WINDOW_ID_RE.test(window.windowId)) {
      throw new Error("The Windows hit test returned an invalid window identity.");
    }
    const windowId = BigInt(window.windowId);
    if (windowId <= BigInt(0) || windowId > BigInt("18446744073709551615")) throw new Error("The Windows hit test returned an invalid HWND.");
    const screenOrigin = window.screenOrigin;
    if (window.shell === true && (!screenOrigin || !Number.isSafeInteger(screenOrigin.x) || !Number.isSafeInteger(screenOrigin.y))) {
      throw new Error("The Windows hit test did not return the shell window origin required for window-scoped cursor placement.");
    }
    return { pid: window.pid, windowId, shell: window.shell === true, keyboardWindow: window.keyboardWindow === true,
      ...(screenOrigin ? { screenOrigin } : {}) };
  }

  async function pointControl(x: number, y: number, expected?: NativePointControl): Promise<NativePointControl> {
    assertWindows();
    assertOwner();
    if (![x, y].every((n) => Number.isSafeInteger(n) && n >= -32768 && n <= 32767)) throw new Error("Invalid accessibility point.");
    const result = await invokeNative({ op: expected ? "invokePointControl" : "inspectPointControl", x, y,
      ...(expected ? { label: expected.label, pid: expected.pid, windowId: expected.windowId, windowPid: expected.windowPid } : {}) });
    if (!result.ok) {
      if (expected) throwNativeInputFailure(result, "Windows accessibility control invocation failed.");
      throw new Error(result.error ?? "Windows accessibility control inspection failed.");
    }
    const control = result.control;
    if (!control || typeof control.label !== "string" || !control.label.trim() || !Number.isSafeInteger(control.pid) || control.pid < 1
      || typeof control.windowId !== "string" || !WINDOW_ID_RE.test(control.windowId) || !Number.isSafeInteger(control.windowPid) || control.windowPid < 1
      || !control.rect || !Object.values(control.rect).every(Number.isFinite) || control.rect.width <= 0 || control.rect.height <= 0
      || control.invoked !== Boolean(expected)) {
      if (expected) throw new DesktopInputOutcomeUnknownError("Windows returned an invalid accessibility invocation result; inspect the target before retrying.");
      throw new Error("Windows returned an invalid accessibility control.");
    }
    return control;
  }

  /**
   * Read the bounded Windows control-view tree rooted at the UI Automation
   * desktop element (not a Windows Task View desktop).
   * This is one shared observation capability for shell, taskbar, and visible
   * app controls; it is not a provider- or application-specific route.
   */
  async function desktopStructure(options: { maxElements?: number; maxDepth?: number } = {}): Promise<NativeDesktopStructure> {
    assertWindows();
    assertOwner();
    // Keep the wrapper aligned with the native UIA walker. The previous
    // desktop-wide 64/10 ceiling silently dropped taskbar, shell, and app
    // controls before the provider ever saw them; the native host already
    // supports the same 4096/64 bounds used for exact windows.
    const maxElements = options.maxElements ?? 4096;
    const maxDepth = options.maxDepth ?? 64;
    if (!Number.isSafeInteger(maxElements) || maxElements < 1 || maxElements > 4096
      || !Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 64) {
      throw new Error("Windows desktop structure bounds are invalid.");
    }
    const result = await invokeNative({ op: "inspectDesktopStructure", maxElements, maxDepth });
    if (!result.ok) throw new Error(result.error ?? "Windows UI Automation could not inspect the desktop structure.");
    const structure = result.desktopStructure;
    const screen = structure?.screen;
    if (!structure || structure.scope !== "desktop" || !["complete", "partial"].includes(structure.status)
      || !screen || ![screen.x, screen.y, screen.width, screen.height].every(Number.isSafeInteger)
      || screen.width < 1 || screen.height < 1 || screen.width > 65_536 || screen.height > 65_536
      || !Array.isArray(structure.elements) || structure.elements.length > maxElements
      || typeof structure.truncated !== "boolean") {
      throw new Error("Windows returned an invalid desktop UI Automation structure.");
    }
    for (const element of structure.elements) {
      if (!element || typeof element.ref !== "string" || !/^desktop-ui-element-\d+$/.test(element.ref)
        || typeof element.label !== "string" || element.label.length > 160
        || typeof element.role !== "string" || element.role.length > 80
        || typeof element.className !== "string" || element.className.length > 120
        || !Number.isSafeInteger(element.depth) || element.depth < 0 || element.depth > maxDepth
        || typeof element.enabled !== "boolean" || typeof element.focused !== "boolean"
        || !element.rect || ![element.rect.x, element.rect.y, element.rect.width, element.rect.height].every(Number.isFinite)
        || element.rect.width <= 0 || element.rect.height <= 0) {
        throw new Error("Windows returned an invalid desktop UI Automation element.");
      }
    }
    return structure;
  }

  async function windowStructure(pid: number, windowId: string, options: { maxElements?: number; maxDepth?: number } = {}): Promise<NativeWindowStructure> {
    assertWindows();
    assertOwner();
    parsePid(String(pid)); parseWindowId(windowId);
    const maxElements = options.maxElements ?? 256;
    const maxDepth = options.maxDepth ?? 32;
    if (!Number.isSafeInteger(maxElements) || maxElements < 1 || maxElements > 4096
      || !Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 64) {
      throw new Error("Windows window structure bounds are invalid.");
    }
    const snapshotId = randomUUID();
    const inspected = await invokeNative({ op: "inspect", pid, windowId });
    if (!inspected.ok) throw new Error(inspected.error ?? "Windows could not inspect the target window.");
    const result = await invokeNative({ op: "inspectWindowStructure", pid, windowId, maxElements, maxDepth, snapshotId });
    if (!result.ok) throw new Error(result.error ?? "Windows UI Automation could not inspect the target window.");
    const structure = result.windowStructure;
    if (!structure || structure.scope !== "window" || structure.windowId !== windowId
      || !["complete", "partial"].includes(structure.status) || !Array.isArray(structure.elements)
      || structure.elements.length > maxElements || typeof structure.truncated !== "boolean") {
      throw new Error("Windows returned an invalid window UI Automation structure.");
    }
    for (const element of structure.elements) {
      if (!element || typeof element.ref !== "string" || !/^window-ui-element-[A-Za-z0-9-]+$/.test(element.ref)
        || typeof element.label !== "string" || element.label.length > 160
        || typeof element.role !== "string" || element.role.length > 80
        || typeof element.className !== "string" || element.className.length > 120
        || typeof element.automationId !== "string" || element.automationId.length > 256
        || (element.runtimeId != null && (!Array.isArray(element.runtimeId) || element.runtimeId.length < 1 || element.runtimeId.length > 128
          || element.runtimeId.some((part) => !Number.isInteger(part) || part < -2147483648 || part > 2147483647)))
        || !Array.isArray(element.path) || element.path.length > maxDepth
        || element.path.some((part) => !Number.isSafeInteger(part) || part < 0)
        || !Number.isSafeInteger(element.depth) || element.depth < 0 || element.depth > maxDepth
        || typeof element.enabled !== "boolean" || typeof element.focused !== "boolean"
        || !element.rect || ![element.rect.x, element.rect.y, element.rect.width, element.rect.height].every(Number.isFinite)
        || element.rect.width <= 0 || element.rect.height <= 0
        || (element.actions !== undefined && Object.values(element.actions).some((action) => typeof action !== "boolean"))) {
        throw new Error("Windows returned an invalid window UI Automation element.");
      }
      if (element.scroll !== undefined && element.scroll !== null && ["horizontal", "vertical"].some((axis) => {
        const value = element.scroll?.[axis as "horizontal" | "vertical"];
        return !value || typeof value.scrollable !== "boolean"
          || (value.percent !== null && (!Number.isFinite(value.percent) || value.percent < 0 || value.percent > 100))
          || (value.viewSize !== null && (!Number.isFinite(value.viewSize) || value.viewSize < 0 || value.viewSize > 100));
      })) throw new Error("Windows returned invalid UI Automation scroll state.");
    }
    return structure;
  }

  async function invokeWindowElement(pid: number, windowId: string, input: {
    path: number[]; action: "activate" | "setValue" | "readValue" | "scroll"; expectedRole: string; expectedLabel: string;
    expectedClassName: string; expectedAutomationId: string; expectedRuntimeId?: number[]; text?: string; direction?: "up" | "down" | "left" | "right";
    granularity?: "small" | "large"; maxChars?: number;
  }): Promise<{ dispatched: boolean; mechanism?: string; reason?: string; valueConfirmed?: boolean;
    read?: boolean; value?: string; truncated?: boolean; redacted?: boolean;
    scrollBefore?: NativeScrollPosition; scrollAfter?: NativeScrollPosition; moved?: boolean | null }> {
    assertWindows(); assertOwner();
    parsePid(String(pid)); parseWindowId(windowId);
    if (!Array.isArray(input.path) || input.path.length > 64 || input.path.some((part) => !Number.isSafeInteger(part) || part < 0)
      || !input.expectedRole || (!input.expectedLabel && !input.expectedAutomationId && !input.expectedRuntimeId)
      || (input.expectedRuntimeId !== undefined && (!Array.isArray(input.expectedRuntimeId) || input.expectedRuntimeId.length < 1 || input.expectedRuntimeId.length > 128
        || input.expectedRuntimeId.some((part) => !Number.isInteger(part) || part < -2147483648 || part > 2147483647)))
      || (input.action === "setValue" && typeof input.text !== "string")
      || (input.action === "readValue" && input.maxChars !== undefined
        && (!Number.isSafeInteger(input.maxChars) || input.maxChars < 1 || input.maxChars > 4096))
      || (input.action === "scroll" && (!input.direction || !["up", "down", "left", "right"].includes(input.direction)
        || (input.granularity !== undefined && input.granularity !== "small" && input.granularity !== "large")))) {
      throw new Error("The native semantic action identity is invalid.");
    }
    let inspected: NativeWindowStageInfo;
    try { inspected = await inspectWindow(String(pid), windowId); }
    catch (error) {
      throw new DesktopInputNotDispatchedError(
        `The native semantic target could not be revalidated; no input was sent. ${error instanceof Error ? error.message : String(error)}`,
        "target-identity",
      );
    }
    if (inspected.pid !== pid || inspected.windowId !== windowId) {
      throw new DesktopInputNotDispatchedError("The native semantic target changed before dispatch; no semantic input was sent.", "target-identity");
    }
    let result: NativeStageResponse;
    try {
      result = await invokeNative({ op: "invokeWindowElement", pid, windowId, ...input });
    } catch (error) {
      if (error instanceof DesktopInputNotDispatchedError || error instanceof DesktopInputOutcomeUnknownError) throw error;
      throw new DesktopInputOutcomeUnknownError(
        `The native semantic action transport failed without proving whether Windows dispatched it. Inspect the target before retrying. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!result.ok) throwNativeInputFailure(result, "Windows could not dispatch the native semantic action.");
    const semanticAction = result.semanticAction;
    if (!semanticAction || typeof semanticAction.dispatched !== "boolean"
      || (semanticAction.mechanism !== undefined && typeof semanticAction.mechanism !== "string")
      || (semanticAction.reason !== undefined && typeof semanticAction.reason !== "string")
      || (semanticAction.valueConfirmed !== undefined && typeof semanticAction.valueConfirmed !== "boolean")
      || (semanticAction.read !== undefined && typeof semanticAction.read !== "boolean")
      // Rust limits Unicode scalar values; JavaScript counts UTF-16 code units,
      // so supplementary characters can occupy two units each.
      || (semanticAction.value !== undefined && (typeof semanticAction.value !== "string" || semanticAction.value.length > (input.maxChars ?? 512) * 2))
      || (semanticAction.truncated !== undefined && typeof semanticAction.truncated !== "boolean")
      || (semanticAction.redacted !== undefined && typeof semanticAction.redacted !== "boolean")
      || (semanticAction.moved !== undefined && semanticAction.moved !== null && typeof semanticAction.moved !== "boolean")
      || ([semanticAction.scrollBefore, semanticAction.scrollAfter].some((position) => position !== undefined
        && (!position || [position.horizontal, position.vertical].some((axis) => axis !== null && (!Number.isFinite(axis) || axis < 0 || axis > 100)))))) {
      throw new DesktopInputOutcomeUnknownError("Windows returned an invalid native semantic action result; inspect the target before retrying.");
    }
    const evidence = semanticAction.nativeDispatch;
    if (evidence && Number.isSafeInteger(evidence.helperPid) && evidence.helperPid > 0
      && /^\d{1,24}$/.test(evidence.startedUnixNanos) && /^\d{1,24}$/.test(evidence.endedUnixNanos)
      && BigInt(evidence.endedUnixNanos) >= BigInt(evidence.startedUnixNanos)) {
      try { deps.onNativeDispatch?.({ ...evidence, ...(streamContext.getStore() ? { streamId: streamContext.getStore() } : {}) }); }
      catch { /* telemetry never reclassifies a dispatched input */ }
    }
    // Native timing stays in the owner diagnostic channel, not provider tool context.
    const { nativeDispatch: _nativeDispatch, ...resultWithoutNativeTiming } = semanticAction;
    return resultWithoutNativeTiming;
  }

  async function captureWindow(pid: number, windowId: string): Promise<{ dataUrl: string; width: number; height: number; originX: number; originY: number }> {
    assertWindows();
    assertOwner();
    parsePid(String(pid)); parseWindowId(windowId);
    const inspected = await invokeNative({ op: "inspect", pid, windowId });
    if (!inspected.ok) throw new Error(inspected.error ?? "Windows could not inspect the target window.");
    const result = await invokeNative({ op: "captureWindow", pid, windowId });
    const capture = result.capture;
    if (!result.ok || !capture || typeof capture.dataUrl !== "string" || !/^data:image\/png;base64,/.test(capture.dataUrl)
      || !Number.isSafeInteger(capture.width) || capture.width < 1 || !Number.isSafeInteger(capture.height) || capture.height < 1
      || typeof capture.originX !== "number" || !Number.isSafeInteger(capture.originX)
      || typeof capture.originY !== "number" || !Number.isSafeInteger(capture.originY)) {
      throw new Error(result.error ?? "Windows could not capture the target window.");
    }
    return { dataUrl: capture.dataUrl, width: capture.width, height: capture.height,
      originX: capture.originX, originY: capture.originY };
  }

  /** Capture the owner's visible virtual screen directly with Win32 GDI. */
  async function captureDesktop(): Promise<{ dataUrl: string; width: number; height: number; originX?: number; originY?: number }> {
    assertWindows();
    assertOwner();
    const result = await invokeNative({ op: "captureDesktop" });
    const capture = result.capture;
    if (!result.ok || !capture || typeof capture.dataUrl !== "string" || !/^data:image\/png;base64,/.test(capture.dataUrl)
      || !Number.isSafeInteger(capture.width) || capture.width < 1 || !Number.isSafeInteger(capture.height) || capture.height < 1) {
      throw new Error(result.error ?? "Windows could not capture the owner desktop.");
    }
    return capture;
  }

  async function registerWindow(nameInput: string, pidInput: string, windowIdInput: string, appId?: string, coordinationKey?: string, shared = false): Promise<WindowsStageRecord> {
    assertWindows();
    assertOwner();
    const name = normalizedName(nameInput);
    if (appId !== undefined && !isPersistedAppId(appId)) throw new Error("The Windows stage app reference is invalid.");
    if (coordinationKey !== undefined && !isCoordinationKey(coordinationKey)) throw new Error("The Windows stage coordination key is invalid.");
    const info = await inspectWindow(pidInput, windowIdInput);
    const release = acquireRegistryLock(root);
    try {
      const registry = readRegistry(root);
      const existing = registry.stages.find((stage) => stage.name === name);
      const savedCoordinationKey = coordinationKey ?? existing?.coordinationKey;
      // Same staleness tolerance as assertWindowUnclaimed(): a dead preview stage's
      // leftover anchor must not permanently lock its window away from every later task.
      if (shared && (!deps.sharedWindowFence || !existing?.agentAssignment?.taskId || !taskActive(existing.agentAssignment.taskId))) {
        throw new Error("A shared window binding requires an active authenticated task and the owner broker's mutation fence.");
      }
      const liveClaimants = withoutStaleOwnerPreviewStages(registry.stages, processAlive, taskActive, now().getTime()).filter((stage) => stage.name !== name
        && stage.anchor?.pid === info.pid && stage.anchor.windowId === info.windowId
        && !(stage.agentAssignment?.taskId && !taskActive(stage.agentAssignment.taskId)));
      if (shared && liveClaimants.some((stage) => !stage.fencedBinding)) throw new Error("An unfenced stage already owns this window; re-observe it through the owner broker before sharing it.");
      const claimed = shared ? undefined : liveClaimants.find((stage) => !(deps.sharedWindowFence && stage.fencedBinding
        && savedCoordinationKey && stage.coordinationKey === savedCoordinationKey));
      if (claimed) throw new Error(`The requested window is already claimed by stage “${claimed.name}”; release or coordinate that ownership first.`);
      const savedAppId = appId ?? existing?.appId;
      const record: WindowsStageRecord = {
        name,
        ...(savedAppId !== undefined ? { appId: savedAppId } : {}),
        ...(savedCoordinationKey !== undefined ? { coordinationKey: savedCoordinationKey } : {}),
        ...(shared ? { sharedBinding: true as const } : {}),
        ...(deps.sharedWindowFence ? { fencedBinding: true as const } : {}),
        roomDesktopId: existing?.roomDesktopId ?? randomUUID(),
        anchor: { pid: info.pid, windowId: info.windowId, ...(info.processGeneration ? { processGeneration: info.processGeneration } : {}) },
        roomWindowId: existing?.anchor?.pid === info.pid && existing.anchor.windowId === info.windowId && existing.anchor.processGeneration === info.processGeneration
          ? existing.roomWindowId
          : randomUUID(),
        ...(existing?.agentAssignment ? { agentAssignment: existing.agentAssignment } : {}),
        registeredAt: existing?.registeredAt ?? now().toISOString(),
      };
      const kept = existing ? registry.stages : compactRegistryStages(registry);
      writeRegistryWhileLocked(root, {
        version: STAGE_REGISTRY_VERSION,
        stages: existing
          ? registry.stages.map((item) => item.name === name ? record : item)
          : [...kept, record],
      });
      return record;
    } finally {
      release();
    }
  }
  async function register(nameInput: string, pidInput: string, windowIdInput: string, appId?: string, coordinationKey?: string): Promise<WindowsStageRecord> {
    return registerWindow(nameInput, pidInput, windowIdInput, appId, coordinationKey);
  }
  /** Explicit read/target sharing only. Input still goes through the service's target fence. */
  async function attachSharedWindow(name: string, pid: string, windowId: string, appId?: string) {
    const stage = await registerWindow(name, pid, windowId, appId, undefined, true);
    return { stage, window: { ...stage.anchor! } };
  }

  async function create(nameInput: string): Promise<WindowsStageRecord> {
    return ensureStage(nameInput);
  }

  /**
   * Creates or refreshes the local M9R stage mapping. It does not create or
   * switch an operating-system desktop.
   */
  async function ensureStage(nameInput: string): Promise<WindowsStageRecord> {
    assertWindows();
    assertOwner();
    const name = normalizedName(nameInput);
    const release = acquireRegistryLock(root);
    try {
      const registry = readRegistry(root);
      const existing = registry.stages.find((stage) => stage.name === name);
      if (!existing) registry.stages = compactRegistryStages(registry);
      const record: WindowsStageRecord = {
        name,
        ...(existing?.appId !== undefined ? { appId: existing.appId } : {}),
        ...(existing?.coordinationKey !== undefined ? { coordinationKey: existing.coordinationKey } : {}),
        roomDesktopId: existing?.roomDesktopId ?? randomUUID(),
        anchor: null,
        roomWindowId: null,
        ...(existing?.agentAssignment ? { agentAssignment: existing.agentAssignment } : {}),
        registeredAt: existing?.registeredAt ?? now().toISOString(),
      };
      writeRegistryWhileLocked(root, {
        version: STAGE_REGISTRY_VERSION,
        stages: existing
          ? registry.stages.map((item) => item.name === name ? record : item)
          : [...registry.stages, record],
      });
      return record;
    } finally {
      release();
    }
  }

  async function inspectStage(nameInput: string): Promise<{ stage: WindowsStageRecord; anchor?: NativeWindowStageInfo }> {
    assertWindows();
    assertOwner();
    const name = normalizedName(nameInput);
    const stage = readRegistry(root).stages.find((item) => item.name === name);
    if (!stage) throw new Error(`No stage named “${name}” is registered on this machine.`);
    if (stage.anchor) {
      const result = await invokeNative({ op: "inspect", pid: stage.anchor.pid, windowId: stage.anchor.windowId });
      if (!result.ok) throw new Error(`Stage “${name}” anchor is unavailable: ${result.error ?? "unknown window error"}. The desktop mapping was kept.`);
      const anchor = verifiedWindowInfo(result.window);
      if (!stage.anchor.processGeneration && anchor.processGeneration
        && anchor.pid === stage.anchor.pid && anchor.windowId === stage.anchor.windowId) {
        // A window saved before generations were recorded: the live window still has the same process and
        // handle, so bind its generation now. Refusing here stranded every stage saved by an older build.
        stage.anchor = { ...stage.anchor, processGeneration: anchor.processGeneration };
        const release = acquireRegistryLock(root);
        try {
          const registry = readRegistry(root);
          writeRegistryWhileLocked(root, { ...registry,
            stages: registry.stages.map((item) => item.name === name && item.anchor?.pid === anchor.pid && item.anchor.windowId === anchor.windowId
              ? { ...item, anchor: { ...item.anchor, processGeneration: anchor.processGeneration! } } : item) });
        } finally { release(); }
      }
      if (!deps.invokeNative && !stage.anchor.processGeneration) {
        throw new Error("This saved window has no process-generation binding. Explicitly select or bind the intended current window before input; M9R will not silently trust a legacy PID/HWND.");
      }
      if (anchor.pid !== stage.anchor.pid || anchor.windowId !== stage.anchor.windowId
        || (stage.anchor.processGeneration !== undefined && anchor.processGeneration !== stage.anchor.processGeneration)) {
        throw new Error("The selected window process generation changed; refresh the exact target before sending input.");
      }
      return { stage, anchor };
    }
    return { stage };
  }

  async function attachWindow(nameInput: string, pidInput: string, windowIdInput: string, appId?: string, coordinationKey?: string): Promise<{ stage: WindowsStageRecord; window: NativeWindowStageInfo }> {
    assertWindows();
    assertOwner();
    const name = normalizedName(nameInput);
    const stage = readRegistry(root).stages.find((item) => item.name === name);
    if (!stage) throw new Error(`No stage named “${name}” is registered on this machine.`);
    const sharedKey = coordinationKey ?? stage.coordinationKey;
    assertWindowUnclaimed(name, Number(pidInput), windowIdInput, sharedKey);
    await inspectWindow(pidInput, windowIdInput);
    const registered = await register(name, pidInput, windowIdInput, appId, sharedKey);
    const inspected = await inspectStage(name);
    if (!inspected.anchor || inspected.anchor.pid !== registered.anchor?.pid || inspected.anchor.windowId !== registered.anchor?.windowId) {
      throw new Error(`Windows did not confirm that the selected app window is attached to stage “${name}”.`);
    }
    return { stage: registered, window: inspected.anchor };
  }

  async function roomKeys(nameInput: string): Promise<{ stage: WindowsStageRecord; anchor?: NativeWindowStageInfo }> {
    const inspected = await inspectStage(nameInput);
    const name = inspected.stage.name;
    const release = acquireRegistryLock(root);
    try {
      const path = registryPath(root);
      let savedVersion: unknown = null;
      if (existsSync(path)) {
        try { savedVersion = (JSON.parse(readFileSync(path, "utf8")) as { version?: unknown }).version; }
        catch { /* readRegistry below returns the actionable corruption error */ }
      }
      const registry = readRegistry(root);
      const stage = registry.stages.find((item) => item.name === name);
      if (!stage || stage.anchor?.pid !== inspected.stage.anchor?.pid
        || stage.anchor?.windowId !== inspected.stage.anchor?.windowId) {
        throw new Error(`Stage “${name}” changed while its room identifiers were being prepared. Refresh and retry.`);
      }
      if (savedVersion !== STAGE_REGISTRY_VERSION) writeRegistryWhileLocked(root, registry);
      return { ...inspected, stage };
    } finally {
      release();
    }
  }

  function list(): WindowsStageRecord[] {
    assertWindows();
    assertOwner();
    return readRegistry(root).stages;
  }

  function assignAgent(nameInput: string, assignment: { handle: string; sessionTag: string; taskId?: string } | null): WindowsStageRecord {
    assertWindows();
    assertOwner();
    const name = normalizedName(nameInput);
    if (assignment && (!/^[a-z0-9_-]{1,40}$/.test(assignment.handle) || !/^[a-f0-9]{8}$/.test(assignment.sessionTag)
      || (assignment.taskId !== undefined && (assignment.taskId.length < 1 || assignment.taskId.length > 100)))) {
      throw new Error("Invalid local agent-to-stage assignment.");
    }
    const release = acquireRegistryLock(root);
    try {
      const registry = readRegistry(root);
      const stage = registry.stages.find((item) => item.name === name);
      if (!stage) throw new Error(`No stage named “${name}” is registered on this machine.`);
      if (assignment && stage.agentAssignment
        && (stage.agentAssignment.handle !== assignment.handle || stage.agentAssignment.sessionTag !== assignment.sessionTag)) {
        throw new Error(`Stage “${name}” is already mapped to another agent session.`);
      }
      if (assignment) stage.agentAssignment = { ...assignment };
      else delete stage.agentAssignment;
      writeRegistryWhileLocked(root, registry);
      return stage;
    } finally {
      release();
    }
  }

  function forget(nameInput: string): WindowsStageRecord {
    assertWindows();
    assertOwner();
    const name = normalizedName(nameInput);
    const release = acquireRegistryLock(root);
    try {
      const registry = readRegistry(root);
      const stage = registry.stages.find((item) => item.name === name);
      if (!stage) throw new Error(`No stage named “${name}” is registered on this machine.`);
      writeRegistryWhileLocked(root, { version: STAGE_REGISTRY_VERSION, stages: registry.stages.filter((item) => item.name !== name) });
      return stage;
    } finally {
      release();
    }
  }

  async function listOwnedWindows(name: string, pid: number) {
    await inspectStage(name);
    return listOwnedWindowsForProcess(pid);
  }

  /**
   * Discover windows for an owner-approved process before a stage exists.
   * Preview stages use this to adopt the window on whatever desktop the owner
   * is currently viewing. It intentionally returns only exact-process window
   * identities; no arbitrary desktop or HWND can be supplied by an agent.
   */
  async function listOwnedWindowsForProcess(pid: number) {
    assertWindows();
    assertOwner();
    if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0xffff_ffff) throw new Error("Invalid owned process id.");
    const result = await invokeNative({ op: "listOwnedWindows", pid });
    if (!result.ok || !Array.isArray(result.windows)) throw new Error(result.error ?? "Owned-window discovery failed.");
    // Window enumeration can include helper, hidden, or otherwise non-targetable
    // HWNDs alongside the real app window. Rejecting the entire response because
    // one sibling is malformed makes a valid app launch fail before exact app
    // matching gets a chance to select its window. Filter candidates here; the
    // caller still selects by exact process/app identity and validates the chosen
    // PID/HWND again before binding or dispatching input.
    return result.windows.filter((window) => Number.isSafeInteger(window?.pid) && window.pid === pid
      && typeof window.windowId === "string" && WINDOW_ID_RE.test(window.windowId)
      && /[^0]/.test(window.windowId.replace(/^0[xX]/, ""))
      && typeof window.title === "string" && Number.isFinite(window.width) && Number.isFinite(window.height)
      && window.width >= 80 && window.height >= 60
      && (window.zOrder === undefined || (Number.isSafeInteger(window.zOrder) && window.zOrder >= 0))
      && (window.processPath == null || (typeof window.processPath === "string" && window.processPath.length > 0 && window.processPath.length <= 32_768))
      && (window.appUserModelId == null || (typeof window.appUserModelId === "string" && /^[A-Za-z0-9_.-]+![A-Za-z0-9_.-]+$/.test(window.appUserModelId))));
  }

  async function listVisibleWindows() {
    assertWindows();
    assertOwner();
    const result = await invokeNative({ op: "listVisibleWindows" });
    if (!result.ok || !Array.isArray(result.windows)) throw new Error(result.error ?? "Windows could not enumerate visible application windows.");
    return result.windows.filter((window): window is { pid: number; windowId: string; title: string; width: number; height: number; x?: number; y?: number; zOrder?: number; className?: string; processName?: string | null; processPath?: string | null; appUserModelId?: string | null } =>
      Number.isSafeInteger(window.pid) && window.pid > 0 && typeof window.windowId === "string" && WINDOW_ID_RE.test(window.windowId)
      && typeof window.title === "string" && Number.isSafeInteger(window.width) && window.width > 0
      && Number.isSafeInteger(window.height) && window.height > 0
      && (window.zOrder === undefined || (Number.isSafeInteger(window.zOrder) && window.zOrder >= 0))
      && (window.processPath == null || (typeof window.processPath === "string" && window.processPath.length > 0 && window.processPath.length <= 32_768))
      && (window.appUserModelId == null || (typeof window.appUserModelId === "string" && /^[A-Za-z0-9_.-]+![A-Za-z0-9_.-]+$/.test(window.appUserModelId))));
  }

  async function warm(): Promise<void> {
    assertWindows();
    assertOwner();
    const result = await invokeNative({ op: "ping" });
    if (!result.ok) throw new Error(result.error ?? "The native Windows stage helper failed its readiness check.");
  }

  /** The only automatic replacement resolver. A PID or title alone never
   * authorizes a rebind; creation time must match and exactly one HWND exists. */
  async function resolveWindowReplacement(nameInput: string) {
    assertWindows();
    assertOwner();
    const stage = readRegistry(root).stages.find((item) => item.name === normalizedName(nameInput));
    const anchor = stage?.anchor;
    if (!anchor?.processGeneration) return undefined;
    const process = await invokeNative({ op: "processGeneration", pid: anchor.pid });
    if (!process.ok || process.processGeneration !== anchor.processGeneration) return undefined;
    const candidates = await listOwnedWindowsForProcess(anchor.pid);
    if (candidates.length !== 1 || candidates[0]!.windowId === anchor.windowId) return undefined;
    const replacement = await inspectWindow(String(anchor.pid), candidates[0]!.windowId);
    if (replacement.processGeneration !== anchor.processGeneration) return undefined;
    return replacement;
  }

  async function presentOwnerWindow(name: string, pid: number, windowId: string, coordinationKey?: string) {
    const existing = readRegistry(root).stages.find((stage) => stage.name === normalizedName(name));
    assertWindowUnclaimed(name, pid, windowId, coordinationKey ?? existing?.coordinationKey);
    const result = await invokeNative({ op: "presentOwnerWindow", pid, windowId });
    if (!result.ok || result.window?.pid !== pid || result.window.windowId !== windowId) {
      throw new Error(result.error ?? "The requested application window was not presented.");
    }
    return verifiedWindowInfo(result.window);
  }

  function assertWindowUnclaimed(name: string, pid: number, windowId: string, coordinationKey?: string) {
    // A claim from a stage whose process has already exited is leftover registry
    // state, not a live hold -- the same staleness rule register() already uses to
    // prune dead preview stages. Checking it here too, not only at registration
    // time, stops a finished or crashed earlier session from permanently locking
    // a window out of every later task that happens to reuse the same app.
    const claimants = withoutStaleOwnerPreviewStages(readRegistry(root).stages, processAlive, taskActive, now().getTime());
    const claimed = claimants.find((stage) => stage.name !== name
      && stage.anchor?.pid === pid && stage.anchor.windowId === windowId
      && !(deps.sharedWindowFence && stage.fencedBinding && coordinationKey && stage.coordinationKey === coordinationKey)
      // A window host like explorer.exe or chrome.exe outlives any one task, so the
      // process never exits between tasks and the staleness check above never fires.
      // The real signal for "is this still a live hold" is whether the claimant's own
      // most recent task is still unfinished -- once it finished, the claim is stale
      // bookkeeping the same way a dead process's claim is, and must not block a
      // different, later task (even from a different session) from using the window.
      && !(stage.agentAssignment?.taskId && !taskActive(stage.agentAssignment.taskId)));
    if (claimed) throw new Error(`The requested window is already claimed by stage “${claimed.name}”; release or coordinate that ownership first.`);
  }

  async function windowStatus(pid: number, windowId: string) {
    assertWindows(); assertOwner();
    parsePid(String(pid)); parseWindowId(windowId);
    const result = await invokeNative({ op: "windowStatus", pid, windowId });
    if (!result.ok || !["closed", "minimized", "occluded", "hidden", "visible"].includes(result.windowState ?? "")) {
      throw new Error(result.error ?? "Window lifecycle state could not be verified.");
    }
    return result.windowState!;
  }

  async function foregroundWindow(pid: number, windowId: string, timeoutMs = 400): Promise<{ pid: number; windowId: string }> {
    assertWindows();
    parsePid(String(pid));
    parseWindowId(windowId);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 1_000) throw new Error("Invalid foreground verification timeout.");
    const result = await invokeNative({ op: "foregroundWindow", pid, windowId, timeoutMs });
    const current = result.foregroundWindow;
    if (!result.ok || !current || !Number.isSafeInteger(current.pid) || current.pid < 1
      || typeof current.windowId !== "string" || !WINDOW_ID_RE.test(current.windowId) || !/[^0]/.test(current.windowId)) {
      throw new Error(result.error ?? "Windows returned an invalid foreground window identity.");
    }
    return current;
  }

  async function currentForegroundWindow(): Promise<{ pid: number; windowId: string; title: string; className: string; visible: boolean; minimized: boolean }> {
    assertWindows(); assertOwner();
    const result = await invokeNative({ op: "currentForegroundWindow" });
    const current = result.foregroundWindow;
    if (!result.ok || !current || !Number.isSafeInteger(current.pid) || current.pid < 1
      || typeof current.windowId !== "string" || !WINDOW_ID_RE.test(current.windowId) || !/[^0]/.test(current.windowId.replace(/^0[xX]/, ""))
      || typeof current.title !== "string" || current.title.length > 512
      || typeof current.className !== "string" || current.className.length > 256
      || typeof current.visible !== "boolean" || typeof current.minimized !== "boolean") {
      throw new Error(result.error ?? "Windows returned an invalid foreground-window identity.");
    }
    return { pid: current.pid, windowId: current.windowId,
      title: current.title, className: current.className, visible: current.visible, minimized: current.minimized };
  }

  async function systemControl(request: WindowsSystemControlRequest): Promise<Record<string, unknown>> {
    assertWindows(); assertOwner();
    if (!request || !["display_brightness", "output_audio", "media", "microphone"].includes(request.control)
      || !["get", "set", "increase", "decrease", "mute", "unmute", "play_pause", "next", "previous"].includes(request.action)
      || (request.value !== undefined && (!Number.isSafeInteger(request.value) || request.value < 0 || request.value > 100))
      || (request.step !== undefined && (!Number.isSafeInteger(request.step) || request.step < 1 || request.step > 50))) {
      throw new Error("Invalid system-control request.");
    }
    const result = await invokeNative({ op: "systemControl", ...request });
    if (!result.ok || !result.result || typeof result.result !== "object" || Array.isArray(result.result)) {
      throw new Error(result.error ?? "Windows returned no system-control result.");
    }
    const value = result.result as Record<string, unknown>;
    if (value.control !== request.control) throw new Error("Windows returned a result for a different system control.");
    if (request.control === "media") {
      if (value.action !== request.action || value.dispatched !== true || typeof value.effect !== "string") throw new Error("Windows returned an invalid media-control result.");
    } else if (!Number.isInteger(value.level) || (value.level as number) < 0 || (value.level as number) > 100
      || ((request.control === "output_audio" || request.control === "microphone") && typeof value.muted !== "boolean")) {
      throw new Error("Windows returned an invalid system-control level.");
    }
    return value;
  }

  async function ownedPopups(pid: number, windowId: string) {
    assertWindows(); assertOwner();
    parsePid(String(pid)); parseWindowId(windowId);
    const result = await invokeNative({ op: "listOwnedPopups", pid, windowId });
    if (!result.ok || !Array.isArray(result.windows) || result.windows.length > 8) throw new Error(result.error ?? "Owned popup enumeration failed.");
    if (result.windows.some((w) => w.pid !== pid || !WINDOW_ID_RE.test(w.windowId))) throw new Error("Invalid owned popup identity.");
    return result.windows;
  }

  /**
   * Real, owned input dispatch -- SendInput at the native layer, not the
   * vendored Cua Driver. `pid`/`windowId` identify the target; every op here
   * requires the target to already be (or be brought to) the real OS
   * foreground window, since that is the only window `SendInput` keyboard
   * events can ever reach, regardless of what the caller intends to target.
   */
  async function windowRect(pid: number, windowId: string) {
    assertWindows(); assertOwner();
    parsePid(String(pid)); parseWindowId(windowId);
    const result = await invokeNative({ op: "windowRect", pid, windowId });
    const rect = result.rect as { x?: number; y?: number; width?: number; height?: number } | undefined;
    if (!result.ok || !rect || ![rect.x, rect.y, rect.width, rect.height].every((n) => typeof n === "number" && Number.isFinite(n)) || (rect.width as number) <= 0 || (rect.height as number) <= 0) {
      throw new Error(result.error ?? "Windows returned no valid window bounds.");
    }
    return { x: rect.x as number, y: rect.y as number, width: rect.width as number, height: rect.height as number };
  }

  /**
   * Reads the real usable work area of whichever monitor the window is
   * currently on -- screen bounds with the taskbar (and any other app-bar)
   * already subtracted, for that specific monitor in a multi-monitor setup,
   * regardless of which edge the taskbar is docked to. A window snap/dock
   * computed from this can never cover the taskbar the way one computed
   * from full screen/monitor bounds, or from an approximate drag endpoint
   * that misses the real edge pixel, can.
   */
  async function workArea(pid: number, windowId: string) {
    assertWindows(); assertOwner();
    parsePid(String(pid)); parseWindowId(windowId);
    const result = await invokeNative({ op: "workArea", pid, windowId });
    const rect = result.rect as { x?: number; y?: number; width?: number; height?: number } | undefined;
    if (!result.ok || !rect || ![rect.x, rect.y, rect.width, rect.height].every((n) => typeof n === "number" && Number.isFinite(n)) || (rect.width as number) <= 0 || (rect.height as number) <= 0) {
      throw new Error(result.error ?? "Windows returned no valid monitor work area.");
    }
    return { x: rect.x as number, y: rect.y as number, width: rect.width as number, height: rect.height as number };
  }

  async function bringToForeground(pid: number, windowId: string) {
    assertWindows(); assertOwner();
    parsePid(String(pid)); parseWindowId(windowId);
    const result = await invokeNative({ op: "bringToForeground", pid, windowId });
    if (!result.ok) throw new Error(result.error ?? "Windows declined to raise the target window to the foreground.");
  }

  async function sendClick(pid: number, windowId: string, x: number, y: number,
    options: { button?: "left" | "right" | "middle"; count?: 1 | 2 | 3 } = {}) {
    assertWindows(); assertOwner();
    parsePid(String(pid)); parseWindowId(windowId);
    const result = await invokeNative({ op: "sendClick", pid, windowId, x, y, ...options });
    if (!result.ok) throwNativeInputFailure(result, "Windows declined the click.");
  }

  async function sendDrag(pid: number, windowId: string, fromX: number, fromY: number, toX: number, toY: number, durationMs?: number) {
    assertWindows(); assertOwner();
    parsePid(String(pid)); parseWindowId(windowId);
    const result = await invokeNative({ op: "sendDrag", pid, windowId, fromX, fromY, toX, toY, ...(durationMs !== undefined ? { durationMs } : {}) });
    if (!result.ok) throwNativeInputFailure(result, "Windows declined the drag.");
  }

  async function sendScroll(pid: number, windowId: string, x: number, y: number, amount: number, axis: "horizontal" | "vertical" = "vertical") {
    assertWindows(); assertOwner();
    parsePid(String(pid)); parseWindowId(windowId);
    const result = await invokeNative({ op: "sendScroll", pid, windowId, x, y, amount, axis });
    if (!result.ok) throwNativeInputFailure(result, "Windows declined the scroll.");
  }

  async function sendKeyCombo(pid: number, windowId: string, keys: string[]) {
    assertWindows(); assertOwner();
    parsePid(String(pid)); parseWindowId(windowId);
    const result = await invokeNative({ op: "sendKeyCombo", pid, windowId, keys });
    if (!result.ok) throwNativeInputFailure(result, "Windows declined the key combination.");
  }

  async function sendText(pid: number, windowId: string, text: string) {
    assertWindows(); assertOwner();
    parsePid(String(pid)); parseWindowId(windowId);
    const result = await invokeNative({ op: "sendText", pid, windowId, text });
    if (!result.ok) throwNativeInputFailure(result, "Windows declined the typed text.");
  }

  /**
   * The background-safe sibling of {@link sendText}: posts WM_CHAR directly to the target
   * window's own message queue instead of SendInput, so it never requires -- and never steals --
   * OS foreground. Only reaches plain Win32 controls that handle WM_CHAR for text entry; a control
   * with custom input handling must still go through sendText (real foreground) or a UIA
   * SetValue/pattern call.
   */
  async function sendTextToWindow(pid: number, windowId: string, text: string) {
    assertWindows(); assertOwner();
    parsePid(String(pid)); parseWindowId(windowId);
    const result = await invokeNative({ op: "sendTextToWindow", pid, windowId, text });
    if (!result.ok) throwNativeInputFailure(result, "Windows declined the background-typed text.");
  }

  /**
   * Posts WM_CLOSE directly to a window, foreground-independent -- the same
   * property sendTextToWindow has for text. Test-only scaffolding for the
   * Phase 0 T3 proof (provoking a real app's own unsaved-changes dialog);
   * production closes an owned app by killing its process, never this.
   */
  async function postCloseWindow(pid: number, windowId: string) {
    assertWindows(); assertOwner();
    parsePid(String(pid)); parseWindowId(windowId);
    const result = await invokeNative({ op: "postCloseWindow", pid, windowId });
    if (!result.ok) throwNativeInputFailure(result, "Windows declined the WM_CLOSE request.");
  }

  /**
   * Resolves a window's descendant window whose real class is exactly
   * "Edit", if any. Used by background text delivery to redirect WM_CHAR to
   * a real app's actual editable child surface when the top-level frame it
   * was given is not itself an editable control.
   */
  async function findEditChildWindow(pid: number, windowId: string): Promise<string | undefined> {
    assertWindows(); assertOwner();
    parsePid(String(pid)); parseWindowId(windowId);
    const result = await invokeNative({ op: "findEditChildWindow", pid, windowId });
    if (!result.ok) throw new Error(result.error ?? "Could not search for a classic Edit child window.");
    return typeof result.childWindowId === "string" ? result.childWindowId : undefined;
  }

  /** Diagnostic only: every descendant window's own class name, in enumeration order. */
  async function listChildWindowClasses(pid: number, windowId: string): Promise<string[]> {
    assertWindows(); assertOwner();
    parsePid(String(pid)); parseWindowId(windowId);
    const result = await invokeNative({ op: "listChildWindowClasses", pid, windowId });
    if (!result.ok || !Array.isArray(result.classes)) throw new Error(result.error ?? "Could not enumerate child window classes.");
    return result.classes;
  }

  async function setWindowState(name: string, state: "minimized" | "maximized" | "restored") {
    const inspected = await inspectStage(name);
    if (!inspected.anchor) throw new Error("No exact selected window.");
    const result = await invokeNative({ op: "setWindowState", ...inspected.anchor, state });
    if (!result.ok || result.state !== state) throw new Error(result.error ?? "Window state was not verified.");
    return state;
  }

  async function setWindowFrame(pid: number, windowId: string, frame: { x: number; y: number; width: number; height: number }) {
    assertWindows(); assertOwner();
    parsePid(String(pid)); parseWindowId(windowId);
    if (![frame.x, frame.y, frame.width, frame.height].every(Number.isSafeInteger)
      || frame.x < -16_383 || frame.x > 16_383 || frame.y < -16_383 || frame.y > 16_383
      || frame.width < 1 || frame.width > 16_383 || frame.height < 1 || frame.height > 16_383) {
      throw new Error("Invalid native window frame.");
    }
    const result = await invokeNative({ op: "setWindowFrame", pid, windowId, ...frame });
    const rect = result.rect as { x?: number; y?: number; width?: number; height?: number } | undefined;
    if (!result.ok || !rect || ![rect.x, rect.y, rect.width, rect.height].every((n) => typeof n === "number" && Number.isFinite(n))) {
      throw new Error(result.error ?? "Windows did not confirm the requested window frame.");
    }
    return { x: rect.x as number, y: rect.y as number, width: rect.width as number, height: rect.height as number };
  }

  /**
   * Reads a window's or control's real text directly via GetWindowTextW -- never a UIA tree
   * read, never an echo of input that was sent. Test-only verification seam: production
   * correctness relies on the driver's own UIA/capture evidence, not this.
   */
  async function getWindowText(pid: number, windowId: string): Promise<string> {
    assertWindows(); assertOwner();
    parsePid(String(pid)); parseWindowId(windowId);
    const result = await invokeNative({ op: "getWindowText", pid, windowId });
    if (!result.ok || typeof result.text !== "string") throw new Error(result.error ?? "Windows could not read the window's text.");
    return result.text;
  }

  async function clipboardRead() {
    assertWindows(); assertOwner();
    const result = await invokeNative({ op: "clipboardRead" });
    const value = result.result as { text?: unknown } | undefined;
    if (!result.ok || typeof value?.text !== "string") throw new Error(result.error ?? "Windows could not read the shared clipboard.");
    return value.text;
  }

  async function clipboardWrite(text: string) {
    assertWindows(); assertOwner();
    if (typeof text !== "string" || text.length > 1_000_000) throw new Error("Clipboard text is invalid or too large.");
    const result = await invokeNative({ op: "clipboardWrite", text });
    if (!result.ok) throw new Error(result.error ?? "Windows could not write the shared clipboard.");
  }

  /**
   * The owner's real, physical pointer position -- distinct from any agent's synthetic cursor
   * overlay. Added for the owner-cursor-isolation fix: any action that must fall back to real
   * SendInput captures this immediately before acting and restores it with
   * `restoreOwnerCursorPosition` immediately after, so the owner's pointer is never left wherever
   * the agent's action happened to leave it.
   */
  async function getOwnerCursorPosition(): Promise<{ x: number; y: number }> {
    const result = await invokeNative({ op: "getCursorPosition" });
    if (!result.ok || !result.position || !Number.isFinite(result.position.x) || !Number.isFinite(result.position.y)) {
      throw new Error(result.error ?? "Could not read the owner's real pointer position.");
    }
    return result.position;
  }

  async function restoreOwnerCursorPosition(x: number, y: number): Promise<void> {
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) throw new Error("Invalid owner pointer restore coordinates.");
    const result = await invokeNative({ op: "restoreCursorPosition", x, y });
    if (!result.ok) throw new Error(result.error ?? "Could not restore the owner's real pointer position.");
  }

  function clearOwnedAnchor(nameInput: string, pid: number, windowId: string) {
    assertWindows(); assertOwner();
    const name = normalizedName(nameInput), release = acquireRegistryLock(root);
    try {
      const registry = readRegistry(root), stage = registry.stages.find((item) => item.name === name);
      if (!stage || stage.anchor?.pid !== pid || stage.anchor.windowId !== windowId) throw new Error("The task app is no longer this stage's registered window.");
      stage.anchor = null; stage.roomWindowId = null; delete stage.appId;
      writeRegistryWhileLocked(root, registry);
    } finally { release(); }
  }

  return { inspectWindow, windowAtPoint, pointControl, desktopStructure, windowStructure, invokeWindowElement, captureWindow, captureDesktop, register, create, ensureStage, inspectStage, resolveWindowReplacement, attachWindow, roomKeys, list, assignAgent, forget, listOwnedWindows, listOwnedWindowsForProcess, listVisibleWindows, presentOwnerWindow, clearOwnedAnchor, getOwnerCursorPosition, restoreOwnerCursorPosition, windowStatus, foregroundWindow, currentForegroundWindow, systemControl, setWindowState, setWindowFrame, clipboardRead, clipboardWrite, ownedPopups, warm,
    close: closeManager,
    withInputStream, closeInputStream, attachSharedWindow, withForegroundAuthorization,
    bringToForeground, sendClick, sendDrag, sendScroll, sendKeyCombo, sendText, sendTextToWindow, postCloseWindow, findEditChildWindow, listChildWindowClasses, getWindowText, windowRect, workArea };
}

function parsePid(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error("PID must be a positive decimal process id.");
  const pid = Number(value);
  if (pid < 1) throw new Error("PID must be a positive decimal process id.");
  if (!Number.isSafeInteger(pid) || pid > 0xffff_ffff) throw new Error("PID is outside the Windows process-id range.");
  return pid;
}

function parseWindowId(value: string): string {
  if (!WINDOW_ID_RE.test(value) || !/[^0]/.test(value.replace(/^0[xX]/, ""))) throw new Error("Window id must be a non-zero decimal or 0x-prefixed handle from the listed window.");
  return value;
}

interface PendingNativeStageRequest {
  readonly requestId: string;
  readonly operation: string;
  readonly resolve: (response: NativeStageResponse) => void;
  readonly reject: (error: Error) => void;
  readonly queuedAt: number;
  readonly timeoutMs: number;
  readonly frame: Buffer;
  sentAt?: number;
  startedAt?: number;
  timeout?: ReturnType<typeof setTimeout>;
}

/**
 * One long-lived native stage host per manager.  Spawning the helper for every
 * inspect/capture/input operation made a multi-step task pay process startup,
 * DLL loading, and UIA initialization repeatedly.  The host speaks the same
 * bounded length-prefixed JSON protocol as the input host. Requests are
 * serialized by the queue and independently identified so acknowledgements
 * and responses can be correlated with their caller.
 */
function createPersistentWindowsStageHost(executable: string) {
  let child: ChildProcessWithoutNullStreams | undefined;
  let closed = false;
  let buffer = Buffer.alloc(0);
  let stderrTail = "";
  const pending = new Map<string, PendingNativeStageRequest>();
  let activeRequestId: string | undefined;
  const startAcknowledgementTimeoutMs = 15_000;
  const inputOperations = new Set(["sendClick", "sendDrag", "sendScroll", "sendKeyCombo", "sendText", "sendTextToWindow", "postCloseWindow", "invokeWindowElement"]);


  const notDispatchedError = (request: Pick<PendingNativeStageRequest, "operation">, message: string): Error => inputOperations.has(request.operation)
    ? new DesktopInputNotDispatchedError(`${message} No target input was sent.`, "native-dispatch-unavailable")
    : new Error(message);

  const failProtocol = (error: Error, reason: string): void => {
    child?.kill();
    failAll(error,
      (queued) => notDispatchedError(queued, `Native Windows desktop-stage operation “${queued.operation}” was not dispatched because ${reason}.`),
      () => error);
  };

  const diagnosticError = (message: string): Error => {
    const detail = stderrTail.trim().replace(/\s+/g, " ").slice(-2_000);
    return new Error(detail ? `${message} Native helper stderr: ${detail}` : message);
  };

  const operationTimeoutMs = (operation: string): number => {
    if (["inspectDesktopStructure", "inspectWindowStructure", "captureWindow", "captureDesktop", "pointControl", "inspectPointControl", "invokePointControl"].includes(operation)) return 30_000;
    if (operation === "listVisibleWindows") return 12_000;
    if (operation === "foregroundWindow" || operation === "bringToForeground") return 3_000;
    return 15_000;
  };

  const failAll = (
    error: Error,
    unstartedError: (request: PendingNativeStageRequest) => Error = () => error,
    activeUnstartedError: (request: PendingNativeStageRequest) => Error = unstartedError,
  ): void => {
    const failedActiveRequestId = activeRequestId;
    const active = [...pending.values()];
    pending.clear();
    for (const request of active) {
      if (request.timeout) clearTimeout(request.timeout);
      request.reject(request.startedAt ? error
        : request.requestId === failedActiveRequestId ? activeUnstartedError(request) : unstartedError(request));
    }
    activeRequestId = undefined;
    child = undefined;
    buffer = Buffer.alloc(0);
    stderrTail = "";
  };

  const dispatchNext = (): void => {
    if (closed || !child || activeRequestId) return;
    const request = [...pending.values()].find((candidate) => candidate.sentAt === undefined);
    if (!request) return;
    const host = child;
    request.sentAt = Date.now();
    activeRequestId = request.requestId;
    request.timeout = setTimeout(() => {
      const elapsedMs = Date.now() - request.sentAt!;
      // No acknowledgement does not prove the active operation was not run:
      // the helper may have started it while its response pipe was unhealthy.
      // Keep that one result uncertain; later queued input is known not sent.
      const error = diagnosticError(`Native Windows desktop-stage operation “${request.operation}” (${request.requestId}) received no start acknowledgement within ${elapsedMs}ms; its outcome is uncertain and the helper was terminated.`);
      process.stderr.write(`[native-stage-helper-no-start] operation=${request.operation}; requestId=${request.requestId}; elapsedMs=${elapsedMs}\n`);
      host.kill();
      failAll(error,
        (queued) => notDispatchedError(queued, `Native Windows desktop-stage operation “${queued.operation}” was not dispatched because the preceding helper request never started.`),
        () => error);
    }, startAcknowledgementTimeoutMs);
    host.stdin.write(request.frame, (writeError) => {
      if (!writeError) return;
      const error = diagnosticError(`Native Windows stage request ${request.operation} (${request.requestId}) could not be written; its outcome is uncertain${writeError.message ? `: ${writeError.message}` : "."}`);
      host.kill();
      failAll(error,
        (queued) => notDispatchedError(queued, `Native Windows desktop-stage operation “${queued.operation}” was not dispatched because the preceding helper request could not be written.`),
        () => error);
    });
  };

  const parseFrames = (): void => {
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (length < 1 || length > MAX_NATIVE_RESPONSE_BYTES) {
        failProtocol(new Error("The native Windows stage helper response exceeded its safe size."), "the helper response protocol became invalid");
        return;
      }
      if (buffer.length < 4 + length) return;
      const body = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);
      let parsed: unknown;
      try { parsed = JSON.parse(body.toString("utf8")); }
      catch {
        failProtocol(new Error("Native Windows stage helper returned invalid JSON."), "the helper response protocol became invalid");
        return;
      }
      if (!parsed || typeof parsed !== "object") {
        failProtocol(new Error("Native Windows stage helper returned an invalid response."), "the helper response protocol became invalid");
        return;
      }
      const response = parsed as NativeStageResponse;
      const requestId = typeof (response as NativeStageResponse & { requestId?: unknown }).requestId === "string"
        ? (response as NativeStageResponse & { requestId: string }).requestId : undefined;
      if (!requestId) {
        failProtocol(new Error("Native Windows stage helper response omitted its request id; the active operation outcome is uncertain."), "the helper response omitted its request id");
        return;
      }
      const request = pending.get(requestId);
      if (!request) {
        failProtocol(new Error(`Native Windows stage helper returned an unknown request id ${requestId}; the active operation outcome is uncertain.`), "the helper response did not match the active request");
        return;
      }
      if (response.type === "started") {
        if (activeRequestId !== requestId) {
          const error = new Error(`Native Windows stage helper started out-of-order request ${requestId}.`);
          failProtocol(error, "the helper response protocol became invalid");
          return;
        }
        if (!request.startedAt) {
          if (request.timeout) clearTimeout(request.timeout);
          request.startedAt = Date.now();
          request.timeout = setTimeout(() => {
            const elapsedMs = Date.now() - request.startedAt!;
            const error = new Error(`Native Windows desktop-stage operation “${request.operation}” (${request.requestId}) did not return after ${elapsedMs}ms; its outcome is uncertain, the helper was terminated, and the target must be re-observed before retrying.`);
            child?.kill();
            failAll(error,
              (queued) => notDispatchedError(queued, `Native Windows desktop-stage operation “${queued.operation}” was not dispatched because the preceding ${request.operation} request timed out.`),
              () => error);
          }, request.timeoutMs);
        }
        continue;
      }
      if (typeof response.ok !== "boolean") {
        const error = new Error("Native Windows stage helper returned an invalid response; the active operation outcome is uncertain.");
        failProtocol(error, "the helper response was invalid");
        return;
      }
      if (activeRequestId !== requestId) {
        const error = new Error(`Native Windows stage helper completed out-of-order request ${requestId}.`);
        failProtocol(error, "the helper response protocol became invalid");
        return;
      }
      pending.delete(requestId);
      if (request.timeout) clearTimeout(request.timeout);
      activeRequestId = undefined;
      request.resolve(response);
      dispatchNext();
    }
  };

  const ensureChild = (): ChildProcessWithoutNullStreams => {
    if (closed) throw new Error("Native Windows stage helper is closed.");
    if (child) return child;
    if (!existsSync(executable)) throw new Error(`The native Windows stage helper is missing at ${executable}. Reinstall or rebuild the M9R Windows runtime first.`);
    const spawned = spawn(executable, ["--desktop-stage-server"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    child = spawned;
    spawned.stdout.on("data", (chunk: Buffer | string) => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      parseFrames();
    });
    spawned.stderr.on("data", (chunk: Buffer | string) => {
      stderrTail = `${stderrTail}${Buffer.from(chunk).toString("utf8")}`.slice(-8_192);
    });
    spawned.once("error", (error) => failAll(error,
      (request) => notDispatchedError(request, `Native Windows desktop-stage operation “${request.operation}” was not dispatched because the helper could not be started.`),
      (request) => notDispatchedError(request, `Native Windows desktop-stage operation “${request.operation}” was not dispatched because the helper could not be started.`)));
    spawned.once("close", (code, signal) => {
      if (child === spawned) {
        const active = [...pending.values()].map((request) => `${request.operation}:${request.requestId}:${request.startedAt ? Date.now() - request.startedAt : `queued-${Date.now() - request.queuedAt}`}ms`).join(",");
        const detail = `pid=${spawned.pid ?? "unknown"}; exitCode=${code ?? "unknown"}; signal=${signal ?? "none"}; pending=${active || "none"}`;
        process.stderr.write(`[native-stage-helper-exit] ${detail}\n`);
        const error = diagnosticError(`Native Windows stage helper exited unexpectedly (${code ?? "unknown"}, ${signal ?? "no signal"}); ${detail}.`);
        failAll(error,
          (request) => notDispatchedError(request, `Native Windows desktop-stage operation “${request.operation}” was not dispatched because the preceding helper request ended the process. ${detail}.`),
          () => error);
      }
    });
    return spawned;
  };

  const invoke = (request: Record<string, unknown>): Promise<NativeStageResponse> => {
    const operation = typeof request.op === "string" ? request.op : "unknown";
    const requestId = typeof request.requestId === "string" && request.requestId.length > 0 ? request.requestId : randomUUID();
    let payload: Buffer;
    try { payload = Buffer.from(JSON.stringify({ ...request, requestId }), "utf8"); }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return Promise.reject(notDispatchedError({ operation }, `Native Windows desktop-stage operation “${operation}” was not dispatched because its request could not be serialized: ${reason}.`));
    }
    if (payload.length > 16 * 1024) {
      return Promise.reject(notDispatchedError({ operation }, `Native Windows desktop-stage operation “${operation}” was not dispatched because its request was invalid or too large.`));
    }
    return new Promise((resolve, reject) => {
      const frame = Buffer.allocUnsafe(4 + payload.length);
      frame.writeUInt32LE(payload.length, 0);
      payload.copy(frame, 4);
      try { ensureChild(); }
      catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        reject(notDispatchedError({ operation }, `Native Windows desktop-stage operation “${operation}” was not dispatched because the helper is unavailable: ${reason}.`));
        return;
      }
      pending.set(requestId, { requestId, operation, resolve, reject, queuedAt: Date.now(), timeoutMs: operationTimeoutMs(operation), frame });
      dispatchNext();
    });
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    if (!child) return;
    child.kill();
    const error = diagnosticError("Native Windows stage helper was closed; the active operation outcome is uncertain.");
    failAll(error,
      (queued) => notDispatchedError(queued, `Native Windows desktop-stage operation “${queued.operation}” was not dispatched because the helper was closed before it started.`),
      () => error);
  };
  return { invoke, close };
}

export async function runWindowsDesktopStageCli(args: string[], deps: WindowsStageDependencies = {}): Promise<number> {
  const manager = createWindowsDesktopStageManager(deps);
  const json = args.includes("--json");
  const commandArgs = args.filter((arg) => arg !== "--json");
  const action = commandArgs[0];
  try {
    if (json && action === "list" && commandArgs.length === 1) {
      const stages = await Promise.all(manager.list().map(async (stage) => {
        try {
          const inspected = await manager.inspectStage(stage.name);
          return {
            name: stage.name,
            ...(stage.agentAssignment ? { agentAssignment: stage.agentAssignment } : {}),
            hasAnchor: Boolean(inspected.anchor),
            status: "available",
          };
        } catch (error) {
          return {
            name: stage.name,
            ...(stage.agentAssignment ? { agentAssignment: stage.agentAssignment } : {}),
            hasAnchor: false,
            status: "unavailable",
            error: error instanceof Error ? error.message : "Windows could not inspect this stage.",
          };
        }
      }));
      process.stdout.write(`${JSON.stringify({ ok: true, stages })}\n`);
      return 0;
    }
    if (json && action === "create" && commandArgs.length === 2) {
      const stage = await manager.create(commandArgs[1]!);
      process.stdout.write(`${JSON.stringify({ ok: true, stage })}\n`);
      return 0;
    }
    if (json && action === "inspect" && commandArgs.length === 2) {
      const result = await manager.inspectStage(commandArgs[1]!);
      process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
      return 0;
    }
    if (action === "room-keys" && commandArgs.length === 2) {
      const result = await manager.roomKeys(commandArgs[1]!);
      const machineId = readOrCreateStageMachineId(deps.root ?? defaultStoreRoot(homedir(), deps.env ?? process.env));
      const resourceKeys = formatWindowsStageRoomKeys(machineId, result.stage);
      if (json) process.stdout.write(`${JSON.stringify({ ok: true, stage: result.stage.name, resourceKeys })}\n`);
      else {
        process.stdout.write(`Desktop room key: ${resourceKeys.desktop}\n`);
        if (resourceKeys.window) process.stdout.write(`Anchor-window room key: ${resourceKeys.window}\n`);
        process.stdout.write("These keys label room coordination leases only; they do not grant another participant access to this computer.\n");
      }
      return 0;
    }
    if (action === "register" && commandArgs.length === 4) {
      const stage = await manager.register(commandArgs[1]!, commandArgs[2]!, commandArgs[3]!);
      process.stdout.write(`Registered owner-visible stage “${stage.name}”.\n`);
      process.stdout.write("The stage is a local window mapping; no Windows desktop was created or switched.\n");
      return 0;
    }
    if (json && action === "attach-window" && commandArgs.length === 4) {
      const result = await manager.attachWindow(commandArgs[1]!, commandArgs[2]!, commandArgs[3]!);
      process.stdout.write(`${JSON.stringify({ ok: true, window: result.window })}\n`);
      return 0;
    }
    if (action === "create" && commandArgs.length === 2) {
      const stage = await manager.create(commandArgs[1]!);
      process.stdout.write(`Registered owner-visible stage “${stage.name}”. No Windows desktop was created or switched.\n`);
      return 0;
    }
    if (action === "inspect" && commandArgs.length === 2) {
      const result = await manager.inspectStage(commandArgs[1]!);
      const anchor = result.anchor ? `; anchor PID ${result.anchor.pid}, window ${result.anchor.windowId}` : "";
      process.stdout.write(`Stage ${result.stage.name}: owner-visible${anchor}.\n`);
      return 0;
    }
    if (action === "forget" && commandArgs.length === 2) {
      const stage = manager.forget(commandArgs[1]!);
      process.stdout.write(`Forgot local mapping for stage ${stage.name}; no window was closed.\n`);
      return 0;
    }
    if (action === "list" && commandArgs.length === 1) {
      const stages = manager.list();
      process.stdout.write(stages.length ? stages.map((stage) => `${stage.name}${stage.anchor ? `\tanchor PID ${stage.anchor.pid}, window ${stage.anchor.windowId}` : "\tno window selected"}`).join("\n") + "\n" : "No local Windows stages registered.\n");
      return 0;
    }
    process.stderr.write("Usage: m9r web stage list | create <name> | register <name> <pid> <window-id> | inspect <name> | room-keys <name> | capture <name> --json | cursor <name> <x> <y> --json | forget <name> [--json]\n");
    process.stderr.write("Stages bind exact windows on the owner's visible Windows screen. They do not create, switch, or move between Windows desktops.\n");
    return action ? 1 : 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Windows stage operation failed."}\n`);
    return 1;
  }
}
