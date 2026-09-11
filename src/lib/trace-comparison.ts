// Trace Comparison — compare a baseline vs a controlled NormalizedManualTrace.
//
// CLAIM DISCIPLINE: This is a MANUAL NORMALIZED COMPARISON, not a measured
// benchmark. Token, cost, latency, model-call, energy, and heat comparisons are
// "unknown" unless real values are present in BOTH source traces. No numbers are
// invented. Detector counts/severity come only from actual detector output.

import type { NormalizedManualTrace } from "@/lib/manual-trace-normalizer";
import {
  detectCodingAgentWaste,
  type CodingAgentFinding,
} from "@/lib/coding-agent-detectors";

export type ComparisonDirection =
  | "improved"
  | "regressed"
  | "unchanged"
  | "unknown";

export type ComparisonMetric = {
  id: string;
  label: string;
  baselineValue: string | number | null;
  controlledValue: string | number | null;
  direction: ComparisonDirection;
  summary: string;
};

export type TraceComparison = {
  baselineRunName: string;
  controlledRunName: string;
  qualityPreserved: boolean | null;
  findingsReduced: boolean | null;
  metrics: ComparisonMetric[];
  baselineFindings: CodingAgentFinding[];
  controlledFindings: CodingAgentFinding[];
  summary: string;
  limitations: string[];
};

// Ordering used so "improved" means moving toward the better end.
const LABEL_RANK: Record<string, number> = {
  none: 0,
  low: 1,
  moderate: 2,
  high: 3,
};

const PASS_FAIL_RANK: Record<string, number> = {
  pass: 0,
  fail: 1,
};

// Lower-is-better direction from two numeric-ish ranks (null = unknown).
function directionLowerBetter(
  base: number | null,
  ctrl: number | null,
): ComparisonDirection {
  if (base === null || ctrl === null) return "unknown";
  if (ctrl < base) return "improved";
  if (ctrl > base) return "regressed";
  return "unchanged";
}

function rankLabel(value: string): number | null {
  return value in LABEL_RANK ? LABEL_RANK[value] : null;
}

function rankPassFail(value: string | null): number | null {
  if (value === null) return null;
  return value in PASS_FAIL_RANK ? PASS_FAIL_RANK[value] : null;
}

function countType(
  findings: CodingAgentFinding[],
  type: CodingAgentFinding["type"],
): number {
  return findings.filter((f) => f.type === type).length;
}

function findingMetric(
  id: string,
  label: string,
  type: CodingAgentFinding["type"],
  baseFindings: CodingAgentFinding[],
  ctrlFindings: CodingAgentFinding[],
): ComparisonMetric {
  const b = countType(baseFindings, type);
  const c = countType(ctrlFindings, type);
  const direction = directionLowerBetter(b, c);
  return {
    id,
    label,
    baselineValue: b,
    controlledValue: c,
    direction,
    summary:
      direction === "improved"
        ? `Fewer ${label.toLowerCase()} (${b} → ${c}).`
        : direction === "regressed"
          ? `More ${label.toLowerCase()} (${b} → ${c}).`
          : `No change in ${label.toLowerCase()} (${b}).`,
  };
}

// exact_* numeric fields: direction is "unknown" whenever either side is null.
function exactMetric(
  id: string,
  label: string,
  base: number | null,
  ctrl: number | null,
): ComparisonMetric {
  const direction =
    base === null || ctrl === null
      ? "unknown"
      : directionLowerBetter(base, ctrl);
  return {
    id,
    label,
    baselineValue: base,
    controlledValue: ctrl,
    direction,
    summary:
      direction === "unknown"
        ? "Not measured in the source traces; comparison unknown."
        : `${label}: ${base} → ${ctrl}.`,
  };
}

