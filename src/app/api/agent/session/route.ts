import { NextRequest, NextResponse } from "next/server";
import { containsActiveContent, sanitizeString } from "@/lib/agent-join";
import {
  authenticateAgent,
  bearerFrom,
  recordAgentSession,
  recordRecommendedRulesForAgent,
  applyRuleEffectivenessForAgent,
  type AuthedAgent,
} from "@/lib/agent-join-service";
import { linkSessionToRun, recordEvidenceContract, publishRunDispatch } from "@/lib/agent-run-service";
import { analyzeAgentSession, buildAgentSessionResponse } from "@/lib/agent-session-analysis";
import { deriveRuleEffectiveness } from "@/lib/rule-effectiveness";
import { applyRuleEffectivenessDecision } from "@/lib/workspace-rules-service";
import { loadCoordinationRuleCandidates } from "@/lib/coordination-rule-candidates";
import { validateEvidenceContract } from "@/lib/evidence-contract";
import { classifySubmission, decideAttachment, computeSubmissionDigest, DEFAULT_EVIDENCE_SUBMISSION_POLICY } from "@/lib/evidence-submission";
import { handleAgentError } from "../_shared";
import { createClient } from "@/lib/supabase/server";
import { supabase } from "@/lib/supabase";
import { resolveActiveOrDefaultProjectId } from "@/lib/projects-service";
import { sendPushNotificationForUser } from "@/lib/push-notification-service";

/**
 * Push-to-decision notification once an unreviewed agent submission links to
 * a run: the workspace owner gets Approve/Reject buttons that record the
 * review decision directly, no tab required. Best-effort -- never blocks or
 * fails the submission itself.
 */
async function pushEvidenceReadyForReview(workspaceId: string, runId: string): Promise<void> {
  if (!supabase) return;
  try {
    const [{ data: project }, { data: run }] = await Promise.all([
      supabase.from("projects").select("owner_id").eq("id", workspaceId).maybeSingle(),
      supabase.from("agent_runs").select("task_title").eq("id", runId).maybeSingle(),
    ]);
    const ownerId = (project as { owner_id?: string } | null)?.owner_id;
    if (!ownerId) return;
    const taskTitle = (run as { task_title?: string } | null)?.task_title ?? "";
    await sendPushNotificationForUser(supabase, ownerId, {
      title: "Agent evidence ready for approval",
      body: taskTitle || "A run is waiting on your review decision.",
      // No dedicated run page exists any more (Runs/Run Passports were cut as
      // user-facing destinations); the workspace chat is where review now
      // happens, via the Approve/Reject actions below.
      url: `/dashboard/agents`,
      tag: `oathlock-evidence-${runId}`,
      actions: [
        { action: "approve", title: "Approve" },
        { action: "reject", title: "Reject" },
      ],
      decide: {
        approve: { url: `/api/agent/runs/${runId}/review`, body: { decision: "reviewed" } },
        reject: { url: `/api/agent/runs/${runId}/review`, body: { decision: "not_accepted" } },
      },
    });
  } catch {
    // Best-effort only -- see doc comment.
  }
}

/**
 * Optional: validate + store a structured Evidence Contract alongside the
 * existing free-text session submission. Additive — a missing/invalid
 * contract never blocks the legacy free-text evidence path, it only means no
 * evidence_records row is written and a warning is returned. Runs that never
 * send `evidence_contract` are unaffected (legacy-record fallback).
 */
