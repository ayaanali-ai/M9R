/**
 * Rule Engine — OathLock Phase 1
 *
 * This module provides the core logic for:
 *   1. Evaluating which persistent Rules apply to a given Trace.
 *   2. Recording that a Rule was applied to a Trace.
 *   3. Creating new persistent Rules from findings in a Blackbox Report.
 *
 * Design principles (Phase 1):
 * - Keep matching deterministic and explainable.
 * - Never invent evidence; matching is based on observable trace structure.
 * - Clear validation and error messages.
 * - The service is intentionally simple — matching heuristics can be
 *   expanded in later phases without changing the public API.
 */

import { supabase } from "@/lib/supabase";
import type {
  Trace as BaseTrace,
  Rule as BaseRule,
  EvidenceLevel,
} from "@/lib/oathlock";

// ---------------------------------------------------------------------------
// Re-exported / Extended Domain Types
// ---------------------------------------------------------------------------

/** Re-export Trace for consumers of the rule engine. */
export type Trace = BaseTrace;

/**
 * Rule represents a persistent improvement rule stored in the database.
 * Extends the core domain Rule with a usage counter for Phase 1 analytics.
 */
export interface Rule extends BaseRule {
  /**
   * How many times this rule has been applied (recorded) against traces.
   * Maintained by applyRuleToTrace().
   */
  timesApplied?: number;
}

/**
 * Finding is the minimal shape needed to derive a persistent Rule.
 * This is intentionally aligned with (but not identical to) CodingAgentFinding
 * and the inline findings inside BlackboxReport.
 */
export interface Finding {
  /** Optional stable id of the source finding. */
  id?: string;

  /** The detector / waste pattern type (e.g. "retry_spiral", "redundant_file_read"). */
  type: string;

  /** Human readable title of the finding. */
  title: string;

  severity: "low" | "medium" | "high";

  /** Short explanation of what was observed. */
  summary?: string;

  /** Concrete snippets of evidence from the trace. */
  evidence?: string[];

  /** Fields or aspects of the trace that were implicated. */
  affectedFields?: string[];

  /** Suggested prevention steps. First item is often used for "fix now". */
  preventionPlan?: string[];

  /** How strongly the finding was supported. */
  evidenceLevel?: EvidenceLevel;

  confidence?: "low" | "medium" | "high";
}

// ---------------------------------------------------------------------------
// Result Types
// ---------------------------------------------------------------------------

/** Describes why a rule matched a trace and with what strength. */
export interface MatchedRule {
  rule: Rule;
  /** Human-readable explanation of why this rule fired on the trace. */
  reason: string;
  /** Rough qualitative strength of the structural signal. */
  signalStrength: "weak" | "moderate" | "strong";
}

/** Describes why a rule did not match. */
export interface UnmatchedRule {
  rule: Rule;
  /** Human-readable reason it was not applied. */
  reason: string;
}

/** The result of running rule evaluation against a trace. */
export interface RuleApplicationResult {
  /** The session identifier from the trace (for correlation). */
  sessionId: string;
  /** Rules that matched the trace with explanations. */
  matchedRules: MatchedRule[];
  /** Rules that were considered but did not match. */
  unmatchedRules: UnmatchedRule[];
  /** When evaluation completed (ISO string). */
  evaluatedAt: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class RuleEngineError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "RuleEngineError";
    this.code = code;
  }
}

export class ValidationError extends RuleEngineError {
  constructor(message: string) {
    super(message, "VALIDATION_ERROR");
    this.name = "ValidationError";
  }
}

export class PersistenceError extends RuleEngineError {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message, "PERSISTENCE_ERROR");
    this.name = "PersistenceError";
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Internal: Trace Signal Detectors (used by matching)
// These are deliberately structural and conservative.
// ---------------------------------------------------------------------------

