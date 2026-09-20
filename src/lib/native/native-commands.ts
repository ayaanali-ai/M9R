/**
 * `m9r-cli setup`, `m9r-cli uninstall`, `m9r-cli send` and the native status block (design sections 8 and 20). File-writing, but
 * every decision about what to write comes from the tested pure cores in `install-core` and `local-store`.
 *
 * Rules: show the plan and ask before writing; compute every new file before writing any (so a bad file stops the
 * whole run with nothing half-done); back up every file that existed; record what was written so uninstall can put it
 * back exactly. Local mode needs no account and no network.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
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
import { deliverToCodex, realDeps, type DeliveryDeps } from "./codex-delivery";
import { canQueue } from "./codex-delivery-core";
import { isHumanContext, isProtectedAction } from "./approval-core";
import { runAllow, runDecision, runRevoke, runRules, runSessions, runTasks } from "./approval-commands";
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
}

type Kind = "hooks-json" | "markdown-block";
interface Manifest { version: 1; installedAt: string; entries: Array<ManifestEntry & { kind: Kind }>; /** Hook program files M9R copied into its own folder; removed on uninstall. */ runtimeFiles?: string[] }

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
export const HOOK_RUNTIME_FILES = ["m9r-hook.js", "local-store.js", "hook-handler.js", "inbox-core.js", "mention-core.js", "memory-hint-core.js", "codex-delivery-core.js", "codex-delivery.js", "approval-core.js"] as const;

function hookSourceDir(env: Record<string, string | undefined>): string {
  return env.M9R_HOOK_SOURCE?.trim() || dirname(hookEntryPath(env));
}

/** Where the hooks run from: an explicit override (tests, development) or M9R's own stable folder. */
export function activeHookEntry(io: Pick<NativeIo, "env" | "homeDir">): string {
  if (io.env.M9R_HOOK_ENTRY?.trim()) return io.env.M9R_HOOK_ENTRY.trim();
  return join(nativePaths(io).m9r, "bin", "m9r-hook.js");
}

function runtimePlan(io: NativeIo): { needed: boolean; sourceDir: string; targetDir: string; missingSource: string[] } {
  const targetDir = join(nativePaths(io).m9r, "bin");
  const sourceDir = hookSourceDir(io.env);
  if (io.env.M9R_HOOK_ENTRY?.trim()) return { needed: false, sourceDir, targetDir, missingSource: [] };
  const missingSource = HOOK_RUNTIME_FILES.filter((f) => !existsSync(join(sourceDir, f)));
  const needed = HOOK_RUNTIME_FILES.some((f) => readText(join(sourceDir, f)) !== readText(join(targetDir, f))) || !existsSync(join(targetDir, "package.json"));
  return { needed, sourceDir, targetDir, missingSource };
}

function copyRuntime(plan: { sourceDir: string; targetDir: string }): string[] {
  mkdirSync(plan.targetDir, { recursive: true });
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

function hookSpecs(entry: string, provider = "claude-code"): HookSpec[] {
  const command = (event: string) => `node "${slash(entry)}" ${event} ${provider}`;
  return [
    { event: "SessionStart", command: command("SessionStart"), timeoutSec: 5 },
    { event: "UserPromptSubmit", command: command("UserPromptSubmit"), timeoutSec: 5 },
  ];
}

interface PlannedFile { path: string; kind: Kind; before: string | null; after: string; changed: boolean; summary: string }

function plan(io: NativeIo): PlannedFile[] {
  const p = nativePaths(io);
  const settingsBefore = readText(p.settings);
  const settings = mergeHooks(settingsBefore, hookSpecs(activeHookEntry(io)), p.settings);
  const mdBefore = readText(p.claudeMd);
  const md = applyStandingInstruction(mdBefore);
  const files: PlannedFile[] = [
    { path: p.settings, kind: "hooks-json", before: settingsBefore, after: settings.content, changed: settings.changed, summary: `add 2 hooks (session start, prompt submit) to ${p.settings}` },
    { path: p.claudeMd, kind: "markdown-block", before: mdBefore, after: md.content, changed: md.changed, summary: `${mdBefore == null ? "create" : "add a short block to"} ${p.claudeMd}` },
  ];
  // Codex is only touched when it is installed here (its folder exists); M9R never creates ~/.codex.
  if (existsSync(p.codex)) {
    const hooksBefore = readText(p.codexHooks);
    const codexHooks = mergeHooks(hooksBefore, hookSpecs(activeHookEntry(io), "codex"), p.codexHooks);
    const agentsBefore = readText(p.codexAgents);
    const agents = applyStandingInstruction(agentsBefore);
    files.push(
      { path: p.codexHooks, kind: "hooks-json", before: hooksBefore, after: codexHooks.content, changed: codexHooks.changed, summary: `add 2 hooks (session start, prompt submit) to ${p.codexHooks} (Codex; you trust them once with /hooks)` },
      { path: p.codexAgents, kind: "markdown-block", before: agentsBefore, after: agents.content, changed: agents.changed, summary: `${agentsBefore == null ? "create" : "add a short block to"} ${p.codexAgents}` },
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

export async function runSetup(io: NativeIo, flags: { yes?: boolean; dryRun?: boolean }): Promise<number> {
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
  for (const f of todo) io.out(`  - ${f.summary}`);
  if (todo.some((f) => f.before != null)) io.out(`  - back up each existing file to ${p.backups} first`);
  io.out("Undo anytime with: m9r-cli uninstall");
  if (flags.dryRun) { io.out("Dry run: nothing was written."); return 0; }
  if (!(await ask(io, !!flags.yes, "Go ahead?"))) { io.out("Nothing was changed."); return 1; }

  mkdirSync(p.backups, { recursive: true });
  const manifest: Manifest = readManifest(p.manifest) ?? { version: 1, installedAt: new Date().toISOString(), entries: [] };
  // The hook program goes first, so a hook can never point at a file that is not there yet.
  if (runtime.needed) manifest.runtimeFiles = copyRuntime(runtime);
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
  writeFileSync(p.manifest, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  createLocalStore(p.m9r); // make sure the local store folder exists
  io.out("Done.");
  printOpenSteps(io);
  return 0;
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
    return runSetup(io, { yes: has("--yes", "-y"), dryRun: has("--dry-run") });
  }
  if (command === "uninstall") return runUninstall(io, { yes: has("--yes", "-y"), purge: has("--purge") });
  if (command === "send") return runSend(io, { to: positionals[0] ?? "", text: positionals.slice(1).join(" "), from: value("--from"), key: value("--key"), session: value("--session") });
  const root = nativePaths(io).m9r;
  if (command === "tasks") return runTasks(io, root);
  if (command === "sessions") return runSessions(io, root, positionals[0]);
  if (command === "approve" || command === "deny") return runDecision(io, root, command === "approve" ? "approved" : "denied", positionals[0], has("--yes", "-y"));
  if (command === "allow") return runAllow(io, root, positionals[0], positionals[1], value("--for"));
  if (command === "standing") return runRules(io, root);
  if (command === "revoke") return runRevoke(io, root, positionals[0]);
  io.err(`Unknown native command: ${command}`);
  return 1;
}
