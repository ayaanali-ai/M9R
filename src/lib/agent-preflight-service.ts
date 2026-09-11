export type PreflightStatus = "allowed" | "warned" | "needs_approval" | "blocked";
export type PreflightRiskLevel = "low" | "medium" | "high";

export type SensitiveArea =
  | "auth"
  | "secrets"
  | "payments"
  | "database"
  | "migrations"
  | "deploy"
  | "dependencies"
  | "permissions"
  | "user_data"
  | "destructive_action"
  | "api"
  | "config";

export interface PreflightInput {
  task: string;
  pathHints?: string[];
  approvalNote?: string | null;
}

export interface PreflightRule {
  id: string;
  title: string;
  body?: string | null;
  status?: string | null;
  deleted_at?: string | null;
  deletedAt?: string | null;
}

export interface PreflightRiskClassification {
  risk_level: PreflightRiskLevel;
  sensitive_areas: SensitiveArea[];
  vague_scope: boolean;
  blocked_reason: string | null;
}

export interface MatchedPreflightRule {
  id: string;
  title: string;
  reason: string;
}

export interface PreflightDecision {
  ok: true;
  status: PreflightStatus;
  risk_level: PreflightRiskLevel;
  summary: string;
  active_rule_count: number;
  matched_rules: MatchedPreflightRule[];
  sensitive_areas: SensitiveArea[];
  approval_required: boolean;
  missing_requirements: string[];
  recommended_requirements: string[];
  next_step: string;
}

const ORDERED_AREAS: SensitiveArea[] = [
  "auth",
  "secrets",
  "payments",
  "database",
  "migrations",
  "deploy",
  "dependencies",
  "permissions",
  "user_data",
  "destructive_action",
  "api",
  "config",
];

const HIGH_RISK_PATTERNS: Array<{ pattern: RegExp; areas: SensitiveArea[] }> = [
  // Bare "session" and "live" used to fire this classifier on their own --
  // confirmed live: a task titled "investigate concurrent session pooling"
  // got tagged "high risk / auth" purely because "session" appeared,
  // nothing to do with login or authentication. An ACP session, a build
  // session, a dev session, and a login session are not the same thing;
  // only phrases that actually mean the login/auth kind should match.
  { pattern: /\b(auth|login|password|oauth|sso|login session|user session|auth session|session token|session cookie)\b/i, areas: ["auth"] },
  { pattern: /\b(token|secret|secrets|credential|credentials|api key|apikey)\b|\.env\b/i, areas: ["secrets"] },
  { pattern: /\b(env|environment variable|environment variables)\b|\.env\b/i, areas: ["config", "secrets"] },
  { pattern: /\b(payment|payments|billing|stripe|checkout|invoice|subscription)\b/i, areas: ["payments"] },
  { pattern: /\b(database migration|schema migration|supabase migration|prisma migration)\b/i, areas: ["database", "migrations"] },
  { pattern: /\b(supabase\/migrations|prisma\/migrations|migrations\/|migration)\b/i, areas: ["database", "migrations"] },
  // "live" alone used to fire this too -- "live sessions", "live activity",
  // and "live turn" are all normal engineering vocabulary that has nothing
  // to do with an actual deploy/release action.
  { pattern: /\b(deploy|deployment|production|prod|go live|ship to production|release to production)\b/i, areas: ["deploy"] },
  { pattern: /\b(dependency install|package upgrade|npm install|pnpm install|yarn add|bun add|npm update|pnpm update|yarn upgrade)\b/i, areas: ["dependencies"] },
  { pattern: /\b(permissions|permission|iam|admin access|administrator|service role|service_role)\b/i, areas: ["permissions"] },
  { pattern: /\b(delete user data|delete customer data|drop table|truncate table|wipe data|purge data|rm -rf|destructive command|destructive commands)\b/i, areas: ["destructive_action", "user_data", "database"] },
];

const MEDIUM_RISK_PATTERNS: Array<{ pattern: RegExp; areas: SensitiveArea[] }> = [
  { pattern: /\b(api route|api routes|route handler|endpoint|server action)\b|\/api\//i, areas: ["api"] },
  { pattern: /\b(database read|database reads|database write|database writes|db read|db write|sql query|query data)\b/i, areas: ["database"] },
  { pattern: /\b(user data|customer data|profile data|personal data|pii)\b/i, areas: ["user_data"] },
  { pattern: /\b(validation|sanitize|sanitise|authorization|authorisation|access control)\b/i, areas: ["auth"] },
  { pattern: /\b(external integration|integration|webhook|webhooks|callback)\b/i, areas: ["api"] },
  { pattern: /\b(background job|background jobs|queue|cron|worker)\b/i, areas: ["api"] },
  { pattern: /\b(middleware|rate limit|rate limits|throttle|cache|caching)\b/i, areas: ["api"] },
  { pattern: /\b(config file|config files|next\.config|vercel\.json|package\.json|tsconfig|eslint|middleware\.ts)\b/i, areas: ["config"] },
];

const LOW_RISK_PATTERN = /\b(copy|docs|documentation|readme|ui layout|layout|styling|style|styles|tests|test|component cleanup|non-sensitive|spacing|typography|text)\b/i;
const GENERIC_SCOPE_PATTERN = /^(fix|update|change|improve|clean up|work on|adjust|touch|modify|handle)(?:\s+(it|stuff|things|code|app|repo|project))?$/i;
const DESTRUCTIVE_PATTERN = /\b(delete|drop|truncate|wipe|purge|destroy|remove all|erase|rm -rf|destructive)\b/i;
const LIVE_SENSITIVE_PATTERN = /\b(production|prod|live|user data|customer data|customers|users|database|supabase|payment|payments|billing|stripe|secret|secrets|token|tokens)\b/i;

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "into",
  "this",
  "that",
  "before",
  "after",
  "when",
  "where",
  "what",
  "which",
  "need",
  "needs",
  "rule",
  "rules",
  "task",
  "change",
  "changes",
  "update",
  "updates",
  "using",
  "list",
  "files",
  "target",
]);

