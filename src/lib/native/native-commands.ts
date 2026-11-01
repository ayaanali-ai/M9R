/**
 * `m9r-cli setup`, `m9r-cli uninstall`, `m9r-cli send` and the native status block (design sections 8 and 20). File-writing, but
 * every decision about what to write comes from the tested pure cores in `install-core` and `local-store`.
 *
 * Rules: show the plan and ask before writing; compute every new file before writing any (so a bad file stops the
 * whole run with nothing half-done); back up every file that existed; record what was written so uninstall can put it
 * back exactly. Local mode needs no account and no network.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  UnparseableConfigError,
  decideUninstall,
  removeHooks,
  removeMcpServerJson,
  removeMcpServerToml,
  removeStandingInstruction,
  sha256,
  type ManifestEntry,
} from "./install-core";
import { createLocalStore, defaultStoreRoot, handleForProvider } from "./local-store";
import { inboxMaxAgeMs } from "./inbox-core";
import { hasPendingRuntimeTransaction, installRuntimeTransaction, pruneCompletedRuntimeTransactions, recoverRuntimeTransactions } from "./runtime-install-transaction";
import { createPageNotesStore } from "./page-notes-store";
import { projectRoomId } from "./project-room";
import { planOpenCodeModelStateRepair, resolveOpenCodeModelFiles, type OpenCodeModelRepairResult } from "./opencode-model-core";
import { opencodeExecutablePath } from "./opencode-executable";
import type { DeliveryDeps } from "./codex-delivery";
import { renameStateFile } from "./atomic-file";
import { DEFAULT_CLOUD_URL, clearCloudConfig, cloudUrlProblem, loadCloudConfig, pullCloudNotes, pushCloudNote, saveCloudConfig } from "./cloud-memory";
import { requestOwnerPipe } from "./owner-pipe";
import { ownerPipePath } from "./web-broker-paths";
import { canQueue, isWindowsSystemCwd, normCwd } from "./codex-delivery-core";
import { isHumanContext, isProtectedAction } from "./approval-core";
import { runAllow, runDecision, runLink, runPurgeStaleApprovals, runRevoke, runRules, runSessions, runSessionsJson, runTasks, runUnlink } from "./approval-commands";
import { acquireFeedLock, feedPath, runFeed } from "./feed-writer";
import { USER_STEPS } from "./onboarding-steps";
import { readRuntimeBuildId, readRuntimeBuildIdentity, type RuntimeBuildIdentity } from "./runtime-build-identity";
import { checkEngineUpdate, parseUpdateConfig } from "./update-lifecycle";
import {
  OPENCODE_IDENTITY_PLUGIN_FILENAME,
  removeOpenCodeWebMcp,
  resolveOpenCodeGlobalPaths,
  webOpenCodeLayout,
  type WebOpenCodeLayout,
} from "./web-setup-core";

export interface NativeIo {
  env: Record<string, string | undefined>;
  homeDir: string;
  out(line: string): void;
  err(line: string): void;
  /** Interactive yes/no; absent when there is no terminal, in which case `--yes` is required. */
  confirm?(question: string): Promise<boolean>;
  /** The caller's working folder, used to pick a session. M9R's own install directory is never a project folder. */
  cwd?: string;
  /** Deprecated test seam retained for source compatibility; broker-owned delivery never uses it. */
  codexDeps?: DeliveryDeps;
  /** Runtime image path; production defaults to the current executable, tests may use an isolated image. */
  executablePath?: string;
  /** Start-with-Windows switch; tests inject a fake so nothing ever touches the real registry. */
  autostart?: Autostart;
  /** Install the M9R-owned broker login task that restores provider processes before the first task. */
  installLocalBrokerAutostart?(): Promise<{ ok: boolean; message: string }>;
  /** Remove only the broker login task owned by this native install. */
  removeLocalBrokerAutostart?(): Promise<{ ok: boolean; message: string }>;
}

export interface Autostart {
  enable(command: string): boolean;
  disable(): void;
  isOn(): boolean;
}

const RUN_KEY = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`;

/** Windows "Run at sign-in" through the per-user Run key: no admin rights, visible in Task Manager's Startup tab, removed by uninstall. */
export const registryAutostart: Autostart = {
  enable(command) {
    if (process.platform !== "win32") return false;
    return spawnSync("reg", ["add", RUN_KEY, "/v", "M9R", "/t", "REG_SZ", "/d", command, "/f"], { windowsHide: true, stdio: "ignore" }).status === 0;
  },
  disable() {
    if (process.platform === "win32") spawnSync("reg", ["delete", RUN_KEY, "/v", "M9R", "/f"], { windowsHide: true, stdio: "ignore" });
  },
  isOn() {
    return process.platform === "win32" && spawnSync("reg", ["query", RUN_KEY, "/v", "M9R"], { windowsHide: true, stdio: "ignore" }).status === 0;
  },
};
const autostartOf = (io: NativeIo): Autostart => io.autostart ?? registryAutostart;

type Kind = "hooks-json" | "markdown-block" | "mcp-json" | "mcp-toml" | "opencode-json" | "opencode-plugin";
interface ActiveRuntimeManifest {
  schemaVersion: 1;
  buildId: string;
  sourceCommit: string;
  sourceDirty: boolean;
  installedRoot: string;
  stateRoot: string;
  installedAt: string;
  /** Present only when setup was invoked with a known project root. */
  sourceRoot?: string;
}
interface Manifest {
  version: 1;
  installedAt: string;
  entries: Array<ManifestEntry & { kind: Kind; openCodeLayout?: WebOpenCodeLayout }>;
  /** Exact M9R-owned files in the stable runtime directory. No retired generations are recorded here. */
  runtimeFiles?: string[];
  /** M9R starts when you sign in to Windows (removed on uninstall). */
  autostart?: boolean;
  /** This install also owns the local broker login task. */
  brokerAutostart?: boolean;
  /** Source-owned identity of the runtime image currently installed in the stable bin folder. */
  activeRuntime?: ActiveRuntimeManifest;
}

export function nativePaths(io: Pick<NativeIo, "env" | "homeDir">) {
  const m9r = defaultStoreRoot(io.homeDir, io.env);
  const claude = io.env.CLAUDE_CONFIG_DIR?.trim() || join(io.homeDir, ".claude");
  const codex = io.env.CODEX_HOME?.trim() || join(io.homeDir, ".codex");
  const openCode = resolveOpenCodeGlobalPaths({
    home: io.homeDir,
    xdgConfigHome: io.env.XDG_CONFIG_HOME,
    appData: io.env.APPDATA,
    exists: existsSync,
  });
  return {
    m9r,
    claude,
    codex,
    opencode: dirname(openCode.configPath),
    opencodeConfig: openCode.configPath,
    opencodeConfigPaths: openCode.configPaths,
    opencodePluginDirectory: openCode.pluginDirectory,
    opencodePlugin: join(openCode.pluginDirectory, OPENCODE_IDENTITY_PLUGIN_FILENAME),
    codexHooks: join(codex, "hooks.json"),
    codexAgents: join(codex, "AGENTS.md"),
    codexConfig: join(codex, "config.toml"),
    settings: join(claude, "settings.json"),
    claudeMd: join(claude, "CLAUDE.md"),
    claudeMcp: join(claude, ".mcp.json"),
    // Claude also has a user-level config beside the `.claude` directory. It
    // can win over the scoped file, so setup must reconcile both locations.
    claudeGlobalMcp: join(io.env.CLAUDE_CONFIG_DIR?.trim() || io.homeDir, ".claude.json"),
    manifest: join(m9r, "install-manifest.json"),
    webSetupManifest: join(m9r, "web-setup-manifest.json"),
    backups: join(m9r, "backups"),
  };
}

/**
 * The self-contained engine (one executable, no Node needed on the machine): `M9R_ENGINE` names it, or it is the program
 * already running this command. The engine is the broker-owned runtime image;
 * provider hooks are intentionally not a supported entry point.
 */
export function engineSource(env: Record<string, string | undefined>, execPath = process.execPath): string | null {
  if (env.M9R_ENGINE?.trim()) return env.M9R_ENGINE.trim();
  return /^m9r-engine(\.exe)?$/i.test(basename(execPath)) ? execPath : null;
}

const engineTarget = (io: Pick<NativeIo, "homeDir" | "env">) => join(nativePaths(io).m9r, "bin", process.platform === "win32" ? "m9r-engine.exe" : "m9r-engine");

function powerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Stops only the installed M9R engine image when the pipe is unavailable.
 *
 * The installer runs from a temporary candidate path, so an exact executable
 * path check keeps it separate from the resident engine that is being
 * replaced. This is deliberately not a process-name kill: no unrelated
 * node/provider process can be touched.
 */
function stopExactResidentEngineImage(enginePath: string): void {
  if (process.platform !== "win32") return;
  const target = resolve(enginePath);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$target = [IO.Path]::GetFullPath(${powerShellLiteral(target)})`,
    "$matches = @(Get-Process -Name 'm9r-engine' -ErrorAction SilentlyContinue | ForEach-Object {",
    "  try {",
    "    $path = [IO.Path]::GetFullPath($_.Path)",
    "    if ([string]::Equals($path, $target, [StringComparison]::OrdinalIgnoreCase)) { $_ }",
    "  } catch { }",
    "})",
    "foreach ($process in $matches) { $process | Stop-Process -Force }",
    "Start-Sleep -Milliseconds 150",
    "$remaining = @(Get-Process -Name 'm9r-engine' -ErrorAction SilentlyContinue | ForEach-Object {",
    "  try {",
    "    $path = [IO.Path]::GetFullPath($_.Path)",
    "    if ([string]::Equals($path, $target, [StringComparison]::OrdinalIgnoreCase)) { $_ }",
    "  } catch { }",
    "})",
    "if ($remaining.Count -gt 0) { throw 'The exact installed M9R engine image did not stop.' }",
  ].join("\n");
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  if (result.error || result.status !== 0) {
    throw new Error(`The exact installed M9R engine image did not stop: ${String(result.error ?? result.stderr ?? "unknown error")}`);
  }
}

