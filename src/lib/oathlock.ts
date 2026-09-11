/**
 * OathLock — Phase 1 Core Domain Types
 *
 * These are the canonical, well-documented interfaces for the early-stage
 * OathLock forensic analysis product. They prioritize clarity and honesty:
 * - Unknowns stay unknown (null/undefined, never fabricated).
 * - Every substantive claim carries an EvidenceLevel.
 * - Types are intentionally minimal and realistic for an early product.
 *
 * Claim discipline (non-negotiable):
 * - Never invent token counts, costs, model identities, or outcomes.
 * - A field is null when the source trace does not provide it.
 * - Detectors and reports must label evidence strength explicitly.
 */

// ---------------------------------------------------------------------------
// EvidenceLevel — the strength of support for any forensic claim.
// ---------------------------------------------------------------------------

/**
 * EvidenceLevel describes how strongly a statement is supported by the trace.
 *
 * - Claimed:     Asserted by the agent, a tool, or a human note, but not
 *                independently verified from raw execution data.
 * - Observed:    Directly present in the trace (e.g. a model name was recorded
 *                on a call, a file path appears in a read event).
 * - Correlated:  Multiple independent signals in the trace line up to support
 *                the claim (e.g. repeated identical file reads + rising token
 *                counts + same step pattern).
 * - Unprovable:  The claim cannot be established from the trace. This includes
 *                both "we have no data" and "the data we have is insufficient".
 *
 * Use this label on every material finding, waste attribution, or security note.
 */
export type EvidenceLevel = "Claimed" | "Observed" | "Correlated" | "Unprovable";

// ---------------------------------------------------------------------------
// Trace — raw agent execution data as captured from an AI agent run.
// This is the untrusted input to forensic analysis.
// ---------------------------------------------------------------------------

/**
 * A single step in a raw agent execution trace.
 *
 * Steps are the atomic recorded events. They may represent model calls,
 * tool invocations, file operations, shell commands, retries, or human
 * interventions. Many fields will be absent (null) on early-stage traces.
 */
export interface TraceStep {
  /** Monotonic index of the step within the run (1-based recommended). */
  step: number;

  /** ISO-8601 timestamp when the step was recorded, if available. */
  timestamp?: string | null;

  /**
   * Logical actor that produced or initiated the step.
   * "agent" is the most common for autonomous runs.
   */
  actor?: "human" | "agent" | "model" | "tool" | null;

  /** Model identifier reported for this step (e.g. "claude-3-5-sonnet"). */
  model?: string | null;

  /** Name of the tool invoked, if any (e.g. "read_file", "bash"). */
  tool?: string | null;

  /** Human-readable summary of the tool input (never raw secrets). */
  toolInputSummary?: string | null;

  /** Human-readable summary of the tool output or result. */
  toolOutputSummary?: string | null;

  /**
   * Files the agent read during this step.
   * Paths should be relative when possible; absolute paths are acceptable.
   */
  filesRead?: string[];

  /**
   * Files the agent wrote or modified during this step.
   */
  filesWritten?: string[];

  /**
   * Shell / terminal commands executed in this step.
   * Store the command text only; do not store full environment.
   */
  shellCommands?: string[];

  /** Any error or failure messages surfaced at this step. */
  errors?: string[];

  /**
   * Number of times this logical action was retried before moving on.
   * 0 means no retries were observed for this step.
   */
  retries?: number;

  /**
   * Token usage reported by the provider for this specific step.
   * When absent, both input and output must be null.
   */
  tokenUsage?: {
    input: number | null;
    output: number | null;
    total: number | null;
  } | null;

  /**
   * Estimated cost in USD for this step, if the provider or recorder
   * supplied a value. Never derived by multiplying tokens by a guess.
   */
  estimatedCostUsd?: number | null;

  /**
   * Keys or categories of metadata known to be missing for this step.
   * Example: ["token_usage", "model_version"].
   */
  missingMetadata?: string[];
}

