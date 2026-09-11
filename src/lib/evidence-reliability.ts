/**
 * Evidence Reliability — OathLock
 * ----------------------------------------------------------------------------
 * The honesty layer that sits underneath every report. It answers two
 * questions for each metric and finding, separately:
 *
 *   1. How well is this supported by what we can actually see? (evidenceSupport)
 *   2. How reliable is the resulting number/claim?            (metricReliability)
 *
 * Core product principle (non-negotiable):
 *   - Behavioral findings (retry spirals, repeated edits, missing verification,
 *     repeated commands, repeated corrections) are the core product. They work
 *     WITHOUT any token/cost metadata.
 *   - Usage findings (exact tokens, exact cost, cache usage, per-model cost) are
 *     OPTIONAL. They are only as strong as the metadata that backs them.
 *   - A report is NEVER blocked just because usage metadata is missing.
 *
 * This module is pure (no IO/DOM) so it is unit-testable and reusable by the
 * report engine, the rule generator, and the report UI.
 */

import type { Trace } from "@/lib/oathlock";
import type { TraceMetrics } from "@/lib/trace-metrics";

// ---------------------------------------------------------------------------
// Evidence support — WHY a metric/finding has the strength it does.
// ---------------------------------------------------------------------------

/**
 * How a metric or finding is supported by the available data.
 *
 * - observed:        Directly visible in the session text/structure (a failed
 *                    command, a repeated file path, an error line). No metadata
 *                    required. This is the bedrock of behavioral analysis.
 * - metadata_backed: Backed by exact structured usage/cost fields present in the
 *                    trace (tokenUsage, estimatedCostUsd, totals).
 * - estimated:       Inferred from visible text (e.g. repeated identical
 *                    transcript blocks, model price tables) but NOT from exact
 *                    usage fields. Must always be labeled as an estimate.
 * - unavailable:     There is insufficient data to support or estimate the
 *                    claim (e.g. cost with no token/cost metadata at all).
 */
export type EvidenceSupport =
  | "observed"
  | "metadata_backed"
  | "estimated"
  | "unavailable";

/**
 * How reliable the resulting metric/claim is, for quick triage.
 *
 * - high:   observed structurally, or backed by exact metadata.
 * - medium: estimated from strong visible signals.
 * - low:    estimated from weak/partial signals.
 * - none:   unavailable — we cannot stand behind a number.
 */
export type MetricReliability = "high" | "medium" | "low" | "none";

/** Whether a finding is core (behavioral) or optional (usage). */
export type FindingCategory = "behavioral" | "usage";

export const EVIDENCE_SUPPORT_LABELS: Record<EvidenceSupport, string> = {
  observed: "Observed",
  metadata_backed: "Metadata-backed",
  estimated: "Estimated",
  unavailable: "Unavailable",
};

export const METRIC_RELIABILITY_LABELS: Record<MetricReliability, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
  none: "None",
};

/**
 * Behavioral finding types. These are the core product and must be detectable
 * with ZERO token/cost metadata. Keep in sync with blackbox-report detectors.
 */
export const BEHAVIORAL_FINDING_TYPES = new Set<string>([
  "retry_spiral",
  "repeated_command",
  "repeated_file_read",
  "repeated_file_edit",
  "missing_verification",
  "scope_creep",
  "repeated_user_correction",
  "model_handoff",
  "final_claim_without_evidence",
  "missing_model_identity",
]);

/**
 * Usage finding types. These require stronger evidence (structured metadata) and
 * must never block a report when absent.
 */
export const USAGE_FINDING_TYPES = new Set<string>([
  "cost_waste",
  "token_waste",
  "exact_token_usage",
  "exact_cost",
  "cache_usage",
  "model_cost_breakdown",
  "missing_usage_metadata",
]);

/** Classify a finding type as behavioral (core) or usage (optional). */
export function categorizeFinding(type: string): FindingCategory {
  return USAGE_FINDING_TYPES.has(type) ? "usage" : "behavioral";
}

/** Map an EvidenceSupport level onto a default MetricReliability. */
export function reliabilityForSupport(support: EvidenceSupport): MetricReliability {
  switch (support) {
    case "observed":
    case "metadata_backed":
      return "high";
    case "estimated":
      return "medium";
    case "unavailable":
      return "none";
  }
}

// ---------------------------------------------------------------------------
// Honest copy — replaces dead-end "missing metadata" language.
// ---------------------------------------------------------------------------

/** Useful language for when exact usage/cost cannot be computed. */
export const USAGE_UNAVAILABLE_COPY =
  "Exact token/cost analysis is unavailable because this session does not include usage metadata. " +
  "M9R can still analyze visible behavior such as repeated commands, repeated edits, missing verification, and repeated context blocks.";

/** Shown when a clean/weak session yields no high-confidence repeat patterns. */
export const NO_NEW_RULE_COPY =
  "No high-confidence repeat patterns found. No new workspace rule recommended from this session.";

// ---------------------------------------------------------------------------
// Parser confidence summary — shown at the top of every report.
// ---------------------------------------------------------------------------

export type ParserConfidence = "high" | "medium" | "low" | "none";

export interface ParserConfidenceSummary {
  /** Overall confidence in how well the session was parsed into structure. */
  confidence: ParserConfidence;
  /** One-line, honest reason for the confidence level. */
  reason: string;

