/**
 * `m9r-cli setup`, `m9r-cli uninstall`, `m9r-cli send` and the native status block (design sections 8 and 20). File-writing, but
 * every decision about what to write comes from the tested pure cores in `install-core` and `local-store`.
 *
 * Rules: show the plan and ask before writing; compute every new file before writing any (so a bad file stops the
 * whole run with nothing half-done); back up every file that existed; record what was written so uninstall can put it
 * back exactly. Local mode needs no account and no network.
 */
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOOK_MARKER,
  UnparseableConfigError,
  applyStandingInstruction,
  decideUninstall,
  hasOurHooks,
  mergeHooks,
  mergeMcpServerJson,
  mergeMcpServerToml,
  removeHooks,
  removeMcpServerJson,
  removeMcpServerToml,
  removeStandingInstruction,
  sha256,
  standingInstructionStatus,
  type HookSpec,
  type ManifestEntry,
  type McpServerSpec,
} from "./install-core";
import { createLocalStore, defaultStoreRoot, handleForProvider } from "./local-store";
import { inboxMaxAgeMs } from "./inbox-core";
import { CONNECTION_CLAIM_TTL_MS } from "./mcp-connection-core";
import { hasPendingRuntimeTransaction, installRuntimeTransaction, pruneCommittedRuntimeBackups, recoverRuntimeTransactions } from "./runtime-install-transaction";
import { createPageNotesStore } from "./page-notes-store";
import { projectRoomId } from "./project-room";
import { planOpenCodeModelStateRepair, resolveOpenCodeModelFiles, type OpenCodeModelRepairResult } from "./opencode-model-core";
import { refreshManagedOpenCodeIdentityPlugin } from "./opencode-plugin-refresh";
import { renameStateFile } from "./atomic-file";
import { DEFAULT_CLOUD_URL, clearCloudConfig, cloudUrlProblem, loadCloudConfig, pullCloudNotes, pushCloudNote, saveCloudConfig } from "./cloud-memory";
import { codexHome, deliverToCodex, realDeps, spawnDeliveryRunner, type DeliveryDeps } from "./codex-delivery";
import { codexNoteInEffect, createCodexWatcher } from "./codex-watch";
import { hookPipePath, requestShutdown, startHookServer } from "./hook-server";
import { runHookRequest } from "./hook-run";
import { canQueue, isWindowsSystemCwd, normCwd } from "./codex-delivery-core";
import { isHumanContext, isProtectedAction } from "./approval-core";
import { runAllow, runDecision, runLink, runPurgeStaleApprovals, runRevoke, runRules, runSessions, runSessionsJson, runTasks, runUnlink } from "./approval-commands";
import { acquireFeedLock, feedPath, runFeed } from "./feed-writer";
import { USER_STEPS } from "./onboarding-steps";
import { readRuntimeBuildId, readRuntimeBuildIdentity, type RuntimeBuildIdentity } from "./runtime-build-identity";
import { checkEngineUpdate, parseUpdateConfig } from "./update-lifecycle";
import {
  buildOpenCodeIdentityPluginSource,
  OPENCODE_IDENTITY_PLUGIN_FILENAME,
  planOpenCodeIdentityPluginInstall,
  removeOpenCodeWebMcp,
  resolveOpenCodeGlobalPaths,
  resolveOpenCodeHookInvocation,
  webOpenCodeLayout,
  mergeOpenCodeWebMcp,
  type WebOpenCodeLayout,
} from "./web-setup-core";

