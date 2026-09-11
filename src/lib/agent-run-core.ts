/**
 * Agent Run — pure core (validation, redaction, two-run proof shaping)
 * ----------------------------------------------------------------------------
 * IO-free logic for the Agent Dashboard + Two-Run Rule Proof loop. Kept separate
 * from the DB service (agent-run-service.ts), the API routes, and the React UI so
 * the security-critical and copy-critical pieces are unit-testable without a
 * database or a browser.
 *
 * Two invariants live here and are tested directly:
 *   1. Run events carry status/provenance ONLY. `redactRunEvent` strips tokens,
 *      setup codes, claim URLs, `.oathlock/local.json`, and anything that looks
 *      like source code. There is no path for raw content into a run event.
 *   2. Two-run proof copy is conservative. It never says a rule "worked",
 *      "proved" anything, "saved" money, "fixed" the agent, or "passed
 *      compliance". `assertConservative` and the forbidden-phrase list enforce it.
 */

import type { RuleHealthStatus } from "@/lib/rule-health";

// ---------------------------------------------------------------------------
// Run status + phase
// ---------------------------------------------------------------------------

/**
 * Raw, CLI-settable run status. Deliberately coarse: the CLI only knows a
 * free-text phase string, never whether evidence was recorded or a human made
 * a review decision — those live server-side (see deriveRunDisplayState in
 * agent-workspace-data.ts, which layers the fuller spec vocabulary — waiting_for
 * _evidence, evidence_ready, waiting_for_approval, reviewed, needs_follow_up,
 * not_accepted, revoked, stale — on top of real evidence/passport/review rows
 * rather than trying to encode it all in one CLI-asserted enum).
 */
export const RUN_STATUSES = [
  "started",
  "working",
  "blocked",
  "waiting_for_human",
  "submitted",
  "completed",
  "failed",
  "expired",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export function isRunStatus(value: unknown): value is RunStatus {
  return typeof value === "string" && (RUN_STATUSES as readonly string[]).includes(value);
}

/**
 * Normalize a free-text phase from the CLI into a status + a short label.
 * The CLI lets a human/agent type any phase (e.g. "reading files"); we map the
 * common phrases to a canonical status and otherwise keep the run "working".
 */
export function statusForPhase(phase: string | undefined | null): RunStatus {
  const p = (phase ?? "").toLowerCase();
  if (!p.trim()) return "working";
  if (/block/.test(p)) return "blocked";
  if (/wait|approv/.test(p)) return "waiting_for_human";
  if (/submit/.test(p)) return "submitted";
  if (/complete|done|finish/.test(p)) return "completed";
  if (/expire|time.?out|budget/.test(p)) return "expired";
  if (/fail|error|abort/.test(p)) return "failed";
  return "working";
}

// ---------------------------------------------------------------------------
// Event redaction — the security boundary for run telemetry
// ---------------------------------------------------------------------------

const MAX_MESSAGE_LEN = 200;

/** Patterns that must never survive into a stored run event message. */
export const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Scoped agent tokens (oak_…). Match the whole token, not just the prefix.
  [/oak_[A-Za-z0-9._-]+/g, "[redacted-token]"],
  // Bearer headers.
  [/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]"],
  // Claim URLs (…/claim/<id>).
  [/https?:\/\/\S*\/claim\/\S+/gi, "[redacted-claim-url]"],
  // Setup codes if ever echoed.
  [/setup_code[=:]\s*\S+/gi, "setup_code=[redacted]"],
  // The local token file path/contents reference.
  [/\.oathlock[/\\]local\.json/gi, "[redacted-local-state]"],
  // Anything that names a raw token field.
  [/"?token"?\s*[:=]\s*"?[A-Za-z0-9._-]{12,}"?/gi, "token=[redacted]"],
];

/**
 * Heuristic: does this message look like it carries source code rather than a
 * status string? Run events are short status telemetry; multi-line blobs or code
 * punctuation density are rejected outright (we keep only a generic label).
 */
