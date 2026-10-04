/**
 * The desktop pill writes a small heartbeat file while it is running and visible; the web broker reads it and tells the
 * in-page pill, so the owner sees one pill, not two. Everything is local and unauthenticated on purpose: the worst a
 * stray writer can do is hide the in-page pill, which the owner can bring back with the message shortcut.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";

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

/** True if a process with this exact image name is already running (Windows only; `tasklist` ships with the OS). */
function windowsProcessRunning(imageName: string): boolean {
  try {
    const out = execFileSync("tasklist", ["/FI", `IMAGENAME eq ${imageName}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
    return out.toLowerCase().includes(imageName.toLowerCase());
  } catch {
    // tasklist failing to run at all is not evidence the pill is up; err toward not double-launching a visible window.
    return true;
  }
}

/**
 * Launches the desktop overlay once, at broker startup, if it isn't already running. Nothing ever installed or
 * started this on its own before: a user who rebooted had to double-click the exe by hand every time. The broker
 * itself already has its own login-triggered autostart task, so piggybacking the overlay launch onto its own
 * startup needs no new scheduled task and runs exactly once per login, not on a repeating timer.
 */
export function launchDesktopOverlayIfNeeded(root: string): void {
  if (process.platform !== "win32") return;
  const exe = join(root, "bin", "m9r-overlay.exe");
  if (!existsSync(exe)) return;
  if (windowsProcessRunning("m9r-overlay.exe")) return;
  try {
    const child = spawn(exe, [], { detached: true, stdio: "ignore", windowsHide: false });
    child.unref();
  } catch {
    // Best-effort: a failed launch here must never take the broker itself down.
  }
}