export interface NativeIo {
  env: Record<string, string | undefined>;
  homeDir: string;
  out(line: string): void;
  err(line: string): void;
  /** Interactive yes/no; absent when there is no terminal, in which case `--yes` is required. */
  confirm?(question: string): Promise<boolean>;
  /** Codex delivery dependencies; tests inject fakes, production uses the real `codex queue`. */
  codexDeps?: DeliveryDeps;
  /** The caller's working folder, used to pick a session. M9R's own install directory is never a project folder. */
  cwd?: string;
  /** Runtime image path; production defaults to the current executable, tests may use an isolated image. */
  executablePath?: string;
  /** Start-with-Windows switch; tests inject a fake so nothing ever touches the real registry. */
  autostart?: Autostart;
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
  /** Bundled runtimes installed by M9R, including retired images retained by still-running agent sessions. */
  runtimeFiles?: string[];
  /** M9R starts when you sign in to Windows (removed on uninstall). */
  autostart?: boolean;
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

/** The tiny hook entry sits next to this module in `cli/dist`; tests and dev can override it. */
export function hookEntryPath(env: Record<string, string | undefined>): string {
  if (env.M9R_HOOK_ENTRY?.trim()) return env.M9R_HOOK_ENTRY.trim();
  return fileURLToPath(new URL("./m9r-hook.js", import.meta.url));
}

/**
 * The hook must not run from where the CLI happens to live: `npx` runs it from a cache that is later cleared, which
 * would silently kill the hooks. Setup copies this small runtime into M9R's own folder and points the hooks there.
 */
export const HOOK_RUNTIME_FILES = ["m9r-hook.js", "local-store.js", "mcp-connection-core.js", "hook-handler.js", "hook-run.js", "inbox-core.js", "mention-core.js", "memory-hint-core.js", "codex-delivery-core.js", "codex-delivery.js", "codex-liveness.js", "approval-core.js", "risk-core.js", "web-broker-client.js", "web-broker-paths.js", "identity-core.js", "hook-server.js"] as const;

function hookSourceDir(env: Record<string, string | undefined>): string {
  return env.M9R_HOOK_SOURCE?.trim() || dirname(hookEntryPath(env));
}

/**
 * The self-contained engine (one executable, no Node needed on the machine): `M9R_ENGINE` names it, or it is the program
 * already running this command. When present, hooks run from a copy of it in M9R's own folder instead of JS files.
 */
export function engineSource(env: Record<string, string | undefined>, execPath = process.execPath): string | null {
  if (env.M9R_ENGINE?.trim()) return env.M9R_ENGINE.trim();
  return /^m9r-engine(\.exe)?$/i.test(basename(execPath)) ? execPath : null;
}

const engineTarget = (io: Pick<NativeIo, "homeDir" | "env">) => join(nativePaths(io).m9r, "bin", process.platform === "win32" ? "m9r-engine.exe" : "m9r-engine");

/** Where the hooks run from: an explicit override (tests, development), the engine copy, or M9R's own stable folder. */
export function activeHookEntry(io: Pick<NativeIo, "env" | "homeDir">): string {
  if (io.env.M9R_HOOK_ENTRY?.trim()) return io.env.M9R_HOOK_ENTRY.trim();
  if (engineSource(io.env)) return engineTarget(io);
  return join(nativePaths(io).m9r, "bin", "m9r-hook.js");
}

const shimName = process.platform === "win32" ? "m9r-hook.exe" : "m9r-hook-native";
const shimTarget = (io: Pick<NativeIo, "homeDir" | "env">) => join(nativePaths(io).m9r, "bin", shimName);

/** The small native hook program that ships next to the engine, when there is one (it answers in milliseconds; see hook-server.ts). */
function shimSource(env: Record<string, string | undefined>): string | null {
  const engine = engineSource(env);
  if (!engine) return null;
  const path = join(dirname(engine), shimName);
  return existsSync(path) ? path : null;
}

/** Stops a running resident engine so its file can be replaced or removed; harmless when none is running. */
async function stopResidentEngine(io: NativeIo): Promise<void> {
  const pipe = hookPipePath(nativePaths(io).m9r);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await requestShutdown(pipe, 1000);
    await new Promise((r) => setTimeout(r, 150));
    // A live listener means shutdown has not completed (or the pill's supervisor restarted it).
    if (!await requestShutdown(pipe, 250)) return;
  }
  throw new Error("The M9R resident engine did not stop. Close the M9R desktop pill before retrying setup.");
}

const sameFile = (a: string, b: string): boolean => {
  try { return statSync(a).size === statSync(b).size && createHash("sha256").update(readFileSync(a)).digest("hex") === createHash("sha256").update(readFileSync(b)).digest("hex"); } catch { return false; }
};

function runtimePlan(io: NativeIo): { needed: boolean; sourceDir: string; targetDir: string; missingSource: string[]; engine?: { from: string; to: string }; shim?: { from: string; to: string }; nativeInputHost?: { from: string; to: string }; companions?: Array<{ from: string; to: string }> } {
  const targetDir = join(nativePaths(io).m9r, "bin");
  const engine = engineSource(io.env);
  if (engine && !io.env.M9R_HOOK_ENTRY?.trim()) {
    const to = engineTarget(io);
    const shimFrom = shimSource(io.env);
    const shim = shimFrom ? { from: shimFrom, to: shimTarget(io) } : undefined;
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
      if (name === "m9r-web-broker.exe" && existsSync(join(nativePaths(io).m9r, "web-broker-install.json"))) continue;
      const source = join(dirname(engine), name);
      if (existsSync(source)) collect(source, join(targetDir, name));
    }
    return { needed: hasPendingRuntimeTransaction(targetDir) || !sameFile(engine, to) || (!!shim && !sameFile(shim.from, shim.to)) || (!!nativeInputHost && !sameFile(nativeInputHost.from, nativeInputHost.to)) || companions.some((file) => !sameFile(file.from, file.to)), sourceDir: dirname(engine), targetDir, missingSource: existsSync(engine) ? [] : [engine], engine: { from: engine, to }, shim, nativeInputHost, companions };
  }
  const sourceDir = hookSourceDir(io.env);
  if (io.env.M9R_HOOK_ENTRY?.trim()) return { needed: false, sourceDir, targetDir, missingSource: [] };
  const missingSource = HOOK_RUNTIME_FILES.filter((f) => !existsSync(join(sourceDir, f)));
  const needed = HOOK_RUNTIME_FILES.some((f) => readText(join(sourceDir, f)) !== readText(join(targetDir, f))) || !existsSync(join(targetDir, "package.json"));
  return { needed, sourceDir, targetDir, missingSource };
}

