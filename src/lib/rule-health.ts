/**
 * Rule Health v0 (M9R)
 * ----------------------------------------------------------------------------
 * When an agent submits a later session AFTER loading M9R workspace rules,
 * this module compares the session's observed findings against the loaded rules
 * and classifies each rule's health. It turns "generate rules once" into "keep
 * agent rules honest over time."
 *
 * Discipline (non-negotiable):
 *  - Evidence-based and conservative. We never mark a rule `followed` without a
 *    positive, relevant signal that is strong enough — absence of a bad finding
 *    is at best `Inferred`, never `Observed`.
 *  - A rule is only `violated` from OBSERVED session findings, never because the
 *    agent self-reported it. Agent-reported followed/violated can never override
 *    contradictory observed evidence; at most they downgrade to needs_review.
 *  - No speculative claims. If we cannot evaluate a rule, we say so
 *    (too_vague / needs_review / not_applicable), we do not guess `followed`.
 *
 * Pure + IO-free so the policy is unit-testable without a DB or network.
 */

export type RuleHealthStatus =
  | "followed"
  | "violated"
  | "not_applicable"
  | "too_vague"
  | "needs_review"
  | "obsolete";

export type RuleHealthEvidenceLevel = "Observed" | "Inferred" | "Insufficient";

/** A rule the agent reports it loaded before doing the work. Shape is lenient. */
export interface LoadedRuleInput {
  id?: string;
  title?: string;
  rule_type?: string;
  ruleType?: string;
  body?: string;
  text?: string;
}

/** A finding detected in the submitted session (subset of the report finding). */
export interface SessionFindingInput {
  type: string;
  title?: string;
  evidenceLevel?: string;
}

/** Coarse activity signals from the parser, used to judge relevance. */
export interface RuleHealthSignals {
  filesEdited?: number;
  commandsDetected?: number;
  turnsDetected?: number;
  parserConfidence?: string;
  /**
   * Extra repeated failing commands (repeat count − 1, summed). Used to tune
   * retry-prevention: a single ordinary failure should not read as a violation.
   */
  repeatedCommandFailures?: number;
  /** Steps that errored (any failure, not necessarily repeated). */
  failedCommands?: number;
}

/** What the agent *claims* — trusted only as a weak, non-overriding hint. */
export interface AgentReportedRules {
  followed?: unknown;
  violated?: unknown;
}

export interface RuleHealthItem {
  rule_id: string;
  title: string;
  status: RuleHealthStatus;
  evidenceLevel: RuleHealthEvidenceLevel;
  reason: string;
  matchedFindingTypes: string[];
}

export interface RuleHealthSummary {
  followed: number;
  violated: number;
  not_applicable: number;
  too_vague: number;
  needs_review: number;
  obsolete: number;
}

export interface RuleHealthReport {
  evaluated: boolean;
  items: RuleHealthItem[];
  summary: RuleHealthSummary;
}

export interface EvaluateRuleHealthInput {
  rulesLoaded: unknown;
  findings: SessionFindingInput[];
  signals?: RuleHealthSignals;
  agentReported?: AgentReportedRules;
}

// ---------------------------------------------------------------------------
// Knowledge: rule types ↔ observable finding types
// ---------------------------------------------------------------------------

/**
 * Map a workspace rule_type to the session finding type(s) that would prove the
 * rule's target behavior recurred. Only these rule types are directly observable
 * from findings; others can't be confirmed/violated from finding data alone.
 */
const RULE_TYPE_TO_FINDING_TYPES: Record<string, string[]> = {
  retry_prevention: ["retry_spiral"],
  edit_thrash_prevention: ["repeated_file_edit"],
  context_control: ["repeated_file_read"],
  cost_control: ["cost_waste"],
  security: ["unusual_model_switch"],
};

/** Rule types we recognize (observable or not). Used to tell "known" from junk. */
const KNOWN_RULE_TYPES = new Set<string>([
  ...Object.keys(RULE_TYPE_TO_FINDING_TYPES),
  "verification",
  "metadata",
  "scope_control",
  "output_quality",
  "project_memory",
]);

/** Short human label per observable rule type, for reason strings. */
const BEHAVIOR_LABEL: Record<string, string> = {
  retry_prevention: "retry-spiral",
  edit_thrash_prevention: "edit-thrash",
  context_control: "repeated-file-read",
  cost_control: "cost-waste",
  security: "unusual model switch",
};

/** Generic platitudes that cannot be evaluated reliably. */
const VAGUE_PATTERNS: RegExp[] = [
  /be (more )?careful/i,
  /clean code/i,
  /good code/i,
  /best practices?/i,
  /follow (good )?conventions?/i,
  /do (a )?better/i,
  /try harder/i,
  /pay attention/i,
  /high[- ]quality/i,
  /write better/i,
];

