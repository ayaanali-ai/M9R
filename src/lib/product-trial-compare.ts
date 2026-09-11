/**
 * Product Trial — two-run conservative comparison (pure)
 * ----------------------------------------------------------------------------
 * Builds the honest, structured comparison object for the Claude Code product
 * trial: Run A (baseline/evidence) vs Run B (later run that loaded a promoted
 * rule). It reuses the tested behavioral comparison (run-comparison.ts) and the
 * conservative Rule Health copy, and adds the trial-specific discipline:
 *
 *  - NEVER claim token/cost savings unless BOTH runs carried usage metadata.
 *  - NEVER assert better output quality without objective signals (tests/build/
 *    lint/acceptance/human approval).
 *  - NEVER use overclaiming language (see FORBIDDEN_PROOF_PHRASES).
 *
 * Everything here is IO-free so the verdict logic is unit-testable without a DB,
 * a network, or a browser.
 */

import { compareRuns, type RunStats, type MetricDelta } from "@/lib/run-comparison";
import { dominantRuleHealthStatus, type RuleHealthStatus } from "@/lib/rule-health";
import { TWO_RUN_PROOF_COPY, FORBIDDEN_PROOF_PHRASES } from "@/lib/agent-run-core";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface UsageSnapshot {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cost: number | null;
}

export interface QualitySignals {
  testsPassed?: boolean | null;
  buildPassed?: boolean | null;
  lintPassed?: boolean | null;
  acceptanceCriteriaMet?: boolean | null;
  humanApproval?: boolean | null;
  finalDiffScope?: string | null;
}

export interface RuleHealthResult {
  evaluated: boolean;
  /** The dominant evaluated status, when one rule's outcome is the headline. */
  dominant?: RuleHealthStatus | null;
  items?: Array<{ status: RuleHealthStatus; title?: string }>;
}

