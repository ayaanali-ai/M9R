/**
 * Agent Instructions — M9R
 * ----------------------------------------------------------------------------
 * Turns a Blackbox Report into the thing that actually changes behavior: a
 * clean, high-priority block of rules a user can paste at the top of their next
 * Claude / Cursor prompt, or save as `rules.md`.
 *
 * This is the "holy shit this helps" layer. It is PURE (no DOM, no I/O) so it
 * can be unit-tested and reused by any surface.
 *
 * Honesty rules (same discipline as the rest of M9R):
 *  - Instruction lines are derived from findings/signals that were actually
 *    detected — we never emit advice for a pattern that isn't in the report.
 *  - "Expected impact" only quotes numbers the trace/metrics literally support.
 *    When a number isn't measurable, we describe the qualitative win instead of
 *    inventing a figure.
 */

import type { BlackboxReport, Finding } from "@/lib/blackbox-report";
import type { TraceMetrics } from "@/lib/trace-metrics";
import { formatTokens, formatUsd } from "@/lib/trace-metrics";

export interface AgentRuleLine {
  /** The pasteable imperative, e.g. "Never retry the same failing command…". */
  text: string;
  priority: "high" | "medium" | "low";
  /** The finding/signal type this rule came from (for de-duplication). */
  sourceType: string;
}

/**
 * Canonical instruction line per finding type. One crisp imperative each — the
 * kind of line that genuinely improves the next run when pasted up top.
 */
const FINDING_INSTRUCTIONS: Record<string, { text: string; priority: "high" | "medium" | "low" }> = {
  retry_spiral: {
    text:
      "Never retry the exact same failing command more than once. After a failure, read the error and change strategy before re-running.",
    priority: "high",
  },
  cost_waste: {
    text:
      "Stop and diagnose after the first failed attempt. Do not spend tokens re-running work that already failed without new information.",
    priority: "high",
  },
  repeated_file_read: {
    text:
      "Read each file at most once per task. Cache or summarize its contents instead of re-reading the same file into context.",
    priority: "medium",
  },
  repeated_file_edit: {
    text:
      "Inspect the root cause before re-editing a file. Read it fully and plan the complete change, then apply it in one pass instead of trial-and-error edits.",
    priority: "medium",
  },
  missing_usage_metadata: {
    text:
      "Record token usage and cost on every model/tool response so the run stays measurable and auditable.",
    priority: "medium",
  },
  missing_model_identity: {
    text:
      "Include the model id in every step so model handoffs and cost are attributable.",
    priority: "low",
  },
};

/** Canonical instruction line per security-signal kind. */
const SIGNAL_INSTRUCTIONS: Record<string, { text: string; priority: "high" | "medium" | "low" }> = {
  unusual_model_switch: {
    text:
      "Pin one primary model for the core task. Only switch models for a specific, named sub-task — not mid-stream.",
    priority: "medium",
  },
};

/**
 * Derive the de-duplicated, priority-ordered set of agent rules implied by a
 * report's findings and security signals. Order: high → medium → low.
 */
export function deriveAgentRules(report: BlackboxReport): AgentRuleLine[] {
  const seen = new Set<string>();
  const lines: AgentRuleLine[] = [];

  const push = (sourceType: string, def?: { text: string; priority: "high" | "medium" | "low" }) => {
    if (!def || seen.has(sourceType)) return;
    seen.add(sourceType);
    lines.push({ text: def.text, priority: def.priority, sourceType });
  };

  for (const finding of report.findings) push(finding.type, FINDING_INSTRUCTIONS[finding.type]);
  for (const signal of report.securitySignals) push(signal.kind, SIGNAL_INSTRUCTIONS[signal.kind]);

  const rank = { high: 3, medium: 2, low: 1 } as const;
  return lines.sort((a, b) => rank[b.priority] - rank[a.priority]);
}

/**
 * Build the full, pasteable instruction block. Returns null when there's
 * nothing actionable — callers should hide the CTA rather than show an empty
 * block (we never pad it with filler advice).
 */
export function buildAgentInstructionBlock(report: BlackboxReport): string | null {
  const rules = deriveAgentRules(report);
  if (rules.length === 0) return null;

  const body = rules.map((r) => `* ${r.text}`).join("\n");
  return [
    "=== OATHLOCK RULES (HIGHEST PRIORITY) ===",
    "",
    body,
    "",
    "=== END OATHLOCK RULES ===",
  ].join("\n");
}

/**
 * Build a focused instruction snippet for a single recommendation — what the
 * per-recommendation "Copy as instruction" button hands over. Falls back to the
 * recommendation's own title when it isn't tied to a known finding type.
 */
