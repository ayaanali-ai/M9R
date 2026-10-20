/**
 * The interactive Windows desktop has one foreground window and one physical
 * input stream.  Background-capable actions may run concurrently, but any
 * action that must use the real foreground stream needs a single FIFO lease.
 *
 * This deliberately contains no Windows or provider logic.  Keeping the
 * coordination primitive provider-neutral makes it usable by every stage and
 * keeps tests deterministic.
 */

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

/** Create one broker-local FIFO lease for actions that can change OS focus. */
export function createForegroundInputLease(): ForegroundInputLease {
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
          item.resolve(await item.operation());
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