const STRONG_MATCH_TOKENS = new Set([
  "auth",
  "session",
  "login",
  "password",
  "token",
  "secret",
  "secrets",
  "env",
  "payment",
  "payments",
  "billing",
  "stripe",
  "database",
  "migration",
  "migrations",
  "supabase",
  "prisma",
  "deploy",
  "production",
  "dependency",
  "dependencies",
  "permission",
  "permissions",
  "iam",
  "admin",
  "api",
  "route",
  "webhook",
  "middleware",
  "cache",
  "caching",
  "config",
  "docs",
  "ui",
  "tests",
  "styling",
]);

export function sanitizePreflightText(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedInputText(task: string, pathHints: string[] = []): string {
  return [task, ...pathHints].map((item) => sanitizePreflightText(item)).join("\n");
}

function addAreas(target: Set<SensitiveArea>, areas: SensitiveArea[]): void {
  for (const area of areas) target.add(area);
}

function orderedAreas(areas: Set<SensitiveArea>): SensitiveArea[] {
  return ORDERED_AREAS.filter((area) => areas.has(area));
}

function activeRulesOnly(rules: PreflightRule[]): PreflightRule[] {
  return rules.filter((rule) => (rule.status == null || rule.status === "active") && !rule.deleted_at && !rule.deletedAt);
}

function isVagueScope(task: string, pathHints: string[]): boolean {
  const clean = sanitizePreflightText(task);
  if (clean.length < 12) return true;
  if (GENERIC_SCOPE_PATTERN.test(clean)) return true;
  return pathHints.length === 0 && /^(fix|update|change|improve|clean up|work on|adjust|touch|modify)\b/i.test(clean);
}

export function detectSensitiveAreas(task: string, pathHints: string[] = []): SensitiveArea[] {
  const text = normalizedInputText(task, pathHints);
  const areas = new Set<SensitiveArea>();

  for (const entry of HIGH_RISK_PATTERNS) {
    if (entry.pattern.test(text)) addAreas(areas, entry.areas);
  }
  for (const entry of MEDIUM_RISK_PATTERNS) {
    if (entry.pattern.test(text)) addAreas(areas, entry.areas);
  }
  if (DESTRUCTIVE_PATTERN.test(text)) addAreas(areas, ["destructive_action"]);
  if (/\b(user data|customer data|customers|users)\b/i.test(text)) addAreas(areas, ["user_data"]);

  return orderedAreas(areas);
}

export function classifyPreflightRisk(input: PreflightInput): PreflightRiskClassification {
  const task = sanitizePreflightText(input.task);
  const pathHints = (input.pathHints ?? []).map(sanitizePreflightText).filter(Boolean);
  const text = normalizedInputText(task, pathHints);
  const sensitiveAreas = detectSensitiveAreas(task, pathHints);
  const high = HIGH_RISK_PATTERNS.some((entry) => entry.pattern.test(text));
  const medium = MEDIUM_RISK_PATTERNS.some((entry) => entry.pattern.test(text));
  const low = LOW_RISK_PATTERN.test(text);
  const destructiveLiveTask = DESTRUCTIVE_PATTERN.test(text) && LIVE_SENSITIVE_PATTERN.test(text);
  const destructiveMigration = /\b(destructive|drop|truncate|wipe|purge)\b/i.test(text) && /\bmigration\b/i.test(text);
  const blockedReason =
    destructiveLiveTask || destructiveMigration
      ? "Task appears destructive or live-sensitive and needs narrower scope."
      : null;

  let riskLevel: PreflightRiskLevel = "medium";
  if (high || blockedReason) riskLevel = "high";
  else if (medium) riskLevel = "medium";
  else if (low) riskLevel = "low";

  return {
    risk_level: riskLevel,
    sensitive_areas: sensitiveAreas,
    vague_scope: isVagueScope(task, pathHints),
    blocked_reason: blockedReason,
  };
}

function tokensFor(value: string): Set<string> {
  const normalized = sanitizePreflightText(value)
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[^a-z0-9.]+/g, " ");
  const tokens = normalized
    .split(/\s+/)
    .map((token) => token.replace(/^\.+|\.+$/g, ""))
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
  return new Set(tokens);
}

