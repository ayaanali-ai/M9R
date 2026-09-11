// Gemini-style Provider Wrapper (PROTOTYPE) — wraps a user-supplied callback that
// returns a Google Gemini / GenAI-style response and records explicit usage.
//
// STRICT RULES: This does NOT import the Gemini SDK and calls no external API. It
// reads only explicit usageMetadata.{promptTokenCount, candidatesTokenCount,
// totalTokenCount}. Gemini reports an explicit total, which is preserved as-is
// (the only allowed derivation — total = input + output — is unnecessary here and
// never overrides an explicit total). It never infers other usage, never
// estimates cost from tokens, and never estimates energy/heat. Cost is used only
// if the caller supplies it. See docs/PROVIDER_INTEGRATION_SPEC.md and
// docs/PROVIDER_INTEGRATION_CHECKLIST.md.

import type { RunLeakRecorder } from "@/lib/recorder-wrapper";

// Minimal local response shape — no SDK dependency. Mirrors the explicit fields
// of a Gemini GenerateContentResponse.usageMetadata.
export type GeminiStyleUsage = {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
};

export type GeminiStyleResponse = {
  id?: string;
  model?: string;
  usageMetadata?: GeminiStyleUsage;
  responseId?: string;
  modelVersion?: string;
};

export type GeminiWrapperInput<T extends GeminiStyleResponse> = {
  recorder: RunLeakRecorder;
  id: string;
  model?: string;
  promptSummary?: string;
  outputSummary?: string;
  costUsd?: number | null;
  call: () => Promise<T>;
};

// Convert explicit Gemini usageMetadata into flat explicit usage. Absent fields
// stay undefined → the generic mapper records null (never estimated). The
// explicit totalTokenCount is preserved as-is.
function flatUsage(u?: GeminiStyleUsage):
  | { inputTokens?: number; outputTokens?: number; totalTokens?: number }
  | undefined {
  if (!u) return undefined;
  return {
    inputTokens: u.promptTokenCount,
    outputTokens: u.candidatesTokenCount,
    totalTokens: u.totalTokenCount,
  };
}

export async function recordGeminiStyleCall<T extends GeminiStyleResponse>(
  input: GeminiWrapperInput<T>,
): Promise<T> {
  const startedAt = new Date().toISOString();
  const start = Date.now();

  let response: T;
  try {
    response = await input.call();
  } catch (err) {
    // Record the failed call (no usage invented), then rethrow.
    await input.recorder.recordModelCall({
      id: input.id,
      provider: "google",
      model: input.model,
      promptSummary: input.promptSummary,
      outputSummary: input.outputSummary,
      costUsd: input.costUsd ?? null,
      latencyMs: Date.now() - start,
      startedAt,
      endedAt: new Date().toISOString(),
      call: async () => {
        throw err;
      },
    });
    throw err; // unreachable (recordModelCall rethrows), kept for type safety
  }

  const latencyMs = Date.now() - start;
  await input.recorder.recordModelCall({
    id: input.id,
    provider: "google",
    model: input.model,
    promptSummary: input.promptSummary,
    outputSummary: input.outputSummary,
    costUsd: input.costUsd ?? null,
    latencyMs,
    startedAt,
    endedAt: new Date().toISOString(),
    // Explicit Gemini usage mapped to flat fields; the generic mapper preserves
    // the explicit total and never infers missing values.
    usage: flatUsage(response.usageMetadata),
    call: async () => response,
  });

  return response;
}
