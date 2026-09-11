// Anthropic-style Provider Wrapper (PROTOTYPE) — wraps a user-supplied callback
// that returns an Anthropic Messages-style response and records explicit usage.
//
// STRICT RULES: This does NOT import the Anthropic SDK and calls no external API.
// It reads only explicit response.usage.{input_tokens, output_tokens}; it never
// infers missing usage, never estimates cost from tokens, and never estimates
// energy/heat. Cost is used only if the caller supplies it explicitly.
// See docs/PROVIDER_INTEGRATION_SPEC.md and docs/PROVIDER_INTEGRATION_CHECKLIST.md.

import type { RunLeakRecorder } from "@/lib/recorder-wrapper";

// Minimal local response shape — no SDK dependency.
export type AnthropicStyleUsage = {
  input_tokens?: number;
  output_tokens?: number;
};

export type AnthropicStyleResponse = {
  id?: string;
  model?: string;
  usage?: AnthropicStyleUsage;
  content?: unknown;
  stop_reason?: string | null;
};

export type AnthropicWrapperInput<T extends AnthropicStyleResponse> = {
  recorder: RunLeakRecorder;
  id: string;
  model?: string;
  promptSummary?: string;
  outputSummary?: string;
  costUsd?: number | null;
  call: () => Promise<T>;
};

export async function recordAnthropicStyleCall<T extends AnthropicStyleResponse>(
  input: AnthropicWrapperInput<T>,
): Promise<T> {
  let response: T | undefined;

  // We let the recorder wrapper own latency + success/failure semantics by
  // running the provider callback inside recordModelCall. The usage is read from
  // the response AFTER the callback resolves, so we capture the response here and
  // build the model-call metadata from it. Explicit fields only.
  await input.recorder.recordModelCall<T>({
    id: input.id,
    provider: "anthropic",
    model: input.model,
    promptSummary: input.promptSummary,
    outputSummary: input.outputSummary,
    // Cost only if the caller explicitly supplied it; never from tokens.
    costUsd: input.costUsd ?? null,
    // Usage is resolved lazily below; recordModelCall reads `usage` from this
    // object, so we attach a getter-free snapshot after the call by wrapping it.
    call: async () => {
      const r = await input.call();
      response = r;
      return r;
    },
    // Anthropic-style usage: input/output only. If usage is missing, these are
    // undefined and the mapper records null — not estimated.
    get usage(): { input_tokens?: number; output_tokens?: number } | undefined {
      const u = response?.usage;
      if (!u) return undefined;
      return {
        input_tokens: u.input_tokens,
        output_tokens: u.output_tokens,
      };
    },
  });

  // recordModelCall resolves with the callback's result; but to keep the typed
  // return precise we return the captured response. (recordModelCall already
  // rethrows on failure, so reaching here means success.)
  return response as T;
}
