/**
 * The desktop pill writes a small heartbeat file while it is running and visible; the web broker reads it and tells the
 * in-page pill, so the owner sees one pill, not two. Everything is local and unauthenticated on purpose: the worst a
 * stray writer can do is hide the in-page pill, which the owner can bring back with the message shortcut.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { readRuntimeBuildIdentity } from "./runtime-build-identity";

export const DESKTOP_PILL_FILE = "pill-desktop.json";
/** The desktop pill beats every 2 s; three missed beats means it is gone (quit, crashed, or the machine slept). */
export const DESKTOP_PILL_MAX_AGE_MS = 6_000;

export function desktopPillHeartbeatPath(root: string): string {
  return join(root, DESKTOP_PILL_FILE);
}

/** True only for a fresh heartbeat that says the pill is visible. Anything malformed counts as "not running". */
export function desktopPillRunning(text: string | null | undefined, nowMs: number, maxAgeMs = DESKTOP_PILL_MAX_AGE_MS): boolean {
  if (!text) return false;
  try {
    const beat = JSON.parse(text) as { at?: unknown; visible?: unknown };
    if (typeof beat.at !== "number" || !Number.isFinite(beat.at) || beat.visible !== true) return false;
    const age = nowMs - beat.at;
    return age >= -2_000 && age <= maxAgeMs;
  } catch {
    return false;
  }
}

export function readDesktopPillRunning(root: string, nowMs = Date.now()): boolean {
  try {
    return desktopPillRunning(readFileSync(desktopPillHeartbeatPath(root), "utf8"), nowMs);
  } catch {
    return false;
  }
}

export function classifyOverlayProcesses(text: string, canonicalPath: string): "running" | "absent" | "conflict" {
  const parsed: unknown = JSON.parse(text);
  const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  if (rows.some((row) => !row || typeof row.ExecutablePath !== "string" || !row.ExecutablePath)) {
    throw new Error("An overlay process has an unreadable executable path");
  }
  const canonical = resolve(canonicalPath).toLowerCase();
  if (rows.some((row) => resolve(row.ExecutablePath).toLowerCase() !== canonical)) return "conflict";
  return rows.length ? "running" : "absent";
}

/**
 * Launch only the installed canonical overlay. Unknown process identity and other
 * generations fail closed and are recorded instead of silently looking successful.
 */
export function launchDesktopOverlayIfNeeded(root: string): "running" | "pending" | "failed" | "unsupported" {
  if (process.platform !== "win32") return "unsupported";
  const exe = join(root, "bin", "m9r-overlay.exe");
  const report = (state: string, detail?: string) => {
    const record = JSON.stringify({ at: new Date().toISOString(), executable: exe, state, detail });
    try { appendFileSync(join(root, "pill-startup.jsonl"), record + "\n"); } catch { /* stderr remains available */ }
    if (state !== "running") process.stderr.write(`M9R pill startup: ${record}\n`);
  };
  try {
    if (!existsSync(exe)) throw new Error("Canonical overlay is missing");
    const identity = readRuntimeBuildIdentity(exe);
    if (identity.status !== "verified") throw new Error(`Canonical overlay integrity is not verified: ${identity.status}`);
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "@(Get-CimInstance Win32_Process -Filter \"Name='m9r-overlay.exe'\" -ErrorAction Stop | Select-Object ExecutablePath) | ConvertTo-Json -Compress"],
    { encoding: "utf8", windowsHide: true, timeout: 5_000 });
    const state = classifyOverlayProcesses(output.trim() || "[]", exe);
    if (state === "conflict") throw new Error("Another overlay generation is running; canonical startup was not attempted");
    if (state === "running") { report(state); return "running"; }
    const child = spawn(exe, [], { detached: true, stdio: "ignore", windowsHide: false, cwd: join(root, "bin") });
    child.once("error", (error) => report("failed", error.message));
    child.unref();
    report("pending");
    return "pending";
  } catch (error) {
    report("failed", error instanceof Error ? error.message : String(error));
    return "failed";
  }
}

/** Retry only during startup, so intentionally quitting the pill stays respected. */
export function startDesktopOverlay(root: string): () => void {
  let attempts = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attempt = () => {
    attempts += 1;
    const state = launchDesktopOverlayIfNeeded(root);
    if ((state === "failed" || state === "pending") && attempts < 4) {
      timer = setTimeout(attempt, 10_000);
      timer.unref();
    }
  };
  attempt();
  return () => { if (timer) clearTimeout(timer); };
}
