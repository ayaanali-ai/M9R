// Recorded Session Adapter — convert a RecordedCodingSession into a
// NormalizedManualTrace, populating EXACT fields only from explicitly provided
// usage metadata. Missing usage stays null; nothing is estimated.
//
// This is the bridge that lets future recorded sessions flow through the same
// normalize -> detect -> compare -> benchmark pipeline as manual/imported
// traces, with the exact_* fields finally populated where real data exists.

import {
  normalizeManualTrace,
  type NormalizedManualTrace,
} from "@/lib/manual-trace-normalizer";
import type {
  RecordedCodingSession,
  RecordedModelCall,
} from "@/lib/trace-recorder-schema";
import { normalizeUsd } from "@/lib/provider-usage-mappers";

// Sum tokens from a single call using only explicit fields. Returns null when
// the call carries no token data (so we never fabricate a zero).
function tokensForCall(call: RecordedModelCall): number | null {
  if (typeof call.totalTokens === "number") return call.totalTokens;
  const hasInput = typeof call.inputTokens === "number";
  const hasOutput = typeof call.outputTokens === "number";
  if (!hasInput && !hasOutput) return null;
  return (hasInput ? (call.inputTokens as number) : 0) +
    (hasOutput ? (call.outputTokens as number) : 0);
}

// Sum across calls; null if NO call provided the metric (don't invent a 0).
function sumExplicit(
  calls: RecordedModelCall[],
  pick: (c: RecordedModelCall) => number | null,
): number | null {
  let total = 0;
  let any = false;
  for (const c of calls) {
    const v = pick(c);
    if (typeof v === "number") {
      total += v;
      any = true;
    }
  }
  return any ? total : null;
}

function normalizeBuildLint(
  v: RecordedCodingSession["buildResult"],
): "pass" | "fail" | null {
  return v === "pass" || v === "fail" ? v : null;
}

export function recordedSessionToNormalizedTrace(
  session: RecordedCodingSession,
): NormalizedManualTrace {
  // Build the qualitative layer via the existing normalizer (risks, waste
  // patterns, correction loops) using the session's narrative evidence.
  const rawSummary = [
    session.objective,
    ...session.notes,
    ...session.knownErrors,
    ...session.toolCalls.map((t) => t.errorSummary ?? "").filter(Boolean),
  ].join("\n");

  const base = normalizeManualTrace({
    runName: session.runName,
    objective: session.objective,
    rawSummary,
    commandsRun: session.commandsRun.join("\n"),
    filesChanged: session.filesChanged.join("\n"),
    knownErrors: session.knownErrors.join("\n"),
    notes: session.notes.join("\n"),
  });

  // Exact fields — from explicit metadata only.
  const exact_model_calls = session.modelCalls.length; // a real, listed count
  const exact_token_count = sumExplicit(session.modelCalls, tokensForCall);
  const exact_cost_usd_raw = sumExplicit(session.modelCalls, (c) =>
    typeof c.costUsd === "number" ? c.costUsd : null,
  );
  // Normalize float artifacts (e.g. 0.12000000000000001 -> 0.12) without
  // rounding to cents. No other adapter behavior changes.
  const exact_cost_usd =
    exact_cost_usd_raw === null ? null : normalizeUsd(exact_cost_usd_raw);

  // Latency: captured per-call in the recorder schema but the NormalizedManualTrace
  // schema has no latency field, so we surface it as a note rather than inventing
  // a field. (Energy is never recorder-measured.)
  const latencySum = sumExplicit(session.modelCalls, (c) =>
    typeof c.latencyMs === "number" ? c.latencyMs : null,
  );

  // Recorded-session imports are NOT "pasted evidence". Drop the generic manual
  // caveats that misdescribe a strict recorded import, but keep the per-note
  // entries the manual normalizer carries through. Then prepend accurate,
  // recorded-session-specific limitations. (Do not remove caveats entirely.)
  const MISLEADING_MANUAL_CAVEATS = new Set<string>([
    "Structured from pasted evidence; not a measured trace.",
    "Token, cost, latency, energy, and heat are null unless supplied in the source.",
    "Risk/waste labels are qualitative heuristics over the pasted text, not detector findings.",
  ]);

  const provenance: string[] = [
    `Imported from recorded session (schema ${session.schemaVersion}).`,
    "Exact model calls are counted from recorded modelCalls.",
    exact_token_count === null
      ? "Exact token count is summed only from explicit per-call token fields; none present, so it stays null."
      : "Exact token count is summed only from explicit per-call token fields.",
    exact_cost_usd === null
      ? "Exact cost is summed only from explicit per-call costUsd fields; none present, so it stays null."
      : "Exact cost is summed only from explicit per-call costUsd fields.",
    "Missing usage remains null/unknown.",
    latencySum === null
      ? "Recorded latency is captured per call but not yet represented in the normalized schema."
      : `Recorded latency is captured per call (total ≈ ${latencySum} ms) but not yet represented in the normalized schema.`,
    "exact_energy_wh stays null; energy/heat remain configurable estimates, not recorder-measured.",
    "Waste labels remain detector/heuristic findings, not provider measurements.",
  ];

  const carriedNotes = base.limitations.filter(
    (l) => !MISLEADING_MANUAL_CAVEATS.has(l),
  );

  return {
    ...base,
    files_changed: session.filesChanged.length ? session.filesChanged : base.files_changed,
    commands_run: session.commandsRun.length ? session.commandsRun : base.commands_run,
    known_errors: session.knownErrors.length ? session.knownErrors : base.known_errors,
    build_result: normalizeBuildLint(session.buildResult),
    lint_result: normalizeBuildLint(session.lintResult),
    quality_checks: {
      build_passes:
        normalizeBuildLint(session.buildResult) === null
          ? null
          : session.buildResult === "pass",
      lint_passes:
        normalizeBuildLint(session.lintResult) === null
          ? null
          : session.lintResult === "pass",
    },
    limitations: [...provenance, ...carriedNotes],
    exact_token_count,
    exact_model_calls,
    exact_cost_usd,
    exact_energy_wh: null,
  };
}