function sharedKeywords(left: Set<string>, right: Set<string>): string[] {
  return [...left].filter((token) => right.has(token)).slice(0, 6);
}

export function matchActiveRules(task: string, pathHints: string[] = [], activeRules: PreflightRule[] = []): MatchedPreflightRule[] {
  const taskTokens = tokensFor([task, ...pathHints].join("\n"));
  if (taskTokens.size === 0) return [];

  return activeRulesOnly(activeRules)
    .map((rule) => {
      const ruleTokens = tokensFor(`${rule.title}\n${rule.body ?? ""}`);
      const shared = sharedKeywords(taskTokens, ruleTokens);
      const strong = shared.filter((token) => STRONG_MATCH_TOKENS.has(token));
      const matched = strong.length > 0 || shared.length >= 2;
      if (!matched) return null;
      const keywords = (strong.length > 0 ? strong : shared).slice(0, 4);
      return {
        id: rule.id,
        title: rule.title,
        reason: `Matched active rule keywords: ${keywords.join(", ")}.`,
      } satisfies MatchedPreflightRule;
    })
    .filter((rule): rule is MatchedPreflightRule => Boolean(rule));
}

function buildRecommendedRequirements(
  classification: PreflightRiskClassification,
  matchedRules: MatchedPreflightRule[],
  activeRuleCount: number,
): string[] {
  const requirements: string[] = [];
  if (classification.risk_level === "high") {
    requirements.push("Record human approval before the run starts.");
  }
  if (classification.sensitive_areas.length > 0) {
    requirements.push(`Review sensitive areas before starting: ${classification.sensitive_areas.join(", ")}.`);
  }
  if (activeRuleCount > 0 && matchedRules.length === 0) {
    requirements.push("No active repo rules matched this task; review scope before starting.");
  }
  return requirements;
}

function summarizeDecision(status: PreflightStatus, matchedRuleCount: number, activeRuleCount: number): string {
  if (status === "blocked") {
    return "Preflight blocked this task because it appears destructive or live-sensitive and needs more detail.";
  }
  if (status === "needs_approval") {
    return "Preflight found high-risk sensitive areas. Human approval is required before starting.";
  }
  if (activeRuleCount === 0) {
    return "Preflight found no active repo rules for this agent.";
  }
  if (status === "warned") {
    return "Preflight found medium risk or unclear scope. Review requirements before starting.";
  }
  if (matchedRuleCount === 0) {
    return "Preflight allows this low-risk task. No active repo rules matched the task keywords.";
  }
  return "Preflight allows this low-risk task with active repo rules matched.";
}

function nextStepFor(status: PreflightStatus): string {
  if (status === "blocked") {
    return "Add a narrower task, target paths, rollback plan, and explicit human approval before trying again.";
  }
  if (status === "needs_approval") {
    return "Get human approval and include target paths before starting the run.";
  }
  if (status === "warned") {
    return "Review missing and recommended requirements before starting the run.";
  }
  return "Start the run and keep the matched active rules in context.";
}

export function buildPreflightDecision(input: PreflightInput, activeRules: PreflightRule[]): PreflightDecision {
  const task = sanitizePreflightText(input.task);
  const pathHints = (input.pathHints ?? []).map(sanitizePreflightText).filter(Boolean);
  const classification = classifyPreflightRisk({ task, pathHints, approvalNote: input.approvalNote });
  const activeRuleCount = activeRulesOnly(activeRules).length;
  const matchedRules = matchActiveRules(task, pathHints, activeRules);
  const missingRequirements: string[] = [];

  if (activeRuleCount === 0) {
    missingRequirements.push("No active repo rules are available for this agent.");
  }
  if (classification.risk_level === "high" && !sanitizePreflightText(input.approvalNote ?? "")) {
    missingRequirements.push("Human approval is required before this task starts.");
  }
  if ((classification.risk_level === "high" || classification.risk_level === "medium") && pathHints.length === 0) {
    missingRequirements.push("Path hints are required for sensitive preflight checks.");
  }
  if (classification.vague_scope) {
    missingRequirements.push("Task scope is too broad; provide target files or a narrower description.");
  }

  let status: PreflightStatus;
  if (classification.blocked_reason) status = "blocked";
  else if (classification.risk_level === "high") status = "needs_approval";
  else if (activeRuleCount === 0 || classification.risk_level === "medium" || classification.vague_scope) status = "warned";
  else status = "allowed";

  return {
    ok: true,
    status,
    risk_level: classification.risk_level,
    summary: summarizeDecision(status, matchedRules.length, activeRuleCount),
    active_rule_count: activeRuleCount,
    matched_rules: matchedRules,
    sensitive_areas: classification.sensitive_areas,
    approval_required: status === "needs_approval" || status === "blocked",
    missing_requirements: missingRequirements,
    recommended_requirements: buildRecommendedRequirements(classification, matchedRules, activeRuleCount),
    next_step: nextStepFor(status),
  };
}
