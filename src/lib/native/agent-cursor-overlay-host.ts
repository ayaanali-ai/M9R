import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { appendFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultStoreRoot } from "./local-store";

type Rgb = readonly [number, number, number];

export interface AgentCursorOverlayPoint {
  id: string;
  label: string;
  color: Rgb;
  x: number;
  y: number;
  cue?: "edit" | "click";
  dragSample?: true;
}

export interface AgentCursorOverlayHost {
  /** Start the transparent renderer before the first task, without showing a marker. */
  warm?(): Promise<boolean>;
  upsert(point: AgentCursorOverlayPoint): Promise<boolean>;
  say(input: { id: string; text: string }): Promise<boolean>;
  /** True once the marker is confirmed hidden (or was already not visible). False on a dropped/timed-out ack -- the caller must retry rather than forget the marker. */
  hide(id: string): Promise<boolean>;
  close(): Promise<void>;
}

type OverlayMessage = { event?: unknown; requestId?: unknown; ok?: unknown };
type SpawnOverlay = typeof spawn;
type OverlayChild = ChildProcessByStdio<Writable, Readable, Readable>;

const READY_TIMEOUT_MS = 2_000;
// A freshly-installed, unsigned exe routinely gets held up by Windows Defender's first-run scan well
// past READY_TIMEOUT_MS -- confirmed live on 2026-11-13, reproducing on the very first spawn after every
// install. That one-time scan doesn't recur for the same file, so a single longer-timeout retry absorbs
// it immediately instead of leaving no agent marker on screen until some later, unrelated action happens
// to trigger the next lazy respawn attempt (observed live as a multi-minute gap).
const READY_RETRY_TIMEOUT_MS = 10_000;
const ACK_TIMEOUT_MS = 900;
const EXIT_TIMEOUT_MS = 700;

// native-input-host refuses --spawn-cursor-overlay when it sees these
// markers, to stop a human using a coding-agent CLI on M9R's own source from
// accidentally drawing on the owner's screen. But M9R's real task-running
// agents ARE Claude Code / Codex / OpenCode CLI processes by design, so they
// always carry these same markers -- strip them from just this one child's
// environment so the guard can't mistake a real task run for dev-session
// self-triggering. Every other process this teammate CLI spawns keeps its
// real environment untouched.
const AGENT_CONTEXT_MARKERS = [
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CODEX_CI",
  "CODEX_THREAD_ID",
  "CODEX_SESSION_ID",
  "OPENCODE",
  "OPENCODE_SESSION_ID",
] as const;

function overlaySpawnEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const marker of AGENT_CONTEXT_MARKERS) delete env[marker];
  return env;
}

// Temporary: the overlay's own stderr was previously discarded entirely
// (stdio [pipe, pipe, "ignore"]), and the task-record timing evidence alone
// could not distinguish "process never spawned", "spawned but the window
// never rendered", and "spawned, rendered, but the ack IPC stalled". This
// writes every spawn/exit/timeout to a durable log the engine's own stdout
// doesn't carry, so the next live task run tells us which one it actually is.
//
// logRoot is injectable (defaults to the real ~/.m9r) for exactly one reason: every
// test that exercises this host used to fall through to the real path unconditionally
// -- no test file sandboxed it -- so every test run on a dev machine spammed the
// developer's own live cursor-overlay-debug.log with thousands of real entries
// (confirmed: a single `node scripts/run-test-suite.mjs all` run left ~50 "spawned"/
// "executable-missing" lines per test file). A test passing a tmp logRoot now writes
// nowhere near the real app's state.
function debugLogPath(logRoot: string | undefined): string {
  return join(logRoot ?? defaultStoreRoot(homedir(), process.env), "cursor-overlay-debug.log");
}

/**
 * Kills any m9r-native-input-host.exe left running from a PREVIOUS broker process -- the broker is a
 * singleton (one per machine), so at the moment a new broker starts, before it has created any session's
 * overlay host, every instance of this image is necessarily an orphan: either the prior broker exited
 * ungracefully (crash, SIGKILL, taskkill /F) and skipped AgentCursorOverlayHost.close()'s own kill, or it
 * never got the chance to spawn one that then outlived it. Safe to call unconditionally at broker startup,
 * and nowhere else -- once real sessions exist this would kill their live overlay too. Windows-only like
 * the host itself; a no-op everywhere else.
 */
export function killStaleAgentCursorOverlayHosts(run: typeof spawnSync = spawnSync): void {
  if (process.platform !== "win32") return;
  try { run("taskkill", ["/IM", "m9r-native-input-host.exe", "/F"], { stdio: "ignore" }); } catch { /* none were running */ }
}

