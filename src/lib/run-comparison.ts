/**
 * Run Comparison — OathLock v5
 * ----------------------------------------------------------------------------
 * Compares two analyzed coding-agent sessions (an original run and a later
 * follow-up) and reports whether behavior appears to have improved. This is the
 * foundation of the repeat-use loop: apply rules → run again → see if it helped.
 *
 * Honesty discipline (critical — this is where overclaiming is tempting):
 *  - We describe direction ("reduced in the follow-up run"), never certainty or
 *    attribution.
 *  - We never claim dollar savings unless both runs carry real cost metadata.
 *  - When the data can't support a conclusion, the verdict is `insufficient_data`.
 *
 * Pure module (no DOM/IO).
 */

import type { Trace } from "@/lib/oathlock";
import type { TraceMetrics } from "@/lib/trace-metrics";
import type { GeneratedRule, RuleType } from "@/lib/generated-rules";

// --- Per-run statistics -----------------------------------------------------

export interface RunStats {
  stepCount: number;
  /** Total retries recorded across the run. */
  retries: number;
  /** Extra occurrences of identical failing commands (repeat count − 1, summed). */
  repeatedCommands: number;
  /** Extra edits to already-edited files (edit count − 1, summed). */
  repeatedFileEdits: number;
  /** Steps that errored. */
  failedCommands: number;
  /** Steps that performed a tool call, command, or file op. */
  toolCalls: number;
  /** Distinct files written/edited. */
  changedFiles: number;
  /**
   * Conservative proxy for scope creep: distinct top-level directories touched.
   * (We can't prove intent from a trace; this is a signal, not a verdict.)
   */
  scopeCreepSignals: number;
  /** True when a test/build/lint command ran without erroring on that step. */
  verificationPresent: boolean;
  /** Total tokens, or null when the run carried no usage metadata. */
  totalTokens: number | null;
  /** Best-available cost, or null when neither recorded nor estimable. */
  costUsd: number | null;
}

const VERIFY_CMD_RE = /\b(test|tests|build|lint|typecheck|tsc|vitest|jest|pytest|mocha|check)\b/i;

