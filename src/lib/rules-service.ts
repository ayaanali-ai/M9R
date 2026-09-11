/**
 * Rules Service — OathLock Phase 1
 *
 * Read/update/delete operations for persistent rules, backing the Rules
 * Dashboard. Kept deliberately small and server-only (uses the Supabase service
 * role). Rule *creation* lives in rule-engine.ts (createRuleFromFinding); this
 * module is the management surface around already-created rules.
 *
 * Conventions:
 * - Validation throws RulesServiceError with an HTTP status the API can map.
 * - DB rows (snake_case) are mapped to a clean camelCase RuleListItem.
 * - "Deactivate" flips is_active; "delete" is a soft delete (deleted_at).
 */

import { supabase } from "@/lib/supabase";
import { createClient } from "@/lib/supabase/server";
import { resolveActiveOrDefaultProjectId } from "@/lib/projects-service";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class RulesServiceError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "RulesServiceError";
    this.code = code;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A rule as presented in the dashboard (one row). */
export interface RuleListItem {
  id: string;
  title: string;
  leakType: string;
  severity: "low" | "medium" | "high";
  /** Short human description shown in the list (maps from `cause`). */
  description: string;
  fixNow: string;
  evidenceLevel: string;
  isActive: boolean;
  timesApplied: number;
  createdAt: string;
  updatedAt: string | null;
  /** Most recent time this rule was applied to a trace, if ever. */
  lastAppliedAt: string | null;
  /** Applications recorded in the recent window (used = "currently in use"). */
  recentApplications: number;
  /** Report id(s) this rule was created from — powers the "link back" affordance. */
  sourceReportIds: string[];
}

/** Fields needed to persist a brand-new rule created from a report. */
export interface CreateRuleInput {
  title: string;
  leakType: string;
  severity: "low" | "medium" | "high";
  /** Maps to `cause` — the short human description. */
  description: string;
  fixNow?: string;
  promptFix?: string;
  policyRule?: string;
  evidenceNeeded?: string[];
  evidenceLevel?: "Claimed" | "Observed" | "Correlated" | "Unprovable";
  /** Optional source report id (stored only when it is a real UUID). */
  sourceReportId?: string | null;
}

/** Fields a user may edit from the dashboard. */
export interface RuleUpdate {
  title?: string;
  description?: string; // → cause
  severity?: "low" | "medium" | "high";
  fixNow?: string;
  isActive?: boolean;
}

export interface ListRulesOptions {
  /** Free-text filter over title/description/leakType. */
  query?: string;
  /** "active" (default) | "inactive" | "all". */
  status?: "active" | "inactive" | "all";
  /** How far back counts as "recently used", in days. Default 14. */
  recentWindowDays?: number;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

type RuleRow = {
  id: string;
  title: string;
  leak_type: string;
  severity: "low" | "medium" | "high";
  cause: string | null;
  fix_now: string | null;
  evidence_level: string | null;
  is_active: boolean;
  times_applied: number | null;
  source_report_ids: string[] | null;
  created_at: string;
  updated_at: string | null;
};

function mapRow(row: RuleRow): RuleListItem {
  return {
    id: row.id,
    title: row.title,
    leakType: row.leak_type,
    severity: row.severity,
    description: row.cause ?? "",
    fixNow: row.fix_now ?? "",
    evidenceLevel: row.evidence_level ?? "Observed",
    isActive: row.is_active,
    timesApplied: row.times_applied ?? 0,
    sourceReportIds: row.source_report_ids ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAppliedAt: null, // filled by enrichment below
    recentApplications: 0,
  };
}

async function requireAuthenticatedDb() {
  const db = await createClient();
  if (!db) {
    throw new RulesServiceError("Supabase is not configured.", "DB_NOT_CONFIGURED", 503);
  }
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) {
    throw new RulesServiceError("Authentication required.", "UNAUTHENTICATED", 401);
  }
  return { db, userId: user.id };
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

/**
 * List rules for the dashboard, newest first, enriched with recent-usage info.
 *
 * Enrichment ("which rules are used in recent reports") is done with a single
 * extra query against rule_applications, aggregated in JS — fine at Phase 1
 * scale and avoids a DB view.
 */
const FULL_COLUMNS =
  "id, title, leak_type, severity, cause, fix_now, evidence_level, is_active, times_applied, source_report_ids, created_at, updated_at";
// Same set minus times_applied, used as a fallback when the column hasn't been
// added yet (see supabase-rules-dashboard.sql). timesApplied then defaults to 0.
const FALLBACK_COLUMNS =
  "id, title, leak_type, severity, cause, fix_now, evidence_level, is_active, source_report_ids, created_at, updated_at";

export async function listRules(opts: ListRulesOptions = {}): Promise<RuleListItem[]> {
  const { db, userId } = await requireAuthenticatedDb();
  const status = opts.status ?? "active";

  // Build the filtered query for a given column set (re-buildable for fallback).
  const run = (columns: string) => {
    let q = db
      .from("rules")
      .select(columns)
      .eq("created_by", userId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false });
    if (status === "active") q = q.eq("is_active", true);
    if (status === "inactive") q = q.eq("is_active", false);
    return q.limit(500);
  };

