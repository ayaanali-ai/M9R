/**
 * Workspace Rules Service — OathLock v5.1
 * ----------------------------------------------------------------------------
 * Persistence for workspace-scoped rules: promote generated rules from a report
 * into a workspace, manage their health over time, and export the active set.
 *
 * Runs as the signed-in user (cookie session) so RLS enforces "owner of the
 * workspace only". Workspace resolution + user provisioning reuse the hardened
 * helpers in projects-service (so a missing public.users row or default
 * workspace never dead-ends here either).
 *
 * The dedupe/merge decisions are made by the pure planPromotion() — this module
 * only executes the actions it returns, keeping the policy testable without a DB.
 */

import { createClient } from "@/lib/supabase/server";
import { resolveActiveOrDefaultProjectId } from "@/lib/projects-service";
import { assertCanActivateRule } from "@/lib/plan-limits-service";
import type { GeneratedRule, RuleStatus } from "@/lib/generated-rules";
import { planPromotion, type WorkspaceRule } from "@/lib/workspace-rule-matching";
import { generateRulesFile, type RulesFileFormat, type RulesFile } from "@/lib/rules-file-generator";
import { redactSession, type RedactionResult } from "@/lib/session-redaction";
import type { RuleEffectivenessDecision } from "@/lib/rule-effectiveness";
import { appendAuditLogEntry } from "@/lib/audit-log";

export class WorkspaceRulesError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "WorkspaceRulesError";
    this.code = code;
    this.status = status;
  }
}

type Db = NonNullable<Awaited<ReturnType<typeof createClient>>>;

const COLUMNS =
  "id, workspace_id, source_report_id, source_session_name, title, body, rule_type, confidence, status, evidence_summary, source_finding_id, expected_prevention, scope_condition, created_at, updated_at, last_seen_at, promoted_at, retired_at, times_seen, times_exported, times_helped, notes, created_by";

type Row = {
  id: string;
  workspace_id: string;
  source_report_id: string | null;
  source_session_name: string | null;
  title: string;
  body: string;
  rule_type: string;
  confidence: string;
  status: string;
  evidence_summary: string | null;
  source_finding_id: string | null;
  expected_prevention: string | null;
  scope_condition: string | null;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
  promoted_at: string | null;
  retired_at: string | null;
  times_seen: number | null;
  times_exported: number | null;
  times_helped: number | null;
  notes: string | null;
  created_by: string | null;
};

function mapRow(r: Row): WorkspaceRule {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    sourceReportId: r.source_report_id,
    sourceSessionName: r.source_session_name,
    title: r.title,
    body: r.body,
    ruleType: r.rule_type as WorkspaceRule["ruleType"],
    confidence: r.confidence as WorkspaceRule["confidence"],
    status: r.status as RuleStatus,
    evidenceSummary: r.evidence_summary ?? "",
    sourceFindingId: r.source_finding_id,
    expectedPrevention: r.expected_prevention ?? "",
    scopeCondition: r.scope_condition,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastSeenAt: r.last_seen_at,
    promotedAt: r.promoted_at,
    retiredAt: r.retired_at,
    timesSeen: r.times_seen ?? 0,
    timesExported: r.times_exported ?? 0,
    timesHelped: r.times_helped ?? 0,
    notes: r.notes,
    createdBy: r.created_by,
  };
}

async function requireUser(): Promise<{ db: Db; user: { id: string; email?: string | null; name?: string | null } }> {
  const db = await createClient();
  if (!db) throw new WorkspaceRulesError("Supabase is not configured.", "DB_NOT_CONFIGURED", 503);
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) throw new WorkspaceRulesError("Sign in to manage workspace rules.", "UNAUTHENTICATED", 401);
  return {
    db,
    user: { id: user.id, email: user.email, name: (user.user_metadata?.name as string | undefined) ?? null },
  };
}

/** Resolve the workspace to operate on (explicit id, else the active/default one). */
async function resolveWorkspace(db: Db, user: { id: string; email?: string | null; name?: string | null }, workspaceId?: string): Promise<string> {
  if (workspaceId) return workspaceId;
  return resolveActiveOrDefaultProjectId(db, user);
}

type ManualSource = "manual" | "import";

export interface ManualWorkspaceRuleInput {
  title: string;
  body: string;
  workspaceId?: string;
  riskLevel?: string | null;
  pathPatterns?: string[] | string | null;
}

export interface ImportWorkspaceRulesInput {
  text: string;
  workspaceId?: string;
  sourceLabel?: string | null;
  riskLevel?: string | null;
  pathPatterns?: string[] | string | null;
}

export interface ImportRuleDraft {
  title: string;
  body: string;
}

