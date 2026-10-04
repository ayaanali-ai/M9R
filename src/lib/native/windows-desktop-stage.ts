import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isAgentContext } from "./approval-core";
import { defaultStoreRoot } from "./local-store";

const STAGE_REGISTRY_VERSION = 1;
const MAX_STAGES = 16;
const MAX_NATIVE_RESPONSE_BYTES = 32 * 1024;
const DESKTOP_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WINDOW_ID_RE = /^(?:0[xX][0-9a-f]+|[0-9]+)$/;

export interface WindowsStageRecord {
  name: string;
  desktopId: string;
  anchor: { pid: number; windowId: string };
  registeredAt: string;
}

interface StageRegistry {
  version: 1;
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
  if (!parsed || typeof parsed !== "object" || (parsed as { version?: unknown }).version !== STAGE_REGISTRY_VERSION || !Array.isArray((parsed as { stages?: unknown }).stages)) {
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
    if (!record.anchor || !Number.isInteger(record.anchor.pid) || (record.anchor.pid ?? 0) < 1 || typeof record.anchor.windowId !== "string" || !WINDOW_ID_RE.test(record.anchor.windowId)) {
      throw new Error("The local Windows stage registry contains an invalid anchor window; it was left unchanged.");
    }
    if (typeof record.registeredAt !== "string" || !Number.isFinite(Date.parse(record.registeredAt))) throw new Error("The local Windows stage registry contains an invalid registration time; it was left unchanged.");
    return { name, desktopId: record.desktopId.toLowerCase(), anchor: { pid: record.anchor.pid!, windowId: record.anchor.windowId }, registeredAt: record.registeredAt };
  });
  return { version: 1, stages: records };
}

function registryPath(root: string): string {
  return join(root, "windows-stages.json");
}

function readRegistry(root: string): StageRegistry {
  const path = registryPath(root);
  if (!existsSync(path)) return { version: 1, stages: [] };
  const raw = readFileSync(path, "utf8");
  if (Buffer.byteLength(raw, "utf8") > 16 * 1024) throw new Error("The local Windows stage registry is too large; it was left unchanged.");
  return parseRegistry(raw);
}

function writeRegistry(root: string, registry: StageRegistry): void {
  mkdirSync(root, { recursive: true });
  const target = registryPath(root);
  const lock = `${target}.lock`;
  try {
    mkdirSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Another Windows stage registry update is already running; retry after it finishes.");
    throw error;
  }
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, target);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* preserve the original write error */ }
    throw error;
  } finally {
    rmSync(lock, { recursive: true, force: true });
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
    if (isAgentContext(deps.env ?? process.env)) throw new Error("Agents cannot register stages or move owner windows; ask the owner to run this command in a terminal.");
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
    const registry = readRegistry(root);
    const existing = registry.stages.find((stage) => stage.name === name);
    if (existing && existing.desktopId !== info.desktopId) {
      throw new Error(`Stage “${name}” already names a different desktop. Forget it first, then register the new desktop.`);
    }
    const record: WindowsStageRecord = {
      name,
      desktopId: info.desktopId,
      anchor: { pid: info.pid, windowId: info.windowId },
      registeredAt: existing?.registeredAt ?? now().toISOString(),
    };
    if (!existing && registry.stages.length >= MAX_STAGES) throw new Error(`This machine already has ${MAX_STAGES} registered stages.`);
    writeRegistry(root, {
      version: 1,
      stages: existing
        ? registry.stages.map((item) => item.name === name ? record : item)
        : [...registry.stages, record],
    });
    return record;
  }

  async function inspectStage(nameInput: string): Promise<{ stage: WindowsStageRecord; anchor: NativeWindowStageInfo }> {
    assertWindows();
    assertOwner();
    const name = normalizedName(nameInput);
    const stage = readRegistry(root).stages.find((item) => item.name === name);
    if (!stage) throw new Error(`No stage named “${name}” is registered on this machine.`);
    const result = await invokeNative({ op: "inspect", pid: stage.anchor.pid, windowId: stage.anchor.windowId });
    if (!result.ok) throw new Error(`Stage “${name}” anchor is unavailable: ${result.error ?? "unknown window error"}. The desktop mapping was kept.`);
    const anchor = normalizeWindowInfo(result.window);
    if (anchor.desktopId !== stage.desktopId) throw new Error(`Stage “${name}” anchor moved to another desktop. The saved mapping was kept; re-register it only after owner review.`);
    return { stage, anchor };
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

  function list(): WindowsStageRecord[] {
    assertWindows();
    assertOwner();
    return readRegistry(root).stages;
  }

  function forget(nameInput: string): WindowsStageRecord {
    assertWindows();
    assertOwner();
    const name = normalizedName(nameInput);
    const registry = readRegistry(root);
    const stage = registry.stages.find((item) => item.name === name);
    if (!stage) throw new Error(`No stage named “${name}” is registered on this machine.`);
    writeRegistry(root, { version: 1, stages: registry.stages.filter((item) => item.name !== name) });
    return stage;
  }

  return { inspectWindow, register, inspectStage, moveWindow, list, forget };
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
  const action = args[0];
  try {
    if (action === "register" && args.length === 4) {
      const stage = await manager.register(args[1]!, args[2]!, args[3]!);
      process.stdout.write(`Registered local stage “${stage.name}” on desktop ${stage.desktopId}.\n`);
      process.stdout.write("The stage is machine-local. Create and switch virtual desktops with Windows (Win+Ctrl+D / Win+Ctrl+Arrow); M9R does not switch desktops automatically.\n");
      return 0;
    }
    if (action === "inspect" && args.length === 2) {
      const result = await manager.inspectStage(args[1]!);
      process.stdout.write(`Stage ${result.stage.name}: desktop ${result.stage.desktopId}; anchor PID ${result.anchor.pid}, window ${result.anchor.windowId}; ${result.anchor.onCurrentDesktop ? "currently visible desktop" : "on another desktop"}.\n`);
      return 0;
    }
    if (action === "move-window" && args.length === 4) {
      const result = await manager.moveWindow(args[1]!, args[2]!, args[3]!);
      process.stdout.write(result.fromDesktopId === result.stage.desktopId
        ? `Window ${result.window.windowId} is already on stage ${result.stage.name}.\n`
        : `Moved window ${result.window.windowId} from desktop ${result.fromDesktopId} to stage ${result.stage.name} (${result.stage.desktopId}).\n`);
      return 0;
    }
    if (action === "forget" && args.length === 2) {
      const stage = manager.forget(args[1]!);
      process.stdout.write(`Forgot local mapping for stage ${stage.name}; Windows desktop and windows were not deleted.\n`);
      return 0;
    }
    if (action === "list" && args.length === 1) {
      const stages = manager.list();
      process.stdout.write(stages.length ? stages.map((stage) => `${stage.name}\t${stage.desktopId}\tanchor PID ${stage.anchor.pid}, window ${stage.anchor.windowId}`).join("\n") + "\n" : "No local Windows stages registered.\n");
      return 0;
    }
    process.stderr.write("Usage: m9r web stage list | register <name> <pid> <window-id> | inspect <name> | move-window <name> <pid> <window-id> | forget <name>\n");
    process.stderr.write("To register: create/switch to the Windows virtual desktop, open a window there, then register that window as its anchor.\n");
    return action ? 1 : 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Windows stage operation failed."}\n`);
    return 1;
  }
}
