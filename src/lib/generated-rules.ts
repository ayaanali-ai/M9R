/**
 * Generated Rules — OathLock v5
 * ----------------------------------------------------------------------------
 * The rule-quality layer. Wraps the existing Blackbox Report (we do NOT replace
 * the parser/report core) and turns each observed pattern into a specific,
 * behavioral, evidence-backed rule an agent can actually follow on the next run.
 *
 * Design tenets:
 *  - Rules are SPECIFIC and BEHAVIORAL ("after a command fails twice, do not
 *    rerun it unless inputs changed"), never vague ("be careful", "write clean
 *    code"). Vague rules are worse than none — they train nothing.
 *  - Every rule is tied to a finding and carries an honest evidence summary and
 *    a careful, non-overclaiming expectedPrevention ("may reduce…", "appears…").
 *  - Confidence and status are derived from evidence strength, so curation can
 *    keep the rule set small and high-signal over time.
 *
 * This module is pure (no DOM/IO) so it is unit-testable and reusable by the
 * report UI, the rules-file generator, and the run-comparison layer.
 */

import type { BlackboxReport, Finding } from "@/lib/blackbox-report";
import type { TraceMetrics } from "@/lib/trace-metrics";
import type { EvidenceLevel } from "@/lib/oathlock";
import { type EvidenceSupport, NO_NEW_RULE_COPY } from "@/lib/evidence-reliability";

// --- Schema -----------------------------------------------------------------

export type RuleType =
  | "retry_prevention"
  | "edit_thrash_prevention"
  | "scope_control"
  | "verification"
  | "context_control"
  | "security"
  | "metadata"
  | "cost_control"
  | "output_quality"
  | "project_memory";

export type RuleConfidence = "high" | "medium" | "low";

export type RuleStatus = "active" | "needs_review" | "low_confidence" | "retired";

export interface GeneratedRule {
  id: string;
  title: string;
  /** The behavioral instruction the agent should follow. Specific + enforceable. */
  body: string;
  ruleType: RuleType;
  confidence: RuleConfidence;
  /** Honest, short summary of the trace evidence behind this rule. */
  evidenceSummary: string;
  /** The finding this rule was generated from (null for synthesized rules). */
  sourceFindingId: string | null;
  /** Careful, non-overclaiming statement of what this may prevent. */
  expectedPrevention: string;
  createdAt: string;
  status: RuleStatus;
  /** Optional curation/usage telemetry (populated by comparison + health over time). */
  lastSeenAt?: string;
  timesTriggered?: number;
  timesHelped?: number;
}

// --- Finding → rule blueprint -----------------------------------------------

interface RuleBlueprint {
  ruleType: RuleType;
  title: string;
  body: string;
  expectedPrevention: string;
}

/**
 * Canonical, specific rule text per finding type. These are deliberately the
 * "good rules" — behavioral and checkable — not platitudes.
 */
const FINDING_BLUEPRINTS: Record<string, RuleBlueprint> = {
  retry_spiral: {
    ruleType: "retry_prevention",
    title: "Stop retrying unchanged failing commands",
    body:
      "After a command fails twice, do not rerun the same command unless the code, config, dependencies, environment variables, or command arguments have changed. Read the error and change strategy first.",
    expectedPrevention: "May reduce repeated identical command failures and the retry loops that follow them.",
  },
  repeated_file_edit: {
    ruleType: "edit_thrash_prevention",
    title: "Inspect root cause before re-editing a file",
    body:
      "After editing the same file twice for the same issue, stop and inspect the root cause before editing again. Read the file fully and plan the complete change, then apply it in one pass.",
    expectedPrevention: "May reduce trial-and-error edit churn on a single file.",
  },
  repeated_file_read: {
    ruleType: "context_control",
    title: "Read each file once per task",
    body:
      "Read each file at most once per task. Reference cached content or a short summary instead of re-reading the same file into context.",
    expectedPrevention: "May reduce context bloat from re-reading the same files.",
  },
  cost_waste: {
    ruleType: "cost_control",
    title: "Diagnose before spending more on a failed path",
    body:
      "Stop and diagnose after the first failed attempt instead of spending more tokens re-running work that already failed without new information.",
    expectedPrevention: "May reduce spend on steps that repeat failed work.",
  },
  // NOTE: metadata-quality findings (missing_usage_metadata,
  // missing_model_identity) are intentionally NOT mapped to workspace rules.
  // They are honest report-level notes about what could not be measured — not
  // repeat behavioral patterns. Minting a "record the model" rule from a clean
  // session would contradict the "No new rule recommended" trust guarantee.
};

