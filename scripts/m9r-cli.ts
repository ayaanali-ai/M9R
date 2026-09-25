/**
 * M9R CLI v0 — entrypoint
 * ----------------------------------------------------------------------------
 * Thin wrapper that wires the testable core (src/lib/m9r-cli-core.ts) to
 * real IO: global fetch, the filesystem, process env/cwd, stdout/stderr, and a
 * best-effort browser open. All command logic lives in the core so it can be
 * unit-tested without a network or repo writes.
 *
 * Run it via the package script:
 *   npm run m9r -- doctor
 *   npm run m9r -- init
 *   npm run m9r -- disconnect
 *   npm run m9r -- rules
 *   npm run m9r -- submit-session m9r-session.md --approved
 */

import { mkdir, mkdtemp, readFile, writeFile, access, unlink, chmod, rm, readdir, rename, rmdir } from "node:fs/promises";
import { connect } from "node:net";
import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { emitKeypressEvents } from "node:readline";
import { homedir, platform, tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { WebSocket } from "ws";

import { run, type CliDeps } from "@/lib/oathlock-cli-core";
import { runResidentCycle, validateResidentProfile, type ResidentProfile } from "@/lib/oathlock-resident-core";
import { buildResidentServicePlan } from "@/lib/resident-service-plan";
import { ensureLocalTerminalRuntime } from "@/lib/local-terminal-runtime-launcher";
import { createResidentSupervisor, residentProfileNames, RESIDENT_STALE_BUILD_EXIT_CODE } from "@/lib/resident-supervisor";
import { applyResidentCredential, refreshResidentProfile, residentCredentialPaths, isResidentAgentKind, type ResidentAgentKind } from "@/lib/resident-profile-source";
import { parseProviderAdapterConfig, type ProviderAdapterConfig } from "@/lib/provider-adapter-config";
import { isTerminalProvider } from "@/lib/local-terminal-protocol";
import { BRIDGE_PROTOCOL_VERSION, DEFAULT_BRIDGE_PORT } from "@/lib/local-terminal-protocol";
import { buildWindowsLaunchScript, buildRegAddArgs, buildRegDeleteArgs, buildRegQueryArgs, WINDOWS_RUN_KEY_VALUE_NAME } from "@/lib/oathlock-windows-service";
import {
  autostartPlatform,
  buildScheduledTaskRegisterScript,
  buildScheduledTaskQueryScript,
  buildScheduledTaskRemoveScript,
  buildPowerShellArgs,
  buildLaunchAgentPlist,
  macosLaunchAgentPath,
  MACOS_LAUNCH_AGENT_LABEL,
  buildSystemdUnit,
  linuxSystemdUnitPath,
  LINUX_SYSTEMD_UNIT_NAME,
  buildCronLine,
  upsertCronEntry,
  removeCronEntry,
  WINDOWS_TASK_NAME,
  type AutostartLaunchSpec,
} from "@/lib/oathlock-autostart";
import { parseWatchdogLockPid, parseWatchdogLockStartedAt, shouldStartWatchdog, shouldRelaunch, stillHoldsWatchdogLock } from "@/lib/oathlock-watchdog";
import { drainCaptureSpool } from "@/lib/cross-agent-capture-core";
import { createInterface } from "node:readline/promises";
import { createLocalStore, defaultStoreRoot } from "@/lib/native/local-store";
import { isAgentContext, isHumanContext } from "@/lib/native/approval-core";
import { DEFAULT_BROKER_PORT, brokerKeyPath } from "@/lib/native/web-broker-paths";
import { runWebAuthorityCli } from "@/lib/native/web-authority-cli";
import { apiKeyLaunchBlock, buildVendorLaunchPlan, type M9rLaunchProfile, type M9rLaunchVendor } from "@/lib/native/vendor-launch-core";
import { detectInstalledAgents, type DetectedAgent, type DetectableAgentKind } from "@/lib/agent-detection-core";
import {
  buildClaudeMcpAddArgs, buildClaudeMcpRemoveArgs, extensionIdFromManifestKey, mergeCodexWebMcp, mergeOpenCodeWebMcp, parseWebSetupList,
  planWebSetup, removeCodexWebMcp, removeOpenCodeWebMcp, resolveWebMcpRuntime, selectWebSetupAgents,
  webConfigUninstallMode, WEB_EXTENSION_ID, type WebSetupBrowser,
} from "@/lib/native/web-setup-core";
import { loadOrCreateBrokerKey, startWebBroker } from "@/lib/native/web-broker-server";
import { createWebAuthority } from "@/lib/native/web-authority-core";
import { createWebAuthorityStore } from "@/lib/native/web-authority-store";

const execFileAsync = promisify(execFile);

const WEB_SETUP_MANIFEST = "web-setup-manifest.json";
const WEB_TASK_NAME = "M9R Web Broker";

/** Best-effort: open a URL in the default browser. Never throws to the caller. */
function openUrl(url: string): void {
  try {
    const cmd =
      platform() === "win32" ? "cmd" : platform() === "darwin" ? "open" : "xdg-open";
    const args = platform() === "win32" ? ["/c", "start", "", url] : [url];
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* opening the browser is optional */
  }
}

const deps: CliDeps = {
  cwd: process.cwd(),
  env: process.env,
  fetch: globalThis.fetch,
  readFile: (p) => readFile(p, "utf8"),
  writeFile: (p, data) => writeFile(p, data, "utf8"),
  writeSecretFile: async (p, data) => {
    await writeFile(p, data, { encoding: "utf8", mode: 0o600 });
    if (platform() !== "win32") await chmod(p, 0o600);
  },
  removeFile: (p) => unlink(p),
  mkdir: async (p) => {
    await mkdir(p, { recursive: true });
  },
  fileExists: async (p) => {
    try {
      await access(p);
      return true;
    } catch {
      return false;
    }
  },
  out: (line) => process.stdout.write(line + "\n"),
  err: (line) => process.stderr.write(line + "\n"),
  openUrl,
  probeVersion,
  confirm: process.stdin.isTTY
    ? async (question) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
          return answer === "y" || answer === "yes";
        } finally {
          rl.close();
        }
      }
    : undefined,
  drainCapture: () => drainCaptureSpool({
    repositoryRoot: process.cwd(),
    readTranscript: (path) => readFile(path, "utf8"),
  }),
};

/**
 * Real `m9r connect` agent-detection probe: `<binary> --version`, real
 * process, real PATH resolution -- `shell: true` so this also finds npm's
 * Windows `.cmd` shims (`claude.cmd`, `codex.cmd`, `opencode.cmd`), the
 * exact same PATHEXT gap `acp-stdio-adapter.ts` already had to work around
 * for OpenCode. A 3s timeout is generous for a `--version` flag (none of
 * these three touch the network for it) and short enough that one hung
 * install can't stall the rest of `connect`'s detection pass. Any failure
 * mode -- not found, non-zero exit, timeout -- returns null; `connect`
 * treats null as "not installed," never as an error to surface.
 */
async function probeVersion(binary: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(binary, ["--version"], { timeout: 3000, shell: true, windowsHide: true });
    return stdout;
  } catch {
    return null;
  }
}

async function readResidentCredential(provider: ResidentAgentKind): Promise<unknown> {
  for (const path of residentCredentialPaths(process.cwd(), provider)) {
    try { return JSON.parse(await readFile(path, "utf8")); } catch { /* try the legacy connection only for backward compatibility */ }
  }
  throw new Error("Provider connection is unavailable; reconnect this agent with oathlock init.");
}

async function readResidentAdapter(provider: ResidentAgentKind): Promise<ProviderAdapterConfig | null> {
  const path = join(process.cwd(), ".oathlock", "agents", provider, "adapter.json");
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
    const parsed = parseProviderAdapterConfig(raw, provider);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value;
  } catch {
    return null;
  }
}

/**
 * A long-running resident/bridge process has no way to know a rebuild
 * happened out from under it -- confirmed live: a resident process kept
 * running for hours after several rebuilds, silently executing its original
 * stale code with zero signal, and the only way to notice was manually
 * diffing process start times against git history. scripts/build-cli.mjs
 * stamps build-info.json next to this compiled entry on every build;
 * comparing the value captured at this process's own startup against a
 * fresh read on each poll cycle surfaces drift instead of hiding it.
 *
 * No-ops (by design, not a bug) when running from source via tsx -- there
 * is no cli/dist/build-info.json alongside scripts/oathlock-cli.ts in that
 * case, and running live source is never stale relative to itself.
 */
let capturedBuildTimestamp: string | null | undefined;
let warnedStaleBuild = false;
async function currentBuildTimestamp(): Promise<string | null> {
  try {
    const infoPath = resolve(dirname(fileURLToPath(import.meta.url)), "build-info.json");
    const raw = JSON.parse(await readFile(infoPath, "utf8")) as { builtAt?: unknown };
    return typeof raw.builtAt === "string" ? raw.builtAt : null;
  } catch {
    return null;
  }
}
/**
 * `exitOnStale` is only safe for a process a supervisor will actually
 * relaunch (resident run's own loop, spawned by createResidentSupervisor).
 * The terminal-runtime process itself IS the supervisor -- nothing above it
 * would bring it back if it exited, so its own freshness check stays warn-
 * only (the default) rather than silently killing every resident with it.
 */
async function checkBuildFreshness(label: string, options: { exitOnStale?: boolean } = {}): Promise<void> {
  const builtAt = await currentBuildTimestamp();
  if (builtAt === null) return;
  if (capturedBuildTimestamp === undefined) {
    capturedBuildTimestamp = builtAt;
    return;
  }
  if (capturedBuildTimestamp !== null && builtAt !== capturedBuildTimestamp) {
    if (options.exitOnStale) {
      process.stderr.write(`${label}: newer build (${builtAt}) detected on disk, restarting to pick it up.\n`);
      process.exit(RESIDENT_STALE_BUILD_EXIT_CODE);
    }
    if (!warnedStaleBuild) {
      warnedStaleBuild = true;
      process.stderr.write(
        `\n⚠️  ${label} started with build ${capturedBuildTimestamp}, but a newer build (${builtAt}) is now on disk (npm run build:cli was run again after this process started).\n` +
        `   It will keep silently running the OLD code until you kill and restart it. Restart this process now to pick up recent changes.\n\n`,
      );
    }
  }
}

