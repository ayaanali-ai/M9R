const BRIDGE_STARTED = "Mission ACP Bridge is running locally";
const BRIDGE_ALREADY_RUNNING = " -- exiting, the existing process stays up.";
const BRIDGE_AUTH_REJECTED = "Mission Relay rejected Bridge authentication";

/**
 * Distinguish an actual bridge failure from the runner's intentional clean
 * exits. A duplicate runner's clean exit is neutral: it proves only that a
 * sibling owns the provider lock, not that the sibling authenticated or is
 * healthy. Treating it as positive health can erase an earlier Relay-auth
 * failure from the same bounded log tail.
 */
export function missionBridgeLogIsUnhealthy(logTail: string): boolean {
  let latestSignal: "healthy" | "unhealthy" | null = null;

  for (const line of logTail.split(/\r?\n/)) {
    if (line.includes(BRIDGE_STARTED)) {
      latestSignal = "healthy";
      continue;
    }

    // A duplicate process has no information about the lock owner's health.
    if (line.includes(BRIDGE_ALREADY_RUNNING)) continue;

    if (
      line.includes(BRIDGE_AUTH_REJECTED)
      || line.includes("Mission ACP Bridge did not start (")
      || line.includes("Mission ACP Bridge crashed:")
      || line.includes("Mission Bridge (") && line.includes(" failed to connect during ")
    ) {
      latestSignal = "unhealthy";
      continue;
    }

    const exit = /\[supervisor\] child exited with code\s+([^\s]+)/.exec(line);
    if (exit && exit[1] !== "0") latestSignal = "unhealthy";
  }

  // A clean exit without an explicit failure is not evidence that a provider
  // bridge is unhealthy. The per-provider supervisor owns its bounded retry.
  return latestSignal === "unhealthy";
}