/** Security-signal kind → rule blueprint (kept conservative). */
const SIGNAL_BLUEPRINTS: Record<string, RuleBlueprint> = {
  unusual_model_switch: {
    ruleType: "security",
    title: "Justify model switches",
    body:
      "Pin one primary model for the core task. Only switch models for a specific, named sub-task, and state the reason for the switch.",
    expectedPrevention: "May reduce unexplained model-to-model handoffs mid-task.",
  },
};

/**
 * A general verification rule, synthesized when a run shows failures/retries but
 * we cannot confirm a final verifying test/build step. High-value and safe.
 */
const VERIFICATION_BLUEPRINT: RuleBlueprint = {
  ruleType: "verification",
  title: "Verify before the final response",
  body:
    "Before your final response, run the relevant test or build command and report the exact result. Do not claim success without running it.",
  expectedPrevention: "May catch broken changes before they are reported as done.",
};

// --- Confidence / status derivation -----------------------------------------

/** Map evidence strength + severity onto a confidence level. */
function deriveConfidence(level: EvidenceLevel, severity: "low" | "medium" | "high"): RuleConfidence {
  if (level === "Correlated") return "high";
  if (level === "Observed") return severity === "high" ? "high" : "medium";
  return "low"; // Claimed / Unprovable
}

/** A rule's initial status follows its confidence (curation can change it later). */
function statusForConfidence(confidence: RuleConfidence): RuleStatus {
  return confidence === "low" ? "low_confidence" : "active";
}

/**
 * Evidence gate for rule generation.
 *
 * - observed / metadata_backed → eligible, status follows confidence (may be active).
 * - estimated                  → eligible but never active: needs_review.
 * - unavailable                → not eligible; we never mint a rule from absence.
 */
function gateForSupport(
  support: EvidenceSupport | undefined,
  confidence: RuleConfidence,
): { eligible: boolean; status: RuleStatus } {
  if (support === "unavailable") return { eligible: false, status: "low_confidence" };
  if (support === "estimated") return { eligible: true, status: "needs_review" };
  // observed / metadata_backed (or undefined, treated as observed for back-compat)
  return { eligible: true, status: statusForConfidence(confidence) };
}

/** Honest one-line evidence summary from a finding's evidence list. */
function evidenceSummaryFromFinding(finding: Finding): string {
  if (finding.evidence.length === 0) return `${finding.title} (observed in this session).`;
  // Keep it to the first one or two concrete items — the report holds the rest.
  return finding.evidence.slice(0, 2).join(" ");
}

// --- Public API -------------------------------------------------------------

let counter = 0;
function ruleId(ruleType: RuleType): string {
  // Stable-ish, readable id. Dedup collapses by ruleType, so a type-led id helps.
  counter += 1;
  return `rule_${ruleType}_${counter}`;
}

/**
 * Generate specific, evidence-backed rules from a Blackbox Report. One rule per
 * supported finding/signal, plus a synthesized verification rule for runs that
 * show failures but no confirmed verification step.
 *
 * Returns rules in raw (pre-dedup) form — callers should pass the result through
 * dedupeRules() before display/export.
 */