async function runResidentCli(argv: string[]): Promise<number> {
  if (argv[0] !== "run" && argv[0] !== "configure" && argv[0] !== "refresh" && argv[0] !== "service-plan") {
    process.stderr.write("Usage: oathlock resident configure --provider <slug> --binding-id <id> --profile <name>\n       oathlock resident refresh --profile <name>\n       oathlock resident run [--config .oathlock/resident.local.json] [--profile name] [--once]\n       oathlock resident service-plan --profile <name>\n");
    return 1;
  }
  const valueFor = (name: string) => {
    const exact = argv.find((value) => value.startsWith(`${name}=`));
    if (exact) return exact.slice(name.length + 1);
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const configFile = valueFor("--config") ?? join(process.cwd(), ".oathlock", "resident.local.json");
  const profileName = valueFor("--profile");
  if (argv[0] === "service-plan") {
    if (!profileName) { process.stderr.write("resident service-plan: --profile is required.\n"); return 1; }
    try {
      const pollMs = Math.max(5_000, Math.min(60_000, Number(valueFor("--poll-ms") ?? 15_000)));
      process.stdout.write(JSON.stringify(buildResidentServicePlan({ profile: profileName, workingDirectory: process.cwd(), configFile, pollMs }), null, 2) + "\n");
      return 0;
    } catch (error) { process.stderr.write(`resident service-plan: ${error instanceof Error ? error.message : "invalid input"}.\n`); return 1; }
  }
  if (argv[0] === "refresh") {
    if (!profileName) { process.stderr.write("resident refresh: --profile is required.\n"); return 1; }
    let config: { profiles?: Array<Record<string, unknown>> };
    try { config = JSON.parse(await readFile(configFile, "utf8")) as { profiles?: Array<Record<string, unknown>> }; }
    catch { process.stderr.write(`resident refresh: could not read ${configFile}.\n`); return 1; }
    const profiles = Array.isArray(config.profiles) ? config.profiles : [];
    const index = profiles.findIndex((profile) => profile?.name === profileName);
    if (index < 0) { process.stderr.write(`resident refresh: profile ${profileName} was not found.\n`); return 1; }
    const current = profiles[index];
    const provider = isResidentAgentKind(current.provider) ? current.provider : null;
    if (!provider) { process.stderr.write("resident refresh: profile provider is invalid.\n"); return 1; }
    let refreshed: Record<string, unknown>;
    try {
      refreshed = refreshResidentProfile(current, `${provider}-${randomUUID()}`);
      const checked = validateResidentProfile(applyResidentCredential(refreshed, await readResidentCredential(provider)));
      if (!checked.ok) throw new Error(checked.reason ?? "invalid profile");
    } catch (error) {
      process.stderr.write(`resident refresh: ${error instanceof Error ? error.message : "refresh failed"}\n`);
      return 1;
    }
    profiles[index] = refreshed;
    await writeFile(configFile, JSON.stringify({ ...config, profiles }, null, 2) + "\n", "utf8");
    process.stdout.write(`Resident profile ${profileName} refreshed for the current ${provider} connection; no token was stored or printed.\n`);
    return 0;
  }
  if (argv[0] === "configure") {
    const provider = valueFor("--provider");
    const repositoryBindingId = valueFor("--binding-id");
    const executionMode = valueFor("--mode") ?? "read_only";
    const capabilities = (valueFor("--capabilities") ?? "review").split(",").map((value) => value.trim()).filter(Boolean);
    if (!profileName || !isResidentAgentKind(provider) || !repositoryBindingId) {
      process.stderr.write("resident configure: --profile, --provider, and --binding-id are required.\n");
      return 1;
    }
    let local: unknown;
    try { local = await readResidentCredential(provider); }
    catch { process.stderr.write("resident configure: no connected M9R token found; run m9r init as this provider first.\n"); return 1; }
    let existing: { profiles?: Array<Record<string, unknown>> } = {};
    try { existing = JSON.parse(await readFile(configFile, "utf8")) as { profiles?: Array<Record<string, unknown>> }; } catch { /* first profile */ }
    const profiles = (existing.profiles ?? []).filter((profile) => profile.name !== profileName);
    const adapter = provider === "codex" || provider === "claude-code" ? null : await readResidentAdapter(provider);
    if (provider !== "codex" && provider !== "claude-code" && (!adapter || adapter.protocol !== "oathlock-json-stdio")) {
      process.stderr.write(`resident configure: ${provider} needs .oathlock/agents/${provider}/adapter.json with protocol oathlock-json-stdio.\n`);
      return 1;
    }
    const persistedCandidate = {
      name: profileName,
      apiUrl: (process.env.OATHLOCK_API_URL ?? "https://app.m9r.workers.dev").replace(/\/+$/, ""),
      provider,
      ...(adapter ? { adapter } : {}),
      instanceKey: `${provider}-${randomUUID()}`,
      repositoryBindingId,
      repositoryRoot: process.cwd(),
      capabilities,
      executionMode,
      heartbeatSequence: 0,
    };
    let candidate: Record<string, unknown>;
    try { candidate = applyResidentCredential(persistedCandidate, local); }
    catch { process.stderr.write("resident configure: connected token is invalid.\n"); return 1; }
    const checkedProfile = validateResidentProfile(candidate);
    if (!checkedProfile.ok) { process.stderr.write(`resident configure: invalid profile (${checkedProfile.reason}).\n`); return 1; }
    profiles.push(persistedCandidate);
    await mkdir(join(process.cwd(), ".oathlock"), { recursive: true });
    await writeFile(configFile, JSON.stringify({ profiles }, null, 2) + "\n", "utf8");
    process.stdout.write(`Resident profile ${profileName} saved locally for ${provider}; no token was printed.\n`);
    return 0;
  }
  const once = argv.includes("--once");
  const pollMs = Math.max(5_000, Math.min(60_000, Number(valueFor("--poll-ms") ?? 15_000)));
  let raw: unknown;
  try { raw = JSON.parse(await readFile(configFile, "utf8")); }
  catch { process.stderr.write(`resident: could not read ${configFile}.\n`); return 1; }
  const config = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const profiles = Array.isArray(config.profiles) ? config.profiles : [config];
  const selected = profileName
    ? profiles.find((profile) => profile && typeof profile === "object" && (profile as Record<string, unknown>).name === profileName)
    : profiles[0];
  const selectedName = selected && typeof selected === "object" && typeof (selected as Record<string, unknown>).name === "string"
    ? (selected as Record<string, unknown>).name as string
    : null;
  if (!selectedName) { process.stderr.write("resident: selected profile has no name.\n"); return 1; }
  const provider = selected && typeof selected === "object" && !Array.isArray(selected)
    && isResidentAgentKind((selected as Record<string, unknown>).provider)
    ? (selected as Record<string, unknown>).provider as ResidentAgentKind
    : null;
  if (!provider) { process.stderr.write("resident: selected profile has an invalid provider.\n"); return 1; }
  let resolvedProfile: Record<string, unknown>;
  try { resolvedProfile = applyResidentCredential(selected as Record<string, unknown>, await readResidentCredential(provider)); }
  catch { process.stderr.write(`resident: ${provider} is not connected; run oathlock init --agent-kind ${provider}.\n`); return 1; }
  const checked = validateResidentProfile(resolvedProfile);
  if (!checked.ok || !checked.profile) { process.stderr.write(`resident: invalid profile (${checked.reason}).\n`); return 1; }
  let profile: ResidentProfile = checked.profile;
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.stdout.write(`Resident ${profile.instanceKey} ready for ${profile.provider} (${profile.executionMode}).\n`);
  await checkBuildFreshness(`resident run --profile ${profileName ?? selectedName}`, { exitOnStale: true });
  try {
    do {
      const result = await runResidentCycle(profile, { signal: controller.signal });
      profile = { ...profile, heartbeatSequence: result.heartbeatSequence };
      if (result.claimed > 0) process.stdout.write(`Resident processed ${result.claimed} grant(s): ${result.returned} returned, ${result.failed} failed.\n`);
      await checkBuildFreshness(`resident run --profile ${profileName ?? selectedName}`, { exitOnStale: true });
      if (once || controller.signal.aborted) break;
      await new Promise<void>((resolveSleep) => {
        const timer = setTimeout(resolveSleep, pollMs);
        controller.signal.addEventListener("abort", () => { clearTimeout(timer); resolveSleep(); }, { once: true });
      });
    } while (!controller.signal.aborted);
    return 0;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

/**
 * Spawns `oathlock <...subArgs>` as a fully detached, consoleless child.
 *
 * Two properties are BOTH required, and measured on Windows 11 before this
 * was written:
 *
 * 1. No console. `detached: true` makes libuv pass DETACHED_PROCESS, so the
 *    child is bound to no console at all. Verified with AttachConsole +
 *    GetConsoleProcessList against the launching terminal: the spawned pid is
 *    not in that console's process list, so closing the window cannot reach
 *    it. (`windowsHide` stays as belt and braces.)
 *
 * 2. No live parent. A plain one-hop `spawn(node, ..., {detached:true})` FAILS
 *    this: the child keeps this process as its parent, and a
 *    `taskkill /F /T` on the runtime -- which is how terminal hosts tear a
 *    session down, and which walks parent/child links, not consoles -- takes
 *    the watchdog with it. Measured directly: one-hop child died, orphaned
 *    child survived.
 *
 * So we go through a throwaway `node -e` hop that spawns the real target
 * detached and exits immediately. The target is then orphaned, and no
 * parent-walking kill can find it. The previous `cmd /d /c start "" /b ...`
 * form achieved the same orphaning by accident (its `cmd.exe` exits right
 * after handing off); this gets it deliberately, without a shell in the path
 * and without `start /b`'s "run in the parent's console" semantics.
 */
const DETACHED_SPAWN_HOP = "const{spawn}=require('child_process');const c=spawn(process.argv[1],process.argv.slice(2),{detached:true,stdio:'ignore',windowsHide:true});c.unref();";

function spawnDetachedOathlockCommand(subArgs: string[]): void {
  const runtimeArgs = [...process.execArgv, process.argv[1], ...subArgs];
  const child = platform() === "win32"
    ? spawn(process.execPath, ["-e", DETACHED_SPAWN_HOP, process.execPath, ...runtimeArgs], {
        cwd: process.cwd(),
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      })
    // POSIX `detached` already calls setsid(), which severs the controlling
    // terminal; orphaning adds nothing there, so keep the direct spawn.
    : spawn(process.execPath, runtimeArgs, {
        cwd: process.cwd(),
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
  child.unref();
}

const watchdogLockPath = () => join(process.cwd(), ".oathlock", "watchdog.lock");
const watchdogLogPath = () => join(process.cwd(), ".oathlock", "watchdog.log");

async function watchdogLog(line: string): Promise<void> {
  try {
    await mkdir(join(process.cwd(), ".oathlock"), { recursive: true });
    await writeFile(watchdogLogPath(), `${new Date().toISOString()} ${line}\n`, { flag: "a" });
  } catch { /* best-effort logging only -- never let a log write crash the watchdog */ }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when no live watchdog currently holds the lock -- i.e. a fresh one
 * should be started. A hard-killed watchdog never runs its SIGINT/SIGTERM
 * cleanup, so its lock file survives with a dead pid; and on Windows that pid
 * can later be recycled by an unrelated process, which is why the lock's age
 * is taken into account too (see shouldStartWatchdog).
 */
async function watchdogSlotIsFree(): Promise<boolean> {
  let raw: string | null = null;
  try { raw = await readFile(watchdogLockPath(), "utf8"); } catch { /* no lock yet */ }
  return shouldStartWatchdog(parseWatchdogLockPid(raw), isPidAlive, parseWatchdogLockStartedAt(raw));
}

function probeTerminalRuntimePort(): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = connect({ host: "127.0.0.1", port: DEFAULT_BRIDGE_PORT, timeout: 4_000 });
    socket.once("connect", () => { socket.destroy(); resolvePromise(true); });
    socket.once("timeout", () => { socket.destroy(); resolvePromise(false); });
    socket.once("error", () => resolvePromise(false));
  });
}

/**
 * Option B from the reliability discussion: a second, near-zero-cost process
 * that notices `oathlock terminal runtime` died mid-session and relaunches
 * it, instead of waiting for the next Windows login (the existing HKCU
 * Run-key registration only fires once, at login -- oathlock-windows-service.ts).
 * Spawned detached from startTerminalRuntime() below, so a crash of the main
 * process does not take this down with it (detached children outlive their
 * parent on Windows). Idempotent via a lock file: every relaunch of the
 * runtime spawns a fresh watchdog, which checks for an already-live one and
 * exits immediately if found, so crash/relaunch cycles never accumulate more
 * than one watchdog.
 */
async function watchdogLockIsOurs(): Promise<boolean> {
  let raw: string | null = null;
  try { raw = await readFile(watchdogLockPath(), "utf8"); } catch { /* lock vanished -- treat as lost */ }
  return stillHoldsWatchdogLock(raw, process.pid);
}

async function runWatchdog(): Promise<number> {
  if (!(await watchdogSlotIsFree())) {
    await watchdogLog(`watchdog ${process.pid} found the slot already held -- exiting.`);
    // Explicit exit, not just a return: the logging above is already flushed
    // (watchdogLog awaits its own write) and this path installs no cleanup
    // handlers, so there is nothing left to run. Returning alone leaves
    // termination at the mercy of whatever handles the module graph happens
    // to hold open, which is how stood-down watchdogs lingered as live
    // processes doing nothing. Same graceful `process.exit(0)` the SIGINT /
    // SIGTERM cleanup below uses.
    process.exit(0);
  }

  await mkdir(join(process.cwd(), ".oathlock"), { recursive: true });
  await writeFile(watchdogLockPath(), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  // The slot check and the write above are not atomic, so a watchdog that
  // started at the same moment may have written its own pid in between. The
  // last writer wins; anyone else re-reads and stands down.
  if (!(await watchdogLockIsOurs())) {
    await watchdogLog(`watchdog ${process.pid} lost the startup race for the lock -- exiting.`);
    process.exit(0);
  }
  await watchdogLog(`watchdog started, pid ${process.pid}`);

  const PROBE_INTERVAL_MS = 15_000;
  const FAILURE_THRESHOLD = 3; // ~45s unreachable before relaunching.
  const POST_RELAUNCH_GRACE_MS = 20_000; // give a fresh runtime time to bind before probing again.
  let consecutiveFailures = 0;
  let stopped = false;
  const cleanup = async () => {
    stopped = true;
    // Never delete a lock another watchdog now owns -- that would hand the
    // slot to any number of new starters while the real holder keeps running.
    if (await watchdogLockIsOurs()) {
      try { await unlink(watchdogLockPath()); } catch { /* best effort */ }
    }
    process.exit(0);
  };
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);

  while (!stopped) {
    // A watchdog that has been superseded (its lock reclaimed as stale, or
    // overwritten by a later starter) must not keep probing and relaunching
    // in parallel with the real holder.
    if (!(await watchdogLockIsOurs())) {
      await watchdogLog(`watchdog ${process.pid} no longer holds the lock -- exiting.`);
      process.exit(0);
    }
    const alive = await probeTerminalRuntimePort();
    if (alive) {
      consecutiveFailures = 0;
    } else {
      consecutiveFailures += 1;
      if (shouldRelaunch(consecutiveFailures, FAILURE_THRESHOLD)) {
        await watchdogLog(`runtime unreachable after ${consecutiveFailures} probes -- relaunching.`);
        spawnDetachedOathlockCommand(["terminal", "runtime"]);
        consecutiveFailures = 0;
        await new Promise((r) => setTimeout(r, POST_RELAUNCH_GRACE_MS));
        continue;
      }
    }
    await new Promise((r) => setTimeout(r, PROBE_INTERVAL_MS));
  }
  return 0;
}

async function startTerminalRuntime(options: { localOnly?: boolean } = {}): Promise<number> {
  const localOnly = options.localOnly === true;
  if (localOnly) process.env.M9R_LOCAL_ONLY = "1";
  if (!localOnly) {
    const { startNativeEventSync } = await import("../src/lib/native-event-sync");
    startNativeEventSync();
  }
  const configFile = join(process.cwd(), ".oathlock", "resident.local.json");
  let config: unknown = {};
  try { config = JSON.parse(await readFile(configFile, "utf8")); } catch { /* terminals still work without resident profiles */ }
  const profiles = localOnly ? [] : residentProfileNames(config);
  const supervisor = createResidentSupervisor({
    profiles,
    launch(profile, onExit) {
      const child = spawn(process.execPath, [process.argv[1], "resident", "run", "--config", configFile, "--profile", profile], {
        cwd: process.cwd(),
        stdio: "ignore",
        windowsHide: true,
      });
      let reported = false;
      const report = (code: number | null) => {
        if (reported) return;
        reported = true;
        onExit(code);
      };
      child.once("error", () => report(1));
      child.once("exit", report);
      return { kill: () => { if (!child.killed) child.kill(); } };
    },
    schedule(callback, delayMs) {
      const timer = setTimeout(callback, delayMs);
      timer.unref();
      return { cancel: () => clearTimeout(timer) };
    },
    onStateChange(profile, state) {
      // "failed" means this resident has exhausted its restart budget and is
      // now permanently offline until this whole terminal runtime process is
      // restarted. Previously invisible -- a human only found out by
      // noticing the agent had gone silent (confirmed live this session with
      // claude-gate11e). This is the loud, unmissable signal that was missing.
      if (state === "failed") process.stderr.write(`[resident-supervisor] profile "${profile}" has FAILED and will not auto-restart -- it exhausted its restart budget. Restart the terminal runtime once the underlying issue is fixed.\n`);
    },
  });
  const stop = () => supervisor.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  supervisor.start();
  // The watchdog is intentionally detached in production so it can recover a
  // runtime after the launching shell disappears. Packaging tests set this
  // private opt-out to avoid leaving an orphan process holding their temporary
  // cwd open on Windows; normal installs never set it.
  const watchdogEnabled = process.env.M9R_TEST_DISABLE_WATCHDOG !== "1";
  if (!localOnly && watchdogEnabled) spawnDetachedOathlockCommand(["watchdog", "run"]);
  // Supervision was one-directional: the watchdog watched the runtime and
  // nothing watched the watchdog, so once it died the whole recovery path was
  // gone silently. This closes that loop cheaply -- a lock-file check every
  // few minutes, relaunching only when the same predicate the watchdog itself
  // uses says the slot is free. A watchdog that starts while one is already
  // live exits immediately, so a spurious relaunch costs nothing.
  // One relaunch attempt in flight at a time. The check is async and the
  // freshly spawned watchdog needs a moment to write the lock, so without this
  // an overlapping tick can still see a free slot and spawn a second one.
  if (!localOnly) {
    let watchdogRelaunchInFlight = false;
    const watchdogGuardTimer = setInterval(() => {
      if (watchdogRelaunchInFlight) return;
      watchdogRelaunchInFlight = true;
      void watchdogSlotIsFree().then(async (free) => {
        if (!free) return;
        await watchdogLog("runtime self-check found no live watchdog -- relaunching.");
        spawnDetachedOathlockCommand(["watchdog", "run"]);
        // Hold the guard past the spawn so the next tick sees the new lock.
        await new Promise((r) => setTimeout(r, 10_000));
      }).catch(() => { /* never let supervision noise crash the runtime */ })
        .finally(() => { watchdogRelaunchInFlight = false; });
    }, 3 * 60_000);
    watchdogGuardTimer.unref();
  }
  await checkBuildFreshness("oathlock terminal runtime");
  const freshnessTimer = setInterval(() => { void checkBuildFreshness("oathlock terminal runtime"); }, 5 * 60_000);
  freshnessTimer.unref();
  // Item #28 Part A: the ONE real, per-machine, per-person terminal --
  // deliberately separate from oathlock-terminal-bridge.ts's own (now
  // unused for terminals, still used for its other real jobs: reconnect
  // polling, file-watch batching) loopback WebSocket server, which was the
  // old, deprecated, single-viewer-only bridge item #21 already flagged as
  // "being replaced, not extended." This one talks to the real Mission
  // Relay, the same one the dashboard's own terminal panes render from.
  if (!localOnly) {
    const { startOwnerPtyRuntime } = await import("../src/lib/mission/owner-pty-runtime");
    void startOwnerPtyRuntime({ repositoryRoot: process.cwd() }).catch((error) => {
      console.error(`[owner-terminal] failed to start: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  // Item #9 Phase 1a: resident-served real files over the relay, no Tauri
  // needed -- see M9R_MASTER_BUILD_PLAN.md's #9 section. No-ops quietly if
  // this machine has no connected provider yet.
  if (!localOnly) {
    const { startOwnerFsRuntime } = await import("../src/lib/mission/owner-fs-runtime");
    void startOwnerFsRuntime({ repositoryRoot: process.cwd() }).catch((error) => {
      console.error(`[owner-fs] failed to start: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  // Item #11/#29: the local half of the shared-context memory catalog --
  // exports newly-archived Sessions to .oathlock/memory/*.md as they happen,
  // so a connected agent's own real read/grep tools have something to search
  // (see search_memory in dev-mcp-server.ts for the live, no-export-needed path).
  if (!localOnly) {
    const { startMemoryExportLoop } = await import("../src/lib/memory-export-core");
    startMemoryExportLoop({ repositoryRoot: process.cwd() });
  }
  // Item #35: drains .oathlock/capture/pending.jsonl (written by the
  // SessionEnd hook/OpenCode plugin `m9r connect` installs) into the same
  // .oathlock/memory/ tree above, so a Claude Code/Codex/OpenCode session a
  // human launched directly in their own terminal -- never touching M9R's
  // dashboard -- still becomes real, searchable shared memory.
  {
    const { startCaptureDrainLoop } = await import("../src/lib/cross-agent-capture-core");
    startCaptureDrainLoop({ repositoryRoot: process.cwd() });
  }
  // Item #3: recover OpenCode sessions whose process died before the plugin
  // received an idle event. This uses OpenCode's own persisted-session CLI,
  // not provider authentication, and feeds the same spool as live capture.
  if (!localOnly) {
    const { startOpenCodeCaptureBackfillLoop } = await import("../src/lib/opencode-capture-backfill-core");
    startOpenCodeCaptureBackfillLoop({ repositoryRoot: process.cwd() });
  }
  await import("./oathlock-terminal-bridge");
  return 0;
}

const windowsServiceScriptPath = () => join(process.cwd(), ".oathlock", "service-launch.ps1");

/**
 * How the login launcher should relaunch this CLI. A raw .ts entry (monorepo
 * dev checkout, running via the "oathlock" npm script) needs the same --import
 * register-alias.mjs flag that script already passes, or every aliased "lib"
 * import throws immediately with no console to show it in -- the launcher
 * would look "installed" and just never actually boot. The packaged CLI
 * (build-cli.mjs's flattened cli/dist/oathlock.js) has no path aliases left to
 * resolve. Node's ESM --import loader rejects a raw Windows absolute path
 * ("C:\...") as an unsupported URL scheme; it must be a real file:// URL.
 */
/**
 * Prefers THIS repo's own packaged build over whatever script happens to be
 * currently executing. `process.argv[1]` reflects invocation, not intent --
 * confirmed live: running `npx oathlock init` from inside a repo checkout
 * can resolve to a globally-installed `oathlock` package elsewhere on disk
 * (npm/npx PATH resolution, not this repo), even though the human is
 * standing in this specific repo and expects `npm run build:cli` here to be
 * what changes what starts at login. Falling back to process.argv[1] only
 * when this repo has no packaged build at all keeps a genuinely global-only
 * install (no local checkout) working exactly as before.
 */
async function repoLocalCliEntryPath(): Promise<string> {
  // "m9r.js" is the real packaged bin (cli/package.json's only bin entry).
  // "oathlock.js" is a stale build artifact that still ships alongside it --
  // this function picking it over m9r.js is exactly what caused a real,
  // live bug: `service install` wrote a login launcher pointing at the old
  // bundle, so the persistent resident silently kept running pre-rename code
  // (including the .m9r/.oathlock directory mismatch) after every reboot,
  // with no visible failure -- it just quietly never picked up any fix.
  const repoLocalDist = resolve(join(process.cwd(), "cli", "dist", "m9r.js"));
  try {
    await access(repoLocalDist);
    return repoLocalDist;
  } catch {
    return resolve(process.argv[1]);
  }
}

async function autostartLaunchSpec(): Promise<AutostartLaunchSpec> {
  const cliEntryPath = await repoLocalCliEntryPath();
  const nodeArgs = cliEntryPath.endsWith(".ts")
    ? ["--disable-warning=ExperimentalWarning", "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--import", pathToFileURL(resolve(join(process.cwd(), "scripts", "register-alias.mjs"))).href]
    : [];
  return {
    nodeExecutable: process.execPath,
    nodeArgs,
    cliEntryPath,
    args: ["terminal", "runtime"],
    workingDirectory: process.cwd(),
  };
}

async function writeWindowsLaunchScript(): Promise<string> {
  const scriptPath = resolve(windowsServiceScriptPath());
  await mkdir(join(process.cwd(), ".oathlock"), { recursive: true });
  // Terminal panes stay an explicit opt-in (see bridge-runtime.ts's own
  // comment on OATHLOCK_TERMINAL_PANES) -- but the login-launched resident
  // is a separate process from the shell that ran `service install`, so it
  // never inherits a shell-set env var. Baking it into the generated launch
  // script is what makes the opt-in actually survive a reboot.
  await writeFile(scriptPath, buildWindowsLaunchScript({ ...(await autostartLaunchSpec()), envVars: { OATHLOCK_TERMINAL_PANES: "1" } }), "utf8");
  return scriptPath;
}

function powerShell(script: string): Promise<{ stdout: string }> {
  return execFileAsync("powershell.exe", buildPowerShellArgs(script), { windowsHide: true });
}

/**
 * Registers the hidden per-user logon Scheduled Task, and on success drops the
 * legacy HKCU\...\Run value so a login never starts the runtime twice. If the
 * security stack refuses the task (an onlogon trigger is a known malware-
 * persistence pattern and gets behavior-blocked independently of admin
 * rights -- see oathlock-windows-service.ts) we fall back to the Run key,
 * which is what shipped before this and is known to write clean here.
 */
async function installWindowsAutostart(): Promise<string> {
  const scriptPath = await writeWindowsLaunchScript();
  const launcherArguments = `-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${scriptPath}"`;
  try {
    await powerShell(buildScheduledTaskRegisterScript(launcherArguments, process.cwd()));
    await execFileAsync("reg", buildRegDeleteArgs()).catch(() => undefined);
    return `hidden logon Scheduled Task "${WINDOWS_TASK_NAME}"`;
  } catch (taskError) {
    try {
      await execFileAsync("reg", buildRegAddArgs(scriptPath));
      return `HKCU\\...\\Run\\${WINDOWS_RUN_KEY_VALUE_NAME} (Scheduled Task registration was refused)`;
    } catch {
      throw taskError;
    }
  }
}

async function removeWindowsAutostart(): Promise<void> {
  await powerShell(buildScheduledTaskRemoveScript()).catch(() => undefined);
  await execFileAsync("reg", buildRegDeleteArgs()).catch(() => undefined);
  await unlink(windowsServiceScriptPath()).catch(() => undefined);
}

function homeDirectory(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) throw new Error("no home directory in the environment");
  return home;
}

async function installMacosAutostart(): Promise<string> {
  const home = homeDirectory();
  const plistPath = macosLaunchAgentPath(home);
  await mkdir(dirname(plistPath), { recursive: true });
  await mkdir(join(process.cwd(), ".oathlock"), { recursive: true });
  await writeFile(plistPath, buildLaunchAgentPlist(await autostartLaunchSpec(), join(process.cwd(), ".oathlock", "launch-agent.log")), "utf8");
  const domain = `gui/${typeof process.getuid === "function" ? process.getuid() : ""}`;
  // bootout-then-bootstrap is the idempotent form: re-running init reloads the
  // (possibly rewritten) plist instead of erroring with "service already
  // loaded". `bootstrap` is the modern verb; `load -w` covers older macOS.
  await execFileAsync("launchctl", ["bootout", `${domain}/${MACOS_LAUNCH_AGENT_LABEL}`]).catch(() => undefined);
  try {
    await execFileAsync("launchctl", ["bootstrap", domain, plistPath]);
  } catch {
    await execFileAsync("launchctl", ["load", "-w", plistPath]);
  }
  return `user LaunchAgent ${plistPath}`;
}

async function removeMacosAutostart(): Promise<void> {
  const home = homeDirectory();
  const plistPath = macosLaunchAgentPath(home);
  const domain = `gui/${typeof process.getuid === "function" ? process.getuid() : ""}`;
  await execFileAsync("launchctl", ["bootout", `${domain}/${MACOS_LAUNCH_AGENT_LABEL}`]).catch(() => undefined);
  await execFileAsync("launchctl", ["unload", "-w", plistPath]).catch(() => undefined);
  await unlink(plistPath).catch(() => undefined);
}

async function hasUserSystemd(): Promise<boolean> {
  try {
    await execFileAsync("systemctl", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

/** Reads the current user crontab; an empty/absent crontab is not an error. */
async function readCrontab(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("crontab", ["-l"]);
    return stdout;
  } catch {
    return "";
  }
}

async function writeCrontab(contents: string): Promise<void> {
  await new Promise<void>((resolveWrite, rejectWrite) => {
    const child = spawn("crontab", ["-"], { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", rejectWrite);
    child.on("close", (code) => (code === 0 ? resolveWrite() : rejectWrite(new Error(`crontab - exited ${code}`))));
    child.stdin.end(contents);
  });
}

async function installLinuxAutostart(): Promise<string> {
  const spec = await autostartLaunchSpec();
  if (await hasUserSystemd()) {
    const unitPath = linuxSystemdUnitPath(homeDirectory());
    await mkdir(dirname(unitPath), { recursive: true });
    await writeFile(unitPath, buildSystemdUnit(spec), "utf8");
    await execFileAsync("systemctl", ["--user", "daemon-reload"]);
    await execFileAsync("systemctl", ["--user", "enable", "--now", LINUX_SYSTEMD_UNIT_NAME]);
    return `user systemd unit ${unitPath}`;
  }
  // No systemd: a @reboot crontab entry is the portable user-level fallback.
  // Rewriting through upsertCronEntry keeps every unrelated line intact and
  // guarantees exactly one M9R entry no matter how often init runs.
  await writeCrontab(upsertCronEntry(await readCrontab(), buildCronLine(spec)));
  return "@reboot entry in your user crontab (no systemd found)";
}

async function removeLinuxAutostart(): Promise<void> {
  if (await hasUserSystemd()) {
    await execFileAsync("systemctl", ["--user", "disable", "--now", LINUX_SYSTEMD_UNIT_NAME]).catch(() => undefined);
    await unlink(linuxSystemdUnitPath(homeDirectory())).catch(() => undefined);
    await execFileAsync("systemctl", ["--user", "daemon-reload"]).catch(() => undefined);
  }
  const crontab = await readCrontab();
  if (crontab.includes("oathlock-runtime-autostart")) {
    await writeCrontab(removeCronEntry(crontab)).catch(() => undefined);
  }
}

/** Installs login autostart for the current OS. Throws; callers must not let it fail `init`. */
async function installLoginAutostart(): Promise<string> {
  switch (autostartPlatform(platform())) {
    case "windows": return installWindowsAutostart();
    case "macos": return installMacosAutostart();
    case "linux": return installLinuxAutostart();
    default: throw new Error(`no user-level login launcher is available on ${platform()}`);
  }
}

/** Best-effort removal of whatever this machine had registered. Never throws. */
async function removeLoginAutostart(): Promise<void> {
  try {
    switch (autostartPlatform(platform())) {
      case "windows": await removeWindowsAutostart(); break;
      case "macos": await removeMacosAutostart(); break;
      case "linux": await removeLinuxAutostart(); break;
      default: break;
    }
  } catch {
    /* leaving a stale launcher behind must never fail `disconnect` */
  }
}

async function runServiceCli(argv: string[]): Promise<number> {
  if (argv[0] !== "install" && argv[0] !== "uninstall" && argv[0] !== "status") {
    process.stderr.write("Usage: oathlock service install|uninstall|status\n");
    return 1;
  }
  if (autostartPlatform(platform()) === "unsupported") {
    process.stderr.write(`oathlock service ${argv[0]}: no user-level login launcher exists for ${platform()} -- 'oathlock terminal runtime' still works, it just needs to be started once per login.\n`);
    return 1;
  }
  if (argv[0] === "install") {
    try {
      const mechanism = await installLoginAutostart();
      process.stdout.write(`M9R Runtime will now start hidden at login (${mechanism}). Log off and back on to verify, or run: m9r service status\n`);
      return 0;
    } catch (error) {
      process.stderr.write(`oathlock service install: could not register the login launcher (${error instanceof Error ? error.message : "unknown error"}).\n`);
      return 1;
    }
  }
  if (argv[0] === "uninstall") {
    await removeLoginAutostart();
    process.stdout.write(`Login launcher removed. M9R Runtime no longer starts automatically at login.\n`);
    return 0;
  }
  if (platform() !== "win32") {
    process.stdout.write(autostartPlatform(platform()) === "macos"
      ? `Check with: launchctl print gui/$(id -u)/${MACOS_LAUNCH_AGENT_LABEL}\n`
      : `Check with: systemctl --user status ${LINUX_SYSTEMD_UNIT_NAME}\n`);
    return 0;
  }
  try {
    const { stdout } = await powerShell(buildScheduledTaskQueryScript());
    if (stdout.trim() === "installed") {
      process.stdout.write(`Installed: hidden logon Scheduled Task "${WINDOWS_TASK_NAME}".\n`);
      return 0;
    }
  } catch {
    /* fall through to the legacy Run-key check */
  }
  try {
    const { stdout } = await execFileAsync("reg", buildRegQueryArgs());
    process.stdout.write(stdout);
    return 0;
  } catch {
    process.stdout.write(`Not installed. Run: oathlock service install\n`);
    return 0;
  }
}

async function reportTerminalState(state: string | undefined): Promise<number> {
  const sessionId = process.env.OATHLOCK_TERMINAL_SESSION_ID;
  const provider = process.env.OATHLOCK_AGENT_KIND;
  if (!sessionId) {
    process.stderr.write("terminal state: this command must run inside an M9R Runtime terminal.\n");
    return 1;
  }
  if (state !== "idle" && state !== "working" && state !== "blocked") {
    process.stderr.write("Usage: oathlock terminal state <idle|working|blocked>\n");
    return 1;
  }
  if (!isTerminalProvider(provider)) {
    process.stderr.write("terminal state: this terminal has no authorized provider identity.\n");
    return 1;
  }
  try {
    await new Promise<void>((resolveState, rejectState) => {
      const socket = new WebSocket(
        `ws://127.0.0.1:${DEFAULT_BRIDGE_PORT}/terminal`,
        [BRIDGE_PROTOCOL_VERSION, `oathlock-provider.${provider}`],
        { origin: `http://127.0.0.1:${DEFAULT_BRIDGE_PORT}` },
      );
      const timeout = setTimeout(() => {
        socket.terminate();
        rejectState(new Error("runtime request timed out"));
      }, 1_000);
      socket.once("open", () => {
        socket.send(JSON.stringify({ type: "report-state", sessionId, state }));
      });
      socket.on("message", (data) => {
        const message = JSON.parse(String(data)) as Record<string, unknown>;
        if (message.type === "state-recorded" && message.sessionId === sessionId) {
          clearTimeout(timeout);
          socket.close();
          resolveState();
        } else if (message.type === "error") {
          clearTimeout(timeout);
          socket.close();
          rejectState(new Error(typeof message.error === "string" ? message.error : "runtime rejected state"));
        }
      });
      socket.once("error", (error) => {
        clearTimeout(timeout);
        rejectState(error);
      });
    });
    return 0;
  } catch (error) {
    process.stderr.write(`terminal state: ${error instanceof Error ? error.message : "runtime unavailable"}.\n`);
    return 1;
  }
}

const argv = process.argv.slice(2);
async function runVendorLaunch(args: string[]): Promise<number> {
  const vendorValue = args[0];
  if (vendorValue !== "claude" && vendorValue !== "codex") {
    process.stderr.write("Usage: m9r launch <claude|codex> [--profile web-only|hands] [--allow-api-key]\n");
    return 2;
  }
  const vendor: M9rLaunchVendor = vendorValue;
  let profile: M9rLaunchProfile = "web-only";
  let allowApiKey = false;
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === "--allow-api-key") allowApiKey = true;
    else if (args[i] === "--profile" && (args[i + 1] === "web-only" || args[i + 1] === "hands")) {
      profile = args[i + 1] as M9rLaunchProfile;
      i += 1;
    } else {
      process.stderr.write("Usage: m9r launch <claude|codex> [--profile web-only|hands] [--allow-api-key]\n");
      return 2;
    }
  }
  const blocked = apiKeyLaunchBlock(process.env, allowApiKey);
  if (blocked) {
    process.stderr.write(`${blocked}\n`);
    return 2;
  }

  const storeRoot = defaultStoreRoot(homedir(), process.env);
  const store = createLocalStore(storeRoot);
  const sessionId = randomUUID();
  const identity = store.issueIdentity(vendor, vendor === "claude" ? "claude-code" : "codex-cli", sessionId);
  const tempDir = await mkdtemp(join(tmpdir(), "m9r-launch-"));
  try {
    const compiledMcp = join(dirname(fileURLToPath(import.meta.url)), "m9r-mcp.js");
    const mcpSource = resolve(process.cwd(), "scripts", "m9r-mcp.ts");
    const mcpRegister = resolve(process.cwd(), "scripts", "register-alias.mjs");
    let mcpArgs: string[];
    try {
      await access(compiledMcp);
      mcpArgs = [compiledMcp];
    } catch {
      try { await access(mcpSource); } catch { throw new Error("M9R MCP entry is missing; install the CLI build or run from the M9R repository."); }
      mcpArgs = ["--disable-warning=ExperimentalWarning", "--import", mcpRegister, mcpSource];
    }
    const mcpEnv: Record<string, string> = { M9R_HOME: storeRoot };
    if (process.env.M9R_WEB_BROKER_PORT) mcpEnv.M9R_WEB_BROKER_PORT = process.env.M9R_WEB_BROKER_PORT;
    const plan = buildVendorLaunchPlan({
      vendor, profile, cwd: process.cwd(), mcpConfigPath: join(tempDir, "mcp.json"), promptFile: join(tempDir, "m9r-system-prompt.txt"),
      mcpCommand: process.execPath, mcpArgs, mcpEnv, sessionToken: identity.token,
    });
    if (plan.mcpConfigJson) await writeFile(join(tempDir, "mcp.json"), plan.mcpConfigJson, "utf8");
    if (plan.promptFileContent) await writeFile(join(tempDir, "m9r-system-prompt.txt"), plan.promptFileContent, "utf8");
    const binary = process.env[vendor === "claude" ? "M9R_CLAUDE_BIN" : "M9R_CODEX_BIN"]?.trim() || plan.command;
    const child = spawn(binary, plan.args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: plan.stdinPrompt ? ["pipe", "inherit", "inherit"] : "inherit",
      shell: platform() === "win32",
      windowsHide: false,
    });
    if (plan.stdinPrompt && child.stdin) {
      child.stdin.end(plan.stdinPrompt);
    }
    return await new Promise<number>((resolveCode, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolveCode(code ?? 1));
    });
  } catch (error) {
    process.stderr.write(`m9r launch failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    store.revokeIdentity(sessionId);
    await rm(tempDir, { recursive: true, force: true });
  }
}

type WebSetupManifest = {
  version: 1;
  configs: Array<{ agent: DetectableAgentKind; path: string; layout?: "legacy" | "servers"; existedBefore: boolean; beforeHash: string | null; installedHash: string; backupPath?: string }>;
  extensionPath: string;
  extensionFiles: Array<{ path: string; hash: string }>;
  extensionDirectories?: string[];
  runtimePath?: string;
  runtimeHash?: string;
  brokerConfigPath: string;
  brokerConfigHash: string;
  brokerConfigExistedBefore?: boolean;
  brokerConfigBackupPath?: string;
  brokerKeyCreated?: boolean;
  brokerKeyHash?: string;
  identityBootstrap: "installed" | "preexisting" | "not-installed";
  identityManifestHash?: string;
  browsers: WebSetupBrowser[];
};

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const canRead = async (path: string) => access(path).then(() => true).catch(() => false);
const readOptional = async (path: string) => (await canRead(path)) ? readFile(path) : null;
const writeAtomic = async (path: string, value: string | Uint8Array) => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, value);
  await rename(temporary, path);
};

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

function hasClaudeMcpEntry(raw: string): boolean {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const servers = (value as Record<string, unknown>).mcpServers;
    return typeof servers === "object" && servers !== null && !Array.isArray(servers) && Object.hasOwn(servers, "m9r");
  } catch { return false; }
}

function webMcpRuntime(): { command: string; args: readonly string[] } {
  const entry = fileURLToPath(import.meta.url);
  const installedEngine = join(defaultStoreRoot(homeDirectory(), process.env), "bin", process.platform === "win32" ? "m9r-engine.exe" : "m9r-engine");
  const builtMcp = join(dirname(entry), "m9r-mcp.js");
  const sourceMcp = join(dirname(entry), "m9r-mcp.ts");
  const currentExecutable = /^m9r-engine(?:\.exe)?$/i.test(entry.split(/[\\/]/).pop() ?? "") || /^m9r-engine(?:\.exe)?$/i.test(process.execPath.split(/[\\/]/).pop() ?? "");
  return resolveWebMcpRuntime({
    nodeCommand: process.execPath,
    ...(awaitableExists(installedEngine) ? { installedEngine } : {}),
    ...(currentExecutable ? { currentEngine: process.execPath } : {}),
    ...(awaitableExists(builtMcp) ? { compiledMcp: builtMcp } : {}),
    ...(awaitableExists(sourceMcp) ? { sourceMcp, sourceNodeArgs: process.execArgv } : {}),
  });
}

function awaitableExists(path: string): boolean {
  return existsSync(path);
}

async function detectBrowsers(): Promise<WebSetupBrowser[]> {
  if (platform() !== "win32") return [];
  const roots = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter((v): v is string => !!v);
  const candidates: Array<[WebSetupBrowser, string[]]> = [
    ["chrome", roots.map((root) => join(root, "Google", "Chrome", "Application", "chrome.exe"))],
    ["edge", roots.map((root) => join(root, "Microsoft", "Edge", "Application", "msedge.exe"))],
  ];
  const found: WebSetupBrowser[] = [];
  for (const [browser, paths] of candidates) if (paths.some(awaitableExists)) found.push(browser);
  return found;
}

async function selectWebAgents(detected: readonly DetectedAgent[]): Promise<DetectableAgentKind[]> {
  const items: DetectableAgentKind[] = ["claude-code", "codex", "opencode"];
  const names: Record<DetectableAgentKind, string> = { "claude-code": "Claude Code", codex: "Codex", opencode: "OpenCode" };
  const found = new Set(detected.map((agent) => agent.kind));
  const selected = new Set(items.filter((item) => found.has(item)));
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Non-interactive setup requires both --agents <claude-code,codex,opencode> and --yes.");
  return await new Promise((resolvePick, rejectPick) => {
    let cursor = 0;
    const render = () => {
      process.stdout.write("\x1b[2J\x1b[HSelect installed agents (arrows move, Space toggles, Enter confirms):\n\n");
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i]!;
        const missing = !found.has(item);
        const row = `${i === cursor ? "❯" : " "} [${selected.has(item) ? "x" : " "}] ${names[item]}${missing ? " (not found)" : ""}`;
        process.stdout.write(missing ? `\x1b[90m${row}\x1b[0m\n` : `${row}\n`);
      }
    };
    const stdin = process.stdin;
    const oldRaw = stdin.isRaw;
    const finish = (error?: Error) => {
      stdin.removeListener("keypress", onKey);
      if (stdin.isTTY && typeof stdin.setRawMode === "function") stdin.setRawMode(Boolean(oldRaw));
      process.stdout.write("\n");
      if (error) rejectPick(error);
      else {
        const chosen = items.filter((item) => selected.has(item));
        try { resolvePick(selectWebSetupAgents(detected, chosen)); } catch (selectionError) { rejectPick(selectionError); }
      }
    };
    const onKey = (_text: string | undefined, key: { name?: string; sequence?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === "c") { finish(new Error("Setup cancelled.")); return; }
      if (key.name === "up") cursor = (cursor + items.length - 1) % items.length;
      else if (key.name === "down") cursor = (cursor + 1) % items.length;
      else if (key.name === "space" && found.has(items[cursor]!)) {
        const item = items[cursor]!;
        if (selected.has(item)) selected.delete(item); else selected.add(item);
      } else if (key.name === "return") { finish(); return; }
      render();
    };
    // Node's readline keypress decoder is also used by existing CLI prompts.
    emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.on("keypress", onKey);
    render();
  });
}

function resolveWebConfigPaths(): Partial<Record<DetectableAgentKind, string>> {
  const home = homeDirectory();
  const configHome = process.env.CODEX_HOME?.trim() || join(home, ".codex");
  const opencodeHome = process.env.XDG_CONFIG_HOME?.trim() || process.env.APPDATA?.trim() || join(home, ".config");
  return {
    "claude-code": join(process.env.CLAUDE_CONFIG_DIR?.trim() || home, ".claude.json"),
    codex: join(configHome, "config.toml"),
    opencode: ["opencode.jsonc", "opencode.json"].map((name) => join(opencodeHome, "opencode", name)).find(awaitableExists)
      ?? join(opencodeHome, "opencode", "opencode.json"),
  };
}

function webExtensionSource(destination: string): string {
  const entry = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.M9R_EXTENSION_SOURCE?.trim(),
    join(entry, "extension"),
    resolve(entry, "..", "extensions", "browser"),
    resolve(entry, "..", "..", "extensions", "browser"),
    destination,
  ].filter((value): value is string => Boolean(value));
  return candidates.find((path) => awaitableExists(join(path, "manifest.json"))) ?? "";
}

function webBrokerRuntime(root: string, port: number): { executable: string; args: string[]; copiedBundle?: string; sourceBundle?: string } {
  const installedEngine = join(root, "bin", process.platform === "win32" ? "m9r-engine.exe" : "m9r-engine");
  if (awaitableExists(installedEngine)) return { executable: installedEngine, args: ["web", "serve", "--home", root, "--port", String(port)] };
  const sourceBundle = join(dirname(fileURLToPath(import.meta.url)), "m9r-web-broker.cjs");
  if (!awaitableExists(sourceBundle)) throw new Error("The packaged broker runtime is missing; run the CLI build and reinstall the package.");
  const copiedBundle = join(root, "web-runtime", "m9r-web-broker.cjs");
  return { executable: process.execPath, args: [copiedBundle, "--home", root, "--port", String(port)], copiedBundle, sourceBundle };
}

function formatWebPlan(
  plan: ReturnType<typeof planWebSetup>,
  mcpCommand: { command: string; args: readonly string[] },
  brokerRuntime: { executable: string; args: readonly string[] },
  root: string,
): string[] {
  const taskAction = `"${brokerRuntime.executable.replaceAll('"', '""')}" ${brokerRuntime.args.map((value) => `"${value.replaceAll('"', '""')}"`).join(" ")}`;
  const rows = ["M9R Web setup will:", `  - install/update the browser extension at ${plan.extensionPath}`, `  - allow extension ID ${plan.allowedExtensionIds[0]} on 127.0.0.1 only`, "  - register the local broker to start at Windows sign-in (current user; no admin)", "  - configure these user-level MCP entries:"];
  rows.push("  - files:");
  for (const item of plan.agentFiles) rows.push(`      ${item.path}`);
  rows.push(`      ${join(root, "web-broker.json")}`, `      ${join(root, "web-broker.key")} (generated locally; value is never shown)`, `      ${join(root, WEB_SETUP_MANIFEST)}`, `      ${plan.extensionPath}\\<packaged extension files>`);
  if (brokerRuntime.args[0]?.endsWith("m9r-web-broker.cjs")) rows.push(`      ${brokerRuntime.args[0]} (packaged local broker runtime)`);
  for (const item of plan.agentFiles) {
    rows.push(`      ${item.agent}: ${item.path}${item.layout ? ` (${item.layout} OpenCode layout)` : ""}`);
    if (item.agent === "claude-code") {
      rows.push(`        command: claude ${buildClaudeMcpRemoveArgs().join(" ")} (only if already present)`);
      rows.push(`        command: claude ${buildClaudeMcpAddArgs({ ...mcpCommand, m9rHome: plan.m9rHome }).join(" ")}`);
    }
    else rows.push("        action: add/update only the m9r MCP entry; preserve the other settings");
  }
  rows.push(`  - command: schtasks.exe /Create /SC ONLOGON /TN "${WEB_TASK_NAME}" /TR "${taskAction}" /F /RL LIMITED`);
  rows.push(`  - command: schtasks.exe /Run /TN "${WEB_TASK_NAME}"`);
  rows.push(`  - browsers: ${plan.browsers.length ? plan.browsers.join(", ") : "none detected; extension can be loaded later"}`);
  for (const browser of plan.browsers) rows.push(`      open ${browser === "chrome" ? "chrome://extensions/" : "edge://extensions/"}`);
  rows.push("  - install the existing M9R session identity bootstrap for Claude Code/Codex where selected");
  return rows;
}

async function runWebSetup(args: string[]): Promise<number> {
  if (platform() !== "win32") { process.stderr.write("M9R Web setup currently supports Windows 10/11 only.\n"); return 2; }
  const yes = args.includes("--yes") || args.includes("-y");
  const dryRun = args.includes("--dry-run");
  const requestedAgents = valueAfter(args, "--agents");
  const requestedBrowsers = valueAfter(args, "--browsers");
  if ((!process.stdin.isTTY || !process.stdout.isTTY) && (!yes || !requestedAgents)) {
    process.stderr.write("Non-interactive setup requires --agents <claude-code,codex,opencode> and --yes.\n"); return 2;
  }
  try {
    const detected = await detectInstalledAgents(probeVersion);
    const selected = requestedAgents
      ? selectWebSetupAgents(detected, parseWebSetupList(requestedAgents, ["claude-code", "codex", "opencode"], "agent"))
      : await selectWebAgents(detected);
    const installedBrowsers = await detectBrowsers();
    const browsers = requestedBrowsers
      ? parseWebSetupList(requestedBrowsers, ["chrome", "edge"], "browser") as WebSetupBrowser[]
      : installedBrowsers;
    const home = homeDirectory();
    const root = defaultStoreRoot(home, process.env);
    const extensionPath = join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "M9R", "extension");
    const extensionSource = webExtensionSource(extensionPath);
    if (!extensionSource) throw new Error("The packaged browser extension was not found. Install from the M9R package or set M9R_EXTENSION_SOURCE to its folder.");
    const runtime = webMcpRuntime();
    const port = Number(process.env.M9R_WEB_BROKER_PORT) || DEFAULT_BROKER_PORT;
    const runtimePlan = { command: runtime.command, args: runtime.args, m9rHome: root, brokerPort: port };
    const configPaths = resolveWebConfigPaths();
    const plan = planWebSetup({ detected, selectedAgents: selected, engineCommand: runtime.command, mcpArgs: runtime.args, m9rHome: root, configPaths, extensionPath, browsers, extensionId: WEB_EXTENSION_ID });
    const brokerRuntime = webBrokerRuntime(root, port);
    process.stdout.write(`${formatWebPlan(plan, runtime, brokerRuntime, root)}\n`);
    const identityAgents = selected.filter((agent) => agent === "claude-code" || agent === "codex");
    if (identityAgents.length) {
      process.stdout.write("\nExisting M9R identity bootstrap plan (preview):\n");
      await run(["setup", "--identity-only", "--agents", identityAgents.join(","), "--dry-run"], deps);
    }
    if (dryRun) { process.stdout.write("Dry run only; no files, processes, browser tabs, or login tasks were changed.\n"); return 0; }
    if (!yes && !(await deps.confirm?.("Apply this exact M9R Web setup plan?"))) { process.stdout.write("Cancelled. Nothing was changed.\n"); return 0; }

    const manifestPath = join(root, WEB_SETUP_MANIFEST);
    const previousManifest = await readOptional(manifestPath);
    const previous = previousManifest ? JSON.parse(previousManifest.toString("utf8")) as WebSetupManifest : null;
    const manifest: WebSetupManifest = previous ?? { version: 1, configs: [], extensionPath, extensionFiles: [], extensionDirectories: [], brokerConfigPath: join(root, "web-broker.json"), brokerConfigHash: "", identityBootstrap: "not-installed", browsers };
    const existingTask = await execFileAsync("schtasks.exe", ["/Query", "/TN", WEB_TASK_NAME], { windowsHide: true, timeout: 10_000 }).then(() => true).catch(() => false);
    if (existingTask && !previousManifest) throw new Error(`A Windows task named ${WEB_TASK_NAME} already exists but is not owned by this web setup; refusing to overwrite it.`);
    manifest.extensionPath = extensionPath;
    manifest.browsers = browsers;
    await writeAtomic(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    const existingExtensionManifest = join(extensionPath, "manifest.json");
    if (await canRead(existingExtensionManifest)) {
      const current = JSON.parse(await readFile(existingExtensionManifest, "utf8")) as { key?: string };
      if (!current.key || extensionIdFromManifestKey(current.key) !== WEB_EXTENSION_ID) throw new Error(`Existing extension at ${extensionPath} does not have the fixed M9R development ID; move it aside before setup.`);
    } else {
      const destinationExists = await canRead(extensionPath);
      if (destinationExists && (await readdir(extensionPath)).length > 0) throw new Error(`The extension folder ${extensionPath} already contains files but no valid M9R manifest; refusing to overwrite user data.`);
      const files: string[] = [];
      const walk = async (directory: string) => {
        for (const item of await readdir(directory, { withFileTypes: true })) {
          if (["store-assets", "test-page", ".git", "node_modules"].includes(item.name)) continue;
          const source = join(directory, item.name);
          if (item.isDirectory()) await walk(source); else files.push(source);
        }
      };
      await walk(extensionSource);
      for (const source of files) {
        const relative = source.slice(extensionSource.length + 1);
        const target = join(extensionPath, relative);
        const content = await readFile(source);
        let directory = dirname(target);
        const created = new Set(manifest.extensionDirectories ?? []);
        while (directory === extensionPath || directory.startsWith(`${extensionPath}${process.platform === "win32" ? "\\" : "/"}`)) {
          if (!await canRead(directory)) created.add(directory);
          if (directory === extensionPath) break;
          directory = dirname(directory);
        }
        manifest.extensionDirectories = [...created].sort((left, right) => right.length - left.length);
        await writeAtomic(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content);
        manifest.extensionFiles.push({ path: target, hash: digest(content) });
        await writeAtomic(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
      }
    }

    manifest.brokerConfigPath = join(root, "web-broker.json");
    const previousBrokerConfig = await readOptional(manifest.brokerConfigPath);
    if (manifest.brokerConfigExistedBefore === undefined) {
      manifest.brokerConfigExistedBefore = previousBrokerConfig !== null;
      if (previousBrokerConfig) {
        manifest.brokerConfigBackupPath = join(root, "web-backups", `broker-${randomUUID()}.bak`);
        await mkdir(dirname(manifest.brokerConfigBackupPath), { recursive: true });
        await writeFile(manifest.brokerConfigBackupPath, previousBrokerConfig);
      }
    }
    if (previous?.brokerConfigHash && previousBrokerConfig && digest(previousBrokerConfig) !== previous.brokerConfigHash) {
      throw new Error("The managed broker config changed outside M9R setup; review it before rerunning setup.");
    }
    await writeAtomic(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    const mcpConfig = JSON.stringify({ version: 1, extensionIds: [WEB_EXTENSION_ID], port }, null, 2) + "\n";
    await writeAtomic(manifest.brokerConfigPath, mcpConfig);
    manifest.brokerConfigHash = digest(mcpConfig);
    const identityManifestPath = join(root, "install-manifest.json");
    const hadIdentityManifest = await canRead(identityManifestPath);

    for (const item of plan.agentFiles) {
      const path = item.path;
      const beforeBytes = await readOptional(path);
      const beforeText = beforeBytes?.toString("utf8") ?? "";
      const priorRecord = manifest.configs.find((config) => config.agent === item.agent);
      const plannedConfig = item.agent === "codex"
        ? mergeCodexWebMcp(beforeText, runtimePlan)
        : item.agent === "opencode"
          ? mergeOpenCodeWebMcp(beforeText, item.layout ?? "legacy", runtimePlan)
          : null;
      const record: WebSetupManifest["configs"][number] = priorRecord
        ? { ...priorRecord, path, ...(item.layout ? { layout: item.layout } : {}), installedHash: plannedConfig ? digest(plannedConfig) : "" }
        : {
          agent: item.agent, path, ...(item.layout ? { layout: item.layout } : {}),
          existedBefore: beforeBytes !== null, beforeHash: beforeBytes ? digest(beforeBytes) : null, installedHash: plannedConfig ? digest(plannedConfig) : "",
        };
      if (beforeBytes && !priorRecord) {
        const backupPath = join(root, "web-backups", `${item.agent}-${randomUUID()}.bak`);
        await mkdir(dirname(backupPath), { recursive: true });
        await writeFile(backupPath, beforeBytes);
        record.backupPath = backupPath;
      }
      manifest.configs = manifest.configs.filter((config) => config.agent !== item.agent);
      manifest.configs.push(record);
      await writeAtomic(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
      if (item.agent === "claude-code") {
        const claude = detected.find((agent) => agent.kind === item.agent);
        if (!claude) throw new Error("Claude Code disappeared during setup.");
        const currentEntry = hasClaudeMcpEntry(beforeText);
        if (currentEntry) {
          await execFileAsync(claude.binary, buildClaudeMcpRemoveArgs(), { shell: true, windowsHide: true, timeout: 20_000 });
          const afterRemove = await readOptional(path);
          if (afterRemove) {
            record.installedHash = digest(afterRemove);
            manifest.configs = manifest.configs.map((config) => config.agent === item.agent ? record : config);
            await writeAtomic(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
          }
        }
        const { stdout } = await execFileAsync(claude.binary, buildClaudeMcpAddArgs(runtimePlan), { shell: true, windowsHide: true, timeout: 20_000 });
        void stdout;
      } else if (item.agent === "codex") {
        await writeAtomic(path, plannedConfig ?? beforeText);
      } else {
        await writeAtomic(path, plannedConfig ?? beforeText);
      }
      const afterBytes = await readFile(path);
      record.installedHash = digest(afterBytes);
      manifest.configs = manifest.configs.map((config) => config.agent === item.agent ? record : config);
      await writeAtomic(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    }

    if (identityAgents.length) {
      const identityExit = await run(["setup", "--identity-only", "--agents", identityAgents.join(","), "--yes"], deps);
      if (identityExit !== 0) throw new Error("The M9R session identity bootstrap failed; review the setup output before retrying.");
      manifest.identityBootstrap = manifest.identityBootstrap === "installed" || !hadIdentityManifest ? "installed" : "preexisting";
      if (manifest.identityBootstrap === "installed") {
        const identityManifest = await readOptional(identityManifestPath);
        manifest.identityManifestHash = identityManifest ? digest(identityManifest) : undefined;
      }
      await writeAtomic(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    }

    const keyPath = brokerKeyPath(root);
    const hadBrokerKey = await canRead(keyPath);
    const key = loadOrCreateBrokerKey(keyPath);
    manifest.brokerKeyCreated = manifest.brokerKeyCreated ?? !hadBrokerKey;
    manifest.brokerKeyHash = digest(key);
    await writeAtomic(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    const brokerExe = brokerRuntime.executable;
    const brokerArgs = [...brokerRuntime.args];
    if (brokerRuntime.copiedBundle && brokerRuntime.sourceBundle) {
      const runtimePath = brokerRuntime.copiedBundle;
      const oldRuntime = await readOptional(runtimePath);
      if (oldRuntime && manifest.runtimeHash && digest(oldRuntime) !== manifest.runtimeHash) throw new Error("The managed broker runtime changed outside M9R setup; it was not overwritten.");
      const runtimeBytes = await readFile(brokerRuntime.sourceBundle);
      await mkdir(dirname(runtimePath), { recursive: true });
      await writeFile(runtimePath, runtimeBytes);
      manifest.runtimePath = runtimePath;
      manifest.runtimeHash = digest(runtimeBytes);
      await writeAtomic(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    }
    const taskAction = `"${brokerExe.replaceAll('"', '""')}" ${brokerArgs.map((value) => `"${value.replaceAll('"', '""')}"`).join(" ")}`;
    await execFileAsync("schtasks.exe", ["/Create", "/SC", "ONLOGON", "/TN", WEB_TASK_NAME, "/TR", taskAction, "/F", "/RL", "LIMITED"], { windowsHide: true, timeout: 20_000 });
    await execFileAsync("schtasks.exe", ["/Run", "/TN", WEB_TASK_NAME], { windowsHide: true, timeout: 20_000 });
    const healthUrl = `http://127.0.0.1:${port}/health`;
    let brokerReady = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try { brokerReady = (await fetch(healthUrl, { signal: AbortSignal.timeout(500) })).ok; } catch { /* keep polling */ }
      if (brokerReady) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
    const statusResponse = brokerReady ? await fetch(`http://127.0.0.1:${port}/web/status`, { headers: { "x-m9r-key": key }, signal: AbortSignal.timeout(1_000) }).catch(() => null) : null;
    const status = statusResponse?.ok ? await statusResponse.json() as { extensionReady?: boolean } : null;
    await writeAtomic(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    process.stdout.write(`\n[${brokerReady ? "PASS" : "FAIL"}] local broker health check\n`);
    process.stdout.write(`[${status ? "PASS" : "FAIL"}] authenticated broker status check\n`);
    for (const item of plan.agentFiles) {
      let configured = false;
      if (item.agent === "claude-code") {
        configured = hasClaudeMcpEntry((await readOptional(item.path))?.toString("utf8") ?? "");
      } else {
        const raw = (await readOptional(item.path))?.toString("utf8") ?? "";
        configured = item.agent === "codex" ? removeCodexWebMcp(raw) !== raw : removeOpenCodeWebMcp(raw, item.layout ?? "legacy") !== raw;
      }
      process.stdout.write(`[${configured ? "PASS" : "FAIL"}] ${item.agent} MCP configuration\n`);
    }
    process.stdout.write(`[${status?.extensionReady ? "PASS" : "WAIT"}] extension ready handshake${status?.extensionReady ? "" : " (load unpacked once below)"}\n`);
    if (!brokerReady || !status) return 1;

    const clipboard = spawn("clip.exe", [], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    clipboard.stdin?.end(`${extensionPath}\r\n`);
    for (const browser of browsers) {
      const programFiles = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter((v): v is string => !!v);
      const exeNames = browser === "chrome" ? ["Google\\Chrome\\Application\\chrome.exe"] : ["Microsoft\\Edge\\Application\\msedge.exe"];
      const executable = programFiles.map((base) => join(base, exeNames[0]!)).find(awaitableExists);
      if (executable) spawn(executable, [browser === "chrome" ? "chrome://extensions/" : "edge://extensions/"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    }
    process.stdout.write(`\nManual browser step: open ${extensionPath} from the clipboard in Extensions > Developer mode > Load unpacked, then allow the requested site.\n`);
    process.stdout.write("First task: ask your agent to open https://en.wikipedia.org and read the heading.\n");
    if (selected.includes("opencode")) process.stdout.write("Note: OpenCode MCP is configured, but this build has no OpenCode SessionStart identity hook; authenticated M9R web tools need that bootstrap.\n");
    return 0;
  } catch (error) {
    process.stderr.write(`M9R web setup failed: ${error instanceof Error ? error.message : "unknown error"}. No secret values were displayed.\n`);
    return 1;
  }
}

async function runWebUninstall(args: string[]): Promise<number> {
  if (platform() !== "win32") { process.stderr.write("M9R Web uninstall currently supports Windows 10/11 only.\n"); return 2; }
  const root = defaultStoreRoot(homeDirectory(), process.env);
  const manifestPath = join(root, WEB_SETUP_MANIFEST);
  let manifest: WebSetupManifest;
  try { manifest = JSON.parse(await readFile(manifestPath, "utf8")) as WebSetupManifest; }
  catch { process.stderr.write("No M9R Web setup manifest was found.\n"); return 1; }
  process.stdout.write("M9R Web uninstall will remove the managed login task, broker and extension files, and these MCP entries:\n");
  for (const config of manifest.configs) process.stdout.write(`  - ${config.agent}: ${config.path}\n`);
  if (manifest.identityBootstrap === "installed") process.stdout.write("  - the M9R identity bootstrap installed by this setup\n");
  if (!args.includes("--yes") && !args.includes("-y") && !(await deps.confirm?.("Apply this exact M9R Web removal plan?"))) { process.stdout.write("Cancelled. Nothing was changed.\n"); return 0; }
  const port = Number(process.env.M9R_WEB_BROKER_PORT) || DEFAULT_BROKER_PORT;
  try {
    const key = (await readFile(brokerKeyPath(root), "utf8")).trim();
    await fetch(`http://127.0.0.1:${port}/web/shutdown`, { method: "POST", headers: { "x-m9r-key": key }, signal: AbortSignal.timeout(1_000) }).catch(() => undefined);
  } catch { /* Broker may already be stopped. */ }
  await execFileAsync("schtasks.exe", ["/End", "/TN", WEB_TASK_NAME], { windowsHide: true }).catch(() => undefined);
  await execFileAsync("schtasks.exe", ["/Delete", "/TN", WEB_TASK_NAME, "/F"], { windowsHide: true }).catch(() => undefined);
  for (const config of manifest.configs) {
    const current = await readOptional(config.path);
    const action = webConfigUninstallMode({ existedBefore: config.existedBefore, currentHash: current ? digest(current) : null, installedHash: config.installedHash });
    if (action === "restore-backup" && config.backupPath && await canRead(config.backupPath)) await writeAtomic(config.path, await readFile(config.backupPath));
    else if (action === "delete-created-file") await unlink(config.path).catch(() => undefined);
    else if (action === "remove-managed-entry" && current) {
      const text = current.toString("utf8");
      const after = config.agent === "codex" ? removeCodexWebMcp(text) : config.agent === "opencode" ? removeOpenCodeWebMcp(text, config.layout ?? "legacy") : null;
      if (after !== null) await writeAtomic(config.path, after);
      else {
        const claude = await detectInstalledAgents(probeVersion).then((agents) => agents.find((agent) => agent.kind === "claude-code"));
        if (claude && hasClaudeMcpEntry(text)) {
          const removed = await execFileAsync(claude.binary, buildClaudeMcpRemoveArgs(), { shell: true, windowsHide: true, timeout: 20_000 }).then(() => true).catch(() => false);
          if (!removed) process.stdout.write(`  [KEEP] Could not remove Claude's managed entry; review it with: claude mcp list\n`);
        } else if (!claude) process.stdout.write(`  [KEEP] Claude Code is unavailable; review its entry with: claude mcp list\n`);
      }
    }
    if (config.backupPath) await unlink(config.backupPath).catch(() => undefined);
  }
  for (const file of manifest.extensionFiles) {
    const current = await readOptional(file.path);
    if (current && digest(current) === file.hash) await unlink(file.path).catch(() => undefined);
  }
  for (const directory of manifest.extensionDirectories ?? []) await rmdir(directory).catch(() => undefined);
  if (manifest.runtimePath && manifest.runtimeHash) {
    const current = await readOptional(manifest.runtimePath);
    if (current && digest(current) === manifest.runtimeHash) await unlink(manifest.runtimePath).catch(() => undefined);
  }
  const brokerConfig = await readOptional(manifest.brokerConfigPath);
  const brokerAction = webConfigUninstallMode({ existedBefore: manifest.brokerConfigExistedBefore === true, currentHash: brokerConfig ? digest(brokerConfig) : null, installedHash: manifest.brokerConfigHash });
  if (brokerAction === "restore-backup" && manifest.brokerConfigBackupPath && await canRead(manifest.brokerConfigBackupPath)) await writeAtomic(manifest.brokerConfigPath, await readFile(manifest.brokerConfigBackupPath));
  else if (brokerAction === "delete-created-file") await unlink(manifest.brokerConfigPath).catch(() => undefined);
  if (manifest.brokerConfigBackupPath) await unlink(manifest.brokerConfigBackupPath).catch(() => undefined);
  if (manifest.brokerKeyCreated && manifest.brokerKeyHash) {
    const keyPath = brokerKeyPath(root);
    const keyBytes = await readOptional(keyPath);
    if (keyBytes && digest(keyBytes.toString("utf8").trim()) === manifest.brokerKeyHash) await unlink(keyPath).catch(() => undefined);
  }
  if (manifest.identityBootstrap === "installed") {
    const identityManifestPath = join(root, "install-manifest.json");
    const currentIdentityManifest = await readOptional(identityManifestPath);
    if (currentIdentityManifest && digest(currentIdentityManifest) === manifest.identityManifestHash) {
      const code = await run(["uninstall", "--yes"], deps);
      if (code !== 0) process.stdout.write("  [KEEP] Native identity bootstrap needs manual review via m9r uninstall.\n");
    } else {
      process.stdout.write("  [KEEP] Native identity setup changed since web setup; preserved it instead of removing later user changes.\n");
    }
  } else if (manifest.identityBootstrap === "preexisting") {
    process.stdout.write("  [KEEP] Existing native M9R identity setup was left untouched.\n");
  }
  await unlink(manifestPath);
  process.stdout.write("M9R Web-managed setup was removed; files changed by you since setup were preserved.\n");
  return 0;
}

async function runWebBrokerServer(args: string[]): Promise<number> {
  const home = valueAfter(args, "--home") || defaultStoreRoot(homeDirectory(), process.env);
  const configuredPort = valueAfter(args, "--port");
  process.env.M9R_HOME = home;
  if (configuredPort) process.env.M9R_WEB_BROKER_PORT = configuredPort;
  const root = defaultStoreRoot(homeDirectory(), process.env);
  const key = loadOrCreateBrokerKey(brokerKeyPath(root));
  const authorityStore = createWebAuthorityStore(root);
  const authority = createWebAuthority({ ownerId: process.env.M9R_OWNER_ID?.trim() || "local-machine" });
  authority.restore(authorityStore.load());
  const port = Number(process.env.M9R_WEB_BROKER_PORT) || DEFAULT_BROKER_PORT;
  const broker = await startWebBroker({ key, port, host: "127.0.0.1", allowedExtensionIds: [WEB_EXTENSION_ID], ownerId: "local-machine", authority, authorityStore });
  process.stdout.write(`M9R web broker listening on 127.0.0.1:${broker.port}\n`);
  const stop = () => void broker.close().then(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return await new Promise<number>((resolveServer) => {
    process.once("exit", () => resolveServer(0));
  });
}

async function runWebCli(args: string[]): Promise<number> {
  if (args[0] === "setup") return runWebSetup(args.slice(1));
  if (args[0] === "uninstall") return runWebUninstall(args.slice(1));
  if (args[0] === "serve") return runWebBrokerServer(args.slice(1));
  const root = defaultStoreRoot(homedir(), process.env);
  let key: string;
  try {
    key = (await readFile(brokerKeyPath(root), "utf8")).trim();
  } catch {
    process.stderr.write("M9R web broker key is missing; start the local web broker first.\n");
    return 1;
  }
  const port = Number(process.env.M9R_WEB_BROKER_PORT) || DEFAULT_BROKER_PORT;
  const terminal = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  return runWebAuthorityCli(args, {
    port,
    key,
    fetch: globalThis.fetch,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    canApprove: terminal && !isAgentContext(process.env) && isHumanContext({ hasTerminal: terminal, env: process.env }),
    confirm: deps.confirm,
  });
}

const execution = argv[0] === "setup" && argv.includes("--web")
  ? runWebSetup(argv.filter((arg) => arg !== "--web").slice(1))
  : argv[0] === "resident"
  ? runResidentCli(argv.slice(1))
  : argv[0] === "service"
    ? runServiceCli(argv.slice(1))
  : argv[0] === "terminal" && argv[1] === "state"
    ? reportTerminalState(argv[2])
  : argv[0] === "terminal" && (argv[1] === "runtime" || argv[1] === "bridge")
    ? startTerminalRuntime({ localOnly: argv.includes("--local-only") })
  : argv[0] === "watchdog" && argv[1] === "run"
    ? runWatchdog()
    : argv[0] === "web"
      ? runWebCli(argv.slice(1))
    : argv[0] === "launch"
      ? runVendorLaunch(argv.slice(1))
    : run(argv, deps);

/** `--no-autostart` declines; an interactive terminal is asked (default yes); a script keeps the disclosed default. */
async function autostartConsented(): Promise<boolean> {
  if (argv.includes("--no-autostart")) return false;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return true;
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question("Start the M9R runtime automatically at login? [Y/n] ")).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

async function ensureRuntimeAfterAgentCommand(): Promise<void> {
  const result = await ensureLocalTerminalRuntime({
    probe: async (url) => {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(500) });
        return response.ok;
      } catch {
        return false;
      }
    },
    spawn: () => {
      // process.execArgv carries whatever flags actually started THIS
      // process (e.g. --import .../register-alias.mjs, --disable-warning=...
      // from the `oathlock` npm script) -- a raw .ts entry needs those to
      // resolve its own path-aliased imports. Without them the relaunched
      // process throws on its first import and exits immediately;
      // combined with stdio: "ignore" below, that crash was completely
      // silent, so `doctor`/`inbox`/`rules`/`run start` looked like they
      // relaunched the runtime when the child was actually dead on arrival.
      // Same detached, console-free spawn the watchdog uses -- see
      // spawnDetachedOathlockCommand for why `cmd /c start /b` is wrong here.
      spawnDetachedOathlockCommand(["terminal", "runtime"]);
    },
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  if (argv[0] === "init") {
    deps.out(result === "failed"
      ? "Connection succeeded, but M9R Runtime could not start automatically. Run: m9r terminal runtime"
      : `M9R Runtime ${result === "started" ? "started" : "already running"}; Watchfloor terminals can attach automatically.`);
  }
  // A persistent login launcher (Scheduled Task / LaunchAgent / systemd user
  // unit / crontab) is a real, disclosed change to the machine -- it must only
  // happen from `init`, the one command whose whole
  // purpose is "set this connection up," never silently from commands that
  // are documented (and used) as read-only checks (`doctor`) or routine
  // agent-loop calls (`rules`/`inbox`/`run start`). It previously self-healed
  // on every trigger, which meant `doctor` -- described in cli/README.md as
  // checking things "without changing anything" -- could write a login-
  // startup registry key with no message shown. If init's install failed or
  // was skipped, the fix is the explicit, user-invoked `oathlock service
  // install`, not a silent retry buried in unrelated commands.
  if (argv[0] === "init") {
    // Additive, never a gate: onboarding has already succeeded by this point,
    // so a refused Scheduled Task / missing launchctl / no-systemd box gets a
    // warning and the manual command, not a failed `init`.
    try {
      if (!(await autostartConsented())) {
        deps.out("Login startup skipped. The runtime will not return after a reboot; run: m9r service install");
        return;
      }
      const mechanism = await installLoginAutostart();
      deps.out(`Login startup is installed (${mechanism}); the runtime will return automatically after a reboot. Remove it any time with: m9r disconnect`);
    } catch (error) {
      deps.err(`Login startup could not be installed automatically (${error instanceof Error ? error.message : "unknown error"}). Run: oathlock service install`);
    }
  } else if (platform() === "win32" && result !== "failed") {
    // Either mechanism counts as installed: init prefers the Scheduled Task
    // but falls back to the Run key, so checking only one produces a false
    // "not set to start at login" nag on a perfectly configured machine.
    const taskInstalled = await powerShell(buildScheduledTaskQueryScript())
      .then(({ stdout }) => stdout.trim() === "installed")
      .catch(() => false);
    if (!taskInstalled) {
      try {
        await execFileAsync("reg", buildRegQueryArgs());
      } catch {
        deps.out("Note: M9R Runtime is not set to start at login. Run: m9r service install");
      }
    }
  }
}

execution
  .then(async (code) => {
    const runtimeTrigger = argv[0] === "init" || argv[0] === "rules" || argv[0] === "inbox"
      || (argv[0] === "run" && argv[1] === "start");
    if (code === 0 && runtimeTrigger) {
      await ensureRuntimeAfterAgentCommand();
    }
    // Disconnecting a workspace must not leave a login launcher pointed at a
    // connection that no longer exists. Best-effort by the same rule as
    // install: a failed cleanup warns, it does not fail `disconnect`.
    if (code === 0 && argv[0] === "disconnect") {
      await removeLoginAutostart();
      process.stdout.write("Login startup entry removed; the runtime will no longer start at login.\n");
    }
    process.exitCode = code;
  })
  .catch((e) => {
    process.stderr.write(`oathlock: unexpected error: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  });