  let { data, error } = await run(FULL_COLUMNS);

  // Gracefully degrade if `times_applied` doesn't exist yet (Postgres 42703).
  if (error && (error.code === "42703" || /times_applied/i.test(error.message ?? ""))) {
    ({ data, error } = await run(FALLBACK_COLUMNS));
  }

  if (error) {
    // Log the underlying cause; return a safe message to the client.
    console.error("listRules failed:", error.message, error.code);
    throw new RulesServiceError("Failed to list rules.", "LIST_FAILED", 500);
  }

  let items = ((data ?? []) as unknown as RuleRow[]).map((r) => mapRow(r));

  // Optional free-text filter (done in JS to keep the query simple).
  if (opts.query && opts.query.trim()) {
    const needle = opts.query.trim().toLowerCase();
    items = items.filter(
      (r) =>
        r.title.toLowerCase().includes(needle) ||
        r.description.toLowerCase().includes(needle) ||
        r.leakType.toLowerCase().includes(needle),
    );
  }

  await enrichWithRecentUsage(items, opts.recentWindowDays ?? 14);
  return items;
}

/**
 * Mutates `items`, filling lastAppliedAt and recentApplications from
 * rule_applications. Best-effort: failures here never break the listing.
 */
async function enrichWithRecentUsage(items: RuleListItem[], windowDays: number): Promise<void> {
  if (items.length === 0 || !supabase) return;

  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const ids = items.map((r) => r.id);

  const { data, error } = await supabase
    .from("rule_applications")
    .select("rule_id, applied_at")
    .in("rule_id", ids)
    .gte("applied_at", since);

  if (error || !data) return; // best-effort

  const recentCount = new Map<string, number>();
  const lastApplied = new Map<string, string>();
  for (const row of data as Array<{ rule_id: string; applied_at: string }>) {
    recentCount.set(row.rule_id, (recentCount.get(row.rule_id) ?? 0) + 1);
    const prev = lastApplied.get(row.rule_id);
    if (!prev || row.applied_at > prev) lastApplied.set(row.rule_id, row.applied_at);
  }

  for (const item of items) {
    item.recentApplications = recentCount.get(item.id) ?? 0;
    item.lastAppliedAt = lastApplied.get(item.id) ?? null;
  }
}

// ---------------------------------------------------------------------------
// Create (from a Blackbox Report)
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Persist a new rule created from a report recommendation/finding.
 *
 * Runs as the **signed-in user** (cookie session) so the rule is owned
 * correctly and RLS applies. `rules.project_id` and `rules.created_by` are
 * NOT NULL, so we resolve the user's *active* workspace — falling back to their
 * default and creating one on first use — rather than asking the UI to supply
 * raw UUIDs. See resolveActiveOrDefaultProjectId in projects-service.
 *
 * The source report id is stored only when it's a real UUID — client-generated
 * report ids (from in-browser analysis that was never persisted) are dropped,
 * keeping the link-back honest.
 */