/** Stops a running resident engine so its file can be replaced or removed; harmless when none is running. */
async function stopResidentEngine(io: NativeIo): Promise<void> {
  // The legacy hook pipe is intentionally not part of the shutdown protocol.
  // Stop only the exact broker-owned engine image; the installer owns the
  // broker task and provider-process drain separately.
  const installedEngine = engineTarget(io);
  if (existsSync(installedEngine)) stopExactResidentEngineImage(installedEngine);
}

const sameFile = (a: string, b: string): boolean => {
  try { return statSync(a).size === statSync(b).size && createHash("sha256").update(readFileSync(a)).digest("hex") === createHash("sha256").update(readFileSync(b)).digest("hex"); } catch { return false; }
};

function runtimePlan(io: NativeIo): { needed: boolean; sourceDir: string; targetDir: string; missingSource: string[]; engine?: { from: string; to: string }; shim?: { from: string; to: string }; nativeInputHost?: { from: string; to: string }; companions?: Array<{ from: string; to: string }> } {
  const targetDir = join(nativePaths(io).m9r, "bin");
  const engine = engineSource(io.env);
  // The broker-owned provider supervisor is the only supported runtime path.
  // Provider lifecycle hooks and the native hook shim are intentionally not
  // copied, started, or installed anymore. They are a legacy second control
  // plane and are removed by the setup plan below.
  if (engine) {
    const to = engineTarget(io);
    const shim = undefined;
    const nativeInputSource = process.platform === "win32" ? join(dirname(engine), "m9r-native-input-host.exe") : "";
    const nativeInputHost = nativeInputSource && existsSync(nativeInputSource)
      ? { from: nativeInputSource, to: join(targetDir, "m9r-native-input-host.exe") }
      : undefined;
    const companions: Array<{ from: string; to: string }> = [];
    const collect = (source: string, target: string) => {
      const info = lstatSync(source);
      if (info.isSymbolicLink()) throw new Error("The bundled runtime must not contain symbolic links.");
      if (info.isDirectory()) for (const name of readdirSync(source)) collect(join(source, name), join(target, name));
      else if (info.isFile()) companions.push({ from: source, to: target });
      else throw new Error("The bundled runtime contains an unsupported file type.");
    };
    for (const name of ["m9r-overlay.exe", "m9r-web-broker.exe", "cua-driver-runtime", "THIRD_PARTY_NOTICES.txt", "m9r-build-info.json"]) {
      // The standalone installer owns the web broker's hash manifest and has
      // an authenticated stop/replace/start lifecycle. A plain engine setup
      // must not overwrite that image behind the installer's ownership record.
      if (name === "m9r-web-broker.exe" && existsSync(join(nativePaths(io).m9r, "web-broker-install.json"))
        && io.env.M9R_INCLUDE_MANAGED_BROKER !== "1") continue;
      const source = join(dirname(engine), name);
      if (existsSync(source)) collect(source, join(targetDir, name));
    }
    return { needed: hasPendingRuntimeTransaction(targetDir) || !sameFile(engine, to) || (!!nativeInputHost && !sameFile(nativeInputHost.from, nativeInputHost.to)) || companions.some((file) => !sameFile(file.from, file.to)), sourceDir: dirname(engine), targetDir, missingSource: existsSync(engine) ? [] : [engine], engine: { from: engine, to }, shim, nativeInputHost, companions };
  }
  // A source checkout without the packaged engine can still inspect and clean
  // provider configuration, but it must never silently fall back to the old
  // hook-only runtime. That fallback is what allowed the two architectures to
  // reappear on the same machine.
  return { needed: false, sourceDir: "", targetDir, missingSource: [] };
}

function replaceRuntimeFile(from: string, to: string): string[] {
  if (sameFile(from, to)) return [];
  const staged = `${to}.m9r-new-${process.pid}-${randomUUID()}`;
  try {
    copyFileSync(from, staged);
    // Windows Defender and the shell can briefly retain a just-stopped image
    // handle. Retry the same stable-path replacement for a bounded window;
    // never rename the old executable aside or create a retired sibling.
    const attempts = process.platform === "win32" ? 24 : 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        renameSync(staged, to);
        return [];
      } catch (replaceError) {
        lastError = replaceError;
        const retryable = process.platform === "win32"
          && (replaceError as NodeJS.ErrnoException)?.code === "EPERM";
        if (!retryable || attempt === attempts) break;
        awaitDelay(250 * Math.min(attempt, 8));
      }
    }
    if (process.platform === "win32" && existsSync(to)) {
      throw new Error(`M9R could not replace the locked runtime file at its stable path: ${to}. Close M9R-owned work and retry; no retired copy was created.`, { cause: lastError });
    }
    throw lastError;
  } finally {
    rmSync(staged, { force: true });
  }
}

function awaitDelay(ms: number): void {
  const wake = Date.now() + ms;
  while (Date.now() < wake) {
    // Atomics.wait provides a synchronous bounded sleep without opening a
    // second event loop or allowing another installer transaction to overlap.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, wake - Date.now()));
  }
}

function plannedRuntimeTargets(runtime: { targetDir: string; engine?: { to: string }; shim?: { to: string }; nativeInputHost?: { to: string }; companions?: Array<{ to: string }> }): string[] {
  if (runtime.engine) return [runtime.engine.to, ...(runtime.shim ? [runtime.shim.to] : []), ...(runtime.nativeInputHost ? [runtime.nativeInputHost.to] : []), ...(runtime.companions ?? []).map((file) => file.to)];
  return [];
}

