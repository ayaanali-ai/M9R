/**
 * The interactive Windows desktop has one foreground window and one physical
 * input stream.  Background-capable actions may run concurrently, but any
 * action that must use the real foreground stream needs a single FIFO lease.
 *
 * This deliberately contains no Windows or provider logic. Keeping the
 * coordination primitive provider-neutral makes it usable by every stage and
 * keeps tests deterministic. A shared lock path may be supplied when several
 * provider workers need to serialize the one real OS foreground stream.
 */

import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

export interface ForegroundInputLeaseOptions {
  /** A shared M9R-owned directory used to coordinate separate worker processes. */
  lockPath?: string;
  /** Poll interval while another worker owns the shared lease. */
  pollMs?: number;
  /** Maximum age for a lock whose owner process no longer exists. */
  staleMs?: number;
  /** Injectable clock for deterministic recovery tests. */
  now?: () => number;
}

export interface ForegroundInputLease {
  run<T>(owner: string, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T>;
}

interface PendingOperation {
  owner: string;
  signal?: AbortSignal;
  operation: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  cancelled: boolean;
  started: boolean;
  onAbort?: () => void;
}

function cancellationReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Foreground input lease wait was cancelled.");
}

type SharedOwner = { pid: number; token: string; owner: string; startedAt: number };

function isAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function waitForRetry(signal: AbortSignal | undefined, delayMs: number): Promise<void> {
  signal?.throwIfAborted();
  return new Promise<void>((resolveWait, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveWait();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancellationReason(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function readSharedOwner(path: string): SharedOwner | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<SharedOwner>;
    if (!Number.isSafeInteger(value.pid) || (value.pid ?? 0) < 1 || typeof value.token !== "string" ||
        typeof value.owner !== "string" || typeof value.startedAt !== "number") return undefined;
    return value as SharedOwner;
  } catch {
    return undefined;
  }
}

function removeStaleSharedLock(lockPath: string): void {
  const info = lstatSync(lockPath);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Foreground lease path is not a managed directory; preserved for inspection.");
  const entries = readdirSync(lockPath);
  if (entries.some((entry) => entry !== "owner.json")) throw new Error("Foreground lease contains unexpected files; preserved for inspection.");
  rmSync(lockPath, { recursive: true, force: true });
}

function boundedOption(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.floor(value!))) : fallback;
}

async function acquireSharedLease(
  lockPath: string | undefined,
  owner: string,
  signal: AbortSignal | undefined,
  pollMs: number,
  staleMs: number,
  now: () => number,
): Promise<() => void> {
  if (!lockPath) return () => undefined;
  const lock = resolve(lockPath);
  const ownerPath = join(lock, "owner.json");
  const token = randomUUID();
  const record: SharedOwner = { pid: process.pid, token, owner: owner.slice(0, 128), startedAt: now() };

  while (true) {
    signal?.throwIfAborted();
    try {
      mkdirSync(lock);
      try {
        writeFileSync(ownerPath, JSON.stringify(record), { encoding: "utf8", mode: 0o600, flag: "wx" });
      } catch (error) {
        rmSync(lock, { recursive: true, force: true });
        throw error;
      }
      return () => {
        if (readSharedOwner(ownerPath)?.token === token) rmSync(lock, { recursive: true, force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const current = readSharedOwner(ownerPath);
      if (current && isAlive(current.pid)) {
        await waitForRetry(signal, pollMs);
        continue;
      }
      let ageMs = 0;
      try { ageMs = Math.max(0, now() - statSync(lock).mtimeMs); } catch { ageMs = staleMs; }
      // A dead PID can be reclaimed immediately. A partially written owner
      // record needs the age guard so a live owner is never stolen mid-write.
      if (current || ageMs >= staleMs) {
        removeStaleSharedLock(lock);
        continue;
      }
      await waitForRetry(signal, pollMs);
    }
  }
}

/** Create a FIFO lease for actions that can change OS focus. */
export function createForegroundInputLease(options: ForegroundInputLeaseOptions = {}): ForegroundInputLease {
  const pollMs = boundedOption(options.pollMs, 25, 1, 1_000);
  const staleMs = boundedOption(options.staleMs, 30_000, 1_000, 24 * 60 * 60 * 1_000);
  const now = options.now ?? (() => Date.now());
  const pending: PendingOperation[] = [];
  let running = false;

  const pump = (): void => {
    if (running) return;
    running = true;
    void drain();
  };

  const drain = async (): Promise<void> => {
    try {
      while (pending.length > 0) {
        const item = pending.shift()!;
        if (item.cancelled) continue;
        item.started = true;
        if (item.onAbort && item.signal) item.signal.removeEventListener("abort", item.onAbort);
        if (item.signal?.aborted) {
          item.reject(cancellationReason(item.signal));
          continue;
        }
        try {
          const releaseSharedLease = await acquireSharedLease(options.lockPath, item.owner, item.signal, pollMs, staleMs, now);
          try { item.resolve(await item.operation()); }
          finally { releaseSharedLease(); }
        } catch (error) {
          item.reject(error);
        }
      }
    } finally {
      running = false;
      if (pending.length > 0) pump();
    }
  };

  return {
    run<T>(owner: string, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
      signal?.throwIfAborted();
      return new Promise<T>((resolve, reject) => {
        const item: PendingOperation = {
          owner,
          signal,
          operation,
          resolve: (value) => resolve(value as T),
          reject,
          cancelled: false,
          started: false,
        };
        const onAbort = () => {
          if (item.started || item.cancelled) return;
          item.cancelled = true;
          const index = pending.indexOf(item);
          if (index >= 0) pending.splice(index, 1);
          reject(cancellationReason(signal!));
          pump();
        };
        item.onAbort = onAbort;
        if (signal) signal.addEventListener("abort", onAbort, { once: true });
        // Keep the owner on the queued record for local debugger inspection
        // without exposing it in provider-facing errors or telemetry.
        pending.push(item);
        pump();
      });
    },
  };
}
