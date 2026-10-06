import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isAgentContext } from "./approval-core";
import { defaultStoreRoot } from "./local-store";

const STAGE_REGISTRY_VERSION = 3;
const MAX_STAGES = 16;
const MAX_NATIVE_RESPONSE_BYTES = 32 * 1024;
const DESKTOP_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WINDOW_ID_RE = /^(?:0[xX][0-9a-f]+|[0-9]+)$/;
const MACHINE_ID_FILE = "windows-stage-machine-id";

export interface WindowsStageRecord {
  name: string;
  desktopId: string;
  /** Random local coordination identity; the Windows desktop GUID never leaves this machine. */
  roomDesktopId: string;
  /** Desktop active before M9R created this stage; null for adopted stages. */
  returnToDesktopId: string | null;
  /** The stage is a real Windows desktop; an anchor is optional for a newly created stage. */
  anchor: { pid: number; windowId: string } | null;
  /** Random identity rotated whenever the registered anchor window changes. */
  roomWindowId: string | null;
  /** Local-only owner mapping; never included in room coordination events. */
  agentAssignment?: { handle: string; sessionTag: string };
  registeredAt: string;
}

interface StageRegistry {
  version: 3;
  stages: WindowsStageRecord[];
}

interface NativeWindowStageInfo {
  pid: number;
  windowId: string;
  desktopId: string;
  onCurrentDesktop: boolean;
}

interface NativeStageResponse {
  ok: boolean;
  error?: string;
  window?: NativeWindowStageInfo;
  desktop?: NativeDesktopStageInfo;
  input?: { childWindowId: string };
  windows?: { pid: number; windowId: string; title: string; width: number; height: number }[];
}

interface NativeDesktopStageInfo {
  desktopId: string;
  isCurrent: boolean;
  returnDesktopId?: string | null;
}

export interface WindowsStageDependencies {
  platform?: NodeJS.Platform;
  root?: string;
  nativeHostPath?: string;
  terminal?: boolean;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  invokeNative?: (request: Record<string, unknown>) => Promise<NativeStageResponse>;
}

function normalizedName(value: string): string {
  const name = value.trim().toLowerCase().replace(/\s+/g, "-");
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(name)) {
    throw new Error("Stage names must be 1–40 lowercase letters, numbers, hyphens, or underscores, and start with a letter or number.");
  }
  return name;
}