/**
 * Trace represents the raw execution record of an autonomous AI agent run.
 *
 * This is the primary input to BlackboxReport generation. It is intentionally
 * permissive: real agent frameworks emit very different shapes. Normalizers
 * and adapters map concrete formats onto this interface.
 *
 * Important:
 * - All numeric measurements (tokens, cost) are null unless explicitly present.
 * - No fields are invented during import or normalization.
 * - The schema/version is advisory; consumers must validate content.
 */
export interface Trace {
  /** Optional schema identifier (e.g. "oathlock.trace.v0"). */
  schema?: string;

  /**
   * Distinguishes curated "clean" examples from real-world "messy" traces.
   * Purely descriptive; does not affect analysis semantics.
   */
  variant?: "clean" | "messy" | null;

  /** Free-text note describing where the trace came from. */
  provenance?: string | null;

  /** Stable identifier for this specific agent run/session. */
  sessionId: string;

  /** Short description of what the agent was asked to accomplish. */
  taskSummary: string;

  /** ISO-8601 start time of the run, if recorded. */
  startedAt?: string | null;

  /** ISO-8601 end time of the run, if recorded. */
  endedAt?: string | null;

  /** Distinct actor kinds observed anywhere in the trace. */
  actorsObserved?: string[];

  /** The ordered list of raw execution steps. */
  steps: TraceStep[];

  /** Aggregate counts derived only from fields present in steps. */
  totals?: {
    steps: number;
    failedCommands: number;
    retries: number;

    /**
     * Summed token usage across all steps that reported it.
     * Null when no step reported token usage.
     */
    tokenUsage?: {
      input: number;
      output: number;
      total: number;
    } | null;

    /**
     * Summed cost across steps that reported estimatedCostUsd.
     * Null when no step reported cost.
     */
    estimatedCostUsd?: number | null;
  };

  /**
   * Categories of metadata that were globally absent from the entire trace.
   * Example: ["token_usage", "estimated_cost_usd"].
   */
  missingMetadataGlobal?: string[];

  /**
   * Indicates whether the trace has been processed for PII/secret removal.
   */
  anonymization?: {
    applied: boolean;
    notes: string[];
  };

  /**
   * How this session was ingested: detected input format, source agent, and an
   * honest source-quality score, plus what was/wasn't extracted. Populated by
   * the raw-session normalizer; absent for legacy/structured-only paths.
   */
  inputProfile?: InputProfile;
}

/**
 * Honest description of how a session entered OathLock — shown at the top of the
 * Blackbox Report and used to gate workspace-rule generation.
 */
export interface InputProfile {
  format: string;
  formatLabel: string;
  source: string;
  sourceLabel: string;
  sourceQuality: "strong" | "medium" | "limited" | "insufficient";
  sourceQualityLabel: string;
  /** What OathLock extracted from this input. */
  extracted: string[];
  /** What OathLock could not extract or safely claim. */
  unavailable: string[];
  /** Honest reasons for the format/source/quality classification. */
  reasons: string[];
}

// ---------------------------------------------------------------------------
// BlackboxReport — the primary forensic analysis output.
// ---------------------------------------------------------------------------

/**
 * A summary of the run suitable for a human auditor or dashboard.
 */
export interface BlackboxRunSummary {
  task: string;
  sessionId: string;
  steps: number;
  failedCommands: number;
  retries: number;
  actors: string[];
}

/**
 * Quantified waste (tokens or cost) with an explicit "known vs unknown" flag.
 *
 * When `known` is false, `value` must be null and the note must explain why.
 * OathLock never fabricates waste numbers.
 */
export interface WasteEstimate {
  known: boolean;
  value: number | null;
  note: string;
}

/**
 * BlackboxReport is the canonical forensic postmortem for a single agent run.
 *
 * It is produced by feeding a Trace through detectors. The report must:
 * - State the most likely failure mode based on evidence.
 * - Report waste only from measured usage that actually exists in the trace.
 * - Label every finding with an EvidenceLevel.
 * - Never promise savings or future behavior.
 */