export function compareNormalizedRuns(input: {
  baseline: NormalizedManualTrace;
  controlled: NormalizedManualTrace;
}): TraceComparison {
  const { baseline, controlled } = input;

  const baselineFindings = detectCodingAgentWaste(baseline);
  const controlledFindings = detectCodingAgentWaste(controlled);

  const metrics: ComparisonMetric[] = [];

  // Build result
  metrics.push({
    id: "build_result",
    label: "Build result",
    baselineValue: baseline.build_result,
    controlledValue: controlled.build_result,
    direction: directionLowerBetter(
      rankPassFail(baseline.build_result),
      rankPassFail(controlled.build_result),
    ),
    summary: `Build: ${baseline.build_result ?? "unknown"} → ${controlled.build_result ?? "unknown"}.`,
  });

  // Lint result
  metrics.push({
    id: "lint_result",
    label: "Lint result",
    baselineValue: baseline.lint_result,
    controlledValue: controlled.lint_result,
    direction: directionLowerBetter(
      rankPassFail(baseline.lint_result),
      rankPassFail(controlled.lint_result),
    ),
    summary: `Lint: ${baseline.lint_result ?? "unknown"} → ${controlled.lint_result ?? "unknown"}.`,
  });

  // Correction loops (qualitative label)
  metrics.push({
    id: "correction_loops",
    label: "Correction loops",
    baselineValue: baseline.correction_loops,
    controlledValue: controlled.correction_loops,
    direction: directionLowerBetter(
      rankLabel(baseline.correction_loops),
      rankLabel(controlled.correction_loops),
    ),
    summary: `Correction loops: ${baseline.correction_loops} → ${controlled.correction_loops}.`,
  });

  // Known errors count
  metrics.push({
    id: "known_errors",
    label: "Known errors",
    baselineValue: baseline.known_errors.length,
    controlledValue: controlled.known_errors.length,
    direction: directionLowerBetter(
      baseline.known_errors.length,
      controlled.known_errors.length,
    ),
    summary: `Known errors: ${baseline.known_errors.length} → ${controlled.known_errors.length}.`,
  });

  // Per-detector finding counts
  metrics.push(
    findingMetric(
      "redundant_file_read",
      "Redundant file read findings",
      "redundant_file_read",
      baselineFindings,
      controlledFindings,
    ),
    findingMetric(
      "build_fix_loop",
      "Build-fix loop findings",
      "build_fix_loop",
      baselineFindings,
      controlledFindings,
    ),
    findingMetric(
      "ambiguous_edit_retry",
      "Ambiguous edit retry findings",
      "ambiguous_edit_retry",
      baselineFindings,
      controlledFindings,
    ),
    findingMetric(
      "scope_creep",
      "Scope creep findings",
      "scope_creep",
      baselineFindings,
      controlledFindings,
    ),
    findingMetric(
      "claims_drift",
      "Claims drift findings",
      "claims_drift",
      baselineFindings,
      controlledFindings,
    ),
    findingMetric(
      "duplicate_copy",
      "Duplicate copy findings",
      "duplicate_copy",
      baselineFindings,
      controlledFindings,
    ),
  );

  // Exact numeric fields — unknown unless present in both traces.
  metrics.push(
    exactMetric("exact_token_count", "Exact token count", baseline.exact_token_count, controlled.exact_token_count),
    exactMetric("exact_model_calls", "Exact model calls", baseline.exact_model_calls, controlled.exact_model_calls),
    exactMetric("exact_cost_usd", "Exact cost (USD)", baseline.exact_cost_usd, controlled.exact_cost_usd),
    exactMetric("exact_energy_wh", "Exact energy (Wh)", baseline.exact_energy_wh, controlled.exact_energy_wh),
  );

  // Findings reduced: total detector findings down, controlled?
  const findingsReduced =
    controlledFindings.length < baselineFindings.length
      ? true
      : controlledFindings.length > baselineFindings.length
        ? false
        : null;

  // New high-severity findings in controlled that weren't in baseline.
  const baselineTypes = new Set(baselineFindings.map((f) => f.type));
  const newHighSeverity = controlledFindings.filter(
    (f) => f.severity === "high" && !baselineTypes.has(f.type),
  );

  // Quality preserved: build/lint still pass AND no new high-severity findings.
  const buildOk =
    controlled.build_result === null
      ? null
      : controlled.build_result === "pass";
  const lintOk =
    controlled.lint_result === null ? null : controlled.lint_result === "pass";

  let qualityPreserved: boolean | null;
  if (newHighSeverity.length > 0) {
    qualityPreserved = false;
  } else if (buildOk === false || lintOk === false) {
    qualityPreserved = false;
  } else if (buildOk === null && lintOk === null) {
    qualityPreserved = null; // no build/lint evidence either way
  } else {
    qualityPreserved = true;
  }

  const summary = buildSummary({
    findingsReduced,
    qualityPreserved,
    newHighSeverity: newHighSeverity.length,
    baseCount: baselineFindings.length,
    ctrlCount: controlledFindings.length,
  });

  const limitations = [
    "Manual normalized comparison, not a measured benchmark.",
    "Token, cost, latency, model-call, energy, and heat remain unknown unless present in both source traces.",
    "Detector counts and severity are qualitative, derived from structured manual evidence.",
    "Quality-preserved is based on build/lint evidence and new high-severity findings only.",
  ];

  return {
    baselineRunName: baseline.run_name,
    controlledRunName: controlled.run_name,
    qualityPreserved,
    findingsReduced,
    metrics,
    baselineFindings,
    controlledFindings,
    summary,
    limitations,
  };
}

function buildSummary(args: {
  findingsReduced: boolean | null;
  qualityPreserved: boolean | null;
  newHighSeverity: number;
  baseCount: number;
  ctrlCount: number;
}): string {
  const parts: string[] = [];
  if (args.findingsReduced === true) {
    parts.push(
      `Detector findings decreased (${args.baseCount} → ${args.ctrlCount}).`,
    );
  } else if (args.findingsReduced === false) {
    parts.push(
      `Detector findings increased (${args.baseCount} → ${args.ctrlCount}).`,
    );
  } else {
    parts.push(`Detector findings unchanged (${args.baseCount}).`);
  }

  if (args.newHighSeverity > 0) {
    parts.push(
      `${args.newHighSeverity} new high-severity finding type(s) appeared in the controlled run.`,
    );
  }

  if (args.qualityPreserved === true) {
    parts.push("Quality appears preserved (build/lint evidence holds, no new high-severity findings).");
  } else if (args.qualityPreserved === false) {
    parts.push("Quality not preserved on available evidence.");
  } else {
    parts.push("Quality preservation is unknown without build/lint evidence.");
  }

  return parts.join(" ");
}
