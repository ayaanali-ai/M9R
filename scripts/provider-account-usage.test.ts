import assert from "node:assert/strict";
import test from "node:test";

import {
  loadProviderAccountUsage,
  type ProviderUsageFetch,
} from "../src/lib/provider-account-usage.ts";

const NOW = new Date("2026-07-28T12:00:00.000Z");

test("reports honest provider states without making network calls when admin keys are absent", async () => {
  let calls = 0;
  const fetchImpl: ProviderUsageFetch = async () => {
    calls += 1;
    throw new Error("unexpected fetch");
  };

  const result = await loadProviderAccountUsage({ env: {}, fetchImpl, now: NOW });

  assert.equal(calls, 0);
  assert.deepEqual(
    result.map(({ provider, status, isConsumerAllowance }) => ({ provider, status, isConsumerAllowance })),
    [
      { provider: "openai", status: "not_configured", isConsumerAllowance: false },
      { provider: "anthropic", status: "not_configured", isConsumerAllowance: false },
      { provider: "xai", status: "unsupported", isConsumerAllowance: false },
    ],
  );
});

test("aggregates OpenAI organization usage and never exposes the admin key", async () => {
  const secret = "openai-admin-secret";
  const fetchImpl: ProviderUsageFetch = async () =>
    new Response(JSON.stringify({
      data: [
        { results: [{ input_tokens: 120, output_tokens: 30, num_model_requests: 2 }] },
        { results: [{ input_tokens: 80, output_tokens: 20, num_model_requests: 1 }] },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } });

  const [openai] = await loadProviderAccountUsage({
    env: { OPENAI_ADMIN_API_KEY: secret },
    fetchImpl,
    now: NOW,
  });

  assert.equal(openai.status, "available");
  assert.equal(openai.inputTokens, 200);
  assert.equal(openai.outputTokens, 50);
  assert.equal(openai.totalTokens, 250);
  assert.equal(openai.requests, 3);
  assert.equal(JSON.stringify(openai).includes(secret), false);
});

test("aggregates Anthropic uncached, cache, and output token usage", async () => {
  const fetchImpl: ProviderUsageFetch = async (input) => {
    const url = String(input);
    if (!url.includes("anthropic.com")) throw new Error(`unexpected URL: ${url}`);
    return new Response(JSON.stringify({
      data: [{
        results: [{
          uncached_input_tokens: 100,
          cache_read_input_tokens: 40,
          cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 5 },
          output_tokens: 25,
        }],
      }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const result = await loadProviderAccountUsage({
    env: { ANTHROPIC_ADMIN_API_KEY: "anthropic-admin-secret" },
    fetchImpl,
    now: NOW,
  });
  const anthropic = result.find((entry) => entry.provider === "anthropic");

  assert.equal(anthropic?.status, "available");
  assert.equal(anthropic?.inputTokens, 155);
  assert.equal(anthropic?.outputTokens, 25);
  assert.equal(anthropic?.totalTokens, 180);
});

test("isolates provider errors instead of failing the dashboard", async () => {
  const fetchImpl: ProviderUsageFetch = async (input) => {
    if (String(input).includes("openai.com")) return new Response("denied", { status: 401 });
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  };

  const result = await loadProviderAccountUsage({
    env: {
      OPENAI_ADMIN_API_KEY: "openai-admin-secret",
      ANTHROPIC_ADMIN_API_KEY: "anthropic-admin-secret",
    },
    fetchImpl,
    now: NOW,
  });

  assert.equal(result.find((entry) => entry.provider === "openai")?.status, "error");
  assert.equal(result.find((entry) => entry.provider === "anthropic")?.status, "available");
});