export interface BlackboxReport {
  /** The normalized shape the input trace was recognized as. */
  format: string;

  runSummary: BlackboxRunSummary;

  /**
   * Human-readable classification of the dominant failure pattern observed.
   * Example: "Retry spiral", "Repeated context", "No waste pattern detected".
   */
  failureType: string;

  /**
   * One or two sentences explaining the failure classification.
   * Must be grounded in the trace; "unknown" is acceptable.
   */
  failureSummary: string;

  /** Token waste attributed from steps that carried usage metadata. */
  tokenWaste: WasteEstimate;

  /** Cost waste (USD) attributed from steps that carried cost metadata. */
  costWaste: WasteEstimate;

  /**
   * Detector findings in descending order of severity.
   * Each finding must carry its own evidence and prevention suggestions.
   */
  findings: Array<{
    id: string;
    type: string;
    title: string;
    severity: "low" | "medium" | "high";
    summary: string;

    /** Raw evidence snippets pulled from the trace. */
    evidence: string[];

    /** Which fields or step characteristics were implicated. */
    affectedFields: string[];

    /** Concrete actions that would have prevented or mitigated this pattern. */
    preventionPlan: string[];

    /**
     * How strongly the finding is supported.
     * Must be one of the four canonical EvidenceLevel values.
     */
    evidenceLevel: EvidenceLevel;

    confidence: "low" | "medium" | "high";
  }>;

  /**
   * The single highest-priority next action recommended to the operator.
   * Derived from the top finding's first prevention step, or null.
   */
  fixFirst: string | null;

  /**
   * De-duplicated, prioritized list of prevention steps across all findings.
   */
  preventionPlan: string[];

  /** Count of findings whose severity is "high". */
  highSeverityCount: number;

  /** When the report was generated (ISO-8601). */
  generatedAt?: string;
}

// ---------------------------------------------------------------------------
// Rule — a persistent, reusable improvement derived from one or more reports.
// ---------------------------------------------------------------------------

/**
 * Rule captures a durable, actionable lesson extracted from forensic analysis.
 *
 * Rules are the bridge between one-off Blackbox Reports and long-term
 * improvement. A Rule may be:
 * - Applied manually by engineers ("remember to...").
 * - Fed into advisory policy checks.
 * - Eventually used for automated prevention (future).
 *
 * Rules are created from reports; they are not invented in a vacuum.
 */
export interface Rule {
  /** Stable identifier for the rule. */
  id: string;

  /** Short, human-readable title. */
  title: string;

  /**
   * The class of waste or risk this rule addresses.
   * Should align with detector types or finding categories.
   */
  leakType: string;

  /**
   * Severity the rule is intended to address when violated.
   */
  severity: "low" | "medium" | "high";

  /**
   * Concise statement of the underlying cause observed in traces.
   */
  cause: string;

  /**
   * Immediate action an operator or agent should take.
   */
  fixNow: string;

  /**
   * A suggested prompt or instruction change that would help an agent
   * avoid the pattern.
   */
  promptFix: string;

  /**
   * A declarative policy statement (suitable for advisory checks or
   * future enforcement).
   */
  policyRule: string;

  /**
   * What concrete evidence a trace must contain for this rule to be
   * reliably evaluated. Used for honesty about detection limits.
   */
  evidenceNeeded: string[];

  /**
   * Known limitations of the rule. Never omit.
   */
  limitations: string[];

  /**
   * Evidence level of the report(s) that originally motivated this rule.
   * A rule derived from weak evidence should carry a weak EvidenceLevel.
   */
  evidenceLevel: EvidenceLevel;

  /**
   * Trace or report identifiers that contributed to the creation of this rule.
   * Used for auditability and to avoid orphaned rules.
   */
  sourceReportIds: string[];

  /** ISO-8601 time when the rule was created or last updated. */
  createdAt: string;

  /** ISO-8601 time when the rule was last modified, if different from created. */
  updatedAt?: string;
}

