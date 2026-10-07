import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { isAgentContext } from "./approval-core";

export interface ApprovedStageApp { executable: string; args: string[]; sha256: string }
/** Keep Chromium from handing a stage launch to the user's already-running browser process. */
export function ownedBrowserLaunch(root: string, stageName: string, app: ApprovedStageApp): ApprovedStageApp {
  if (!/^(?:preview-)?agent-[a-f0-9]{24}$/.test(stageName)) throw new Error("Invalid browser stage name.");
  if (app.args.length || !/^(?:chrome|msedge)\.exe$/i.test(basename(app.executable))) return app;
  return { ...app, args: [`--user-data-dir=${join(root, "stage-browser-profiles", stageName)}`, "--no-first-run", "--no-default-browser-check", "--new-window", "about:blank"] };
}
const CATALOG = "task-stage-apps.json";
const APP_ID = /^[a-z][a-z0-9_-]{0,39}$/;

export function listApprovedStageApps(root: string): string[] {
  const file = join(root, CATALOG);
  if (!existsSync(file)) return [];
  if (statSync(file).size > 65536) throw new Error("Stage app catalog exceeds its size limit.");
  const catalog = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown; apps?: Record<string, unknown> };
  if (catalog.version !== 1 || !catalog.apps || Array.isArray(catalog.apps) || typeof catalog.apps !== "object") throw new Error("Invalid stage app catalog.");
  const ids = Object.keys(catalog.apps);
  if (ids.length > 16 || ids.some((id) => !APP_ID.test(id))) throw new Error("Invalid stage app catalog.");
  return ids.sort();
}

export function readApprovedStageApp(root: string, id: string): ApprovedStageApp {
  if (!APP_ID.test(id)) throw new Error("Invalid stage app identifier.");
  const file = join(root, CATALOG);
  if (!existsSync(file) || statSync(file).size > 65536) throw new Error("No approved stage app catalog is available.");
  const catalog = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown; apps?: Record<string, ApprovedStageApp> };
  const app = catalog.version === 1 && catalog.apps && Object.hasOwn(catalog.apps, id) ? catalog.apps[id] : undefined;
  if (!app || !isAbsolute(app.executable) || !/\.exe$/i.test(app.executable) || !Array.isArray(app.args)
    || app.args.length > 16 || app.args.some((arg) => typeof arg !== "string" || arg.length > 2048 || /[\u0000\r\n]/.test(arg))
    || !/^[a-f0-9]{64}$/.test(app.sha256)) throw new Error("This app has not been approved for task stages.");
  if (!statSync(app.executable).isFile() || statSync(app.executable).size > 256 * 1024 * 1024) throw new Error("The approved app exceeds its supported size or is not a file.");
  if (createHash("sha256").update(readFileSync(app.executable)).digest("hex") !== app.sha256) throw new Error("The approved app changed; owner review is required again.");
  return app;
}

/** Only the owner supplies executable paths and fixed arguments; agents select an app ID. */
export function approveStageApp(root: string, id: string, executable: string, args: string[], context: { terminal: boolean; env: Record<string, string | undefined> }) {  if (!context.terminal || isAgentContext(context.env)) throw new Error("Only the owner can approve stage applications.");
  if (!APP_ID.test(id) || !isAbsolute(executable) || !/\.exe$/i.test(executable) || !statSync(executable).isFile() || statSync(executable).size > 256 * 1024 * 1024
    || args.length > 16 || args.some((arg) => typeof arg !== "string" || arg.length > 2048 || /[\u0000\r\n]/.test(arg))) throw new Error("Invalid stage application.");
  mkdirSync(root, { recursive: true });
  const file = join(root, CATALOG), lock = `${file}.lock`, temp = `${file}.${process.pid}.tmp`;
  mkdirSync(lock);
  try {
    if (existsSync(file) && statSync(file).size > 65536) throw new Error("Stage app catalog exceeds its size limit.");
    const catalog = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as { version: number; apps: Record<string, ApprovedStageApp> } : { version: 1, apps: {} };
    if (catalog.version !== 1 || !catalog.apps || Object.keys(catalog.apps).length >= 16 && !Object.hasOwn(catalog.apps, id)) throw new Error("Invalid or full stage app catalog.");
    catalog.apps[id] = { executable, args, sha256: createHash("sha256").update(readFileSync(executable)).digest("hex") };
    writeFileSync(temp, JSON.stringify(catalog) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temp, file);
  } finally { rmSync(temp, { force: true }); rmSync(lock, { recursive: true, force: true }); }
}