async function tryRecordEvidenceContract(input: {
  runId: string;
  workspaceId: string;
  sessionId: string | null;
  evidenceContract: unknown;
  agentKind?: string | null;
  humanApproved: boolean;
}): Promise<{ evidenceContractId: string | null; evidenceContractErrors: string[] }> {
  if (input.evidenceContract === undefined || input.evidenceContract === null) {
    return { evidenceContractId: null, evidenceContractErrors: [] };
  }
  // humanApproved must be the caller's own real, already-verified auth/consent
  // value -- never hardcoded true here. validateEvidenceContract already
  // refuses to record an unapproved contract; this function used to discard
  // that gate by always claiming approval regardless of the actual submission.
  const result = validateEvidenceContract(input.evidenceContract, { humanApprovedSubmission: input.humanApproved });
  if (!result.ok || !result.normalized) {
    return { evidenceContractId: null, evidenceContractErrors: result.errors.map((e) => `${e.field}: ${e.message}`) };
  }
  const stored = await recordEvidenceContract({
    runId: input.runId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    contract: result.normalized,
    warnings: result.warnings,
  });
  if (stored) {
    await publishRunDispatch(
      { workspaceId: input.workspaceId, agentKind: input.agentKind },
      input.runId,
      "EVIDENCE_READY",
      "Evidence Contract recorded",
    );
    // Best-effort tamper-evident record — same hash-chained audit log
    // mission-domain actions and Finding writes already append to. Never
    // blocks the evidence write itself if the chain append has a problem.
    try {
      const { appendAuditLogEntry } = await import("@/lib/audit-log");
      await appendAuditLogEntry({
        workspaceId: input.workspaceId,
        action: "evidence_contract_recorded",
        actorKind: "agent",
        actorId: input.agentKind ?? null,
        payload: { evidenceRecordId: stored.id, runId: input.runId, sessionId: input.sessionId },
      });
    } catch (error) {
      console.error(`Audit log append failed for action "evidence_contract_recorded" in workspace ${input.workspaceId}:`, error instanceof Error ? error.message : error);
    }
  }
  return { evidenceContractId: stored?.id ?? null, evidenceContractErrors: [] };
}

// ---------------------------------------------------------------------------
// POST /api/agent/session — submit an approved, redacted session for analysis.
//
// Requires a Bearer agent token + scope. human_approved_submission must be an
// explicit boolean: true records human-approved evidence; false lands the
// evidence as UNREVIEWED and leaves the run awaiting a human review decision.
// Reuses the EXISTING redaction → normalize → report → rules pipeline (via
// analyzeAgentSession) — it does not duplicate report logic. Raw session content
// is never logged or persisted; only honest metadata is stored.
//
// Dashboard cookie-auth submissions are accepted for the selected run so the
// Runs tab can submit approved evidence without a separate pipeline.
// ---------------------------------------------------------------------------

export const maxDuration = 60;

const MAX_SESSION_CHARS = 500_000; // matches the existing CLI cap.

type SessionBody = {
  run_id?: unknown;
  connection_id?: unknown;
  agent_kind?: unknown;
  session_text?: unknown;
  session_summary?: unknown;
  session_format?: unknown;
  redaction_status?: unknown;
  human_approved_submission?: unknown;
  rules_loaded?: unknown;
  rules_followed?: unknown;
  rules_violated?: unknown;
  evidence_contract?: unknown;
};

type CookieDb = NonNullable<Awaited<ReturnType<typeof createClient>>>;

function jsonError(error: string, status: number, extra: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json({ error, ...extra }, { status });
}

async function readJsonBody(req: NextRequest): Promise<SessionBody | NextResponse> {
  try {
    return (await req.json()) as SessionBody;
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }
}

function sessionTextFromBody(body: SessionBody): string {
  return typeof body.session_text === "string"
    ? body.session_text
    : typeof body.session_summary === "string"
      ? body.session_summary
      : "";
}

function buildAgentContext(run: { connection_id: string; workspace_id: string; agent_kind: string | null; repo_hint?: string | null }): AuthedAgent {
  return {
    connectionId: run.connection_id,
    workspaceId: run.workspace_id,
    agentKind: run.agent_kind as AuthedAgent["agentKind"],
    scopes: ["session:submit"],
    repoHint: run.repo_hint ?? null,
    tokenId: null,
  };
}

async function listActiveRulesForWorkspace(db: CookieDb, workspaceId: string) {
  const { data, error } = await db
    .from("workspace_rules")
    .select("id, title, body, status, deleted_at")
    .eq("workspace_id", workspaceId)
    .eq("status", "active")
    .is("deleted_at", null);

  if (error) throw error;
  return (data ?? []) as Array<{
    id: string;
    title: string | null;
    body: string | null;
    status: string | null;
    deleted_at: string | null;
  }>;
}