// ---------------------------------------------------------------------------
// ModelHandoff — MTM (model-to-model) transition signal.
// ---------------------------------------------------------------------------

/**
 * ModelHandoff records a transition from one model invocation to another
 * within the same agent run.
 *
 * MTM signals are important for:
 * - Understanding planner → executor patterns.
 * - Detecting expensive model used for trivial follow-ups.
 * - Correlating context size and cost across model switches.
 *
 * A handoff is "observed" only when the trace explicitly records two distinct
 * model calls in sequence with a plausible continuation relationship.
 */
export interface ModelHandoff {
  /** Identifier for this handoff event (unique within the trace). */
  id: string;

  /**
   * The step index (or step id) of the source model call.
   */
  fromStep: number;

  /**
   * The model name or identifier used for the source call.
   */
  fromModel: string | null;

  /**
   * The step index of the destination model call.
   */
  toStep: number;

  /**
   * The model name or identifier used for the destination call.
   */
  toModel: string | null;

  /**
   * How the handoff was detected.
   * - "explicit" : the trace recorded a distinct "next model" or "handoff" marker.
   * - "sequential" : two model calls occurred in immediate succession with
   *                  no intervening human/tool decision recorded.
   * - "inferred" : heuristic (e.g. output of one becomes input of next).
   */
  detection: "explicit" | "sequential" | "inferred";

  /**
   * Strength of evidence that a deliberate handoff occurred.
   */
  evidenceLevel: EvidenceLevel;

  /**
   * Approximate token context carried forward, if measurable.
   * Null when not recorded.
   */
  contextCarriedTokens?: number | null;

  /**
   * Free-text note explaining the purpose or trigger of the handoff
   * (e.g. "planner → code generator", "escalation after failure").
   */
  note?: string | null;
}

// ---------------------------------------------------------------------------
// SecuritySignal — security-relevant observations extracted from a trace.
// ---------------------------------------------------------------------------

/**
 * Category of security signal. Keep this list small and realistic for Phase 1.
 */
export type SecuritySignalKind =
  | "secret_in_output"
  | "prompt_injection_risk"
  | "excessive_privilege"
  | "policy_violation"
  | "unusual_model_switch"
  | "sensitive_data_access"
  // --- MTM (model-to-model) signals — see lib/mtm-signals.ts ---------------
  | "high_volume_queries"
  | "possible_distillation"
  | "missing_credentials"
  | "other";

/**
 * SecuritySignal represents a single noteworthy security or safety observation
 * derived from the trace.
 *
 * Phase 1 signals are conservative. We only emit a signal when the trace
 * contains concrete structural or textual evidence. We do not perform deep
 * semantic analysis or claim to "detect attacks".
 */
export interface SecuritySignal {
  /** Stable id within the scope of one analysis run. */
  id: string;

  kind: SecuritySignalKind;

  /** Short human title for the signal. */
  title: string;

  /**
   * One-sentence description of what was observed.
   * Must be directly supported by trace content.
   */
  description: string;

  /**
   * The EvidenceLevel for this signal. Most early signals will be
   * "Observed" or "Claimed".
   */
  evidenceLevel: EvidenceLevel;

  /**
   * Step indices or step identifiers where the signal was triggered.
   */
  affectedSteps: number[];

  /**
   * Concrete evidence fragments (redacted where appropriate).
   */
  evidence: string[];

  /**
   * Recommended immediate mitigation or follow-up.
   * Keep specific and actionable.
   */
  recommendedAction: string;

  /**
   * Severity from an operational response perspective.
   * "high" does not mean "we are certain an attack happened".
   */
  severity: "low" | "medium" | "high";

  /**
   * True if the signal was generated from a heuristic that is known
   * to produce false positives (document in limitations).
   */
  heuristic: boolean;
}

// ---------------------------------------------------------------------------
// Convenience re-exports for consumers who want the full set.
// ---------------------------------------------------------------------------

export type {
  // All primary types are already exported above via their declarations.
};
