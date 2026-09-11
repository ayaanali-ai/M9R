/**
 * Agent Session Analysis (OathLock Agent Join v0)
 * ----------------------------------------------------------------------------
 * Thin wrapper that runs an agent-submitted session through the EXISTING
 * OathLock pipeline — it does not fork report or rule logic:
 *
 *   redactSession            (privacy gate, server-side belt-and-braces)
 *     → normalizeRawSession   (detect format/source + honest source quality)
 *       → normalizeToTrace    (canonical trace)
 *         → generateBlackboxReport  (findings, parser confidence)
 *           → generateRulesFromReport (evidence-gated rules)
 *
 * Claim discipline is inherited from the pipeline: rules only come from real
 * evidence, source quality gates whether rules can be active, and nothing is
 * invented. We never log or persist the raw session text here.
 */

import { redactSession } from "@/lib/session-redaction";
import { normalizeRawSession } from "@/lib/raw-session-normalizer";
import { normalizeToTrace } from "@/lib/normalize-trace";
import { computeTraceMetrics } from "@/lib/trace-metrics";
import { generateBlackboxReport } from "@/lib/blackbox-report";
import { generateRulesFromReport, type GeneratedRule } from "@/lib/generated-rules";
import { summarizeRun, type RunStats } from "@/lib/run-comparison";
import { dedupeRules } from "@/lib/rule-deduplication";
import { behaviorBucket } from "@/lib/rule-deduplication";
import { evaluateRuleHealth, type RuleHealthReport } from "@/lib/rule-health";
import type { SourceQuality } from "@/lib/session-input-detection";
import {
  extractQualitySignals,
  deriveQualitySignals,
  buildMeasurabilitySummary,
  hasCommandTiedVerificationSignal,
  type DerivedQualitySignals,
  type MeasurabilitySummary,
  type VerificationProvenance,
} from "@/lib/quality-signal-extraction";
import { extractApprovedEvidenceRecord, type ApprovedEvidenceRecord } from "@/lib/approved-evidence-record";

export interface AgentSessionAnalysis {
  sourceQuality: SourceQuality;
  sourceLabel: string;
  parserConfidence: {
    confidence: string;
    reason: string;
    turnsDetected: number;
    commandsDetected: number;
    filesEdited: number;
    usageFieldsDetected: boolean;
  };
  findings: Array<{ type: string; title: string; severity: string; evidenceLevel: string }>;
  findingsCount: number;
  /**
   * Conservative behavioral snapshot (counts only, no content) for the two-run
   * product-trial comparison: retries, repeated edits/commands, failed commands,
   * tool calls, changed files, verification presence, and usage (null when the
   * session carried no token/cost metadata).
   */
  behavior: RunStats & {
    recordSummary: ApprovedEvidenceRecord;
    verificationProvenance: VerificationProvenance[];
  };
  /** Explicit usage metadata (null fields when the session recorded none). */
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    cost: number | null;
  };
  /**
   * Objective output-quality signals extracted from the redacted session text
   * (tests/build/lint/human review). Null fields when the evidence didn't state
   * them. These are never agent self-claims — only command-tied results.
   */
  qualitySignals: DerivedQualitySignals;
  /** Compact, display-ready measurability block for `submit-session`. */
  measurableSignals: MeasurabilitySummary;
  /** Structured rules generated from the session (active/needs_review only). */
  generatedRules: GeneratedRule[];
  rules: {
    recommended: boolean;
    message: string;
    activeCount: number;
    needsReviewCount: number;
    ruleLikeFindingsCount: number;
    titles: string[];
  };
  /** Honest reason when no rules were generated (clean/weak evidence). */
  noNewRuleReason: string | null;
  /** What the server-side redaction pass caught (count only, never the values). */
  redaction: { confidence: string; summary: string; countsByType: Record<string, number> };
  note: string;
}

/**
 * Analyze a (already-approved) session. We re-run redaction defensively even
 * though the agent is required to submit redacted text; this is a belt-and-
 * braces privacy pass and never trusts the client's claim of redaction.
 */
