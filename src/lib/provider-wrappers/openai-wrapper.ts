// OpenAI-style Provider Wrapper (PROTOTYPE) — wraps a user-supplied callback
// that returns an OpenAI-style response and records explicit usage.
//
// STRICT RULES: This does NOT import the OpenAI SDK and calls no external API.
// It reads only explicit response.usage.{input_tokens, output_tokens,
// total_tokens}. The only allowed derivation is total = input + output when
// total_tokens is missing but both are explicit (handled by the mapper). It
// never infers other usage, never estimates cost from tokens, and never
// estimates energy/heat. Cost is used only if the caller supplies it.
// See docs/PROVIDER_INTEGRATION_SPEC.md and docs/PROVIDER_INTEGRATION_CHECKLIST.md.

import type { RunLeakRecorder } from "@/lib/recorder-wrapper";

// Minimal local response shape — no SDK dependency.
export type OpenAIStyleUsage = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
};

export type OpenAIStyleResponse = {
  id?: string;
  model?: string;
  usage?: OpenAIStyleUsage;
  output?: unknown;
  choices?: unknown;
};

export type OpenAIWrapperInput<T extends OpenAIStyleResponse> = {
  recorder: RunLeakRecorder;
  id: string;
  model?: string;
  promptSummary?: string;
  outputSummary?: string;
  costUsd?: number | null;
  call: () => Promise<T>;
};

function explicitUsage(u?: OpenAIStyleUsage): OpenAIStyleUsage | undefined {
  if (!u) return undefined;
  // Pass only the explicit fields; absent fields stay undefined (the mapper
  // records null and derives total only when both input+output are explicit).
  return {
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    total_tokens: u.total_tokens,
  };
}

export async function recordOpenAIStyleCall<T extends OpenAIStyleResponse>(
  input: OpenAIWrapperInput<T>,
): Promise<T> {
  const startedAt = new Date().toISOString();
  const start = Date.now();

  let response: T;
  try {
    // Clearer two-step pattern: run the callback ourselves, then record from the
    // resolved response (no deferred getter).
    response = await input.call();
  } catch (err) {
    // Record the failed call via the recorder wrapper (its thrown callback sets
    // success:false + errorSummary and rethrows the original error). No usage.
    await input.recorder.recordModelCall({
      id: input.id,
      provider: "openai",
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
    provider: "openai",
    model: input.model,
    promptSummary: input.promptSummary,
    outputSummary: input.outputSummary,
    costUsd: input.costUsd ?? null,
    latencyMs,
    startedAt,
    endedAt: new Date().toISOString(),
    // Explicit OpenAI-style usage. Mapper preserves total_tokens when present,
    // derives it only when both input+output are explicit.
    usage: explicitUsage(response.usage),
    // The call already resolved; hand the recorder the resolved response.
    call: async () => response,
  });

  return response;
}
