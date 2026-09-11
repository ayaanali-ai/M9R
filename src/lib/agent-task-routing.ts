/**
 * Deterministic task-to-tier policy for bounded agent work.
 *
 * This selects an abstract capability tier, never a vendor model name. Provider
 * adapters own the current model mapping so model releases cannot silently
 * change the policy contract. Unknown work stays conservative.
 */

export type AgentModelTier = "economy" | "balanced" | "frontier";
export type AgentTaskClass = "mechanical" | "design" | "implementation" | "investigation" | "architecture" | "high_risk" | "ambiguous";
export type AgentProviderPreference = "claude-code" | "codex" | null;

export interface AgentTaskRoutingInput {
  task: string;
  paths?: string[];
  failedAttempts?: number;
  minimumTier?: AgentModelTier;
}

export interface AgentTaskRoute {
  taskClass: AgentTaskClass;
  baseModelTier: AgentModelTier;
  modelTier: AgentModelTier;
  providerPreference: AgentProviderPreference;
  maxEstimatedTokens: number;
  maxDurationMs: number;
  requiresHumanApproval: boolean;
  automaticRetryAllowed: boolean;
  escalated: boolean;
  reasons: string[];
}

const TIER_ORDER: AgentModelTier[] = ["economy", "balanced", "frontier"];
// balanced raised from 20k: a bounded provider launch's fixed overhead
// (system prompt, loaded skills/MCP context) alone commonly runs ~20k
// tokens before any real work happens -- verified directly against a real
// Codex CLI invocation -- so 20k rejected nearly every real "balanced"
// dispatch as over-budget purely on overhead. This is the third of three
// independent ceilings (run-mode.ts, resident authorization, this one) that
// all had to move together; the lowest one always wins.
const TIER_BUDGET: Record<AgentModelTier, { maxEstimatedTokens: number; maxDurationMs: number }> = {
  economy: { maxEstimatedTokens: 4_000, maxDurationMs: 10 * 60_000 },
  balanced: { maxEstimatedTokens: 60_000, maxDurationMs: 45 * 60_000 },
  frontier: { maxEstimatedTokens: 60_000, maxDurationMs: 60 * 60_000 },
};

function atLeast(left: AgentModelTier, right: AgentModelTier): AgentModelTier {
  return TIER_ORDER[Math.max(TIER_ORDER.indexOf(left), TIER_ORDER.indexOf(right))];
}

function escalate(tier: AgentModelTier, steps: number): AgentModelTier {
  return TIER_ORDER[Math.min(TIER_ORDER.length - 1, TIER_ORDER.indexOf(tier) + steps)];
}

function classify(task: string, paths: string[]): AgentTaskClass {
  const text = `${task} ${paths.join(" ")}`.toLowerCase();
  const words = task.trim().split(/\s+/).filter(Boolean);

  if (words.length < 3 || /\b(do the thing|handle it|fix stuff|make it work)\b/.test(task.toLowerCase())) return "ambiguous";
  if (/\b(auth|authentication|authorization|rls|row.level|migration|production|payment|billing|secret|credential|security|permission)\b/.test(text)) return "high_risk";
  if (/\b(redesign|visual|layout|interaction|animation|typography|responsive|accessibility|a11y|css|tailwind|component)\b/.test(text)) return "design";
  if (/\b(architecture|architect|protocol|schema design|distributed|concurrency|threat model)\b/.test(text)) return "architecture";
  if (/\b(rename|format|formatting|lint|typo|copy change|reword|sort imports|mechanical)\b/.test(text)) return "mechanical";
  if (/\b(investigate|diagnose|audit|review|analyze|trace|root cause)\b/.test(text)) return "investigation";
  return "implementation";
}

function baseTier(taskClass: AgentTaskClass): AgentModelTier {
  if (taskClass === "mechanical") return "economy";
  if (taskClass === "architecture" || taskClass === "high_risk") return "frontier";
  return "balanced";
}

export function routeAgentTask(input: AgentTaskRoutingInput): AgentTaskRoute {
  const task = typeof input.task === "string" ? input.task.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "";
  const paths = Array.isArray(input.paths) ? input.paths.filter((path): path is string => typeof path === "string").slice(0, 100) : [];
  const failedAttempts = Number.isSafeInteger(input.failedAttempts) && (input.failedAttempts ?? 0) > 0 ? input.failedAttempts! : 0;
  const taskClass = classify(task, paths);
  const startingTier = baseTier(taskClass);
  const retryEscalation = Math.min(failedAttempts, 2);
  let modelTier = escalate(startingTier, retryEscalation);
  if (input.minimumTier) modelTier = atLeast(modelTier, input.minimumTier);
  const automaticRetryAllowed = failedAttempts < 2;
  const requiresHumanApproval = taskClass === "high_risk" || taskClass === "ambiguous" || !automaticRetryAllowed;
  const reasons = [`task_class:${taskClass}`, `base_tier:${startingTier}`];
  if (retryEscalation > 0) reasons.push(`failed_attempts:${failedAttempts}`, `escalated_to:${modelTier}`);
  if (input.minimumTier) reasons.push(`minimum_tier:${input.minimumTier}`);
  if (requiresHumanApproval) reasons.push("human_approval_required");

  return {
    taskClass,
    baseModelTier: startingTier,
    modelTier,
    providerPreference: taskClass === "design" ? "claude-code" : null,
    ...TIER_BUDGET[modelTier],
    requiresHumanApproval,
    automaticRetryAllowed,
    escalated: modelTier !== startingTier,
    reasons,
  };
}