// ---------------------------------------------------------------------------
// Helpers (pure)
// ---------------------------------------------------------------------------

function clampStr(v: unknown, max = 200): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function looksVague(text: string): boolean {
  return VAGUE_PATTERNS.some((re) => re.test(text));
}

/** Infer a rule type from free text when the rule didn't declare one. */
function inferRuleType(text: string): string | null {
  const t = text.toLowerCase();
  if (/edit/.test(t) && /(thrash|re-?edit|same file|again|twice|churn)/.test(t)) {
    return "edit_thrash_prevention";
  }
  if (/(retry|re-?run|rerun|failing command|failed command|same command)/.test(t)) {
    return "retry_prevention";
  }
  if (/(read .*once|re-?read|context bloat|read the same file)/.test(t)) {
    return "context_control";
  }
  if (/(token|spend|spent|cost)/.test(t)) {
    return "cost_control";
  }
  if (/(model switch|switch model|model-to-model)/.test(t)) {
    return "security";
  }
  if (/(verif|run the .*test|before your final|run the relevant)/.test(t)) {
    return "verification";
  }
  return null;
}

/**
 * Whether the session shows activity relevant to a rule type, so absence of a
 * matching finding can be read as "followed" rather than "untouched".
 *  - true:    relevant activity present
 *  - false:   the session did not touch this behavior at all
 *  - "unknown": we cannot measure relevance for this rule type (be conservative)
 */
function relevanceFor(ruleType: string, s: RuleHealthSignals): boolean | "unknown" {
  switch (ruleType) {
    case "edit_thrash_prevention":
      return (s.filesEdited ?? 0) > 0;
    case "retry_prevention":
    case "cost_control":
      return (s.commandsDetected ?? 0) > 0;
    default:
      // context_control (reads not counted), security, verification, etc.
      return "unknown";
  }
}

function strongFinding(level: string | undefined): boolean {
  return level === "Observed" || level === "Correlated";
}

function asStringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => clampStr(x)).filter(Boolean);
}

