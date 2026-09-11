/**
 * Plan limits for OathLock workspaces.
 * ----------------------------------------------------------------------------
 * The app currently has no required billing table, so missing plan/subscription
 * data is treated as free. Keep this service central so future billing rows can
 * be wired without scattering entitlement checks through product code.
 */

export type UserPlan = "free" | "paid" | "unknown";

export interface PlanLimits {
  maxWorkspaces: number | null;
  maxAgents: number | null;
  maxRules: number | null;
  /** Free plan retention: how far back a query is allowed to look. null = unlimited. */
  auditRetentionDays: number | null;
}

export interface WorkspacePlanUsage {
  plan: UserPlan;
  workspaceCount: number;
  maxWorkspaces: number | null;
  limitReached: boolean;
  message: string | null;
}

export const FREE_PLAN_MAX_WORKSPACES = 2;
export const FREE_PLAN_MAX_AGENTS = 2;
export const FREE_PLAN_MAX_RULES = 10;
export const FREE_PLAN_AUDIT_RETENTION_DAYS = 30;

export const FREE_PLAN_LIMIT_MESSAGE =
  "Free plan limit reached. Free users can create up to 2 workspaces.";
export const FREE_PLAN_AGENT_LIMIT_MESSAGE =
  "Free plan limit reached. Free users can connect up to 2 agents per workspace.";
export const FREE_PLAN_RULE_LIMIT_MESSAGE =
  "Free plan limit reached. Free users can keep up to 10 active workspace rules.";

export class PlanLimitError extends Error {
  readonly status = 403;
  readonly code: string;
  readonly usage: WorkspacePlanUsage | { plan: UserPlan; count: number; max: number };

  constructor(message: string, code: string, usage: WorkspacePlanUsage | { plan: UserPlan; count: number; max: number }) {
    super(message);
    this.name = "PlanLimitError";
    this.code = code;
    this.usage = usage;
  }
}

type DbError = { code?: string | null; message?: string | null };
type QueryResult = { data?: unknown; error?: DbError | null; count?: number | null };
type FromBuilder = {
  select(columns: string, options?: Record<string, unknown>): QueryBuilder;
};
type QueryBuilder = PromiseLike<QueryResult> & {
  eq(column: string, value: unknown): QueryBuilder;
  in(column: string, values: readonly unknown[]): QueryBuilder;
  order(column: string, options?: Record<string, unknown>): QueryBuilder;
  limit(count: number): QueryBuilder;
  maybeSingle(): Promise<QueryResult>;
  is(column: string, value: unknown): QueryBuilder;
};
type DbClient = { from(table: string): FromBuilder };

function fromTable(db: unknown, table: string): FromBuilder {
  return (db as DbClient).from(table);
}

function missingOptionalPlanSurface(error: DbError | null | undefined): boolean {
  if (!error) return false;
  return (
    error.code === "42P01" ||
    error.code === "42703" ||
    error.code === "PGRST205" ||
    /relation .* does not exist|table .* does not exist|column .* does not exist/i.test(error.message ?? "")
  );
}

export function normalizeUserPlan(value: unknown): UserPlan {
  const plan = String(value ?? "").trim().toLowerCase();
  if (!plan) return "unknown";
  if (["free", "trial", "starter", "hobby"].includes(plan)) return "free";
  if (["paid", "pro", "team", "teams", "business", "enterprise", "growth"].includes(plan)) {
    return "paid";
  }
  return "unknown";
}

function planFromMetadata(metadata: unknown): UserPlan {
  if (!metadata || typeof metadata !== "object") return "unknown";
  const data = metadata as Record<string, unknown>;
  return normalizeUserPlan(data.plan ?? data.subscription_plan ?? data.tier);
}

export function resolveUserPlan(input: {
  subscription?: Record<string, unknown> | null;
  userMetadata?: unknown;
}): UserPlan {
  const subscription = input.subscription;
  if (subscription) {
    const status = String(subscription.status ?? "").toLowerCase();
    const active = ["active", "trialing", "paid"].includes(status);
    const plan = normalizeUserPlan(
      subscription.plan ?? subscription.tier ?? subscription.price_id,
    );
    if (active && plan !== "free") return "paid";
    if (plan === "free") return "free";
  }

  const metadataPlan = planFromMetadata(input.userMetadata);
  if (metadataPlan === "paid") return "paid";
  return "free";
}

export function getPlanLimits(plan: UserPlan): PlanLimits {
  if (plan === "paid") {
    return { maxWorkspaces: null, maxAgents: null, maxRules: null, auditRetentionDays: null };
  }
  return {
    maxWorkspaces: FREE_PLAN_MAX_WORKSPACES,
    maxAgents: FREE_PLAN_MAX_AGENTS,
    maxRules: FREE_PLAN_MAX_RULES,
    auditRetentionDays: FREE_PLAN_AUDIT_RETENTION_DAYS,
  };
}

