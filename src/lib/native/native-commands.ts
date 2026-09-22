/**
 * `m9r-cli setup`, `m9r-cli uninstall`, `m9r-cli send` and the native status block (design sections 8 and 20). File-writing, but
 * every decision about what to write comes from the tested pure cores in `install-core` and `local-store`.
 *
 * Rules: show the plan and ask before writing; compute every new file before writing any (so a bad file stops the
 * whole run with nothing half-done); back up every file that existed; record what was written so uninstall can put it
 * back exactly. Local mode needs no account and no network.
 */
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
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
  removeHooks,
  removeStandingInstruction,
  sha256,
  standingInstructionStatus,
  type HookSpec,
  type ManifestEntry,
} from "./install-core";
import { createLocalStore, defaultStoreRoot, handleForProvider } from "./local-store";
import { codexHome, deliverToCodex, realDeps, spawnDeliveryRunner, type DeliveryDeps } from "./codex-delivery";
import { codexNoteInEffect, createCodexWatcher } from "./codex-watch";
import { hookPipePath, requestShutdown, startHookServer } from "./hook-server";
import { runHookRequest } from "./hook-run";
import { canQueue } from "./codex-delivery-core";
import { isHumanContext, isProtectedAction } from "./approval-core";
import { runAllow, runDecision, runLink, runRevoke, runRules, runSessions, runSessionsJson, runTasks, runUnlink } from "./approval-commands";
import { acquireFeedLock, feedPath, runFeed } from "./feed-writer";
import { USER_STEPS } from "./onboarding-steps";

export interface NativeIo {
  env: Record<string, string | undefined>;
  homeDir: string;
  out(line: string): void;
  err(line: string): void;
  /** Interactive yes/no; absent when there is no terminal, in which case `--yes` is required. */
  confirm?(question: string): Promise<boolean>;
  /** Codex delivery dependencies; tests inject fakes, production uses the real `codex queue`. */
  codexDeps?: DeliveryDeps;
  /** Where the command was run; the default is the process's own folder. Used to pick between several open sessions. */
  cwd?: string;
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

type Kind = "hooks-json" | "markdown-block";
interface Manifest { version: 1; installedAt: string; entries: Array<ManifestEntry & { kind: Kind }>; /** Hook program files M9R copied into its own folder; removed on uninstall. */ runtimeFiles?: string[]; /** M9R starts when you sign in to Windows (removed on uninstall). */ autostart?: boolean }

export function nativePaths(io: Pick<NativeIo, "env" | "homeDir">) {
  const m9r = defaultStoreRoot(io.homeDir, io.env);
  const claude = io.env.CLAUDE_CONFIG_DIR?.trim() || join(io.homeDir, ".claude");
  const codex = io.env.CODEX_HOME?.trim() || join(io.homeDir, ".codex");
  return { m9r, claude, codex, codexHooks: join(codex, "hooks.json"), codexAgents: join(codex, "AGENTS.md"), settings: join(claude, "settings.json"), claudeMd: join(claude, "CLAUDE.md"), manifest: join(m9r, "install-manifest.json"), backups: join(m9r, "backups") };
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
export const HOOK_RUNTIME_FILES = ["m9r-hook.js", "local-store.js", "hook-handler.js", "hook-run.js", "inbox-core.js", "mention-core.js", "memory-hint-core.js", "codex-delivery-core.js", "codex-delivery.js", "codex-liveness.js", "approval-core.js", "risk-core.js"] as const;

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
  if (await requestShutdown(hookPipePath(nativePaths(io).m9r))) await new Promise((r) => setTimeout(r, 900));
}

const sameFile = (a: string, b: string): boolean => {
  try { return statSync(a).size === statSync(b).size && createHash("sha256").update(readFileSync(a)).digest("hex") === createHash("sha256").update(readFileSync(b)).digest("hex"); } catch { return false; }
};

function runtimePlan(io: NativeIo): { needed: boolean; sourceDir: string; targetDir: string; missingSource: string[]; engine?: { from: string; to: string }; shim?: { from: string; to: string } } {
  const targetDir = join(nativePaths(io).m9r, "bin");
  const engine = engineSource(io.env);
  if (engine && !io.env.M9R_HOOK_ENTRY?.trim()) {
    const to = engineTarget(io);
    const shimFrom = shimSource(io.env);
    const shim = shimFrom ? { from: shimFrom, to: shimTarget(io) } : undefined;
    return { needed: !sameFile(engine, to) || (!!shim && !sameFile(shim.from, shim.to)), sourceDir: dirname(engine), targetDir, missingSource: existsSync(engine) ? [] : [engine], engine: { from: engine, to }, shim };
  }
  const sourceDir = hookSourceDir(io.env);
  if (io.env.M9R_HOOK_ENTRY?.trim()) return { needed: false, sourceDir, targetDir, missingSource: [] };
  const missingSource = HOOK_RUNTIME_FILES.filter((f) => !existsSync(join(sourceDir, f)));
  const needed = HOOK_RUNTIME_FILES.some((f) => readText(join(sourceDir, f)) !== readText(join(targetDir, f))) || !existsSync(join(targetDir, "package.json"));
  return { needed, sourceDir, targetDir, missingSource };
}

function copyRuntime(plan: { sourceDir: string; targetDir: string; engine?: { from: string; to: string }; shim?: { from: string; to: string } }): string[] {
  mkdirSync(plan.targetDir, { recursive: true });
  if (plan.engine) {
    const written = [plan.engine.to];
    copyFileSync(plan.engine.from, plan.engine.to);
    if (plan.shim) { copyFileSync(plan.shim.from, plan.shim.to); written.push(plan.shim.to); }
    return written;
  }
  const written: string[] = [];
  for (const f of HOOK_RUNTIME_FILES) { copyFileSync(join(plan.sourceDir, f), join(plan.targetDir, f)); written.push(join(plan.targetDir, f)); }
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
    // Claude only: when a turn ends, its final message answers any task another agent handed it.
    ...(provider === "claude-code" ? [{ event: "Stop", command: command("Stop"), timeoutSec: 5 }] : []),
  ];
}

