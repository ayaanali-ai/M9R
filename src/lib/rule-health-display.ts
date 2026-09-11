/**
 * Rule Health — display helpers (UI copy + presentation policy)
 * ----------------------------------------------------------------------------
 * Pure, IO-free strings and ordering used by RuleHealthPanel. Kept separate from
 * the classifier (rule-health.ts) and from the React component so the exact
 * human-facing copy is unit-testable without rendering, and so the conservative
 * wording (no "guaranteed", "proven success", or "compliant") lives in one place.
 *
 * This module does NOT classify anything — it only describes statuses produced
 * by the classifier. Display only.
 */

import type { RuleHealthStatus } from "@/lib/rule-health";

/** Shown when no loaded rules were evaluated (evaluated:false / none loaded). */
export const RULE_HEALTH_EMPTY_COPY = "No loaded rules were evaluated for this session.";

/** One conservative sentence per status. Never claims a rule "worked"/"passed". */
export const STATUS_COPY: Record<RuleHealthStatus, string> = {
  followed: "Evidence suggests this rule held.",
  violated: "The same pattern recurred while this rule was loaded.",
  not_applicable: "This session did not touch the rule’s behavior.",
  too_vague: "This rule is too broad to evaluate reliably.",
  needs_review: "Evidence is mixed or insufficient.",
  obsolete: "Later evidence suggests this rule may no longer apply.",
};

/** Short badge label per status. */
export const STATUS_LABEL: Record<RuleHealthStatus, string> = {
  followed: "Followed",
  violated: "Violated",
  not_applicable: "Not applicable",
  too_vague: "Too vague",
  needs_review: "Needs review",
  obsolete: "Obsolete",
};

export type StatusTone = "good" | "bad" | "warn" | "neutral";

/** Visual tone per status. Only `followed` is "good" — and only conservatively. */
export const STATUS_TONE: Record<RuleHealthStatus, StatusTone> = {
  followed: "good",
  violated: "bad",
  not_applicable: "neutral",
  too_vague: "warn",
  needs_review: "warn",
  obsolete: "neutral",
};

/** Stable display order for both the summary chips and the item list. */
export const STATUS_ORDER: RuleHealthStatus[] = [
  "followed",
  "violated",
  "needs_review",
  "not_applicable",
  "too_vague",
  "obsolete",
];

/** Tailwind classes per tone for badges/chips. */
export const TONE_CHIP: Record<StatusTone, string> = {
  good: "border-emerald-400/20 bg-emerald-400/[0.07] text-emerald-200",
  bad: "border-red-400/20 bg-red-400/[0.07] text-red-200",
  warn: "border-amber-400/20 bg-amber-400/[0.07] text-amber-200",
  neutral: "border-white/[0.08] bg-white/[0.035] text-zinc-400",
};

/** Evidence-level chip tones (Observed / Inferred / Insufficient). */
export const EVIDENCE_CHIP: Record<string, string> = {
  Observed: "border-sky-400/20 bg-sky-400/[0.07] text-sky-200",
  Inferred: "border-amber-400/20 bg-amber-400/[0.07] text-amber-200",
  Insufficient: "border-white/[0.08] bg-white/[0.035] text-zinc-400",
};

export function evidenceChipClass(level: string): string {
  return EVIDENCE_CHIP[level] ?? EVIDENCE_CHIP.Insufficient;
}
