import { renameSync } from "node:fs";

const WINDOWS_RENAME_RETRY_DELAYS_MS = [10, 30, 70] as const;
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

interface AtomicRenameDependencies {
  platform?: NodeJS.Platform;
  rename?: typeof renameSync;
  wait?: (milliseconds: number) => void;
}

/**
 * Atomically replaces a state file, retrying only short-lived Windows
 * replacement failures. Permanent ACL/path failures still surface after this
 * bounded window.
 */
export function renameStateFile(source: string, destination: string, dependencies: AtomicRenameDependencies = {}): void {
  const platform = dependencies.platform ?? process.platform;
  const rename = dependencies.rename ?? renameSync;
  const wait = dependencies.wait ?? ((milliseconds: number) => { Atomics.wait(SLEEP_CELL, 0, 0, milliseconds); });
  let retry = 0;

  while (true) {
    try {
      rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const delay = WINDOWS_RENAME_RETRY_DELAYS_MS[retry];
      if (platform !== "win32" || delay === undefined || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) {
        throw error;
      }
      retry += 1;
      wait(delay);
    }
  }
}
