/**
 * Blackbox Report Generator — OathLock Phase 1
 *
 * This service is responsible for taking a raw agent execution `Trace`
 * and producing a structured, honest `BlackboxReport`.
 *
 * Core principles:
 * - Evidence levels must be assigned conservatively and explainably.
 * - Never invent data that is not present in the trace.
 * - Model handoffs and security signals are derived only from observable facts.
 * - Recommendations must be actionable and tied to evidence.
 */

import {
  type Trace,
  type EvidenceLevel,
  type ModelHandoff,
  type SecuritySignal,
} from "@/lib/oathlock";
import { computeTraceMetrics, formatUsd, formatTokens, type TraceMetrics } from "@/lib/trace-metrics";
import { detectMtmSignals } from "@/lib/mtm-signals";
import {
  type EvidenceSupport,
  type MetricReliability,
  type FindingCategory,
  type ParserConfidenceSummary,
  categorizeFinding,
  reliabilityForSupport,
  usageEvidenceSupport,
  computeParserConfidence,
  USAGE_UNAVAILABLE_COPY,
} from "@/lib/evidence-reliability";

// ---------------------------------------------------------------------------
// Types for Blackbox Report Generation
// ---------------------------------------------------------------------------

/**
 * A Finding represents a notable observation or pattern detected in the trace.
 * Every finding MUST carry an evidenceLevel to indicate how strongly it is
 * supported by the raw trace data.
 */
export interface Finding {
  /** Stable identifier for this finding within the report. */
  id: string;

  /** Machine-readable category (e.g. "repeated_file_read", "retry_spiral"). */
  type: string;

  /** Short human title. */
  title: string;

  /** One or two sentence summary of the issue. */
  summary: string;

  /** Raw evidence snippets or observations pulled from the trace. */
  evidence: string[];

  /**
   * How strongly this finding is supported by the trace data.
   *
   * Decision guide:
   * - Observed:   A concrete field or value was directly present (e.g. model name, file path, error message).
   * - Correlated: Multiple independent signals align (e.g. same file read repeatedly + rising token counts + same command failing).
   * - Claimed:    The trace (or a step note) asserts something, but we cannot independently verify it from execution data.
   * - Unprovable: We have insufficient data to support or refute the claim (common when usage metadata is missing).
   */
  evidenceLevel: EvidenceLevel;

  /**
   * Whether this is a core behavioral finding (works without usage metadata)
   * or an optional usage finding (needs token/cost metadata).
   */
  category: FindingCategory;

  /**
   * Why this finding has the evidence level it does — observed in the visible
   * session, backed by exact metadata, estimated from visible text, or
   * unavailable. This is the honest "why" the product promises.
   */
  evidenceSupport: EvidenceSupport;

  /** How reliable the resulting claim is, for quick triage. */
  metricReliability: MetricReliability;

  /** One-line explanation of the evidence support for this finding. */
  evidenceReason: string;

  /** Relative impact of this finding. */
  severity: "low" | "medium" | "high";

  /** Step numbers (1-based) that contributed to this finding. */
  affectedSteps?: number[];
}

/**
 * A recommended action for the operator or future agent runs.
 * Recommendations should be derived from findings and signals.
 */
export interface Recommendation {
  id: string;
  priority: "high" | "medium" | "low";
  title: string;
  description: string;
  /** IDs of findings or signals that motivated this recommendation. */
  relatedFindingIds?: string[];
  relatedSignalIds?: string[];
}

/**
 * The structured Blackbox Report produced from a single agent trace.
 */
export interface BlackboxReport {
  /** Unique identifier for this report (generated at creation time). */
  id: string;

  /** The session/run identifier from the source trace. */
  traceSessionId: string;

  /**
   * Parser-confidence summary shown at the top of the report: how much
   * structure was extracted, plus turns/commands/files/metadata counts.
   */
  parserConfidence: ParserConfidenceSummary;

  /**
   * How the session was ingested (input format, source agent, source quality,
   * what was/wasn't extracted). Present when the normalizer ran; absent for
   * legacy/structured-only inputs.
   */
  inputProfile?: Trace["inputProfile"];

  /**
   * True when the session shows evidence that verification (tests/build/
   * typecheck) was actually run/summarized. Suppresses the synthesized
   * "Verify before final response" rule so we don't claim verification was
   * missing when a Claude Code recap clearly verified.
   */
  verificationPresent: boolean;

