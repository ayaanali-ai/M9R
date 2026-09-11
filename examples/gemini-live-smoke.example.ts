// Gemini LIVE smoke test — may make a real provider call, and ONLY behind an
// explicit opt-in gate. It proves a real Gemini response can be recorded into
// runleak.recorded.v0 via the existing pipeline.
//
// STRICT: no live call unless RUNLEAK_PROVIDER_TEST_ENABLED=true AND
// GEMINI_API_KEY AND GEMINI_LIVE_TEST_MODEL are present. Skips safely (exit 0)
// otherwise. Never prints/stores API keys. Never stores raw prompt or raw
// response body — summaries only. Records explicit usage only; cost stays null;
// energy stays null. See docs/REAL_PROVIDER_LIVE_TEST_POLICY.md.
import { writeFileSync } from "node:fs";
import { createRunLeakRecorder } from "@/lib/recorder-wrapper";
import {
  recordGeminiStyleCall,
  type GeminiStyleResponse,
} from "@/lib/provider-wrappers/gemini-wrapper";
import {
  isLiveProviderTestEnabled,
  assertNoApiKeyInTraceText,
  redactProviderSecrets,
} from "@/lib/provider-integration-safety";

const SKIP_PROOF = "docs/proof/test-019c-gemini-live-smoke/live-skipped-output.txt";

function skip(reason: string): void {
  const msg = `Gemini live smoke test SKIPPED: ${reason}. No live call was made; no live artifacts written.`;
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
  const apiKey = env.GEMINI_API_KEY;
  const model = env.GEMINI_LIVE_TEST_MODEL;
  if (!apiKey) {
    skip("GEMINI_API_KEY is not set");
    return;
  }
  if (!model) {
    skip("GEMINI_LIVE_TEST_MODEL is not set");
    return;
  }

  // --- live path: instantiate the SDK ONLY here ---
  const { GoogleGenAI } = await import("@google/genai");
  const client = new GoogleGenAI({ apiKey });

  const recorder = createRunLeakRecorder({
    runName: "Gemini LIVE smoke test (user-owned key)",
    objective: "Prove a real Gemini response records into runleak.recorded.v0.",
    source: "manual",
    startedAt: new Date().toISOString(),
  });

  const prompt = "Reply with one short sentence: RunLeak live smoke test.";

  await recordGeminiStyleCall({
    recorder,
    id: "live-1",
    model,
    // Summaries only — never the raw prompt or raw response body.
    promptSummary: "Tiny synthetic Gemini live smoke test prompt",
    outputSummary: "Redacted Gemini live smoke test response summary",
    // costUsd intentionally omitted → stays null. No price-from-tokens.
    call: async (): Promise<GeminiStyleResponse> => {
      const r = await client.models.generateContent({
        model,
        contents: prompt,
      });
      // Return ONLY safe, explicit fields. No candidates / raw response body.
      const u = r.usageMetadata;
      return {
        model: r.modelVersion ?? model,
        responseId: r.responseId,
        usageMetadata: u
          ? {
              promptTokenCount: u.promptTokenCount,
              candidatesTokenCount: u.candidatesTokenCount,
              totalTokenCount: u.totalTokenCount,
            }
          : undefined,
      };
    },
  });

  recorder
    .addCommandRun("npm run example:gemini-live-smoke")
    .setBuildResult("unknown")
    .setLintResult("unknown")
    .addNote("Real Gemini local live smoke test with a user-owned key.")
    .addNote("Summaries only; raw prompt/response not stored. costUsd null; energy null.");

  const session = recorder.finish({ endedAt: new Date().toISOString() });
  const json = JSON.stringify(session, null, 2);

  // Safety gate before writing: fail loudly if a key shape leaked into the trace,
  // then redact defensively.
  assertNoApiKeyInTraceText(json);
  const safeJson = redactProviderSecrets(json);

  const outPath = "examples/gemini-live-smoke.recorded.example.json";
  writeFileSync(outPath, safeJson + "\n");
  console.error(`Wrote ${outPath}`);

  // Print a redacted, key-free summary only.
  const mc = session.modelCalls[0];
  console.log(
    redactProviderSecrets(
      JSON.stringify(
        {
          live: true,
          provider: "google",
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