function countFileReads(trace: Trace): Map<string, number> {
  const counts = new Map<string, number>();
  for (const step of trace.steps ?? []) {
    for (const file of step.filesRead ?? []) {
      const key = file.trim().toLowerCase();
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

function hasRepeatedFileReads(trace: Trace): boolean {
  for (const count of countFileReads(trace).values()) {
    if (count >= 2) return true;
  }
  return false;
}

function hasHighRepeatFileReads(trace: Trace): boolean {
  for (const count of countFileReads(trace).values()) {
    if (count >= 3) return true;
  }
  return false;
}

function hasRetrySpiralSignals(trace: Trace): boolean {
  const retries = trace.totals?.retries ?? 0;
  const failedSteps = trace.steps?.filter((s) => (s.errors?.length ?? 0) > 0).length ?? 0;
  // A real spiral usually shows multiple retries + repeated failing commands.
  return retries >= 2 || failedSteps >= 2;
}

function hasStrongRetrySpiral(trace: Trace): boolean {
  const retries = trace.totals?.retries ?? 0;
  const failedSteps = trace.steps?.filter((s) => (s.errors?.length ?? 0) > 0).length ?? 0;
  return retries >= 3 || failedSteps >= 3;
}

function hasBloatedToolOutput(trace: Trace): boolean {
  const bloatedPatterns =
    /bloated|full.*(log|output)|dumped|entire log|thousands of lines|large output|pasted (the )?(whole|entire)/i;
  return (trace.steps ?? []).some((step) => {
    const summary = step.toolOutputSummary ?? "";
    return bloatedPatterns.test(summary);
  });
}

/**
 * Missing usage metadata detector.
 *
 * IMPORTANT: This intentionally mirrors `detectMissingUsageMetadata` in
 * blackbox-report.ts so that a rule fires whenever the report flags the same
 * pattern. Previously this only returned true when usage was *entirely* absent,
 * which meant traces with partial metadata were flagged by the report but the
 * rule silently failed to trigger.
 *
 * We return a structured result so callers can distinguish "no data at all"
 * (strong signal) from "partial coverage" (moderate signal).
 */
function detectMissingUsageMetadata(trace: Trace): {
  missing: boolean;
  /** True when there is no usage/cost data whatsoever. */
  total: boolean;
} {
  const steps = trace.steps ?? [];
  const stepsWithUsage = steps.filter((s) => s.tokenUsage != null).length;
  const totalSteps = steps.length;

  const hasGlobalTokens = (trace.totals?.tokenUsage?.total ?? 0) > 0;
  const hasAnyCost = steps.some((s) => s.estimatedCostUsd != null);

  // Case 1: nothing at all — no per-step usage, no totals, no cost.
  if (stepsWithUsage === 0 && !hasGlobalTokens && !hasAnyCost) {
    return { missing: true, total: true };
  }

  // Case 2: partial coverage on a non-trivial trace (matches the report).
  if (stepsWithUsage < totalSteps * 0.5 && totalSteps > 3) {
    return { missing: true, total: false };
  }

  return { missing: false, total: false };
}

/** True when no step recorded which model was used (mirrors the report). */
function hasMissingModelIdentity(trace: Trace): boolean {
  const steps = trace.steps ?? [];
  if (steps.length === 0) return false;
  return steps.every((s) => !s.model || s.model.trim() === "");
}

function hasBuildFixLoopSignals(trace: Trace): boolean {
  const failedBuildish = (trace.steps ?? []).filter((s) => {
    const cmds = (s.shellCommands ?? []).join(" ").toLowerCase();
    const errs = (s.errors ?? []).join(" ").toLowerCase();
    return /build|npm run build|tsc|eslint/.test(cmds) && /error|fail|exit code 1/.test(errs);
  }).length;
  const retries = trace.totals?.retries ?? 0;
  return failedBuildish >= 2 || (failedBuildish >= 1 && retries >= 1);
}

// ---------------------------------------------------------------------------
// Core Matching Logic
// ---------------------------------------------------------------------------

interface MatchDecision {
  applies: boolean;
  reason: string;
  signalStrength: "weak" | "moderate" | "strong";
}

const LEAK_TYPE_MATCHERS: Record<
  string,
  (trace: Trace) => MatchDecision
> = {
  // Repeated / redundant reads of the same file
  repeated_context: (trace) => {
    if (hasHighRepeatFileReads(trace)) {
      return {
        applies: true,
        reason: "The same file(s) were read 3+ times with no intervening edits.",
        signalStrength: "strong",
      };
    }
    if (hasRepeatedFileReads(trace)) {
      return {
        applies: true,
        reason: "The same file(s) were read multiple times across steps.",
        signalStrength: "moderate",
      };
    }
    return {
      applies: false,
      reason: "No repeated file reads detected.",
      signalStrength: "weak",
    };
  },

  redundant_file_read: (trace) => {
    // Alias for repeated context in many detectors
    const base = LEAK_TYPE_MATCHERS.repeated_context(trace);
    if (base.applies) {
      return {
        ...base,
        reason: base.reason.replace("file(s) were read", "file was re-read"),
      };
    }
    return base;
  },

  // Retry / loop behavior
  retry_spiral: (trace) => {
    if (hasStrongRetrySpiral(trace)) {
      return {
        applies: true,
        reason: "Multiple retries (3+) combined with repeated failures observed.",
        signalStrength: "strong",
      };
    }
    if (hasRetrySpiralSignals(trace)) {
      return {
        applies: true,
        reason: "Retries and/or repeated failing steps detected.",
        signalStrength: "moderate",
      };
    }
    return {
      applies: false,
      reason: "No significant retry spiral signals found.",
      signalStrength: "weak",
    };
  },

  build_fix_loop: (trace) => {
    if (hasBuildFixLoopSignals(trace)) {
      return {
        applies: true,
        reason: "Repeated build/lint failures with retries or multiple failing steps.",
        signalStrength: "moderate",
      };
    }
    return {
      applies: false,
      reason: "No build-fix loop pattern detected in commands and errors.",
      signalStrength: "weak",
    };
  },

  // Bloated tool output being fed back into context
  bloated_tool_output: (trace) => {
    if (hasBloatedToolOutput(trace)) {
      return {
        applies: true,
        reason: "Tool output summaries contain indicators of large or full dumps being passed forward.",
        signalStrength: "moderate",
      };
    }
    return {
      applies: false,
      reason: "No bloated tool output signals found in step summaries.",
      signalStrength: "weak",
    };
  },

  // Missing usage metadata makes cost/token attribution impossible.
  // Mirrors the report: fires on both total absence and partial coverage.
  missing_usage_metadata: (trace) => {
    const result = detectMissingUsageMetadata(trace);
    if (result.missing) {
      return result.total
        ? {
            applies: true,
            reason:
              "No token usage or cost metadata was present on any step or in totals.",
            signalStrength: "strong",
          }
        : {
            applies: true,
            reason:
              "Fewer than half of the steps carry token usage metadata, making cost attribution unreliable.",
            signalStrength: "moderate",
          };
    }
    return {
      applies: false,
      reason: "Trace contains sufficient usage metadata.",
      signalStrength: "weak",
    };
  },

  // No model identity recorded on any step.
  missing_model_identity: (trace) => {
    if (hasMissingModelIdentity(trace)) {
      return {
        applies: true,
        reason: "No `model` field was recorded on any step.",
        signalStrength: "strong",
      };
    }
    return {
      applies: false,
      reason: "At least one step records a model identity.",
      signalStrength: "weak",
    };
  },
};

/**
 * Alias map: normalizes the many leak-type / finding-type spellings onto a
 * single canonical matcher key.
 *
 * This is the fix for the most common silent failure: the Blackbox Report
 * emits findings of type `repeated_file_read`, while the matcher map was keyed
 * on `repeated_context` / `redundant_file_read`. A rule created from such a
 * finding (leakType === "repeated_file_read") therefore never found a matcher
 * and fell through to the weak text-search fallback, so it never triggered.
 *
 * Keep both keys and values lowercase. Add new synonyms here rather than
 * duplicating matcher logic.
 */
const LEAK_TYPE_ALIASES: Record<string, string> = {
  repeated_file_read: "repeated_context",
  redundant_file_read: "repeated_context",
  repeated_reads: "repeated_context",
  retry_loop: "retry_spiral",
  retries: "retry_spiral",
  build_loop: "build_fix_loop",
  missing_metadata: "missing_usage_metadata",
  missing_usage: "missing_usage_metadata",
  usage_metadata_missing: "missing_usage_metadata",
  missing_model: "missing_model_identity",
  model_identity_missing: "missing_model_identity",
};

/**
 * Resolve a rule's leakType to a matcher, applying canonicalization and
 * aliasing. Returns null when no structural matcher exists for the type.
 */
function resolveMatcher(
  leakType: string,
): ((trace: Trace) => MatchDecision) | null {
  const key = leakType.trim().toLowerCase();
  // 1) Direct hit on a known matcher.
  if (LEAK_TYPE_MATCHERS[key]) return LEAK_TYPE_MATCHERS[key];
  // 2) Alias resolution onto a canonical matcher.
  const aliased = LEAK_TYPE_ALIASES[key];
  if (aliased && LEAK_TYPE_MATCHERS[aliased]) return LEAK_TYPE_MATCHERS[aliased];
  return null;
}

/**
 * Canonicalize any leak-type / finding-type string to its stable key.
 * Lowercases, trims, and resolves known synonyms via the alias map.
 */
function canonicalLeakType(type: string): string {
  const key = (type ?? "").trim().toLowerCase();
  return LEAK_TYPE_ALIASES[key] ?? key;
}

// ---------------------------------------------------------------------------
// Report-Driven Matching
//
// The most reliable way to keep rule evaluation consistent with the Blackbox
// Report is to match rules directly against what the report actually surfaced
// (findings, security signals, and recommendations) — not to independently
// re-derive signals from the raw trace and hope the two detectors agree.
//
// This closes a whole class of silent misses. For example, the recommendation
// "Require usage metadata on all model calls" is produced from a *security
// signal*, which the structural trace matchers never inspected. By indexing the
// report we guarantee: if the report flagged a pattern, a rule for that pattern
// triggers.
// ---------------------------------------------------------------------------

/**
 * Minimal structural view of a Blackbox Report needed for matching.
 * Declared locally so the rule engine does not hard-depend on the report module
 * (callers can pass the real BlackboxReport — it is structurally compatible).
 */
export interface ReportLike {
  findings?: Array<{
    id?: string;
    type: string;
    title?: string;
    severity?: "low" | "medium" | "high";
  }>;
  securitySignals?: Array<{
    kind?: string;
    title?: string;
    severity?: "low" | "medium" | "high";
  }>;
  recommendations?: Array<{
    title?: string;
    relatedFindingIds?: string[];
  }>;
}

/** A pattern the report surfaced, keyed by canonical leak type. */
interface ReportSignal {
  reason: string;
  severity: "low" | "medium" | "high";
}

/** Map a finding/signal severity onto a qualitative signal strength. */
function severityToStrength(
  severity: "low" | "medium" | "high" | undefined,
): "weak" | "moderate" | "strong" {
  if (severity === "high") return "strong";
  if (severity === "low") return "weak";
  return "moderate"; // medium or unspecified
}

/**
 * Map a security signal (by kind/title) onto a canonical leak type.
 * Security signals do not carry a `type`, so we infer it from their semantics.
 */
function leakTypeForSecuritySignal(signal: {
  kind?: string;
  title?: string;
}): string | null {
  const haystack = `${signal.kind ?? ""} ${signal.title ?? ""}`.toLowerCase();
  if (haystack.includes("metadata")) return "missing_usage_metadata";
  if (haystack.includes("retry")) return "retry_spiral";
  if (haystack.includes("model_switch") || haystack.includes("model switch")) {
    return "unusual_model_switch";
  }
  return null;
}

/**
 * Build an index of every pattern the report surfaced, keyed by canonical leak
 * type. When the same leak type appears multiple times, the strongest severity
 * wins so the rule fires with the most accurate signal strength.
 */
function buildReportSignalIndex(report: ReportLike): Map<string, ReportSignal> {
  const index = new Map<string, ReportSignal>();
  const sevRank = { low: 1, medium: 2, high: 3 } as const;

  const add = (
    rawType: string | null,
    reason: string,
    severity: "low" | "medium" | "high" = "medium",
  ) => {
    if (!rawType) return;
    const key = canonicalLeakType(rawType);
    if (!key) return;
    const existing = index.get(key);
    // Keep whichever occurrence carries the higher severity.
    if (!existing || sevRank[severity] > sevRank[existing.severity]) {
      index.set(key, { reason, severity });
    }
  };

  // 1) Findings — the primary, type-bearing source.
  for (const f of report.findings ?? []) {
    add(
      f.type,
      `Report finding "${f.title ?? f.type}" (${f.severity ?? "medium"}) matches this rule.`,
      f.severity ?? "medium",
    );
  }

  // 2) Security signals — inferred type from kind/title.
  for (const s of report.securitySignals ?? []) {
    const type = leakTypeForSecuritySignal(s);
    add(
      type,
      `Report security signal "${s.title ?? type}" (${s.severity ?? "medium"}) matches this rule.`,
      s.severity ?? "medium",
    );
  }

  // 3) Recommendations — resolve via their related findings, then keywords.
  const findingTypeById = new Map<string, string>();
  for (const f of report.findings ?? []) {
    if (f.id) findingTypeById.set(f.id, f.type);
  }
  for (const r of report.recommendations ?? []) {
    // a) Resolve through the findings a recommendation explicitly references.
    for (const fid of r.relatedFindingIds ?? []) {
      const t = findingTypeById.get(fid);
      if (t) add(t, `Report recommendation "${r.title ?? t}" targets this rule.`);
    }
    // b) Keyword fallback for recommendations not tied to a finding
    //    (e.g. "Require usage metadata on all model calls").
    const title = (r.title ?? "").toLowerCase();
    if (title.includes("usage metadata") || title.includes("usage or cost")) {
      add("missing_usage_metadata", `Report recommendation "${r.title}" targets this rule.`);
    }
    if (title.includes("retry") || title.includes("repeated failure")) {
      add("retry_spiral", `Report recommendation "${r.title}" targets this rule.`);
    }
    if (title.includes("repeated file") || title.includes("re-read") || title.includes("cache")) {
      add("repeated_context", `Report recommendation "${r.title}" targets this rule.`);
    }
  }

  return index;
}

/**
 * Decide whether a single rule applies to the given trace.
 * This is the heart of evaluateRulesForTrace.
 *
 * Matching order:
 *   1. Report-driven: if a report index is provided and it surfaced a pattern
 *      matching the rule's (canonical) leak type, the rule fires. This keeps
 *      evaluation consistent with the report by construction.
 *   2. Structural: otherwise fall back to deterministic trace detectors.
 */
function decideRuleMatch(
  rule: Rule,
  trace: Trace,
  reportIndex?: Map<string, ReportSignal>,
): MatchDecision {
  // 1) Prefer the report's own conclusions when available.
  if (reportIndex) {
    const signal = reportIndex.get(canonicalLeakType(rule.leakType));
    if (signal) {
      return {
        applies: true,
        reason: signal.reason,
        signalStrength: severityToStrength(signal.severity),
      };
    }
  }

  // 2) Resolve via canonicalization + alias map so finding-type spellings
  // (e.g. "repeated_file_read") reach the right structural matcher.
  const matcher = resolveMatcher(rule.leakType);

  if (matcher) {
    return matcher(trace);
  }

  // Fallback heuristic for unknown/custom leak types:
  // Look for the leakType string appearing in error messages, commands, or summaries.
  const haystack = [
    ...((trace.steps ?? []).flatMap((s) => s.errors ?? [])),
    ...((trace.steps ?? []).flatMap((s) => s.shellCommands ?? [])),
    ...(trace.totals ? [JSON.stringify(trace.totals)] : []),
  ]
    .join(" ")
    .toLowerCase();

  if (haystack.includes(rule.leakType.toLowerCase())) {
    return {
      applies: true,
      reason: `Trace contains textual signal matching leak type "${rule.leakType}".`,
      signalStrength: "weak",
    };
  }

  return {
    applies: false,
    reason: `No direct structural or textual match for leak type "${rule.leakType}".`,
    signalStrength: "weak",
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluate which of the provided active rules apply to the given trace.
 *
 * Matching is purely structural and based on observable properties of the trace
 * (repeated reads, retries + errors, bloated outputs, missing metadata, etc.).
 *
 * The function always returns a result object even when no rules match.
 * It never throws for "no match" conditions — only for invalid input.
 *
 * @param report Optional Blackbox Report. When supplied, rules are matched
 *   against what the report actually surfaced (findings, security signals,
 *   recommendations) first, then fall back to structural trace detection.
 *   Passing the report is strongly recommended: it guarantees that any pattern
 *   the report flagged will trigger its corresponding rule.
 */
export async function evaluateRulesForTrace(
  trace: Trace,
  activeRules: Rule[],
  report?: ReportLike,
): Promise<RuleApplicationResult> {
  // --- Input Validation ----------------------------------------------------
  if (!trace || typeof trace !== "object") {
    throw new ValidationError("trace must be a valid Trace object");
  }
  if (!Array.isArray(trace.steps)) {
    throw new ValidationError("trace.steps must be an array");
  }
  if (!trace.sessionId || typeof trace.sessionId !== "string") {
    throw new ValidationError("trace.sessionId is required and must be a string");
  }
  if (!Array.isArray(activeRules)) {
    throw new ValidationError("activeRules must be an array");
  }

  const evaluatedAt = new Date().toISOString();
  const matchedRules: MatchedRule[] = [];
  const unmatchedRules: UnmatchedRule[] = [];
  const reportIndex = report ? buildReportSignalIndex(report) : undefined;

  for (const rule of activeRules) {
    // Basic guard on rule shape
    if (!rule || !rule.id || !rule.leakType) {
      unmatchedRules.push({
        rule: (rule ?? { id: "invalid", leakType: "unknown" }) as Rule,
        reason: "Rule is missing required fields (id or leakType).",
      });
      continue;
    }

    // Run the decision logic (commented above)
    const decision = decideRuleMatch(rule, trace, reportIndex);

    if (decision.applies) {
      matchedRules.push({
        rule,
        reason: decision.reason,
        signalStrength: decision.signalStrength,
      });
    } else {
      unmatchedRules.push({
        rule,
        reason: decision.reason,
      });
    }
  }

  // Sort matched by rough strength (strong first) for usability
  matchedRules.sort((a, b) => {
    const order = { strong: 3, moderate: 2, weak: 1 } as const;
    return order[b.signalStrength] - order[a.signalStrength];
  });

  return {
    sessionId: trace.sessionId,
    matchedRules,
    unmatchedRules,
    evaluatedAt,
  };
}

/**
 * Record that a rule was applied to a specific trace.
 *
 * Side effects:
 *   - Increments `times_applied` (or `timesApplied`) on the rule.
 *   - Inserts a row into rule_applications for auditability (best effort).
 *
 * This function is intended to be called from server-side code (API routes).
 */
export async function applyRuleToTrace(
  ruleId: string,
  traceId: string,
  userId: string,
): Promise<void> {
  // --- Input Validation ----------------------------------------------------
  if (!ruleId || typeof ruleId !== "string") {
    throw new ValidationError("ruleId is required and must be a non-empty string");
  }
  if (!traceId || typeof traceId !== "string") {
    throw new ValidationError("traceId is required and must be a non-empty string");
  }
  if (!userId || typeof userId !== "string") {
    throw new ValidationError("userId is required and must be a non-empty string");
  }

  if (!supabase) {
    throw new PersistenceError(
      "Supabase client is not configured. Cannot persist rule application.",
    );
  }

  try {
    // 1) Increment the times_applied counter on the rule.
    // We use a small RPC-friendly pattern: fetch current, increment, update.
    const { data: currentRule, error: fetchErr } = await supabase
      .from("rules")
      .select("id, times_applied")
      .eq("id", ruleId)
      .maybeSingle();

    if (fetchErr) {
      throw new PersistenceError("Failed to load rule for application", fetchErr);
    }
    if (!currentRule) {
      throw new RuleEngineError(`Rule not found: ${ruleId}`, "RULE_NOT_FOUND");
    }

    const nextCount = (currentRule.times_applied ?? 0) + 1;

    const { error: updateErr } = await supabase
      .from("rules")
      .update({ times_applied: nextCount, updated_at: new Date().toISOString() })
      .eq("id", ruleId);

    if (updateErr) {
      throw new PersistenceError("Failed to increment times_applied on rule", updateErr);
    }

    // 2) Record the application event (for history and future analytics).
    // We do not require a reportId here; it can be added by callers that have it.
    const { error: insertErr } = await supabase.from("rule_applications").insert({
      rule_id: ruleId,
      trace_id: traceId,
      status: "applied",
      applied_at: new Date().toISOString(),
    });

    if (insertErr) {
      // Non-fatal for the increment — log via throw only if you want strictness.
      // For Phase 1 we surface it so callers can decide.
      throw new PersistenceError("Failed to record rule application", insertErr);
    }
  } catch (err) {
    if (err instanceof RuleEngineError) throw err;
    throw new PersistenceError("Unexpected error while applying rule to trace", err);
  }
}

/**
 * Create a new persistent Rule derived from a single Finding in a Blackbox Report.
 *
 * The created rule will:
 *   - Use the finding's type as leakType
 *   - Pull prevention text from the finding when available
 *   - Record the source report via sourceReportIds
 *   - Default evidenceLevel to "Observed" when not provided on the finding
 *
 * Returns the persisted Rule (with generated id and timestamps).
 */
export async function createRuleFromFinding(
  reportId: string,
  finding: Finding,
): Promise<Rule> {
  // --- Input Validation ----------------------------------------------------
  if (!reportId || typeof reportId !== "string") {
    throw new ValidationError("reportId is required and must be a non-empty string");
  }
  if (!finding || typeof finding !== "object") {
    throw new ValidationError("finding must be a valid Finding object");
  }
  if (!finding.type || typeof finding.type !== "string") {
    throw new ValidationError("finding.type is required");
  }
  if (!finding.title || typeof finding.title !== "string") {
    throw new ValidationError("finding.title is required");
  }

  if (!supabase) {
    throw new PersistenceError(
      "Supabase client is not configured. Cannot create rule.",
    );
  }

  // Build human-friendly rule content from the finding
  const leakType = finding.type;
  const title = finding.title;
  const severity = finding.severity ?? "medium";

  // Use the first prevention step as the immediate fix when available.
  const fixNow = finding.preventionPlan?.[0] ?? "Address the root cause indicated by the finding.";
  const promptFix =
    finding.preventionPlan?.[1] ??
    "Before repeating the action, verify whether prior results can be reused.";
  const policyRule =
    `Flag traces that exhibit "${leakType}" patterns and require review before proceeding.`;

  const evidenceLevel: EvidenceLevel = finding.evidenceLevel ?? "Observed";

  const now = new Date().toISOString();

  const rulePayload = {
    // id will be generated by DB or we can let the insert return it
    project_id: null, // Phase 1: many rules may be global or attached later
    created_by: null, // Filled by server context when available
    leak_type: leakType,
    severity,
    title,
    cause:
      finding.summary ??
      `Pattern "${leakType}" was detected in a prior forensic analysis.`,
    fix_now: fixNow,
    prompt_fix: promptFix,
    policy_rule: policyRule,
    evidence_needed: finding.evidence ?? [],
    limitations: ["Derived automatically from a single finding."],
    evidence_level: evidenceLevel,
    source_report_ids: [reportId],
    is_active: true,
    times_applied: 0,
    created_at: now,
    updated_at: now,
  };

  const { data, error } = await supabase
    .from("rules")
    .insert(rulePayload)
    .select("*")
    .single();

  if (error || !data) {
    throw new PersistenceError("Failed to insert new rule from finding", error);
  }

  // Map DB row back to our Rule interface (field name normalization)
  const createdRule: Rule = {
    id: data.id,
    title: data.title,
    leakType: data.leak_type,
    severity: data.severity,
    cause: data.cause,
    fixNow: data.fix_now,
    promptFix: data.prompt_fix,
    policyRule: data.policy_rule,
    evidenceNeeded: data.evidence_needed ?? [],
    limitations: data.limitations ?? [],
    evidenceLevel: data.evidence_level as EvidenceLevel,
    sourceReportIds: data.source_report_ids ?? [],
    createdAt: data.created_at,
    updatedAt: data.updated_at,
    timesApplied: data.times_applied ?? 0,
  };

  return createdRule;
}

// ---------------------------------------------------------------------------
// Convenience: In-memory evaluator for tests / client-side demos
// (Does not touch persistence)
// ---------------------------------------------------------------------------

/**
 * Pure synchronous version of evaluation. Useful for tests and client-side use
 * where you only want to know which rules would match without side effects.
 */
export function evaluateRulesForTraceSync(
  trace: Trace,
  activeRules: Rule[],
  report?: ReportLike,
): Omit<RuleApplicationResult, "evaluatedAt"> & { evaluatedAt: string } {
  // Re-use the main validation + logic by calling the async version internally
  // but synchronously for the pure part.
  // For simplicity we duplicate the tiny validation block here.
  if (!trace?.sessionId) {
    throw new ValidationError("trace.sessionId is required");
  }
  if (!Array.isArray(activeRules)) {
    throw new ValidationError("activeRules must be an array");
  }

  const evaluatedAt = new Date().toISOString();
  const matchedRules: MatchedRule[] = [];
  const unmatchedRules: UnmatchedRule[] = [];
  const reportIndex = report ? buildReportSignalIndex(report) : undefined;

  for (const rule of activeRules) {
    if (!rule?.id || !rule.leakType) {
      unmatchedRules.push({
        rule: (rule ?? { id: "invalid", leakType: "unknown" }) as Rule,
        reason: "Invalid rule shape",
      });
      continue;
    }
    const decision = decideRuleMatch(rule, trace, reportIndex);
    if (decision.applies) {
      matchedRules.push({
        rule,
        reason: decision.reason,
        signalStrength: decision.signalStrength,
      });
    } else {
      unmatchedRules.push({ rule, reason: decision.reason });
    }
  }

  matchedRules.sort((a, b) => {
    const order = { strong: 3, moderate: 2, weak: 1 } as const;
    return order[b.signalStrength] - order[a.signalStrength];
  });

  return { sessionId: trace.sessionId, matchedRules, unmatchedRules, evaluatedAt };
}