function parseRegistry(raw: string): StageRegistry {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("The local Windows stage registry is corrupt; it was left unchanged."); }
  const version = parsed && typeof parsed === "object" ? (parsed as { version?: unknown }).version : undefined;
  if (!parsed || typeof parsed !== "object" || typeof version !== "number"
    || ![1, 2, STAGE_REGISTRY_VERSION].includes(version) || !Array.isArray((parsed as { stages?: unknown }).stages)) {
    throw new Error("The local Windows stage registry has an unsupported format; it was left unchanged.");
  }
  const stages = (parsed as { stages: unknown[] }).stages;
  if (stages.length > MAX_STAGES) throw new Error("The local Windows stage registry exceeds its safe limit; it was left unchanged.");
  const names = new Set<string>();
  const records = stages.map((item): WindowsStageRecord => {
    if (!item || typeof item !== "object") throw new Error("The local Windows stage registry contains an invalid record; it was left unchanged.");
    const record = item as Partial<WindowsStageRecord>;
    const name = normalizedName(typeof record.name === "string" ? record.name : "");
    if (names.has(name)) throw new Error("The local Windows stage registry contains duplicate names; it was left unchanged.");
    names.add(name);
    if (typeof record.desktopId !== "string" || !DESKTOP_ID_RE.test(record.desktopId)) throw new Error("The local Windows stage registry contains an invalid desktop id; it was left unchanged.");
    const returnToDesktopId = record.returnToDesktopId ?? null;
    if (returnToDesktopId !== null && (typeof returnToDesktopId !== "string" || !DESKTOP_ID_RE.test(returnToDesktopId))) {
      throw new Error("The local Windows stage registry contains an invalid return desktop id; it was left unchanged.");
    }
    let anchor: WindowsStageRecord["anchor"] = null;
    if (record.anchor !== undefined && record.anchor !== null) {
      if (!Number.isInteger(record.anchor.pid) || (record.anchor.pid ?? 0) < 1 || typeof record.anchor.windowId !== "string" || !WINDOW_ID_RE.test(record.anchor.windowId)) {
        throw new Error("The local Windows stage registry contains an invalid anchor window; it was left unchanged.");
      }
      anchor = { pid: record.anchor.pid!, windowId: record.anchor.windowId };
    } else if (version === 1) {
      throw new Error("The local Windows stage registry contains an invalid anchor window; it was left unchanged.");
    }
    if (typeof record.registeredAt !== "string" || !Number.isFinite(Date.parse(record.registeredAt))) throw new Error("The local Windows stage registry contains an invalid registration time; it was left unchanged.");
    const roomDesktopId = record.roomDesktopId ?? (version < STAGE_REGISTRY_VERSION ? randomUUID() : null);
    const roomWindowId = record.roomWindowId ?? (version < STAGE_REGISTRY_VERSION && anchor ? randomUUID() : null);
    if (typeof roomDesktopId !== "string" || !DESKTOP_ID_RE.test(roomDesktopId)
      || (roomWindowId !== null && (typeof roomWindowId !== "string" || !DESKTOP_ID_RE.test(roomWindowId)))
      || (anchor === null && roomWindowId !== null) || (anchor !== null && roomWindowId === null)) {
      throw new Error("The local Windows stage registry contains an invalid room coordination identity; it was left unchanged.");
    }
    let agentAssignment: WindowsStageRecord["agentAssignment"];
    if (record.agentAssignment !== undefined) {
      const value = record.agentAssignment as { handle?: unknown; sessionTag?: unknown } | null;
      if (value !== null && (!value || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).some((key) => key !== "handle" && key !== "sessionTag")
        || typeof value.handle !== "string" || !/^[a-z0-9_-]{1,40}$/.test(value.handle)
        || typeof value.sessionTag !== "string" || !/^[a-f0-9]{8}$/.test(value.sessionTag))) {
        throw new Error("The local Windows stage registry contains an invalid agent assignment; it was left unchanged.");
      }
      if (value) agentAssignment = { handle: value.handle as string, sessionTag: value.sessionTag as string };
    }
    return {
      name,
      desktopId: record.desktopId.toLowerCase(),
      roomDesktopId: roomDesktopId.toLowerCase(),
      returnToDesktopId: returnToDesktopId?.toLowerCase() ?? null,
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
    if (!DESKTOP_ID_RE.test(value)) throw new Error("The local stage machine id is invalid; it was left unchanged.");
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
  if (Buffer.byteLength(raw, "utf8") > 16 * 1024) throw new Error("The local Windows stage registry is too large; it was left unchanged.");
  return parseRegistry(raw);
}

export function formatWindowsStageRoomKeys(machineId: string, stage: Pick<WindowsStageRecord, "roomDesktopId" | "roomWindowId">): { desktop: string; window?: string } {
  if (!DESKTOP_ID_RE.test(machineId) || !DESKTOP_ID_RE.test(stage.roomDesktopId)
    || (stage.roomWindowId !== null && !DESKTOP_ID_RE.test(stage.roomWindowId))) {
    throw new Error("The local Windows stage room identifiers are invalid.");
  }
  return {
    desktop: `desktop:${machineId.toLowerCase()}:${stage.roomDesktopId.toLowerCase()}`,
    ...(stage.roomWindowId ? { window: `window:${machineId.toLowerCase()}:${stage.roomWindowId.toLowerCase()}` } : {}),
  };
}

function acquireRegistryLock(root: string): () => void {
  mkdirSync(root, { recursive: true });
  const target = registryPath(root);
  const lock = `${target}.lock`;
  try {
    mkdirSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Another Windows stage registry update is already running; retry after it finishes.");
    throw error;
  }
  return () => rmSync(lock, { recursive: true, force: true });
}

function writeRegistryWhileLocked(root: string, registry: StageRegistry): void {
  const target = registryPath(root);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, target);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* preserve the original write error */ }
    throw error;
  }
}

function normalizeWindowInfo(value: unknown): NativeWindowStageInfo {
  if (!value || typeof value !== "object") throw new Error("The native Windows stage helper returned no window result.");
  const item = value as Partial<NativeWindowStageInfo>;
  if (!Number.isInteger(item.pid) || (item.pid ?? 0) < 1 || typeof item.windowId !== "string" || !WINDOW_ID_RE.test(item.windowId)
      || typeof item.desktopId !== "string" || !DESKTOP_ID_RE.test(item.desktopId) || typeof item.onCurrentDesktop !== "boolean") {
    throw new Error("The native Windows stage helper returned an invalid window result.");
  }
  return { pid: item.pid!, windowId: item.windowId, desktopId: item.desktopId.toLowerCase(), onCurrentDesktop: item.onCurrentDesktop };
}

