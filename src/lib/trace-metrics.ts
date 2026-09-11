/**
 * Trace Metrics — OathLock (client-safe, pure)
 * ----------------------------------------------------------------------------
 * Derives honest, measurable, and *useful* numbers from a normalized Trace:
 * token usage, recorded vs. estimated cost, retry/failure behavior, and waste.
 *
 * Guiding rules:
 *  - Never fabricate. A field is `null` when the trace can't support it, and
 *    callers render that as "not measurable", never as 0.
 *  - Be transparent about estimation. Cost the trace did not record but that we
 *    derive from a model price table is reported separately and flagged
 *    (`hasEstimatedCost` / `costIsEstimated`), never silently merged.
 *  - Make waste actionable: attribute tokens/cost to the steps that failed or
 *    were retried, so "Estimated waste: $X from repeated failures" is grounded.
 *
 * Consumers: the report's Token & Cost panel, run-history (improvement trends),
 * and the Blackbox report's waste findings.
 */

import type { Trace, TraceStep } from "@/lib/oathlock";
import { estimateCostFromTokens } from "@/lib/cost-model";

export interface RepeatedFailure {
  command: string;
  count: number;
}

/**
 * A block of tool input/output or shell-command text that recurred across
 * 3+ steps unchanged — the same context/command re-sent instead of reused.
 * Unlike `repeatedFailures` (retry-spiral evidence), this fires on successful
 * steps too: it's about redundant context construction, not failure.
 */
export interface RepeatedContextFinding {
  /** Where the repeated text was found. */
  source: "toolInputSummary" | "toolOutputSummary" | "shellCommands";
  /** Short preview of the repeated content, for display (never the full text). */
  preview: string;
  /** Total occurrences, including the first (non-wasted) one. */
  occurrences: number;
  /** Step numbers where this content reappeared — excludes the first occurrence. */
  wastedStepNumbers: number[];
  /** Tokens attributed to the non-first occurrences, when those steps reported usage. */
  wasteTokens: number | null;
  /** Cost attributed to the non-first occurrences, recorded or estimated. */
  wasteUsd: number | null;
}

export interface TraceMetrics {
  // --- Run shape ----------------------------------------------------------
  stepCount: number;
  failedSteps: number;
  /** failedSteps / stepCount, 0..1. */
  failedStepRatio: number;
  retries: number;
  /** retries / stepCount, 0..1. 0 when no steps. */
  retryRate: number;

  // --- Token usage --------------------------------------------------------
  /** True when at least one step (or totals) carried token usage. */
  hasTokenUsage: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  /** Fraction of steps carrying any token usage, 0..1. */
  tokenCoverage: number;
  /** Distinguishes measured totals from incomplete attribution. */
  usageCompleteness: "none" | "partial" | "complete";

  // --- Cost (recorded vs estimated) ---------------------------------------
  /** True when the trace explicitly recorded cost on a step or in totals. */
  hasCostData: boolean;
  /** Total of *recorded* cost only. Null when nothing recorded. */
  costUsd: number | null;
  /** Fraction of steps carrying explicit cost, 0..1. */
  costCoverage: number;
  /** True when we could derive any cost from token counts + the price table. */
  hasEstimatedCost: boolean;
  /** Model-priced estimate for steps lacking recorded cost. Null when none. */
  estimatedCostUsd: number | null;
  /**
   * Best available total cost: recorded where present, estimated elsewhere.
   * Null only when neither recorded nor estimable.
   */
  effectiveCostUsd: number | null;
  /** True when `effectiveCostUsd` includes any estimated (non-recorded) cost. */
  costIsEstimated: boolean;

  // --- Retry / failure behavior -------------------------------------------
  /** Commands that failed 2+ times — the core retry-spiral evidence. */
  repeatedFailures: RepeatedFailure[];
  /** True when the agent appears stuck (repeated identical failures / high retries). */
  stuckLoop: boolean;

  // --- Waste --------------------------------------------------------------
  /** Tokens spent on steps that failed or were retried (lower bound). */
  wasteTokens: number | null;
  /** Recorded-or-estimated cost of steps that failed or were retried. */
  wasteUsd: number | null;
  /** Plain-English basis for the waste numbers (always set). */
  wasteNote: string;