export function generateRulesFromReport(
  report: BlackboxReport,
  metrics?: TraceMetrics,
): GeneratedRule[] {
  counter = 0;
  const now = new Date().toISOString();
  const rules: GeneratedRule[] = [];

  // Source-quality gate: honest inputs only mint active rules when the evidence
  // is strong enough. "limited" inputs can suggest rules but never as active;
  // "insufficient" inputs produce no rules at all.
  const quality = report.inputProfile?.sourceQuality;
  const allowAnyRule = quality !== "insufficient";
  const allowActiveRule = quality !== "limited" && allowAnyRule;
  if (!allowAnyRule) return rules;

  /** Apply the source-quality ceiling on top of the per-finding evidence gate. */
  const capStatus = (status: RuleStatus): RuleStatus =>
    !allowActiveRule && status === "active" ? "needs_review" : status;

  for (const finding of report.findings) {
    const bp = FINDING_BLUEPRINTS[finding.type];
    if (!bp) continue;
    const confidence = deriveConfidence(finding.evidenceLevel, finding.severity);
    // Evidence gate: never mint a rule from unavailable evidence; estimated
    // evidence yields a needs_review (never active) rule.
    const gate = gateForSupport(finding.evidenceSupport, confidence);
    if (!gate.eligible) continue;
    rules.push({
      id: ruleId(bp.ruleType),
      title: bp.title,
      body: bp.body,
      ruleType: bp.ruleType,
      confidence,
      evidenceSummary: evidenceSummaryFromFinding(finding),
      sourceFindingId: finding.id,
      expectedPrevention: bp.expectedPrevention,
      createdAt: now,
      status: capStatus(gate.status),
      lastSeenAt: now,
    });
  }

  for (const signal of report.securitySignals) {
    const bp = SIGNAL_BLUEPRINTS[signal.kind];
    if (!bp) continue;
    const confidence = deriveConfidence(signal.evidenceLevel, signal.severity);
    rules.push({
      id: ruleId(bp.ruleType),
      title: bp.title,
      body: bp.body,
      ruleType: bp.ruleType,
      confidence,
      evidenceSummary: signal.evidence?.[0] ?? signal.description,
      sourceFindingId: signal.id,
      expectedPrevention: bp.expectedPrevention,
      createdAt: now,
      status: capStatus(statusForConfidence(confidence)),
      lastSeenAt: now,
    });
  }

  // Synthesize a verification rule for runs that failed/retried — high value,
  // and the trace rarely proves a final verifying step happened.
  const failed = metrics?.failedSteps ?? 0;
  const retries = metrics?.retries ?? 0;
  const alreadyHasVerification = rules.some((r) => r.ruleType === "verification");
  // Do not synthesize a verification rule when the session already shows
  // verification was run/summarized (e.g. a Claude Code recap with "npm test"
  // passing). Telling the user "verification missing" then would be false.
  if (!alreadyHasVerification && !report.verificationPresent && (failed > 0 || retries > 0)) {
    rules.push({
      id: ruleId(VERIFICATION_BLUEPRINT.ruleType),
      title: VERIFICATION_BLUEPRINT.title,
      body: VERIFICATION_BLUEPRINT.body,
      ruleType: VERIFICATION_BLUEPRINT.ruleType,
      confidence: "medium",
      evidenceSummary: `This run showed ${failed} failed step(s) and ${retries} retr${retries === 1 ? "y" : "ies"}; a verifying test/build step was not confirmed.`,
      sourceFindingId: null,
      expectedPrevention: VERIFICATION_BLUEPRINT.expectedPrevention,
      createdAt: now,
      status: capStatus("active"),
      lastSeenAt: now,
    });
  }

  return rules;
}

/**
 * Summarize whether this report should yield any new workspace rule.
 *
 * Returns the honest "No new rule recommended" state when no active or
 * needs_review rule could be generated, so the UI never fabricates a rule from
 * a clean or low-evidence session.
 */
export function summarizeRuleGeneration(rules: GeneratedRule[]): {
  recommended: boolean;
  message: string;
  activeCount: number;
  needsReviewCount: number;
} {
  const meaningful = rules.filter(
    (r) => r.status === "active" || r.status === "needs_review",
  );
  const activeCount = rules.filter((r) => r.status === "active").length;
  const needsReviewCount = rules.filter((r) => r.status === "needs_review").length;
  const recommended = meaningful.length > 0;
  return {
    recommended,
    message: recommended
      ? `${activeCount} rule(s) recommended${needsReviewCount > 0 ? `, ${needsReviewCount} for review` : ""}.`
      : NO_NEW_RULE_COPY,
    activeCount,
    needsReviewCount,
  };
}

/** Human label for a rule type (UI + export headings). */
export const RULE_TYPE_LABELS: Record<RuleType, string> = {
  retry_prevention: "Retry prevention",
  edit_thrash_prevention: "Edit-thrash prevention",
  scope_control: "Scope control",
  verification: "Verification",
  context_control: "Context control",
  security: "Security",
  metadata: "Metadata",
  cost_control: "Cost control",
  output_quality: "Output quality",
  project_memory: "Project memory",
};

/** Human label for confidence. */
export const CONFIDENCE_LABELS: Record<RuleConfidence, string> = {
  high: "High confidence",
  medium: "Medium confidence",
  low: "Low confidence",
};
