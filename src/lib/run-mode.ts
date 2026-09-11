/**
 * Run Mode — OathLock V2 Phase 6 (coordination policy + budget)
 * ----------------------------------------------------------------------------
 * Bounds how much cross-agent coordination a Run is allowed. Pure/IO-free:
 * defaults + a budget check function. The actual enforcement call site is
 * Phase 8 (Bounded Assistance) — help/check requests are checked against
 * this budget before they're allowed to publish.
 */

export const RUN_MODES = ["solo", "coordinated", "assurance", "collaborative"] as const;
export type RunMode = (typeof RUN_MODES)[number];

export function isRunMode(value: unknown): value is RunMode {
  return typeof value === "string" && (RUN_MODES as readonly string[]).includes(value);
}

export interface CoordinationPolicy {
  mode: RunMode;
  maxSupportingAgents: number;
  maxRequests: number;
  maxDelegationDepth: number;
  maxBriefCharacters: number;
  maxEstimatedTokensPerRequest: number | null;
  requiresHumanApprovalAbove: number | null;
  /** Gate 8: hard wall-clock ceiling for one run, regardless of mode. Not a token/spend budget — those are separate, unmeasured concerns (see efficiency-metrics.ts). */
  maxRunDurationMs: number;
}

/** 6 hours: generous enough not to interrupt real work, but a run cannot silently run forever. */
const DEFAULT_MAX_RUN_DURATION_MS = 6 * 60 * 60_000;

/** Solo is the default: zero coordination, zero additional model calls through OathLock. */
export const SOLO_POLICY: CoordinationPolicy = {
  mode: "solo",
  maxSupportingAgents: 0,
  maxRequests: 0,
  maxDelegationDepth: 0,
  maxBriefCharacters: 4000,
  maxEstimatedTokensPerRequest: null,
  requiresHumanApprovalAbove: null,
  maxRunDurationMs: DEFAULT_MAX_RUN_DURATION_MS,
};

/** One bounded complementary contribution — platform-specific repro, docs research, a focused test. */
export const COORDINATED_POLICY: CoordinationPolicy = {
  mode: "coordinated",
  maxSupportingAgents: 1,
  maxRequests: 1,
  maxDelegationDepth: 1,
  maxBriefCharacters: 4000,
  // Raised from 20k: a bounded assignment's fixed overhead (system prompt,
  // loaded skills/MCP context) alone commonly runs ~20k tokens before any
  // real work happens, so 20k rejected nearly every real dispatch as
  // over-budget regardless of task size. 60k still bounds spend -- it's
  // sized to the provider's real floor, not made unlimited.
  maxEstimatedTokensPerRequest: 60_000,
  requiresHumanApprovalAbove: null,
  maxRunDurationMs: DEFAULT_MAX_RUN_DURATION_MS,
};

/**
 * Independent review of sensitive work — verification-only scope, one request.
 * maxDelegationDepth is 1, not 0: this is the ROOT run's own budget, and
 * issuing its one allowed request creates a depth-1 supporting run. That
 * supporting run cannot delegate further — its OWN policy is what enforces
 * depth 0, not the root run's ability to make its single request at all.
 */
export const ASSURANCE_POLICY: CoordinationPolicy = {
  mode: "assurance",
  maxSupportingAgents: 1,
  maxRequests: 1,
  maxDelegationDepth: 1,
  maxBriefCharacters: 4000,
  // Raised from 20k: a bounded assignment's fixed overhead (system prompt,
  // loaded skills/MCP context) alone commonly runs ~20k tokens before any
  // real work happens, so 20k rejected nearly every real dispatch as
  // over-budget regardless of task size. 60k still bounds spend -- it's
  // sized to the provider's real floor, not made unlimited.
  maxEstimatedTokensPerRequest: 60_000,
  requiresHumanApprovalAbove: 0,
  maxRunDurationMs: DEFAULT_MAX_RUN_DURATION_MS,
};

