export const BROKER_STARTUP_HEALTH_TIMEOUT_MS = 60_000;
export const BROKER_STARTUP_HEALTH_POLL_MS = 250;

export interface BrokerHealthWaitResult {
  ready: boolean;
  attempts: number;
  elapsedMs: number;
}

export interface BrokerHealthWaitOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

/** Wait for a launched local broker to pass authenticated health, within a bounded cold-start window. */
export async function waitForBrokerHealth(
  probe: () => Promise<boolean>,
  options: BrokerHealthWaitOptions = {},
): Promise<BrokerHealthWaitResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const timeoutMs = Math.max(0, options.timeoutMs ?? BROKER_STARTUP_HEALTH_TIMEOUT_MS);
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? BROKER_STARTUP_HEALTH_POLL_MS);
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  let attempts = 0;

  while (true) {
    attempts += 1;
    try {
      if (await probe()) return { ready: true, attempts, elapsedMs: Math.max(0, now() - startedAt) };
    } catch {
      // A refused connection is expected until the broker finishes its startup.
    }
    const remainingMs = deadline - now();
    if (remainingMs <= 0) return { ready: false, attempts, elapsedMs: Math.max(0, now() - startedAt) };
    await sleep(Math.min(pollIntervalMs, remainingMs));
  }
}