  /**
   * True when the session is clean or evidence is too weak to justify any new
   * workspace rule. Prevents OathLock from inventing low-trust rules.
   */
  noNewRuleRecommended: boolean;

  /** Human reason for the no-new-rule state (set only when true). */
  noNewRuleReason?: string;

  /** Short task description from the trace. */
  taskSummary: string;

  /** When this report was generated. */
  generatedAt: string;

  /**
   * High-level textual summary of what happened.
   * Should be grounded — never claim savings or outcomes not supported by data.
   */
  summary: string;

  /** All findings discovered during analysis. */
  findings: Finding[];

  /** Detected transitions between different models (MTM signals). */
  modelHandoffs: ModelHandoff[];

  /** Security or safety-related observations. */
  securitySignals: SecuritySignal[];

  /** Prioritized, actionable recommendations. */
  recommendations: Recommendation[];

  /**
   * Coarse overall assessment based on findings and signals.
   * Used for quick triage. Not a guarantee.
   */
  overallRisk: "low" | "medium" | "high";
}

// ---------------------------------------------------------------------------
// Error Types
// ---------------------------------------------------------------------------

export class BlackboxReportError extends Error {
  // Plain field instead of a TS parameter property so Node's type-stripping
  // loader (used by the test runner) can execute this module directly.
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
    this.name = "BlackboxReportError";
  }
}

export class InvalidTraceError extends BlackboxReportError {
  constructor(message: string) {
    super(message, "INVALID_TRACE");
    this.name = "InvalidTraceError";
  }
}

// ---------------------------------------------------------------------------
// Internal Analysis Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a stable ID for a report or sub-item.
 */