export async function analyzeAgentSession(
  sessionText: string,
  fileNameHint?: string,
  opts: { humanApprovedSubmission?: boolean; rulesLoaded?: unknown } = {},
): Promise<AgentSessionAnalysis> {
  const redaction = redactSession(sessionText);

  const normalized = normalizeRawSession(redaction.redactedText, fileNameHint);
  const trace = normalized.trace
    ? normalizeToTrace(normalized.trace)
    : normalizeToTrace({ steps: [] });

  const metrics = computeTraceMetrics(trace);
  const report = await generateBlackboxReport(trace);
  const generated = dedupeRules(generateRulesFromReport(report, metrics)).rules;

  const candidateSourceRules = generated.filter(
    (r) => r.status === "active" || r.status === "needs_review",
  );

  // Extract objective signals from the (already redacted) text. A structured
  // evidence summary often lists "Changed file: - path" and command-tied test
  // results that the trace parser does not turn into edit steps; we use those to
  // honestly raise filesEdited and to feed the measurability block + compare.
  const extracted = extractQualitySignals(redaction.redactedText);
  if (opts.humanApprovedSubmission === true) {
    extracted.humanReviewed = true;
  }
  const qualitySignals = deriveQualitySignals(extracted);
  const measurableSignals = buildMeasurabilitySummary(extracted);
  const filesEdited = Math.max(report.parserConfidence.filesEdited, extracted.changedFiles.length);

  const behavior = summarizeRun(trace, metrics);
  const recordSummary = extractApprovedEvidenceRecord(redaction.redactedText);
  // Honestly reflect explicitly-listed changed files when the trace parser saw
  // none (a structured evidence summary lists them as bullets, not edit steps).
  behavior.changedFiles = Math.max(behavior.changedFiles, extracted.changedFiles.length);
  if (hasCommandTiedVerificationSignal(extracted)) {
    behavior.verificationPresent = true;
  }
  if (extracted.failedCommandsExplicitNone) {
    behavior.failedCommands = 0;
  } else if (extracted.failedCommandCount > 0) {
    behavior.failedCommands = Math.max(behavior.failedCommands, extracted.failedCommandCount);
  }
  const approvedBehavior = Object.assign(behavior, {
    recordSummary,
    verificationProvenance: extracted.verification,
  });

  const meaningful = filterReviewableRuleCandidates({
    rules: candidateSourceRules,
    sourceQuality: normalized.detection.sourceQuality,
    parserConfidence: report.parserConfidence.confidence,
    behavior: approvedBehavior,
    rulesLoaded: opts.rulesLoaded,
  });
  const reviewableCandidateCount = meaningful.length;
  const ruleLikeFindingsCount = Math.max(0, candidateSourceRules.length - reviewableCandidateCount);

  return {
    sourceQuality: normalized.detection.sourceQuality,
    sourceLabel: normalized.detection.sourceLabel ?? normalized.detection.source,
    parserConfidence: {
      confidence: report.parserConfidence.confidence,
      reason: report.parserConfidence.reason,
      turnsDetected: report.parserConfidence.turnsDetected,
      commandsDetected: report.parserConfidence.commandsDetected,
      filesEdited,
      usageFieldsDetected: report.parserConfidence.usageFieldsDetected,
    },
    findings: report.findings.map((f) => ({
      type: f.type,
      title: f.title,
      severity: f.severity,
      evidenceLevel: f.evidenceLevel,
    })),
    findingsCount: report.findings.length,
    behavior: approvedBehavior,
    qualitySignals,
    measurableSignals,
    usage: {
      inputTokens: metrics.inputTokens,
      outputTokens: metrics.outputTokens,
      totalTokens: metrics.totalTokens,
      cost: metrics.effectiveCostUsd,
    },
    generatedRules: meaningful,
    rules: {
      recommended: reviewableCandidateCount > 0,
      message: buildRuleCandidateMessage(reviewableCandidateCount, ruleLikeFindingsCount),
      activeCount: 0,
      needsReviewCount: reviewableCandidateCount,
      ruleLikeFindingsCount,
      titles: meaningful.map((r) => r.title),
    },
    noNewRuleReason: report.noNewRuleRecommended ? report.noNewRuleReason ?? null : null,
    redaction: {
      confidence: redaction.confidence,
      summary: redaction.redactionSummary,
      countsByType: redaction.countsByType,
    },
    note: normalized.note,
  };
}