function obsoleteOwnedRuntimeEntries(
  manifest: Manifest | null,
  runtime: { targetDir: string; engine?: { to: string }; shim?: { to: string }; nativeInputHost?: { to: string }; companions?: Array<{ to: string }> },
  io: NativeIo,
): { removeTargets: string[]; preservedEntries: string[]; staleEntries: string[] } {
  const root = resolve(runtime.targetDir);
  const rootPrefix = `${root}${sep}`;
  const normalize = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
  const desired = new Set(plannedRuntimeTargets(runtime).map((path) => normalize(resolve(path))));
  const brokerPath = resolve(join(root, "m9r-web-broker.exe"));
  const separatelyManagedBroker = existsSync(join(nativePaths(io).m9r, "web-broker-install.json"))
    && io.env.M9R_INCLUDE_MANAGED_BROKER !== "1";
  const removeTargets: string[] = [];
  const preservedEntries: string[] = [];
  const staleEntries: string[] = [];
  for (const entry of manifest?.runtimeFiles ?? []) {
    if (typeof entry !== "string" || !entry.trim()) throw new Error("The M9R runtime ownership manifest contains an invalid path; refusing to update or delete runtime files.");
    const absolute = resolve(entry);
    const key = normalize(absolute);
    if (!normalize(absolute).startsWith(normalize(rootPrefix))) {
      // A legacy manifest entry outside the M9R runtime directory is not safe to
      // purge as part of runtime reconciliation; preserve it for explicit audit.
      preservedEntries.push(entry);
      continue;
    }
    if (desired.has(key)) continue;
    if (separatelyManagedBroker && key === normalize(brokerPath)) {
      preservedEntries.push(entry);
      continue;
    }
    staleEntries.push(entry);
    if (!existsSync(absolute)) continue;
    const info = lstatSync(absolute);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Refusing to remove an M9R runtime entry that is not a regular file: ${absolute}`);
    removeTargets.push(absolute);
  }
  return { removeTargets, preservedEntries, staleEntries };
}

function copyRuntime(plan: { sourceDir: string; targetDir: string; engine?: { from: string; to: string }; shim?: { from: string; to: string }; nativeInputHost?: { from: string; to: string }; companions?: Array<{ from: string; to: string }> }, previousRuntimeFiles: readonly string[], io: NativeIo, reconcileObsolete: boolean): string[] {
  mkdirSync(plan.targetDir, { recursive: true });
  const desired = plannedRuntimeTargets(plan);
  const previousManifest = { runtimeFiles: [...previousRuntimeFiles] } as Manifest;
  // A hook-only CLI package cannot authoritatively describe the complete
  // installed runtime. Preserve its existing ownership list; only a complete
  // engine package may reconcile and remove files from that full runtime.
  const obsolete = reconcileObsolete
    ? obsoleteOwnedRuntimeEntries(previousManifest, plan, io)
    : { removeTargets: [], preservedEntries: [...previousRuntimeFiles], staleEntries: [] };
  const removeTargets = obsolete.removeTargets;
  if (plan.engine) {
    recoverRuntimeTransactions(plan.targetDir, replaceRuntimeFile);
    const files = [plan.engine, ...(plan.shim ? [plan.shim] : []), ...(plan.nativeInputHost ? [plan.nativeInputHost] : []), ...(plan.companions ?? [])];
    installRuntimeTransaction(plan.targetDir, files, replaceRuntimeFile, removeTargets);
    pruneCompletedRuntimeTransactions(plan.targetDir);
    return [...desired, ...obsolete.preservedEntries];
  }
  // A source checkout without the packaged engine is inspection-only. Never
  // recreate the retired hook runtime as a fallback installation.
  if (plan.engine) throw new Error("The M9R-owned engine runtime was expected but is unavailable.");
  return [...desired, ...obsolete.preservedEntries];
}

const readText = (path: string): string | null => (existsSync(path) ? readFileSync(path, "utf8") : null);

export const MCP_SERVER_NAME = "m9r";
/** @deprecated Provider hook runtime files are retired and this list is intentionally empty. */
export const HOOK_RUNTIME_FILES = [] as const;

function openCodeVersionLine(io: NativeIo): string | undefined {
  const configured = io.env.M9R_OPENCODE_VERSION?.trim();
  if (configured) return configured;
  try {
    const executable = opencodeExecutablePath(io.env);
    if (!executable) return undefined;
    const result = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 2000, windowsHide: true, shell: false });
    if (result.status !== 0) return undefined;
    return String(result.stdout ?? "").split(/\r?\n/, 1)[0]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function openCodeLayoutFor(io: NativeIo, existing: string | null): WebOpenCodeLayout {
  const versionLayout = webOpenCodeLayout(openCodeVersionLine(io));
  if (versionLayout === "servers") return versionLayout;
  // If version probing is unavailable, an existing modern config still gives
  // us an unambiguous layout signal. Never rewrite it into the legacy shape.
  return existing && /["']servers["']\s*:/u.test(existing) ? "servers" : "legacy";
}

interface PlannedFile {
  path: string;
  kind: Kind;
  before: string | null;
  after: string;
  changed: boolean;
  summary: string;
  openCodeLayout?: WebOpenCodeLayout;
  /** A legacy provider integration file that is owned by M9R and must be removed, not emptied. */
  removeFile?: boolean;
}

interface NativeOpenCodeModelRepair {
  statePath: string;
  plan: OpenCodeModelRepairResult;
}

/**
 * Plan the same conservative model-state repair used by web setup for native
 * setup too. OpenCode's model.json is user state, so a native runtime update
 * must never guess a replacement: it only removes references that the local
 * cached catalog explicitly marks unavailable and selects another usable
 * model from that catalog.
 */
function planNativeOpenCodeModelRepair(io: NativeIo, selectedAgents: readonly string[] | undefined, includeMcp: boolean): NativeOpenCodeModelRepair | null {
  if (!includeMcp) return null;
  const p = nativePaths(io);
  const wantsOpenCode = selectedAgents === undefined ? p.opencodeConfigPaths.some((path) => existsSync(path)) : selectedAgents.includes("opencode");
  if (!wantsOpenCode) return null;
  const paths = resolveOpenCodeModelFiles({
    home: io.homeDir,
    xdgStateHome: io.env.XDG_STATE_HOME,
    xdgCacheHome: io.env.XDG_CACHE_HOME,
  });
  if (!existsSync(paths.statePath) || !existsSync(paths.catalogPath)) return null;
  try {
    const state = JSON.parse(readFileSync(paths.statePath, "utf8")) as unknown;
    const catalog = JSON.parse(readFileSync(paths.catalogPath, "utf8")) as unknown;
    const plan = planOpenCodeModelStateRepair(state, catalog);
    return { statePath: paths.statePath, plan };
  } catch {
    return {
      statePath: paths.statePath,
      plan: { status: "blocked", reason: "persisted OpenCode model state or its cached provider catalog is not valid JSON", removedModelIDs: [] },
    };
  }
}

/** Replace a managed state file with a same-directory temporary file, retaining the old bytes separately first. */
function applyNativeOpenCodeModelRepair(repair: NativeOpenCodeModelRepair): string | null {
  if (repair.plan.status !== "updated" || !repair.plan.state) return null;
  const backupPath = `${repair.statePath}.m9r-backup-${randomUUID()}.json`;
  const temporaryPath = `${repair.statePath}.m9r-next-${process.pid}-${randomUUID()}.tmp`;
  const displacedPath = `${repair.statePath}.m9r-displaced-${process.pid}-${randomUUID()}.tmp`;
  copyFileSync(repair.statePath, backupPath);
  try {
    writeFileSync(temporaryPath, JSON.stringify(repair.plan.state, null, 2) + "\n", "utf8");
    try {
      renameStateFile(temporaryPath, repair.statePath);
    } catch (error) {
      // Node's Windows rename does not replace an existing file. Move the
      // original only after the rollback copy exists, then install the staged
      // replacement and restore the original if the second move fails.
      if (process.platform !== "win32" || !existsSync(repair.statePath)) throw error;
      renameStateFile(repair.statePath, displacedPath);
      try {
        renameStateFile(temporaryPath, repair.statePath);
        rmSync(displacedPath, { force: true });
      } catch (installError) {
        try { if (!existsSync(repair.statePath) && existsSync(displacedPath)) renameStateFile(displacedPath, repair.statePath); } catch { /* backupPath remains the recovery boundary */ }
        throw installError;
      }
    }
    return backupPath;
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  } finally {
    rmSync(displacedPath, { force: true });
  }
}

function plan(io: NativeIo, selectedAgents?: readonly string[]): PlannedFile[] {
  // Managed-owner mode is deliberately cleanup-only for provider-global
  // configuration. The broker creates a private MCP config for each owned
  // provider process; global hooks, plugins, and MCP entries are a second
  // lifecycle authority and must never be installed again.
  const p = nativePaths(io);
  const files: PlannedFile[] = [];
  const selected = (name: string) => selectedAgents === undefined || selectedAgents.includes(name);
  const add = (entry: PlannedFile) => { if (entry.changed) files.push(entry); };

  if (selected("claude-code")) {
    const settingsBefore = readText(p.settings);
    if (settingsBefore != null) {
      const settings = removeHooks(settingsBefore, p.settings);
      add({ path: p.settings, kind: "hooks-json", before: settingsBefore, after: settings.content, changed: settings.changed, summary: `remove legacy M9R provider hooks from ${p.settings}` });
    }
    const mdBefore = readText(p.claudeMd);
    if (mdBefore != null) {
      const md = removeStandingInstruction(mdBefore);
      add({ path: p.claudeMd, kind: "markdown-block", before: mdBefore, after: md.content, changed: md.changed, summary: `remove the legacy M9R standing-instruction block from ${p.claudeMd}` });
    }
    for (const path of [p.claudeMcp, p.claudeGlobalMcp]) {
      const before = readText(path);
      if (before == null) continue;
      const result = removeMcpServerJson(before, MCP_SERVER_NAME, path);
      add({ path, kind: "mcp-json", before, after: result.content, changed: result.changed, summary: `remove the legacy global M9R MCP registration from ${path}` });
    }
  }

  if (selected("codex") && existsSync(p.codex)) {
    const hooksBefore = readText(p.codexHooks);
    if (hooksBefore != null) {
      const hooks = removeHooks(hooksBefore, p.codexHooks);
      add({ path: p.codexHooks, kind: "hooks-json", before: hooksBefore, after: hooks.content, changed: hooks.changed, summary: `remove legacy M9R provider hooks from ${p.codexHooks}` });
    }
    const agentsBefore = readText(p.codexAgents);
    if (agentsBefore != null) {
      const agents = removeStandingInstruction(agentsBefore);
      add({ path: p.codexAgents, kind: "markdown-block", before: agentsBefore, after: agents.content, changed: agents.changed, summary: `remove the legacy M9R standing-instruction block from ${p.codexAgents}` });
    }
    const codexConfigBefore = readText(p.codexConfig);
    if (codexConfigBefore != null) {
      const codexConfig = removeMcpServerToml(codexConfigBefore, MCP_SERVER_NAME);
      add({ path: p.codexConfig, kind: "mcp-toml", before: codexConfigBefore, after: codexConfig.content, changed: codexConfig.changed, summary: `remove the legacy global M9R MCP registration from ${p.codexConfig}` });
    }
  }

  if (selected("opencode")) {
    for (const path of p.opencodeConfigPaths) {
      const before = readText(path);
      if (before == null) continue;
      const layout = openCodeLayoutFor(io, before);
      const after = removeOpenCodeWebMcp(before, layout, true);
      add({ path, kind: "opencode-json", openCodeLayout: layout, before, after, changed: after !== before, summary: `remove the legacy global M9R MCP/plugin registration from ${path}` });
    }
    const pluginBefore = readText(p.opencodePlugin);
    const priorManifest = readManifest(p.manifest);
    const priorPlugin = priorManifest?.entries.find((entry) => entry.path === p.opencodePlugin);
    const ownership = priorPlugin ? { ownedPath: priorPlugin.path, ownedHash: priorPlugin.sha256After } : null;
    const currentHash = pluginBefore == null ? null : sha256(pluginBefore);
    const owned = ownership?.ownedPath === p.opencodePlugin && ownership.ownedHash === currentHash;
    if (pluginBefore != null && owned) {
      files.push({ path: p.opencodePlugin, kind: "opencode-plugin", before: pluginBefore, after: "", changed: true, removeFile: true, summary: `remove the M9R-owned OpenCode identity plugin at ${p.opencodePlugin}` });
    }
  }
  return files;
}

function readManifest(path: string): Manifest | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as Manifest; } catch { return null; }
}

function activeRuntimeFromIdentity(io: NativeIo, runtimeRoot: string, identity: RuntimeBuildIdentity): ActiveRuntimeManifest | null {
  if (identity.status !== "verified" || !identity.buildId || !identity.sourceCommit || identity.sourceDirty === undefined) return null;
  const sourceRoot = io.env.M9R_PROJECT_ROOT?.trim();
  return {
    schemaVersion: 1,
    buildId: identity.buildId,
    sourceCommit: identity.sourceCommit,
    sourceDirty: identity.sourceDirty,
    installedRoot: runtimeRoot,
    stateRoot: nativePaths(io).m9r,
    installedAt: new Date().toISOString(),
    ...(sourceRoot ? { sourceRoot } : {}),
  };
}

function sameActiveRuntime(left: ActiveRuntimeManifest | undefined, right: ActiveRuntimeManifest | null): boolean {
  if (!left || !right) return false;
  return left.schemaVersion === right.schemaVersion
    && left.buildId === right.buildId
    && left.sourceCommit === right.sourceCommit
    && left.sourceDirty === right.sourceDirty
    && left.installedRoot === right.installedRoot
    && left.stateRoot === right.stateRoot;
}

function installedEnginePath(io: NativeIo, runtime: ReturnType<typeof runtimePlan>): string {
  return runtime.engine?.to ?? join(runtime.targetDir, process.platform === "win32" ? "m9r-engine.exe" : "m9r-engine");
}

async function ask(io: NativeIo, yes: boolean, question: string): Promise<boolean> {
  if (yes) return true;
  if (!io.confirm) { io.err("No terminal to ask on. Run again with --yes to proceed."); return false; }
  return io.confirm(question);
}

export async function runSetup(io: NativeIo, flags: { yes?: boolean; dryRun?: boolean; autostart?: boolean; agents?: readonly string[]; identityOnly?: boolean }): Promise<number> {
  let files: PlannedFile[];
  try { files = plan(io, flags.agents); } catch (error) {
    if (error instanceof UnparseableConfigError) { io.err(error.message); io.err("Nothing was changed."); return 1; }
    throw error;
  }
  const p = nativePaths(io);
  const modelRepair = planNativeOpenCodeModelRepair(io, flags.agents, !flags.identityOnly);
  const todo = files.filter((f) => f.changed);
  const runtime = runtimePlan(io);
  const manifestBefore = readManifest(p.manifest);
  const installedEngine = installedEnginePath(io, runtime);
  const runtimeReconcileEnabled = !!runtime.engine;
  const obsoleteRuntime = runtimeReconcileEnabled
    ? obsoleteOwnedRuntimeEntries(manifestBefore, runtime, io)
    : { removeTargets: [], preservedEntries: manifestBefore?.runtimeFiles ?? [], staleEntries: [] };
  const installedIdentity = existsSync(installedEngine) ? readRuntimeBuildIdentity(installedEngine) : null;
  const activeRuntime = installedIdentity ? activeRuntimeFromIdentity(io, runtime.targetDir, installedIdentity) : null;
  // An installed runtime must remain verifiable. An unreadable or mismatched
  // image is never treated as converged or silently overwritten by setup.
  if (manifestBefore?.activeRuntime && existsSync(installedEngine) && !activeRuntime && !runtime.needed) {
    io.err(`The installed M9R runtime identity could not be verified (${installedIdentity?.reason ?? "unknown"}); refusing to claim setup is current.`);
    io.err("Repair the runtime from a verified package before retrying setup.");
    return 1;
  }
  const identityNeedsReconcile = !!activeRuntime && !sameActiveRuntime(manifestBefore?.activeRuntime, activeRuntime);

  io.out("M9R setup (local mode: no account, no network)");
  // Startup belongs to the broker-owned runtime, never to a provider hook.
  const startupRequested = flags.autostart === true && !!runtime.engine && process.platform === "win32";
  const canAutostart = !!runtime.engine && process.platform === "win32";
  if (todo.length === 0 && !runtime.needed && !startupRequested && !identityNeedsReconcile && modelRepair?.plan.status !== "updated" && obsoleteRuntime.staleEntries.length === 0) { io.out("Already set up. Nothing to change."); printOpenSteps(io); return 0; }
  io.out("This will:");
  if (startupRequested) io.out("  - start the M9R desktop pill when this Windows user signs in (uninstall removes this entry)");
  if (flags.autostart === true && canAutostart) io.out("  - install the M9R-owned broker login task so provider processes start before the first pill message");
  if (runtime.needed) io.out(`  - install the verified M9R engine, overlay, broker, and native desktop runtime at ${runtime.targetDir}`);
  if (identityNeedsReconcile) io.out(`  - reconcile the verified installed runtime identity in ${p.manifest}`);
  if (obsoleteRuntime.staleEntries.length > 0) io.out(`  - remove ${obsoleteRuntime.staleEntries.length} obsolete M9R-owned runtime file(s) as part of the same verified runtime transaction`);
  for (const f of todo) io.out(`  - ${f.summary}`);
  if (modelRepair?.plan.status === "updated") io.out(`  - repair stale OpenCode model references in ${modelRepair.statePath} using the cached provider catalog (a rollback copy will be retained)`);
  if (modelRepair?.plan.status === "blocked") io.out(`  [WAIT] OpenCode model state was not changed: ${modelRepair.plan.reason}`);
  if (todo.some((f) => f.before != null)) io.out(`  - back up each existing file to ${p.backups} first`);
  io.out("Undo anytime with: m9r-cli uninstall");
  if (flags.dryRun) { io.out("Dry run: nothing was written."); return 0; }
  if (!(await ask(io, !!flags.yes, "Go ahead?"))) { io.out("Nothing was changed."); return 1; }
  // Starting with Windows is its own, optional yes: nothing about it is implied by the rest.
  const wantAutostart = canAutostart && (flags.autostart === true || (flags.autostart === undefined && !flags.yes && !!io.confirm && (await io.confirm("Also start M9R when you sign in to Windows, so it is ready before your first prompt? (Uninstall turns this off.)"))));
  let brokerAutostartInstalled = false;
  if (wantAutostart) {
    io.out("  - install the M9R-owned broker login task so provider processes start before the first pill message");
    if (!io.installLocalBrokerAutostart) {
      io.err("The packaged CLI cannot install the M9R-owned broker login task; rebuild or reinstall the packaged CLI before enabling desktop autostart.");
      io.err("Nothing was changed.");
      return 1;
    }
    const broker = await io.installLocalBrokerAutostart();
    if (!broker.ok) {
      io.err(`Could not install the M9R-owned broker login task: ${broker.message}`);
      io.err("Nothing was changed.");
      return 1;
    }
    brokerAutostartInstalled = true;
    io.out(`[PASS] ${broker.message}`);
  }

  mkdirSync(p.backups, { recursive: true });
  const manifest: Manifest = manifestBefore ?? { version: 1, installedAt: new Date().toISOString(), entries: [] };
  if (runtime.needed || obsoleteRuntime.staleEntries.length > 0) {
    if (runtime.engine) await stopResidentEngine(io);
    manifest.runtimeFiles = [...new Set(copyRuntime(runtime, manifest.runtimeFiles ?? [], io, runtimeReconcileEnabled))];
    if (obsoleteRuntime.staleEntries.length > 0) io.out(`[PASS] Reconciled the owned runtime list and removed ${obsoleteRuntime.removeTargets.length} obsolete runtime file(s).`);
  }
  if (modelRepair?.plan.status === "updated") {
    const backupPath = applyNativeOpenCodeModelRepair(modelRepair);
    if (backupPath) io.out(`[PASS] OpenCode model selection repaired using the cached provider catalog; rollback kept at ${backupPath}`);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const f of todo) {
    const existing = manifest.entries.find((e) => e.path === f.path);
    let entry: ManifestEntry & { kind: Kind; openCodeLayout?: WebOpenCodeLayout };
    if (existing) {
      entry = { ...existing, sha256After: sha256(f.after), ...(f.openCodeLayout ? { openCodeLayout: f.openCodeLayout } : {}) };
      manifest.entries = manifest.entries.filter((e) => e.path !== f.path);
    } else {
      let backupPath: string | null = null;
      if (f.before != null) { backupPath = join(p.backups, `${stamp}-${basename(f.path)}`); copyFileSync(f.path, backupPath); }
      entry = { path: f.path, kind: f.kind, existedBefore: f.before != null, backupPath, sha256After: sha256(f.after), ...(f.openCodeLayout ? { openCodeLayout: f.openCodeLayout } : {}) };
    }
    mkdirSync(dirname(f.path), { recursive: true });
    if (f.removeFile) {
      rmSync(f.path, { force: true });
    } else {
      writeFileSync(f.path, f.after, "utf8");
    }
    manifest.entries.push(entry);
  }
  if (wantAutostart && runtime.engine) {
    // The overlay is the user-facing launcher. The broker scheduled task owns
    // provider processes; no headless hook/feed process is registered here.
    const overlayExe = join(dirname(runtime.engine.to), "m9r-overlay.exe");
    const command = existsSync(overlayExe) ? `"${overlayExe}"` : `"${runtime.engine.to}"`;
    manifest.autostart = autostartOf(io).enable(command);
    io.out(manifest.autostart ? "M9R will start when you sign in to Windows." : "Could not turn on starting with Windows; M9R still starts itself when an agent first needs it.");
  }
  if (brokerAutostartInstalled) manifest.brokerAutostart = true;
  const verifiedInstalledIdentity = existsSync(installedEngine) ? readRuntimeBuildIdentity(installedEngine) : null;
  const verifiedActiveRuntime = verifiedInstalledIdentity ? activeRuntimeFromIdentity(io, runtime.targetDir, verifiedInstalledIdentity) : null;
  if (verifiedActiveRuntime) {
    // Write the record only after the image and companion transaction has
    // completed. The manifest therefore cannot point at a build that was only
    // staged or was replaced by a partial copy.
    manifest.activeRuntime = verifiedActiveRuntime;
  } else if (manifest.activeRuntime && (runtime.needed || identityNeedsReconcile)) {
    io.err(`The installed runtime could not be verified after setup (${verifiedInstalledIdentity?.reason ?? "missing build manifest"}); no active-runtime claim was written.`);
    return 1;
  }
  writeFileSync(p.manifest, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  createLocalStore(p.m9r); // make sure the local store folder exists
  // Runtime startup is owned by the installer/scheduled broker task. Setup
  // never starts a second feed or hook process.
  io.out("Done.");
  printOpenSteps(io);
  return 0;
}

function printOpenSteps(io: NativeIo): void {
  io.out("Still yours to do:");
  const hasKnownEndpoint = createLocalStore(nativePaths(io).m9r).listEndpoints().length > 0;
  for (const s of USER_STEPS.filter((x) => x.id !== "install" && (x.id !== "new-session" || !hasKnownEndpoint))) io.out(`  - ${s.title}${s.fix ? `: ${s.fix}` : ""}`);
}

export async function runUninstall(io: NativeIo, flags: { yes?: boolean; purge?: boolean }): Promise<number> {
  const p = nativePaths(io);
  const manifest = readManifest(p.manifest);
  if (!manifest || manifest.entries.length === 0) { io.out("Nothing to uninstall: M9R has not set anything up here."); return 0; }
  io.out("M9R uninstall will:");
  for (const e of manifest.entries) io.out(`  - ${e.existedBefore ? "restore or clean" : "remove"} ${e.path}`);
  if (flags.purge) io.out(`  - delete the local M9R data in ${p.m9r}`);
  if (!(await ask(io, !!flags.yes, "Go ahead?"))) { io.out("Nothing was changed."); return 1; }

  if (manifest.brokerAutostart) {
    if (!io.removeLocalBrokerAutostart) {
      io.err("This install owns an M9R broker login task, but this CLI cannot safely remove it. Reinstall the packaged CLI before uninstalling.");
      return 1;
    }
    const broker = await io.removeLocalBrokerAutostart();
    if (!broker.ok) {
      io.err(`Could not remove the M9R-owned broker login task: ${broker.message}`);
      return 1;
    }
    io.out(`[PASS] ${broker.message}`);
  }

  for (const e of manifest.entries) {
    const current = readText(e.path);
    const decision = decideUninstall(e, current);
    if (decision.action === "restore_backup" && existsSync(decision.backupPath)) {
      writeFileSync(e.path, readFileSync(decision.backupPath, "utf8"), "utf8");
      io.out(`Restored ${e.path} exactly as it was.`);
    } else if (decision.action === "delete_file") {
      rmSync(e.path, { force: true });
      io.out(`Removed ${e.path} (M9R had created it).`);
    } else if (decision.action === "restore_backup" || decision.action === "remove_our_entries") {
      if (current == null) continue;
      if (e.kind === "opencode-plugin" && decision.action === "remove_our_entries") {
        io.out(`Preserved user-edited OpenCode plugin ${e.path}.`);
        continue;
      }
      const result = e.kind === "hooks-json" ? removeHooks(current, e.path)
        : e.kind === "mcp-json" ? removeMcpServerJson(current, MCP_SERVER_NAME, e.path)
        : e.kind === "mcp-toml" ? removeMcpServerToml(current, MCP_SERVER_NAME)
        : e.kind === "opencode-json" ? { content: removeOpenCodeWebMcp(current, e.openCodeLayout ?? openCodeLayoutFor(io, current)), changed: true }
        : removeStandingInstruction(current);
      if (result.changed) writeFileSync(e.path, result.content, "utf8");
      io.out(`Removed M9R's entries from ${e.path}; your own edits were kept.`);
    }
  }
  // Only what this install turned on: a scratch install's uninstall must never switch off the real one.
  if (manifest.autostart) autostartOf(io).disable();
  if ((manifest.runtimeFiles ?? []).length > 0) await stopResidentEngine(io);
  // The standalone installer records the broker separately so it can preserve a broker that a user changed after
  // installation. The engine copied that companion during setup, but must leave it for the installer-owned manifest
  // to verify and remove; a direct engine-only install has no separate record and still removes it normally.
  const managedWebBroker = existsSync(join(p.m9r, "web-broker-install.json"));
  for (const f of manifest.runtimeFiles ?? []) {
    if (managedWebBroker && basename(f).toLowerCase() === "m9r-web-broker.exe") continue;
    rmSync(f, { force: true });
  }
  try { rmdirSync(join(p.m9r, "bin")); } catch { /* not empty or already gone: leave it */ }
  rmSync(p.manifest, { force: true });
  if (flags.purge) rmSync(p.m9r, { recursive: true, force: true });
  io.out("Done. M9R has removed everything it added.");
  return 0;
}

