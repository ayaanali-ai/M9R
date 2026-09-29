import type { WebBatchRequest, WebBatchResponse, WebRequest, WebResponse } from "@/lib/native/web-broker-core";
import type { WebBrokerClient } from "@/lib/native/web-broker-client";

/**
 * Test-only broker client. Production clients read the key from disk; benchmark tests must not do that because
 * the broker intentionally denies the sandbox access to its key file after startup.
 */
export function createBenchmarkWebBrokerClient(key: string, port: number, fetchImpl: typeof fetch = fetch): WebBrokerClient {
  const baseUrl = `http://127.0.0.1:${port}`;

  async function post<T>(path: string, body: WebRequest | WebBatchRequest): Promise<T> {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-m9r-key": key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    return (await response.json()) as T;
  }

  return {
    run: (request: WebRequest) => post<WebResponse>("/cmd", request),
    runBatch: (request: WebBatchRequest) => post<WebBatchResponse>("/batch", request),
  };
}

async function postBenchmarkOwnerRequest(key: string, port: number, path: string, body: Record<string, string>, fetchImpl: typeof fetch): Promise<void> {
  if (path !== "/web/aware/members/invite" && path !== "/web/aware/disclosures/decision") {
    throw new Error(`Unsupported benchmark owner route: ${path}`);
  }

  const response = await fetchImpl(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-m9r-key": key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  const result = await response.json() as { ok?: boolean; error?: string };
  if (!response.ok || result.ok !== true) throw new Error(result.error ?? `benchmark owner request failed (${response.status})`);
}

export function inviteBenchmarkAgent(key: string, port: number, agent: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  return postBenchmarkOwnerRequest(key, port, "/web/aware/members/invite", { agent }, fetchImpl);
}

export function approveBenchmarkDisclosure(key: string, port: number, requestId: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  return postBenchmarkOwnerRequest(key, port, "/web/aware/disclosures/decision", { requestId, decision: "approve" }, fetchImpl);
}