export interface ManualRuleStorageMetadata {
  source: ManualSource;
  approved_by: string | null;
  approved_at: string | null;
  risk_level: string | null;
  path_patterns: string[];
  import_source?: string | null;
  redaction_summary: string;
  redaction_confidence: RedactionResult["confidence"];
}

const MAX_IMPORT_DRAFTS = 12;

function trimTo(value: string, max: number): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed.length > max ? `${trimmed.slice(0, max - 3).trimEnd()}...` : trimmed;
}

function normalizeOptionalText(value: unknown, max = 80): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimTo(trimmed, max) : null;
}

function normalizePathPatterns(value: string[] | string | null | undefined): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\n,]/) : [];
  return raw.map((item) => trimTo(String(item), 160)).filter(Boolean).slice(0, 20);
}

function redactForRuleStorage(value: string): { text: string; redaction: RedactionResult } {
  const redaction = redactSession(value);
  return { text: redaction.redactedText.trim(), redaction };
}

export function buildManualRuleNotes(meta: ManualRuleStorageMetadata): string {
  return JSON.stringify(meta);
}

function buildSourceMetadata(args: {
  source: ManualSource;
  approvedBy: string | null;
  approvedAt: string | null;
  riskLevel?: string | null;
  pathPatterns?: string[] | string | null;
  importSource?: string | null;
  redaction: RedactionResult;
}): ManualRuleStorageMetadata {
  return {
    source: args.source,
    approved_by: args.approvedBy,
    approved_at: args.approvedAt,
    risk_level: normalizeOptionalText(args.riskLevel, 40),
    path_patterns: normalizePathPatterns(args.pathPatterns),
    import_source: args.importSource ? normalizeOptionalText(args.importSource, 100) : undefined,
    redaction_summary: args.redaction.redactionSummary,
    redaction_confidence: args.redaction.confidence,
  };
}

export function parseImportedRuleDrafts(text: string): ImportRuleDraft[] {
  const source = text.trim();
  if (!source) return [];

  const candidates = source
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
        .replace(/^\s*>\s?/, "")
        .trim(),
    )
    .filter((line) => line.length >= 16)
    .filter((line) => !/^(available skills|mcp servers|model recommendations|key differences|steps)$/i.test(line));

  const unique = new Set<string>();
  const drafts: ImportRuleDraft[] = [];
  for (const line of candidates) {
    const normalized = line.replace(/\s+/g, " ");
    const key = normalized.toLowerCase();
    if (unique.has(key)) continue;
    unique.add(key);
    drafts.push({
      title: trimTo(normalized.replace(/[:.]\s*$/, ""), 72),
      body: normalized,
    });
    if (drafts.length >= MAX_IMPORT_DRAFTS) break;
  }

  if (drafts.length === 0) {
    const fallback = trimTo(source.replace(/\s+/g, " "), 1200);
    drafts.push({
      title: trimTo(fallback, 72),
      body: fallback,
    });
  }

  return drafts;
}

// ---------------------------------------------------------------------------
// Manual / imported drafts
// ---------------------------------------------------------------------------

export async function createManualWorkspaceRule(input: ManualWorkspaceRuleInput): Promise<{ rule: WorkspaceRule; redaction: RedactionResult }> {
  const title = input.title?.trim();
  const body = input.body?.trim();
  if (!title) throw new WorkspaceRulesError("Rule title is required.", "BAD_INPUT", 400);
  if (!body) throw new WorkspaceRulesError("Rule body is required.", "BAD_INPUT", 400);

  const { db, user } = await requireUser();
  const wsId = await resolveWorkspace(db, user, input.workspaceId);
  const titleRedaction = redactForRuleStorage(title);
  const bodyRedaction = redactForRuleStorage(body);

  const metadata = buildSourceMetadata({
    source: "manual",
    approvedBy: null,
    approvedAt: null,
    riskLevel: input.riskLevel,
    pathPatterns: input.pathPatterns,
    redaction: bodyRedaction.redaction,
  });

  const { data, error } = await db
    .from("workspace_rules")
    .insert({
      workspace_id: wsId,
      created_by: user.id,
      source_report_id: null,
      source_session_name: "manual",
      title: trimTo(titleRedaction.text || "Manual workspace rule", 120),
      body: bodyRedaction.text,
      rule_type: "manual",
      confidence: "medium",
      status: "needs_review",
      evidence_summary: "Human-written workspace rule draft. Review before activating.",
      source_finding_id: null,
      expected_prevention: "Human-written workspace guidance; future impact depends on later runs.",
      promoted_at: null,
      last_seen_at: null,
      times_seen: 1,
      notes: buildManualRuleNotes(metadata),
    })
    .select(COLUMNS)
    .single();

  if (error) throw new WorkspaceRulesError("Failed to create manual rule draft.", "CREATE_FAILED", 500);
  return { rule: mapRow(data as unknown as Row), redaction: bodyRedaction.redaction };
}