  // --- Counts the user can verify against their own session ---------------
  turnsDetected: number;
  commandsDetected: number;
  failedCommandsDetected: number;
  filesMentioned: number;
  filesEdited: number;

  // --- Capability flags ---------------------------------------------------
  /** True when the trace carries any structured metadata (totals / provenance). */
  metadataDetected: boolean;
  /** True when exact token or cost usage fields are present. */
  usageFieldsDetected: boolean;
}

const STRUCTURED_SCHEMA_RE = /trace|oathlock|jsonl?/i;

/**
 * Compute the parser-confidence summary for a normalized trace.
 *
 * Confidence reflects how much structure we could extract — NOT whether usage
 * metadata exists. A clean structured trace with no tokens is still high
 * confidence; a wall of natural-language prose with no commands is low/none.
 */
export function computeParserConfidence(
  trace: Trace,
  metrics?: TraceMetrics,
): ParserConfidenceSummary {
  const steps = trace.steps ?? [];

  const commands = steps.flatMap((s) => s.shellCommands ?? []);
  const failedCommands = steps.filter(
    (s) => (s.errors?.length ?? 0) > 0 && (s.shellCommands?.length ?? 0) > 0,
  ).length;
  const filesMentioned = new Set(
    steps.flatMap((s) => [...(s.filesRead ?? []), ...(s.filesWritten ?? [])]),
  ).size;
  const filesEdited = new Set(steps.flatMap((s) => s.filesWritten ?? [])).size;

  const tools = steps.filter((s) => s.tool != null && s.tool !== "").length;
  const errors = steps.filter((s) => (s.errors?.length ?? 0) > 0).length;
  const turns = trace.actorsObserved?.length
    ? Math.max(trace.actorsObserved.length, 0)
    : 0;

  const usageFieldsDetected =
    metrics?.hasTokenUsage === true ||
    metrics?.hasCostData === true ||
    steps.some((s) => s.tokenUsage != null || s.estimatedCostUsd != null) ||
    (trace.totals?.tokenUsage?.total ?? 0) > 0 ||
    (trace.totals?.estimatedCostUsd ?? null) != null;

  const metadataDetected =
    usageFieldsDetected ||
    (trace.schema != null && STRUCTURED_SCHEMA_RE.test(trace.schema)) ||
    (trace.totals != null && (trace.totals.steps ?? 0) > 0);

  // Signal strength: how many concrete, structural actions did we extract?
  const structuralSignals = commands.length + tools + filesMentioned + errors;
  const isStructured =
    trace.schema != null &&
    STRUCTURED_SCHEMA_RE.test(trace.schema) &&
    trace.variant !== "messy";

  let confidence: ParserConfidence;
  let reason: string;

  if (steps.length === 0 || structuralSignals === 0) {
    confidence = "none";
    reason =
      "Insufficient session content — no commands, tool calls, file operations, or errors could be extracted.";
  } else if (isStructured && structuralSignals >= 2) {
    confidence = "high";
    reason =
      "Structured trace with clear tool/command/file sections.";
  } else if (structuralSignals >= 4 || (commands.length >= 2 && (errors >= 1 || filesMentioned >= 1))) {
    confidence = "medium";
    reason =
      "Messy transcript with enough visible commands, edits, and/or errors to analyze behavior.";
  } else {
    confidence = "low";
    reason =
      "Partial session or mostly natural language — limited extractable structure.";
  }

  return {
    confidence,
    reason,
    turnsDetected: turns,
    commandsDetected: commands.length,
    failedCommandsDetected: failedCommands,
    filesMentioned,
    filesEdited,
    metadataDetected,
    usageFieldsDetected,
  };
}

// ---------------------------------------------------------------------------
// Usage / cost claim guards — single source of truth for what may be shown.
// ---------------------------------------------------------------------------

/**
 * Whether an EXACT dollar cost may be shown. Only true when the trace recorded
 * cost metadata. Estimated cost is NOT exact and must be labeled separately.
 */
export function canShowExactCost(metrics: TraceMetrics): boolean {
  return metrics.hasCostData === true && metrics.costUsd != null;
}

/**
 * Whether EXACT token usage may be shown. Only true when token fields exist.
 */
export function canShowExactTokens(metrics: TraceMetrics): boolean {
  return metrics.hasTokenUsage === true && metrics.totalTokens != null;
}

/**
 * Whether a "saved $X" / before-after savings claim may be made. Requires real
 * recorded cost on both sides — OathLock never claims savings from estimates.
 */
export function canClaimSavings(
  before: TraceMetrics,
  after: TraceMetrics,
): boolean {
  return canShowExactCost(before) && canShowExactCost(after);
}

/**
 * The evidence support for a cost/token claim, derived purely from metrics.
 * - metadata_backed when exact fields exist
 * - estimated when we could only price from tokens / visible repetition
 * - unavailable otherwise
 */
export function usageEvidenceSupport(
  metrics: TraceMetrics,
  kind: "cost" | "tokens",
): EvidenceSupport {
  if (kind === "cost") {
    if (canShowExactCost(metrics)) return "metadata_backed";
    if (metrics.hasEstimatedCost) return "estimated";
    return "unavailable";
  }
  if (canShowExactTokens(metrics)) return "metadata_backed";
  if (metrics.wasteTokens != null) return "estimated";
  return "unavailable";
}
