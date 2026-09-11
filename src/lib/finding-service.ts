/**
 * Finding Service — DB-facing writes/reads for Reviewed Findings (Phase 5).
 * ----------------------------------------------------------------------------
 * Same trust model as dispatch-service.ts / response-service.ts. The one extra
 * rule here: publishing a Finding is agent-initiated (service-role), but
 * moving it to `available` is an EXPLICIT HUMAN ACTION ONLY — never automatic,
 * never inferable from agent agreement (see AGENT_CANNOT_REVIEW_OWN_FINDING).
 */

import { supabase } from "@/lib/supabase";
import { createClient } from "@/lib/supabase/server";
import { AgentJoinError } from "@/lib/agent-join-service";
import { sendPushNotificationForUser } from "@/lib/push-notification-service";
import {
  validateFinding,
  type FindingInput,
  type FindingReviewState,
  type FindingEvidenceLevel,
  type AdoptionConfirmation,
} from "@/lib/finding";

function requireService() {
  if (!supabase) {
    throw new AgentJoinError("M9R agent backend is not configured.", "DB_NOT_CONFIGURED", 503);
  }
  return supabase;
}

function isMissingTableError(err: { code?: string | null; message?: string | null } | null): boolean {
  if (!err) return false;
  return err.code === "42P01" || err.code === "PGRST205" || /Could not find the table/i.test(err.message ?? "");
}

/**
 * Best-effort append to the tamper-evident audit log (see audit-log.ts) —
 * evidence and findings are the product's actual differentiator, so a write
 * to either gets the same hash-chained record mission-domain actions already
 * do (mission-application-service.ts's auditLog). Never blocks or fails the
 * finding write itself if the chain append has a problem.
 */
async function auditLog(input: {
  workspaceId: string;
  action: string;
  actorKind: "human" | "agent" | "system";
  actorId: string | null;
  payload: Record<string, unknown>;
}): Promise<void> {
  try {
    const { appendAuditLogEntry } = await import("@/lib/audit-log");
    await appendAuditLogEntry(input);
  } catch (error) {
    console.error(`Audit log append failed for action "${input.action}" in workspace ${input.workspaceId}:`, error instanceof Error ? error.message : error);
  }
}

/**
 * Push-to-decision notification for a newly published Finding: the workspace
 * owner gets Approve/Reject buttons that hit the promote-to-rule and retire
 * endpoints directly from the notification, no tab required. Best-effort --
 * never blocks or fails the finding write itself.
 */
async function pushFindingReadyForReview(
  db: NonNullable<ReturnType<typeof requireService>>,
  workspaceId: string,
  findingId: string,
  title: string,
): Promise<void> {
  const { data: project } = await db.from("projects").select("owner_id").eq("id", workspaceId).maybeSingle();
  const ownerId = (project as { owner_id?: string } | null)?.owner_id;
  if (!ownerId) return;

  await sendPushNotificationForUser(db, ownerId, {
    title: "Finding ready for review",
    body: title,
    url: "/dashboard/memory",
    tag: `oathlock-finding-${findingId}`,
    actions: [
      { action: "approve", title: "Approve & suggest rule" },
      { action: "reject", title: "Retire" },
    ],
    decide: {
      approve: { url: `/api/agent/findings/${findingId}/promote-to-rule`, body: { workspace_id: workspaceId } },
      reject: { url: `/api/agent/findings/${findingId}/review`, body: { decision: "retired", workspace_id: workspaceId } },
    },
  });
}

export interface PublishFindingResult {
  ok: boolean;
  id: string | null;
  errors: string[];
}