export async function runSend(io: NativeIo, input: { to: string; text: string; from?: string; key?: string; session?: string }): Promise<number> {
  const to = input.to.replace(/^@/, "").toLowerCase();
  if (!to || !input.text.trim()) { io.err("Usage: m9r-cli send @<agent> \"<message>\" [--from <name>]"); return 1; }
  if (input.session?.trim()) {
    io.err("Provider session targeting has been retired. Send through the M9R-owned broker without --session.");
    return 1;
  }
  const store = createLocalStore(nativePaths(io).m9r);
  // Typed by a person only with a real terminal and no agent markers; an agent running this command is agent-initiated.
  const human = isHumanContext({ hasTerminal: !!io.confirm, env: io.env });
  const workingDirectory = io.env.M9R_PROJECT_ROOT?.trim() || io.cwd || process.cwd();
  const storeRoot = normCwd(nativePaths(io).m9r);
  const normalizedWorkingDirectory = normCwd(workingDirectory);
  // M9R's installed executables live under ~/.m9r/bin. A sign-in shortcut can
  // also inherit Windows\System32 when the shell did not provide a project.
  // Neither location is a user's project and neither may pin delivery to a
  // nonexistent Codex session.
  let taskCwd = isWindowsSystemCwd(workingDirectory)
    || normalizedWorkingDirectory === storeRoot || normalizedWorkingDirectory.startsWith(`${storeRoot}/`)
    ? undefined
    : workingDirectory;
  if (!taskCwd) {
    // A sign-in-launched pill inherits the install folder, not a project.
    // Recover only the owner's saved broker project, never another agent's cwd.
    try {
      const configured = JSON.parse(readFileSync(join(nativePaths(io).m9r, "broker-autostart.json"), "utf8").replace(/^\uFEFF/, "")) as { projectRoot?: unknown };
      if (typeof configured.projectRoot === "string" && configured.projectRoot.trim()
        && normCwd(configured.projectRoot) !== storeRoot
        && !normCwd(configured.projectRoot).startsWith(`${storeRoot}/`)
        && !isWindowsSystemCwd(configured.projectRoot)) taskCwd = configured.projectRoot;
    } catch { /* no owner-configured project: keep the existing unscoped route */ }
  }
  const { task, created } = store.addTask({ from: input.from ?? (human ? "you" : "agent"), to: handleForProvider(to), goal: input.text, origin: human ? "human_typed" : "agent_initiated", ...(taskCwd ? { cwd: taskCwd } : {}), idempotencyKey: input.key ?? randomUUID() });
  if (task.approval === "pending") {
    io.out(`Task ${task.id} to @${task.to} is waiting for the user's approval; nothing was delivered.`);
    io.out(`Tell the user to run: m9r-cli approve ${task.id}${isProtectedAction(task.goal) ? "  (it looks like a protected action, so a standing rule would not cover it)" : ""}`);
    return 0;
  }
  // A deferred row is the explicit hand-off to the provider-neutral resident
  // pump. It is written at task creation time, so enabling a new adapter can
  // never resurrect an older task that predates that hand-off.
  if (created && canQueue(task)) {
    store.setDelivery(task.id, { state: "deferred" });
  }
  const ownerTask = created && task.origin === "human_typed" && task.from === "you";
  const ownerPipe = ownerTask ? ownerPipePath(nativePaths(io).m9r) : undefined;
  // `existsSync` does not reliably report a Windows named pipe. Probe the
  // authenticated owner-only read route when the path is not visible, but
  // keep the probe short so a standalone CLI remains responsive without a
  // running M9R broker.
  const ownerPipeReady = ownerPipe
    ? process.platform !== "win32" && existsSync(ownerPipe)
      || (await requestOwnerPipe(ownerPipe, { method: "GET", path: "/web/aware/members" }, 250)) !== null
    : false;
  // The owner-launched broker owns the Cua surface.  Ask it to show the
  // recipient's logical cursor immediately after a human task is accepted;
  // this is fire-and-forget so task delivery never waits on a visual overlay.
  // The owner-pipe endpoint accepts only owner-originated human tasks and
  // performs no desktop focus or physical-pointer operation.
  if (created && task.origin === "human_typed" && task.from === "you") {
    // `existsSync` is a cheap no-op for the normal CLI/test path when the
    // broker is not running; do not leave a five-second named-pipe probe
    // behind every standalone send.
    if (ownerPipeReady && ownerPipe) void requestOwnerPipe(ownerPipe, {
      method: "POST", path: "/web/stage/prime-cursor-owner", body: { taskId: task.id },
    }, 5_000);
  }
  // Once the M9R owner broker is running, an owner task must enter the
  // managed provider connection directly. Do not let the compatibility pump
  // or a provider inbox become the normal path again: that is the old
  // provider-owned STDIO model this cutover replaces. An explicit --session
  // remains a compatibility escape hatch for an already provider-owned
  // session; normal owner sends intentionally have no session selector.
  if (ownerTask && ownerPipeReady && ownerPipe) {
    const result = await requestOwnerPipe<{ ok?: unknown; sessionId?: unknown; error?: unknown }>(ownerPipe, {
      method: "POST", path: "/web/provider-delivery", body: { taskId: task.id },
    }, 70_000);
    if (!result) {
      io.err(`M9R owner delivery did not answer for task ${task.id}; the task was not sent through a provider inbox fallback.`);
      return 1;
    }
    if (result.ok !== true) {
      const reason = typeof result.error === "string" && result.error.trim() ? result.error : "the managed provider owner rejected delivery";
      io.err(`M9R owner delivery rejected task ${task.id}: ${reason}`);
      return 1;
    }
    io.out(`Sent to @${task.to} as task ${task.id}; M9R owner accepted it on the managed provider connection.`);
    return 0;
  }
  if (ownerTask) {
    io.err(`M9R owner broker is not available for task ${task.id}; the task remains recorded but was not sent through a provider hook or provider session.`);
    return 1;
  }
  io.out(`${created ? "Sent" : "Already sent"} to @${task.to} as task ${task.id}. It appears at that agent's next prompt.`);
  return 0;
}

