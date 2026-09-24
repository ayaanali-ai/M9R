import { readFileSync } from "node:fs";
import type { WebRequest, WebResponse } from "./web-broker-core";
import type { WebAgentMessage } from "./web-broker-core";
import { DEFAULT_BROKER_PORT } from "./web-broker-paths";

export interface WebBrokerClient {
  run(request: WebRequest): Promise<WebResponse>;
  notifyMessage?(message: WebAgentMessage): Promise<boolean>;
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
  };
}