export async function publishFinding(input: FindingInput): Promise<PublishFindingResult> {
  const result = validateFinding(input);
  if (!result.ok || !result.normalized) {
    return { ok: false, id: null, errors: result.errors.map((e) => `${e.field}: ${e.message}`) };
  }
  const f = result.normalized;

  try {
    const db = requireService();
    const { data, error } = await db
      .from("findings")
      .insert({
        workspace_id: f.workspaceId,
        originating_run_id: f.originatingRunId,
        originating_sender: f.originatingSender,
        schema_version: f.schemaVersion,
        title: f.title,
        applicable_environment: f.applicableEnvironment,
        observed_behavior: f.observedBehavior,
        evidence_level: f.evidenceLevel,
        suggested_response: f.suggestedResponse,
        known_limitations: f.knownLimitations,
        review_state: f.reviewState,
      })
      .select("id")
      .single();

    if (error) {
      if (isMissingTableError(error)) return { ok: true, id: null, errors: [] };
      console.error("publishFinding failed:", error.message, error.code);
      return { ok: false, id: null, errors: [error.message] };
    }
    const findingId = (data as { id: string }).id;
    await auditLog({
      workspaceId: f.workspaceId,
      action: "finding_published",
      actorKind: "agent",
      actorId: f.originatingSender,
      payload: { findingId, originatingRunId: f.originatingRunId, title: f.title, evidenceLevel: f.evidenceLevel },
    });
    void pushFindingReadyForReview(db, f.workspaceId, findingId, f.title).catch(() => undefined);
    return { ok: true, id: findingId, errors: [] };
  } catch (err) {
    console.error("publishFinding threw:", err instanceof Error ? err.message : err);
    return { ok: false, id: null, errors: ["Finding publish failed."] };
  }
}

/** Links a Finding to the chat message that announced it, for the inline Approve/Reject card. */
export async function attachFindingAnnouncementMessage(id: string, workspaceId: string, messageId: string): Promise<void> {
  const db = requireService();
  const { error } = await db.from("findings").update({ announcement_message_id: messageId }).eq("id", id).eq("workspace_id", workspaceId);
  if (error && !isMissingTableError(error)) throw new Error(`Could not attach the finding to its message: ${error.message}`);
}

/**
 * Move a Finding to `available` or `retired`. Cookie-authenticated ONLY — this
 * is the human review gate; there is no agent-callable path to this function.
 * Ownership is enforced by the caller passing an already RLS-scoped cookie db.
 */
export async function reviewFinding(
  workspaceId: string,
  findingId: string,
  decision: Extract<FindingReviewState, "available" | "retired">,
  reviewerUserId: string | null = null,
): Promise<{ ok: boolean; error?: string }> {
  const db = requireService();
  const { error } = await db
    .from("findings")
    .update({ review_state: decision, reviewed_at: new Date().toISOString() })
    .eq("id", findingId)
    .eq("workspace_id", workspaceId);
  if (error) {
    if (isMissingTableError(error)) return { ok: true };
    return { ok: false, error: error.message };
  }
  await auditLog({
    workspaceId,
    action: "finding_reviewed",
    actorKind: "human",
    actorId: reviewerUserId,
    payload: { findingId, decision },
  });
  return { ok: true };
}

/**
 * Record that a later run cited an available Finding. Only Findings already
 * in `available` state can be adopted — an agent cannot adopt its own
 * unreviewed observation and call it reused knowledge.
 */
export async function recordAdoption(input: {
  findingId: string;
  workspaceId: string;
  adoptingRunId: string;
  confirmation?: AdoptionConfirmation | null;
}): Promise<{ ok: boolean; error?: string }> {
  const db = requireService();

  // Scoped to the adopting run's own workspace, matching every other
  // Finding lookup in this file (reviewFinding, listAvailableFindingsForWorkspace) --
  // requireService() bypasses RLS, so without this an agent could adopt
  // (cite) another workspace's Finding by id alone.
  const { data: finding, error: findingError } = await db
    .from("findings")
    .select("id, review_state")
    .eq("id", input.findingId)
    .eq("workspace_id", input.workspaceId)
    .maybeSingle();
  if (findingError) {
    if (isMissingTableError(findingError)) return { ok: true };
    return { ok: false, error: findingError.message };
  }
  if (!finding) return { ok: false, error: "Finding not found." };
  if ((finding as { review_state: string }).review_state !== "available") {
    return { ok: false, error: "Only available (human-reviewed) Findings can be adopted." };
  }

  const { error } = await db.from("findings_adoptions").insert({
    finding_id: input.findingId,
    adopting_run_id: input.adoptingRunId,
    confirmation: input.confirmation ?? null,
  });
  if (error) {
    // Unique violation = already adopted by this run; treat as a no-op success.
    if (error.code === "23505") return { ok: true };
    if (isMissingTableError(error)) return { ok: true };
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

export interface FindingView {
  id: string;
  workspaceId?: string;
  originatingRunId: string;
  originatingSender: string;
  title: string;
  applicableEnvironment: string;
  observedBehavior: string;
  evidenceLevel: FindingEvidenceLevel;
  suggestedResponse: string;
  knownLimitations: string[];
  reviewState: FindingReviewState;
  createdAt: string;
}

/** Findings visible in the dashboard (RLS-scoped to the signed-in user's workspaces). */
export async function listFindingsForUser(opts: { onlyAvailable?: boolean } = {}): Promise<FindingView[]> {
  const db = await createClient();
  if (!db) return [];
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return [];

  let query = db
    .from("findings")
    .select(
      // workspace_id travels with the row because the review POST requires it
      // as proof-of-ownership -- without it the Memory client would have to
      // re-query ownership per flagged item.
      "id, workspace_id, originating_run_id, originating_sender, title, applicable_environment, observed_behavior, evidence_level, suggested_response, known_limitations, review_state, created_at",
    )
    .order("created_at", { ascending: false })
    .limit(100);
  if (opts.onlyAvailable) query = query.eq("review_state", "available");

  const { data, error } = await query;
  if (error) {
    if (isMissingTableError(error)) return [];
    throw error;
  }

  return ((data ?? []) as Array<{
    id: string;
    workspace_id: string;
    originating_run_id: string;
    originating_sender: string;
    title: string;
    applicable_environment: string;
    observed_behavior: string;
    evidence_level: string;
    suggested_response: string;
    known_limitations: string[] | null;
    review_state: string;
    created_at: string;
  }>).map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    originatingRunId: row.originating_run_id,
    originatingSender: row.originating_sender,
    title: row.title,
    applicableEnvironment: row.applicable_environment,
    observedBehavior: row.observed_behavior,
    evidenceLevel: row.evidence_level as FindingEvidenceLevel,
    suggestedResponse: row.suggested_response,
    knownLimitations: row.known_limitations ?? [],
    reviewState: row.review_state as FindingReviewState,
    createdAt: row.created_at,
  }));
}

