/**
 * Agent Run Service (Agent Dashboard + Two-Run Rule Proof loop)
 * ----------------------------------------------------------------------------
 * DB-facing run-lifecycle operations. Two trust paths, mirroring agent-join:
 *
 *  - Agent (Bearer-token) writes use the SERVICE-ROLE client and are scoped in
 *    app code to the token's OWN connection/workspace. A run can only be touched
 *    by the connection that started it — never a client-supplied workspace id.
 *
 *  - Dashboard (cookie) reads use the COOKIE client, so RLS limits results to
 *    runs in workspaces the signed-in user owns. One user can never see another
 *    user's agent runs.
 *
 * Invariants:
 *  - Run events store only short, redacted status strings (redactRunEvent). No
 *    source code, tokens, local.json, claim URLs, or setup codes are ever stored.
 *  - We never trust a client-supplied workspace/connection id for writes.
 */

import { supabase } from "@/lib/supabase";
import { createHash } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { deriveAgentPresence, type AgentPresence } from "@/lib/agent-presence";
import type { ExecutionOrigin } from "@/lib/agent-heartbeat";
import { defaultPolicyForMode, checkRunDurationBudget, isRunMode } from "@/lib/run-mode";
import { AgentJoinError, type AuthedAgent } from "@/lib/agent-join-service";
import { sanitizeString } from "@/lib/agent-join";
import {
  isRunStatus,
  statusForPhase,
  redactRunEvent,
  type RunStatus,
} from "@/lib/agent-run-core";
import { buildProductTrialComparison, type ProductTrialComparison, type QualitySignals } from "@/lib/product-trial-compare";
import { selectRunsResilient, isMissingColumnError } from "@/lib/agent-runs-read";
import type { RunStats } from "@/lib/run-comparison";
import { dominantRuleHealthStatus, type RuleHealthStatus } from "@/lib/rule-health";
import {
  REVIEW_DECISION_EVENT_TYPE,
  buildRunReviewEventPayload,
  type HumanRunReview,
  type RunReviewDecision,
} from "@/lib/run-review-decision-service";
import { publishDispatch } from "@/lib/dispatch-service";
import type { DispatchType } from "@/lib/dispatch";

/** Best-effort Wire publish. Never throws, never blocks the run-lifecycle action that triggered it. */
export async function publishRunDispatch(
  agent: { workspaceId: string; agentKind?: string | null },
  runId: string,
  type: DispatchType,
  summary: string,
  detail?: Record<string, string | number | boolean | null> | null,
): Promise<void> {
  try {
    await publishDispatch({
      workspaceId: agent.workspaceId,
      runId,
      type,
      sender: agent.agentKind ?? "agent",
      summary,
      detail: detail ?? null,
    });
  } catch (err) {
    console.error("publishRunDispatch failed:", err instanceof Error ? err.message : err);
  }
}

function requireService() {
  if (!supabase) {
    throw new AgentJoinError("M9R agent backend is not configured.", "DB_NOT_CONFIGURED", 503);
  }
  return supabase;
}

/**
 * Store a validated Evidence Contract. Callers MUST validate with
 * validateEvidenceContract() first — this only persists an already-normalized,
 * already-approved contract; it performs no validation of its own.
 */
export async function recordEvidenceContract(input: {
  runId: string;
  workspaceId: string;
  sessionId: string | null;
  contract: unknown;
  warnings: unknown[];
}): Promise<{ id: string } | null> {
  const db = requireService();
  const contractDigest = `sha256:${createHash("sha256").update(JSON.stringify(input.contract)).digest("hex")}`;
  const { data, error } = await db
    .from("evidence_records")
    .insert({
      run_id: input.runId,
      workspace_id: input.workspaceId,
      session_id: input.sessionId,
      contract: input.contract,
      contract_digest: contractDigest,
      warnings: input.warnings,
      human_approved_submission: true,
    })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") {
      console.error("recordEvidenceContract rejected replayed evidence contract.");
      return null;
    }
    console.error("recordEvidenceContract failed:", error.message, error.code);
    return null;
  }
  return { id: data.id as string };
}

