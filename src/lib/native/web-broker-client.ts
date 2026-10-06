import { readFileSync } from "node:fs";
import type { WebBatchRequest, WebBatchResponse, WebRequest, WebResponse } from "./web-broker-core";
import type { WebAgentMessage } from "./web-broker-core";
import { DEFAULT_BROKER_PORT } from "./web-broker-paths";

export interface WebBrokerClient {
  taskStageApp?(token: string, taskId: string, appId?: string): Promise<{ ok: boolean; result?: unknown; error?: string }>;
  taskStageAction?(token: string, taskId: string, action: unknown): Promise<{ ok: boolean; result?: unknown; error?: string }>;
  prepareTaskStage?(token: string, taskId: string): Promise<{ ok: boolean; stage?: unknown; error?: string }>;
  run(request: WebRequest): Promise<WebResponse>;
  runBatch?(request: WebBatchRequest): Promise<WebBatchResponse>;
  notifyMessage?(message: WebAgentMessage): Promise<boolean>;
  /** Ask the local AWARE ledger before a browser-room agent writes a task into another member's inbox. */
  authorizeRoomMessage?(sender: string, recipient: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Every agent configured in this room (for m9r_agents; a web session has no endpoint registry entry otherwise). */
  listRoomAgents?(): Promise<string[]>;
  /** A native (non-worker) agent's turn just ended -- mark its cursor "Done" instead of leaving it on whatever the
   * last individual browser action happened to be. Called from that agent's own Stop hook. */
  markDone?(agent: string, provider: string, sessionId: string): Promise<boolean>;
}

export interface WebBrokerClientOptions {
  keyPath: string;
  port?: number;
  fetchImpl?: typeof fetch;
}

export function createWebBrokerClient(options: WebBrokerClientOptions): WebBrokerClient {
  const doFetch = options.fetchImpl ?? fetch;
  const baseUrl = `http://127.0.0.1:${options.port ?? DEFAULT_BROKER_PORT}`;
  return {
    async taskStageApp(token, taskId, appId) {
      try {
        const key = readFileSync(options.keyPath, "utf8").trim();
        const response = await doFetch(`${baseUrl}/web/stage/${appId === undefined ? "close" : "launch"}`, {
          method: "POST", headers: { "content-type": "application/json", "x-m9r-key": key },
          body: JSON.stringify({ token, taskId, ...(appId === undefined ? {} : { appId }) }), signal: AbortSignal.timeout(15_000),
        });
        return await response.json() as { ok: boolean; result?: unknown; error?: string };
      } catch { return { ok: false, error: "The owner-launched stage broker is not reachable." }; }
    },
    async taskStageAction(token, taskId, action) {
      try {
        const key = readFileSync(options.keyPath, "utf8").trim();
        const response = await doFetch(`${baseUrl}/web/stage/action`, {
          method: "POST", headers: { "content-type": "application/json", "x-m9r-key": key },
          body: JSON.stringify({ token, taskId, action }), signal: AbortSignal.timeout(15_000),
        });
        return await response.json() as { ok: boolean; result?: unknown; error?: string };
      } catch { return { ok: false, error: "The owner-launched stage broker is not reachable." }; }
    },
    async prepareTaskStage(token, taskId) {
      try {
        const key = readFileSync(options.keyPath, "utf8").trim();
        const response = await doFetch(`${baseUrl}/web/stage/prepare`, {
          method: "POST", headers: { "content-type": "application/json", "x-m9r-key": key },
          body: JSON.stringify({ token, taskId }), signal: AbortSignal.timeout(15_000),
        });
        return await response.json() as { ok: boolean; stage?: unknown; error?: string };
      } catch { return { ok: false, error: "The owner-launched stage broker is not reachable." }; }
    },
    async run(request) {
      let key: string;
      try {
        key = readFileSync(options.keyPath, "utf8").trim();
      } catch {
        return { ok: false, error: "the M9R web broker has not been started yet (run m9r-web-broker once)" };
      }
      try {
        const response = await doFetch(`${baseUrl}/cmd`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-m9r-key": key },
          body: JSON.stringify(request),
          // The broker may hold startup calls while Chrome starts the extension worker and it sends READY.
          signal: AbortSignal.timeout(60_000),
        });
        return (await response.json()) as WebResponse;
      } catch (error) {
        if (error instanceof Error && error.name === "TimeoutError") return { ok: false, error: "the M9R web broker did not answer within 60s" };
        const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
        const code = (cause as { code?: string } | undefined)?.code ?? (cause instanceof Error ? cause.message : String(cause));
        return { ok: false, error: `the M9R web broker is not reachable (${code}); start it with m9r-web-broker` };
      }
    },
    async runBatch(request) {
      let key: string;
      try {
        key = readFileSync(options.keyPath, "utf8").trim();
      } catch {
        return { ok: false, steps: [], failedAt: 0 };
      }
      try {
        const response = await doFetch(`${baseUrl}/batch`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-m9r-key": key },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(60_000),
        });
        return (await response.json()) as WebBatchResponse;
      } catch {
        return { ok: false, steps: [], failedAt: 0 };
      }
    },
    async notifyMessage(message) {
      let key: string;
      try {
        key = readFileSync(options.keyPath, "utf8").trim();
      } catch {
        return false;
      }
      try {
        const response = await doFetch(`${baseUrl}/web/message`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-m9r-key": key },
          body: JSON.stringify(message),
          signal: AbortSignal.timeout(2_000),
        });
        if (!response.ok) return false;
        const result: unknown = await response.json();
        return typeof result === "object" && result !== null && "ok" in result && (result as { ok?: unknown }).ok === true;
      } catch {
        // A browser overlay is a best-effort surface; the durable inbox send remains successful.
        return false;
      }
    },
    async authorizeRoomMessage(sender, recipient) {
      let key: string;
      try {
        key = readFileSync(options.keyPath, "utf8").trim();
      } catch {
        return { ok: false, error: "AWARE room membership could not be checked; the local broker key is unavailable" };
      }
      try {
        const response = await doFetch(`${baseUrl}/web/aware/messages/authorize`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-m9r-key": key },
          body: JSON.stringify({ sender, recipient }),
          signal: AbortSignal.timeout(2_000),
        });
        const result: unknown = await response.json();
        if (response.ok && typeof result === "object" && result !== null && "ok" in result && (result as { ok?: unknown }).ok === true) {
          return { ok: true };
        }
        const error = typeof result === "object" && result !== null && "error" in result && typeof (result as { error?: unknown }).error === "string"
          ? (result as { error: string }).error
          : "AWARE room membership denied the message";
        return { ok: false, error };
      } catch {
        return { ok: false, error: "AWARE room membership could not be checked; the local broker is unavailable" };
      }
    },
    async listRoomAgents() {
      let key: string;
      try {
        key = readFileSync(options.keyPath, "utf8").trim();
      } catch {
        return [];
      }
      try {
        const response = await doFetch(`${baseUrl}/web/agents`, { headers: { "x-m9r-key": key }, signal: AbortSignal.timeout(2_000) });
        const result: unknown = await response.json();
        const agents = result && typeof result === "object" ? (result as { agents?: unknown }).agents : undefined;
        return Array.isArray(agents) ? agents.filter((a): a is string => typeof a === "string") : [];
      } catch {
        return [];
      }
    },
    async markDone(agent, provider, sessionId) {
      if (!sessionId || sessionId.length > 128) return false;
      let key: string;
      try {
        key = readFileSync(options.keyPath, "utf8").trim();
      } catch {
        return false;
      }
      try {
        const response = await doFetch(`${baseUrl}/web/agent-done`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-m9r-key": key },
          body: JSON.stringify({ agent, provider, sessionId }),
          signal: AbortSignal.timeout(2_500),
        });
        if (!response.ok) return false;
        const result: unknown = await response.json();
        return typeof result === "object" && result !== null &&
          "ok" in result && (result as { ok?: unknown }).ok === true &&
          "marked" in result && (result as { marked?: unknown }).marked === true;
      } catch {
        // Best-effort: a missing/unreachable broker must never fail the agent's own turn just because the pill
        // could not be told it finished.
        return false;
      }
    },
  };
}