export async function createRule(input: CreateRuleInput): Promise<RuleListItem> {
  // Basic validation up front for clear 400s.
  if (!input.title?.trim()) throw new RulesServiceError("Title is required.", "BAD_INPUT", 400);
  if (!input.leakType?.trim()) throw new RulesServiceError("leakType is required.", "BAD_INPUT", 400);
  if (!["low", "medium", "high"].includes(input.severity)) {
    throw new RulesServiceError("Invalid severity.", "BAD_INPUT", 400);
  }

  const db = await createClient();
  if (!db) {
    throw new RulesServiceError("Supabase is not configured.", "DB_NOT_CONFIGURED", 503);
  }

  // Must be signed in — rules are owned by a user + project.
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) {
    throw new RulesServiceError("Sign in to save a rule.", "UNAUTHENTICATED", 401);
  }

  // Use the workspace the user is actually looking at (active cookie), falling
  // back to their default — creating one on first use. Self-heals a missing
  // public.users row so this never fails with "Could not resolve a workspace".
  const projectId = await resolveActiveOrDefaultProjectId(db, {
    id: user.id,
    email: user.email,
    name: (user.user_metadata?.name as string | undefined) ?? null,
  });

  const sourceReportIds =
    input.sourceReportId && UUID_RE.test(input.sourceReportId) ? [input.sourceReportId] : [];

  const payload = {
    project_id: projectId,
    created_by: user.id,
    leak_type: input.leakType.trim(),
    severity: input.severity,
    title: input.title.trim(),
    cause: input.description?.trim() || `Pattern "${input.leakType}" observed in a Blackbox Report.`,
    fix_now: input.fixNow?.trim() || "Address the root cause indicated by this recommendation.",
    prompt_fix: input.promptFix?.trim() || "Incorporate this lesson into the agent's instructions.",
    policy_rule:
      input.policyRule?.trim() || `Flag traces exhibiting "${input.leakType}" and require review.`,
    evidence_needed: input.evidenceNeeded ?? [],
    limitations: ["Created from a Blackbox Report recommendation."],
    evidence_level: input.evidenceLevel ?? "Observed",
    source_report_ids: sourceReportIds,
    is_active: true,
  };

  // Select the fallback set (no times_applied) so creation works even before
  // the rules-dashboard migration adds that column; a new rule is 0 applications.
  const { data, error } = await db.from("rules").insert(payload).select(FALLBACK_COLUMNS).single();
  if (error || !data) {
    console.error("createRule failed:", error?.message, error?.code);
    throw new RulesServiceError("Failed to save the rule.", "CREATE_FAILED", 500);
  }
  return mapRow(data as unknown as RuleRow);
}

// ---------------------------------------------------------------------------
// Update (edit / deactivate)
// ---------------------------------------------------------------------------

export async function updateRule(id: string, patch: RuleUpdate): Promise<RuleListItem> {
  if (!id) throw new RulesServiceError("Rule id is required.", "BAD_INPUT", 400);
  const { db, userId } = await requireAuthenticatedDb();

  // Translate the editable fields to DB columns. Only include provided keys.
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.title !== undefined) {
    if (!patch.title.trim()) throw new RulesServiceError("Title cannot be empty.", "BAD_INPUT", 400);
    update.title = patch.title.trim();
  }
  if (patch.description !== undefined) update.cause = patch.description;
  if (patch.fixNow !== undefined) update.fix_now = patch.fixNow;
  if (patch.severity !== undefined) {
    if (!["low", "medium", "high"].includes(patch.severity)) {
      throw new RulesServiceError("Invalid severity.", "BAD_INPUT", 400);
    }
    update.severity = patch.severity;
  }
  if (patch.isActive !== undefined) update.is_active = patch.isActive;

  const { data, error } = await db
    .from("rules")
    .update(update)
    .eq("id", id)
    .eq("created_by", userId)
    .is("deleted_at", null)
    .select(FULL_COLUMNS)
    .maybeSingle();

  if (error) throw new RulesServiceError("Failed to update rule.", "UPDATE_FAILED", 500);
  if (!data) throw new RulesServiceError("Rule not found.", "NOT_FOUND", 404);
  return mapRow(data as RuleRow);
}

// ---------------------------------------------------------------------------
// Delete (soft)
// ---------------------------------------------------------------------------

export async function deleteRule(id: string): Promise<void> {
  if (!id) throw new RulesServiceError("Rule id is required.", "BAD_INPUT", 400);
  const { db, userId } = await requireAuthenticatedDb();

  const { data, error } = await db
    .from("rules")
    .update({ deleted_at: new Date().toISOString(), is_active: false })
    .eq("id", id)
    .eq("created_by", userId)
    .is("deleted_at", null)
    .select("id")
    .maybeSingle();

  if (error) throw new RulesServiceError("Failed to delete rule.", "DELETE_FAILED", 500);
  if (!data) throw new RulesServiceError("Rule not found.", "NOT_FOUND", 404);
}