export function buildRuleCandidateMessage(candidateCount: number, ruleLikeFindingsCount: number): string {
  if (candidateCount <= 0) {
    return ruleLikeFindingsCount > 0
      ? "No new rule candidates were created. Rule-like findings were kept as findings only; review the active rule health before promoting anything."
      : "No new rule candidates were created from this session.";
  }
  return candidateCount === 1
    ? "1 rule candidate for review."
    : `${candidateCount} rule candidates for review.`;
}

export function buildAgentSessionNextStep(candidateCount: number, ruleLikeFindingsCount: number): string {
  if (candidateCount <= 0) {
    return ruleLikeFindingsCount > 0
      ? "No new rule candidates were created. Rule-like findings were kept as findings only; review the active rule health before promoting anything."
      : "No new rule candidates were created from this session.";
  }
  return "Review the rule candidate(s) in the dashboard before promoting anything.";
}

function filterReviewableRuleCandidates(input: {
  rules: GeneratedRule[];
  sourceQuality: SourceQuality;
  parserConfidence: string;
  behavior: RunStats;
  rulesLoaded?: unknown;
}): GeneratedRule[] {
  const strongEnoughSource = input.sourceQuality === "medium" || input.sourceQuality === "strong";
  const strongEnoughParser = input.parserConfidence === "medium" || input.parserConfidence === "high";
  if (!strongEnoughSource || !strongEnoughParser) return [];

  const hasRetryCandidate = input.rules.some((rule) => rule.ruleType === "retry_prevention");

  return input.rules.filter((rule) => {
    if (isCoveredByLoadedRule(rule, input.rulesLoaded)) return false;
    switch (rule.ruleType) {
      case "retry_prevention":
        return hasRepeatedRetryEvidence(rule, input.behavior);
      case "edit_thrash_prevention":
        return hasRepeatedEditEvidence(rule, input.behavior);
      case "context_control":
        return hasRepeatedContextEvidence(rule);
      case "cost_control":
        return input.behavior.repeatedCommands > 0
          && (input.behavior.totalTokens !== null || input.behavior.costUsd !== null);
      case "verification":
        // A single failed command is normal execution noise, not a durable
        // workspace lesson. Repeated unchanged failures belong to the more
        // specific retry-prevention candidate, so do not create two rules for
        // the same incident.
        return !hasRetryCandidate
          && input.behavior.repeatedCommands > 0
          && input.behavior.failedCommands > 0
          && !input.behavior.verificationPresent;
      case "scope_control":
        return input.behavior.scopeCreepSignals > 0;
      case "security":
        return true;
      default:
        return false;
    }
  });
}

function hasRepeatedRetryEvidence(rule: GeneratedRule, behavior: RunStats): boolean {
  if (behavior.repeatedCommands > 0) return true;
  return /failed\s+\d+\s*(?:times|x|×)|\b[2-9]\d*\s+steps contained errors|total retries across the run/i.test(
    rule.evidenceSummary,
  );
}

function hasRepeatedEditEvidence(rule: GeneratedRule, behavior: RunStats): boolean {
  if (behavior.repeatedFileEdits > 0) return true;
  return /edited\s+[3-9]\d*\s+times/i.test(rule.evidenceSummary);
}

function hasRepeatedContextEvidence(rule: GeneratedRule): boolean {
  return /read\s+[2-9]\d*\s+times/i.test(rule.evidenceSummary);
}

