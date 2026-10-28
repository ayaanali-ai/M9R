import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { renameStateFile } from "./atomic-file";
import type { UiState } from "./web-ui-bridge";

/**
 * The broker-owned state file consumed by the native pill.
 *
 * This is deliberately a one-way, redacted view of the broker UI state. The
 * pill does not discover provider processes, read provider sessions, or
 * maintain a second lifecycle. It only renders what the owner broker already
 * knows and sends owner commands back through the owner pipe.
 */
export const DESKTOP_PILL_STATE_FILE = "desktop-pill-state.json";

export function desktopPillStatePath(root: string): string {
  return join(root, DESKTOP_PILL_STATE_FILE);
}

function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, text, { encoding: "utf8", flag: "wx" });
  try {
    renameStateFile(temporary, path);
  } finally {
    try { rmSync(temporary, { force: true }); } catch { /* the rename already consumed it */ }
  }
}

/** Publish the latest broker state without exposing provider credentials or session internals. */
export function writeDesktopPillState(root: string, state: UiState): void {
  writeAtomic(desktopPillStatePath(root), `${JSON.stringify({ version: 1, surface: "desktop-pill", state })}\n`);
}

export function clearDesktopPillState(root: string): void {
  try { rmSync(desktopPillStatePath(root), { force: true }); } catch { /* shutdown remains best effort */ }
}

/** Read and validate only the outer envelope; the pill performs its own UI-shape validation. */
export function readDesktopPillState(root: string): UiState | null {
  try {
    const value = JSON.parse(readFileSync(desktopPillStatePath(root), "utf8")) as { version?: unknown; surface?: unknown; state?: unknown };
    if (value.version !== 1 || value.surface !== "desktop-pill" || !value.state || typeof value.state !== "object" || Array.isArray(value.state)) return null;
    return value.state as UiState;
  } catch {
    return null;
  }
}