type DesktopPillOwnerResponse = { ok: boolean; error?: string };

async function runDesktopPillOwnerRequest(io: NativeIo, path: string, body: Record<string, unknown>, label: string): Promise<number> {
  const result = await requestOwnerPipe<DesktopPillOwnerResponse>(ownerPipePath(nativePaths(io).m9r), {
    method: "POST", path, body,
  }, 15_000);
  if (!result) {
    io.err(`The M9R owner broker did not answer the desktop pill ${label}; no browser or inbox fallback was used.`);
    return 1;
  }
  if (result.ok !== true) {
    io.err(typeof result.error === "string" && result.error.trim() ? result.error : `The M9R owner broker rejected the desktop pill ${label}.`);
    return 1;
  }
  io.out(`Desktop pill ${label} accepted by the M9R owner broker.`);
  return 0;
}

/** Route a desktop-pill message directly to the owner broker's UI bridge. */
export function runPillSend(io: NativeIo, text: string): Promise<number> {
  const message = text.trim();
  if (!message) { io.err("The desktop pill message is empty."); return Promise.resolve(1); }
  // Keep retries idempotent at the owner boundary. The id is transport-only;
  // it is never rendered, added to an M9R task, or sent to the provider.
  return runDesktopPillOwnerRequest(io, "/web/ui/command", { text: message, context: {}, requestId: randomUUID() }, "message");
}