/**
 * One owner-broker child renders all agent markers. It is presentation only:
 * callers must never use its result as evidence that an input action landed.
 */
export function createAgentCursorOverlayHost(input: {
  executablePath: string;
  spawnProcess?: SpawnOverlay;
  pathExists?: (path: string) => boolean;
  /** Root directory for this host's own debug log; defaults to the real ~/.m9r. Tests should pass a tmp dir. */
  logRoot?: string;
}): AgentCursorOverlayHost {
  const spawnProcess = input.spawnProcess ?? spawn;
  const pathExists = input.pathExists ?? existsSync;
  const logPath = debugLogPath(input.logRoot);
  function debugLog(event: string, detail: Record<string, unknown> = {}): void {
    try {
      appendFileSync(logPath, `${new Date().toISOString()} ${event} ${JSON.stringify(detail)}\n`);
    } catch { /* diagnostic logging must never affect overlay behavior */ }
  }
  let child: OverlayChild | undefined;
  let ready: Promise<boolean> | undefined;
  let nextRequestId = 1;
  let closing: Promise<void> | undefined;
  const pending = new Map<number, { resolve: (ok: boolean) => void; timer: NodeJS.Timeout }>();
  const visible = new Set<string>();
  // A missing ACK leaves presentation uncertain; it does not prove absence.
  const possiblyVisible = new Set<string>();
  const markerQueues = new Map<string, Promise<void>>();
  async function forMarker<T>(id: string, run: () => Promise<T>): Promise<T> {
    const previous = markerQueues.get(id) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>(resolve => { release = resolve; });
    markerQueues.set(id, tail);
    await previous;
    try { return await run(); }
    finally { release(); if (markerQueues.get(id) === tail) markerQueues.delete(id); }
  }
  const hide = async (id: string): Promise<boolean> => {
    if (!visible.has(id) && !possiblyVisible.has(id)) return true;
    return forMarker(id, async () => {
      const ok = await send({ cmd: "hide", id });
      if (ok) { visible.delete(id); possiblyVisible.delete(id); }
      return ok;
    });
  };

  const failPending = () => {
    for (const [id, request] of pending) {
      clearTimeout(request.timer);
      request.resolve(false);
      pending.delete(id);
    }
  };

  function consumeLine(line: string): void {
    let message: OverlayMessage;
    try { message = JSON.parse(line) as OverlayMessage; }
    catch { return; }
    if (message.event === "ready") {
      // The startup promise is resolved by the first successfully rendered
      // layered frame, not merely by process creation.
      (child as (OverlayChild & { __m9rReady?: () => void }) | undefined)?.__m9rReady?.();
      return;
    }
    if (message.event !== "ack" || !Number.isSafeInteger(message.requestId)) return;
    const id = message.requestId as number;
    const request = pending.get(id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(id);
    request.resolve(message.ok === true);
  }

  async function attemptStart(timeoutMs: number): Promise<boolean> {
    // The exe's presence was previously checked once, by the caller, before this
    // host was even constructed -- a broker that started slightly ahead of an
    // in-progress install (or one racing a binary swap) got a permanently
    // undefined host for its entire lifetime, with no later cursor action ever
    // able to self-heal even once the exe showed up. Recheck it on every real
    // attempt instead, so a startup race only costs the presentations that
    // land in that narrow window, not the rest of that broker's life.
    if (!pathExists(input.executablePath)) {
      debugLog("executable-missing", { executablePath: input.executablePath });
      return false;
    }
    let resolveReady!: (value: boolean) => void;
    const readiness = new Promise<boolean>((resolve) => { resolveReady = resolve; });
    let settled = false;
    const finishReady = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolveReady(value);
    };
    let process: OverlayChild;
    const spawnStartedAt = Date.now();
    try {
      process = spawnProcess(input.executablePath, ["--spawn-cursor-overlay"], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: overlaySpawnEnv(),
      }) as OverlayChild;
    } catch (spawnError) {
      debugLog("spawn-threw", { error: String(spawnError) });
      return false;
    }
    debugLog("spawned", { pid: process.pid, executablePath: input.executablePath });
    child = process;
    ready = readiness;
    (process as OverlayChild & { __m9rReady?: () => void }).__m9rReady = () => {
      debugLog("ready", { pid: process.pid, msSinceSpawn: Date.now() - spawnStartedAt });
      finishReady(true);
    };
    const lines = createInterface({ input: process.stdout });
    lines.on("line", consumeLine);
    const stderrLines = createInterface({ input: process.stderr });
    stderrLines.on("line", (line) => debugLog("stderr", { pid: process.pid, line }));
    process.once("error", (error) => {
      debugLog("process-error", { pid: process.pid, error: String(error) });
      finishReady(false);
    });
    process.once("exit", (code, signal) => {
      debugLog("exit", { pid: process.pid, code, signal, msSinceSpawn: Date.now() - spawnStartedAt });
      finishReady(false);
      lines.close();
      stderrLines.close();
      failPending();
      if (child === process) {
        child = undefined;
        ready = undefined;
        visible.clear();
        possiblyVisible.clear();
      }
    });
    const timer = setTimeout(() => {
      debugLog("ready-timeout", { pid: process.pid, timeoutMs });
      finishReady(false);
    }, timeoutMs);
    const result = await readiness;
    clearTimeout(timer);
    if (!result && child === process) {
      child = undefined;
      ready = undefined;
      lines.close();
      stderrLines.close();
      try { process.kill(); } catch { /* the process may already have exited */ }
    }
    return result;
  }

  async function ensureStarted(): Promise<boolean> {
    if (child && ready) return ready;
    if (closing) return false;
    if (await attemptStart(READY_TIMEOUT_MS)) return true;
    // One retry with a much longer timeout absorbs a one-time Defender scan of the freshly-written exe
    // instead of leaving no cursor marker on screen until some unrelated later action retries.
    return attemptStart(READY_RETRY_TIMEOUT_MS);
  }

  async function send(command: Record<string, unknown>): Promise<boolean> {
    if (!await ensureStarted()) return false;
    const process = child;
    if (!process || process.exitCode !== null || process.killed || !process.stdin.writable) return false;
    const requestId = nextRequestId++;
    if (!Number.isSafeInteger(requestId)) {
      nextRequestId = 2;
      return false;
    }
    const line = `${JSON.stringify({ ...command, requestId })}\n`;
    const sentAt = Date.now();
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        debugLog("ack-timeout", { pid: process.pid, requestId, cmd: command.cmd, timeoutMs: ACK_TIMEOUT_MS });
        pending.delete(requestId);
        resolve(false);
      }, ACK_TIMEOUT_MS);
      pending.set(requestId, { resolve, timer });
      process.stdin.write(line, (error) => {
        if (!error) return;
        debugLog("stdin-write-error", { pid: process.pid, requestId, cmd: command.cmd, error: String(error), msSinceSent: Date.now() - sentAt });
        const request = pending.get(requestId);
        if (!request) return;
        clearTimeout(request.timer);
        pending.delete(requestId);
        request.resolve(false);
      });
    });
  }

  return {
    async warm() {
      return ensureStarted();
    },
    async upsert(point) {
      if (!point.id || point.id.length > 72 || !point.label || point.label.length > 28
        || !Number.isFinite(point.x) || !Number.isFinite(point.y)
        || point.color.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)) return false;
      // Register before startup awaits so a concurrent close cannot mistake
      // an in-flight initial marker for one that was never requested.
      possiblyVisible.add(point.id);
      return forMarker(point.id, async () => {
        const ok = await send({ cmd: "upsert", ...point });
        if (ok) visible.add(point.id);
        return ok;
      });
    },
    async say(message) {
      // Bubbles are presentation for an accepted A2A summary, never the
      // transport itself. Require a currently acknowledged sender marker and
      // bound every string before it reaches the native renderer.
      const text = message.text.replace(/[\r\n\t\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 160);
      if (!possiblyVisible.has(message.id) || !text) return false;
      return forMarker(message.id, async () =>
        visible.has(message.id) && await send({ cmd: "say", id: message.id, text }));
    },
    async hide(id) {
      return hide(id);
    },
    async close() {
      if (closing) return closing;
      closing = (async () => {
        await Promise.all([...new Set([...visible, ...possiblyVisible])].map((id) => hide(id).catch(() => undefined)));
        const process = child;
        visible.clear();
        possiblyVisible.clear();
        if (!process) return;
        child = undefined;
        ready = undefined;
        const exited = new Promise<void>((resolve) => {
          if (process.exitCode !== null) { resolve(); return; }
          process.once("exit", () => resolve());
        });
        try { process.stdin.end(); } catch { /* already closed */ }
        await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, EXIT_TIMEOUT_MS))]);
        if (process.exitCode === null && !process.killed) {
          try { process.kill(); } catch { /* already exited */ }
        }
        failPending();
      })().finally(() => { closing = undefined; });
      return closing;
    },
  };
}