async function recordSubmission(
  agent: AuthedAgent,
  body: SessionBody,
  sessionText: string,
  rulesLoaded: unknown,
  humanApproved: boolean,
  origin: "human" | "agent",
): Promise<{
  response: NextResponse;
  responseBody: Awaited<ReturnType<typeof buildAgentSessionResponse>>;
  sessionId: string | null;
  analysis: Awaited<ReturnType<typeof analyzeAgentSession>>;
}> {
  const sessionFormat = sanitizeString(body.session_format, 32) || null;
  const redactionStatus = sanitizeString(body.redaction_status, 32) || null;

  const analysis = await analyzeAgentSession(sessionText, sessionFormat ? `session.${sessionFormat}` : undefined, {
    humanApprovedSubmission: humanApproved,
    rulesLoaded,
  });
  const responseBody = buildAgentSessionResponse(analysis, {
    rulesLoaded,
    rulesFollowed: body.rules_followed,
    rulesViolated: body.rules_violated,
    redactionStatus,
  });

  // The real, server-determined classification -- origin comes from which
  // auth path called this function (a compile-time constant per call site),
  // never from anything the client claims. humanConfirmed is true ONLY for
  // the dashboard/cookie path: an agent's own human_approved_submission
  // claim can no longer produce attestation "attested" by itself (the gap
  // finding f5951583 was filed against).
  const runId = sanitizeString(body.run_id, 64) || null;
  const classification = classifySubmission({
    contract: body.evidence_contract,
    rawSessionText: sessionText,
    redactionCompleted: true,
    linkage: { runId, expectedRunId: runId, assignmentStale: false, alreadySubmitted: false },
  });
  const attachment = decideAttachment({
    classification,
    policy: DEFAULT_EVIDENCE_SUBMISSION_POLICY,
    origin,
    humanConfirmed: origin === "human",
    digest: computeSubmissionDigest({ contract: body.evidence_contract, rawSessionText: sessionText, runId }),
  });

  const sessionId = await recordAgentSession(agent, {
    agentKind: agent.agentKind,
    sessionFormat,
    sourceQuality: analysis.sourceQuality,
    humanApproved,
    findingsCount: analysis.findingsCount,
    rulesGenerated: analysis.rules.activeCount + analysis.rules.needsReviewCount,
    summary: analysis.rules.message,
    ruleHealth: responseBody.rule_health,
    submissionOrigin: attachment.origin,
    attachmentStatus: attachment.status,
    humanAttestation: attachment.attestation,
    submissionDigest: attachment.digest,
    behavior: {
      retries: analysis.behavior.retries,
      repeatedCommands: analysis.behavior.repeatedCommands,
      repeatedFileEdits: analysis.behavior.repeatedFileEdits,
      failedCommands: analysis.behavior.failedCommands,
      toolCalls: analysis.behavior.toolCalls,
      changedFiles: analysis.behavior.changedFiles,
      verificationPresent: analysis.behavior.verificationPresent,
      totalTokens: analysis.usage.totalTokens,
      costUsd: analysis.usage.cost,
      inputTokens: analysis.usage.inputTokens,
      outputTokens: analysis.usage.outputTokens,
      testsPassed: analysis.qualitySignals.testsPassed,
      buildPassed: analysis.qualitySignals.buildPassed,
      lintPassed: analysis.qualitySignals.lintPassed,
      humanApproval: analysis.qualitySignals.humanApproval,
    },
  });

  if (analysis.generatedRules.length > 0) {
    await recordRecommendedRulesForAgent(
      agent,
      analysis.generatedRules.map((r) => ({
        title: r.title,
        body: r.body,
        ruleType: r.ruleType,
        confidence: r.confidence,
        evidenceSummary: r.evidenceSummary,
        sourceFindingId: r.sourceFindingId,
        expectedPrevention: r.expectedPrevention,
      })),
      sessionFormat ? `agent session (${sessionFormat})` : "agent session",
      sessionId,
    );
  }

  return { response: NextResponse.json(responseBody), responseBody, sessionId, analysis };
}

// ---------------------------------------------------------------------------
// Dashboard path
// ---------------------------------------------------------------------------