export function runPillDecision(io: NativeIo, approvalId: string, decision: string): Promise<number> {
  if (!approvalId || !["allow", "deny"].includes(decision)) {
    io.err("The desktop pill decision must be allow or deny.");
    return Promise.resolve(1);
  }
  return runDesktopPillOwnerRequest(io, decision === "allow" ? "/web/ui/approve" : "/web/ui/deny", { id: approvalId }, "approval decision");
}

export function runPillNote(io: NativeIo, text: string): Promise<number> {
  const note = text.trim();
  if (!note) { io.err("The desktop pill note is empty."); return Promise.resolve(1); }
  return runDesktopPillOwnerRequest(io, "/web/ui/save-note", { text: note }, "memory note");
}

/** Route a live provider model choice through the authenticated owner broker. */
export function runPillModel(io: NativeIo, handle: string, model?: string, effort?: string): Promise<number> {
  const normalizedHandle = handle?.replace(/^@/, "").trim().toLowerCase();
  if (!/^[a-z][a-z0-9_.-]{0,39}$/.test(normalizedHandle)) {
    io.err("Usage: m9r-cli pill-model @agent <provider-reported-model> [effort]");
    return Promise.resolve(1);
  }
  if (model !== undefined && (!model.trim() || model.length > 160)) {
    io.err("The model must be a non-empty provider-reported ID.");
    return Promise.resolve(1);
  }
  if (effort !== undefined && (!effort.trim() || effort.length > 160)) {
    io.err("The effort must be a non-empty provider-reported ID.");
    return Promise.resolve(1);
  }
  return runDesktopPillOwnerRequest(io, "/web/ui/model", {
    handle: normalizedHandle,
    ...(model === undefined ? {} : { model: model.trim() }),
    ...(effort === undefined ? {} : { effort: effort.trim() }),
  }, "model selection");
}

