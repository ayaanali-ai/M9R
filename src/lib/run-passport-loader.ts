import { getAgentRunForUser, type DashboardRun } from "@/lib/agent-run-service";
import {
  buildRunPassport,
  type PassportActiveRuleInput,
  type PassportSessionInput,
  type RunPassport,
} from "@/lib/run-passport-service";
import {
  REVIEW_DECISION_EVENT_TYPE,
  humanReviewFromEvents,
  type HumanRunReview,
  type RunReviewEventRow,
} from "@/lib/run-review-decision-service";
import { createClient } from "@/lib/supabase/server";
import { EVIDENCE_CONTRACT_SCHEMA_VERSION, type EvidenceContract } from "@/lib/evidence-contract";
import { readGithubLinksForRun } from "@/lib/github-link-service";

/**
 * Run Passport loader (server-only, cookie-scoped)
 * ----------------------------------------------------------------------------
 * One read path for the Run Passport, shared by the dashboard API route and the
 * /dashboard/runs/[id] record page. Everything goes through the signed-in
 * user's RLS scope; it never reads raw session content and never returns rule
 * bodies.
 */

type CookieDb = NonNullable<Awaited<ReturnType<typeof createClient>>>;

function isMissingColumnError(error: { code?: string | null; message?: string | null }): boolean {
  return error.code === "42703" || /column .* does not exist/i.test(error.message ?? "");
}

async function readActiveRuleMetadata(db: CookieDb, workspaceId: string | null): Promise<PassportActiveRuleInput[]> {
  if (!workspaceId) return [];

  const { data, error } = await db
    .from("workspace_rules")
    .select("id, title, status, deleted_at")
    .eq("workspace_id", workspaceId)
    .eq("status", "active")
    .is("deleted_at", null)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return ((data ?? []) as Array<{ id: string; title: string | null; status: string | null; deleted_at: string | null }>).map(
    (rule) => ({
      id: rule.id,
      title: rule.title ?? "Untitled rule",
      status: rule.status,
      deleted_at: rule.deleted_at,
    }),
  );
}

async function readSessionSnapshotMetadata(db: CookieDb, sessionId: string | null): Promise<PassportSessionInput | null> {
  if (!sessionId) return null;

  const { data, error } = await db
    .from("agent_sessions")
    .select("id, created_at, source_quality, human_approved_submission, rule_health, behavior")
    .eq("id", sessionId)
    .maybeSingle();

  if (error) {
    if (isMissingColumnError(error)) return null;
    throw error;
  }
  if (!data) return null;

  const row = data as {
    id: string;
    created_at?: string | null;
    source_quality?: string | null;
    human_approved_submission?: boolean | null;
    rule_health?: PassportSessionInput["rule_health"];
    behavior?: PassportSessionInput["behavior"];
  };

  return {
    id: row.id,
    created_at: row.created_at ?? null,
    source_quality: row.source_quality ?? null,
    human_approved_submission: row.human_approved_submission ?? null,
    rule_health: row.rule_health ?? null,
    behavior: row.behavior ?? null,
  };
}

async function readHumanReviewMetadata(db: CookieDb, runId: string): Promise<HumanRunReview> {
  const { data, error } = await db
    .from("agent_run_events")
    .select("event_type, message, created_at")
    .eq("run_id", runId)
    .eq("event_type", REVIEW_DECISION_EVENT_TYPE)
    .order("created_at", { ascending: false })
    .limit(5);

  if (error) throw error;
  return humanReviewFromEvents((data ?? []) as RunReviewEventRow[]);
}

/**
 * Read the most recently recorded Evidence Contract for a run, if any. Rows in
 * evidence_records are already-validated contracts (see evidence-contract.ts
 * and recordEvidenceContract) — this is a trust read, not re-validation.
 */
async function readEvidenceContractMetadata(db: CookieDb, runId: string): Promise<EvidenceContract | null> {
  const { data, error } = await db
    .from("evidence_records")
    .select("contract")
    .eq("run_id", runId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    // 42P01 = raw Postgres undefined_table; PGRST205 = PostgREST's "table not
    // found in schema cache," which is what actually surfaces in practice when
    // a migration hasn't been applied yet.
    if (isMissingColumnError(error) || error.code === "42P01" || error.code === "PGRST205") return null;
    throw error;
  }
  if (!data) return null;

  const contract = data.contract as { schemaVersion?: unknown } | null;
  if (!contract || contract.schemaVersion !== EVIDENCE_CONTRACT_SCHEMA_VERSION) return null;
  return contract as EvidenceContract;
}

export interface LoadedRunPassport {
  run: DashboardRun;
  passport: RunPassport;
}

/**
 * Load the run (owner-scoped) and build its Run Passport. Returns null when the
 * run does not exist for this user or M9R is not configured.
 */
export async function loadRunPassportForUser(runId: string): Promise<LoadedRunPassport | null> {
  const run = await getAgentRunForUser(runId);
  if (!run) return null;

  const db = await createClient();
  if (!db) return null;

  const [activeRules, session, humanReview, evidenceContract, githubLinks] = await Promise.all([
    readActiveRuleMetadata(db, run.workspace_id),
    readSessionSnapshotMetadata(db, run.latest_session_id),
    readHumanReviewMetadata(db, run.id),
    readEvidenceContractMetadata(db, run.id),
    readGithubLinksForRun(run.id),
  ]);
  const passport = buildRunPassport({ run, session, activeRules, humanReview, evidenceContract, githubLinks });

  return { run, passport };
}