const EVIDENCE_LEVEL_CONFIDENCE: Record<string, "low" | "medium" | "high"> = {
  inferred: "low",
  correlated: "medium",
  command_tied: "high",
};

export interface FindingRuleSource {
  id: string;
  workspaceId: string;
  title: string;
  observedBehavior: string;
  suggestedResponse: string;
  evidenceLevel: string;
  /** The Finding's own applicableEnvironment -- the human already reviewed
   * and approved this scope condition; carrying it through at promotion
   * keeps it, instead of silently discarding it into free-text body. */
  applicableEnvironment: string;
}

/**
 * Draft a rule from a reviewed Finding. `workspace_rules.source_finding_id`
 * has existed since the schema was designed for this, but nothing ever wrote
 * to it -- Findings and Rules were two disconnected systems until now. The
 * draft still lands in `needs_review`, same human promotion gate as every
 * other rule; this only removes the step of a human re-typing the agent's
 * own suggested_response by hand.
 */
export async function createRuleFromFinding(finding: FindingRuleSource): Promise<WorkspaceRule> {
  const title = finding.title.trim();
  const body = finding.suggestedResponse.trim();
  if (!title) throw new WorkspaceRulesError("Finding has no title to draft a rule from.", "BAD_INPUT", 400);
  if (!body) throw new WorkspaceRulesError("Finding has no suggested response to draft a rule from.", "BAD_INPUT", 400);

  const { db, user } = await requireUser();
  const titleRedaction = redactForRuleStorage(title);
  const bodyRedaction = redactForRuleStorage(body);
  const evidenceRedaction = redactForRuleStorage(finding.observedBehavior.trim() || "No further detail recorded.");
  const scope = finding.applicableEnvironment.trim();
  const scopeRedaction = scope ? redactForRuleStorage(scope) : null;

  const metadata = buildSourceMetadata({
    source: "manual",
    approvedBy: user.id,
    approvedAt: new Date().toISOString(),
    redaction: bodyRedaction.redaction,
  });

  const { data, error } = await db
    .from("workspace_rules")
    .insert({
      workspace_id: finding.workspaceId,
      created_by: user.id,
      source_report_id: null,
      source_session_name: "finding",
      title: trimTo(titleRedaction.text || "Rule suggested from Finding", 120),
      body: bodyRedaction.text,
      rule_type: "from_finding",
      confidence: EVIDENCE_LEVEL_CONFIDENCE[finding.evidenceLevel] ?? "medium",
      status: "needs_review",
      evidence_summary: trimTo(evidenceRedaction.text, 400),
      source_finding_id: finding.id,
      expected_prevention: trimTo(bodyRedaction.text, 400),
      scope_condition: scopeRedaction ? trimTo(scopeRedaction.text, 400) : null,
      promoted_at: null,
      last_seen_at: null,
      times_seen: 1,
      notes: buildManualRuleNotes(metadata),
    })
    .select(COLUMNS)
    .single();

  if (error) throw new WorkspaceRulesError("Failed to draft a rule from this finding.", "CREATE_FAILED", 500);
  return mapRow(data as unknown as Row);
}

