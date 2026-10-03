/**
 * The desktop pill writes a small heartbeat file while it is running and visible; the web broker reads it and tells the
 * in-page pill, so the owner sees one pill, not two. Everything is local and unauthenticated on purpose: the worst a
 * stray writer can do is hide the in-page pill, which the owner can bring back with the message shortcut.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