export function createWindowsDesktopStageManager(deps: WindowsStageDependencies = {}) {
  const platform = deps.platform ?? process.platform;
  const root = deps.root ?? defaultStoreRoot(homedir(), deps.env ?? process.env);
  const now = deps.now ?? (() => new Date());
  const invokeNative = deps.invokeNative ?? ((request) => invokeWindowsStageHelper(
    deps.nativeHostPath ?? join(root, "bin", "m9r-native-input-host.exe"), request,
  ));

  function assertWindows(): void {
    if (platform !== "win32") throw new Error("The Windows virtual-desktop stage is available only on Windows.");
  }

  function assertOwner(): void {
    if (!deps.terminal && !(process.stdin.isTTY && process.stdout.isTTY)) throw new Error("Windows stage changes require the owner at an interactive terminal.");
    if (isAgentContext(deps.env ?? process.env)) throw new Error("Agents cannot create, activate, register, or move owner desktop stages; ask the owner to run this command in a terminal.");
  }

  async function inspectWindow(pidInput: string, windowId: string): Promise<NativeWindowStageInfo> {
    assertWindows();
    assertOwner();
    const pid = parsePid(pidInput);
    const handle = parseWindowId(windowId);
    const result = await invokeNative({ op: "inspect", pid, windowId: handle });
    if (!result.ok) throw new Error(result.error ?? "Windows could not inspect that window.");
    return normalizeWindowInfo(result.window);
  }

  async function register(nameInput: string, pidInput: string, windowIdInput: string): Promise<WindowsStageRecord> {
    assertWindows();
    assertOwner();
    const name = normalizedName(nameInput);
    const info = await inspectWindow(pidInput, windowIdInput);
    const release = acquireRegistryLock(root);
    try {
      const registry = readRegistry(root);
      const existing = registry.stages.find((stage) => stage.name === name);
      if (existing && existing.desktopId !== info.desktopId) {
        throw new Error(`Stage “${name}” already names a different desktop. Forget it first, then register the new desktop.`);
      }
      const record: WindowsStageRecord = {
        name,
        desktopId: info.desktopId,
        roomDesktopId: existing?.roomDesktopId ?? randomUUID(),
        returnToDesktopId: existing?.returnToDesktopId ?? null,
        anchor: { pid: info.pid, windowId: info.windowId },
        roomWindowId: existing?.anchor?.pid === info.pid && existing.anchor.windowId === info.windowId
          ? existing.roomWindowId
          : randomUUID(),
        ...(existing?.agentAssignment ? { agentAssignment: existing.agentAssignment } : {}),
        registeredAt: existing?.registeredAt ?? now().toISOString(),
      };
      if (!existing && registry.stages.length >= MAX_STAGES) throw new Error(`This machine already has ${MAX_STAGES} registered stages.`);
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

  async function create(nameInput: string): Promise<WindowsStageRecord> {
    assertWindows();
    assertOwner();
    const name = normalizedName(nameInput);
    const release = acquireRegistryLock(root);
    try {
      const registry = readRegistry(root);
      if (registry.stages.some((stage) => stage.name === name)) throw new Error(`A local stage named “${name}” already exists.`);
      if (registry.stages.length >= MAX_STAGES) throw new Error(`This machine already has ${MAX_STAGES} registered stages.`);

      const result = await invokeNative({ op: "createDesktop" });
      if (!result.ok) throw new Error(result.error ?? "Windows could not create a virtual desktop.");
      const desktop = normalizeDesktopInfo(result.desktop);
      if (desktop.isCurrent) throw new Error("Windows created the desktop but activated it unexpectedly; M9R did not register the stage.");
      if (registry.stages.some((stage) => stage.desktopId === desktop.desktopId)) throw new Error("Windows returned a desktop already registered under another stage name; the new stage was not registered.");
      if (!desktop.returnDesktopId) throw new Error("Windows created a stage but did not return the desktop that was active beforehand; M9R did not save the stage.");

      const record: WindowsStageRecord = {
        name,
        desktopId: desktop.desktopId,
        roomDesktopId: randomUUID(),
        returnToDesktopId: desktop.returnDesktopId.toLowerCase(),
        anchor: null,
        roomWindowId: null,
        registeredAt: now().toISOString(),
      };
      try {
        writeRegistryWhileLocked(root, { version: STAGE_REGISTRY_VERSION, stages: [...registry.stages, record] });
      } catch (error) {
        throw new Error(`Windows created desktop ${desktop.desktopId}, but M9R could not save its local stage mapping. The desktop was left intact. ${error instanceof Error ? error.message : ""}`.trim());
      }
      return record;
    } finally {
      release();
    }
  }

  function normalizeDesktopInfo(value: unknown): NativeDesktopStageInfo {
    if (!value || typeof value !== "object") throw new Error("The native Windows stage helper returned no desktop result.");
    const item = value as Partial<NativeDesktopStageInfo>;
    if (typeof item.desktopId !== "string" || !DESKTOP_ID_RE.test(item.desktopId) || typeof item.isCurrent !== "boolean"
        || (item.returnDesktopId !== undefined && item.returnDesktopId !== null
          && (typeof item.returnDesktopId !== "string" || !DESKTOP_ID_RE.test(item.returnDesktopId)))) {
      throw new Error("The native Windows stage helper returned an invalid desktop result.");
    }
    return {
      desktopId: item.desktopId.toLowerCase(),
      isCurrent: item.isCurrent,
      ...(item.returnDesktopId ? { returnDesktopId: item.returnDesktopId.toLowerCase() } : {}),
    };
  }

  async function inspectStage(nameInput: string): Promise<{ stage: WindowsStageRecord; desktop: NativeDesktopStageInfo; anchor?: NativeWindowStageInfo }> {
    assertWindows();
    assertOwner();
    const name = normalizedName(nameInput);
    const stage = readRegistry(root).stages.find((item) => item.name === name);
    if (!stage) throw new Error(`No stage named “${name}” is registered on this machine.`);
    if (stage.anchor) {
      const result = await invokeNative({ op: "inspect", pid: stage.anchor.pid, windowId: stage.anchor.windowId });
      if (!result.ok) throw new Error(`Stage “${name}” anchor is unavailable: ${result.error ?? "unknown window error"}. The desktop mapping was kept.`);
      const anchor = normalizeWindowInfo(result.window);
      if (anchor.desktopId !== stage.desktopId) throw new Error(`Stage “${name}” anchor moved to another desktop. The saved mapping was kept; re-register it only after owner review.`);
      return { stage, desktop: { desktopId: anchor.desktopId, isCurrent: anchor.onCurrentDesktop }, anchor };
    }
    const result = await invokeNative({ op: "inspectDesktop", desktopId: stage.desktopId });
    if (!result.ok) throw new Error(`Stage “${name}” is unavailable: ${result.error ?? "unknown desktop error"}. The local mapping was kept.`);
    const desktop = normalizeDesktopInfo(result.desktop);
    if (desktop.desktopId !== stage.desktopId) throw new Error(`Stage “${name}” resolved to a different desktop. The saved mapping was kept.`);
    return { stage, desktop };
  }

  async function activate(nameInput: string): Promise<{ stage: WindowsStageRecord; desktop: NativeDesktopStageInfo }> {
    assertWindows();
    assertOwner();
    const name = normalizedName(nameInput);
    const stage = readRegistry(root).stages.find((item) => item.name === name);
    if (!stage) throw new Error(`No stage named “${name}” is registered on this machine.`);
    const result = await invokeNative({ op: "activateDesktop", desktopId: stage.desktopId });
    if (!result.ok) throw new Error(result.error ?? "Windows could not activate the stage.");
    const desktop = normalizeDesktopInfo(result.desktop);
    if (desktop.desktopId !== stage.desktopId || !desktop.isCurrent) throw new Error("Windows did not confirm that the requested stage is active.");
    return { stage, desktop };
  }

  async function returnToOwnerDesktop(nameInput: string): Promise<{ stage: WindowsStageRecord; desktop: NativeDesktopStageInfo }> {
    assertWindows();
    assertOwner();
    const name = normalizedName(nameInput);
    const stage = readRegistry(root).stages.find((item) => item.name === name);
    if (!stage) throw new Error(`No stage named “${name}” is registered on this machine.`);
    if (!stage.returnToDesktopId) throw new Error(`Stage “${name}” was adopted from an existing desktop and has no saved return desktop.`);
    const result = await invokeNative({ op: "activateDesktop", desktopId: stage.returnToDesktopId });
    if (!result.ok) throw new Error(result.error ?? "Windows could not return to the desktop that was active before stage creation.");
    const desktop = normalizeDesktopInfo(result.desktop);
    if (desktop.desktopId !== stage.returnToDesktopId || !desktop.isCurrent) {
      throw new Error("Windows did not confirm that the original desktop is active.");
    }
    return { stage, desktop };
  }

  async function moveWindow(nameInput: string, pidInput: string, windowIdInput: string): Promise<{ fromDesktopId: string; window: NativeWindowStageInfo; stage: WindowsStageRecord }> {
    assertWindows();
    assertOwner();
    const name = normalizedName(nameInput);
    const stage = readRegistry(root).stages.find((item) => item.name === name);
    if (!stage) throw new Error(`No stage named “${name}” is registered on this machine.`);
    const current = await inspectWindow(pidInput, windowIdInput);
    if (current.desktopId === stage.desktopId) return { fromDesktopId: current.desktopId, window: current, stage };
    const result = await invokeNative({ op: "move", pid: current.pid, windowId: current.windowId, desktopId: stage.desktopId });
    if (!result.ok) throw new Error(result.error ?? "Windows could not move the window.");
    const moved = normalizeWindowInfo(result.window);
    if (moved.desktopId !== stage.desktopId) throw new Error("Windows did not confirm that the window reached the registered stage.");
    return { fromDesktopId: current.desktopId, window: moved, stage };
  }

  async function attachWindow(nameInput: string, pidInput: string, windowIdInput: string): Promise<{ stage: WindowsStageRecord; window: NativeWindowStageInfo }> {
    assertWindows();
    assertOwner();
    const name = normalizedName(nameInput);
    const stage = readRegistry(root).stages.find((item) => item.name === name);
    if (!stage) throw new Error(`No stage named “${name}” is registered on this machine.`);
    const current = await inspectWindow(pidInput, windowIdInput);
    if (current.desktopId !== stage.desktopId) await moveWindow(name, pidInput, windowIdInput);
    const registered = await register(name, pidInput, windowIdInput);
    const inspected = await inspectStage(name);
    if (!inspected.anchor || inspected.anchor.pid !== registered.anchor?.pid || inspected.anchor.windowId !== registered.anchor?.windowId) {
      throw new Error(`Windows did not confirm that the selected app window is attached to stage “${name}”.`);
    }
    return { stage: registered, window: inspected.anchor };
  }

  async function roomKeys(nameInput: string): Promise<{ stage: WindowsStageRecord; desktop: NativeDesktopStageInfo; anchor?: NativeWindowStageInfo }> {
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
      if (!stage || stage.desktopId !== inspected.stage.desktopId
        || stage.anchor?.pid !== inspected.stage.anchor?.pid
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

  function assignAgent(nameInput: string, assignment: { handle: string; sessionTag: string } | null): WindowsStageRecord {
    assertWindows();
    assertOwner();
    const name = normalizedName(nameInput);
    if (assignment && (!/^[a-z0-9_-]{1,40}$/.test(assignment.handle) || !/^[a-f0-9]{8}$/.test(assignment.sessionTag))) {
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

  async function controlInput(name: string, kind: "click" | "type" | "scroll", input: { x: number; y: number; imageWidth: number; imageHeight: number; text?: string; direction?: "up" | "down" }) {
    const inspected = await inspectStage(name);
    if (!inspected.anchor) throw new Error("Stage has no registered app window.");
    const result = await invokeNative({ op: "input", kind, pid: inspected.anchor.pid, windowId: inspected.anchor.windowId,
      desktopId: inspected.stage.desktopId, ...input });
    if (!result.ok) throw new Error(result.error ?? "Native child-control input failed.");
    if (!result.input?.childWindowId) throw new Error("Native input returned no exact control identity.");
    return result.input;
  }

  async function listOwnedWindows(name: string, pid: number) {
    await inspectStage(name);
    if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0xffff_ffff) throw new Error("Invalid owned process id.");
    const result = await invokeNative({ op: "listOwnedWindows", pid });
    if (!result.ok || !Array.isArray(result.windows)) throw new Error(result.error ?? "Owned-window discovery failed.");
    if (result.windows.length > 16 || result.windows.some((window) => window.pid !== pid
      || typeof window.windowId !== "string" || !WINDOW_ID_RE.test(window.windowId)
      || !/[^0]/.test(window.windowId.replace(/^0[xX]/, ""))
      || typeof window.title !== "string" || !Number.isFinite(window.width) || !Number.isFinite(window.height)
      || window.width < 80 || window.height < 60)) throw new Error("Owned-window discovery returned an invalid identity.");
    return result.windows;
  }

  async function showOwnedWindow(name: string) {
    const inspected = await inspectStage(name);
    if (!inspected.anchor) throw new Error("Stage has no registered owned app.");
    const result = await invokeNative({ op: "showOwnedWindow", pid: inspected.anchor.pid, windowId: inspected.anchor.windowId, desktopId: inspected.stage.desktopId });
    if (!result.ok) throw new Error(result.error ?? "The owned app could not be shown on its background stage.");
    return normalizeWindowInfo(result.window);
  }

  async function moveOwnedWindow(name: string, pid: number, windowId: string) {
    const inspected = await inspectStage(name);
    if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0xffff_ffff) throw new Error("Invalid owned process id.");
    const id = parseWindowId(windowId);
    const result = await invokeNative({ op: "showAndMoveOwnedWindow", pid, windowId: id, desktopId: inspected.stage.desktopId });
    if (!result.ok) throw new Error(result.error ?? "Windows could not place the launched app on its stage.");
    const window = normalizeWindowInfo(result.window);
    if (window.pid !== pid || window.windowId !== id || window.desktopId !== inspected.stage.desktopId || window.onCurrentDesktop) {
      throw new Error("Windows did not confirm the launched app on its background stage.");
    }
    return { stage: inspected.stage, window };
  }

  function clearOwnedAnchor(nameInput: string, pid: number, windowId: string) {
    assertWindows(); assertOwner();
    const name = normalizedName(nameInput), release = acquireRegistryLock(root);
    try {
      const registry = readRegistry(root), stage = registry.stages.find((item) => item.name === name);
      if (!stage || stage.anchor?.pid !== pid || stage.anchor.windowId !== windowId) throw new Error("The task app is no longer this stage's registered window.");
      stage.anchor = null; stage.roomWindowId = null;
      writeRegistryWhileLocked(root, registry);
    } finally { release(); }
  }

  return { inspectWindow, register, create, inspectStage, activate, returnToOwnerDesktop, moveWindow, attachWindow, roomKeys, list, assignAgent, forget, controlInput, listOwnedWindows, moveOwnedWindow, showOwnedWindow, clearOwnedAnchor };
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

function invokeWindowsStageHelper(executable: string, request: Record<string, unknown>): Promise<NativeStageResponse> {
  if (!existsSync(executable)) throw new Error(`The native Windows stage helper is missing at ${executable}. Reinstall or rebuild the M9R Windows runtime first.`);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["--desktop-stage-json"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error("The native Windows stage helper timed out."));
    }, 8_000);
    const finish = (error?: Error, value?: NativeStageResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(value!);
    };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > MAX_NATIVE_RESPONSE_BYTES) {
        child.kill();
        finish(new Error("The native Windows stage helper response exceeded its safe size."));
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-2_000); });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (settled) return;
      let parsed: unknown;
      try { parsed = JSON.parse(stdout); } catch { finish(new Error(`Native Windows stage helper returned invalid JSON${stderr.trim() ? `: ${stderr.trim()}` : "."}`)); return; }
      if (!parsed || typeof parsed !== "object" || typeof (parsed as NativeStageResponse).ok !== "boolean") {
        finish(new Error("Native Windows stage helper returned an invalid response."));
        return;
      }
      const response = parsed as NativeStageResponse;
      if (code !== 0 && response.ok) finish(new Error("Native Windows stage helper exited unsuccessfully after reporting success."));
      else finish(undefined, response);
    });
    child.stdin.end(JSON.stringify(request));
  });
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
            desktopId: stage.desktopId,
            returnToDesktopId: stage.returnToDesktopId,
            ...(stage.agentAssignment ? { agentAssignment: stage.agentAssignment } : {}),
            hasAnchor: Boolean(inspected.anchor),
            isCurrent: inspected.desktop.isCurrent,
            status: inspected.desktop.isCurrent ? "current" : "background",
          };
        } catch (error) {
          return {
            name: stage.name,
            desktopId: stage.desktopId,
            returnToDesktopId: stage.returnToDesktopId,
            ...(stage.agentAssignment ? { agentAssignment: stage.agentAssignment } : {}),
            hasAnchor: false,
            isCurrent: false,
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
    if (json && action === "activate" && commandArgs.length === 2) {
      const result = await manager.activate(commandArgs[1]!);
      process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
      return 0;
    }
    if (json && action === "return" && commandArgs.length === 2) {
      const result = await manager.returnToOwnerDesktop(commandArgs[1]!);
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
      process.stdout.write(`Registered local stage “${stage.name}” on desktop ${stage.desktopId}.\n`);
      process.stdout.write("The stage label is local to this machine. M9R did not create or switch a desktop.\n");
      return 0;
    }
    if (json && action === "attach-window" && commandArgs.length === 4) {
      const result = await manager.attachWindow(commandArgs[1]!, commandArgs[2]!, commandArgs[3]!);
      process.stdout.write(`${JSON.stringify({ ok: true, window: result.window })}\n`);
      return 0;
    }
    if (action === "create" && commandArgs.length === 2) {
      const stage = await manager.create(commandArgs[1]!);
      process.stdout.write(`Created M9R stage “${stage.name}” on Windows desktop ${stage.desktopId}. It remains in the background; use “m9r web stage activate ${stage.name}” to switch to it.\n`);
      return 0;
    }
    if (action === "inspect" && commandArgs.length === 2) {
      const result = await manager.inspectStage(commandArgs[1]!);
      const anchor = result.anchor ? `; anchor PID ${result.anchor.pid}, window ${result.anchor.windowId}` : "";
      process.stdout.write(`Stage ${result.stage.name}: desktop ${result.desktop.desktopId}${anchor}; ${result.desktop.isCurrent ? "currently active" : "on another desktop"}.\n`);
      return 0;
    }
    if (action === "activate" && commandArgs.length === 2) {
      const result = await manager.activate(commandArgs[1]!);
      process.stdout.write(`Activated stage “${result.stage.name}” (${result.desktop.desktopId}). The visible Windows desktop changed.\n`);
      return 0;
    }
    if (action === "return" && commandArgs.length === 2) {
      const result = await manager.returnToOwnerDesktop(commandArgs[1]!);
      process.stdout.write(`Returned from stage “${result.stage.name}” to its original desktop (${result.desktop.desktopId}).\n`);
      return 0;
    }
    if (action === "move-window" && commandArgs.length === 4) {
      const result = await manager.moveWindow(commandArgs[1]!, commandArgs[2]!, commandArgs[3]!);
      process.stdout.write(result.fromDesktopId === result.stage.desktopId
        ? `Window ${result.window.windowId} is already on stage ${result.stage.name}.\n`
        : `Moved window ${result.window.windowId} from desktop ${result.fromDesktopId} to stage ${result.stage.name} (${result.stage.desktopId}).\n`);
      return 0;
    }
    if (action === "forget" && commandArgs.length === 2) {
      const stage = manager.forget(commandArgs[1]!);
      process.stdout.write(`Forgot local mapping for stage ${stage.name}; Windows desktop and windows were not deleted.\n`);
      return 0;
    }
    if (action === "list" && commandArgs.length === 1) {
      const stages = manager.list();
      process.stdout.write(stages.length ? stages.map((stage) => `${stage.name}\t${stage.desktopId}${stage.anchor ? `\tanchor PID ${stage.anchor.pid}, window ${stage.anchor.windowId}` : "\tcreated by M9R"}`).join("\n") + "\n" : "No local Windows stages registered.\n");
      return 0;
    }
    process.stderr.write("Usage: m9r web stage list | create <name> | register <name> <pid> <window-id> | inspect <name> | activate <name> | return <name> | move-window <name> <pid> <window-id> | room-keys <name> | capture <name> --json | cursor <name> <x> <y> --json | forget <name> [--json]\n");
    process.stderr.write("Create and activate require an interactive owner terminal; activate changes the visible Windows desktop. register adopts an existing desktop from one of its windows.\n");
    return action ? 1 : 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Windows stage operation failed."}\n`);
    return 1;
  }
}
