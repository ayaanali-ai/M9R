import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface StageAppLaunchSpec { executable: string; args: string[]; windowExecutable?: string }
export type BrowserLaunchMode = "personal" | "isolated";

/** The browser executable family that the stage broker knows how to attach. */
export type StageBrowserKind = "chrome" | "msedge";

export interface BrowserWindowCandidate {
  pid: number;
  windowId: string;
  appName: string;
  title: string;
  /** Native window eligibility metadata. Older test/adaptor callers may omit it. */
  isOnScreen?: boolean;
  minimized?: boolean;
  onCurrentSpace?: boolean;
  zIndex?: string;
  width?: number;
  height?: number;
}

export interface ForegroundBrowserWindowIdentity {
  pid: number;
  windowId: string;
  onCurrentDesktop: boolean;
  visible: boolean;
  minimized: boolean;
}

/**
 * Keep browser launch policy explicit. Personal is the default: it uses the
 * user's normal profile and cookies. Isolated remains available as an owner
 * selected mode for tests or a deliberately separate profile.
 */
export function ownedBrowserLaunch(
  root: string,
  stageName: string,
  app: StageAppLaunchSpec,
  options: { mode?: BrowserLaunchMode; startUrl?: string } = {},
): StageAppLaunchSpec {
  if (!/^(?:preview-)?agent-[a-f0-9]{24}$/.test(stageName)) throw new Error("Invalid browser stage name.");
  if (app.args.length || !/^(?:chrome|msedge)\.exe$/i.test(basename(app.executable))) return app;
  const mode = options.mode ?? "personal";
  if (mode === "isolated") {
    return {
      ...app,
      args: [
        `--user-data-dir=${join(root, "stage-browser-profiles", stageName)}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--new-window",
        options.startUrl ?? "about:blank",
      ],
    };
  }
  // Chrome hands a personal launch to its existing browser process. Always
  // request a new window so the broker can identify the window created for the
  // task without stealing an already-open window the owner is using.
  return { ...app, args: ["--new-window", ...(options.startUrl ? [options.startUrl] : [])] };
}

export function stageBrowserKind(executable: string): StageBrowserKind | undefined {
  const name = basename(executable).toLowerCase();
  if (name === "chrome.exe") return "chrome";
  if (name === "msedge.exe") return "msedge";
  return undefined;
}

/** Match Windows' renderer HWND, including the normal terminal host for console apps. */
export function stageWindowMatchesApp(candidate: BrowserWindowCandidate, app: StageAppLaunchSpec): boolean {
  const key = (value: string) => basename(value).toLowerCase().replace(/\.exe$/, "");
  const expected = key(app.windowExecutable ?? app.executable);
  const actual = key(candidate.appName);
  // Packaged Windows apps are launched through explorer.exe and are hosted in
  // an ApplicationFrameHost top-level HWND. The host, not the inner XAML
  // child, is the focusable/foreground identity the native stage can own.
  // Accept that generic wrapper only for an explicit AppsFolder activation;
  // normal explorer launches still require an exact process match.
  const packagedActivation = app.args.some((arg) => /^shell:AppsFolder\\[^!]+![^!]+$/i.test(arg));
  if (packagedActivation && actual === "applicationframehost" && candidate.title.trim().length > 0) return true;
  if (expected === actual) {
    // explorer.exe hosts both real folder windows and the shell's own permanent
    // desktop/taskbar window (title "Program Manager"), which always exists whether
    // or not a folder window is open. Matching on process name alone let a stale or
    // nonexistent "Explorer" request silently reuse that desktop window forever
    // instead of ever launching a real folder window.
    if (actual === "explorer" && /^\s*$|^program manager$/i.test(candidate.title)) return false;
    return true;
  }
  if (!["windowsterminal", "openconsole", "conhost"].includes(actual)) return false;
  if (expected === "powershell" || expected === "pwsh") return /powershell/i.test(candidate.title);
  if (expected === "cmd") return /(?:command prompt|cmd\.exe)/i.test(candidate.title);
  return false;
}

function browserWindowMatches(candidate: BrowserWindowCandidate, kind: StageBrowserKind): boolean {
  const app = `${candidate.appName} ${candidate.title}`;
  if (kind === "chrome") return /(?:^|[\\/ _])(?:chrome|google chrome|chrome_widgetwin_1)(?:\.exe)?(?:$|[\\/ _])/.test(app.toLowerCase())
    && !/(?:edge|msedge)/i.test(app);
  return /(?:^|[\\/ ])(?:msedge|microsoft edge)(?:\.exe)?(?:$|[\\/ ])/.test(app.toLowerCase());
}

function eligibleBrowserWindow(candidate: BrowserWindowCandidate): boolean {
  // listWindows({ onScreenOnly: false }) is intentionally used during launch
  // polling so delegated browser processes can be discovered. Do not let that
  // broad inventory turn hidden/minimized/wrong-desktop helper HWNDs into a
  // false "multiple visible windows" refusal.
  if (candidate.isOnScreen === false || candidate.minimized === true || candidate.onCurrentSpace === false) return false;
  if (candidate.width !== undefined && candidate.width < 80) return false;
  if (candidate.height !== undefined && candidate.height < 60) return false;
  return true;
}

function rankBrowserWindows(candidates: readonly BrowserWindowCandidate[]): BrowserWindowCandidate[] {
  return [...candidates].sort((left, right) => {
    const leftZ = left.zIndex === undefined ? null : Number(left.zIndex);
    const rightZ = right.zIndex === undefined ? null : Number(right.zIndex);
    if (leftZ !== null && rightZ !== null && Number.isFinite(leftZ) && Number.isFinite(rightZ) && leftZ !== rightZ) return rightZ - leftZ;
    const leftArea = (left.width ?? 0) * (left.height ?? 0);
    const rightArea = (right.width ?? 0) * (right.height ?? 0);
    if (leftArea !== rightArea) return rightArea - leftArea;
    return `${left.pid}:${left.windowId}`.localeCompare(`${right.pid}:${right.windowId}`);
  });
}

/**
 * Return only a newly-created personal browser window. A pre-existing window
 * is never guessed when more than one candidate exists; the caller can keep
 * polling while Chrome finishes delegating the launch to its browser process.
 */
export function selectPersonalBrowserWindow(
  kind: StageBrowserKind,
  windows: readonly BrowserWindowCandidate[],
  beforeKeys: ReadonlySet<string>,
): BrowserWindowCandidate | undefined {
  const matches = rankBrowserWindows(windows.filter((candidate) => browserWindowMatches(candidate, kind) && eligibleBrowserWindow(candidate)));
  const fresh = matches.filter((candidate) => !beforeKeys.has(`${candidate.pid}:${candidate.windowId}`));
  if (fresh.length === 1) return fresh[0];
  // A launch must never silently choose between two newly-created windows.
  // The caller can keep polling for a single stable candidate or surface an
  // explicit selection request; deterministic z-order is not user intent.
  if (fresh.length > 1) return undefined;
  // If the browser was not running before launch, one visible candidate is a
  // safe adoption even when the platform did not expose a stable before-list.
  if (beforeKeys.size === 0 && matches.length === 1) return matches[0];
  return undefined;
}

/**
 * Adopt the user's already-open personal browser for an owner-visible preview.
 * The broker never guesses between multiple windows: the caller must either
 * close the extra windows or use an explicit window-selection flow.
 */
export function selectExistingPersonalBrowserWindow(
  kind: StageBrowserKind,
  windows: readonly BrowserWindowCandidate[],
  foreground?: ForegroundBrowserWindowIdentity,
): BrowserWindowCandidate | undefined {
  const matches = rankBrowserWindows(windows.filter((candidate) => browserWindowMatches(candidate, kind) && eligibleBrowserWindow(candidate)));
  if (matches.length === 1) return matches[0];
  // When several personal windows exist, the actual foreground HWND is the
  // user's current selection. Match its process and window identity exactly;
  // z-order, size, title, or enumeration order are not substitutes for that.
  if (matches.length > 1 && foreground && foreground.onCurrentDesktop && foreground.visible && !foreground.minimized) {
    const active = matches.filter((candidate) => candidate.pid === foreground.pid
      && candidate.windowId.toLowerCase() === foreground.windowId.toLowerCase());
    if (active.length === 1) return active[0];
  }
  // If another app is foreground, a unique topmost eligible browser HWND is
  // still a stable active-window choice. Never fall back to area or list order.
  if (matches.length > 1 && matches.every((candidate) => candidate.zIndex !== undefined && Number.isFinite(Number(candidate.zIndex)))) {
    const highest = Math.max(...matches.map((candidate) => Number(candidate.zIndex)));
    const frontmost = matches.filter((candidate) => Number(candidate.zIndex) === highest);
    if (frontmost.length === 1) return frontmost[0];
  }
  return undefined;
}

export function hasAmbiguousExistingPersonalBrowserWindow(kind: StageBrowserKind, windows: readonly BrowserWindowCandidate[]): boolean {
  return windows.filter((candidate) => browserWindowMatches(candidate, kind) && eligibleBrowserWindow(candidate)).length > 1;
}

function isWithinDirectory(directory: string, candidate: string): boolean {
  const path = relative(resolve(directory), resolve(candidate));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

/** Detect well-known global package-manager command shim directories. */
export function isPackageManagerShimPath(executable: string, env: Record<string, string | undefined> = process.env): boolean {
  const roots = [
    env.APPDATA ? join(env.APPDATA, "npm") : undefined,
    env.PNPM_HOME,
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "pnpm") : undefined,
    env.BUN_INSTALL ? join(env.BUN_INSTALL, "bin") : undefined,
    env.YARN_BIN,
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Yarn", "bin") : undefined,
  ].filter((path): path is string => Boolean(path));
  if (roots.some((root) => isWithinDirectory(root, executable))) return true;
  const parts = resolve(executable).toLowerCase().split(/[\\/]+/);
  return parts.some((part, index) => part === "node_modules" && parts[index + 1] === ".bin");
}

/**
 * Resolve a GUI app from Windows' installed-app inventory when the short name
 * finds no direct executable or only finds a global package-manager shim.
 * A detected shim is never launched as if it were the requested desktop app.
 */
export async function resolveStageLaunchApp(appId: string, input: {
  env?: Record<string, string | undefined>;
  resolveDirect: () => StageAppLaunchSpec;
  discoverInstalledApp: (name: string) => Promise<StageAppLaunchSpec | undefined>;
}): Promise<StageAppLaunchSpec> {
  const env = input.env ?? process.env;
  let direct: StageAppLaunchSpec | undefined;
  let directError: unknown;
  try { direct = input.resolveDirect(); } catch (error) { directError = error; }
  // A friendly app name is not an instruction to launch whichever executable
  // happens to win PATH/App-Paths lookup. Windows often exposes a legacy
  // compatibility stub beside the packaged app (Notepad is the common case),
  // and the stub can open the wrong window class or bypass the app's registered
  // activation route. Ask the installed-app inventory first for names; only an
  // explicit absolute executable path keeps the direct route authoritative.
  const explicitPath = isAbsolute(appId);
  const installed = explicitPath ? undefined : await input.discoverInstalledApp(appId);
  if (installed) return installed;
  const packageShim = direct !== undefined && isPackageManagerShimPath(direct.executable, env);
  if (direct && !packageShim) return direct;

  if (installed) return installed;
  if (packageShim) {
    throw new Error(`The app name "${appId}" resolved to a package-manager command shim, but Windows did not find a registered installed desktop app; the command shim was not launched.`);
  }
  if (directError) throw directError;
  throw new Error(`The app "${appId}" could not be resolved to an installed desktop application.`);
}
export function isStageAppReference(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024
    && !/[\u0000-\u001f\u007f]/.test(value)
    && (/^[\p{L}\p{N}][\p{L}\p{N} ._()+-]{0,159}$/u.test(value) || (isAbsolute(value) && /\.exe$/i.test(value)));
}

/**
 * Resolve an app's starting directory without inheriting a service cwd such as
 * C:\\Windows\\System32. Prefer the task's project, then configured project
 * root, and finally the user's home directory.
 */
export function stageAppLaunchCwd(
  taskCwd?: string,
  options: { env?: Record<string, string | undefined>; fallback?: string; isDirectory?: (path: string) => boolean } = {},
): string {
  const env = options.env ?? process.env;
  const isDirectory = options.isDirectory ?? ((path: string) => {
    try { return statSync(path).isDirectory(); } catch { return false; }
  });
  const candidates = [taskCwd, env.M9R_PROJECT_ROOT, env.M9R_AGENT_FOLDER, options.fallback ?? homedir()];
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (!value || !isAbsolute(value) || /^(?:[a-z]:[\\/]+windows|[a-z]:[\\/]+winnt)[\\/]+(?:system32|syswow64)(?:[\\/]|$)/i.test(value)) continue;
    if (isDirectory(value)) return value;
  }
  return homedir();
}

export function launchStageApp(app: StageAppLaunchSpec, options: { windowsHide?: boolean; cwd?: string } = {}): ChildProcess {
  // No shell, model-provided arguments, inherited stdin, or agent subprocess.
  // Owner-preview must create the GUI on the interactive desktop so Windows
  // attaches a virtual-desktop application view to the exact HWND. Background
  // stages keep the hidden launch behavior and move the owned window before it
  // is shown on the agent's stage.
  return spawn(app.executable, app.args, { shell: false, windowsHide: options.windowsHide ?? true, cwd: stageAppLaunchCwd(options.cwd), stdio: "ignore" });
}

/**
 * An agent names an installed app, and the broker resolves it to an exact executable without
 * accepting agent-supplied flags or shell syntax. Local apps are resolved from standard install
 * roots, PATH, Windows registrations, and Start menu shortcuts.
 */
export interface ResolvedUnlistedApp extends StageAppLaunchSpec {
  /** False when the agent named an absolute path; always audited at launch. */
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

function pathCandidates(id: string, env: Record<string, string | undefined>): string[] {
  if (!/^[a-z][a-z0-9_-]{0,80}(?:\.exe)?$/i.test(id)) return [];
  const pathValue = env.Path ?? env.PATH ?? "";
  const dirs = pathValue.split(/[;]/).map((value) => value.trim()).filter(Boolean);
  const systemRoot = env.SystemRoot?.trim() || env.WINDIR?.trim();
  if (systemRoot) dirs.push(join(systemRoot, "System32"));
  const localAppData = env.LOCALAPPDATA ?? env.LocalAppData;
  if (localAppData) dirs.push(join(localAppData, "Microsoft", "WindowsApps"));
  const names = id.toLowerCase().endsWith(".exe") ? [id] : [id, `${id}.exe`];
  return [...new Set(dirs.flatMap((dir) => names.map((name) => join(dir, name))))];
}

export function resolveUnlistedStageApp(appId: string, input: { allowAbsolutePath: boolean; env?: Record<string, string | undefined>; exists?: (path: string) => boolean } = { allowAbsolutePath: false }): ResolvedUnlistedApp {
  const env = input.env ?? process.env;
  const exists = input.exists ?? existsSync;
  const aliases: Record<string, string> = { terminal: "wt", "windows terminal": "wt", "google chrome": "chrome", "microsoft edge": "msedge", "file explorer": "explorer", "windows powershell": "powershell" };
  appId = aliases[appId.trim().toLowerCase()] ?? appId.trim();
  if (appId === "powershell" && (env.SystemRoot ?? env.WINDIR)) {
    const candidate = join((env.SystemRoot ?? env.WINDIR)!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (exists(candidate)) return { ...resolvedStageAppShape(candidate), wellKnown: true };
  }
  const wellKnown = wellKnownCandidates(appId, programRoots(env));
  for (const candidate of wellKnown) {
    if (!exists(candidate)) continue;
    return { ...resolvedStageAppShape(candidate), ...(appId === "wt" ? { windowExecutable: "WindowsTerminal.exe" } : {}), wellKnown: true };
  }
  for (const candidate of pathCandidates(appId, env)) {
    if (!exists(candidate)) continue;
    return { ...resolvedStageAppShape(candidate), ...(appId === "wt" ? { windowExecutable: "WindowsTerminal.exe" } : {}), wellKnown: true };
  }
  if (wellKnown.length > 0) throw new Error(`The app "${appId}" is not installed at any of its standard locations or PATH.`);
  // Absolute paths are accepted only when explicitly supplied as a bounded app reference.
  if (input.allowAbsolutePath && isAbsolute(appId) && /\.exe$/i.test(appId) && exists(appId)) {
    return { ...resolvedStageAppShape(appId), wellKnown: false };
  }
  throw new Error(`The app "${appId}" is not installed or could not be resolved on this machine.`);
}

function resolvedStageAppShape(executable: string): StageAppLaunchSpec {
  if (!statSync(executable).isFile()) throw new Error("The installed app is not a file.");
  return { executable, args: [] };
}
