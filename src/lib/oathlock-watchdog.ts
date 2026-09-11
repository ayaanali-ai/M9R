/**
 * Pure decision logic for the terminal-runtime watchdog (Option B from the
 * reliability discussion: a second, near-zero-cost process that notices the
 * main `oathlock terminal runtime` process died mid-session and relaunches
 * it, without waiting for the next Windows login). Kept separate from the
 * real socket/process/file IO in scripts/oathlock-watchdog.ts so the
 * decisions themselves are unit-testable without a real port or process.
 */

/** Parses the watchdog lock file's content. Anything that doesn't parse to a positive integer pid is treated as no lock -- a corrupt lock file must never permanently block a new watchdog from starting. */
export function parseWatchdogLockPid(raw: string | null): number | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown };
    return typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : null;
  } catch {
    return null;
  }
}

/** Parses the lock file's `startedAt` timestamp, or null if absent/unparseable. */
export function parseWatchdogLockStartedAt(raw: string | null): number | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { startedAt?: unknown };
    if (typeof parsed.startedAt !== "string") return null;
    const ms = Date.parse(parsed.startedAt);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

/**
 * A lock older than this is treated as untrustworthy even if its pid still
 * resolves to a live process. Windows recycles pids aggressively, so a
 * long-dead watchdog's pid can be re-used by an unrelated process and block
 * every future relaunch forever. A day is far longer than any legitimate
 * gap between the lock being written and a relaunch attempt mattering.
 */
export const WATCHDOG_LOCK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Whether a new watchdog should proceed to start, given the existing lock file's pid (if any) and whether that pid is actually still alive. A stale lock (process no longer running) must never block a fresh watchdog forever, and neither must an implausibly old one whose pid was likely recycled. */
export function shouldStartWatchdog(
  existingLockPid: number | null,
  isPidAlive: (pid: number) => boolean,
  lockStartedAtMs?: number | null,
  nowMs: number = Date.now(),
): boolean {
  if (existingLockPid === null) return true;
  if (!isPidAlive(existingLockPid)) return true;
  if (typeof lockStartedAtMs === "number" && nowMs - lockStartedAtMs > WATCHDOG_LOCK_MAX_AGE_MS) return true;
  return false;
}

/**
 * Whether the lock file currently on disk still names this process as the
 * holder. Checking the slot and writing the lock cannot be one atomic step, so
 * two watchdogs starting within the same few milliseconds can both see a free
 * slot and both write the lock; the one whose write landed first is then no
 * longer named by the file and must stand down. Without this, the loser ran
 * its probe loop forever alongside the winner -- the observed duplicate
 * watchdog processes that never exited.
 */
export function stillHoldsWatchdogLock(raw: string | null, pid: number): boolean {
  return parseWatchdogLockPid(raw) === pid;
}

/**
 * Whether enough consecutive failed liveness probes have accumulated to
 * declare the runtime dead and relaunch it. A single failed probe is not
 * enough -- a probe can fail transiently (the runtime is mid-restart from
 * its own resident-supervisor logic, a momentary loopback hiccup) and a
 * watchdog that relaunches on the first miss would fight the very recovery
 * mechanisms already in place elsewhere in this codebase.
 */
export function shouldRelaunch(consecutiveFailures: number, threshold: number): boolean {
  return consecutiveFailures >= threshold;
}