function replaceRuntimeFile(from: string, to: string): string[] {
  if (sameFile(from, to)) return [];
  const staged = `${to}.m9r-new-${process.pid}-${randomUUID()}`;
  try {
    copyFileSync(from, staged);
    try {
      // Same-directory rename is atomic. On Windows this works even when an agent still has the old image mapped.
      renameSync(staged, to);
      return [];
    } catch (replaceError) {
      if (process.platform !== "win32" || !existsSync(to)) throw replaceError;
      const retired = `${to}.m9r-retired-${Date.now()}-${randomUUID()}`;
      renameSync(to, retired);
      try {
        renameSync(staged, to);
      } catch (installError) {
        try { renameSync(retired, to); } catch { /* keep the old image recoverable if rollback is also blocked */ }
        throw installError;
      }
      // A running MCP server may still be mapped to the renamed image. Keep it tracked until a later setup/uninstall
      // can remove it after the owner closes that agent session.
      try {
        rmSync(retired, { force: true });
        return [];
      } catch {
        return [retired];
      }
    }
  } finally {
    rmSync(staged, { force: true });
  }
}

function pruneRetiredRuntimeFile(target: string): void {
  let names: string[];
  try { names = readdirSync(dirname(target)); } catch { return; }
  const prefix = `${basename(target)}.m9r-retired-`;
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    try { rmSync(join(dirname(target), name), { force: true }); } catch { /* still mapped by an open agent process */ }
  }
}

function isRetiredRuntimePath(path: string): boolean {
  return /\.m9r-retired-[^\\/]+$/i.test(path);
}

function copyRuntime(plan: { sourceDir: string; targetDir: string; engine?: { from: string; to: string }; shim?: { from: string; to: string }; nativeInputHost?: { from: string; to: string }; companions?: Array<{ from: string; to: string }> }): string[] {
  mkdirSync(plan.targetDir, { recursive: true });
  if (plan.engine) {
    recoverRuntimeTransactions(plan.targetDir, replaceRuntimeFile);
    const files = [plan.engine, ...(plan.shim ? [plan.shim] : []), ...(plan.nativeInputHost ? [plan.nativeInputHost] : []), ...(plan.companions ?? [])];
    const written = installRuntimeTransaction(plan.targetDir, files, replaceRuntimeFile);
    for (const file of files) pruneRetiredRuntimeFile(file.to);
    pruneCommittedRuntimeBackups(plan.targetDir);
    return written;
  }
  const written: string[] = [];
  for (const f of HOOK_RUNTIME_FILES) {
    const target = join(plan.targetDir, f);
    pruneRetiredRuntimeFile(target);
    written.push(...replaceRuntimeFile(join(plan.sourceDir, f), target), target);
  }
  // The runtime files are ES modules; this keeps them working wherever the folder lives.
  const pkg = join(plan.targetDir, "package.json");
  writeFileSync(pkg, JSON.stringify({ type: "module", private: true }) + "\n", "utf8");
  written.push(pkg);
  return written;
}

const slash = (p: string) => p.replace(/\\/g, "/");
const readText = (path: string): string | null => (existsSync(path) ? readFileSync(path, "utf8") : null);

function hookSpecs(entry: string, provider = "claude-code", shim?: string): HookSpec[] {
  // The engine's subcommand is spelled "m9r-hook" so the installed command carries the marker that uninstall looks for.
  const command = (event: string) => (shim ? `"${slash(shim)}" ${event} ${provider}` : /m9r-engine(\.exe)?$/i.test(entry) ? `"${slash(entry)}" m9r-hook ${event} ${provider}` : `node "${slash(entry)}" ${event} ${provider}`);
  return [
    { event: "SessionStart", command: command("SessionStart"), timeoutSec: 5 },
    { event: "UserPromptSubmit", command: command("UserPromptSubmit"), timeoutSec: 5 },
    // Every provider: when a turn ends, tell the browser overlay (markDone) and, for Claude, answer any task another
    // agent handed it with its final message.
    { event: "Stop", command: command("Stop"), timeoutSec: 5 },
  ];
}

/** The native hook the settings should point at: only when one ships with the engine and no override is set. */
const shimFor = (io: NativeIo): string | undefined => (!io.env.M9R_HOOK_ENTRY?.trim() && shimSource(io.env) ? shimTarget(io) : undefined);

export const MCP_SERVER_NAME = "m9r";

/**
 * The MCP server registration is engine-mode only for now: without the self-contained engine, running it would need
 * `node m9r-mcp.js` from the copied runtime folder, which has no node_modules of its own (HOOK_RUNTIME_FILES ships
 * plain .js files, not @modelcontextprotocol/sdk/zod) -- a real gap, not silently pretended away. `plan()` below only
 * adds these entries when `activeHookEntry` resolves to the engine binary.
 */
function mcpServerSpec(io: NativeIo, provider: string): McpServerSpec | null {
  const entry = activeHookEntry(io);
  if (!/m9r-engine(\.exe)?$/i.test(entry)) return null;
  const m9r = nativePaths(io).m9r;
  const launcher = shimSource(io.env) ? shimTarget(io) : entry;
  return {
    // A provider must not hold the replaceable engine image as its long-lived
    // MCP parent. The native shim is a stable handoff boundary; it forwards
    // the provider PID and starts the current engine from the installed bin.
    command: slash(launcher),
    args: ["mcp"],
    env: {
      M9R_HOME: m9r,
      M9R_WEB_BROKER_PORT: io.env.M9R_WEB_BROKER_PORT?.trim() || "47821",
      M9R_PROVIDER: provider,
    },
  };
}