export function recommendationInstruction(
  report: BlackboxReport,
  recommendationId: string,
): string | null {
  const rec = report.recommendations.find((r) => r.id === recommendationId);
  if (!rec) return null;

  // Prefer the canonical line(s) for the finding(s) that motivated this rec.
  const types = new Set(
    (rec.relatedFindingIds ?? [])
      .map((id) => report.findings.find((f) => f.id === id)?.type)
      .filter((t): t is string => Boolean(t)),
  );
  const lines = [...types]
    .map((t) => FINDING_INSTRUCTIONS[t]?.text)
    .filter((t): t is string => Boolean(t));

  // Fall back to a clean imperative built from the recommendation itself.
  if (lines.length === 0) lines.push(rec.title.replace(/^✓\s*/, "").trim());

  const body = lines.map((l) => `* ${l}`).join("\n");
  return ["=== OATHLOCK RULE (HIGHEST PRIORITY) ===", "", body, "", "=== END ==="].join("\n");
}

export interface ExpectedImpact {
  text: string;
  /** "win" → green/positive emphasis; "neutral" → quieter, still useful. */
  tone: "win" | "neutral";
}

/**
 * Honest, per-finding "expected impact" — what applying the rule would have
 * changed in THIS run. Numbers are taken only from real metrics/finding fields;
 * when nothing is measurable we return a qualitative win or null.
 */
export function expectedImpact(finding: Finding, metrics?: TraceMetrics): ExpectedImpact | null {
  const stepsTouched = finding.affectedSteps?.length ?? 0;

  switch (finding.type) {
    case "retry_spiral": {
      // Avoided re-runs = sum of (count - 1) over each repeated failing command.
      const avoided = (metrics?.repeatedFailures ?? []).reduce((a, rf) => a + (rf.count - 1), 0);
      const n = avoided > 0 ? avoided : metrics?.retries ?? 0;
      if (n <= 0 && stepsTouched === 0) return null;

      const parts: string[] = [];
      if (n > 0) parts.push(`avoided ${n} needless re-run${n === 1 ? "" : "s"} of the same failing command`);
      else parts.push(`avoided repeated failures across ${stepsTouched} steps`);

      // Only append measured/estimated waste — never invent it.
      const extras: string[] = [];
      if (metrics?.wasteTokens != null) extras.push(`${formatTokens(metrics.wasteTokens)} tokens`);
      if (metrics?.wasteUsd != null) extras.push(formatUsd(metrics.wasteUsd));
      const tail = extras.length ? ` (~${extras.join(" / ")} of wasted spend)` : "";

      return { text: `Would have ${parts[0]}${tail}.`, tone: "win" };
    }

    case "cost_waste": {
      if (metrics?.wasteUsd == null) return null;
      const est = metrics.costIsEstimated ? " (estimated from model pricing)" : "";
      const tok = metrics.wasteTokens != null ? ` / ${formatTokens(metrics.wasteTokens)} tokens` : "";
      return {
        text: `Would have recovered ~${formatUsd(metrics.wasteUsd)}${tok} of measured waste${est}.`,
        tone: "win",
      };
    }

    case "repeated_file_read": {
      if (stepsTouched < 2) return null;
      return {
        text: `Would have removed ${stepsTouched - 1} repeated file read${stepsTouched - 1 === 1 ? "" : "s"} from context.`,
        tone: "win",
      };
    }

    case "repeated_file_edit": {
      if (stepsTouched < 2) return null;
      // No fake precision: we don't claim a rule would have "collapsed N edits".
      // Edit churn is a workflow pattern, and we can't prove the counterfactual.
      return {
        text:
          "May reduce edit churn by forcing a root-cause pass before further edits to the same file.",
        tone: "neutral",
      };
    }

    case "missing_usage_metadata":
      return { text: "Makes every future run measurable — no estimates required.", tone: "neutral" };

    case "missing_model_identity":
      return { text: "Restores model attribution for cost and handoff analysis.", tone: "neutral" };

    default:
      return null;
  }
}

/**
 * How many of a report's findings are already covered by the user's active
 * workspace rules (matched by leakType === finding.type). Pure helper so the
 * "cumulative rules" summary stays honest and trivially testable.
 */
export function coveredFindingCount(
  report: BlackboxReport,
  activeRuleLeakTypes: string[],
): number {
  const covered = new Set(activeRuleLeakTypes);
  return report.findings.filter((f) => covered.has(f.type)).length;
}