/** Distinct top-level directory of a path ("src/lib/x.ts" → "src"). */
function topDir(path: string): string {
  const clean = path.trim().replace(/^\.\//, "");
  const slash = clean.indexOf("/");
  return slash === -1 ? "(root)" : clean.slice(0, slash);
}

/**
 * Reduce a normalized trace + its honest metrics into a comparable RunStats.
 * Reuses the existing metrics core for retries/failures/tokens/cost so the two
 * layers never disagree.
 */
export function summarizeRun(trace: Trace, metrics: TraceMetrics): RunStats {
  const steps = trace.steps ?? [];

  // Repeated edits: per-file edit counts, summed extra edits.
  const editCounts = new Map<string, number>();
  const changedFiles = new Set<string>();
  const dirs = new Set<string>();
  let toolCalls = 0;
  let verificationPresent = false;

  for (const s of steps) {
    const wrote = s.filesWritten ?? [];
    for (const f of wrote) {
      const key = f.trim().toLowerCase();
      if (!key) continue;
      editCounts.set(key, (editCounts.get(key) ?? 0) + 1);
      changedFiles.add(key);
      dirs.add(topDir(key));
    }
    const isAction =
      Boolean(s.tool) ||
      (s.shellCommands?.length ?? 0) > 0 ||
      (s.filesRead?.length ?? 0) > 0 ||
      wrote.length > 0;
    if (isAction) toolCalls += 1;

    // Verification: a test/build/lint command that did not error on its step.
    if ((s.errors?.length ?? 0) === 0) {
      for (const cmd of s.shellCommands ?? []) {
        if (VERIFY_CMD_RE.test(cmd)) verificationPresent = true;
      }
    }
  }

  const repeatedFileEdits = [...editCounts.values()].reduce((a, c) => a + Math.max(0, c - 1), 0);
  const repeatedCommands = (metrics.repeatedFailures ?? []).reduce(
    (a, rf) => a + Math.max(0, rf.count - 1),
    0,
  );

  return {
    stepCount: metrics.stepCount,
    retries: metrics.retries,
    repeatedCommands,
    repeatedFileEdits,
    failedCommands: metrics.failedSteps,
    toolCalls,
    changedFiles: changedFiles.size,
    scopeCreepSignals: dirs.size,
    verificationPresent,
    totalTokens: metrics.totalTokens,
    costUsd: metrics.effectiveCostUsd,
  };
}

// --- Comparison -------------------------------------------------------------

export type ComparisonVerdict = "improved" | "worsened" | "mixed" | "insufficient_data";

export interface MetricDelta {
  key: string;
  label: string;
  before: number | boolean | null;
  after: number | boolean | null;
  /**
   * Direction relative to "better": "down_is_good" metrics improve when after <
   * before; "up_is_good" (verification) improve when after > before.
   */
  direction: "down_is_good" | "up_is_good" | "neutral";
  /** Conservative grade/display state for the observed movement. */
  change: "improved" | "worsened" | "unchanged" | "unknown" | "increased" | "decreased" | "changed" | "needs_review";
  /** Careful human phrase, e.g. "reduced in the follow-up run". */
  note: string;
}

export interface RunComparison {
  metrics: MetricDelta[];
  verdict: ComparisonVerdict;
  /** Careful, non-causal summary sentence. */
  summary: string;
  /** True when token/cost could be compared (both runs had metadata). */
  costComparable: boolean;
}

function numberDelta(
  key: string,
  label: string,
  before: number,
  after: number,
  direction: "down_is_good" | "up_is_good",
): MetricDelta {
  let change: MetricDelta["change"] = "unchanged";
  if (after !== before) {
    const better = direction === "down_is_good" ? after < before : after > before;
    change = better ? "improved" : "worsened";
  }
  const note =
    change === "unchanged"
      ? "unchanged between runs"
      : change === "improved"
        ? "reduced in the follow-up run"
        : "increased in the follow-up run";
  // For up_is_good, flip the wording on direction of movement.
  const upNote =
    direction === "up_is_good" && change !== "unchanged"
      ? change === "improved"
        ? "present in the follow-up run"
        : "absent in the follow-up run"
      : note;
  return { key, label, before, after, direction, change, note: upNote };
}

function neutralNumberDelta(key: string, label: string, before: number, after: number): MetricDelta {
  const change: MetricDelta["change"] =
    after === before ? "unchanged" : after > before ? "increased" : "decreased";
  return {
    key,
    label,
    before,
    after,
    direction: "neutral",
    change,
    note:
      change === "unchanged"
        ? "unchanged between runs"
        : change === "increased"
          ? "increased in the follow-up run"
          : "decreased in the follow-up run",
  };
}

function changedFilesDelta(before: number, after: number): MetricDelta {
  return {
    key: "changedFiles",
    label: "Changed files",
    before,
    after,
    direction: "neutral",
    change: before === after ? "unchanged" : "changed",
    note: before === after ? "unchanged between runs" : "changed between runs",
  };
}

function failedCommandsDelta(before: RunStats, after: RunStats): MetricDelta {
  if (after.failedCommands === before.failedCommands) {
    return {
      key: "failedCommands",
      label: "Failed commands",
      before: before.failedCommands,
      after: after.failedCommands,
      direction: "neutral",
      change: "unchanged",
      note: "unchanged between runs",
    };
  }

  if (after.failedCommands < before.failedCommands) {
    return {
      key: "failedCommands",
      label: "Failed commands",
      before: before.failedCommands,
      after: after.failedCommands,
      direction: "down_is_good",
      change: "improved",
      note: "reduced in the follow-up run",
    };
  }

  const repeatedHarmfulPattern = after.repeatedCommands > before.repeatedCommands;
  return {
    key: "failedCommands",
    label: "Failed commands",
    before: before.failedCommands,
    after: after.failedCommands,
    direction: repeatedHarmfulPattern ? "down_is_good" : "neutral",
    change: repeatedHarmfulPattern ? "worsened" : "increased",
    note: repeatedHarmfulPattern
      ? "increased with repeated failing-command evidence in the follow-up run"
      : "increased in the follow-up run; review manually",
  };
}

/**
 * Compare two runs. Conservative by construction: a verdict of "improved"
 * requires at least one harmful behavior pattern to decrease. Verification and
 * neutral activity counts are reported, but they do not make behavior improved.
 */
export function compareRuns(before: RunStats, after: RunStats): RunComparison {
  const metrics: MetricDelta[] = [
    numberDelta("retries", "Retry spirals", before.retries, after.retries, "down_is_good"),
    numberDelta("repeatedCommands", "Repeated commands", before.repeatedCommands, after.repeatedCommands, "down_is_good"),
    numberDelta("repeatedFileEdits", "Repeated file edits", before.repeatedFileEdits, after.repeatedFileEdits, "down_is_good"),
    failedCommandsDelta(before, after),
    neutralNumberDelta("toolCalls", "Tool calls", before.toolCalls, after.toolCalls),
    changedFilesDelta(before.changedFiles, after.changedFiles),
    numberDelta(
      "verification",
      "Verification present",
      before.verificationPresent ? 1 : 0,
      after.verificationPresent ? 1 : 0,
      "up_is_good",
    ),
  ];

  // Cost/tokens only when BOTH runs recorded usage — never invent a delta.
  const costComparable = before.totalTokens != null && after.totalTokens != null;
  if (costComparable) {
    metrics.push(
      numberDelta("totalTokens", "Total tokens", before.totalTokens!, after.totalTokens!, "down_is_good"),
    );
  }
  if (before.costUsd != null && after.costUsd != null) {
    metrics.push(numberDelta("costUsd", "Cost (USD)", before.costUsd, after.costUsd, "down_is_good"));
  }

  // Verdict from harmful behavior metrics only. Neutral activity and objective
  // verification are useful signals, but not behavior-improvement evidence.
  const harmfulKeys = new Set(["retries", "repeatedCommands", "repeatedFileEdits", "failedCommands"]);
  const harmfulMoved = metrics.filter(
    (m) => harmfulKeys.has(m.key) && (m.change === "improved" || m.change === "worsened"),
  );
  const improved = harmfulMoved.filter((m) => m.change === "improved").length;
  const worsened = harmfulMoved.filter((m) => m.change === "worsened").length;

  // Insufficient: both runs essentially featureless, or nothing moved at all.
  const featureless =
    before.toolCalls + before.retries + before.failedCommands + before.repeatedFileEdits === 0 &&
    after.toolCalls + after.retries + after.failedCommands + after.repeatedFileEdits === 0;

  let verdict: ComparisonVerdict;
  if (featureless || harmfulMoved.length === 0) verdict = "insufficient_data";
  else if (improved > 0 && worsened === 0) verdict = "improved";
  else if (worsened > 0 && improved === 0) verdict = "worsened";
  else verdict = "mixed";

  const summary =
    verdict === "improved"
      ? "Harmful behavior patterns decreased in the follow-up run. This is an observed change between two sessions, not proof that a rule changed the outcome."
      : verdict === "worsened"
        ? "Behavior appears to have regressed in the follow-up run. Review whether the rules were applied and whether the task was comparable."
        : verdict === "mixed"
          ? "Results are mixed: some patterns reduced while others increased. Insufficient evidence to attribute the change to the rules."
          : "Evidence is mixed or insufficient. No harmful behavior pattern decreased enough to call behavior improved.";

  return { metrics, verdict, summary, costComparable };
}

// --- Rule-level notes -------------------------------------------------------

export type RuleNote =
  | "appears_useful"
  | "needs_more_evidence"
  | "may_be_too_vague"
  | "should_retire"
  | "should_rewrite";

export const RULE_NOTE_LABELS: Record<RuleNote, string> = {
  appears_useful: "Rule appears useful",
  needs_more_evidence: "Rule needs more evidence",
  may_be_too_vague: "Rule may be too vague",
  should_retire: "Rule should be retired",
  should_rewrite: "Rule should be rewritten",
};

/** Which comparison metric a rule type is judged against. */
const RULE_METRIC: Partial<Record<RuleType, string>> = {
  retry_prevention: "retries",
  edit_thrash_prevention: "repeatedFileEdits",
  context_control: "toolCalls",
  cost_control: "totalTokens",
  verification: "verification",
  security: "toolCalls",
};

/**
 * Suggest a curation note per rule, grounded in whether its target metric moved.
 * Conservative: no movement → "needs more evidence", not "useless".
 */
export function ruleLevelNotes(
  rules: GeneratedRule[],
  comparison: RunComparison,
): Array<{ ruleId: string; note: RuleNote }> {
  const byKey = new Map(comparison.metrics.map((m) => [m.key, m]));
  return rules.map((rule) => {
    const metricKey = RULE_METRIC[rule.ruleType];
    const metric = metricKey ? byKey.get(metricKey) : undefined;

    let note: RuleNote;
    if (rule.confidence === "low") note = "may_be_too_vague";
    else if (!metric || metric.change === "unknown") note = "needs_more_evidence";
    else if (metric.change === "improved") note = "appears_useful";
    else if (metric.change === "worsened") note = "should_rewrite";
    else note = "needs_more_evidence"; // unchanged

    return { ruleId: rule.id, note };
  });
}