export function looksLikeSourceCode(message: string): boolean {
  if (message.includes("\n")) return true;
  if (/```/.test(message)) return true;
  // Common code tokens that should never appear in a status phrase.
  if (/(function\s|=>|;\s*$|\{\s*$|import\s|export\s|class\s|<\/?[a-z]+>)/.test(message)) return true;
  return false;
}

/**
 * Reduce any caller-supplied message to a safe, short status string. Strips
 * secrets, rejects source-code-looking content (replaced with a generic label),
 * collapses whitespace, and truncates. Never throws.
 */
export function redactRunEvent(message: unknown): string {
  let text = typeof message === "string" ? message : "";
  text = text.replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (looksLikeSourceCode(text)) return "[status update]";
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  if (text.length > MAX_MESSAGE_LEN) text = text.slice(0, MAX_MESSAGE_LEN - 1) + "…";
  return text;
}

/** True when the redacted form is identical to the input (i.e. nothing stripped). */
export function isCleanRunEvent(message: string): boolean {
  return redactRunEvent(message) === message.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Two-run proof — conservative copy
// ---------------------------------------------------------------------------

/** One conservative sentence per Rule Health status, for the proof panel. */
export const TWO_RUN_PROOF_COPY: Record<RuleHealthStatus, string> = {
  followed: "Evidence suggests this rule held in the later run.",
  violated: "The same pattern recurred while this rule was loaded.",
  not_applicable: "The later run did not touch this rule’s behavior.",
  needs_review: "Evidence is mixed or insufficient.",
  too_vague: "This rule is too broad to evaluate reliably.",
  obsolete: "Later evidence suggests this rule may no longer apply.",
};

/**
 * Phrases that would overclaim. The proof copy must contain none of these.
 * "quality improved" / "cost improved" are banned as bare claims — quality and
 * cost may only be described when tied to objective evidence (tests/build/lint/
 * acceptance/human review) or explicit usage metadata, respectively.
 */
export const FORBIDDEN_PROOF_PHRASES: string[] = [
  "proved it worked",
  "proved it",
  "guaranteed improvement",
  "guaranteed",
  "saved cost",
  "saved money",
  "fixed the agent",
  "compliance passed",
  "compliant",
  "the rule worked",
  "quality improved",
  "cost improved",
];

/** Throw if any conservative-copy string contains a forbidden overclaim. */
export function assertConservative(text: string): void {
  const lower = text.toLowerCase();
  for (const phrase of FORBIDDEN_PROOF_PHRASES) {
    if (lower.includes(phrase)) {
      throw new Error(`Overclaiming phrase in proof copy: "${phrase}"`);
    }
  }
}

// ---------------------------------------------------------------------------
// Two-run proof — shaping
// ---------------------------------------------------------------------------

export interface ProofRunRef {
  runId: string;
  taskTitle: string | null;
  rulesLoadedCount: number;
  status: RunStatus;
}

export interface TwoRunProof {
  /** Run A: the baseline/evidence run that produced/promoted the rule. */
  runA: ProofRunRef;
  /** The rule promoted from Run A. */
  rule: { id: string; title: string; ruleType: string };
  /** Run B: a later run where rules_loaded_count > 0. Null until one exists. */
  runB: ProofRunRef | null;
  /** Rule Health status from Run B, or null when no later run evaluated it. */
  health: RuleHealthStatus | null;
  /** Conservative one-line explanation of the result. */
  copy: string;
  /** Whether Rule Health has actually been evaluated by a later run. */
  evaluated: boolean;
}

/** Copy shown before any later run has loaded the rule and submitted evidence. */
export const PROOF_PENDING_COPY =
  "Rule Health appears after a later run loads this active rule and submits evidence.";

/** Valid Rule Health statuses (the keys of the conservative copy map). */
export function isRuleHealthStatus(value: unknown): value is RuleHealthStatus {
  return typeof value === "string" && value in TWO_RUN_PROOF_COPY;
}

export interface EvaluatedRunLike {
  runId: string;
  taskTitle: string | null;
  rulesLoadedCount: number;
  status: RunStatus;
  ruleHealth?: { evaluated?: boolean; items?: Array<{ status: string; title?: string }> } | null;
}

/**
 * Turn a later run (Run B) that evaluated Rule Health into conservative proof
 * entries, one per evaluated rule item, paired with a baseline Run A. Returns []
 * when the run has not evaluated Rule Health (no later run loaded the rule yet).
 */
export function proofsFromRun(runB: EvaluatedRunLike, runA: ProofRunRef): TwoRunProof[] {
  if (!runB.ruleHealth?.evaluated) return [];
  const runBRef: ProofRunRef = {
    runId: runB.runId,
    taskTitle: runB.taskTitle,
    rulesLoadedCount: runB.rulesLoadedCount,
    status: runB.status,
  };
  return (runB.ruleHealth.items ?? [])
    .filter((it) => isRuleHealthStatus(it.status))
    .map((it) =>
      buildTwoRunProof({
        runA,
        rule: { id: `${runB.runId}:${it.title ?? "rule"}`, title: it.title ?? "(rule)", ruleType: "" },
        runB: runBRef,
        health: it.status as RuleHealthStatus,
      }),
    );
}

/**
 * Build the conservative two-run proof view. When no later run has evaluated the
 * rule (no Run B with loaded rules, or no health status), it returns a pending,
 * non-claiming state — never an overclaim.
 */
export function buildTwoRunProof(input: {
  runA: ProofRunRef;
  rule: { id: string; title: string; ruleType: string };
  runB?: ProofRunRef | null;
  health?: RuleHealthStatus | null;
}): TwoRunProof {
  const runB = input.runB ?? null;
  const evaluated = Boolean(runB && runB.rulesLoadedCount > 0 && input.health);
  const health = evaluated ? (input.health as RuleHealthStatus) : null;
  const copy = health ? TWO_RUN_PROOF_COPY[health] : PROOF_PENDING_COPY;
  assertConservative(copy);
  return { runA: input.runA, rule: input.rule, runB, health, copy, evaluated };
}