export async function importWorkspaceRuleDrafts(input: ImportWorkspaceRulesInput): Promise<{ created: number; rules: WorkspaceRule[]; redaction: RedactionResult }> {
  if (!input.text?.trim()) throw new WorkspaceRulesError("Import text is required.", "BAD_INPUT", 400);

  const { db, user } = await requireUser();
  const wsId = await resolveWorkspace(db, user, input.workspaceId);
  const redacted = redactForRuleStorage(input.text);
  const drafts = parseImportedRuleDrafts(redacted.text);
  const now = new Date().toISOString();
  const sourceLabel = normalizeOptionalText(input.sourceLabel, 100) ?? "repo instructions";
  const metadata = buildSourceMetadata({
    source: "import",
    approvedBy: null,
    approvedAt: null,
    riskLevel: input.riskLevel,
    pathPatterns: input.pathPatterns,
    importSource: sourceLabel,
    redaction: redacted.redaction,
  });

  const inserts = drafts.map((draft) => ({
    workspace_id: wsId,
    created_by: user.id,
    source_report_id: null,
    source_session_name: `import: ${sourceLabel}`,
    title: draft.title,
    body: draft.body,
    rule_type: "manual",
    confidence: "medium",
    status: "needs_review",
    evidence_summary: "Imported repo instruction draft. Review before activating.",
    source_finding_id: null,
    expected_prevention: "Imported workspace guidance; future impact depends on later runs.",
    promoted_at: null,
    last_seen_at: now,
    times_seen: 1,
    notes: buildManualRuleNotes(metadata),
  }));

  const { data, error } = await db.from("workspace_rules").insert(inserts).select(COLUMNS);
  if (error) throw new WorkspaceRulesError("Failed to import rule drafts.", "IMPORT_FAILED", 500);
  const rules = ((data ?? []) as unknown as Row[]).map(mapRow);

  // Announce each new draft in #general, same inline-card pattern as
  // Finding/evidence/run-start -- additive, must never fail the import
  // itself. Rule drafts have no agent to notify (see conversation-service.ts's
  // findOrCreateAgentDmForBearer for the agent-initiated equivalent); #general
  // is the closest existing "everyone sees this" channel to post a
  // human-initiated review request into.
  try {
    const { sendDashboardConversationMessage } = await import("@/lib/conversation-service");
    const { data: general } = await db.from("agent_conversations").select("id").eq("workspace_id", wsId).eq("channel_slug", "general").maybeSingle();
    if (general?.id) {
      for (const rule of rules) {
        try {
          const message = await sendDashboardConversationMessage({
            conversationId: general.id as string,
            body: `New rule draft imported for review: ${rule.title}`,
            idempotencyKey: `rule-draft-announce-message:${rule.id}`,
          });
          await db.from("workspace_rules").update({ announcement_message_id: message.id }).eq("id", rule.id);
        } catch { /* one draft's announcement failing must not affect the others */ }
      }
    }
  } catch { /* the inline review card is additive; the drawer remains the source of truth */ }

  return { created: rules.length, rules, redaction: redacted.redaction };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** List a workspace's rules, newest first. Excludes soft-deleted rows. */
export async function listWorkspaceRules(workspaceId?: string): Promise<WorkspaceRule[]> {
  const { db, user } = await requireUser();
  const wsId = await resolveWorkspace(db, user, workspaceId);

  const { data, error } = await db
    .from("workspace_rules")
    .select(COLUMNS)
    .eq("workspace_id", wsId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) {
    console.error("listWorkspaceRules failed:", error.message, error.code);
    throw new WorkspaceRulesError("Failed to list workspace rules.", "LIST_FAILED", 500);
  }
  return ((data ?? []) as unknown as Row[]).map(mapRow);
}

// ---------------------------------------------------------------------------
// Promote
// ---------------------------------------------------------------------------

export interface PromoteResult {
  created: number;
  updated: number;
  flaggedForReview: number;
  rules: WorkspaceRule[];
}

/**
 * Promote generated rules into a workspace. Dedupes against existing active /
 * needs-review / retired rules via planPromotion:
 *  - new → insert
 *  - similar live rule → update last_seen + times_seen (and evidence if stronger)
 *  - similar retired rule → flag needs_review (never silently reactivated)
 */
export async function promoteGeneratedRules(
  generated: GeneratedRule[],
  opts: { workspaceId?: string; sourceReportId?: string | null; sourceSessionName?: string | null } = {},
): Promise<PromoteResult> {
  const { db, user } = await requireUser();
  const wsId = await resolveWorkspace(db, user, opts.workspaceId);

  const existing = await listWorkspaceRulesFor(db, wsId);
  const now = new Date().toISOString();
  const actions = planPromotion(generated, existing, now);

  let created = 0;
  let updated = 0;
  let flaggedForReview = 0;

  const inserts: Record<string, unknown>[] = [];
  for (const action of actions) {
    if (action.kind === "create") {
      const g = action.rule;
      inserts.push({
        workspace_id: wsId,
        created_by: user.id,
        source_report_id: opts.sourceReportId ?? null,
        source_session_name: opts.sourceSessionName ?? null,
        title: g.title,
        body: g.body,
        rule_type: g.ruleType,
        confidence: g.confidence,
        status: g.status,
        evidence_summary: g.evidenceSummary,
        source_finding_id: g.sourceFindingId,
        expected_prevention: g.expectedPrevention,
        promoted_at: now,
        last_seen_at: now,
        times_seen: 1,
      });
      created += 1;
    } else if (action.kind === "update") {
      const patch: Record<string, unknown> = {
        last_seen_at: action.patch.lastSeenAt,
        times_seen: action.patch.timesSeen,
        updated_at: now,
      };
      if (action.patch.evidenceSummary) patch.evidence_summary = action.patch.evidenceSummary;
      const { error } = await db.from("workspace_rules").update(patch).eq("id", action.id);
      if (!error) updated += 1;
    } else {
      // flag_retired
      const { error } = await db
        .from("workspace_rules")
        .update({
          status: action.patch.status,
          notes: action.patch.notes,
          last_seen_at: action.patch.lastSeenAt,
          times_seen: action.patch.timesSeen,
          updated_at: now,
        })
        .eq("id", action.id);
      if (!error) flaggedForReview += 1;
    }
  }

  if (inserts.length > 0) {
    const { error } = await db.from("workspace_rules").insert(inserts);
    if (error) {
      console.error("promoteGeneratedRules insert failed:", error.message, error.code);
      throw new WorkspaceRulesError("Failed to promote rules to the workspace.", "PROMOTE_FAILED", 500);
    }
  }

  const rules = await listWorkspaceRulesFor(db, wsId);
  return { created, updated, flaggedForReview, rules };
}

/** Internal: list rules for a known workspace id using an existing client. */
async function listWorkspaceRulesFor(db: Db, wsId: string): Promise<WorkspaceRule[]> {
  const { data, error } = await db
    .from("workspace_rules")
    .select(COLUMNS)
    .eq("workspace_id", wsId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) {
    console.error("listWorkspaceRulesFor failed:", error.message, error.code);
    throw new WorkspaceRulesError("Failed to read workspace rules.", "LIST_FAILED", 500);
  }
  return ((data ?? []) as unknown as Row[]).map(mapRow);
}

// ---------------------------------------------------------------------------
// Update (status / body / health)
// ---------------------------------------------------------------------------

async function readWorkspaceRuleForMutation(db: Db, ruleId: string): Promise<Row> {
  const { data, error } = await db
    .from("workspace_rules")
    .select(COLUMNS)
    .eq("id", ruleId)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) throw new WorkspaceRulesError("Failed to read the rule.", "RULE_LOOKUP_FAILED", 500);
  if (!data) throw new WorkspaceRulesError("Rule not found.", "NOT_FOUND", 404);
  return data as unknown as Row;
}