/** The native hook the settings should point at: only when one ships with the engine and no override is set. */
const shimFor = (io: NativeIo): string | undefined => (!io.env.M9R_HOOK_ENTRY?.trim() && shimSource(io.env) ? shimTarget(io) : undefined);

interface PlannedFile { path: string; kind: Kind; before: string | null; after: string; changed: boolean; summary: string }

function plan(io: NativeIo): PlannedFile[] {
  const p = nativePaths(io);
  const settingsBefore = readText(p.settings);
  const settings = mergeHooks(settingsBefore, hookSpecs(activeHookEntry(io), "claude-code", shimFor(io)), p.settings);
  const mdBefore = readText(p.claudeMd);
  const md = applyStandingInstruction(mdBefore);
  const files: PlannedFile[] = [
    { path: p.settings, kind: "hooks-json", before: settingsBefore, after: settings.content, changed: settings.changed, summary: `add 3 hooks (session start, prompt submit, turn end) to ${p.settings}` },
    { path: p.claudeMd, kind: "markdown-block", before: mdBefore, after: md.content, changed: md.changed, summary: `${mdBefore == null ? "create" : "add a short block to"} ${p.claudeMd}` },
  ];
  // Codex is only touched when it is installed here (its folder exists); M9R never creates ~/.codex.
  if (existsSync(p.codex)) {
    const hooksBefore = readText(p.codexHooks);
    const codexHooks = mergeHooks(hooksBefore, hookSpecs(activeHookEntry(io), "codex", shimFor(io)), p.codexHooks);
    const agentsBefore = readText(p.codexAgents);
    const agents = applyStandingInstruction(agentsBefore, "codex");
    files.push(
      { path: p.codexHooks, kind: "hooks-json", before: hooksBefore, after: codexHooks.content, changed: codexHooks.changed, summary: `add 2 hooks (session start, prompt submit) to ${p.codexHooks} (Codex; you trust them once with /hooks)` },
      { path: p.codexAgents, kind: "markdown-block", before: agentsBefore, after: agents.content, changed: agents.changed, summary: `${agentsBefore == null ? "create" : "add a short block to"} ${p.codexAgents} (it tells Codex to leave @mentions of other agents to M9R, so nothing is done twice)` },
    );
  }
  return files;
}