async function dashboardSessionSubmit(req: NextRequest): Promise<NextResponse> {
  const db = await createClient();
  if (!db) return jsonError("M9R is not configured.", 503);

  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return jsonError("Sign in to submit evidence.", 401);

  const workspaceId = await resolveActiveOrDefaultProjectId(db, {
    id: user.id,
    email: user.email,
    name: (user.user_metadata?.name as string | undefined) ?? null,
  });

  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return body;

  const runId = sanitizeString(body.run_id, 64);
  if (!runId) return jsonError("run_id is required.", 400);
  if (body.human_approved_submission !== true) {
    return jsonError("human_approved_submission must be true.", 403);
  }

  const sessionText = sessionTextFromBody(body);
  if (!sessionText.trim()) return jsonError("Provide session_text or session_summary.", 400);
  if (sessionText.length > MAX_SESSION_CHARS) return jsonError("Session is too large.", 413);
  if (containsActiveContent(sessionText)) return jsonError("Prohibited content detected.", 400);

  const connectionId = typeof body.connection_id === "string" ? sanitizeString(body.connection_id, 80) : "";
  const { data: run, error: runError } = await db
    .from("agent_runs")
    .select("id, connection_id, workspace_id, agent_kind, repo_hint, task_title, latest_session_id")
    .eq("id", runId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (runError) return jsonError("Could not read the run.", 500);
  if (!run) return jsonError("Run not found.", 404);
  if (connectionId && connectionId !== run.connection_id) {
    return jsonError("Run does not belong to that connection.", 403);
  }
  if (!run.workspace_id) return jsonError("Run has no workspace.", 400);

  const activeRules = await listActiveRulesForWorkspace(db, run.workspace_id);
  const agent = buildAgentContext({ connection_id: run.connection_id, workspace_id: run.workspace_id, agent_kind: run.agent_kind, repo_hint: run.repo_hint });

  const submission = await recordSubmission(agent, body, sessionText, activeRules, true, "human");
  const effectivenessWrites = submission.responseBody.rule_health.items
    .map(deriveRuleEffectiveness)
    .filter((decision) => decision.action !== "no_change")
    .map((decision) => applyRuleEffectivenessDecision(decision).catch(() => undefined));
  await Promise.all(effectivenessWrites);
  const runLinkage = await linkSessionToRun(agent, run.id, submission.sessionId, {
    complete: true,
    behavior: submission.analysis.behavior,
    ruleHealth: submission.responseBody.rule_health
      ? {
          evaluated: Boolean(submission.responseBody.rule_health.evaluated),
          summary: (submission.responseBody.rule_health.summary ?? {}) as unknown as Record<string, number>,
          items: Array.isArray(submission.responseBody.rule_health.items)
            ? submission.responseBody.rule_health.items.map((item) => ({
                status: String(item.status),
                title: typeof item.title === "string" ? item.title : undefined,
                evidenceLevel: typeof item.evidenceLevel === "string" ? item.evidenceLevel : undefined,
              }))
            : [],
        }
      : null,
  });
  const coordinationCandidates = await loadCoordinationRuleCandidates(agent);
  const coordinationCandidatesCreated = await recordRecommendedRulesForAgent(
    agent,
    coordinationCandidates,
    "reviewed coordination outcomes",
    submission.sessionId,
  );

  const evidenceContractResult = await tryRecordEvidenceContract({
    runId: run.id,
    workspaceId: run.workspace_id,
    sessionId: submission.sessionId,
    evidenceContract: body.evidence_contract,
    agentKind: run.agent_kind,
    // This cookie path already 403'd above (line ~257) unless
    // human_approved_submission === true, so this is always a real approval.
    humanApproved: true,
  });

  const payload: Record<string, unknown> = { ...submission.responseBody };
  if (runLinkage) {
    payload.run_linked = runLinkage.runLinked;
    payload.snapshots_persisted = runLinkage.snapshotsPersisted;
    payload.linked_run_id = runLinkage.linkedRunId;
    payload.migration_required = runLinkage.migrationRequired;
    payload.warnings = [
      ...(runLinkage.warning ? [runLinkage.warning] : []),
      ...(!runLinkage.runLinked
        ? ["This submission is NOT linked to a run, so two-run proof/compare will not be available for this run."]
        : []),
      ...evidenceContractResult.evidenceContractErrors,
    ];
  }
  if (evidenceContractResult.evidenceContractId) {
    payload.evidence_contract_id = evidenceContractResult.evidenceContractId;
  }
  payload.coordination_rule_candidates_created = coordinationCandidatesCreated;
  return NextResponse.json(payload);
}

// ---------------------------------------------------------------------------
// Bearer path
// ---------------------------------------------------------------------------

async function bearerSessionSubmit(req: NextRequest, token: string): Promise<NextResponse> {
  const agent = await authenticateAgent(token);
  if (!agent) {
    return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
  }
  if (!agent.scopes.includes("session:submit")) {
    return NextResponse.json({ error: "Token lacks session:submit scope." }, { status: 403 });
  }

  const body = await readJsonBody(req);
  if (body instanceof NextResponse) return body;
  // Agents may submit on their own, but the claim must be explicit and honest:
  // false lands the evidence as UNREVIEWED (run stays "submitted", never
  // "completed") until a human records a review decision on the Watchfloor.
  if (typeof body.human_approved_submission !== "boolean") {
    return NextResponse.json(
      { error: "human_approved_submission must be an explicit boolean." },
      { status: 403 },
    );
  }
  const humanApproved = body.human_approved_submission;

  const sessionText = sessionTextFromBody(body);
  if (!sessionText.trim()) {
    return NextResponse.json({ error: "Provide session_text or session_summary." }, { status: 400 });
  }
  if (sessionText.length > MAX_SESSION_CHARS) {
    return NextResponse.json({ error: "Session is too large." }, { status: 413 });
  }
  if (containsActiveContent(sessionText)) {
    return NextResponse.json({ error: "Prohibited content detected." }, { status: 400 });
  }

  const submission = await recordSubmission(agent, body, sessionText, body.rules_loaded, humanApproved, "agent");
  await Promise.all(
    submission.responseBody.rule_health.items
      .map(deriveRuleEffectiveness)
      .filter((decision) => decision.action !== "no_change")
      .map((decision) => applyRuleEffectivenessForAgent(agent, decision)),
  );

  const runId = sanitizeString(body.run_id, 64);
  if (!runId) return submission.response;

  const runLinkage = await linkSessionToRun(agent, runId, submission.sessionId, {
    // Unreviewed agent submissions must never complete the run on their own —
    // the run stays "submitted" until a human records a review decision.
    complete: humanApproved,
    behavior: submission.analysis.behavior,
    ruleHealth: submission.responseBody.rule_health
      ? {
          evaluated: Boolean(submission.responseBody.rule_health.evaluated),
          summary: (submission.responseBody.rule_health.summary ?? {}) as unknown as Record<string, number>,
          items: Array.isArray(submission.responseBody.rule_health.items)
            ? submission.responseBody.rule_health.items.map((item) => ({
                status: String(item.status),
                title: typeof item.title === "string" ? item.title : undefined,
                evidenceLevel: typeof item.evidenceLevel === "string" ? item.evidenceLevel : undefined,
              }))
            : [],
        }
      : null,
  });
  if (!humanApproved && runLinkage.runLinked) {
    void pushEvidenceReadyForReview(agent.workspaceId, runId);
  }
  const coordinationCandidates = await loadCoordinationRuleCandidates(agent);
  const coordinationCandidatesCreated = await recordRecommendedRulesForAgent(
    agent,
    coordinationCandidates,
    "reviewed coordination outcomes",
    submission.sessionId,
  );

  const evidenceContractResult = await tryRecordEvidenceContract({
    runId,
    workspaceId: agent.workspaceId,
    sessionId: submission.sessionId,
    evidenceContract: body.evidence_contract,
    agentKind: agent.agentKind,
    humanApproved,
  });

  const payload = { ...submission.responseBody } as Record<string, unknown>;
  return NextResponse.json({
    ...payload,
    run_linked: runLinkage.runLinked,
    snapshots_persisted: runLinkage.snapshotsPersisted,
    linked_run_id: runLinkage.linkedRunId,
    migration_required: runLinkage.migrationRequired,
    coordination_rule_candidates_created: coordinationCandidatesCreated,
    ...(evidenceContractResult.evidenceContractId ? { evidence_contract_id: evidenceContractResult.evidenceContractId } : {}),
    warnings: [
      ...(runLinkage.warning ? [runLinkage.warning] : []),
      ...(!runLinkage.runLinked
        ? ["This submission is NOT linked to a run, so two-run proof/compare will not be available for this run."]
        : []),
      ...evidenceContractResult.evidenceContractErrors,
    ],
  });
}

export async function POST(req: NextRequest) {
  try {
    const token = bearerFrom(req.headers.get("authorization"));
    if (token) return bearerSessionSubmit(req, token);
    return dashboardSessionSubmit(req);
  } catch (err) {
    return handleAgentError(err);
  }
}