function generateId(prefix: string): string {
  // Use timestamp + random for simplicity in Phase 1.
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now()}_${rand}`;
}

/**
 * Safely get a step's model name, normalized.
 */
function getModelName(step: Trace["steps"][number]): string | null {
  return step.model ? step.model.trim() : null;
}

/**
 * Whether model/usage identifiers on this trace are trustworthy STRUCTURED
 * metadata (real per-call records) rather than names scraped from free text.
 *
 * Markdown/raw exports surface model names because the user's prompt or pasted
 * diff mentions them — that is NOT runtime model-call evidence. So for those
 * inputs we do not detect model handoffs, high-volume model-call findings, or
 * "missing usage metadata" findings/signals. Legacy/structured uploads (no
 * inputProfile) keep their existing behavior.
 */
function hasStructuredModelMetadata(trace: Trace): boolean {
  const ip = trace.inputProfile;
  if (ip) return ip.format === "structured_json" || ip.format === "jsonl";
  return true;
}

/** Verification-success phrases. "npm test" alone isn't success — see below. */
const VERIFICATION_SUCCESS_RE =
  /\b(verification (?:passed|present)|tests? pass(?:ed|ing)?|build success(?:ful)?|production build clean|all green|all \d+ pass|typecheck (?:clean|pass(?:ed)?)|build succeeded|✓ tests?|0 errors?)\b/i;
/** Verification commands — count only when not paired with an error/failure. */
const VERIFICATION_CMD_RE = /\b(npm (?:test|run build)|npx? tsc|tsc\b|vitest|jest|pytest|typecheck)\b/i;
const FAILURE_NEARBY_RE = /\b(error|fail(?:ed|ure|ing)?|not defined|✗|✖|❌)\b/i;

/**
 * Whether the session shows evidence that verification (tests/build/typecheck)
 * was actually run and summarized — so we don't tell the user "verification
 * missing" when their Claude Code recap clearly verified.
 *
 * Honest: a verification COMMAND that failed (npm test → error) is not
 * verification success. We require an explicit success phrase, an extracted
 * "verification summary" from the input profile, or a verification command on a
 * step with no error.
 */
function detectVerificationPresent(trace: Trace): boolean {
  // 1. Input profile already extracted a verification summary (markdown export).
  if (trace.inputProfile?.extracted.some((e) => /verif/i.test(e))) return true;

  // 2. Explicit success phrasing in visible step OUTPUT only. We deliberately do
  // NOT scan the task summary or commands — "make the tests pass" / "npm test"
  // are requests/commands, not evidence that verification succeeded.
  const haystacks: string[] = [];
  for (const s of trace.steps) {
    haystacks.push(s.toolOutputSummary ?? "", s.toolInputSummary ?? "");
  }
  if (haystacks.some((h) => VERIFICATION_SUCCESS_RE.test(h))) return true;

  // 3. A verification command on a step that recorded no error.
  for (const s of trace.steps) {
    const hadError = (s.errors?.length ?? 0) > 0;
    if (hadError) continue;
    const text = [...(s.shellCommands ?? []), s.toolOutputSummary ?? ""].join(" ");
    if (VERIFICATION_CMD_RE.test(text) && !FAILURE_NEARBY_RE.test(text)) return true;
  }
  return false;
}

/**
 * Count how many times each file was read across the entire trace.
 */
function countFileReads(trace: Trace): Map<string, number> {
  const counts = new Map<string, number>();
  for (const step of trace.steps) {
    for (const file of step.filesRead ?? []) {
      const key = file.trim().toLowerCase();
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Detect repeated reads of the same file(s).
 * Returns affected step numbers and a description of the repetition.
 */
function detectRepeatedReads(trace: Trace): {
  repeated: boolean;
  affectedSteps: number[];
  evidence: string[];
} {
  const counts = countFileReads(trace);
  const affectedSteps: number[] = [];
  const evidence: string[] = [];

  for (const [file, count] of counts.entries()) {
    if (count >= 2) {
      // Find steps where this file was read
      const stepsWithFile = trace.steps
        .filter((s) => (s.filesRead ?? []).some((f) => f.trim().toLowerCase() === file))
        .map((s) => s.step);

      affectedSteps.push(...stepsWithFile);
      evidence.push(`File "${file}" was read ${count} times (steps: ${stepsWithFile.join(", ")})`);
    }
  }

  return {
    repeated: evidence.length > 0,
    affectedSteps: [...new Set(affectedSteps)].sort((a, b) => a - b),
    evidence,
  };
}

/**
 * Count how many times each file was written/edited across the entire trace.
 */
function countFileWrites(trace: Trace): Map<string, number> {
  const counts = new Map<string, number>();
  for (const step of trace.steps) {
    for (const file of step.filesWritten ?? []) {
      const key = file.trim().toLowerCase();
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Detect edit thrash: the same file edited many times across a run, which on
 * real coding-agent transcripts signals trial-and-error churn (the agent keeps
 * re-editing the same file instead of fixing it once).
 */
function detectRepeatedEdits(trace: Trace): {
  detected: boolean;
  affectedSteps: number[];
  evidence: string[];
} {
  const counts = countFileWrites(trace);
  const affectedSteps: number[] = [];
  const evidence: string[] = [];

  for (const [file, count] of counts.entries()) {
    // 3+ edits to one file is the threshold for "thrash" (2 is normal).
    if (count >= 3) {
      const stepsWithFile = trace.steps
        .filter((s) => (s.filesWritten ?? []).some((f) => f.trim().toLowerCase() === file))
        .map((s) => s.step);
      affectedSteps.push(...stepsWithFile);
      evidence.push(`File "${file}" was edited ${count} times (steps: ${stepsWithFile.join(", ")})`);
    }
  }

  return {
    detected: evidence.length > 0,
    affectedSteps: [...new Set(affectedSteps)].sort((a, b) => a - b),
    evidence,
  };
}

/**
 * Detect retry spirals: repeated failures on similar actions without clear progress.
 */
function detectRetrySpiral(trace: Trace): {
  detected: boolean;
  affectedSteps: number[];
  evidence: string[];
} {
  const evidence: string[] = [];
  const affectedSteps: number[] = [];

  const totalRetries = trace.totals?.retries ?? 0;
  const failingSteps = trace.steps.filter((s) => (s.errors?.length ?? 0) > 0);

  if (totalRetries >= 2 || failingSteps.length >= 2) {
    evidence.push(`Observed ${totalRetries} total retries across the run.`);
    evidence.push(`${failingSteps.length} steps contained errors.`);

    // Look for repeated commands on failing steps
    const failedCommands = new Map<string, number>();
    for (const step of failingSteps) {
      for (const cmd of step.shellCommands ?? []) {
        const key = cmd.trim().toLowerCase();
        failedCommands.set(key, (failedCommands.get(key) ?? 0) + 1);
      }
      affectedSteps.push(step.step);
    }

    for (const [cmd, count] of failedCommands.entries()) {
      if (count >= 2) {
        evidence.push(`Command "${cmd}" failed ${count} times.`);
      }
    }
  }

  return {
    detected: evidence.length > 0,
    affectedSteps: [...new Set(affectedSteps)].sort((a, b) => a - b),
    evidence,
  };
}

/**
 * Detect whether usage metadata is missing for significant parts of the trace.
 */
function detectMissingUsageMetadata(trace: Trace): {
  missing: boolean;
  evidence: string[];
} {
  const stepsWithUsage = trace.steps.filter((s) => s.tokenUsage != null).length;
  const totalSteps = trace.steps.length;

  const hasGlobalTokens = (trace.totals?.tokenUsage?.total ?? 0) > 0;
  const hasAnyCost = trace.steps.some((s) => s.estimatedCostUsd != null);

  if (stepsWithUsage === 0 && !hasGlobalTokens && !hasAnyCost) {
    return {
      missing: true,
      evidence: [
        "No per-step token usage recorded.",
        "No aggregate token totals present.",
        "No estimated costs recorded on any step.",
      ],
    };
  }

  if (stepsWithUsage < totalSteps * 0.5 && totalSteps > 3) {
    return {
      missing: true,
      evidence: [
        `Only ${stepsWithUsage} of ${totalSteps} steps have token usage metadata.`,
      ],
    };
  }

  return { missing: false, evidence: [] };
}

// ---------------------------------------------------------------------------
// Evidence Level Assignment Helpers
// ---------------------------------------------------------------------------

/**
 * Assigns an appropriate EvidenceLevel for a repeated-read finding.
 *
 * - If we see the same file path multiple times in `filesRead` → Observed.
 * - If we also see rising token counts or repeated identical outputs → Correlated.
 * - Pure textual claim without data → Claimed (rare here).
 */
function assignRepeatedReadEvidenceLevel(
  trace: Trace,
  repeatedInfo: ReturnType<typeof detectRepeatedReads>,
): EvidenceLevel {
  if (!repeatedInfo.repeated) return "Unprovable";

  const hasTokenData = trace.steps.some((s) => s.tokenUsage != null);
  const hasMultipleReadsWithData = repeatedInfo.affectedSteps.length >= 2 && hasTokenData;

  if (hasMultipleReadsWithData) {
    return "Correlated";
  }

  // We directly saw the file paths repeated in the trace data
  return "Observed";
}

/**
 * Assigns EvidenceLevel for retry-related findings.
 */
function assignRetryEvidenceLevel(
  trace: Trace,
  retryInfo: ReturnType<typeof detectRetrySpiral>,
): EvidenceLevel {
  if (!retryInfo.detected) return "Unprovable";

  const hasExplicitRetries = (trace.totals?.retries ?? 0) > 0;
  const hasMultipleFailingSteps = retryInfo.affectedSteps.length >= 2;

  if (hasExplicitRetries && hasMultipleFailingSteps) {
    return "Correlated";
  }

  return "Observed";
}

/**
 * For missing metadata, this is almost always "Observed" (we observe the absence)
 * or "Unprovable" when we simply have no data at all.
 */
function assignMissingMetadataEvidenceLevel(trace: Trace): EvidenceLevel {
  const hasAnyStepData = trace.steps.length > 0;
  const hasUsage = trace.steps.some((s) => s.tokenUsage != null);

  if (!hasAnyStepData) return "Unprovable";
  if (!hasUsage) return "Observed";

  return "Claimed"; // We claim it's missing based on partial data
}

// ---------------------------------------------------------------------------
// Main Analysis Functions
// ---------------------------------------------------------------------------

/**
 * Extracts structured findings from the trace.
 * This is the primary place where Evidence Levels are decided.
 */
type RawFinding = Omit<
  Finding,
  "category" | "evidenceSupport" | "metricReliability" | "evidenceReason"
>;

/**
 * Attach the honest evidence-reliability fields to a finding. Behavioral
 * findings derive support from their evidence level (they never need metadata);
 * usage findings derive support from whether real token/cost metadata exists.
 */
function enrichFinding(raw: RawFinding, metrics: TraceMetrics): Finding {
  const category = categorizeFinding(raw.type);

  let evidenceSupport: EvidenceSupport;
  let evidenceReason: string;

  if (category === "usage") {
    if (raw.type === "missing_usage_metadata") {
      evidenceSupport = "unavailable";
      evidenceReason =
        "No exact token/cost usage fields are present, so usage analysis is unavailable.";
    } else {
      // cost_waste / token_waste etc. — strength follows the metadata.
      evidenceSupport = usageEvidenceSupport(metrics, "cost");
      evidenceReason =
        evidenceSupport === "metadata_backed"
          ? "Backed by recorded cost/token metadata in the trace."
          : evidenceSupport === "estimated"
            ? "Estimated from model pricing applied to visible token counts — labeled as an estimate."
            : "No usage metadata available to support an exact figure.";
    }
  } else {
    // Behavioral findings: observed from the visible session, never metadata.
    switch (raw.evidenceLevel) {
      case "Observed":
      case "Correlated":
        evidenceSupport = "observed";
        evidenceReason =
          "Directly visible in the session (repeated commands, file paths, or error lines).";
        break;
      case "Claimed":
        evidenceSupport = "estimated";
        evidenceReason =
          "Asserted in the transcript but not independently verifiable from execution data.";
        break;
      default:
        evidenceSupport = "unavailable";
        evidenceReason = "Insufficient visible evidence to support this finding.";
    }
  }

  return {
    ...raw,
    category,
    evidenceSupport,
    evidenceReason,
    metricReliability: reliabilityForSupport(evidenceSupport),
  };
}

function extractFindings(trace: Trace, metrics: TraceMetrics): Finding[] {
  const findings: RawFinding[] = [];

  // --- Repeated file reads -------------------------------------------------
  const repeatedReads = detectRepeatedReads(trace);
  if (repeatedReads.repeated) {
    const evidenceLevel = assignRepeatedReadEvidenceLevel(trace, repeatedReads);

    findings.push({
      id: generateId("finding"),
      type: "repeated_file_read",
      title: "Repeated file reads detected",
      summary:
        "The same file(s) were read multiple times during the run. This can inflate context size unnecessarily.",
      evidence: repeatedReads.evidence,
      evidenceLevel,
      severity: repeatedReads.affectedSteps.length >= 3 ? "high" : "medium",
      affectedSteps: repeatedReads.affectedSteps,
    });
  }

  // --- Retry spiral / repeated failures ------------------------------------
  const retrySpiral = detectRetrySpiral(trace);
  if (retrySpiral.detected) {
    const evidenceLevel = assignRetryEvidenceLevel(trace, retrySpiral);

    // Enrich with the concrete metrics view: repeated identical failures and
    // the measurable cost/token impact of the wasted attempts.
    const evidence = [...retrySpiral.evidence];
    for (const rf of metrics.repeatedFailures) {
      evidence.push(`Command "${rf.command}" failed ${rf.count}× (no progress between attempts).`);
    }
    if (metrics.wasteUsd != null || metrics.wasteTokens != null) {
      evidence.push(
        `Estimated waste from failures/retries: ${formatUsd(metrics.wasteUsd)}` +
          (metrics.wasteTokens != null ? ` / ${formatTokens(metrics.wasteTokens)} tokens` : "") +
          ` — ${metrics.wasteNote}`,
      );
    }

    findings.push({
      id: generateId("finding"),
      type: "retry_spiral",
      title: metrics.stuckLoop ? "Retry spiral — agent stuck in a loop" : "Retry spiral or repeated failures",
      summary:
        "The agent retried similar actions multiple times after failures, with limited new information between attempts.",
      evidence,
      evidenceLevel,
      severity: "high",
      affectedSteps: retrySpiral.affectedSteps,
    });
  }

  // --- Cost waste from failed/retried work ---------------------------------
  // Only emitted when we can actually attribute measured or estimated cost to
  // wasted steps — we never invent a dollar figure.
  if (metrics.wasteUsd != null && metrics.wasteUsd > 0 && retrySpiral.detected) {
    findings.push({
      id: generateId("finding"),
      type: "cost_waste",
      title: `Estimated cost waste: ${formatUsd(metrics.wasteUsd)} from repeated failures`,
      summary:
        "Tokens and cost were spent on steps that failed or were retried without making progress. " +
        "This is wasted spend that prevention rules can recover.",
      evidence: [
        `Wasted cost: ${formatUsd(metrics.wasteUsd)}${metrics.costIsEstimated ? " (partly estimated from model pricing)" : " (recorded)"}.`,
        metrics.wasteTokens != null ? `Wasted tokens: ${formatTokens(metrics.wasteTokens)}.` : "Token impact not measurable on these steps.",
        metrics.wasteNote,
      ],
      // Recorded cost → Correlated (cost + failure align); estimated → Observed.
      evidenceLevel: metrics.costIsEstimated ? "Observed" : "Correlated",
      severity: metrics.wasteUsd >= 0.5 ? "high" : "medium",
      affectedSteps: retrySpiral.affectedSteps,
    });
  }

  // --- Edit thrash (same file rewritten repeatedly) ------------------------
  const repeatedEdits = detectRepeatedEdits(trace);
  if (repeatedEdits.detected) {
    findings.push({
      id: generateId("finding"),
      type: "repeated_file_edit",
      title: "Edit thrash — same file rewritten repeatedly",
      summary:
        "One or more files were edited many times during the run, a hallmark of trial-and-error churn " +
        "rather than a single, planned change.",
      evidence: repeatedEdits.evidence,
      // We directly observed the same path in filesWritten multiple times.
      evidenceLevel: "Observed",
      // Edit thrash is a workflow risk, not a high-severity incident. High
      // severity is reserved for stronger evidence (repeated destructive
      // commands, exposed secrets, skipped verification after changes, runaway
      // metered tool/model calls). Keep this medium regardless of edit count.
      severity: "medium",
      affectedSteps: repeatedEdits.affectedSteps,
    });
  }

  // --- Missing usage metadata ----------------------------------------------
  // For markdown/raw exports this is a LIMITATION surfaced in the input profile,
  // not a finding (and never a security signal or rule). We only emit the finding
  // for structured traces, where usage metadata is expected by schema but absent.
  const missingUsage = detectMissingUsageMetadata(trace);
  if (missingUsage.missing && hasStructuredModelMetadata(trace)) {
    const evidenceLevel = assignMissingMetadataEvidenceLevel(trace);

    findings.push({
      id: generateId("finding"),
      type: "missing_usage_metadata",
      title: "Exact token/cost analysis unavailable",
      summary: USAGE_UNAVAILABLE_COPY,
      evidence: missingUsage.evidence,
      evidenceLevel,
      severity: "low",
    });
  }

  // --- Basic model information presence ------------------------------------
  const stepsWithModel = trace.steps.filter((s) => getModelName(s) != null).length;
  if (trace.steps.length > 0 && stepsWithModel === 0) {
    findings.push({
      id: generateId("finding"),
      type: "missing_model_identity",
      title: "No model identity recorded",
      summary:
        "None of the steps recorded which model was used. This makes model handoff analysis and cost reasoning difficult.",
      evidence: ["No `model` field present on any step."],
      evidenceLevel: "Observed",
      severity: "low",
    });
  }

  return findings.map((raw) => enrichFinding(raw, metrics));
}

/**
 * Detects model-to-model handoffs (MTM transitions).
 *
 * A handoff is recorded when two consecutive model-involved steps use different models.
 */
function detectModelHandoffs(trace: Trace): ModelHandoff[] {
  // Never infer model handoffs from text-derived model names (a prompt or pasted
  // diff mentioning "claude-code"/"claude-app" is not a runtime transition).
  if (!hasStructuredModelMetadata(trace)) return [];

  const handoffs: ModelHandoff[] = [];
  let previousModel: string | null = null;
  let previousStepNum: number | null = null;

  for (const step of trace.steps) {
    const currentModel = getModelName(step);

    // Only consider steps that involve a model
    const isModelStep = step.actor === "model" || currentModel != null;

    if (isModelStep && currentModel) {
      if (previousModel && previousModel !== currentModel && previousStepNum != null) {
        handoffs.push({
          id: generateId("handoff"),
          fromStep: previousStepNum,
          fromModel: previousModel,
          toStep: step.step,
          toModel: currentModel,
          detection: "sequential",
          evidenceLevel: "Observed", // We directly saw two different model names
          note: `Model changed from ${previousModel} to ${currentModel} between steps ${previousStepNum} and ${step.step}.`,
        });
      }
      previousModel = currentModel;
      previousStepNum = step.step;
    }
  }

  return handoffs;
}

/**
 * Generates basic security signals based on the trace and detected handoffs.
 *
 * Phase 1 keeps this conservative — only obvious structural risks.
 */
function generateSecuritySignals(
  trace: Trace,
  handoffs: ModelHandoff[],
): SecuritySignal[] {
  const signals: SecuritySignal[] = [];

  // Excessive model switching
  if (handoffs.length >= 3) {
    signals.push({
      id: generateId("signal"),
      kind: "unusual_model_switch",
      title: "Excessive model switching",
      description: `The trace shows ${handoffs.length} model handoffs. Frequent switching can indicate unstable routing or planner-executor loops without clear boundaries.`,
      evidenceLevel: "Observed",
      affectedSteps: handoffs.flatMap((h) => [h.fromStep, h.toStep]),
      evidence: handoffs.map((h) => `Step ${h.fromStep} (${h.fromModel}) → Step ${h.toStep} (${h.toModel})`),
      recommendedAction: "Review model routing logic. Consider pinning a primary model for the core task and only escalating for specific sub-tasks.",
      severity: handoffs.length >= 5 ? "high" : "medium",
      heuristic: true,
    });
  }

  // NOTE: Missing token/cost metadata is intentionally NOT a security signal.
  // It is a data-quality limitation surfaced in the report's input/source
  // profile and the "Exact token/cost analysis unavailable" note — not a risk,
  // not a high-severity finding, and never a "Require usage metadata" rule. This
  // keeps markdown/raw exports honest: missing receipts is a limitation, not a
  // failure of the user.

  // Very high retry count can be a sign of stuck behavior (potential DoS on downstream tools)
  const totalRetries = trace.totals?.retries ?? 0;
  if (totalRetries >= 5) {
    signals.push({
      id: generateId("signal"),
      kind: "other",
      title: "High retry volume",
      description: `The run recorded ${totalRetries} retries. This may indicate the agent is stuck in a loop or probing fragile tools repeatedly.`,
      evidenceLevel: "Observed",
      affectedSteps: trace.steps
        .filter((s) => (s.retries ?? 0) > 0 || (s.errors?.length ?? 0) > 0)
        .map((s) => s.step),
      evidence: [`Total retries observed: ${totalRetries}`],
      recommendedAction: "Add circuit breakers or backoff with diagnostic steps after repeated failures.",
      severity: totalRetries >= 8 ? "high" : "medium",
      heuristic: true,
    });
  }

  return signals;
}

/**
 * Produces actionable recommendations based on findings and security signals.
 */
function generateRecommendations(
  findings: Finding[],
  signals: SecuritySignal[],
): Recommendation[] {
  const recommendations: Recommendation[] = [];

  // NOTE: We intentionally do NOT emit a generic "Address highest-severity waste
  // patterns first" recommendation. It adds no product value and competes with
  // the specific, evidence-tied recommendations below. Every recommendation here
  // points at a concrete observed pattern.

  // Repeated reads specific advice
  const repeatedReadFinding = findings.find((f) => f.type === "repeated_file_read");
  if (repeatedReadFinding) {
    recommendations.push({
      id: generateId("rec"),
      priority: "medium",
      title: "Cache or reference repeated file contents",
      description:
        "Instead of re-reading the same files, store results in memory or pass lightweight references/summaries to subsequent model calls.",
      relatedFindingIds: [repeatedReadFinding.id],
    });
  }

  // Edit-thrash advice
  const editFinding = findings.find((f) => f.type === "repeated_file_edit");
  if (editFinding) {
    recommendations.push({
      id: generateId("rec"),
      priority: "medium",
      title: "Plan the change before editing",
      description:
        "When a file is edited 3+ times in a run, have the agent read the file fully and outline the " +
        "complete change first, then apply it in one pass — instead of incremental trial-and-error edits.",
      relatedFindingIds: [editFinding.id],
    });
  }

  // Retry advice
  const retryFinding = findings.find((f) => f.type === "retry_spiral");
  if (retryFinding) {
    recommendations.push({
      id: generateId("rec"),
      priority: "high",
      title: "Implement diagnostic step after repeated failures",
      description:
        "After 2 failed attempts on the same action, switch to a diagnostic or planning step instead of blindly retrying.",
      relatedFindingIds: [retryFinding.id],
    });
  }

  // Security signal driven recommendations
  const switchSignal = signals.find((s) => s.kind === "unusual_model_switch");
  if (switchSignal) {
    recommendations.push({
      id: generateId("rec"),
      priority: "medium",
      title: "Stabilize model selection strategy",
      description: switchSignal.recommendedAction,
      relatedSignalIds: [switchSignal.id],
    });
  }

  // NOTE: We intentionally do not emit a "Require usage metadata" recommendation.
  // Missing token/cost metadata is a limitation shown in the source profile, not
  // an action item — especially for markdown/raw exports that never carry receipts.

  // Fallback general recommendation when nothing strong was found
  if (recommendations.length === 0) {
    recommendations.push({
      id: generateId("rec"),
      priority: "low",
      title: "Continue collecting structured trace data",
      description:
        "The trace did not trigger strong waste or risk patterns. Maintain consistent recording of model names, token usage, and step outcomes for future analysis.",
    });
  }

  return recommendations;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generates a structured Blackbox Report from a raw agent trace.
 *
 * The report includes:
 * - Findings with honest Evidence Levels
 * - Detected model handoffs
 * - Basic security signals
 * - Actionable recommendations
 *
 * This function is designed to be conservative — it prefers "Unprovable"
 * or "Observed" over overclaiming.
 */
export async function generateBlackboxReport(trace: Trace): Promise<BlackboxReport> {
  // --- Validation ----------------------------------------------------------
  if (!trace || typeof trace !== "object") {
    throw new InvalidTraceError("Trace must be a non-null object");
  }

  if (!Array.isArray(trace.steps)) {
    throw new InvalidTraceError("Trace must contain a 'steps' array");
  }

  if (!trace.sessionId || typeof trace.sessionId !== "string") {
    throw new InvalidTraceError("Trace must have a non-empty 'sessionId' string");
  }

  // --- Analysis ------------------------------------------------------------
  // Compute honest metrics once and thread them through findings + signals so
  // cost/token/waste numbers are consistent everywhere in the report.
  const metrics = computeTraceMetrics(trace);
  const findings = extractFindings(trace, metrics);
  const modelHandoffs = detectModelHandoffs(trace);
  // Generic operational signals + lightweight MTM (model-to-model) security
  // signals (escalation, high-volume, distillation, missing credentials).
  const securitySignals = [
    ...generateSecuritySignals(trace, modelHandoffs),
    ...detectMtmSignals(trace, modelHandoffs, hasStructuredModelMetadata(trace)),
  ];
  const recommendations = generateRecommendations(findings, securitySignals);

  // --- Summarization --------------------------------------------------------
  const highSeverityCount = findings.filter((f) => f.severity === "high").length;

  let summary = "No major waste patterns or risk signals were detected in this trace.";
  if (highSeverityCount > 0) {
    summary = `${highSeverityCount} high-severity finding(s) were identified. Review the findings and recommendations for remediation steps.`;
  } else if (findings.length > 0) {
    summary = `${findings.length} finding(s) were identified. Most are moderate or low severity.`;
  }

  if (modelHandoffs.length > 0) {
    summary += ` ${modelHandoffs.length} model handoff(s) were observed.`;
  }

  const overallRisk: "low" | "medium" | "high" =
    highSeverityCount >= 2 || securitySignals.some((s) => s.severity === "high")
      ? "high"
      : highSeverityCount === 1 || findings.length >= 3 || securitySignals.length >= 2
        ? "medium"
        : "low";

  // --- Parser confidence + rule recommendation gate ------------------------
  const parserConfidence = computeParserConfidence(trace, metrics);

  // A new workspace rule is only worth recommending when we have at least one
  // behavioral finding with strong (observed/metadata-backed) support. Clean or
  // weak sessions explicitly produce no rule — this is a trust feature.
  const ruleWorthyFinding = findings.find(
    (f) =>
      f.category === "behavioral" &&
      (f.evidenceSupport === "observed" || f.evidenceSupport === "metadata_backed") &&
      f.type !== "missing_model_identity",
  );
  const noNewRuleRecommended = ruleWorthyFinding == null;
  const noNewRuleReason = noNewRuleRecommended
    ? "No high-confidence repeat patterns found. No new workspace rule recommended from this session."
    : undefined;

  // --- Assemble Report -----------------------------------------------------
  const report: BlackboxReport = {
    id: generateId("report"),
    traceSessionId: trace.sessionId,
    parserConfidence,
    inputProfile: trace.inputProfile,
    verificationPresent: detectVerificationPresent(trace),
    noNewRuleRecommended,
    noNewRuleReason,
    taskSummary: trace.taskSummary ?? "Unknown task",
    generatedAt: new Date().toISOString(),
    summary,
    findings,
    modelHandoffs,
    securitySignals,
    recommendations,
    overallRisk,
  };

  return report;
}
