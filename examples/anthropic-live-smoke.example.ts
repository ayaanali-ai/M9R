// Anthropic LIVE smoke test — the ONLY example that may make a real provider
// call, and ONLY behind an explicit opt-in gate. It proves a real Anthropic
// response can be recorded into runleak.recorded.v0 via the existing pipeline.
//
// STRICT: no live call unless RUNLEAK_PROVIDER_TEST_ENABLED=true AND
// ANTHROPIC_API_KEY AND ANTHROPIC_LIVE_TEST_MODEL are present. Skips safely
// (exit 0) otherwise. Never prints/stores API keys. Never stores raw prompt or
// raw response body — summaries only. Records explicit usage only; cost stays
// null; energy stays null. See docs/REAL_PROVIDER_LIVE_TEST_POLICY.md.
import { writeFileSync } from "node:fs";
import { createRunLeakRecorder } from "@/lib/recorder-wrapper";
import {
  recordAnthropicStyleCall,
  type AnthropicStyleResponse,
} from "@/lib/provider-wrappers/anthropic-wrapper";
import {
  isLiveProviderTestEnabled,
  assertNoApiKeyInTraceText,
  redactProviderSecrets,
} from "@/lib/provider-integration-safety";

const SKIP_PROOF = "docs/proof/test-019-anthropic-live-smoke/live-skipped-output.txt";

function skip(reason: string): void {
  const msg = `Anthropic live smoke test SKIPPED: ${reason}. No live call was made; no live artifacts written.`;
  // Never include secrets; redact defensively.
  console.log(redactProviderSecrets(msg));
  try {
    writeFileSync(SKIP_PROOF, msg + "\n");
  } catch {
    /* proof dir may not exist when run ad hoc; skip silently */
  }
}

async function main(): Promise<void> {
  const env = process.env;

  // CI must never run live unless explicitly opted in.
  if (env.CI === "true" && !isLiveProviderTestEnabled(env)) {
    skip("running in CI without RUNLEAK_PROVIDER_TEST_ENABLED=true");
    return;
  }
  if (!isLiveProviderTestEnabled(env)) {
    skip("RUNLEAK_PROVIDER_TEST_ENABLED is not 'true'");
    return;
  }
  const apiKey = env.ANTHROPIC_API_KEY;
  const model = env.ANTHROPIC_LIVE_TEST_MODEL;
  if (!apiKey) {
    skip("ANTHROPIC_API_KEY is not set");
    return;
  }
  if (!model) {
    skip("ANTHROPIC_LIVE_TEST_MODEL is not set");
    return;
  }

  // --- live path: instantiate the SDK ONLY here ---
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey });

  const recorder = createRunLeakRecorder({
    runName: "Anthropic LIVE smoke test (user-owned key)",
    objective: "Prove a real Anthropic response records into runleak.recorded.v0.",
    source: "manual",
    startedAt: new Date().toISOString(),
  });

  const prompt = "Reply with one short sentence: RunLeak live smoke test.";

  await recordAnthropicStyleCall({
    recorder,
    id: "live-1",
    model,
    // Summaries only — never the raw prompt or raw response body.
    promptSummary: "Tiny synthetic live smoke test prompt",
    outputSummary: "Redacted live smoke test response summary",
    // costUsd intentionally omitted → stays null. No price-from-tokens.
    call: async (): Promise<AnthropicStyleResponse> => {
      const r = await client.messages.create({
        model,
        max_tokens: 64,
        messages: [{ role: "user", content: prompt }],
      });
      // Return ONLY safe, explicit fields. No content blocks / raw body.
      return {
        id: r.id,
        model: r.model,
        usage: r.usage
          ? { input_tokens: r.usage.input_tokens, output_tokens: r.usage.output_tokens }
          : undefined,
        stop_reason: r.stop_reason ?? null,
      };
    },
  });

  recorder
    .addCommandRun("npm run example:anthropic-live-smoke")
    .setBuildResult("unknown")
    .setLintResult("unknown")
    .addNote("Real Anthropic local live smoke test with a user-owned key.")
    .addNote("Summaries only; raw prompt/response not stored. costUsd null; energy null.");

  const session = recorder.finish({ endedAt: new Date().toISOString() });
  const json = JSON.stringify(session, null, 2);

  // Safety gate before writing: fail loudly if a key shape leaked into the trace,
  // then redact defensively.
  assertNoApiKeyInTraceText(json);
  const safeJson = redactProviderSecrets(json);

  const outPath = "examples/anthropic-live-smoke.recorded.example.json";
  writeFileSync(outPath, safeJson + "\n");
  console.error(`Wrote ${outPath}`);

  // Print a redacted, key-free summary only.
  const mc = session.modelCalls[0];
  console.log(
    redactProviderSecrets(
      JSON.stringify(
        {
          live: true,
          provider: "anthropic",
          model: mc?.model,
          success: mc?.success ?? null,
          input_tokens: mc?.inputTokens ?? null,
          output_tokens: mc?.outputTokens ?? null,
          total_tokens: mc?.totalTokens ?? null,
          costUsd: mc?.costUsd ?? null,
          note: "summaries only; raw prompt/response not stored; energy null",
        },
        null,
        2,
      ),
    ),
  );
}

main().catch((err) => {
  // Never leak secrets via error text.
  console.error(redactProviderSecrets(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
