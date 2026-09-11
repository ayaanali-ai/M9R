/**
 * Rule Deduplication — OathLock v5
 * ----------------------------------------------------------------------------
 * Before rules are shown or exported, collapse ones that address the same agent
 * behavior so the user ends up with a small, high-signal set instead of clutter.
 *
 * Philosophy: more rules are NOT better. When two rules target the same behavior
 * we keep the single best one — the more specific, more enforceable, shorter,
 * less-vague rule, closest to observed evidence — and discard the rest.
 *
 * Conflicts (same behavior, materially different instructions) are not silently
 * dropped: the weaker rule is downgraded to `needs_review` so a human decides,
 * rather than exporting two contradictory rules as active.
 *
 * Pure module (no DOM/IO) → unit-testable.
 */

import type { GeneratedRule, RuleType } from "@/lib/generated-rules";

/**
 * Behavior buckets. Rules whose ruleType maps to the same bucket are candidates
 * for merging (they govern the same class of agent behavior).
 */
const BEHAVIOR_BUCKET: Record<RuleType, string> = {
  retry_prevention: "repeated_failed_commands",
  edit_thrash_prevention: "repeated_file_edits",
  scope_control: "scope_creep",
  verification: "missing_verification",
  context_control: "bloated_context",
  metadata: "missing_metadata",
  cost_control: "cost_waste",
  security: "security_sensitive_actions",
  output_quality: "unclear_summaries",
  project_memory: "project_memory",
};

const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 } as const;

/** The behavior bucket a rule type governs (exported for cross-set matching). */
export function behaviorBucket(ruleType: RuleType): string {
  return BEHAVIOR_BUCKET[ruleType] ?? ruleType;
}

/**
 * Heuristic "quality" score for a rule — higher is better. Rewards specificity,
 * enforceability, and evidence; penalizes vagueness and length.
 */
function ruleScore(rule: GeneratedRule): number {
  let score = 0;

  // Confidence and a concrete source carry the most weight.
  score += CONFIDENCE_RANK[rule.confidence] * 3;
  if (rule.sourceFindingId) score += 2;
  if (rule.evidenceSummary && rule.evidenceSummary.trim().length > 0) score += 1;

  const body = rule.body.toLowerCase();

  // Reward enforceable, specific phrasing (conditions + concrete nouns).
  if (/\b(after|before|if|when|unless)\b/.test(body)) score += 2; // conditional → checkable
  if (/\b(twice|once|two|first|exact|same)\b/.test(body)) score += 1; // specific quantities
  if (/\b(command|file|test|build|token|model|scope|metadata)\b/.test(body)) score += 1;

  // Penalize vagueness — the hallmark of useless rules.
  if (/\b(be careful|clean code|best pract'? s?|avoid mistakes|think step|properly|appropriately)\b/.test(body)) {
    score -= 4;
  }

  // Prefer shorter rules among otherwise-equal ones (easier to follow).
  if (body.length <= 220) score += 1;
  if (body.length > 400) score -= 1;

  return score;
}

/** Two rules "conflict" if same bucket but their core instruction differs a lot. */
function rulesConflict(a: GeneratedRule, b: GeneratedRule): boolean {
  // Same canonical body → not a conflict, just a duplicate.
  const na = a.body.trim().toLowerCase();
  const nb = b.body.trim().toLowerCase();
  if (na === nb) return false;
  // Different ruleType inside the same bucket is rare; treat clearly different
  // bodies (low token overlap) as a conflict worth human review.
  return tokenOverlap(na, nb) < 0.4;
}

/**
 * Similarity of two rule bodies as a behavior signal, 0..1. Combines word
 * overlap with a small bonus when both clearly target the same concrete noun
 * (command/file/test/etc.). Exported so workspace matching never relies on
 * fragile exact-string comparison.
 */
export function bodySimilarity(a: string, b: string): number {
  return tokenOverlap(a.trim().toLowerCase(), b.trim().toLowerCase());
}

/** Jaccard-ish overlap of word sets, 0..1. */
function tokenOverlap(a: string, b: string): number {
  const sa = new Set(a.split(/\W+/).filter((w) => w.length > 3));
  const sb = new Set(b.split(/\W+/).filter((w) => w.length > 3));
  if (sa.size === 0 || sb.size === 0) return 0;
  let shared = 0;
  for (const w of sa) if (sb.has(w)) shared += 1;
  return shared / Math.min(sa.size, sb.size);
}

export interface DedupeResult {
  /** The kept, de-duplicated rules (best-of each behavior bucket). */
  rules: GeneratedRule[];
  /** How many rules were merged away. */
  mergedCount: number;
  /** Rules downgraded to needs_review because they conflicted with a kept rule. */
  conflicts: GeneratedRule[];
}

/**
 * De-duplicate generated rules. For each behavior bucket we keep the highest-
 * scoring rule; lower-scoring duplicates are dropped, and genuinely conflicting
 * rules are surfaced as `needs_review` rather than silently exported.
 */
export function dedupeRules(input: GeneratedRule[]): DedupeResult {
  const byBucket = new Map<string, GeneratedRule[]>();
  for (const rule of input) {
    const bucket = BEHAVIOR_BUCKET[rule.ruleType] ?? rule.ruleType;
    const list = byBucket.get(bucket) ?? [];
    list.push(rule);
    byBucket.set(bucket, list);
  }

  const kept: GeneratedRule[] = [];
  const conflicts: GeneratedRule[] = [];
  let mergedCount = 0;

  for (const list of byBucket.values()) {
    if (list.length === 1) {
      kept.push(list[0]);
      continue;
    }

    // Winner = highest score; ties broken by shorter body.
    const ranked = [...list].sort(
      (a, b) => ruleScore(b) - ruleScore(a) || a.body.length - b.body.length,
    );
    const winner = ranked[0];
    kept.push(winner);

    for (const loser of ranked.slice(1)) {
      if (rulesConflict(winner, loser)) {
        // Keep the conflicting rule visible, but flagged for human review.
        conflicts.push({ ...loser, status: "needs_review" });
      } else {
        mergedCount += 1; // a true duplicate — merged away
      }
    }
  }

  // Stable, useful ordering for display/export: status then confidence.
  const statusRank = { active: 4, needs_review: 3, low_confidence: 2, retired: 1 } as const;
  const all = [...kept, ...conflicts].sort(
    (a, b) =>
      statusRank[b.status] - statusRank[a.status] ||
      CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence],
  );

  return { rules: all, mergedCount, conflicts };
}
