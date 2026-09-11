/**
 * Workspace Rule Matching — OathLock v5.1
 * ----------------------------------------------------------------------------
 * Pure logic for the persistent-rules layer: decide how a freshly generated rule
 * relates to the rules already in a workspace, and what promoting it should do.
 *
 * This is what makes OathLock a *living rules system* instead of a per-report
 * export tool — and it must be honest:
 *  - A similar active rule is updated (last seen, times seen), never duplicated.
 *  - A retired rule that reappears is flagged for review, NEVER silently
 *    reactivated.
 *  - Matching uses ruleType + behavior bucket + body similarity, not fragile
 *    exact-string equality.
 *
 * Pure module (no DOM/IO) → fully unit-testable.
 */

import type { GeneratedRule, RuleType, RuleConfidence, RuleStatus } from "@/lib/generated-rules";
import { behaviorBucket, bodySimilarity } from "@/lib/rule-deduplication";

/** A rule persisted in a workspace (camelCase mirror of the DB row). */
export interface WorkspaceRule {
  id: string;
  workspaceId: string;
  sourceReportId: string | null;
  sourceSessionName: string | null;
  title: string;
  body: string;
  ruleType: RuleType;
  confidence: RuleConfidence;
  status: RuleStatus;
  evidenceSummary: string;
  sourceFindingId: string | null;
  expectedPrevention: string;
  /** The condition under which this rule applies (e.g. a Finding's
   * applicableEnvironment, carried through at promotion) -- null for rules
   * with no recorded scope, meaning "no narrower condition was ever set,"
   * never fabricated as "always applies." */
  scopeCondition: string | null;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string | null;
  promotedAt: string | null;
  retiredAt: string | null;
  timesSeen: number;
  timesExported: number;
  timesHelped: number;
  notes: string | null;
  createdBy: string | null;
}

/** How a generated rule relates to what's already in the workspace. */
export type PromotionMatchStatus =
  | "new" //               no similar rule exists → will be created
  | "exists_active" //     a similar active/needs_review rule exists → will be updated
  | "retired_reappeared"; // a similar RETIRED rule exists → flag for review, never auto-reactivate

export interface PromotionMatch {
  status: PromotionMatchStatus;
  /** The existing workspace rule we matched, if any. */
  existing: WorkspaceRule | null;
}

const CONFIDENCE_RANK: Record<RuleConfidence, number> = { high: 3, medium: 2, low: 1 };

/**
 * Are two rules about the same agent behavior? Requires the same behavior bucket
 * AND a meaningful body overlap, so unrelated rules in the same bucket don't
 * collapse, and reworded rules for the same issue still match.
 */
export function rulesMatch(a: { ruleType: RuleType; body: string }, b: { ruleType: RuleType; body: string }): boolean {
  if (behaviorBucket(a.ruleType) !== behaviorBucket(b.ruleType)) return false;
  // Same bucket is already a strong signal; require modest body overlap to be safe.
  return bodySimilarity(a.body, b.body) >= 0.3;
}

/** Find the best existing match for a generated rule (active/review preferred over retired). */
function findMatch(generated: GeneratedRule, workspace: WorkspaceRule[]): WorkspaceRule | null {
  const candidates = workspace.filter((w) => rulesMatch(generated, w));
  if (candidates.length === 0) return null;
  // Prefer a live rule (active/needs_review/low_confidence) over a retired one,
  // then the most-recently-seen.
  const livePriority = (s: RuleStatus) => (s === "retired" ? 0 : 1);
  return [...candidates].sort(
    (x, y) =>
      livePriority(y.status) - livePriority(x.status) ||
      (y.lastSeenAt ?? "").localeCompare(x.lastSeenAt ?? ""),
  )[0];
}

/** Classify a single generated rule against the current workspace rules. */
export function classifyForPromotion(
  generated: GeneratedRule,
  workspace: WorkspaceRule[],
): PromotionMatch {
  const existing = findMatch(generated, workspace);
  if (!existing) return { status: "new", existing: null };
  if (existing.status === "retired") return { status: "retired_reappeared", existing };
  return { status: "exists_active", existing };
}

/** A concrete action the service should take when promoting a generated rule. */
export type PromotionAction =
  | { kind: "create"; rule: GeneratedRule }
  | {
      kind: "update";
      id: string;
      // Patch applied to an existing live rule (seen again this session).
      patch: {
        lastSeenAt: string;
        timesSeen: number;
        evidenceSummary?: string; // only when the new evidence is stronger
      };
    }
  | {
      kind: "flag_retired";
      id: string;
      // A retired pattern reappeared → surface for review, never auto-reactivate.
      patch: { status: "needs_review"; notes: string; lastSeenAt: string; timesSeen: number };
    };

/**
 * Decide what promoting a set of generated rules should do against the existing
 * workspace, at a given timestamp. Deterministic and side-effect free — the
 * service simply executes the returned actions.
 */
export function planPromotion(
  generated: GeneratedRule[],
  workspace: WorkspaceRule[],
  now: string = new Date().toISOString(),
): PromotionAction[] {
  return generated.map((rule) => {
    const { status, existing } = classifyForPromotion(rule, workspace);

    if (status === "new" || !existing) {
      return { kind: "create", rule };
    }

    if (status === "retired_reappeared") {
      return {
        kind: "flag_retired",
        id: existing.id,
        patch: {
          status: "needs_review",
          notes: "Retired rule pattern reappeared in a later session — review whether it should remain retired.",
          lastSeenAt: now,
          timesSeen: existing.timesSeen + 1,
        },
      };
    }

    // exists_active → update last-seen + times-seen, and improve the evidence
    // summary only when the new generation carries stronger evidence.
    const stronger = CONFIDENCE_RANK[rule.confidence] > CONFIDENCE_RANK[existing.confidence];
    return {
      kind: "update",
      id: existing.id,
      patch: {
        lastSeenAt: now,
        timesSeen: existing.timesSeen + 1,
        ...(stronger && rule.evidenceSummary ? { evidenceSummary: rule.evidenceSummary } : {}),
      },
    };
  });
}

/** Human label per match status (UI badges). */
export const MATCH_STATUS_LABELS: Record<PromotionMatchStatus | "promoted", string> = {
  new: "New",
  exists_active: "Already in workspace",
  retired_reappeared: "Retired rule reappeared",
  promoted: "Promoted",
};