/** Same as listFindingsForUser, but for the Bearer-authenticated (agent) path — a Brief source. */
export async function listAvailableFindingsForWorkspace(workspaceId: string, limit = 20): Promise<FindingView[]> {
  const db = requireService();
  const { data, error } = await db
    .from("findings")
    .select(
      "id, originating_run_id, originating_sender, title, applicable_environment, observed_behavior, evidence_level, suggested_response, known_limitations, review_state, created_at",
    )
    .eq("workspace_id", workspaceId)
    .eq("review_state", "available")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    if (isMissingTableError(error)) return [];
    throw error;
  }

  return ((data ?? []) as Array<{
    id: string;
    originating_run_id: string;
    originating_sender: string;
    title: string;
    applicable_environment: string;
    observed_behavior: string;
    evidence_level: string;
    suggested_response: string;
    known_limitations: string[] | null;
    review_state: string;
    created_at: string;
  }>).map((row) => ({
    id: row.id,
    originatingRunId: row.originating_run_id,
    originatingSender: row.originating_sender,
    title: row.title,
    applicableEnvironment: row.applicable_environment,
    observedBehavior: row.observed_behavior,
    evidenceLevel: row.evidence_level as FindingEvidenceLevel,
    suggestedResponse: row.suggested_response,
    knownLimitations: row.known_limitations ?? [],
    reviewState: row.review_state as FindingReviewState,
    createdAt: row.created_at,
  }));
}

/**
 * Observed (not yet human-reviewed) Findings for one workspace — service-role,
 * workspace-scoped read. Feeds the Approval Center queue the same way
 * `listAvailableFindingsForWorkspace` feeds Brief sources: the caller already
 * proved workspace ownership via the cookie-scoped dashboard query before
 * passing the workspaceId in.
 */
export async function listObservedFindingsForWorkspace(workspaceId: string, limit = 50): Promise<FindingView[]> {
  const db = requireService();
  const { data, error } = await db
    .from("findings")
    .select(
      "id, workspace_id, originating_run_id, originating_sender, title, applicable_environment, observed_behavior, evidence_level, suggested_response, known_limitations, review_state, created_at",
    )
    .eq("workspace_id", workspaceId)
    .eq("review_state", "observed")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    if (isMissingTableError(error)) return [];
    throw error;
  }

  return ((data ?? []) as Array<{
    id: string;
    workspace_id: string;
    originating_run_id: string;
    originating_sender: string;
    title: string;
    applicable_environment: string;
    observed_behavior: string;
    evidence_level: string;
    suggested_response: string;
    known_limitations: string[] | null;
    review_state: string;
    created_at: string;
  }>).map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    originatingRunId: row.originating_run_id,
    originatingSender: row.originating_sender,
    title: row.title,
    applicableEnvironment: row.applicable_environment,
    observedBehavior: row.observed_behavior,
    evidenceLevel: row.evidence_level as FindingEvidenceLevel,
    suggestedResponse: row.suggested_response,
    knownLimitations: row.known_limitations ?? [],
    reviewState: row.review_state as FindingReviewState,
    createdAt: row.created_at,
  }));
}

