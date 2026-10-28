/**
 * Best-effort local-to-cloud presence for a provider's MCP supervisor.
 *
 * Mission Bridge already renews this lease when the full terminal runtime is
 * running. Direct provider MCP sessions do not start Mission Bridge, though,
 * so the dashboard could mark an otherwise healthy local connection offline.
 * This small owner-local publisher closes that gap without changing the
 * provider-facing MCP contract or exposing the bearer token to tool calls.
 */

export const LOCAL_PRESENCE_HEARTBEAT_INTERVAL_MS = 30_000;
export const LOCAL_PRESENCE_HEARTBEAT_TIMEOUT_MS = 10_000;

export interface LocalPresenceHeartbeatOptions {
  appUrl: string;
  agentToken: string;
  provider: string;
  adapterInstanceId: string;
  intervalMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  onError?: (error: unknown) => void;
}

export interface LocalPresenceHeartbeatHandle {
  /** Resolves when the initial lease attempt completes. */
  ready: Promise<boolean>;
  /** Sends one serialized heartbeat, returning false on a transport/server failure. */
  sendNow(): Promise<boolean>;
  /** Stops future renewals and cancels an in-flight request. */
  stop(): void;
}

export function startLocalPresenceHeartbeat(options: LocalPresenceHeartbeatOptions): LocalPresenceHeartbeatHandle {
  const fetchImpl = options.fetchImpl ?? fetch;
  const intervalMs = options.intervalMs ?? LOCAL_PRESENCE_HEARTBEAT_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? LOCAL_PRESENCE_HEARTBEAT_TIMEOUT_MS;
  const endpoint = `${options.appUrl.replace(/\/+$/, "")}/api/agent/presence/heartbeat`;
  let sequence = 0;
  let stopped = false;
  let inFlight: Promise<boolean> | null = null;
  let controller: AbortController | null = null;

  const sendNow = async (): Promise<boolean> => {
    if (stopped) return false;
    if (inFlight) return inFlight;
    const nextSequence = ++sequence;
    const request = (async () => {
      const requestController = new AbortController();
      controller = requestController;
      const timeout = setTimeout(() => requestController.abort(), timeoutMs);
      try {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          signal: requestController.signal,
          headers: { authorization: `Bearer ${options.agentToken}`, "content-type": "application/json" },
          body: JSON.stringify({
            protocolVersion: "m9r.presence.v1",
            adapterInstanceId: options.adapterInstanceId,
            sequence: nextSequence,
            executionOrigin: "linked",
            provider: options.provider,
            idempotencyKey: `${options.adapterInstanceId}:${nextSequence}`.slice(0, 128),
          }),
        });
        if (!response.ok) throw new Error(`Agent presence heartbeat failed with HTTP ${response.status}.`);
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          throw new Error("Agent presence heartbeat returned no accepted presence lease.");
        }
        const row = body && typeof body === "object" && !Array.isArray(body)
          ? body as Record<string, unknown>
          : null;
        if (
          row?.ok !== true
          || row.state !== "awake"
          || typeof row.lease_expires_at !== "string"
          || !Number.isFinite(Date.parse(row.lease_expires_at))
        ) {
          throw new Error("Agent presence heartbeat returned no accepted presence lease.");
        }
        return true;
      } catch (error) {
        options.onError?.(error);
        return false;
      } finally {
        clearTimeout(timeout);
        if (controller === requestController) controller = null;
      }
    })();
    inFlight = request;
    try {
      return await request;
    } finally {
      if (inFlight === request) inFlight = null;
    }
  };

  const timer = setInterval(() => { void sendNow(); }, intervalMs);
  timer.unref?.();
  const ready = sendNow();
  return {
    ready,
    sendNow,
    stop: () => {
      stopped = true;
      clearInterval(timer);
      controller?.abort();
    },
  };
}
