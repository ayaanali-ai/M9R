import assert from "node:assert/strict";
import test from "node:test";
import type { WebBatchRequest, WebRequest } from "@/lib/native/web-broker-core";
import { approveBenchmarkDisclosure, createBenchmarkWebBrokerClient, inviteBenchmarkAgent } from "./bench/web-client";

test("benchmark broker client uses the in-memory key for both real broker routes", async () => {
  const calls: Array<{ url: string; headers: Headers; body: unknown }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    });
    return new Response(JSON.stringify({ ok: true, steps: [] }), { status: 200 });
  };
  const client = createBenchmarkWebBrokerClient("test-only-broker-key", 47821, fetchImpl);
  const command: WebRequest = { agent: "codex", provider: "codex", sessionId: "bench", action: "read", selector: "body" };
  const batch: WebBatchRequest = {
    agent: "codex",
    provider: "codex",
    sessionId: "bench",
    steps: [{ action: "open", url: "https://example.test/" }],
  };

  await client.run(command);
  await client.runBatch?.(batch);
  await inviteBenchmarkAgent("test-only-broker-key", 47821, "claude", fetchImpl);
  await approveBenchmarkDisclosure("test-only-broker-key", 47821, "disclosure-test", fetchImpl);

  assert.deepEqual(calls.map((call) => call.url), [
    "http://127.0.0.1:47821/cmd",
    "http://127.0.0.1:47821/batch",
    "http://127.0.0.1:47821/web/aware/members/invite",
    "http://127.0.0.1:47821/web/aware/disclosures/decision",
  ]);
  assert.deepEqual(calls.map((call) => call.headers.get("x-m9r-key")), Array(4).fill("test-only-broker-key"));
  assert.deepEqual(calls.map((call) => call.body), [
    command,
    batch,
    { agent: "claude" },
    { requestId: "disclosure-test", decision: "approve" },
  ]);
});