/**
 * Human-selected sustained collaboration. The primary agent may issue several
 * bounded assignments, but supporting agents still cannot recursively
 * delegate and each request remains subject to the value, scope, token, and
 * latency gates. This is a larger allowance, never an unbounded swarm.
 */
export const COLLABORATIVE_POLICY: CoordinationPolicy = {
  mode: "collaborative",
  maxSupportingAgents: 2,
  maxRequests: 6,
  maxDelegationDepth: 1,
  maxBriefCharacters: 4000,
  // Raised from 20k: a bounded assignment's fixed overhead (system prompt,
  // loaded skills/MCP context) alone commonly runs ~20k tokens before any
  // real work happens, so 20k rejected nearly every real dispatch as
  // over-budget regardless of task size. 60k still bounds spend -- it's
  // sized to the provider's real floor, not made unlimited.
  maxEstimatedTokensPerRequest: 60_000,
  requiresHumanApprovalAbove: 40_000,
  maxRunDurationMs: DEFAULT_MAX_RUN_DURATION_MS,
};

export function defaultPolicyForMode(mode: RunMode): CoordinationPolicy {
  if (mode === "collaborative") return COLLABORATIVE_POLICY;
  if (mode === "coordinated") return COORDINATED_POLICY;
  if (mode === "assurance") return ASSURANCE_POLICY;
  return SOLO_POLICY;
}

/** What's actually happened so far in this run, checked against the policy. */
export interface CoordinationUsage {
  supportingAgentsUsed: number;
  requestsUsed: number;
  currentDelegationDepth: number;
}

export interface BudgetCheckResult {
  allowed: boolean;
  reason: string | null;
}

/**
 * Can this run issue one more coordination request (help/check) right now?
 * Agents cannot expand their own budget — this only ever reads the policy, it
 * never mutates it.
 */
export function checkBudget(policy: CoordinationPolicy, usage: CoordinationUsage): BudgetCheckResult {
  if (usage.currentDelegationDepth >= policy.maxDelegationDepth) {
    return { allowed: false, reason: `Delegation depth ${usage.currentDelegationDepth} reached the ${policy.mode} limit of ${policy.maxDelegationDepth}.` };
  }
  if (usage.requestsUsed >= policy.maxRequests) {
    return { allowed: false, reason: `Request count ${usage.requestsUsed} reached the ${policy.mode} limit of ${policy.maxRequests}.` };
  }
  // `supportingAgentsUsed` is the number already participating. Equality is
  // not itself a reason to block another request to one of those same agents;
  // request count remains the hard per-run ceiling. Provider routing enforces
  // the available resident set, which is currently Codex + Claude Code.
  if (usage.supportingAgentsUsed > policy.maxSupportingAgents) {
    return { allowed: false, reason: `Supporting-agent count ${usage.supportingAgentsUsed} reached the ${policy.mode} limit of ${policy.maxSupportingAgents}.` };
  }
  return { allowed: true, reason: null };
}

/** True when a Brief's size is within the policy's cap — reuses brief.ts's own budget as the default. */
export function briefFitsPolicy(policy: CoordinationPolicy, briefCharacters: number): boolean {
  return briefCharacters <= policy.maxBriefCharacters;
}

export interface RunDurationCheck {
  overBudget: boolean;
  /** Only meaningful when overBudget is true. */
  exceededByMs: number;
}

/**
 * Has this run exceeded its policy's wall-clock ceiling? Pure: takes the run's
 * own started_at and the current time, never infers duration from activity or
 * guesses a start time. An invalid/unparseable startedAt is never treated as
 * "over budget" — absence of a signal is not evidence of a violation.
 */
export function checkRunDurationBudget(startedAt: string, nowMs: number, policy: CoordinationPolicy): RunDurationCheck {
  const startMs = Date.parse(startedAt);
  if (!Number.isFinite(startMs) || startMs > nowMs) return { overBudget: false, exceededByMs: 0 };
  const elapsed = nowMs - startMs;
  if (elapsed <= policy.maxRunDurationMs) return { overBudget: false, exceededByMs: 0 };
  return { overBudget: true, exceededByMs: elapsed - policy.maxRunDurationMs };
}