function openCodeVersionLine(io: NativeIo): string | undefined {
  const configured = io.env.M9R_OPENCODE_VERSION?.trim();
  if (configured) return configured;
  try {
    const result = spawnSync("opencode", ["--version"], { encoding: "utf8", timeout: 2000, windowsHide: true });
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

function nativeOpenCodeHookInvocation(
  io: NativeIo,
  event: "SessionStart" | "UserPromptSubmit" | "OpenCodePoll" | "OpenCodeDelivered" | "OpenCodeDeliveryFailed" | "OpenCodeExecutionFailed",
): { command: string; args: readonly string[] } {
  const stableShim = shimFor(io) ? shimTarget(io) : null;
  if (stableShim) return { command: stableShim, args: [event, "opencode"] };
  const entry = activeHookEntry(io);
  const name = basename(entry);
  if (/^m9r-engine(?:\.exe)?$/i.test(name)) {
    return resolveOpenCodeHookInvocation({ nodeCommand: process.execPath, engineExecutable: entry, event });
  }
  if (/\.js$/i.test(name)) {
    return resolveOpenCodeHookInvocation({ nodeCommand: process.execPath, compiledHookPath: entry, event });
  }
  // An explicitly supplied native hook is already the per-event entrypoint;
  // do not guess a second subcommand around it.
  return { command: entry, args: [event, "opencode"] };
}

interface ManagedWebSetupPluginRefresh {
  manifestPath: string;
  pluginPath: string;
  desiredContent: string;
}

interface PlannedFile {
  path: string;
  kind: Kind;
  before: string | null;
  after: string;
  changed: boolean;
  summary: string;
  openCodeLayout?: WebOpenCodeLayout;
  managedWebSetupPlugin?: ManagedWebSetupPluginRefresh;
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

function managedWebSetupPluginOwnership(manifestPath: string, pluginPath: string): { ownedPath: string; ownedHash: string } | null {
  const text = readText(manifestPath);
  if (text == null) return null;
  try {
    const record = JSON.parse(text) as { openCodeIdentityPluginPath?: unknown; openCodeIdentityPluginHash?: unknown };
    if (typeof record.openCodeIdentityPluginPath !== "string" || typeof record.openCodeIdentityPluginHash !== "string") return null;
    return { ownedPath: record.openCodeIdentityPluginPath, ownedHash: record.openCodeIdentityPluginHash };
  } catch {
    // A malformed web manifest is not proof of ownership. Preserve the plugin
    // rather than adopting or overwriting an unverified file.
    return null;
  }
}

/** Atomically replace a small managed text/JSON file, including the Windows existing-file case. */
function writeBytesAtomically(path: string, bytes: Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.m9r-next-${process.pid}-${randomUUID()}.tmp`;
  const displacedPath = `${path}.m9r-displaced-${process.pid}-${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, bytes);
  try {
    try {
      renameStateFile(temporaryPath, path);
    } catch (error) {
      if (process.platform !== "win32" || !existsSync(path)) throw error;
      renameStateFile(path, displacedPath);
      try {
        renameStateFile(temporaryPath, path);
        rmSync(displacedPath, { force: true });
      } catch (installError) {
        try { if (!existsSync(path) && existsSync(displacedPath)) renameStateFile(displacedPath, path); } catch { /* keep the displaced copy for manual recovery */ }
        throw installError;
      }
    }
  } finally {
    rmSync(temporaryPath, { force: true });
    rmSync(displacedPath, { force: true });
  }
}

function plan(io: NativeIo, selectedAgents?: readonly string[], includeMcp = true): PlannedFile[] {
  const p = nativePaths(io);
  const wantsClaude = selectedAgents === undefined || selectedAgents.includes("claude-code");
  const wantsCodex = selectedAgents === undefined ? existsSync(p.codex) : selectedAgents.includes("codex");
  const files: PlannedFile[] = [];
  if (wantsClaude) {
    const settingsBefore = readText(p.settings);
    const settings = mergeHooks(settingsBefore, hookSpecs(activeHookEntry(io), "claude-code", shimFor(io)), p.settings);
    const mdBefore = readText(p.claudeMd);
    const md = applyStandingInstruction(mdBefore);
    files.push(
      { path: p.settings, kind: "hooks-json", before: settingsBefore, after: settings.content, changed: settings.changed, summary: `add 3 hooks (session start, prompt submit, turn end) to ${p.settings}` },
      { path: p.claudeMd, kind: "markdown-block", before: mdBefore, after: md.content, changed: md.changed, summary: `${mdBefore == null ? "create" : "add a short block to"} ${p.claudeMd}` },
    );
  }
  const claudeMcpSpec = includeMcp ? mcpServerSpec(io, "claude-code") : null;
  if (claudeMcpSpec && wantsClaude) {
    const claudeMcpBefore = readText(p.claudeMcp);
    const claudeMcp = mergeMcpServerJson(claudeMcpBefore, MCP_SERVER_NAME, claudeMcpSpec, p.claudeMcp);
    files.push({ path: p.claudeMcp, kind: "mcp-json", before: claudeMcpBefore, after: claudeMcp.content, changed: claudeMcp.changed, summary: `register the M9R MCP server (whoami/agents/send/inbox/result) in ${p.claudeMcp}` });
    const claudeGlobalBefore = readText(p.claudeGlobalMcp);
    const claudeGlobal = mergeMcpServerJson(claudeGlobalBefore, MCP_SERVER_NAME, claudeMcpSpec, p.claudeGlobalMcp);
    files.push({ path: p.claudeGlobalMcp, kind: "mcp-json", before: claudeGlobalBefore, after: claudeGlobal.content, changed: claudeGlobal.changed, summary: `reconcile the user-level Claude MCP registration in ${p.claudeGlobalMcp}` });
  }
  if (wantsCodex) {
    const hooksBefore = readText(p.codexHooks);
    const codexHooks = mergeHooks(hooksBefore, hookSpecs(activeHookEntry(io), "codex", shimFor(io)), p.codexHooks);
    const agentsBefore = readText(p.codexAgents);
    const agents = applyStandingInstruction(agentsBefore, "codex");
    files.push(
      { path: p.codexHooks, kind: "hooks-json", before: hooksBefore, after: codexHooks.content, changed: codexHooks.changed, summary: `add 2 hooks (session start, prompt submit) to ${p.codexHooks} (Codex; you trust them once with /hooks)` },
      { path: p.codexAgents, kind: "markdown-block", before: agentsBefore, after: agents.content, changed: agents.changed, summary: `${agentsBefore == null ? "create" : "add a short block to"} ${p.codexAgents} (it tells Codex to leave @mentions of other agents to M9R, so nothing is done twice)` },
    );
    const codexMcpSpec = includeMcp ? mcpServerSpec(io, "codex") : null;
    if (codexMcpSpec) {
      const codexConfigBefore = readText(p.codexConfig);
      const codexConfig = mergeMcpServerToml(codexConfigBefore, MCP_SERVER_NAME, codexMcpSpec);
      files.push({ path: p.codexConfig, kind: "mcp-toml", before: codexConfigBefore, after: codexConfig.content, changed: codexConfig.changed, summary: `register the M9R MCP server (whoami/agents/send/inbox/result) in ${p.codexConfig}` });
    }
  }
  const wantsOpenCode = selectedAgents === undefined ? p.opencodeConfigPaths.some((path) => existsSync(path)) : selectedAgents.includes("opencode");
  const openCodeMcpSpec = includeMcp && wantsOpenCode ? mcpServerSpec(io, "opencode") : null;
  if (openCodeMcpSpec) {
    const pluginBefore = readText(p.opencodePlugin);
    const pluginInvocation = nativeOpenCodeHookInvocation(io, "SessionStart");
    const pluginSource = buildOpenCodeIdentityPluginSource(
      pluginInvocation,
      nativeOpenCodeHookInvocation(io, "UserPromptSubmit"),
      nativeOpenCodeHookInvocation(io, "OpenCodePoll"),
      nativeOpenCodeHookInvocation(io, "OpenCodeDelivered"),
      nativeOpenCodeHookInvocation(io, "OpenCodeDeliveryFailed"),
      nativeOpenCodeHookInvocation(io, "OpenCodeExecutionFailed"),
    );
    const priorManifest = readManifest(p.manifest);
    const priorPlugin = priorManifest?.entries.find((entry) => entry.path === p.opencodePlugin);
    const webPlugin = managedWebSetupPluginOwnership(p.webSetupManifest, p.opencodePlugin);
    const pluginOwnership = priorPlugin ? { ownedPath: priorPlugin.path, ownedHash: priorPlugin.sha256After } : webPlugin;
    const pluginAction = planOpenCodeIdentityPluginInstall({
      targetPath: p.opencodePlugin,
      currentHash: pluginBefore == null ? null : sha256(pluginBefore),
      desiredHash: sha256(pluginSource),
      ...(pluginOwnership ?? {}),
    });
    const managePlugin = pluginAction === "install" || pluginAction === "upgrade" || pluginAction === "unchanged";
    if (pluginAction === "install" || pluginAction === "upgrade") {
      files.push({
        path: p.opencodePlugin,
        kind: "opencode-plugin",
        before: pluginBefore,
        after: pluginSource,
        changed: true,
        summary: `${pluginAction} the M9R OpenCode identity/delivery plugin at ${p.opencodePlugin}`,
        ...(webPlugin && !priorPlugin && webPlugin.ownedPath === p.opencodePlugin
          ? { managedWebSetupPlugin: { manifestPath: p.webSetupManifest, pluginPath: p.opencodePlugin, desiredContent: pluginSource } }
          : {}),
      });
    }
    const command = {
      command: openCodeMcpSpec.command,
      args: openCodeMcpSpec.args,
      m9rHome: openCodeMcpSpec.env?.M9R_HOME ?? p.m9r,
      brokerPort: Number(openCodeMcpSpec.env?.M9R_WEB_BROKER_PORT ?? 47821),
    };
    for (const configPath of p.opencodeConfigPaths) {
      const configBefore = readText(configPath);
      const layout = openCodeLayoutFor(io, configBefore);
      const configAfter = mergeOpenCodeWebMcp(configBefore ?? "", layout, command, managePlugin);
      files.push({
        path: configPath,
        kind: "opencode-json",
        openCodeLayout: layout,
        before: configBefore,
        after: configAfter,
        changed: configAfter !== (configBefore ?? ""),
        summary: `register the M9R MCP server and identity plugin in ${configPath}`,
      });
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
  try { files = plan(io, flags.agents, !flags.identityOnly); } catch (error) {
    if (error instanceof UnparseableConfigError) { io.err(error.message); io.err("Nothing was changed."); return 1; }
    throw error;
  }
  const p = nativePaths(io);
  const modelRepair = planNativeOpenCodeModelRepair(io, flags.agents, !flags.identityOnly);
  const todo = files.filter((f) => f.changed);
  const runtime = runtimePlan(io);
  const manifestBefore = readManifest(p.manifest);
  const installedEngine = installedEnginePath(io, runtime);
  const installedIdentity = existsSync(installedEngine) ? readRuntimeBuildIdentity(installedEngine) : null;
  const activeRuntime = installedIdentity ? activeRuntimeFromIdentity(io, runtime.targetDir, installedIdentity) : null;
  // A legacy hook-only install has no build manifest and remains supported. Once
  // an install claims an active runtime, however, an unreadable or mismatched
  // image must not be treated as converged or silently overwritten by setup.
  if (manifestBefore?.activeRuntime && existsSync(installedEngine) && !activeRuntime && !runtime.needed) {
    io.err(`The installed M9R runtime identity could not be verified (${installedIdentity?.reason ?? "unknown"}); refusing to claim setup is current.`);
    io.err("Repair the runtime from a verified package before retrying setup.");
    return 1;
  }
  const identityNeedsReconcile = !!activeRuntime && !sameActiveRuntime(manifestBefore?.activeRuntime, activeRuntime);

  io.out("M9R setup (local mode: no account, no network)");
  if (runtime.missingSource.length > 0) {
    io.err(`The hook program is missing next to this CLI (${runtime.missingSource.join(", ")}). Reinstall it with: npm i -g m9r-cli`);
    io.err("Nothing was changed.");
    return 1;
  }
  // A previously installed user can opt into startup without reinstalling hooks.
  const startupRequested = flags.autostart === true && !!runtime.engine && !!runtime.shim
    && process.platform === "win32" && !io.env.M9R_HOOK_ENTRY?.trim();
  if (todo.length === 0 && !runtime.needed && !startupRequested && !identityNeedsReconcile && modelRepair?.plan.status !== "updated") { io.out("Already set up. Nothing to change."); printOpenSteps(io); return 0; }
  io.out("This will:");
  if (startupRequested) io.out("  - start the M9R desktop pill when this Windows user signs in (uninstall removes this entry)");
  if (runtime.needed) io.out(`  - copy the small hook program to ${runtime.targetDir} (so the hooks keep working even if this CLI moves or is updated)`);
  if (runtime.engine && runtime.shim) io.out("  - start the M9R background engine, which answers your agents' hooks in milliseconds (uninstall stops it)");
  if (identityNeedsReconcile) io.out(`  - reconcile the verified installed runtime identity in ${p.manifest}`);
  for (const f of todo) io.out(`  - ${f.summary}`);
  if (modelRepair?.plan.status === "updated") io.out(`  - repair stale OpenCode model references in ${modelRepair.statePath} using the cached provider catalog (a rollback copy will be retained)`);
  if (modelRepair?.plan.status === "blocked") io.out(`  [WAIT] OpenCode model state was not changed: ${modelRepair.plan.reason}`);
  if (todo.some((f) => f.before != null)) io.out(`  - back up each existing file to ${p.backups} first`);
  io.out("Undo anytime with: m9r-cli uninstall");
  if (flags.dryRun) { io.out("Dry run: nothing was written."); return 0; }
  if (!(await ask(io, !!flags.yes, "Go ahead?"))) { io.out("Nothing was changed."); return 1; }
  // Starting with Windows is its own, optional yes: nothing about it is implied by the rest.
  const canAutostart = !!runtime.engine && !!runtime.shim && process.platform === "win32" && !io.env.M9R_HOOK_ENTRY?.trim();
  const wantAutostart = canAutostart && (flags.autostart === true || (flags.autostart === undefined && !flags.yes && !!io.confirm && (await io.confirm("Also start M9R when you sign in to Windows, so it is ready before your first prompt? (Uninstall turns this off.)"))));

  mkdirSync(p.backups, { recursive: true });
  const manifest: Manifest = manifestBefore ?? { version: 1, installedAt: new Date().toISOString(), entries: [] };
  // The hook program goes first, so a hook can never point at a file that is not there yet.
  if (runtime.needed) {
    if (runtime.engine) await stopResidentEngine(io);
    manifest.runtimeFiles = [...new Set([...(manifest.runtimeFiles ?? []), ...copyRuntime(runtime)])]
      // Retired images that were unlocked get pruned during copyRuntime. Drop their now-dead ownership
      // records; keep any image still on disk because a running provider MCP process may have it mapped.
      .filter((file) => !isRetiredRuntimePath(file) || existsSync(file));
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
    if (f.managedWebSetupPlugin) {
      const refreshed = await refreshManagedOpenCodeIdentityPlugin(f.managedWebSetupPlugin, {
        readFile: async (path) => existsSync(path) ? readFileSync(path) : null,
        writeAtomic: async (path, bytes) => writeBytesAtomically(path, bytes),
        removeFile: async (path) => { rmSync(path, { force: true }); },
      });
      if (!refreshed.updated) {
        throw new Error(`The web-owned OpenCode plugin changed during setup (${refreshed.action}); refusing to overwrite it.`);
      }
    } else {
      writeFileSync(f.path, f.after, "utf8");
    }
    manifest.entries.push(entry);
  }
  if (wantAutostart && runtime.engine) {
    // The overlay pill also starts and supervises the engine (spawn_engine_supervisor in main.rs); autostart it, not the
    // headless engine alone, so the pill is on screen after a reboot, not just ready to answer hooks invisibly. Falls back
    // to the engine alone when the overlay is not installed next to it (it is a separate, optional install today).
    const overlayExe = join(dirname(runtime.engine.to), "m9r-overlay.exe");
    const command = existsSync(overlayExe) ? `"${overlayExe}"` : `"${runtime.engine.to}" feed --watch --serve-hooks`;
    manifest.autostart = autostartOf(io).enable(command);
    io.out(manifest.autostart ? "M9R will start when you sign in to Windows." : "Could not turn on starting with Windows; M9R still starts itself when an agent first needs it.");
  }
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
  // Identity-only reconciliation must not spawn a second resident engine. A
  // runtime replacement or a real setup change may start the managed daemon;
  // otherwise the existing owner stays in place.
  if (runtime.engine && runtime.shim && !io.env.M9R_NO_DAEMON && (runtime.needed || startupRequested || todo.length > 0)) warmUpAndStart(io, runtime.shim.to, runtime.engine.to);
  io.out("Done.");
  printOpenSteps(io);
  return 0;
}

/**
 * Runs the new native hook once (so the antivirus scan of a brand-new program happens now, not on your first prompt) and starts
 * the resident engine so the first hook already finds it. Best effort: a failure here only means the hook starts it later.
 */
function warmUpAndStart(io: NativeIo, shim: string, engine: string): void {
  try { spawnSync(shim, ["--warm"], { timeout: 20_000, windowsHide: true, stdio: "ignore" }); } catch { /* the first real call warms it instead */ }
  try {
    const child = spawn(engine, ["feed", "--watch", "--serve-hooks"], { detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env, ...io.env } });
    child.on("error", () => undefined);
    child.unref();
  } catch { /* the hook starts it on first use */ }
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
  const { task, created } = store.addTask({ from: input.from ?? (human ? "you" : "agent"), to: handleForProvider(to), goal: input.text, origin: human ? "human_typed" : "agent_initiated", ...(taskCwd ? { cwd: taskCwd } : {}), ...(input.session ? { targetSession: input.session } : {}), idempotencyKey: input.key ?? randomUUID() });
  if (task.approval === "pending") {
    io.out(`Task ${task.id} to @${task.to} is waiting for the user's approval; nothing was delivered.`);
    io.out(`Tell the user to run: m9r-cli approve ${task.id}${isProtectedAction(task.goal) ? "  (it looks like a protected action, so a standing rule would not cover it)" : ""}`);
    return 0;
  }
  if (task.to === "codex" && created && canQueue(task)) {
    const outcome = await deliverToCodex(store, task.id, io.codexDeps ?? realDeps(io.env));
    if (outcome.state === "queued") { io.out(`Sent to @codex as task ${task.id} and accepted by its session. That confirms delivery, not that work has started. The answer reaches ${task.from === "you" ? "your" : `@${task.from}'s`} inbox.`); return 0; }
    if (outcome.state === "failed") { io.out(`Sent to @codex as task ${task.id}, but it could not be pushed: ${outcome.reason}`); io.out("It will show at Codex's next prompt instead."); return 0; }
  }
  io.out(`${created ? "Sent" : "Already sent"} to @${task.to} as task ${task.id}. It appears at that agent's next prompt.`);
  return 0;
}

export interface StatusRow { id: string; state: "ok" | "todo" | "info"; label: string; fix?: string }

/** Live checklist rows for `doctor`: what is in place, what is still open, with the exact fix beside each. */
export function nativeStatus(io: NativeIo): StatusRow[] {
  const p = nativePaths(io);
  const rows: StatusRow[] = [];
  const settings = readText(p.settings);
  rows.push(hasOurHooks(settings, HOOK_MARKER) ? { id: "claude-hooks", state: "ok", label: "Claude Code hooks installed" } : { id: "claude-hooks", state: "todo", label: "Claude Code hooks not installed", fix: "m9r-cli setup" });
  const md = standingInstructionStatus(readText(p.claudeMd));
  rows.push(md.present ? { id: "standing", state: md.current ? "ok" : "todo", label: md.current ? "Standing instruction in CLAUDE.md" : "Standing instruction is out of date", ...(md.current ? {} : { fix: "m9r-cli setup" }) } : { id: "standing", state: "todo", label: "Standing instruction missing from CLAUDE.md", fix: "m9r-cli setup" });
  if (existsSync(p.codex)) {
    rows.push(hasOurHooks(readText(p.codexHooks), HOOK_MARKER) ? { id: "codex-hooks", state: "ok", label: "Codex hooks installed (trust them once with /hooks)" } : { id: "codex-hooks", state: "todo", label: "Codex hooks not installed", fix: "m9r-cli setup" });
  }
  const entry = activeHookEntry(io);
  rows.push(existsSync(entry) ? { id: "hook-entry", state: "ok", label: "Hook program present" } : { id: "hook-entry", state: "todo", label: `Hook program missing at ${entry}`, fix: "npm i -g m9r-cli, then m9r-cli setup" });
  const store = createLocalStore(p.m9r);
  const endpoints = store.listEndpoints();
  rows.push({ id: "endpoints", state: "info", label: endpoints.length ? `Agents seen on this machine: ${endpoints.map((e) => `@${e.handle}`).join(", ")}` : "No agent sessions seen yet. Start a new Claude Code session." });
  const statusNow = Date.now();
  const sessions = endpoints.flatMap((endpoint) => store.sessionsFor(endpoint.handle));
  // `sessions` is intentionally retained for continuity and recovery. It is
  // not an inventory of currently open provider processes, so historical
  // records must not produce a misleading "restart your session" warning.
  const activeSessions = sessions.filter((session) => {
    const lastSeen = Date.parse(session.lastSeenAt);
    return Number.isFinite(lastSeen) && lastSeen <= statusNow && statusNow - lastSeen <= CONNECTION_CLAIM_TTL_MS;
  });
  const missingIdentity = activeSessions.filter((session) => !store.sessionsWithIdentity(session.handle, session.cwd).some((live) => live.sessionId === session.sessionId));
  rows.push(missingIdentity.length > 0
    ? { id: "target-identities", state: "todo", label: `${missingIdentity.length} recently active provider session(s) lack a live M9R identity; targeted delivery will fail visibly`, fix: "continue that existing provider session so M9R can issue its session token" }
    : { id: "target-identities", state: activeSessions.length > 0 ? "ok" : "info", label: activeSessions.length > 0 ? "All recently active provider sessions have live M9R identities" : "No recently active provider sessions to check; retained session history is preserved" });
  const inboxCutoff = statusNow - inboxMaxAgeMs();
  const pending = endpoints.reduce((n, e) => n + store.tasksFor(e.handle).filter((t) => {
    const createdAt = Date.parse(t.createdAt);
    return t.approval !== "denied" && t.approval !== "expired"
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
  const root = nativePaths(io).m9r;
  if (command === "feed") {
    const controller = new AbortController();
    const release = has("--watch") ? acquireFeedLock(root) : () => {};
    if (!release) { io.out("The feed is already being written by another M9R process."); return 0; }
    const watching = has("--watch");
    let server: ReturnType<typeof startHookServer> | undefined;
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
      // The Codex watcher forwards what a person types in Codex; Codex must be told to stand down or the work is done twice, so it only
      // runs when the stand-down note is installed for Codex (or a test forces it on).
      // Finding Codex sessions (so `@codex` has somewhere to go) always runs while watching. Forwarding what a person types in Codex only
      // happens for sessions where Codex was told to stand down (its AGENTS.md carries the note), or when a test forces it on.
      const routeMentions = io.env.M9R_CODEX_WATCH === "1" ? true : (cwd: string | undefined) => codexNoteInEffect(cwd, codexHome(io.env));
      const watcher = watching && !io.env.M9R_NO_CODEX_WATCH ? createCodexWatcher(createLocalStore(root), { codexHome: codexHome(io.env), routeMentions, dispatch: (id) => spawnDeliveryRunner(activeHookEntry(io), id, io.env) }) : undefined;
      server = watching && has("--serve-hooks")
        ? startHookServer({
            path: hookPipePath(root),
            handle: (req) => runHookRequest({ event: req.event ?? "", provider: req.provider ?? "claude-code", input: req.input ?? null, providerProcessId: req.providerProcessId, env: req.env }, activeHookEntry(io), { ...io.env }, true),
            onShutdown: () => controller.abort(),
          })
        : undefined;
      await runFeed({ root, watch: watching, codexWatcher: watcher, signal: controller.signal, onWrite: watching ? (f) => io.out(`feed #${f.seq}: ${f.needsYou.length} need you`) : undefined });
      if (!watching) io.out(`Wrote ${feedPath(root)}`);
      return 0;
    } finally {
      if (freshnessTimer) clearInterval(freshnessTimer);
      server?.close();
      // A runtime-generation change must never strand the single-writer lock,
      // even if feed observation or hook-server startup throws.
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
