// Provider Usage Mappers — convert explicit provider usage metadata into
// RunLeak RecordedModelCall objects. Prepares RunLeak for a future live recorder
// WITHOUT building one. No external API calls, no model interception.
//
// STRICT RULES: explicit token fields only; never infer missing tokens; never
// estimate cost from tokens; never estimate energy/heat. totalTokens is derived
// only when both input and output are explicit. See docs/claims.md.

import type { RecordedModelCall } from "@/lib/trace-recorder-schema";

export type ProviderUsageKind =
  | "openai_responses"
  | "anthropic_messages"
  | "google_gemini"
  | "xai_grok"
  | "local_runtime";

// Normalize floating-point artifacts (e.g. 0.12000000000000001 -> 0.12) without
// rounding to cents — keeps up to 8 decimals, appropriate for API costs.
export function normalizeUsd(value: number): number {
  if (!Number.isFinite(value)) return value;
  return Number(value.toFixed(8));
}

function assertNonNegInt(
  value: number | null | undefined,
  field: string,
): void {
  if (value === null || value === undefined) return;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer when present.`);
  }
}

function assertNonNeg(
  value: number | null | undefined,
  field: string,
): void {
  if (value === null || value === undefined) return;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative number when present.`);
  }
}

// Shared assembly. Derives totalTokens only when both input and output are
// explicit; preserves an explicit total when provided. Never invents usage.
function buildModelCall(input: {
  id: string;
  provider: RecordedModelCall["provider"];
  model?: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  costUsd?: number | null;
  latencyMs?: number | null;
  startedAt?: string;
  endedAt?: string;
  promptSummary?: string;
  outputSummary?: string;
}): RecordedModelCall {
  if (!input.id || !input.id.trim()) {
    throw new Error("model call id is required.");
  }
  assertNonNegInt(input.inputTokens, "inputTokens");
  assertNonNegInt(input.outputTokens, "outputTokens");
  assertNonNegInt(input.totalTokens, "totalTokens");
  assertNonNeg(input.costUsd, "costUsd");
  assertNonNeg(input.latencyMs, "latencyMs");

  const inputTokens = input.inputTokens ?? null;
  const outputTokens = input.outputTokens ?? null;

  let totalTokens: number | null = input.totalTokens ?? null;
  if (
    totalTokens === null &&
    typeof inputTokens === "number" &&
    typeof outputTokens === "number"
  ) {
    totalTokens = inputTokens + outputTokens;
  }

  const costUsd =
    typeof input.costUsd === "number" ? normalizeUsd(input.costUsd) : input.costUsd ?? null;

  return {
    id: input.id,
    provider: input.provider,
    model: input.model,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd,
    latencyMs: input.latencyMs ?? null,
    promptSummary: input.promptSummary,
    outputSummary: input.outputSummary,
  };
}

export function mapOpenAIUsageToModelCall(input: {
  id: string;
  model?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  costUsd?: number | null;
  latencyMs?: number | null;
  startedAt?: string;
  endedAt?: string;
  promptSummary?: string;
  outputSummary?: string;
}): RecordedModelCall {
  return buildModelCall({
    id: input.id,
    provider: "openai",
    model: input.model,
    inputTokens: input.usage?.input_tokens ?? null,
    outputTokens: input.usage?.output_tokens ?? null,
    totalTokens: input.usage?.total_tokens ?? null,
    costUsd: input.costUsd ?? null,
    latencyMs: input.latencyMs ?? null,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    promptSummary: input.promptSummary,
    outputSummary: input.outputSummary,
  });
}

export function mapAnthropicUsageToModelCall(input: {
  id: string;
  model?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  costUsd?: number | null;
  latencyMs?: number | null;
  startedAt?: string;
  endedAt?: string;
  promptSummary?: string;
  outputSummary?: string;
}): RecordedModelCall {
  // Anthropic reports input/output only; total is derived (both explicit) or null.
  return buildModelCall({
    id: input.id,
    provider: "anthropic",
    model: input.model,
    inputTokens: input.usage?.input_tokens ?? null,
    outputTokens: input.usage?.output_tokens ?? null,
    totalTokens: null,
    costUsd: input.costUsd ?? null,
    latencyMs: input.latencyMs ?? null,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    promptSummary: input.promptSummary,
    outputSummary: input.outputSummary,
  });
}

export function mapGenericUsageToModelCall(input: {
  id: string;
  provider?: RecordedModelCall["provider"];
  model?: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  costUsd?: number | null;
  latencyMs?: number | null;
  startedAt?: string;
  endedAt?: string;
  promptSummary?: string;
  outputSummary?: string;
}): RecordedModelCall {
  return buildModelCall({
    id: input.id,
    provider: input.provider ?? "unknown",
    model: input.model,
    inputTokens: input.inputTokens ?? null,
    outputTokens: input.outputTokens ?? null,
    totalTokens: input.totalTokens ?? null,
    costUsd: input.costUsd ?? null,
    latencyMs: input.latencyMs ?? null,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    promptSummary: input.promptSummary,
    outputSummary: input.outputSummary,
  });
}