export interface TrialCompareInput {
  baselineRunId: string;
  laterRunId: string;
  loadedRules: string[];
  promotedRuleIds: string[];
  ruleHealth?: RuleHealthResult | null;
  /**
   * How many rules the later run reported loading. Used to distinguish "the later
   * run never loaded a rule" from "rules were loaded but the Rule Health snapshot
   * could not be hydrated" — those must NOT produce the same message.
   */
  laterRulesLoadedCount?: number | null;
  /**
   * True when the later run submitted a session but its Rule Health snapshot could
   * not be recovered (submitted before snapshot persistence / before the migration).
   */
  ruleHealthSnapshotUnavailable?: boolean;
  /** True when a behavioral snapshot for either run could not be recovered. */
  behaviorSnapshotUnavailable?: boolean;
  /** Behavioral stats for each run (from summarizeRun). */
  before: RunStats;
  after: RunStats;
  /** Explicit usage metadata per run (null fields when not recorded). */
  usageBefore?: UsageSnapshot | null;
  usageAfter?: UsageSnapshot | null;
  /** Objective quality signals per run (all optional / nullable). */
  qualityBefore?: QualitySignals | null;
  qualityAfter?: QualitySignals | null;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export const USAGE_UNAVAILABLE_MESSAGE =
  "Usage comparison unavailable because one or both sessions did not include token/cost metadata.";

export const QUALITY_UNJUDGEABLE_MESSAGE =
  "Output quality comparison requires objective signals such as build result, test result, lint result, acceptance criteria, or human approval.";

/**
 * Shown when only the LATER run carried objective signals. We refuse to call this
 * an improvement — there is no comparable baseline — but we do NOT claim "no
 * signals were supplied", because that would be false.
 */
export const QUALITY_BASELINE_LACKS_MESSAGE =
  "Output quality signals were present for the later run, but the baseline lacks comparable objective signals, so output quality was not compared.";

/** Shown when only the BASELINE run carried objective signals. */
export const QUALITY_LATER_LACKS_MESSAGE =
  "Output quality signals were present for the baseline run, but the later run lacks comparable objective signals, so output quality was not compared.";

/**
 * Shown when BOTH runs carried objective signals. Deliberately presence-only —
 * it states that verification existed, never that the rule improved quality.
 */
export const QUALITY_BOTH_PRESENT_MESSAGE = "Both runs include objective verification signals.";

/**
 * Shown when the later run loaded rules and submitted a session, but its Rule
 * Health snapshot cannot be recovered. This is NOT the same as "the rule was never
 * loaded" — it means the snapshot was never persisted (old run) or the migration
 * had not been applied at submit time.
 */
export const RULE_HEALTH_SNAPSHOT_UNAVAILABLE_MESSAGE =
  "Rule Health snapshot unavailable for this run. This run was submitted before snapshot persistence or before the migration was applied. Run a fresh later run after deployment.";

/** Shown when behavioral counts cannot be trusted because a snapshot is missing. */
export const BEHAVIOR_SNAPSHOT_UNAVAILABLE_MESSAGE =
  "Behavioral counts are unavailable for this comparison because a run's behavior snapshot was not recovered; zeroed counts are not meaningful here. Run a fresh later run after deployment.";

/** Short, actionable guidance shown when output quality cannot be judged. */
export const QUALITY_MEASURABLE_HINT = [
  "Include build/lint/test results in the redacted session.",
  "Include the acceptance criteria for the task.",
  "Include whether the human reviewer accepted the final diff.",
  "Do not include secrets or full source code.",
];

export interface UsageDelta {
  available: boolean;
  message?: string;
  inputTokensBefore: number | null;
  inputTokensAfter: number | null;
  outputTokensBefore: number | null;
  outputTokensAfter: number | null;
  totalTokensBefore: number | null;
  totalTokensAfter: number | null;
  costBefore: number | null;
  costAfter: number | null;
}

export interface QualitySignalDelta {
  key: string;
  before: boolean | string | null;
  after: boolean | string | null;
}

export interface OutputQualityDelta {
  judgeable: boolean;
  message?: string;
  /** When not judgeable, actionable steps to make quality measurable next time. */
  hint?: string[];
  signals: QualitySignalDelta[];
}

export interface VerificationDelta {
  before: boolean;
  after: boolean;
  change: "improved" | "worsened" | "unchanged";
  note: string;
}

export interface ProductTrialComparison {
  baseline_run_id: string;
  later_run_id: string;
  loaded_rules: string[];
  promoted_rule_ids: string[];
  rule_health_result: RuleHealthResult | null;
  /** False when Rule Health could not be hydrated (snapshot missing/unrecoverable). */
  rule_health_snapshot_available: boolean;
  /** False when behavioral counts are not trustworthy (snapshot missing). */
  behavior_snapshot_available: boolean;
  behavioral_delta: MetricDelta[];
  verification_delta: VerificationDelta;
  usage_delta: UsageDelta;
  output_quality_delta: OutputQualityDelta;
  honest_verdict: string;
  limitations: string[];
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

function assertNoOverclaim(text: string): void {
  const lower = text.toLowerCase();
  for (const phrase of FORBIDDEN_PROOF_PHRASES) {
    if (lower.includes(phrase)) throw new Error(`Overclaim in trial verdict: "${phrase}"`);
  }
}

function bothHaveUsage(a?: UsageSnapshot | null, b?: UsageSnapshot | null): boolean {
  return Boolean(a && b && a.totalTokens != null && b.totalTokens != null);
}

function buildUsageDelta(before?: UsageSnapshot | null, after?: UsageSnapshot | null): UsageDelta {
  const available = bothHaveUsage(before, after);
  return {
    available,
    message: available ? undefined : USAGE_UNAVAILABLE_MESSAGE,
    inputTokensBefore: before?.inputTokens ?? null,
    inputTokensAfter: after?.inputTokens ?? null,
    outputTokensBefore: before?.outputTokens ?? null,
    outputTokensAfter: after?.outputTokens ?? null,
    totalTokensBefore: before?.totalTokens ?? null,
    totalTokensAfter: after?.totalTokens ?? null,
    costBefore: before?.cost ?? null,
    costAfter: after?.cost ?? null,
  };
}

const QUALITY_KEYS: Array<[keyof QualitySignals, string]> = [
  ["testsPassed", "tests passed"],
  ["buildPassed", "build passed"],
  ["lintPassed", "lint passed"],
  ["acceptanceCriteriaMet", "acceptance criteria met"],
  ["humanApproval", "human approval"],
  ["finalDiffScope", "final diff scope"],
];

/** True when at least one objective quality signal is present in this run. */
function hasQualitySignal(s?: QualitySignals | null): boolean {
  if (!s) return false;
  for (const [key] of QUALITY_KEYS) {
    if (s[key] != null) return true;
  }
  return false;
}

function buildQualityDelta(before?: QualitySignals | null, after?: QualitySignals | null): OutputQualityDelta {
  const beforeHas = hasQualitySignal(before);
  const afterHas = hasQualitySignal(after);

  // Neither run carried objective signals — honestly unjudgeable, with a hint.
  if (!beforeHas && !afterHas) {
    return { judgeable: false, message: QUALITY_UNJUDGEABLE_MESSAGE, hint: QUALITY_MEASURABLE_HINT, signals: [] };
  }

  const signals: QualitySignalDelta[] = QUALITY_KEYS.map(([key]) => ({
    key,
    before: (before?.[key] ?? null) as boolean | string | null,
    after: (after?.[key] ?? null) as boolean | string | null,
  }));

  // Both runs carried comparable signals — judgeable, but presence-only (never
  // a causal/quality-improvement claim; see the verdict + limitations).
  if (beforeHas && afterHas) {
    return { judgeable: true, message: QUALITY_BOTH_PRESENT_MESSAGE, signals };
  }

  // Asymmetric: one run has signals, the other does not. We report the signals we
  // have but refuse to compare quality, because there is no comparable baseline.
  return {
    judgeable: false,
    message: afterHas ? QUALITY_BASELINE_LACKS_MESSAGE : QUALITY_LATER_LACKS_MESSAGE,
    signals,
  };
}

/** Headline copy from Rule Health, reusing the conservative two-run wording. */
function ruleHealthHeadline(rh?: RuleHealthResult | null, snapshotUnavailable = false): string {
  if (!rh || !rh.evaluated) {
    // Snapshot missing (rules WERE loaded) is a distinct, honest message — never
    // claim the later run "may not have loaded the rule".
    if (snapshotUnavailable) return RULE_HEALTH_SNAPSHOT_UNAVAILABLE_MESSAGE;
    return "Rule Health was not evaluated, so it is unknown whether the loaded rule held.";
  }
  // Deterministic severity/decisiveness ranking — never "first item wins".
  const dominant = rh.dominant ?? dominantRuleHealthStatus(rh.items ?? []);
  if (dominant) return TWO_RUN_PROOF_COPY[dominant];
  return "Rule Health was evaluated but produced no clear per-rule outcome.";
}

/**
 * Compose the honest verdict. Strictly conservative: behavior is described as
 * observed change (never causation), usage/quality only when measured.
 */
function buildVerdict(
  behavioral: ReturnType<typeof compareRuns>,
  usage: UsageDelta,
  quality: OutputQualityDelta,
  rh: RuleHealthResult | null | undefined,
  ruleHealthSnapshotUnavailable: boolean,
  behaviorSnapshotUnavailable: boolean,
): string {
  const parts: string[] = [];
  appendVerdictPart(parts, ruleHealthHeadline(rh, ruleHealthSnapshotUnavailable));

  // Behavioral counts are only meaningful when both snapshots were recovered.
  appendVerdictPart(
    parts,
    behaviorSnapshotUnavailable
      ? BEHAVIOR_SNAPSHOT_UNAVAILABLE_MESSAGE
      : buildBehaviorVerdictSummary(behavioral, quality),
  );

  appendVerdictPart(
    parts,
    usage.available
      ? "Token/cost figures are compared from recorded usage metadata below."
      : USAGE_UNAVAILABLE_MESSAGE,
  );

  // Quality is reported from its own message: presence-only when both runs have
  // signals, an honest "not compared" when asymmetric, and the unjudgeable copy
  // when neither does. It NEVER asserts the rule improved quality.
  appendVerdictPart(parts, quality.message ?? QUALITY_UNJUDGEABLE_MESSAGE);

  const verdict = parts.join(" ");
  assertNoOverclaim(verdict);
  return verdict;
}

function appendVerdictPart(parts: string[], part: string): void {
  const clean = part.trim();
  if (!clean) return;
  const previous = parts[parts.length - 1];
  if (previous && firstSentence(previous) === firstSentence(clean)) {
    parts[parts.length - 1] = clean;
    return;
  }
  parts.push(clean);
}

function firstSentence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^[^.!?]+[.!?]/);
  return (match ? match[0] : trimmed).trim();
}

