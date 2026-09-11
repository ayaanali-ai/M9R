import "server-only";

import type { DashboardRun } from "@/lib/agent-run-service";
import {
  buildRunPassport,
  type PassportSessionInput,
  type RunPassport,
} from "@/lib/run-passport-service";
import {
  REVIEW_DECISION_EVENT_TYPE,
  humanReviewFromEvents,
  type RunReviewEventRow,
} from "@/lib/run-review-decision-service";
import { createClient } from "@/lib/supabase/server";
import type { WorkspaceRule } from "@/lib/workspace-rule-matching";

type CookieDb = NonNullable<Awaited<ReturnType<typeof createClient>>>;

type SessionSnapshotRow = {
  id: string;
  created_at: string | null;
  source_quality: string | null;
  human_approved_submission: boolean | null;
  rule_health?: PassportSessionInput["rule_health"];
  behavior?: PassportSessionInput["behavior"];
};

type ReviewEventWithRun = RunReviewEventRow & {
  run_id: string;
};

async function readSessionSnapshots(
  db: CookieDb,
  sessionIds: string[],
): Promise<Map<string, SessionSnapshotRow>> {
  if (sessionIds.length === 0) return new Map();

  const full = await db
    .from("agent_sessions")
    .select("id, created_at, source_quality, human_approved_submission, rule_health, behavior")
    .in("id", sessionIds);

  let rows: SessionSnapshotRow[] = [];
  if (!full.error) {
    rows = (full.data ?? []) as SessionSnapshotRow[];
  } else if (full.error.code === "42703" || /column .* does not exist/i.test(full.error.message ?? "")) {
    const fallback = await db
      .from("agent_sessions")
      .select("id, created_at, source_quality, human_approved_submission")
      .in("id", sessionIds);
    if (!fallback.error) rows = (fallback.data ?? []) as SessionSnapshotRow[];
  }

  return new Map(rows.map((row) => [row.id, row]));
}

async function readReviewEvents(
  db: CookieDb,
  runIds: string[],
): Promise<Map<string, ReviewEventWithRun[]> | null> {
  if (runIds.length === 0) return new Map();

  const { data, error } = await db
    .from("agent_run_events")
    .select("run_id, event_type, message, created_at")
    .in("run_id", runIds)
    .eq("event_type", REVIEW_DECISION_EVENT_TYPE)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) return null;

  const byRun = new Map<string, ReviewEventWithRun[]>();
  for (const event of (data ?? []) as ReviewEventWithRun[]) {
    const events = byRun.get(event.run_id) ?? [];
    events.push(event);
    byRun.set(event.run_id, events);
  }
  return byRun;
}

export async function loadAgentApprovalData(input: {
  runs: DashboardRun[];
  activeRules: WorkspaceRule[];
}): Promise<{ passports: RunPassport[] }> {
  const db = await createClient();
  if (!db) return { passports: [] };

  const submittedRuns = input.runs.filter((run) => run.latest_session_id);
  const sessionIds = submittedRuns
    .map((run) => run.latest_session_id)
    .filter((id): id is string => Boolean(id));
  const runIds = submittedRuns.map((run) => run.id);

  const [sessionsById, reviewEventsByRun] = await Promise.all([
    readSessionSnapshots(db, sessionIds),
    readReviewEvents(db, runIds),
  ]);

  const passports = reviewEventsByRun ? submittedRuns.map((run) => {
    const snapshot = run.latest_session_id
      ? sessionsById.get(run.latest_session_id)
      : undefined;
    const session: PassportSessionInput | null = run.latest_session_id
      ? {
          id: run.latest_session_id,
          created_at: snapshot?.created_at ?? run.completed_at,
          source_quality: snapshot?.source_quality ?? null,
          human_approved_submission: snapshot?.human_approved_submission ?? null,
          rule_health: snapshot?.rule_health ?? null,
          behavior: snapshot?.behavior ?? null,
        }
      : null;
    const activeRules = input.activeRules
      .filter((rule) => rule.workspaceId === run.workspace_id && rule.status === "active")
      .map((rule) => ({
        id: rule.id,
        title: rule.title,
        status: rule.status,
        body: rule.body,
      }));
    const humanReview = humanReviewFromEvents(reviewEventsByRun.get(run.id));
    return buildRunPassport({ run, session, activeRules, humanReview });
  }) : [];

  return { passports };
}