function readManifest(path: string): Manifest | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as Manifest; } catch { return null; }
}

async function ask(io: NativeIo, yes: boolean, question: string): Promise<boolean> {
  if (yes) return true;
  if (!io.confirm) { io.err("No terminal to ask on. Run again with --yes to proceed."); return false; }
  return io.confirm(question);
}

export async function runSetup(io: NativeIo, flags: { yes?: boolean; dryRun?: boolean; autostart?: boolean }): Promise<number> {
  let files: PlannedFile[];
  try { files = plan(io); } catch (error) {
    if (error instanceof UnparseableConfigError) { io.err(error.message); io.err("Nothing was changed."); return 1; }
    throw error;
  }
  const p = nativePaths(io);
  const todo = files.filter((f) => f.changed);
  const runtime = runtimePlan(io);

  io.out("M9R setup (local mode: no account, no network)");
  if (runtime.missingSource.length > 0) {
    io.err(`The hook program is missing next to this CLI (${runtime.missingSource.join(", ")}). Reinstall it with: npm i -g m9r-cli`);
    io.err("Nothing was changed.");
    return 1;
  }
  if (todo.length === 0 && !runtime.needed) { io.out("Already set up. Nothing to change."); printOpenSteps(io); return 0; }
  io.out("This will:");
  if (runtime.needed) io.out(`  - copy the small hook program to ${runtime.targetDir} (so the hooks keep working even if this CLI moves or is updated)`);
  if (runtime.engine && runtime.shim) io.out("  - start the M9R background engine, which answers your agents' hooks in milliseconds (uninstall stops it)");
  for (const f of todo) io.out(`  - ${f.summary}`);
  if (todo.some((f) => f.before != null)) io.out(`  - back up each existing file to ${p.backups} first`);
  io.out("Undo anytime with: m9r-cli uninstall");
  if (flags.dryRun) { io.out("Dry run: nothing was written."); return 0; }
  if (!(await ask(io, !!flags.yes, "Go ahead?"))) { io.out("Nothing was changed."); return 1; }
  // Starting with Windows is its own, optional yes: nothing about it is implied by the rest.
  const canAutostart = !!runtime.engine && !!runtime.shim && process.platform === "win32" && !io.env.M9R_HOOK_ENTRY?.trim();
  const wantAutostart = canAutostart && (flags.autostart === true || (flags.autostart === undefined && !flags.yes && !!io.confirm && (await io.confirm("Also start M9R when you sign in to Windows, so it is ready before your first prompt? (Uninstall turns this off.)"))));

  mkdirSync(p.backups, { recursive: true });
  const manifest: Manifest = readManifest(p.manifest) ?? { version: 1, installedAt: new Date().toISOString(), entries: [] };
  // The hook program goes first, so a hook can never point at a file that is not there yet.
  if (runtime.needed) {
    if (runtime.engine) await stopResidentEngine(io);
    manifest.runtimeFiles = copyRuntime(runtime);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const f of todo) {
    const existing = manifest.entries.find((e) => e.path === f.path);
    let entry: ManifestEntry & { kind: Kind };
    if (existing) {
      entry = { ...existing, sha256After: sha256(f.after) };
      manifest.entries = manifest.entries.filter((e) => e.path !== f.path);
    } else {
      let backupPath: string | null = null;
      if (f.before != null) { backupPath = join(p.backups, `${stamp}-${basename(f.path)}`); copyFileSync(f.path, backupPath); }
      entry = { path: f.path, kind: f.kind, existedBefore: f.before != null, backupPath, sha256After: sha256(f.after) };
    }
    mkdirSync(dirname(f.path), { recursive: true });
    writeFileSync(f.path, f.after, "utf8");
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
  writeFileSync(p.manifest, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  createLocalStore(p.m9r); // make sure the local store folder exists
  if (runtime.engine && runtime.shim && !io.env.M9R_NO_DAEMON) warmUpAndStart(io, runtime.shim.to, runtime.engine.to);
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
  for (const s of USER_STEPS.filter((x) => x.id !== "install")) io.out(`  - ${s.title}${s.fix ? `: ${s.fix}` : ""}`);
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
      const result = e.kind === "hooks-json" ? removeHooks(current, e.path) : removeStandingInstruction(current);
      if (result.changed) writeFileSync(e.path, result.content, "utf8");
      io.out(`Removed M9R's entries from ${e.path}; your own edits were kept.`);
    }
  }
  // Only what this install turned on: a scratch install's uninstall must never switch off the real one.
  if (manifest.autostart) autostartOf(io).disable();
  if ((manifest.runtimeFiles ?? []).length > 0) await stopResidentEngine(io);
  for (const f of manifest.runtimeFiles ?? []) rmSync(f, { force: true });
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
  const { task, created } = store.addTask({ from: input.from ?? (human ? "you" : "agent"), to: handleForProvider(to), goal: input.text, origin: human ? "human_typed" : "agent_initiated", cwd: io.cwd ?? process.cwd(), ...(input.session ? { targetSession: input.session } : {}), idempotencyKey: input.key ?? randomUUID() });
  if (task.approval === "pending") {
    io.out(`Task ${task.id} to @${task.to} is waiting for the user's approval; nothing was delivered.`);
    io.out(`Tell the user to run: m9r-cli approve ${task.id}${isProtectedAction(task.goal) ? "  (it looks like a protected action, so a standing rule would not cover it)" : ""}`);
    return 0;
  }
  if (task.to === "codex" && created && canQueue(task)) {
    const outcome = await deliverToCodex(store, task.id, io.codexDeps ?? realDeps(io.env));
    if (outcome.state === "queued") { io.out(`Sent to @codex as task ${task.id} and pushed into its session; it runs there now. The answer reaches ${task.from === "you" ? "your" : `@${task.from}'s`} inbox.`); return 0; }
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
  const pending = endpoints.reduce((n, e) => n + store.tasksFor(e.handle).filter((t) => t.approval !== "denied" && t.approval !== "expired" && store.cursorFor(e.handle) < t.seq).length, 0);
  if (pending > 0) rows.push({ id: "pending", state: "info", label: `${pending} task(s) waiting in inboxes` });
  return rows;
}

export function printNativeStatus(io: NativeIo): void {
  io.out("Native front door (local mode)");
  for (const r of nativeStatus(io)) io.out(`[${r.state === "ok" ? "PASS" : r.state === "todo" ? "TODO" : "INFO"}] ${r.label}${r.fix ? `  ->  ${r.fix}` : ""}`);
  for (const s of USER_STEPS.filter((x) => x.id === "new-session" || x.id === "codex-trust")) io.out(`[YOU ] ${s.title}${s.fix ? `  ->  ${s.fix}` : ""}`);
}

/** Argument handling for the four commands, kept here so the big CLI core only forwards `rest`. */
export async function runNativeCommand(command: string, rest: string[], io: NativeIo): Promise<number> {
  const has = (...names: string[]) => rest.some((a) => names.includes(a));
  const value = (name: string) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i += 1) { if (rest[i].startsWith("-")) { if (["--from", "--key", "--for", "--session"].includes(rest[i])) i += 1; continue; } positionals.push(rest[i]); }
  if (command === "setup") {
    if (has("--status")) { printNativeStatus(io); return 0; }
    return runSetup(io, { yes: has("--yes", "-y"), dryRun: has("--dry-run"), autostart: has("--autostart") ? true : undefined });
  }
  if (command === "uninstall") return runUninstall(io, { yes: has("--yes", "-y"), purge: has("--purge") });
  if (command === "send") return runSend(io, { to: positionals[0] ?? "", text: positionals.slice(1).join(" "), from: value("--from"), key: value("--key"), session: value("--session") });
  const root = nativePaths(io).m9r;
  if (command === "feed") {
    const controller = new AbortController();
    const release = has("--watch") ? acquireFeedLock(root) : () => {};
    if (!release) { io.out("The feed is already being written by another M9R process."); return 0; }
    if (has("--watch")) { process.once("SIGINT", () => controller.abort()); process.once("SIGTERM", () => controller.abort()); io.out(`Writing ${feedPath(root)} (Ctrl+C to stop)`); }
    // The Codex watcher forwards what a person types in Codex; Codex must be told to stand down or the work is done twice, so it only
    // runs when the stand-down note is installed for Codex (or a test forces it on).
    // Finding Codex sessions (so `@codex` has somewhere to go) always runs while watching. Forwarding what a person types in Codex only
    // happens for sessions where Codex was told to stand down (its AGENTS.md carries the note), or when a test forces it on.
    const routeMentions = io.env.M9R_CODEX_WATCH === "1" ? true : (cwd: string | undefined) => codexNoteInEffect(cwd, codexHome(io.env));
    const watcher = has("--watch") && !io.env.M9R_NO_CODEX_WATCH ? createCodexWatcher(createLocalStore(root), { codexHome: codexHome(io.env), routeMentions, dispatch: (id) => spawnDeliveryRunner(activeHookEntry(io), id, io.env) }) : undefined;
    const server = has("--watch") && has("--serve-hooks")
      ? startHookServer({
          path: hookPipePath(root),
          handle: (req) => runHookRequest({ event: req.event ?? "", provider: req.provider ?? "claude-code", input: req.input ?? null, env: req.env }, activeHookEntry(io), { ...io.env }, true),
          onShutdown: () => controller.abort(),
        })
      : undefined;
    await runFeed({ root, watch: has("--watch"), codexWatcher: watcher, signal: controller.signal, onWrite: has("--watch") ? (f) => io.out(`feed #${f.seq}: ${f.needsYou.length} need you`) : undefined });
    server?.close();
    release();
    if (!has("--watch")) io.out(`Wrote ${feedPath(root)}`);
    return 0;
  }
  if (command === "dismiss") { const n = createLocalStore(root).dismiss(positionals.map((p) => p.toUpperCase())); io.out(n ? `Cleared ${n} from the overlay list.` : "Nothing to clear."); return 0; }
  if (command === "tasks") return runTasks(io, root);
  if (command === "sessions") return runSessions(io, root, positionals[0]);
  if (command === "sessions-json") return runSessionsJson(io, root, positionals[0]);
  if (command === "link") return runLink(io, root, value("--from-handle"), value("--from-session"), value("--to-handle"), value("--to-session"));
  if (command === "unlink") return runUnlink(io, root, positionals[0]);
  if (command === "approve" || command === "deny") return runDecision(io, root, command === "approve" ? "approved" : "denied", positionals[0], has("--yes", "-y"));
  if (command === "allow") return runAllow(io, root, positionals[0], positionals[1], value("--for"));
  if (command === "standing") return runRules(io, root);
  if (command === "revoke") return runRevoke(io, root, positionals[0]);
  io.err(`Unknown native command: ${command}`);
  return 1;
}