/** Set a rule's review/archive status. Activation must go through promoteWorkspaceRule(). */
export async function updateWorkspaceRuleStatus(ruleId: string, status: RuleStatus): Promise<WorkspaceRule> {
  const { db } = await requireUser();
  if (status === "active") {
    throw new WorkspaceRulesError("Use the promote route to activate a rule.", "PROMOTE_REQUIRED", 400);
  }
  const patch: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
  if (status === "retired") patch.retired_at = new Date().toISOString();
  else patch.retired_at = null; // un-retiring clears the stamp

  const { data, error } = await db
    .from("workspace_rules")
    .update(patch)
    .eq("id", ruleId)
    .is("deleted_at", null)
    .select(COLUMNS)
    .maybeSingle();

  if (error) throw new WorkspaceRulesError("Failed to update rule status.", "UPDATE_FAILED", 500);
  if (!data) throw new WorkspaceRulesError("Rule not found.", "NOT_FOUND", 404);
  return mapRow(data as unknown as Row);
}

export async function softDeleteWorkspaceRule(ruleId: string): Promise<{ id: string; deletedAt: string }> {
  const { db } = await requireUser();
  const sourceRule = await readWorkspaceRuleForMutation(db, ruleId);
  if (!["needs_review", "retired"].includes(sourceRule.status)) {
    throw new WorkspaceRulesError("Only needs-review drafts and archived rules can be deleted.", "DELETE_NOT_ALLOWED", 409);
  }

  const now = new Date().toISOString();
  const { data, error } = await db
    .from("workspace_rules")
    .update({ deleted_at: now, updated_at: now })
    .eq("id", ruleId)
    .in("status", ["needs_review", "retired"])
    .is("deleted_at", null)
    .select("id, deleted_at")
    .maybeSingle();

  if (error) throw new WorkspaceRulesError("Failed to delete the rule.", "DELETE_FAILED", 500);
  if (!data) throw new WorkspaceRulesError("Rule was not available to delete.", "DELETE_NOT_ALLOWED", 409);
  return { id: data.id as string, deletedAt: (data.deleted_at as string | null) ?? now };
}