export interface StatusRow { id: string; state: "ok" | "todo" | "info"; label: string; fix?: string }

/** Live checklist rows for `doctor`: what is in place, what is still open, with the exact fix beside each. */
export function nativeStatus(io: NativeIo): StatusRow[] {
  const p = nativePaths(io);
  const rows: StatusRow[] = [];
  rows.push({ id: "provider-owner", state: "ok", label: "M9R broker owns provider processes; provider hooks and global MCP integrations are disabled" });
  rows.push({ id: "legacy-provider-path", state: "ok", label: "Legacy provider hook/session path is not installed" });
  const store = createLocalStore(p.m9r);
  const endpoints = store.listEndpoints();
  rows.push({ id: "endpoints", state: "info", label: endpoints.length ? `Agents seen on this machine: ${endpoints.map((e) => `@${e.handle}`).join(", ")}` : "No agent sessions seen yet. Start a new Claude Code session." });
  const statusNow = Date.now();
  rows.push({ id: "target-identities", state: "info", label: "Provider-owned session identities are not used; broker connections are created and supervised directly" });
  const inboxCutoff = statusNow - inboxMaxAgeMs();
  const pending = endpoints.reduce((n, e) => n + store.tasksFor(e.handle).filter((t) => {
    const createdAt = Date.parse(t.createdAt);
    return t.approval !== "denied" && t.approval !== "expired"
      && t.receipt?.state !== "canceled"
      && t.receipt?.state !== "paused"
      && !t.resultSummary
      && t.delivery?.state !== "queued" && t.delivery?.state !== "done"
      && Number.isFinite(createdAt) && createdAt <= statusNow && createdAt >= inboxCutoff
      && store.cursorFor(e.handle) < t.seq;
  }).length, 0);
  if (pending > 0) rows.push({ id: "pending", state: "info", label: `${pending} task(s) waiting in inboxes` });
  return rows;
}

export function printNativeStatus(io: NativeIo): void {
  io.out("Native front door (local mode)");
  const rows = nativeStatus(io);
  for (const r of rows) io.out(`[${r.state === "ok" ? "PASS" : r.state === "todo" ? "TODO" : "INFO"}] ${r.label}${r.fix ? `  ->  ${r.fix}` : ""}`);
  const hasKnownEndpoint = rows.some((row) => row.id === "endpoints" && row.label.startsWith("Agents seen on this machine:"));
  for (const s of USER_STEPS.filter((x) => (x.id === "new-session" && !hasKnownEndpoint) || x.id === "codex-trust")) io.out(`[YOU ] ${s.title}${s.fix ? `  ->  ${s.fix}` : ""}`);
}

/**
 * Saves a fact or decision to the shared project memory that every agent reads at session start (the same store `m9r_note`
 * writes). The room is the folder the broker was set up for, so a note saved from the desktop pill lands where the agents look.
 */
export async function runNote(io: NativeIo, text: string): Promise<number> {
  const note = text.trim();
  if (!note) { io.err("Say what to remember: m9r note \"the staging URL is ...\""); return 1; }
  if (note.length > 2_000) { io.err("That note is too long (2000 characters at most)."); return 1; }
  const root = nativePaths(io).m9r;
  let folder = io.env.M9R_PROJECT_ROOT?.trim();
  if (!folder) {
    try { folder = (JSON.parse(readFileSync(join(root, "broker-autostart.json"), "utf8").replace(/^﻿/, "")) as { projectRoot?: string }).projectRoot; } catch { /* no marker: fall back to the folder the command ran in */ }
  }
  const result = createPageNotesStore(root).append({ room: projectRoomId(folder || io.cwd || process.cwd()), agent: "you", text: note, source: "agent" });
  if (!result.ok) { io.err(result.error); return 1; }
  const sent = await pushCloudNote(root, note);
  io.out(sent.ok ? "Saved to shared memory and to your team's dashboard." : loadCloudConfig(root) ? `Saved here. The dashboard copy did not go through: ${sent.error}.` : "Saved to shared memory.");
  return 0;
}