/** Did the agent name this rule (by id or title) in its self-report? */
function agentNamed(list: string[], id: string, title: string): boolean {
  const idL = id.toLowerCase();
  const titleL = title.toLowerCase();
  return list.some((x) => {
    const xl = x.toLowerCase();
    return xl === idL || xl === titleL;
  });
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function emptySummary(): RuleHealthSummary {
  return {
    followed: 0,
    violated: 0,
    not_applicable: 0,
    too_vague: 0,
    needs_review: 0,
    obsolete: 0,
  };
}

function evaluateOne(
  loaded: LoadedRuleInput,
  index: number,
  findings: SessionFindingInput[],
  signals: RuleHealthSignals,
  reportedFollowed: string[],
  reportedViolated: string[],
): RuleHealthItem {
  const id = clampStr(loaded.id) || `loaded_rule_${index + 1}`;
  const title = clampStr(loaded.title) || id;
  const bodyText = clampStr(loaded.body ?? loaded.text, 1000);
  const declaredType = clampStr(loaded.rule_type ?? loaded.ruleType).toLowerCase();
  const haystack = `${title} ${bodyText}`.trim();

  const item = (
    status: RuleHealthStatus,
    evidenceLevel: RuleHealthEvidenceLevel,
    reason: string,
    matchedFindingTypes: string[] = [],
  ): RuleHealthItem => ({ rule_id: id, title, status, evidenceLevel, reason, matchedFindingTypes });

  // Resolve a rule type: declared (if recognized) else inferred from text.
  const ruleType =
    declaredType && KNOWN_RULE_TYPES.has(declaredType) ? declaredType : inferRuleType(haystack);

  // too_vague: a platitude, or a rule we cannot map to any evaluable behavior.
  if (looksVague(haystack) || !ruleType) {
    return item(
      "too_vague",
      "Insufficient",
      "Rule is too generic to evaluate reliably against session evidence.",
    );
  }

  const findingTypes = RULE_TYPE_TO_FINDING_TYPES[ruleType] ?? [];
  const reportedSaysViolated = agentNamed(reportedViolated, id, title);
  const reportedSaysFollowed = agentNamed(reportedFollowed, id, title);

  // Not observable from findings (e.g. verification): we can't confirm or refute.
  if (findingTypes.length === 0) {
    return item(
      "needs_review",
      "Insufficient",
      "This rule's behavior is not directly observable from session findings; review manually.",
    );
  }

  // VIOLATED — the target failure pattern recurred despite the rule being loaded.
  // Observed evidence wins over any agent self-report.
  const matched = findings.filter((f) => findingTypes.includes(f.type));
  if (matched.length > 0) {
    const observed = matched.some((f) => strongFinding(f.evidenceLevel));
    const label = BEHAVIOR_LABEL[ruleType] ?? ruleType;

    // Retry-prevention sensitivity guard: a single ordinary failed command is
    // NOT a retry violation. Require GENUINE repetition. When the structured
    // repetition signal is known and shows no repeated failure, that overrides a
    // strong-looking finding (the parser can over-flag a one-shot failure as a
    // spiral). When the repetition signal is unknown, a strong retry_spiral
    // finding is still enough to call a violation.
    if (ruleType === "retry_prevention") {
      const repetitionKnown = signals.repeatedCommandFailures !== undefined;
      const repeatedFailure = (signals.repeatedCommandFailures ?? 0) >= 1;
      const justified = repeatedFailure || (!repetitionKnown && observed);
      if (!justified) {
        return item(
          "needs_review",
          "Inferred",
          `A failing command appeared, but there is no repeated-retry pattern, so this is not a ${label} violation. Review manually.`,
          Array.from(new Set(matched.map((f) => f.type))),
        );
      }
    }

    const note = reportedSaysFollowed
      ? " The agent reported this rule as followed, but observed evidence shows otherwise."
      : "";
    return item(
      "violated",
      observed ? "Observed" : "Inferred",
      `The ${label} pattern recurred in this session even though the rule was loaded.${note}`,
      Array.from(new Set(matched.map((f) => f.type))),
    );
  }

  // No matching finding. Decide between followed / not_applicable / needs_review
  // using relevance + parser strength. Conservative by default.
  const relevance = relevanceFor(ruleType, signals);
  const label = BEHAVIOR_LABEL[ruleType] ?? ruleType;

  if (relevance === false) {
    return item(
      "not_applicable",
      "Insufficient",
      `The session did not touch ${label}-related behavior, so the rule could not be evaluated.`,
    );
  }

  const strongParser = signals.parserConfidence === "high";
  if (relevance === true && strongParser) {
    if (reportedSaysViolated) {
      return item(
        "needs_review",
        "Inferred",
        `No ${label} pattern was observed, but the agent reported a violation. Evidence is mixed; review manually.`,
      );
    }
    return item(
      "followed",
      "Inferred",
      `Relevant ${label} activity occurred with no recurrence of the pattern; the rule appears to have been followed.`,
    );
  }

  // Relevant-but-not-strong, or relevance unknown: insufficient to call followed.
  return item(
    "needs_review",
    "Insufficient",
    `No ${label} pattern was observed, but evidence is not strong enough to confirm the rule was followed.`,
  );
}

/**
 * Evaluate rule health for a submitted session against the rules it loaded.
 * Returns `evaluated: false` with an empty summary when no rules were loaded.
 */
export function evaluateRuleHealth(input: EvaluateRuleHealthInput): RuleHealthReport {
  const loaded: LoadedRuleInput[] = Array.isArray(input.rulesLoaded)
    ? (input.rulesLoaded.filter((r) => r && typeof r === "object") as LoadedRuleInput[])
    : [];

  if (loaded.length === 0) {
    return { evaluated: false, items: [], summary: emptySummary() };
  }

  const findings = Array.isArray(input.findings) ? input.findings : [];
  const signals = input.signals ?? {};
  const reportedFollowed = asStringList(input.agentReported?.followed);
  const reportedViolated = asStringList(input.agentReported?.violated);

  const items = loaded.map((rule, i) =>
    evaluateOne(rule, i, findings, signals, reportedFollowed, reportedViolated),
  );

  const summary = emptySummary();
  for (const it of items) summary[it.status] += 1;

  return { evaluated: true, items, summary };
}

// ---------------------------------------------------------------------------
// Dominant status (the conservative headline across several rules)
// ---------------------------------------------------------------------------

/**
 * Deterministic severity/decisiveness ranking for the headline status. A lower
 * index wins. `violated` leads (any violation is the headline); `followed` beats
 * inconclusive statuses; `not_applicable` is the weakest and only wins when it is
 * the ONLY status present. This replaces any "first item wins" behavior.
 */
export const RULE_HEALTH_DOMINANCE: RuleHealthStatus[] = [
  "violated",
  "followed",
  "needs_review",
  "too_vague",
  "obsolete",
  "not_applicable",
];

/**
 * Pick the dominant (headline) status from a set of evaluated rule statuses,
 * using RULE_HEALTH_DOMINANCE. Returns null for an empty set.
 */
export function dominantRuleHealthStatus(
  statuses: Array<RuleHealthStatus | { status: RuleHealthStatus }>,
): RuleHealthStatus | null {
  const list = statuses.map((s) => (typeof s === "string" ? s : s.status));
  if (list.length === 0) return null;
  for (const candidate of RULE_HEALTH_DOMINANCE) {
    if (list.includes(candidate)) return candidate;
  }
  return list[0];
}