export async function archiveWorkspaceRule(ruleId: string): Promise<WorkspaceRule> {
  const { db } = await requireUser();
  const sourceRule = await readWorkspaceRuleForMutation(db, ruleId);
  if (sourceRule.status !== "active") {
    throw new WorkspaceRulesError("Only active rules can be archived.", "ARCHIVE_NOT_ALLOWED", 409);
  }

  const now = new Date().toISOString();
  const { data, error } = await db
    .from("workspace_rules")
    .update({ status: "retired", retired_at: now, updated_at: now })
    .eq("id", ruleId)
    .eq("status", "active")
    .is("deleted_at", null)
    .select(COLUMNS)
    .maybeSingle();

  if (error) throw new WorkspaceRulesError("Failed to archive the rule.", "ARCHIVE_FAILED", 500);
  if (!data) throw new WorkspaceRulesError("Rule was not available to archive.", "ARCHIVE_NOT_ALLOWED", 409);
  return mapRow(data as unknown as Row);
}

export async function restoreArchivedWorkspaceRule(ruleId: string): Promise<WorkspaceRule> {
  const { db } = await requireUser();
  const sourceRule = await readWorkspaceRuleForMutation(db, ruleId);
  if (sourceRule.status !== "retired") {
    throw new WorkspaceRulesError("Only archived rules can be restored.", "RESTORE_NOT_ALLOWED", 409);
  }

  const { data, error } = await db
    .from("workspace_rules")
    .update({
      status: "needs_review",
      promoted_at: null,
      retired_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", ruleId)
    .eq("status", "retired")
    .is("deleted_at", null)
    .select(COLUMNS)
    .maybeSingle();

  if (error) throw new WorkspaceRulesError("Failed to restore the archived rule.", "RESTORE_FAILED", 500);
  if (!data) throw new WorkspaceRulesError("Rule was not available to restore.", "RESTORE_NOT_ALLOWED", 409);
  return mapRow(data as unknown as Row);
}

/**
 * Best-effort audit entry for a human decision that promotes a rule to
 * active. Never blocks the promotion itself -- the rule is already promoted
 * by the time this runs -- but its absence was previously a real gap: rule
 * promotion is the product's central "a human decided this" moment, and it
 * wrote no record to the tamper-evident chain at all.
 */
async function auditRulePromotion(workspaceId: string, ruleId: string, title: string, actorId: string, targetConnectionId?: string): Promise<void> {
  try {
    await appendAuditLogEntry({
      workspaceId,
      action: "rule_promoted",
      actorKind: "human",
      actorId,
      payload: { ruleId, title, ...(targetConnectionId ? { targetConnectionId } : {}) },
    });
  } catch (error) {
    console.error(`Audit log append failed for action "rule_promoted" in workspace ${workspaceId}:`, error instanceof Error ? error.message : error);
  }
}

export async function promoteWorkspaceRule(ruleId: string): Promise<WorkspaceRule> {
  const { db, user } = await requireUser();
  const sourceRule = await readWorkspaceRuleForMutation(db, ruleId);
  if (sourceRule.status !== "needs_review") {
    throw new WorkspaceRulesError("Only needs-review rules can be promoted.", "PROMOTE_NOT_ALLOWED", 409);
  }
  await assertCanActivateRule(db, user.id, sourceRule.workspace_id);

  const now = new Date().toISOString();
  const { data, error } = await db
    .from("workspace_rules")
    .update({ status: "active", promoted_at: now, retired_at: null, updated_at: now })
    .eq("id", ruleId)
    .eq("status", "needs_review")
    .is("deleted_at", null)
    .select(COLUMNS)
    .maybeSingle();

  if (error) throw new WorkspaceRulesError("Failed to promote rule.", "PROMOTE_FAILED", 500);
  if (!data) throw new WorkspaceRulesError("Rule was not available to promote.", "PROMOTE_NOT_ALLOWED", 409);
  const rule = mapRow(data as unknown as Row);
  await auditRulePromotion(rule.workspaceId, rule.id, rule.title, user.id);
  return rule;
}

/**
 * Promote a reviewed rule for a specific approved agent connection. The target
 * connection's workspace is the source of truth for what `npx m9r-cli rules`
 * can fetch. If the reviewed rule came from another workspace owned by the
 * same signed-in user, copy it into the target workspace as active while
 * preserving source session provenance.
 */
export async function promoteWorkspaceRuleForAgentConnection(
  ruleId: string,
  targetConnectionId: string,
): Promise<WorkspaceRule> {
  if (!targetConnectionId?.trim()) {
    throw new WorkspaceRulesError("Select a connected agent workspace before promoting this rule.", "TARGET_REQUIRED", 400);
  }

  const { db, user } = await requireUser();
  const { data: target, error: targetError } = await db
    .from("agent_connections")
    .select("id, workspace_id, agent_kind, status")
    .eq("id", targetConnectionId.trim())
    .eq("status", "active")
    .maybeSingle();

  if (targetError) throw new WorkspaceRulesError("Failed to resolve target agent workspace.", "TARGET_LOOKUP_FAILED", 500);
  if (!target) throw new WorkspaceRulesError("Target agent workspace was not found.", "TARGET_NOT_FOUND", 404);

  const targetWorkspaceId = (target as { workspace_id?: string | null }).workspace_id;
  if (!targetWorkspaceId) {
    throw new WorkspaceRulesError("Target agent connection has no workspace.", "TARGET_WORKSPACE_MISSING", 400);
  }

  const { data: source, error: sourceError } = await db
    .from("workspace_rules")
    .select(COLUMNS)
    .eq("id", ruleId)
    .is("deleted_at", null)
    .maybeSingle();

  if (sourceError) throw new WorkspaceRulesError("Failed to read the reviewed rule.", "RULE_LOOKUP_FAILED", 500);
  if (!source) throw new WorkspaceRulesError("Rule not found.", "NOT_FOUND", 404);

  const sourceRule = source as unknown as Row;
  if (sourceRule.status !== "needs_review") {
    throw new WorkspaceRulesError("Only needs-review rules can be promoted.", "PROMOTE_NOT_ALLOWED", 409);
  }
  await assertCanActivateRule(db, user.id, targetWorkspaceId);
  const now = new Date().toISOString();

  if (sourceRule.workspace_id === targetWorkspaceId) {
    const { data, error } = await db
      .from("workspace_rules")
      .update({ status: "active", promoted_at: now, retired_at: null, updated_at: now })
      .eq("id", ruleId)
      .is("deleted_at", null)
      .select(COLUMNS)
      .maybeSingle();
    if (error) throw new WorkspaceRulesError("Failed to promote rule for this agent workspace.", "PROMOTE_FAILED", 500);
    if (!data) throw new WorkspaceRulesError("Rule not found.", "NOT_FOUND", 404);
    const rule = mapRow(data as unknown as Row);
    await auditRulePromotion(rule.workspaceId, rule.id, rule.title, user.id, targetConnectionId);
    return rule;
  }

  const { data: existing, error: existingError } = await db
    .from("workspace_rules")
    .select(COLUMNS)
    .eq("workspace_id", targetWorkspaceId)
    .eq("title", sourceRule.title)
    .is("deleted_at", null)
    .maybeSingle();

  if (existingError) throw new WorkspaceRulesError("Failed to check target workspace rules.", "TARGET_RULE_LOOKUP_FAILED", 500);
  if (existing) {
    const existingRule = existing as unknown as Row;
    const { data, error } = await db
      .from("workspace_rules")
      .update({
        status: "active",
        body: sourceRule.body,
        rule_type: sourceRule.rule_type,
        confidence: sourceRule.confidence,
        evidence_summary: sourceRule.evidence_summary,
        source_report_id: sourceRule.source_report_id,
        source_session_name: sourceRule.source_session_name,
        source_finding_id: sourceRule.source_finding_id,
        expected_prevention: sourceRule.expected_prevention,
        promoted_at: existingRule.promoted_at ?? now,
        retired_at: null,
        updated_at: now,
      })
      .eq("id", existingRule.id)
      .select(COLUMNS)
      .maybeSingle();
    if (error) throw new WorkspaceRulesError("Failed to update target workspace rule.", "PROMOTE_FAILED", 500);
    if (!data) throw new WorkspaceRulesError("Rule not found.", "NOT_FOUND", 404);
    const rule = mapRow(data as unknown as Row);
    await auditRulePromotion(rule.workspaceId, rule.id, rule.title, user.id, targetConnectionId);
    return rule;
  }

  const { data: inserted, error: insertError } = await db
    .from("workspace_rules")
    .insert({
      workspace_id: targetWorkspaceId,
      created_by: user.id,
      source_report_id: sourceRule.source_report_id,
      source_session_name: sourceRule.source_session_name,
      title: sourceRule.title,
      body: sourceRule.body,
      rule_type: sourceRule.rule_type,
      confidence: sourceRule.confidence,
      status: "active",
      evidence_summary: sourceRule.evidence_summary,
      source_finding_id: sourceRule.source_finding_id,
      expected_prevention: sourceRule.expected_prevention,
      promoted_at: now,
      last_seen_at: now,
      times_seen: Math.max(1, sourceRule.times_seen ?? 0),
      notes: sourceRule.workspace_id === targetWorkspaceId ? sourceRule.notes : `Adopted from reviewed rule ${sourceRule.id}.`,
    })
    .select(COLUMNS)
    .single();

  if (insertError) throw new WorkspaceRulesError("Failed to promote rule into the selected agent workspace.", "PROMOTE_FAILED", 500);
  const rule = mapRow(inserted as unknown as Row);
  await auditRulePromotion(rule.workspaceId, rule.id, rule.title, user.id, targetConnectionId);
  return rule;
}

export const retireWorkspaceRule = (ruleId: string) => updateWorkspaceRuleStatus(ruleId, "retired");
export const markRuleNeedsReview = (ruleId: string) => updateWorkspaceRuleStatus(ruleId, "needs_review");

/** Apply a previously evaluated health decision; never auto-promotes or retires. */
export async function applyRuleEffectivenessDecision(decision: RuleEffectivenessDecision): Promise<void> {
  if (!decision.ruleId) throw new WorkspaceRulesError("Rule id is required.", "BAD_INPUT", 400);
  if (decision.action === "increment_helped") {
    await markRuleHelped(decision.ruleId);
  } else if (decision.action === "mark_needs_review") {
    await markRuleNeedsReview(decision.ruleId);
  }
}

/** Rewrite a rule's title and/or body (curation: sharpen a vague rule). */
export async function updateWorkspaceRuleText(
  ruleId: string,
  input: { title?: string; body?: string },
): Promise<WorkspaceRule> {
  const title = input.title;
  const body = input.body;
  if (typeof title === "string" && !title.trim()) {
    throw new WorkspaceRulesError("Rule title cannot be empty.", "BAD_INPUT", 400);
  }
  if (typeof body === "string" && !body.trim()) {
    throw new WorkspaceRulesError("Rule body cannot be empty.", "BAD_INPUT", 400);
  }
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof title === "string") patch.title = title.trim();
  if (typeof body === "string") patch.body = body.trim();
  if (!("title" in patch) && !("body" in patch)) {
    throw new WorkspaceRulesError("Nothing to update.", "BAD_INPUT", 400);
  }

  const { db } = await requireUser();
  const { data, error } = await db
    .from("workspace_rules")
    .update(patch)
    .eq("id", ruleId)
    .is("deleted_at", null)
    .select(COLUMNS)
    .maybeSingle();
  if (error) throw new WorkspaceRulesError("Failed to update the rule.", "UPDATE_FAILED", 500);
  if (!data) throw new WorkspaceRulesError("Rule not found.", "NOT_FOUND", 404);
  return mapRow(data as unknown as Row);
}

export const updateWorkspaceRuleBody = (ruleId: string, body: string) =>
  updateWorkspaceRuleText(ruleId, { body });

/** Mark a rule as having helped (used by before/after comparison curation). */
export async function markRuleHelped(ruleId: string): Promise<void> {
  const { db } = await requireUser();
  const { data } = await db.from("workspace_rules").select("times_helped").eq("id", ruleId).maybeSingle();
  const next = ((data as { times_helped?: number } | null)?.times_helped ?? 0) + 1;
  await db.from("workspace_rules").update({ times_helped: next, updated_at: new Date().toISOString() }).eq("id", ruleId);
}

/** Bump times_exported for the given rule ids (best-effort, used on export). */
export async function incrementRuleExportCount(ruleIds: string[]): Promise<void> {
  if (ruleIds.length === 0) return;
  const { db } = await requireUser();
  const { data } = await db.from("workspace_rules").select("id, times_exported").in("id", ruleIds);
  for (const row of (data ?? []) as Array<{ id: string; times_exported: number | null }>) {
    await db
      .from("workspace_rules")
      .update({ times_exported: (row.times_exported ?? 0) + 1 })
      .eq("id", row.id);
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Export the workspace's ACTIVE rules (plus needs-review when requested) in the
 * requested format. Bumps times_exported for the included rules. Retired/low-
 * confidence rules are always excluded.
 */
export async function exportWorkspaceRules(
  format: RulesFileFormat,
  opts: { workspaceId?: string; workspaceName?: string | null; includeNeedsReview?: boolean } = {},
): Promise<RulesFile> {
  const { db, user } = await requireUser();
  const wsId = await resolveWorkspace(db, user, opts.workspaceId);
  const all = await listWorkspaceRulesFor(db, wsId);

  // GeneratedRule shape is a structural subset of WorkspaceRule, so the export
  // generator (which only reads status/ruleType/body/etc.) accepts these as-is.
  const file = generateRulesFile(format, all as unknown as GeneratedRule[], {
    scope: "workspace",
    workspaceName: opts.workspaceName ?? null,
    includeNeedsReview: opts.includeNeedsReview,
  });

  // Best-effort export counters for the rules actually included.
  const included = all.filter(
    (r) => r.status === "active" || (opts.includeNeedsReview && r.status === "needs_review"),
  );
  await incrementRuleExportCount(included.map((r) => r.id)).catch(() => {});

  return file;
}