/** `m9r cloud connect <token> [--url ...]`, `m9r cloud status`, `m9r cloud sync`, `m9r cloud disconnect`. */
export async function runCloud(io: NativeIo, positionals: string[], urlFlag?: string): Promise<number> {
  const root = nativePaths(io).m9r;
  const action = positionals[0] ?? "status";
  if (action === "connect") {
    const token = positionals[1]?.trim();
    const url = (urlFlag ?? DEFAULT_CLOUD_URL).replace(/\/+$/, "");
    if (!token) { io.err("Create a token in M9R under Settings > API tokens, then run: m9r cloud connect <token>"); return 1; }
    const problem = cloudUrlProblem(url);
    if (problem) { io.err(problem); return 1; }
    saveCloudConfig(root, { url, token });
    const pulled = await pullCloudNotes(root);
    if (!pulled.ok) { clearCloudConfig(root); io.err(`Could not connect: ${pulled.error}. Nothing was saved.`); return 1; }
    io.out(`Connected to ${url}. ${pulled.count} team note${pulled.count === 1 ? "" : "s"} will be shown to your agents.`);
    return 0;
  }
  if (action === "sync") {
    const pulled = await pullCloudNotes(root);
    io.out(pulled.ok ? `Synced ${pulled.count} team note${pulled.count === 1 ? "" : "s"}.` : `Could not sync: ${pulled.error}.`);
    return pulled.ok ? 0 : 1;
  }
  if (action === "disconnect") { clearCloudConfig(root); io.out("Disconnected. Local memory is unchanged."); return 0; }
  const config = loadCloudConfig(root);
  io.out(config ? `Connected to ${config.url}.` : "Not connected. Create a token in M9R under Settings > API tokens, then run: m9r cloud connect <token>");
  return 0;
}

/** Argument handling for the four commands, kept here so the big CLI core only forwards `rest`. */
export async function runNativeCommand(command: string, rest: string[], io: NativeIo): Promise<number> {
  const has = (...names: string[]) => rest.some((a) => names.includes(a));
  const value = (name: string) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i += 1) { if (rest[i].startsWith("-")) { if (["--from", "--key", "--for", "--session"].includes(rest[i])) i += 1; continue; } positionals.push(rest[i]); }
  if (command === "setup") {
    if (has("--status")) { printNativeStatus(io); return 0; }
    return runSetup(io, {
      yes: has("--yes", "-y"),
      dryRun: has("--dry-run"),
      autostart: has("--autostart") ? true : undefined,
      agents: value("--agents")?.split(",").map((agent) => agent.trim()).filter(Boolean),
      identityOnly: has("--identity-only"),
    });
  }
  if (command === "update") {
    if (positionals[0] !== "check") {
      io.err("Usage: m9r-cli update check");
      return 1;
    }
    const configPath = io.env.M9R_UPDATE_CONFIG?.trim() || join(nativePaths(io).m9r, "update-config.json");
    let config: ReturnType<typeof parseUpdateConfig>;
    try {
      config = parseUpdateConfig(JSON.parse(readFileSync(configPath, "utf8")) as unknown);
    } catch (error) {
      io.err(`M9R update metadata is not configured or is invalid (${error instanceof Error ? error.message : "unknown error"}).`);
      return 1;
    }
    const currentVersion = io.env.M9R_RUNTIME_VERSION?.trim() || config.currentVersion;
    const result = await checkEngineUpdate({ currentVersion, source: config.source });
    io.out(JSON.stringify({
      phase: result.state.phase,
      currentVersion: result.state.currentVersion,
      availableVersion: result.state.availableVersion,
      checkedAt: result.state.checkedAt,
      error: result.state.error,
    }));
    return result.state.phase === "failed" ? 1 : 0;
  }
  if (command === "uninstall") return runUninstall(io, { yes: has("--yes", "-y"), purge: has("--purge") });
  if (command === "note") return runNote(io, positionals.join(" "));
  if (command === "cloud") return runCloud(io, positionals, value("--url"));
  if (command === "send") return runSend(io, { to: positionals[0] ?? "", text: positionals.slice(1).join(" "), from: value("--from"), key: value("--key"), session: value("--session") });
  if (command === "pill-send") return runPillSend(io, rest.join(" "));
  if (command === "pill-decide") return runPillDecision(io, rest[0] ?? "", rest[1] ?? "");
  if (command === "pill-note") return runPillNote(io, rest.join(" "));
  if (command === "pill-model") return runPillModel(io, positionals[0] ?? "", positionals[1], positionals[2]);
  const root = nativePaths(io).m9r;
  if (command === "feed") {
    if (has("--serve-hooks")) {
      io.err("The legacy provider hook server has been removed. Start the M9R-owned web broker instead.");
      return 1;
    }
    const controller = new AbortController();
    const release = has("--watch") ? acquireFeedLock(root) : () => {};
    if (!release) { io.out("The feed is already being written by another M9R process."); return 0; }
    const watching = has("--watch");
    let freshnessTimer: ReturnType<typeof setInterval> | undefined;
    try {
      if (watching) {
        process.once("SIGINT", () => controller.abort());
        process.once("SIGTERM", () => controller.abort());
        io.out(`Writing ${feedPath(root)} (Ctrl+C to stop)`);

        // A runtime update replaces the adjacent manifest atomically. A feed
        // process that keeps its old executable mapped would otherwise keep
        // serving stale hooks forever while the new files sit unused. Abort
        // through runFeed's normal drain path when the generation changes;
        // the overlay supervisor or the next hook then starts the current
        // image. The marker read is cheap and does not re-hash the executable.
        const buildIdAtStart = readRuntimeBuildId(io.executablePath ?? process.execPath);
        if (buildIdAtStart) {
          let reported = false;
          freshnessTimer = setInterval(() => {
            if (reported) return;
            const currentBuildId = readRuntimeBuildId(io.executablePath ?? process.execPath);
            if (currentBuildId === buildIdAtStart) return;
            reported = true;
            io.err("M9R runtime generation changed on disk; draining the feed before the current runtime takes over.");
            controller.abort();
          }, 2_000);
          freshnessTimer.unref?.();
        }
      }
      // The feed is view-only. Provider lifecycle and delivery belong solely
      // to the broker-owned provider supervisor.
      await runFeed({ root, watch: watching, signal: controller.signal, onWrite: watching ? (f) => io.out(`feed #${f.seq}: ${f.needsYou.length} need you`) : undefined });
      if (!watching) io.out(`Wrote ${feedPath(root)}`);
      return 0;
    } finally {
      if (freshnessTimer) clearInterval(freshnessTimer);
      // A runtime-generation change must never strand the single-writer lock.
      release();
    }
  }
  if (command === "dismiss") { const n = createLocalStore(root).dismiss(positionals.map((p) => p.toUpperCase())); io.out(n ? `Cleared ${n} from the overlay list.` : "Nothing to clear."); return 0; }
  if (command === "tasks") return runTasks(io, root);
  if (command === "sessions") return runSessions(io, root, positionals[0]);
  if (command === "sessions-json") return runSessionsJson(io, root, positionals[0]);
  if (command === "approvals" && positionals[0] === "purge") return runPurgeStaleApprovals(io, root, has("--apply"));
  if (command === "link") return runLink(io, root, value("--from-handle"), value("--from-session"), value("--to-handle"), value("--to-session"));
  if (command === "unlink") return runUnlink(io, root, positionals[0]);
  if (command === "approve" || command === "deny") return runDecision(io, root, command === "approve" ? "approved" : "denied", positionals[0], has("--yes", "-y"));
  if (command === "allow") return runAllow(io, root, positionals[0], positionals[1], value("--for"));
  if (command === "standing") return runRules(io, root);
  if (command === "revoke") return runRevoke(io, root, positionals[0]);
  io.err(`Unknown native command: ${command}`);
  return 1;
}
