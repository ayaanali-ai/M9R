/**
 * Trace normalizer — OathLock Phase 1
 *
 * Maps a raw uploaded trace (snake_case from external tools, camelCase, or a
 * provider-native shape) onto the canonical {@link Trace} consumed by
 * `generateBlackboxReport`, `computeTraceMetrics`, and the rule engine.
 *
 * Two hard rules:
 *  1. Never throw — a partial trace must still produce a report. Missing fields
 *     become null / empty arrays.
 *  2. Never fabricate measurements. Token/cost values are extracted only when
 *     actually present; absent values stay `null` (we do NOT fill with 0).
 *
 * Token & cost extraction is delegated to the provider-agnostic
 * {@link extractTokenUsage} / {@link extractCost} helpers, so OpenAI
 * (`usage.prompt_tokens`), Anthropic (`usage.input_tokens`), Gemini
 * (`usageMetadata.promptTokenCount`), OpenTelemetry (`gen_ai.usage.*`), and
 * camelCase shapes are all understood — at the step level and in `totals`.
 */

import type { Trace } from "@/lib/oathlock";
import { extractTokenUsage, extractCost, finiteNumber } from "@/lib/usage-normalization";

/** Read a string from any of the candidate keys, else null. */
function str(obj: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    if (typeof obj[k] === "string" && (obj[k] as string).trim()) return obj[k] as string;
  }
  return null;
}

/** Read a string[] from any of the candidate keys, else []. */
function strArray(obj: Record<string, unknown>, ...keys: string[]): string[] {
  for (const k of keys) {
    if (Array.isArray(obj[k])) return (obj[k] as unknown[]).filter((v) => typeof v === "string") as string[];
  }
  return [];
}

export function normalizeToTrace(raw: unknown): Trace {
  const r = (raw ?? {}) as Record<string, unknown>;
  const stepsRaw = Array.isArray(r.steps) ? (r.steps as Record<string, unknown>[]) : [];

  const steps = stepsRaw.map((s, index) => {
    // Provider-agnostic usage extraction. `usage` stays null when the step
    // carried no token data at all; partial usage keeps its nulls (no zero-fill).
    const usage = extractTokenUsage(s).usage;
    const cost = extractCost(s).costUsd;

    return {
      step: finiteNumber(s.step) ?? index + 1,
      timestamp: str(s, "timestamp") ?? null,
      actor: (str(s, "actor") as Trace["steps"][number]["actor"]) ?? null,
      model: str(s, "model", "model_name", "modelName"),
      tool: str(s, "tool", "tool_name", "toolName"),
      toolInputSummary: str(s, "tool_input_summary", "toolInputSummary"),
      toolOutputSummary: str(s, "tool_output_summary", "toolOutputSummary"),
      filesRead: strArray(s, "files_read", "filesRead"),
      filesWritten: strArray(s, "files_written", "filesWritten"),
      shellCommands: strArray(s, "shell_commands", "shellCommands"),
      errors: strArray(s, "errors"),
      retries: finiteNumber(s.retries) ?? 0,
      tokenUsage: usage,
      estimatedCostUsd: cost,
      missingMetadata: strArray(s, "missing_metadata", "missingMetadata"),
    };
  }) as Trace["steps"];

  return {
    schema: str(r, "schema") ?? "oathlock.trace.v0",
    variant: (str(r, "variant") as "clean" | "messy" | null) ?? null,
    provenance: str(r, "provenance"),
    sessionId: str(r, "session_id", "sessionId") ?? "unknown-session",
    taskSummary: str(r, "task_summary", "taskSummary", "task") ?? "Unknown task",
    startedAt: str(r, "started_at", "startedAt"),
    endedAt: str(r, "ended_at", "endedAt"),
    actorsObserved: strArray(r, "actors_observed", "actorsObserved"),
    steps,
    totals: normalizeTotals(r.totals, steps),
    missingMetadataGlobal: strArray(r, "missing_metadata_global", "missingMetadataGlobal"),
    anonymization: (r.anonymization as { applied: boolean; notes: string[] }) ?? {
      applied: false,
      notes: [],
    },
    inputProfile: normalizeInputProfile(r.input_profile ?? r.inputProfile),
  };
}

/** Map a snake_case input_profile (from the normalizer) onto the camelCase type. */
function normalizeInputProfile(raw: unknown): Trace["inputProfile"] {
  if (!raw || typeof raw !== "object") return undefined;
  const p = raw as Record<string, unknown>;
  const quality = String(p.source_quality ?? p.sourceQuality ?? "");
  if (!["strong", "medium", "limited", "insufficient"].includes(quality)) return undefined;
  return {
    format: String(p.format ?? "unknown"),
    formatLabel: String(p.format_label ?? p.formatLabel ?? "Unknown"),
    source: String(p.source ?? "unknown"),
    sourceLabel: String(p.source_label ?? p.sourceLabel ?? "Unknown"),
    sourceQuality: quality as NonNullable<Trace["inputProfile"]>["sourceQuality"],
    sourceQualityLabel: String(p.source_quality_label ?? p.sourceQualityLabel ?? ""),
    extracted: Array.isArray(p.extracted) ? (p.extracted as unknown[]).map(String) : [],
    unavailable: Array.isArray(p.unavailable) ? (p.unavailable as unknown[]).map(String) : [],
    reasons: Array.isArray(p.reasons) ? (p.reasons as unknown[]).map(String) : [],
  };
}

/**
 * Normalize the optional `totals` block.
 *
 * We only keep an authoritative aggregate token block when ALL THREE of
 * input/output/total are explicitly present — otherwise we omit it and let the
 * metrics layer sum per-step usage, which avoids presenting a partial aggregate
 * as if it were complete. Counts (steps/failed/retries) are derived from steps
 * when not supplied.
 */
function normalizeTotals(
  rawTotals: unknown,
  steps: Trace["steps"],
): Trace["totals"] {
  const t = (rawTotals ?? null) as Record<string, unknown> | null;

  const derivedFailed = steps.filter((s) => (s.errors?.length ?? 0) > 0).length;
  const derivedRetries = steps.reduce((a, s) => a + (s.retries ?? 0), 0);

  if (!t) {
    return {
      steps: steps.length,
      failedCommands: derivedFailed,
      retries: derivedRetries,
      tokenUsage: null,
      estimatedCostUsd: null,
    };
  }

  const agg = extractTokenUsage(t).usage;
  const completeAggregate =
    agg && agg.input != null && agg.output != null && agg.total != null
      ? { input: agg.input, output: agg.output, total: agg.total }
      : null;

  return {
    steps: finiteNumber(t.steps) ?? steps.length,
    failedCommands: finiteNumber(t.failed_commands) ?? finiteNumber(t.failedCommands) ?? derivedFailed,
    retries: finiteNumber(t.retries) ?? derivedRetries,
    tokenUsage: completeAggregate,
    estimatedCostUsd: extractCost(t).costUsd,
  };
}