/** Append a redacted status/provenance event. Best-effort; never throws. */
async function recordRunEvent(runId: string, eventType: string, message?: string): Promise<void> {
  try {
    const db = requireService();
    await db.from("agent_run_events").insert({
      run_id: runId,
      event_type: sanitizeString(eventType, 48) || "status",
      message: message ? redactRunEvent(message) : null,
    });
  } catch (err) {
    console.error("recordRunEvent failed:", err instanceof Error ? err.message : err);
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export interface StartRunInput {
  taskTitle?: string | null;
  repoHint?: string | null;
  runMode?: import("@/lib/run-mode").RunMode;
}

export interface StartRunResult {
  run_id: string;
  status: RunStatus;
  started_at: string | null;
}

/** Start a run for the authenticated agent's connection. */
export async function startAgentRun(agent: AuthedAgent, input: StartRunInput): Promise<StartRunResult> {
  const db = requireService();
  const taskTitle = sanitizeString(input.taskTitle, 200) || null;
  const repoHint = sanitizeString(input.repoHint, 200) || null;
  // Identity comes from the approved connection — caller input can never change
  // run attribution, and existing historical rows are not relabeled.
  const agentKind = agent.agentKind ?? null;

  const { data, error } = await db
    .from("agent_runs")
    .insert({
      connection_id: agent.connectionId,
      workspace_id: agent.workspaceId,
      agent_kind: agentKind,
      repo_hint: repoHint,
      task_title: taskTitle,
      status: "started",
      current_phase: "started",
      run_mode: input.runMode ?? "solo",
    })
    .select("id, started_at")
    .single();

  if (error || !data) {
    console.error("startAgentRun insert failed:", error?.message, error?.code);
    throw new AgentJoinError("Could not start the run.", "RUN_START_FAILED", 500);
  }

  const runId = data.id as string;
  await recordRunEvent(runId, "started", taskTitle ? `task: ${taskTitle}` : "run started");
  await publishRunDispatch(agent, runId, "RUN_STARTED", taskTitle ? `task: ${taskTitle}` : "run started");
  return { run_id: runId, status: "started", started_at: (data as { started_at?: string | null }).started_at ?? null };
}

/**
 * Best-effort "which run is this in-flight agent action about" lookup, used
 * to attach a related_run_id to chat notices (evidence requests, finding
 * announcements, permission requests) so the Watchfloor can offer a
 * "View run" deep-link -- the OathLock analog of the "Open session in
 * Claude" link in Anthropic's Claude Tag demo (see
 * docs/research-claude-tag-ui-deep-dive.md). Same live-status vocabulary as
 * LIVE_RUN_STATUSES (agent-workspace-data.ts) -- inlined rather than
 * imported to avoid a runtime dependency between an API-route library and a
 * UI-data module for four literal strings. Returns null (never a guess) when
 * no live run is found; the caller must render no link rather than a wrong one.
 */
export async function findCurrentRunIdForConnection(workspaceId: string, connectionId: string): Promise<string | null> {
  const db = requireService();
  const { data } = await db
    .from("agent_runs")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("connection_id", connectionId)
    .in("status", ["started", "working", "blocked", "waiting_for_human", "waiting"])
    .order("last_seen_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ? String((data as { id: string }).id) : null;
}

/**
 * Handoff-only start path. The SQL function claims the message and inserts
 * the child run in one transaction, so concurrent inbox polls cannot create
 * duplicate runs. Dispatch/event publication remains additive and happens
 * only after the durable claim has committed.
 */
export async function startAgentRunFromHandoff(
  agent: AuthedAgent,
  input: { messageId: string; taskTitle?: string | null; runMode?: import("@/lib/run-mode").RunMode },
): Promise<StartRunResult | null> {
  const db = requireService();
  const taskTitle = sanitizeString(input.taskTitle, 200) || null;
  const { data, error } = await db.rpc("claim_handoff_and_start_run", {
    p_workspace_id: agent.workspaceId,
    p_connection_id: agent.connectionId,
    p_message_id: input.messageId,
    p_task_title: taskTitle,
    p_agent_kind: agent.agentKind ?? "agent",
    p_run_mode: input.runMode ?? "coordinated",
  });
  if (error) {
    if (error.code === "42883" || error.code === "PGRST202" || /claim_handoff_and_start_run/i.test(error.message ?? "")) {
      throw new AgentJoinError("Handoff auto-start requires the latest database migration.", "MIGRATION_REQUIRED", 503);
    }
    console.error("startAgentRunFromHandoff failed:", error.message, error.code);
    throw new AgentJoinError("Could not start the handoff run.", "RUN_START_FAILED", 500);
  }
  const row = (Array.isArray(data) ? data[0] : data) as { run_id?: string; started_at?: string | null } | null;
  if (!row?.run_id) return null;
  await recordRunEvent(row.run_id, "started", taskTitle ? `handoff task: ${taskTitle}` : "handoff run started");
  await publishRunDispatch(agent, row.run_id, "RUN_STARTED", taskTitle ? `handoff task: ${taskTitle}` : "handoff run started");
  return { run_id: row.run_id, status: "started", started_at: row.started_at ?? null };
}

// ---------------------------------------------------------------------------
// Status update
// ---------------------------------------------------------------------------

export interface UpdateRunInput {
  runId: string;
  status?: string | null;
  currentPhase?: string | null;
  message?: string | null;
  rulesLoadedCount?: number | null;
}

/** Load a run and assert it belongs to the authenticated agent's connection. */
export async function requireOwnRun(agent: AuthedAgent, runId: string) {
  const db = requireService();
  const { data, error } = await db
    .from("agent_runs")
    .select("id, connection_id, workspace_id, status, started_at, run_mode")
    .eq("id", runId)
    .maybeSingle();
  if (error) {
    console.error("requireOwnRun failed:", error.message, error.code);
    throw new AgentJoinError("Could not read the run.", "RUN_READ_FAILED", 500);
  }
  if (!data) throw new AgentJoinError("Run not found.", "NOT_FOUND", 404);
  // Scope: the token can only touch a run started by its OWN connection.
  if (data.connection_id !== agent.connectionId) {
    throw new AgentJoinError("This run belongs to another connection.", "FORBIDDEN", 403);
  }
  return data;
}

/**
 * Update run status/phase. The status is taken from an explicit status field if
 * valid, else inferred from the phase text. last_seen_at is always bumped.
 */
const TERMINAL_RUN_STATUSES = new Set<RunStatus>(["completed", "submitted", "failed", "expired"]);

export async function updateAgentRunStatus(agent: AuthedAgent, input: UpdateRunInput): Promise<{ status: RunStatus }> {
  const db = requireService();
  const run = await requireOwnRun(agent, input.runId);

  // A run that already reached a terminal state is a hard stop -- the agent
  // process usually keeps running a bit past that point (cancellation,
  // completion, whatever ended it) and keeps sending its normal phase
  // heartbeats, which silently flipped the run right back to "working" on
  // the very next report. This used to check only "cancelled" specifically;
  // that fixed cancel but left the same bug live for completed/submitted/
  // failed/expired runs -- 33 production rows were found carrying a
  // completed_at timestamp while sitting in status "working" or similar,
  // which is exactly this path. "cancelled" isn't in the RunStatus union
  // (the agent itself can never claim it -- only a human action sets it),
  // so this compares against the raw stored value rather than the narrowed
  // type, in addition to consulting TERMINAL_RUN_STATUSES for the rest.
  if ((run.status as string) === "cancelled") {
    throw new AgentJoinError("This run was cancelled and can no longer be updated.", "RUN_CANCELLED", 409);
  }
  if (TERMINAL_RUN_STATUSES.has(run.status as RunStatus)) {
    throw new AgentJoinError(`This run already reached a terminal state (${run.status}) and can no longer be updated.`, "RUN_TERMINAL", 409);
  }

  const phase = sanitizeString(input.currentPhase, 80) || null;
  let status: RunStatus = isRunStatus(input.status) ? input.status : statusForPhase(phase);
  let eventMessage = phase ? `phase: ${phase}` : input.message ?? undefined;
  const now = new Date().toISOString();

  // Gate 8: a run cannot silently continue past its coordination policy's
  // wall-clock ceiling. This never fabricates progress — it forces the run to
  // a visible, terminal "expired" state instead of accepting another update.
  if (!TERMINAL_RUN_STATUSES.has(status) && run.started_at) {
    const policy = defaultPolicyForMode(isRunMode(run.run_mode) ? run.run_mode : "solo");
    const budget = checkRunDurationBudget(run.started_at, Date.now(), policy);
    if (budget.overBudget) {
      status = "expired";
      eventMessage = `Run exceeded its ${policy.mode} time budget by ${Math.round(budget.exceededByMs / 60_000)}m — expired rather than continuing silently; evidence and history are preserved.`;
    }
  }

  const patch: Record<string, unknown> = {
    status,
    current_phase: phase,
    last_seen_at: now,
  };
  if (typeof input.rulesLoadedCount === "number" && input.rulesLoadedCount >= 0) {
    patch.rules_loaded_count = Math.floor(input.rulesLoadedCount);
  }
  if (status === "completed" || status === "submitted") patch.completed_at = now;
  if ((status === "failed" || status === "expired") && eventMessage) patch.error_message = eventMessage;

  const { error } = await db.from("agent_runs").update(patch).eq("id", input.runId);
  if (error) {
    console.error("updateAgentRunStatus failed:", error.message, error.code);
    throw new AgentJoinError("Could not update the run.", "RUN_UPDATE_FAILED", 500);
  }

  await recordRunEvent(input.runId, status, eventMessage);
  await publishRunDispatch(agent, input.runId, dispatchTypeForStatus(status), phase ? `phase: ${phase}` : status, phase ? { phase } : null);
  return { status };
}

const NON_TERMINAL_RUN_STATUSES = ["started", "working", "blocked", "waiting_for_human"] as const;

/**
 * Finalizes runs whose CLI process died without ever sending a final status
 * update -- updateAgentRunStatus's own time-budget check (checkRunDurationBudget)
 * only ever runs when the agent reports again, so a run that goes silent
 * mid-flight stays "working" forever with nothing to trigger the same check.
 * Invoked on a schedule (see vercel.json crons), never by a request an agent
 * or human can trigger. Reuses the exact same budget policy live updates use,
 * so a swept run is finalized identically to how one more heartbeat would
 * have finalized it -- no separate staleness heuristic.
 */
export async function sweepStaleRuns(): Promise<{ scanned: number; expired: number }> {
  const db = requireService();
  const { data, error } = await db
    .from("agent_runs")
    .select("id, started_at, run_mode, workspace_id, agent_kind")
    .in("status", NON_TERMINAL_RUN_STATUSES);
  if (error) {
    console.error("sweepStaleRuns failed to load runs:", error.message, error.code);
    return { scanned: 0, expired: 0 };
  }
  const rows = data ?? [];
  const now = Date.now();
  let expiredCount = 0;
  for (const row of rows) {
    if (!row.started_at) continue;
    const policy = defaultPolicyForMode(isRunMode(row.run_mode) ? row.run_mode : "solo");
    const budget = checkRunDurationBudget(row.started_at, now, policy);
    if (!budget.overBudget) continue;
    const message = `Run went silent and exceeded its ${policy.mode} time budget by ${Math.round(budget.exceededByMs / 60_000)}m — expired rather than left open indefinitely; evidence and history are preserved.`;
    const { error: updateError } = await db
      .from("agent_runs")
      .update({ status: "expired", error_message: message, completed_at: new Date(now).toISOString() })
      .eq("id", row.id)
      .in("status", NON_TERMINAL_RUN_STATUSES);
    if (updateError) {
      console.error("sweepStaleRuns failed to expire run:", row.id, updateError.message);
      continue;
    }
    expiredCount += 1;
    await recordRunEvent(row.id, "expired", message);
    await publishRunDispatch({ workspaceId: row.workspace_id, agentKind: row.agent_kind }, row.id, dispatchTypeForStatus("expired"), message, null);
  }
  return { scanned: rows.length, expired: expiredCount };
}

/**
 * Map a raw run status to the closest canonical Dispatch type. Only WORKING,
 * BLOCKED, and RUN_COMPLETED have a clean 1:1 mapping — everything else
 * (waiting_for_human, submitted, failed, started) becomes a generic
 * PHASE_CHANGED rather than a fabricated canonical type that doesn't fit.
 */
function dispatchTypeForStatus(status: RunStatus): DispatchType {
  if (status === "working") return "WORKING";
  if (status === "blocked") return "BLOCKED";
  if (status === "completed") return "RUN_COMPLETED";
  return "PHASE_CHANGED";
}

/**
 * A conservative, content-free Rule Health snapshot to store on a run. Only
 * summary counts + per-rule status/title/evidence — never session text.
 */
export interface RunRuleHealth {
  evaluated: boolean;
  summary?: Record<string, number>;
  items?: Array<{ status: string; title?: string; evidenceLevel?: string }>;
}

/** A content-free behavioral snapshot (counts only) stored for trial compares. */
export interface RunBehavior {
  recordSummary?: import("@/lib/approved-evidence-record").ApprovedEvidenceRecord | null;
  verificationProvenance?: import("@/lib/quality-signal-extraction").VerificationProvenance[] | null;
  retries?: number;
  repeatedCommands?: number;
  repeatedFileEdits?: number;
  failedCommands?: number;
  toolCalls?: number;
  changedFiles?: number;
  verificationPresent?: boolean;
  totalTokens?: number | null;
  costUsd?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  /**
   * Objective output-quality signals extracted from the redacted session
   * (command-tied test/build/lint results + human review). Null when the
   * evidence did not state them. Never agent self-claims.
   */
  testsPassed?: boolean | null;
  buildPassed?: boolean | null;
  lintPassed?: boolean | null;
  humanApproval?: boolean | null;
}

/**
 * Outcome of linking a submitted session to a run. The session itself is recorded
 * independently, so a linkage/persistence failure must be REPORTED (not swallowed)
 * — otherwise the API returns ok:true while the two-run proof silently breaks.
 */
export interface LinkSessionResult {
  /** True when the run row was updated with latest_session_id. */
  runLinked: boolean;
  /** True when the Rule Health / behavior snapshot was persisted on the run row. */
  snapshotsPersisted: boolean;
  /** The run id that was actually linked, or null when linkage failed. */
  linkedRunId: string | null;
  /** True when the deployed schema is missing the optional snapshot columns. */
  migrationRequired: boolean;
  /** A short, token-safe explanation when something went wrong. */
  warning?: string;
}

/** Link a submitted session to a run and mark it submitted/completed. */
export async function linkSessionToRun(
  agent: AuthedAgent,
  runId: string,
  sessionId: string | null,
  opts: { complete?: boolean; ruleHealth?: RunRuleHealth | null; behavior?: RunBehavior | null } = {},
): Promise<LinkSessionResult> {
  const db = requireService();

  // Ownership: a token can only link a run started by its own connection. If this
  // fails (e.g. the run was started under a different connection), we do NOT throw
  // — the session is already saved; we report that the run could not be linked so
  // the caller can warn instead of claiming the run is proof-ready.
  let ownedRun: Awaited<ReturnType<typeof requireOwnRun>>;
  try {
    ownedRun = await requireOwnRun(agent, runId);
  } catch (err) {
    const code = err instanceof AgentJoinError ? err.code : "RUN_LINK_FAILED";
    return {
      runLinked: false,
      snapshotsPersisted: false,
      linkedRunId: null,
      migrationRequired: false,
      warning: `Run could not be linked to this session (${code}). Two-run proof will not be available for this run; start the later run with the same connected workspace and resubmit.`,
    };
  }

  let assuranceSatisfied = true;
  if (opts.complete && ownedRun.run_mode === "assurance") {
    const { data: decisions, error: decisionError } = await db
      .from("result_adoptions")
      .select("id")
      .eq("run_id", runId)
      .limit(1);
    assuranceSatisfied = !decisionError && Boolean(decisions?.length);
  }

  const now = new Date().toISOString();
  const complete = Boolean(opts.complete && assuranceSatisfied);
  const corePatch: Record<string, unknown> = {
    latest_session_id: sessionId,
    status: complete ? "completed" : "submitted",
    current_phase: complete
      ? "completed"
      : ownedRun.run_mode === "assurance" && !assuranceSatisfied
        ? "waiting for required assurance decision"
        : "submitting evidence",
    last_seen_at: now,
    completed_at: complete ? now : null,
  };
  const snapshotPatch: Record<string, unknown> = {};
  // Conservative behavioral snapshot (counts only — never content).
  if (opts.behavior) {
    snapshotPatch.behavior = opts.behavior;
  }
  // Store only when Rule Health was actually evaluated (a later run loaded rules).
  if (opts.ruleHealth && opts.ruleHealth.evaluated) {
    snapshotPatch.rule_health = {
      evaluated: true,
      summary: opts.ruleHealth.summary ?? {},
      items: (opts.ruleHealth.items ?? []).map((it) => ({
        status: it.status,
        title: it.title,
        evidenceLevel: it.evidenceLevel,
      })),
    };
  }

  const { error: coreError } = await db.from("agent_runs").update(corePatch).eq("id", runId);
  if (coreError) {
    return {
      runLinked: false,
      snapshotsPersisted: false,
      linkedRunId: null,
      migrationRequired: false,
      warning: `Run linkage update failed (${coreError.code ?? "db_error"}). Two-run proof will not be available for this run.`,
    };
  }

  const wantSnapshots = Object.keys(snapshotPatch).length > 0;
  let snapshotsPersisted = false;
  let migrationRequired = false;
  let warning: string | undefined = ownedRun.run_mode === "assurance" && !assuranceSatisfied
    ? "Evidence was linked, but this assurance run cannot complete until a returned secondary result is explicitly adopted, rejected, or challenged."
    : undefined;
  if (wantSnapshots) {
    const { error: snapshotError } = await db.from("agent_runs").update(snapshotPatch).eq("id", runId);
    if (!snapshotError) {
      snapshotsPersisted = true;
    } else if (isMissingColumnError(snapshotError)) {
      migrationRequired = true;
      warning =
        "Run snapshot columns are missing in the deployed schema (migration required: apply supabase-agent-runs.sql). The session snapshot was still saved, so compare can hydrate from it.";
      console.warn("linkSessionToRun: snapshot columns missing — migration required.", snapshotError.code);
    } else {
      warning = `Run snapshot persistence failed (${snapshotError.code ?? "db_error"}). The session snapshot was still saved, so compare can hydrate from it.`;
      console.warn("linkSessionToRun snapshot update failed:", snapshotError.message, snapshotError.code);
    }
  }

  await recordRunEvent(
    runId,
    "session_submitted",
    assuranceSatisfied ? "approved session submitted" : "approved session submitted; required assurance decision still pending",
  );
  return { runLinked: true, snapshotsPersisted, linkedRunId: runId, migrationRequired, warning };
}

// ---------------------------------------------------------------------------
// Dashboard reads (cookie-authenticated, owner-scoped by RLS)
// ---------------------------------------------------------------------------

export interface DashboardRun {
  id: string;
  connection_id: string;
  workspace_id: string;
  agent_kind: string | null;
  repo_hint: string | null;
  task_title: string | null;
  status: RunStatus;
  current_phase: string | null;
  rules_loaded_count: number;
  latest_session_id: string | null;
  rule_health: RunRuleHealth | null;
  behavior: RunBehavior | null;
  started_at: string;
  last_seen_at: string;
  completed_at: string | null;
  error_message: string | null;
  /** Gate 4: real presence, derived from persisted connection + run observations. Absent until attachPresence runs. */
  presence?: AgentPresence;
  /** Gate 1's execution-origin disclosure (resident vs linked), from the connection's last accepted heartbeat. Null if never observed. */
  execution_origin?: ExecutionOrigin | null;
}

/**
 * Attach real, server-derived presence (Gate 1's deriveAgentPresence) and
 * execution-origin disclosure to a set of dashboard runs. One extra query on
 * agent_connections, batched by the runs' own connection ids — RLS already
 * scopes `runs` to the signed-in owner, so this never reads another user's
 * connections. Never fabricates a state: a connection lookup failure leaves
 * `presence`/`execution_origin` unset rather than guessing.
 */
async function attachPresence(cookieDb: NonNullable<Awaited<ReturnType<typeof createClient>>>, runs: DashboardRun[]): Promise<DashboardRun[]> {
  const connectionIds = Array.from(new Set(runs.map((r) => r.connection_id).filter(Boolean)));
  if (connectionIds.length === 0) return runs;

  const { data, error } = await cookieDb
    .from("agent_connections")
    .select("id, status, last_seen_at, execution_origin")
    .in("id", connectionIds);
  if (error || !data) return runs;

  const byId = new Map(data.map((c) => [c.id as string, c as { status: string; last_seen_at: string | null; execution_origin: string | null }]));
  const nowMs = Date.now();

  return runs.map((run) => {
    const conn = byId.get(run.connection_id);
    if (!conn) return run;
    const connectionStatus = conn.status === "revoked" ? "revoked" : conn.status === "active" ? "active" : "unavailable";
    const presence = deriveAgentPresence({
      connectionStatus,
      connectionObservedAt: conn.last_seen_at,
      run: { status: run.status, observedAt: run.last_seen_at },
      nowMs,
    });
    const executionOrigin = conn.execution_origin === "linked" || conn.execution_origin === "resident" ? conn.execution_origin : null;
    return { ...run, presence, execution_origin: executionOrigin };
  });
}

async function sameOwnerWorkspaces(workspaceA: string, workspaceB: string): Promise<boolean> {
  if (!workspaceA || !workspaceB) return false;
  if (workspaceA === workspaceB) return true;
  const db = requireService();
  const { data, error } = await db
    .from("projects")
    .select("id, owner_id")
    .in("id", [workspaceA, workspaceB])
    .is("deleted_at", null);
  if (error) {
    console.error("compare workspace owner lookup failed:", error.message, error.code);
    throw new AgentJoinError("Could not verify run workspace ownership.", "COMPARE_SCOPE_FAILED", 500);
  }
  const rows = (data ?? []) as Array<{ id: string; owner_id: string | null }>;
  const owners = rows.map((r) => r.owner_id).filter(Boolean);
  return rows.length === 2 && owners.length === 2 && new Set(owners).size === 1;
}

type SessionSnapshot = Pick<DashboardRun, "rule_health" | "behavior">;

async function loadSessionSnapshot(sessionId: string | null): Promise<SessionSnapshot | null> {
  if (!sessionId) return null;
  const db = requireService();
  const { data, error } = await db
    .from("agent_sessions")
    .select("rule_health, behavior")
    .eq("id", sessionId)
    .maybeSingle();
  if (error) {
    if (error.code === "42703" || /column .* does not exist/i.test(error.message ?? "")) {
      console.warn("agent_sessions snapshot columns missing in deployed schema; compare fallback unavailable.");
      return null;
    }
    console.error("compare session snapshot lookup failed:", error.message, error.code);
    throw new AgentJoinError("Could not read submitted session snapshot.", "COMPARE_SESSION_FAILED", 500);
  }
  if (!data) return null;
  return {
    rule_health: (data as { rule_health?: DashboardRun["rule_health"] | null }).rule_health ?? null,
    behavior: (data as { behavior?: DashboardRun["behavior"] | null }).behavior ?? null,
  };
}

async function hydrateRunSnapshot(run: DashboardRun): Promise<DashboardRun> {
  if (run.rule_health && run.behavior) return run;
  const snapshot = await loadSessionSnapshot(run.latest_session_id);
  if (!snapshot) return run;
  return {
    ...run,
    rule_health: run.rule_health ?? snapshot.rule_health ?? null,
    behavior: run.behavior ?? snapshot.behavior ?? null,
  };
}

async function hasRuleLineageFromBaselineToLater(runA: DashboardRun, runB: DashboardRun): Promise<boolean> {
  const sourceSessionId = runA.latest_session_id?.trim();
  if (!sourceSessionId || !runB.rule_health?.evaluated) return false;
  const evaluatedTitles = new Set(
    (runB.rule_health.items ?? [])
      .map((it) => (it.title ?? "").trim().toLowerCase())
      .filter(Boolean),
  );
  if (evaluatedTitles.size === 0) return false;

  const db = requireService();
  const { data, error } = await db
    .from("workspace_rules")
    .select("id, title, workspace_id, source_report_id, status")
    .eq("workspace_id", runB.workspace_id)
    .eq("source_report_id", sourceSessionId)
    .eq("status", "active")
    .is("deleted_at", null);
  if (error) {
    console.error("compare rule lineage lookup failed:", error.message, error.code);
    throw new AgentJoinError("Could not verify rule lineage for these runs.", "COMPARE_LINEAGE_FAILED", 500);
  }

  return ((data ?? []) as Array<{ title: string | null }>).some((r) =>
    evaluatedTitles.has((r.title ?? "").trim().toLowerCase()),
  );
}

/**
 * List recent runs visible to the signed-in user. RLS limits rows to runs in
 * workspaces the user owns, so a user can never see another user's runs. Returns
 * [] (never throws) when the backend is unconfigured or the user is signed out.
 */
export async function listAgentRunsForUser(limit = 25): Promise<DashboardRun[]> {
  const cookieDb = await createClient();
  if (!cookieDb) return [];
  const {
    data: { user },
  } = await cookieDb.auth.getUser();
  if (!user) return [];

  const runs = await selectRunsResilient<DashboardRun>((cols) =>
    cookieDb.from("agent_runs").select(cols).order("last_seen_at", { ascending: false }).limit(limit),
  );
  return attachPresence(cookieDb, runs);
}

// ---------------------------------------------------------------------------
// Two-run product-trial comparison
// ---------------------------------------------------------------------------

/** Map a stored behavioral snapshot to the RunStats shape compareRuns expects. */
function behaviorToRunStats(b: RunBehavior | null | undefined): RunStats {
  return {
    stepCount: 0,
    retries: b?.retries ?? 0,
    repeatedCommands: b?.repeatedCommands ?? 0,
    repeatedFileEdits: b?.repeatedFileEdits ?? 0,
    failedCommands: b?.failedCommands ?? 0,
    toolCalls: b?.toolCalls ?? 0,
    changedFiles: b?.changedFiles ?? 0,
    scopeCreepSignals: 0,
    verificationPresent: Boolean(b?.verificationPresent),
    totalTokens: b?.totalTokens ?? null,
    costUsd: b?.costUsd ?? null,
  };
}

/**
 * Map a stored behavioral snapshot's quality fields to the compare-layer
 * QualitySignals. Returns null when the snapshot recorded no objective signal,
 * so an empty run never looks like it supplied verification.
 */
function qualityFromBehavior(b: RunBehavior | null | undefined): QualitySignals | null {
  if (!b) return null;
  const tests = b.testsPassed ?? null;
  const build = b.buildPassed ?? null;
  const lint = b.lintPassed ?? null;
  const human = b.humanApproval ?? null;
  if (tests == null && build == null && lint == null && human == null) return null;
  return {
    testsPassed: tests,
    buildPassed: build,
    lintPassed: lint,
    humanApproval: human,
  };
}

/** Build the conservative product-trial comparison from two run rows. */
export function comparisonFromRuns(runA: DashboardRun, runB: DashboardRun): ProductTrialComparison {
  try {
    const rh = runB.rule_health;
    const items = (rh?.items ?? []).map((it) => ({
      status: it.status as RuleHealthStatus,
      title: it.title,
    }));
    // A run that submitted a session but carries no recoverable snapshot was
    // submitted before snapshot persistence / migration. Distinguish that from a
    // run that genuinely never loaded a rule, so the verdict stays honest.
    const ruleHealthSnapshotUnavailable =
      Boolean(runB.latest_session_id) && (rh == null || rh.evaluated !== true);
    const behaviorSnapshotUnavailable =
      (Boolean(runB.latest_session_id) && runB.behavior == null) ||
      (Boolean(runA.latest_session_id) && runA.behavior == null);
    return buildProductTrialComparison({
      baselineRunId: runA.id,
      laterRunId: runB.id,
      // The rules "loaded" into Run B are the ones Rule Health actually evaluated.
      loadedRules: items.map((it) => it.title ?? "(rule)").filter(Boolean),
      promotedRuleIds: [],
      laterRulesLoadedCount: runB.rules_loaded_count ?? 0,
      ruleHealthSnapshotUnavailable,
      behaviorSnapshotUnavailable,
      ruleHealth: rh
        ? { evaluated: Boolean(rh.evaluated), items, dominant: dominantRuleHealthStatus(items) }
        : null,
      before: behaviorToRunStats(runA.behavior),
      after: behaviorToRunStats(runB.behavior),
      usageBefore: {
        inputTokens: runA.behavior?.inputTokens ?? null,
        outputTokens: runA.behavior?.outputTokens ?? null,
        totalTokens: runA.behavior?.totalTokens ?? null,
        cost: runA.behavior?.costUsd ?? null,
      },
      usageAfter: {
        inputTokens: runB.behavior?.inputTokens ?? null,
        outputTokens: runB.behavior?.outputTokens ?? null,
        totalTokens: runB.behavior?.totalTokens ?? null,
        cost: runB.behavior?.costUsd ?? null,
      },
      // Objective quality signals extracted from each run's redacted session (only
      // command-tied test/build/lint results + explicit human review). Null fields
      // when the evidence did not state them — compare treats a one-sided set as
      // not comparable rather than claiming an improvement.
      qualityBefore: qualityFromBehavior(runA.behavior),
      qualityAfter: qualityFromBehavior(runB.behavior),
    });
  } catch {
    return {
      baseline_run_id: runA.id,
      later_run_id: runB.id,
      loaded_rules: [],
      promoted_rule_ids: [],
      rule_health_result: null,
      rule_health_snapshot_available: false,
      behavior_snapshot_available: false,
      behavioral_delta: [],
      verification_delta: { before: false, after: false, change: "unchanged", note: "Comparison unavailable." },
      usage_delta: { available: false, message: "Comparison unavailable.", inputTokensBefore: null, inputTokensAfter: null, outputTokensBefore: null, outputTokensAfter: null, totalTokensBefore: null, totalTokensAfter: null, costBefore: null, costAfter: null },
      output_quality_delta: { judgeable: false, message: "Comparison unavailable.", signals: [] },
      honest_verdict: "Comparison unavailable due to an internal error.",
      limitations: ["Comparison could not be computed."],
    };
  }
}

/**
 * Compare two runs for a Bearer-authenticated agent (the `oathlock compare`
 * command). Same-connection remains valid, but reconnecting an agent should not
 * break proof: same-workspace runs are allowed across connections. Different
 * workspaces require same-owner rule lineage from the baseline session to an
 * active rule evaluated by the later run.
 */
export async function compareAgentRuns(
  agent: AuthedAgent,
  baselineRunId: string,
  laterRunId: string,
): Promise<ProductTrialComparison> {
  const db = requireService();
  const rows = await selectRunsResilient<DashboardRun>((cols) =>
    db.from("agent_runs").select(cols).in("id", [baselineRunId, laterRunId]),
  );
  const runA = rows.find((r) => r.id === baselineRunId);
  const runB = rows.find((r) => r.id === laterRunId);
  if (!runA || !runB) throw new AgentJoinError("One or both runs were not found.", "NOT_FOUND", 404);
  const hydratedRunA = await hydrateRunSnapshot(runA);
  const hydratedRunB = await hydrateRunSnapshot(runB);
  const sameConnection = runA.connection_id === agent.connectionId && runB.connection_id === agent.connectionId;
  const sameWorkspace = runA.workspace_id === agent.workspaceId && runB.workspace_id === agent.workspaceId;
  if (!sameConnection && !sameWorkspace) {
    const laterInAgentWorkspace = runB.workspace_id === agent.workspaceId;
    const lineageAllowed =
      laterInAgentWorkspace &&
      (await sameOwnerWorkspaces(runA.workspace_id, runB.workspace_id)) &&
      (await hasRuleLineageFromBaselineToLater(hydratedRunA, hydratedRunB));
    if (!lineageAllowed) {
      throw new AgentJoinError(
        "These runs are not in the same workspace or approved rule lineage.",
        "FORBIDDEN",
        403,
      );
    }
  }
  // Snapshot-availability limitations (Rule Health + behavior) are computed
  // canonically inside comparisonFromRuns from the hydrated rows, so the verdict,
  // limitations, and snapshot-availability flags never disagree.
  return comparisonFromRuns(hydratedRunA, hydratedRunB);
}

/** Fetch a single run the user owns, or null. */
/** Linked (supporting) runs created to answer this run's bounded requests — RLS-scoped. */
export async function listLinkedRunIds(runId: string): Promise<string[]> {
  const cookieDb = await createClient();
  if (!cookieDb) return [];
  const {
    data: { user },
  } = await cookieDb.auth.getUser();
  if (!user) return [];

  const { data, error } = await cookieDb.from("agent_runs").select("id").eq("parent_run_id", runId);
  if (error) {
    if (error.code === "42703" || /column .* does not exist/i.test(error.message ?? "")) return [];
    throw error;
  }
  return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
}

export async function getAgentRunForUser(runId: string): Promise<DashboardRun | null> {
  const cookieDb = await createClient();
  if (!cookieDb) return null;
  const {
    data: { user },
  } = await cookieDb.auth.getUser();
  if (!user) return null;

  const rows = await selectRunsResilient<DashboardRun>((cols) =>
    cookieDb.from("agent_runs").select(cols).eq("id", runId).limit(1),
  );
  return rows[0] ?? null;
}

/**
 * Cancel a run the signed-in human owns. Ownership is verified by the
 * caller via getAgentRunForUser (cookie-scoped, RLS-checked) BEFORE calling
 * this; the actual write goes through the service-role client because
 * agent_runs has no RLS UPDATE policy for the authenticated-user role --
 * writing through the cookie client there silently no-ops (Supabase returns
 * { error: null } for an UPDATE that matched zero rows under RLS), which is
 * exactly what made the first version of this endpoint look like it worked
 * (200 OK) while never actually changing anything.
 */
export async function cancelAgentRun(runId: string): Promise<void> {
  const db = requireService();
  const { error, data } = await db.from("agent_runs").update({ status: "cancelled" }).eq("id", runId).select("id");
  if (error) {
    console.error("cancelAgentRun failed:", error.message, error.code);
    throw new AgentJoinError(
      error.code === "23514" ? "Cancel is not available yet: the database migration allowing a 'cancelled' status hasn't been applied." : "Could not cancel this run.",
      error.code === "23514" ? "MIGRATION_REQUIRED" : "RUN_CANCEL_FAILED",
      error.code === "23514" ? 503 : 500,
    );
  }
  if (!data || data.length === 0) {
    throw new AgentJoinError("Could not cancel this run.", "RUN_CANCEL_FAILED", 500);
  }
}

export async function recordRunReviewDecision(
  runId: string,
  input: { decision: RunReviewDecision; note?: string | null },
): Promise<HumanRunReview> {
  const db = requireService();
  const payload = buildRunReviewEventPayload({ decision: input.decision, note: input.note });
  const { error } = await db.from("agent_run_events").insert({
    run_id: runId,
    event_type: REVIEW_DECISION_EVENT_TYPE,
    message: JSON.stringify(payload),
  });

  if (error) {
    console.error("recordRunReviewDecision failed:", error.message, error.code);
    throw new AgentJoinError("Could not save the review decision.", "REVIEW_DECISION_FAILED", 500);
  }

  return {
    decision: payload.decision,
    reviewed_at: payload.created_at,
    note_present: payload.note_present,
  };
}