export function launchApprovedStageApp(app: ApprovedStageApp, options: { windowsHide?: boolean } = {}): ChildProcess {
  // No shell, model-provided arguments, inherited stdin, or agent subprocess.
  // Owner-preview must create the GUI on the interactive desktop so Windows
  // attaches a virtual-desktop application view to the exact HWND. Background
  // stages keep the hidden launch behavior and move the owned window before it
  // is shown on the agent's stage.
  return spawn(app.executable, app.args, { shell: false, windowsHide: options.windowsHide ?? true, stdio: "ignore" });
}

/**
 * Broker-resolved executables for full/request access modes. The mapping is fixed in code: an agent
 * names an id (or, in full mode only, an absolute path) and the broker resolves it to an exact file,
 * so agent input can never smuggle in arguments, flags, or a shell. Launched with fixed empty args and
 * hash-recorded at launch time, under the same exact-process custody as catalog apps.
 */
export interface ResolvedUnlistedApp extends ApprovedStageApp {
  /** False when the agent named an absolute path (full mode only); always audited at launch. */
  wellKnown: boolean;
}

const WINDOWS_PROGRAM_ROOTS = ["ProgramFiles", "ProgramFiles(x86)", "LocalAppData", "ProgramW6432"] as const;

function programRoots(env: Record<string, string | undefined>): string[] {
  const roots: string[] = [];
  for (const key of WINDOWS_PROGRAM_ROOTS) {
    const value = env[key]?.trim();
    if (value && isAbsolute(value)) roots.push(value);
  }
  return [...new Set(roots)];
}

function wellKnownCandidates(id: string, roots: string[]): string[] {
  const at = (...parts: string[]) => roots.map((root) => join(root, ...parts));
  switch (id) {
    case "chrome": return at("Google", "Chrome", "Application", "chrome.exe");
    case "msedge": return at("Microsoft", "Edge", "Application", "msedge.exe");
    case "firefox": return [
      ...roots.map((root) => join(root, "Mozilla Firefox", "firefox.exe")),
    ];
    default: return [];
  }
}

export function resolveUnlistedStageApp(appId: string, input: { allowAbsolutePath: boolean; env?: Record<string, string | undefined>; exists?: (path: string) => boolean } = { allowAbsolutePath: false }): ResolvedUnlistedApp {
  const env = input.env ?? process.env;
  const exists = input.exists ?? existsSync;
  const wellKnown = wellKnownCandidates(appId, programRoots(env));
  for (const candidate of wellKnown) {
    if (!exists(candidate)) continue;
    return { ...readApprovedStageAppShape(candidate), wellKnown: true };
  }
  if (wellKnown.length > 0) throw new Error(`The ${appId} browser is not installed at any of its standard locations.`);
  // Absolute paths are a full-mode-only escape hatch; request mode resolves well-known ids alone.
  if (input.allowAbsolutePath && isAbsolute(appId) && /\.exe$/i.test(appId) && exists(appId)) {
    return { ...readApprovedStageAppShape(appId), wellKnown: false };
  }
  throw new Error("This app has not been approved for task stages.");
}

function readApprovedStageAppShape(executable: string): ApprovedStageApp {
  if (!statSync(executable).isFile() || statSync(executable).size > 256 * 1024 * 1024) throw new Error("The app exceeds its supported size or is not a file.");
  return { executable, args: [], sha256: createHash("sha256").update(readFileSync(executable)).digest("hex") };
}