function isCoveredByLoadedRule(rule: GeneratedRule, rulesLoaded: unknown): boolean {
  const loaded = extractLoadedRuleObjects(rulesLoaded);
  const bucket = behaviorBucket(rule.ruleType);
  return loaded.some((item) => {
    const rawType = item.rule_type ?? item.ruleType ?? item.leakType ?? item.type;
    if (typeof rawType === "string" && behaviorBucket(rawType as GeneratedRule["ruleType"]) === bucket) {
      return true;
    }
    const haystack = `${String(item.title ?? "")} ${String(item.body ?? "")}`.toLowerCase();
    if (rule.ruleType === "retry_prevention") return /\bretry|failing command|failed command/.test(haystack);
    if (rule.ruleType === "edit_thrash_prevention") return /\bedit|re-edit|same file/.test(haystack);
    if (rule.ruleType === "context_control") return /\bread|context|same file/.test(haystack);
    if (rule.ruleType === "cost_control") return /\bcost|token|spend|secondary agent|provider work/.test(haystack);
    if (rule.ruleType === "verification") return /\bverify|test|build|lint/.test(haystack);
    if (rule.ruleType === "scope_control") return /\bscope|allowed path|prohibited path/.test(haystack);
    if (rule.ruleType === "security") return /\bsecurity|secret|credential|permission/.test(haystack);
    return false;
  });
}

function extractLoadedRuleObjects(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) return raw.filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object");
  if (!raw || typeof raw !== "object") return [];
  const rules = (raw as Record<string, unknown>).rules;
  if (Array.isArray(rules)) return rules.filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object");
  if (rules && typeof rules === "object") {
    const items = (rules as Record<string, unknown>).items;
    if (Array.isArray(items)) return items.filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object");
  }
  return [];
}

/**
 * Build the public /api/agent/session response body from an analysis result.
 *
 * Extracted as a pure function so the exact response shape — crucially that
 * `rule_health` is always present and is evaluated whenever rules were loaded —
 * is unit-testable without a DB, auth, or network. The route stays responsible
 * for auth, the approval gate, validation, and persistence; this only shapes the
 * JSON it returns. Behavior is identical to the previous inline construction.
 */
export interface SessionResponseInput {
  rulesLoaded?: unknown;
  rulesFollowed?: unknown;
  rulesViolated?: unknown;
  redactionStatus?: string | null;
}

export interface AgentSessionResponseBody {
  ok: true;
  redaction_status: string | null;
  source_quality: SourceQuality;
  source_quality_label: string;
  parser_confidence: AgentSessionAnalysis["parserConfidence"];
  findings: AgentSessionAnalysis["findings"];
  findings_count: number;
  rules: AgentSessionAnalysis["rules"];
  /** Compact measurability block — objective signals extracted from the session. */
  measurable_signals: MeasurabilitySummary;
  rule_health: RuleHealthReport;
  no_new_rule_reason: string | null;
  server_redaction: AgentSessionAnalysis["redaction"];
  note: string;
  next_step: string;
}

export function buildAgentSessionResponse(
  analysis: AgentSessionAnalysis,
  input: SessionResponseInput = {},
): AgentSessionResponseBody {
  // Rule Health — compare this session against the rules the agent loaded.
  // Evidence-based and conservative; agent self-reports never override findings.
  const rule_health = evaluateRuleHealth({
    rulesLoaded: input.rulesLoaded,
    findings: analysis.findings,
    signals: {
      filesEdited: analysis.parserConfidence.filesEdited,
      commandsDetected: analysis.parserConfidence.commandsDetected,
      turnsDetected: analysis.parserConfidence.turnsDetected,
      parserConfidence: analysis.parserConfidence.confidence,
      // Repetition signals tune retry-prevention so a single ordinary failure is
      // not treated as a violation.
      repeatedCommandFailures: analysis.behavior.repeatedCommands,
      failedCommands: analysis.behavior.failedCommands,
    },
    agentReported: {
      followed: input.rulesFollowed,
      violated: input.rulesViolated,
    },
  });

  return {
    ok: true,
    redaction_status: input.redactionStatus ?? null,
    source_quality: analysis.sourceQuality,
    source_quality_label: analysis.sourceLabel,
    parser_confidence: analysis.parserConfidence,
    findings: analysis.findings,
    findings_count: analysis.findingsCount,
    rules: analysis.rules,
    measurable_signals: analysis.measurableSignals,
    rule_health,
    no_new_rule_reason: analysis.noNewRuleReason,
    server_redaction: analysis.redaction,
    note: analysis.note,
    next_step: buildAgentSessionNextStep(
      analysis.rules.needsReviewCount,
      analysis.rules.ruleLikeFindingsCount,
    ),
  };
}