/** Findings originated by one run (RLS-scoped read) — used by workgraph.ts. */
export async function listFindingsForRun(runId: string): Promise<FindingView[]> {
  const db = await createClient();
  if (!db) return [];
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return [];

  const { data, error } = await db
    .from("findings")
    .select(
      "id, originating_run_id, originating_sender, title, applicable_environment, observed_behavior, evidence_level, suggested_response, known_limitations, review_state, created_at",
    )
    .eq("originating_run_id", runId)
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    if (isMissingTableError(error)) return [];
    throw error;
  }

  return ((data ?? []) as Array<{
    id: string;
    originating_run_id: string;
    originating_sender: string;
    title: string;
    applicable_environment: string;
    observed_behavior: string;
    evidence_level: string;
    suggested_response: string;
    known_limitations: string[] | null;
    review_state: string;
    created_at: string;
  }>).map((row) => ({
    id: row.id,
    originatingRunId: row.originating_run_id,
    originatingSender: row.originating_sender,
    title: row.title,
    applicableEnvironment: row.applicable_environment,
    observedBehavior: row.observed_behavior,
    evidenceLevel: row.evidence_level as FindingEvidenceLevel,
    suggestedResponse: row.suggested_response,
    knownLimitations: row.known_limitations ?? [],
    reviewState: row.review_state as FindingReviewState,
    createdAt: row.created_at,
  }));
}

/** Findings this run adopted (via findings_adoptions) — used by workgraph.ts. */
export async function listFindingsAdoptedByRun(runId: string): Promise<FindingView[]> {
  const db = await createClient();
  if (!db) return [];
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return [];

  const { data: adoptionRows, error: adoptionError } = await db
    .from("findings_adoptions")
    .select("finding_id")
    .eq("adopting_run_id", runId);
  if (adoptionError) {
    if (isMissingTableError(adoptionError)) return [];
    throw adoptionError;
  }
  const findingIds = (adoptionRows ?? []).map((r) => (r as { finding_id: string }).finding_id);
  if (findingIds.length === 0) return [];

  const { data, error } = await db
    .from("findings")
    .select(
      "id, originating_run_id, originating_sender, title, applicable_environment, observed_behavior, evidence_level, suggested_response, known_limitations, review_state, created_at",
    )
    .in("id", findingIds);
  if (error) {
    if (isMissingTableError(error)) return [];
    throw error;
  }

  return ((data ?? []) as Array<{
    id: string;
    originating_run_id: string;
    originating_sender: string;
    title: string;
    applicable_environment: string;
    observed_behavior: string;
    evidence_level: string;
    suggested_response: string;
    known_limitations: string[] | null;
    review_state: string;
    created_at: string;
  }>).map((row) => ({
    id: row.id,
    originatingRunId: row.originating_run_id,
    originatingSender: row.originating_sender,
    title: row.title,
    applicableEnvironment: row.applicable_environment,
    observedBehavior: row.observed_behavior,
    evidenceLevel: row.evidence_level as FindingEvidenceLevel,
    suggestedResponse: row.suggested_response,
    knownLimitations: row.known_limitations ?? [],
    reviewState: row.review_state as FindingReviewState,
    createdAt: row.created_at,
  }));
}

export interface AdoptionCounts {
  totalAdoptions: number;
  confirmed: number;
  contradicted: number;
}

/** Adoption counts for one Finding — feeds summarizeAdoptions() in finding.ts. */
export async function countAdoptions(findingId: string): Promise<AdoptionCounts> {
  const db = await createClient();
  const empty = { totalAdoptions: 0, confirmed: 0, contradicted: 0 };
  if (!db) return empty;

  const { data, error } = await db.from("findings_adoptions").select("confirmation").eq("finding_id", findingId);
  if (error) {
    if (isMissingTableError(error)) return empty;
    throw error;
  }
  const rows = (data ?? []) as Array<{ confirmation: string | null }>;
  return {
    totalAdoptions: rows.length,
    confirmed: rows.filter((r) => r.confirmation === "confirmed").length,
    contradicted: rows.filter((r) => r.confirmation === "contradicted").length,
  };
}