  // --- Repeated context (distinct from failure/retry waste above) --------
  /** Same tool input/output or shell command recurring 3+ times unchanged. */
  repeatedContextFindings: RepeatedContextFinding[];
  /** Sum of wasteTokens across all repeatedContextFindings, null if none measurable. */
  repeatedContextWasteTokens: number | null;
  /** Sum of wasteUsd across all repeatedContextFindings, null if none measurable. */
  repeatedContextWasteUsd: number | null;
  /** Plain-English basis for the repeated-context numbers (always set). */
  repeatedContextNote: string;

  // --- Models -------------------------------------------------------------
  distinctModels: string[];
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** A step "wasted" effort if it errored or was retried — no clean progress. */
function isWastedStep(s: TraceStep): boolean {
  return (s.errors?.length ?? 0) > 0 || (num(s.retries) ?? 0) > 0;
}

/**
 * Best-known USD cost for a single step: the recorded value if present,
 * otherwise a model-priced estimate. Returns `{ value, estimated }` so the
 * caller can track whether any estimation was involved.
 */
function stepCost(s: TraceStep): { value: number | null; estimated: boolean } {
  const recorded = num(s.estimatedCostUsd);
  if (recorded != null) return { value: recorded, estimated: false };

  const u = s.tokenUsage;
  const est = estimateCostFromTokens(s.model, num(u?.input), num(u?.output), num(u?.total));
  return { value: est, estimated: est != null };
}

const REPEATED_CONTEXT_MIN_OCCURRENCES = 3;
/** Below this length a repeated string is more likely boilerplate than real
 * waste (a short shell flag, a one-word tool name) — skip it. */
const REPEATED_CONTEXT_MIN_CHARS = 120;

function normalizeForRepetition(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function previewOf(value: string): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 79)}…` : trimmed;
}

/**
 * Detects the same tool input/output text or shell command recurring
 * unchanged across 3+ steps — the same context re-sent instead of cached and
 * reused. Adapted from the block-id + occurrence-threshold approach used by
 * repeated-context detectors elsewhere; this version works off the fields
 * this Trace schema actually records (no labeled prompt blocks exist here),
 * so grouping is by exact normalized-text match rather than fuzzy similarity.
 * The first occurrence of any group is never counted as waste.
 */
function detectRepeatedContext(steps: TraceStep[]): RepeatedContextFinding[] {
  const sources: Array<{ key: RepeatedContextFinding["source"]; get: (s: TraceStep) => string[] }> = [
    { key: "toolInputSummary", get: (s) => (s.toolInputSummary ? [s.toolInputSummary] : []) },
    { key: "toolOutputSummary", get: (s) => (s.toolOutputSummary ? [s.toolOutputSummary] : []) },
    { key: "shellCommands", get: (s) => s.shellCommands ?? [] },
  ];

  const findings: RepeatedContextFinding[] = [];

  for (const { key, get } of sources) {
    const groups = new Map<string, Array<{ stepNumber: number; step: TraceStep; text: string }>>();
    for (const step of steps) {
      for (const text of get(step)) {
        if (text.length < REPEATED_CONTEXT_MIN_CHARS) continue;
        const normalized = normalizeForRepetition(text);
        const bucket = groups.get(normalized) ?? [];
        bucket.push({ stepNumber: step.step, step, text });
        groups.set(normalized, bucket);
      }
    }

    for (const occurrences of groups.values()) {
      if (occurrences.length < REPEATED_CONTEXT_MIN_OCCURRENCES) continue;
      const [first, ...rest] = occurrences;
      let wasteTokens: number | null = null;
      let wasteUsd: number | null = null;
      for (const { step } of rest) {
        const t = num(step.tokenUsage?.total) ?? (num(step.tokenUsage?.input) ?? 0) + (num(step.tokenUsage?.output) ?? 0);
        if (t) wasteTokens = (wasteTokens ?? 0) + t;
        const { value: cost } = stepCost(step);
        if (cost != null) wasteUsd = (wasteUsd ?? 0) + cost;
      }
      findings.push({
        source: key,
        preview: previewOf(first.text),
        occurrences: occurrences.length,
        wastedStepNumbers: rest.map((o) => o.stepNumber),
        wasteTokens,
        wasteUsd,
      });
    }
  }

  return findings.sort((a, b) => (b.wasteUsd ?? b.wasteTokens ?? b.occurrences) - (a.wasteUsd ?? a.wasteTokens ?? a.occurrences));
}

function buildRepeatedContextNote(findings: RepeatedContextFinding[]): string {
  if (findings.length === 0) {
    return "No repeated context detected — nothing recurred unchanged across 3 or more steps.";
  }
  const totalOccurrences = findings.reduce((sum, f) => sum + (f.wastedStepNumbers.length), 0);
  return `${findings.length} repeated block${findings.length === 1 ? "" : "s"} of context sent unchanged across ${totalOccurrences} extra step${totalOccurrences === 1 ? "" : "s"} — the first use of each is not counted as waste. Detected waste is a lower bound: only steps with measurable usage are included.`;
}

/**
 * Compute measurable metrics from a normalized Trace.
 * Prefers explicit `totals` for token aggregates, falling back to summing steps.
 */
export function computeTraceMetrics(trace: Trace): TraceMetrics {
  const steps = trace.steps ?? [];
  const stepCount = steps.length;

  let failedSteps = 0;
  const models = new Set<string>();

  // Token accumulators — kept null until we see data, so "no usage" → null, not 0.
  let stepInput: number | null = null;
  let stepOutput: number | null = null;
  let stepTotal: number | null = null;
  let usageSteps = 0;
  let completeUsageSteps = 0;

  // Cost accumulators, split into recorded vs. estimated.
  let recordedCost: number | null = null;
  let estimatedOnlyCost: number | null = null;
  let costSteps = 0;

  // Waste accumulators (steps that failed or were retried).
  let wasteTokens: number | null = null;
  let wasteUsd: number | null = null;

  const failedCommandCounts = new Map<string, number>();

  for (const s of steps) {
    const failed = (s.errors?.length ?? 0) > 0;
    if (failed) failedSteps += 1;
    if (s.model && s.model.trim()) models.add(s.model.trim());

    // Tally repeated failing commands (retry-spiral evidence).
    if (failed) {
      for (const cmd of s.shellCommands ?? []) {
        const key = cmd.trim().toLowerCase();
        if (key) failedCommandCounts.set(key, (failedCommandCounts.get(key) ?? 0) + 1);
      }
    }

    // --- Tokens ---
    const usage = s.tokenUsage;
    const i = num(usage?.input);
    const o = num(usage?.output);
    const t = num(usage?.total) ?? (i != null && o != null ? i + o : null);
    if (usage != null && (i != null || o != null || t != null)) {
      usageSteps += 1;
      if (i != null) stepInput = (stepInput ?? 0) + i;
      if (o != null) stepOutput = (stepOutput ?? 0) + o;
      if (t != null) stepTotal = (stepTotal ?? 0) + t;
      if (i != null && o != null && t != null) completeUsageSteps += 1;
    }

    // --- Cost (recorded vs estimated) ---
    const { value: cost, estimated } = stepCost(s);
    if (cost != null) {
      if (estimated) estimatedOnlyCost = (estimatedOnlyCost ?? 0) + cost;
      else {
        recordedCost = (recordedCost ?? 0) + cost;
        costSteps += 1;
      }
    }

    // --- Waste attribution ---
    if (isWastedStep(s)) {
      if (t != null) wasteTokens = (wasteTokens ?? 0) + t;
      if (cost != null) wasteUsd = (wasteUsd ?? 0) + cost;
    }
  }

  // Prefer authoritative aggregate totals when the trace recorded them.
  const totals = trace.totals;
  const totalsTokens = totals?.tokenUsage ?? null;
  const totalsCost = num(totals?.estimatedCostUsd);

  const hasTokenUsage = usageSteps > 0 || (num(totalsTokens?.total) ?? 0) > 0;
  const inputTokens = num(totalsTokens?.input) ?? stepInput;
  const outputTokens = num(totalsTokens?.output) ?? stepOutput;
  const totalTokens =
    num(totalsTokens?.total) ?? stepTotal ?? (inputTokens != null && outputTokens != null ? inputTokens + outputTokens : null);

  // Recorded cost: prefer totals, else summed recorded step costs.
  const recordedTotal = totalsCost ?? recordedCost;
  const hasCostData = recordedTotal != null;
  const hasEstimatedCost = estimatedOnlyCost != null;
  const effectiveCostUsd =
    recordedTotal != null || estimatedOnlyCost != null
      ? (recordedTotal ?? 0) + (estimatedOnlyCost ?? 0)
      : null;
  const costIsEstimated = hasEstimatedCost;

  const retries = num(totals?.retries) ?? steps.reduce((a, s) => a + (num(s.retries) ?? 0), 0);

  // Retry-spiral evidence: identical commands that failed 2+ times.
  const repeatedFailures: RepeatedFailure[] = [...failedCommandCounts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([command, count]) => ({ command, count }))
    .sort((a, b) => b.count - a.count);
  const stuckLoop = repeatedFailures.length > 0 || retries >= 3 || failedSteps >= 3;

  const wasteNote = buildWasteNote(failedSteps, retries, wasteUsd, wasteTokens, costIsEstimated);

  const repeatedContextFindings = detectRepeatedContext(steps);
  const repeatedContextWasteTokens = repeatedContextFindings.some((f) => f.wasteTokens != null)
    ? repeatedContextFindings.reduce((sum, f) => sum + (f.wasteTokens ?? 0), 0)
    : null;
  const repeatedContextWasteUsd = repeatedContextFindings.some((f) => f.wasteUsd != null)
    ? repeatedContextFindings.reduce((sum, f) => sum + (f.wasteUsd ?? 0), 0)
    : null;
  const repeatedContextNote = buildRepeatedContextNote(repeatedContextFindings);

  return {
    stepCount,
    failedSteps,
    failedStepRatio: stepCount > 0 ? failedSteps / stepCount : 0,
    retries,
    retryRate: stepCount > 0 ? retries / stepCount : 0,

    hasTokenUsage,
    inputTokens: hasTokenUsage ? inputTokens : null,
    outputTokens: hasTokenUsage ? outputTokens : null,
    totalTokens: hasTokenUsage ? totalTokens : null,
    tokenCoverage: stepCount > 0 ? usageSteps / stepCount : 0,
    usageCompleteness: !hasTokenUsage
      ? "none"
      : usageSteps === stepCount && completeUsageSteps === stepCount
        ? "complete"
        : "partial",

    hasCostData,
    costUsd: hasCostData ? recordedTotal : null,
    costCoverage: stepCount > 0 ? costSteps / stepCount : 0,
    hasEstimatedCost,
    estimatedCostUsd: estimatedOnlyCost,
    effectiveCostUsd,
    costIsEstimated,

    repeatedFailures,
    stuckLoop,

    wasteTokens,
    wasteUsd,
    wasteNote,

    repeatedContextFindings,
    repeatedContextWasteTokens,
    repeatedContextWasteUsd,
    repeatedContextNote,

    distinctModels: [...models],
  };
}

/** Compose an honest, specific one-liner describing the waste basis. */
function buildWasteNote(
  failedSteps: number,
  retries: number,
  wasteUsd: number | null,
  wasteTokens: number | null,
  estimated: boolean,
): string {
  if (failedSteps === 0 && retries === 0) {
    return "No failed or retried steps — no waste attributed.";
  }
  const cause =
    failedSteps > 0 && retries > 0
      ? `${failedSteps} failed step(s) and ${retries} retr${retries === 1 ? "y" : "ies"}`
      : failedSteps > 0
        ? `${failedSteps} failed step(s)`
        : `${retries} retr${retries === 1 ? "y" : "ies"}`;

  if (wasteUsd == null && wasteTokens == null) {
    return `Waste from ${cause}, but those steps carried no token/cost data — impact not measurable.`;
  }
  const qualifier = estimated ? " (partly estimated from model pricing)" : "";
  return `Attributed to ${cause}${qualifier}. Lower bound — steps without usage data are excluded.`;
}

/** Compact human formatting helpers (honest about unknowns). */
export function formatTokens(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatUsd(n: number | null): string {
  if (n == null) return "—";
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}