function buildBehaviorVerdictSummary(
  behavioral: ReturnType<typeof compareRuns>,
  quality: OutputQualityDelta,
): string {
  const verification = behavioral.metrics.find((m) => m.key === "verification");
  const retry = behavioral.metrics.find((m) => m.key === "retries");
  const repeatedCommands = behavioral.metrics.find((m) => m.key === "repeatedCommands");
  const repeatedFileEdits = behavioral.metrics.find((m) => m.key === "repeatedFileEdits");
  const noRetryOrEditRegression = [retry, repeatedCommands, repeatedFileEdits].every(
    (m) => m?.change !== "worsened",
  );

  if (
    behavioral.verdict === "insufficient_data" &&
    verification?.change === "improved" &&
    noRetryOrEditRegression &&
    quality.message === QUALITY_BASELINE_LACKS_MESSAGE
  ) {
    return "Evidence is mixed or insufficient. The later run includes objective verification signals and no observed retry/edit-thrash regression, but the baseline lacks comparable output-quality signals. This is an observed difference between two sessions, not proof that rules changed the outcome.";
  }

  return behavioral.summary;
}

function buildLimitations(
  usage: UsageDelta,
  quality: OutputQualityDelta,
  rh: RuleHealthResult | null | undefined,
  ruleHealthSnapshotUnavailable: boolean,
  behaviorSnapshotUnavailable: boolean,
): string[] {
  const limits = [
    "This compares two sessions; an observed change is not proof that a rule changed the outcome.",
    "Behavioral counts are conservative proxies derived from the redacted session, not a full audit.",
  ];
  if (!usage.available) limits.push("No token/cost metadata was recorded, so usage was not compared.");
  // Only claim "no signals were supplied" when NEITHER run had any. When signals
  // exist (both runs, or asymmetric) we surface the accurate quality message and
  // reinforce that presence of signals is not proof the rule changed quality.
  if (quality.signals.length === 0) {
    limits.push("No tests/build/lint/acceptance/human-review signals were supplied, so output quality was not judged.");
  } else if (!quality.judgeable) {
    limits.push(quality.message ?? QUALITY_UNJUDGEABLE_MESSAGE);
  } else {
    limits.push("Objective signals are reported as presence only; this is not evidence that a rule changed output quality.");
  }
  if (behaviorSnapshotUnavailable) limits.push(BEHAVIOR_SNAPSHOT_UNAVAILABLE_MESSAGE);
  if (!rh || !rh.evaluated) {
    // Snapshot missing → say so explicitly; only claim "may not have loaded the
    // rule" when there was genuinely no evidence the later run loaded one.
    limits.push(
      ruleHealthSnapshotUnavailable
        ? RULE_HEALTH_SNAPSHOT_UNAVAILABLE_MESSAGE
        : "Rule Health was not evaluated (the later run may not have loaded the rule).",
    );
  }
  return limits;
}

