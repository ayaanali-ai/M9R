import { execFileSync } from "node:child_process";

/**
 * Whether a process is still alive, checked by signal probe. Windows can report EPERM for a PID
 * that has already exited; fall back to the OS process list rather than guessing either way.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || (code !== "EPERM" && code !== "EACCES")) return code !== "ESRCH";
    try {
      const output = execFileSync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue) -ne $null`,
      ], { encoding: "utf8", windowsHide: true, timeout: 5000 });
      return output.trim() === "True";
    } catch {
      // An unreadable process list is not proof the parent is gone; fail closed (treat as alive).
      return true;
    }
  }
}

export interface ParentWatchdogOptions {
  parentPid: number;
  intervalMs?: number;
  onParentGone: () => void;
  isAlive?: (pid: number) => boolean;
}

/**
 * Periodically checks whether `parentPid` is still alive and calls `onParentGone` the first time
 * it is not. Returns a stop function. Guards against a crashed or forcibly-killed parent leaving
 * this process (an MCP worker spawned as a plain child, with no OS-level job/process-group tie on
 * Windows) running forever.
 */
export function startParentLivenessWatchdog(options: ParentWatchdogOptions): () => void {
  const alive = options.isAlive ?? isProcessAlive;
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    if (!alive(options.parentPid)) {
      stopped = true;
      clearInterval(timer);
      options.onParentGone();
    }
  }, options.intervalMs ?? 5000);
  timer.unref?.();
  return () => { stopped = true; clearInterval(timer); };
}
