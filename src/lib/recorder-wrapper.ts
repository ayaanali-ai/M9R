// Recorder Wrapper — a provider-agnostic helper that records explicitly supplied
// model-call and tool-call metadata AROUND user-provided callback functions.
//
// STRICT RULES: This wrapper records only explicit metadata. It does NOT call any
// provider/model itself, does not intercept providers, does not infer missing
// tokens, never estimates cost from tokens, and never estimates energy/heat. It
// measures wall-clock latency only when not explicitly provided. See docs/claims.md.

import { createRecordedSession, RecordedSessionBuilder } from "@/lib/recorder-lite";
import type {
  RecordedCodingSession,
  RecordedModelCall,
} from "@/lib/trace-recorder-schema";
import {
  mapGenericUsageToModelCall,
  mapOpenAIUsageToModelCall,
  mapAnthropicUsageToModelCall,
} from "@/lib/provider-usage-mappers";

// Usage may be supplied in a provider-native shape (mapped by the matching
// helper) or as flat explicit fields (mapped generically). All optional; nothing
// is inferred when absent.
type OpenAIUsage = { input_tokens?: number; output_tokens?: number; total_tokens?: number };
type AnthropicUsage = { input_tokens?: number; output_tokens?: number };
type FlatUsage = {
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
};

export type RecordModelCallInput<T> = {
  id: string;
  provider?: RecordedModelCall["provider"];
  model?: string;
  promptSummary?: string;
  outputSummary?: string;
  // Provider-native or flat explicit usage. Choose ONE shape.
  usage?: OpenAIUsage | AnthropicUsage | FlatUsage;
  costUsd?: number | null;
  latencyMs?: number | null;
  startedAt?: string;
  endedAt?: string;
  call: () => Promise<T>;
};

export type RecordToolCallInput<T> = {
  id: string;
  toolName: string;
  inputSummary?: string;
  outputSummary?: string;
  errorSummary?: string;
  success?: boolean | null;
  latencyMs?: number | null;
  startedAt?: string;
  endedAt?: string;
  call: () => Promise<T>;
};

function hasFlatUsage(u: object): u is FlatUsage {
  return (
    "inputTokens" in u || "outputTokens" in u || "totalTokens" in u
  );
}

// Build a RecordedModelCall from explicit metadata using the right mapper.
function modelCallFromInput<T>(
  input: RecordModelCallInput<T>,
  measured: { startedAt: string; endedAt: string; latencyMs: number },
  outcome: { success: boolean; errorSummary?: string },
): RecordedModelCall {
  const startedAt = input.startedAt ?? measured.startedAt;
  const endedAt = input.endedAt ?? measured.endedAt;
  const latencyMs = input.latencyMs ?? measured.latencyMs;
  // On failure, prefer an explicit outputSummary if the caller gave one; never
  // invent usage.
  const outputSummary = input.outputSummary;
  const common = {
    id: input.id,
    model: input.model,
    costUsd: input.costUsd ?? null,
    latencyMs,
    startedAt,
    endedAt,
    promptSummary: input.promptSummary,
    outputSummary,
  };

  const u = input.usage;
  let mapped: RecordedModelCall;
  if (u && !hasFlatUsage(u) && (input.provider === "openai" || "total_tokens" in u)) {
    // Provider-native OpenAI-style usage (carries total_tokens).
    mapped = mapOpenAIUsageToModelCall({ ...common, usage: u as OpenAIUsage });
  } else if (u && !hasFlatUsage(u) && input.provider === "anthropic") {
    // Anthropic-style usage (input/output only).
    mapped = mapAnthropicUsageToModelCall({ ...common, usage: u as AnthropicUsage });
  } else {
    // Default: flat explicit usage via the generic mapper.
    const flat = (u as FlatUsage | undefined) ?? {};
    mapped = mapGenericUsageToModelCall({
      ...common,
      provider: input.provider ?? "unknown",
      inputTokens: flat.inputTokens ?? null,
      outputTokens: flat.outputTokens ?? null,
      totalTokens: flat.totalTokens ?? null,
    });
  }

  // Attach outcome. Usage is whatever the caller supplied — never inferred for
  // failed calls.
  return {
    ...mapped,
    success: outcome.success,
    ...(outcome.errorSummary ? { errorSummary: outcome.errorSummary } : {}),
  };
}

export class RunLeakRecorder {
  private builder: RecordedSessionBuilder;

  constructor(input: {
    runName: string;
    objective: string;
    source?: RecordedCodingSession["source"];
    startedAt?: string;
  }) {
    this.builder = createRecordedSession(input);
  }

  async recordModelCall<T>(input: RecordModelCallInput<T>): Promise<T> {
    const startedAt = input.startedAt ?? new Date().toISOString();
    const start = Date.now();
    try {
      const result = await input.call();
      const measured = {
        startedAt,
        endedAt: new Date().toISOString(),
        latencyMs: Date.now() - start,
      };
      this.builder.addModelCall(
        modelCallFromInput(input, measured, { success: true }),
      );
      return result;
    } catch (err) {
      const measured = {
        startedAt,
        endedAt: new Date().toISOString(),
        latencyMs: Date.now() - start,
      };
      // Still record the call from the explicit metadata provided; mark failed
      // and capture an error summary. No usage is invented.
      const errorSummary = err instanceof Error ? err.message : String(err);
      this.builder.addModelCall(
        modelCallFromInput(input, measured, { success: false, errorSummary }),
      );
      throw err;
    }
  }

  async recordToolCall<T>(input: RecordToolCallInput<T>): Promise<T> {
    const startedAt = input.startedAt ?? new Date().toISOString();
    const start = Date.now();
    try {
      const result = await input.call();
      this.builder.addToolCall({
        id: input.id,
        toolName: input.toolName,
        startedAt,
        endedAt: new Date().toISOString(),
        latencyMs: input.latencyMs ?? Date.now() - start,
        success: input.success ?? true,
        inputSummary: input.inputSummary,
        outputSummary: input.outputSummary,
      });
      return result;
    } catch (err) {
      const errorSummary =
        input.errorSummary ?? (err instanceof Error ? err.message : String(err));
      this.builder.addToolCall({
        id: input.id,
        toolName: input.toolName,
        startedAt,
        endedAt: new Date().toISOString(),
        latencyMs: input.latencyMs ?? Date.now() - start,
        success: false,
        inputSummary: input.inputSummary,
        outputSummary: input.outputSummary,
        errorSummary,
      });
      throw err;
    }
  }

  addFileChanged(path: string): this {
    this.builder.addFileChanged(path);
    return this;
  }
  addCommandRun(command: string): this {
    this.builder.addCommandRun(command);
    return this;
  }
  addKnownError(error: string): this {
    this.builder.addKnownError(error);
    return this;
  }
  addNote(note: string): this {
    this.builder.addNote(note);
    return this;
  }
  setBuildResult(result: "pass" | "fail" | "unknown"): this {
    this.builder.setBuildResult(result);
    return this;
  }
  setLintResult(result: "pass" | "fail" | "unknown"): this {
    this.builder.setLintResult(result);
    return this;
  }
  finish(opts?: { endedAt?: string }): RecordedCodingSession {
    return this.builder.finish(opts);
  }
}

export function createRunLeakRecorder(input: {
  runName: string;
  objective: string;
  source?: RecordedCodingSession["source"];
  startedAt?: string;
}): RunLeakRecorder {
  return new RunLeakRecorder(input);
}