export function workspaceUsageFor(plan: UserPlan, workspaceCount: number): WorkspacePlanUsage {
  const limits = getPlanLimits(plan);
  const count = Math.max(0, Math.floor(workspaceCount));
  const limitReached = limits.maxWorkspaces !== null && count >= limits.maxWorkspaces;
  return {
    plan,
    workspaceCount: count,
    maxWorkspaces: limits.maxWorkspaces,
    limitReached,
    message: limitReached ? FREE_PLAN_LIMIT_MESSAGE : null,
  };
}

async function readCurrentSubscription(db: unknown, userId: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await fromTable(db, "subscriptions")
    .select("plan, tier, price_id, status, created_at")
    .eq("user_id", userId)
    .in("status", ["active", "trialing", "paid"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    if (missingOptionalPlanSurface(error)) return null;
    throw error;
  }
  return (data as Record<string, unknown> | null) ?? null;
}

async function readUserMetadata(db: unknown, userId: string): Promise<unknown> {
  const { data, error } = await fromTable(db, "users")
    .select("metadata")
    .eq("id", userId)
    .maybeSingle();
  if (error) {
    if (missingOptionalPlanSurface(error)) return null;
    throw error;
  }
  return (data as { metadata?: unknown } | null)?.metadata ?? null;
}

export async function getUserPlan(db: unknown, userId: string): Promise<UserPlan> {
  const subscription = await readCurrentSubscription(db, userId);
  const metadata = subscription ? null : await readUserMetadata(db, userId);
  return resolveUserPlan({ subscription, userMetadata: metadata });
}

export async function countUserWorkspaces(db: unknown, userId: string): Promise<number> {
  const { count, error } = await fromTable(db, "projects")
    .select("id", { count: "exact", head: true })
    .eq("owner_id", userId)
    .is("deleted_at", null);

  if (error) throw error;
  return Math.max(0, count ?? 0);
}

export async function getWorkspacePlanUsage(db: unknown, userId: string): Promise<WorkspacePlanUsage> {
  const [plan, workspaceCount] = await Promise.all([
    getUserPlan(db, userId),
    countUserWorkspaces(db, userId),
  ]);
  return workspaceUsageFor(plan, workspaceCount);
}

export async function assertCanCreateWorkspace(db: unknown, userId: string): Promise<WorkspacePlanUsage> {
  const usage = await getWorkspacePlanUsage(db, userId);
  if (usage.limitReached) throw new PlanLimitError(FREE_PLAN_LIMIT_MESSAGE, "FREE_WORKSPACE_LIMIT_REACHED", usage);
  // TODO: move count+create into a Postgres RPC/transaction if workspace creation
  // becomes high-concurrency. Today this is the safest check available through
  // the existing Supabase client architecture.
  return usage;
}

/** Distinct active agent kinds connected to a workspace -- matches how the
 *  Watchfloor masthead and callsign summaries already count "agents". */
export async function countActiveAgentKinds(db: unknown, workspaceId: string): Promise<number> {
  const { data, error } = await fromTable(db, "agent_connections")
    .select("agent_kind")
    .eq("workspace_id", workspaceId)
    .eq("status", "active");
  if (error) throw error;
  const kinds = new Set(((data ?? []) as Array<{ agent_kind: string }>).map((row) => row.agent_kind));
  return kinds.size;
}

export async function assertCanConnectAgent(db: unknown, userId: string, workspaceId: string, agentKind: string): Promise<void> {
  const plan = await getUserPlan(db, userId);
  const limits = getPlanLimits(plan);
  if (limits.maxAgents === null) return;
  const activeKinds = await countActiveAgentKinds(db, workspaceId);
  // A reconnect of an already-counted kind never trips the limit -- only a
  // genuinely new kind for this workspace can push it over.
  const alreadyCounted = await workspaceHasAgentKind(db, workspaceId, agentKind);
  if (alreadyCounted) return;
  if (activeKinds >= limits.maxAgents) {
    throw new PlanLimitError(FREE_PLAN_AGENT_LIMIT_MESSAGE, "FREE_AGENT_LIMIT_REACHED", { plan, count: activeKinds, max: limits.maxAgents });
  }
}

async function workspaceHasAgentKind(db: unknown, workspaceId: string, agentKind: string): Promise<boolean> {
  const { data, error } = await fromTable(db, "agent_connections")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("agent_kind", agentKind)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

export async function countActiveWorkspaceRules(db: unknown, workspaceId: string): Promise<number> {
  const { count, error } = await fromTable(db, "workspace_rules")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("status", "active")
    .is("deleted_at", null);
  if (error) throw error;
  return Math.max(0, count ?? 0);
}

export async function assertCanActivateRule(db: unknown, userId: string, workspaceId: string): Promise<void> {
  const plan = await getUserPlan(db, userId);
  const limits = getPlanLimits(plan);
  if (limits.maxRules === null) return;
  const count = await countActiveWorkspaceRules(db, workspaceId);
  if (count >= limits.maxRules) {
    throw new PlanLimitError(FREE_PLAN_RULE_LIMIT_MESSAGE, "FREE_RULE_LIMIT_REACHED", { plan, count, max: limits.maxRules });
  }
}