/** Build the conservative product-trial comparison object. */
export function buildProductTrialComparison(input: TrialCompareInput): ProductTrialComparison {
  const behavioral = compareRuns(input.before, input.after);
  const usage_delta = buildUsageDelta(input.usageBefore, input.usageAfter);
  const output_quality_delta = buildQualityDelta(input.qualityBefore, input.qualityAfter);

  const verifyMetric = behavioral.metrics.find((m) => m.key === "verification");
  const verification_delta: VerificationDelta = {
    before: input.before.verificationPresent,
    after: input.after.verificationPresent,
    change:
      verifyMetric?.change === "improved"
        ? "improved"
        : verifyMetric?.change === "worsened"
          ? "worsened"
          : "unchanged",
    note:
      input.after.verificationPresent && !input.before.verificationPresent
        ? "A verification step (test/build/lint) was present in the later run but not the baseline."
        : !input.after.verificationPresent && input.before.verificationPresent
          ? "The later run dropped the verification step that the baseline had."
          : input.after.verificationPresent
            ? "Both runs included a verification step."
            : "Neither run included a verification step.",
  };

  // Behavioral delta excludes usage rows (those live in usage_delta).
  const behavioral_delta = behavioral.metrics.filter((m) => m.key !== "totalTokens" && m.key !== "costUsd");

  // Rule Health is "unavailable" (not "never loaded") when it's missing yet the
  // later run reported loading rules, or the caller flagged the snapshot as gone.
  const ruleHealthMissing = !input.ruleHealth || !input.ruleHealth.evaluated;
  const rulesWereLoaded = (input.laterRulesLoadedCount ?? 0) >= 1;
  const ruleHealthSnapshotUnavailable =
    ruleHealthMissing && (input.ruleHealthSnapshotUnavailable === true || rulesWereLoaded);
  const behaviorSnapshotUnavailable = input.behaviorSnapshotUnavailable === true;

  const honest_verdict = buildVerdict(
    behavioral,
    usage_delta,
    output_quality_delta,
    input.ruleHealth,
    ruleHealthSnapshotUnavailable,
    behaviorSnapshotUnavailable,
  );
  const limitations = buildLimitations(
    usage_delta,
    output_quality_delta,
    input.ruleHealth,
    ruleHealthSnapshotUnavailable,
    behaviorSnapshotUnavailable,
  );

  return {
    baseline_run_id: input.baselineRunId,
    later_run_id: input.laterRunId,
    loaded_rules: input.loadedRules,
    promoted_rule_ids: input.promotedRuleIds,
    rule_health_result: input.ruleHealth ?? null,
    rule_health_snapshot_available: !ruleHealthSnapshotUnavailable,
    behavior_snapshot_available: !behaviorSnapshotUnavailable,
    behavioral_delta,
    verification_delta,
    usage_delta,
    output_quality_delta,
    honest_verdict,
    limitations,
  };
}
