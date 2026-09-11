import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, bearerFrom, listActiveRulesForAgent } from "@/lib/agent-join-service";
import { startAgentRun } from "@/lib/agent-run-service";
import { buildPreflightDecision, sanitizePreflightText, type PreflightDecision, type PreflightRule } from "@/lib/agent-preflight-service";
import { createClient } from "@/lib/supabase/server";
import { handleAgentError } from "../../_shared";
import { defaultPolicyForMode, isRunMode } from "@/lib/run-mode";
import {
  createOrGetPendingApprovalRequest,
  findApprovalRequestByIdempotencyKey,
  markApprovalRequestConsumed,
  attachApprovalRequestMessage,
} from "@/lib/approval-requests";
import { findOrCreateAgentDmForBearer, sendConversationMessage } from "@/lib/conversation-service";

// ---------------------------------------------------------------------------
// POST /api/agent/run/start — begin a run for the authenticated agent.
//
// Bearer-token path (CLI): session:submit scope, bound to the token's own
// connection/workspace.
//
// Dashboard path (cookie): validates the selected connection through user RLS,
// reruns deterministic preflight server-side, then reuses the same run start
// service. Preflight metadata is returned compactly but not persisted because
// the current schema has no safe JSON/details field for it.
// ---------------------------------------------------------------------------

const MAX_TASK_LENGTH = 4000;
const MAX_PATH_HINTS = 40;
const MAX_PATH_HINT_LENGTH = 240;
const MAX_PATH_HINT_TOTAL_LENGTH = 4000;
const MAX_APPROVAL_NOTE_LENGTH = 1000;
const PREFLIGHT_PERSISTENCE_SUPPORTED = false;
const APPROVAL_OPERATION_TYPE_RUN_START = "agent_run_start";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

type StartBody = {
  connection_id?: unknown;
  task?: unknown;
  task_title?: unknown;
  repo_hint?: unknown;
  agent_kind?: unknown;
  path_hints?: unknown;
  approved_by_human?: unknown;
  approval_note?: unknown;
  run_mode?: unknown;
};

type CookieDb = NonNullable<Awaited<ReturnType<typeof createClient>>>;

function jsonError(error: string, status: number, extra: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json({ error, ...extra }, { status });
}

function cleanOptionalString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  return sanitizePreflightText(value).slice(0, maxLength) || null;
}

function parsePathHints(value: unknown): { hints?: string[]; response?: NextResponse } {
  if (value == null) return { hints: [] };
  if (!Array.isArray(value)) return { response: jsonError("path_hints must be an array of strings.", 400) };
  if (value.length > MAX_PATH_HINTS) return { response: jsonError("Too many path hints.", 413) };

  const hints: string[] = [];
  let totalLength = 0;
  for (const item of value) {
    if (typeof item !== "string") return { response: jsonError("path_hints must be an array of strings.", 400) };
    if (item.length > MAX_PATH_HINT_LENGTH) return { response: jsonError("Path hint is too large.", 413) };
    totalLength += item.length;
    if (totalLength > MAX_PATH_HINT_TOTAL_LENGTH) return { response: jsonError("Path hints are too large.", 413) };
    const clean = sanitizePreflightText(item);
    if (clean) hints.push(clean);
  }
  return { hints };
}

async function readJsonBody(req: NextRequest, allowEmpty = false): Promise<StartBody | NextResponse> {
  try {
    return (await req.json()) as StartBody;
  } catch {
    return allowEmpty ? {} : jsonError("Invalid JSON body.", 400);
  }
}

function taskFromBody(body: StartBody): { task?: string; response?: NextResponse } {
  const raw = typeof body.task === "string" ? body.task : typeof body.task_title === "string" ? body.task_title : "";
  if (!raw) return { response: jsonError("Task is required.", 400) };
  if (raw.length > MAX_TASK_LENGTH) return { response: jsonError("Task is too large.", 413) };
  const task = sanitizePreflightText(raw);
  if (!task) return { response: jsonError("Task is required.", 400) };
  return { task };
}

function compactPreflightSnapshot(
  decision: PreflightDecision,
  approvedByHuman: boolean,
  approvalNotePresent: boolean,
) {
  return {
    type: "preflight",
    status: decision.status,
    risk_level: decision.risk_level,
    sensitive_areas: decision.sensitive_areas,
    matched_rule_count: decision.matched_rules.length,
    approval_required: decision.approval_required,
    approved_by_human: approvedByHuman,
    approval_note_present: approvalNotePresent,
    checked_at: new Date().toISOString(),
  };
}

async function listActiveRulesForDashboardStart(db: CookieDb, workspaceId: string): Promise<PreflightRule[]> {
  const { data, error } = await db
    .from("workspace_rules")
    .select("id, title, body, status, deleted_at")
    .eq("workspace_id", workspaceId)
    .eq("status", "active")
    .is("deleted_at", null);

  if (error) throw error;
  return ((data ?? []) as Array<{ id: string; title: string | null; body: string | null; status: string | null; deleted_at: string | null }>).map(
    (rule) => ({
      id: rule.id,
      title: rule.title ?? "Untitled rule",
      body: rule.body,
      status: rule.status,
      deleted_at: rule.deleted_at,
    }),
  );
}

async function dashboardRunStart(req: NextRequest): Promise<NextResponse> {
  const body = await readJsonBody(req, false);
  if (body instanceof NextResponse) return body;

  const connectionId = cleanOptionalString(body.connection_id, 80);
  if (!connectionId) return jsonError("connection_id is required.", 400);

  const parsedTask = taskFromBody(body);
  if (parsedTask.response) return parsedTask.response;
  const task = parsedTask.task!;

  const parsedPathHints = parsePathHints(body.path_hints);
  if (parsedPathHints.response) return parsedPathHints.response;

  if (typeof body.approval_note === "string" && body.approval_note.length > MAX_APPROVAL_NOTE_LENGTH) {
    return jsonError("Approval note is too large.", 413);
  }
  const approvalNote = cleanOptionalString(body.approval_note, MAX_APPROVAL_NOTE_LENGTH);
  const approvedByHuman = body.approved_by_human === true;

  const db = await createClient();
  if (!db) return jsonError("M9R is not configured.", 503);
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return jsonError("Sign in to start a controlled run.", 401);

  const { data: connection, error: connectionError } = await db
    .from("agent_connections")
    .select("id, workspace_id, agent_kind, repo_hint, status")
    .eq("id", connectionId)
    .eq("status", "active")
    .maybeSingle();

  if (connectionError) return jsonError("Failed to resolve agent connection.", 500);
  if (!connection) return jsonError("Agent connection was not found.", 404);

  const row = connection as {
    id: string;
    workspace_id: string | null;
    agent_kind: string | null;
    repo_hint: string | null;
  };
  if (!row.workspace_id) return jsonError("Agent connection has no workspace.", 400);

  const activeRules = await listActiveRulesForDashboardStart(db, row.workspace_id);
  const decision = buildPreflightDecision(
    {
      task,
      pathHints: parsedPathHints.hints ?? [],
      approvalNote,
    },
    activeRules,
  );
  const preflight = compactPreflightSnapshot(decision, approvedByHuman, Boolean(approvalNote));

  if (decision.status === "blocked") {
    return jsonError("Blocked by policy.", 403, { preflight });
  }
  if (decision.status === "needs_approval" && approvedByHuman !== true) {
    return jsonError("Human approval is required before starting this run.", 403, { preflight });
  }

  const runMode = isRunMode(body.run_mode) ? body.run_mode : "solo";
  const result = await startAgentRun({
    connectionId: row.id,
    workspaceId: row.workspace_id,
    agentKind: row.agent_kind as import("@/lib/agent-join").AgentKind,
    scopes: ["session:submit"],
    repoHint: row.repo_hint,
    tokenId: null,
  }, {
    taskTitle: task,
    repoHint: cleanOptionalString(body.repo_hint, 200) ?? row.repo_hint,
    runMode,
  });

  return NextResponse.json(
    {
      ...result,
      collaboration_policy: defaultPolicyForMode(runMode),
      preflight,
      preflight_persistence: PREFLIGHT_PERSISTENCE_SUPPORTED ? "stored" : "skipped_no_safe_field",
    },
    { status: 201 },
  );
}

async function bearerRunStart(req: NextRequest, token: string): Promise<NextResponse> {
  const agent = await authenticateAgent(token);
  if (!agent) {
    return NextResponse.json({ error: "Invalid or missing agent token." }, { status: 401 });
  }
  if (!agent.scopes.includes("session:submit")) {
    return NextResponse.json({ error: "Token lacks session:submit scope." }, { status: 403 });
  }

  const body = await readJsonBody(req, false);
  if (body instanceof NextResponse) return body;

  const parsedTask = taskFromBody(body);
  if (parsedTask.response) return parsedTask.response;
  const task = parsedTask.task!;

  const parsedPathHints = parsePathHints(body.path_hints);
  if (parsedPathHints.response) return parsedPathHints.response;

  const activeRules = (await listActiveRulesForAgent(agent)).map((rule) => ({
    id: rule.id,
    title: rule.title,
    body: rule.body,
    status: "active",
    deleted_at: null,
  } satisfies PreflightRule));
  const decision = buildPreflightDecision(
    {
      task,
      pathHints: parsedPathHints.hints ?? [],
      // A bearer caller is the agent, not the human. Its body can never supply
      // approval provenance or an approval note on the human's behalf.
      approvalNote: null,
    },
    activeRules,
  );
  const preflight = compactPreflightSnapshot(decision, false, false);

  if (decision.status === "blocked") {
    return jsonError("Blocked by policy.", 403, { preflight });
  }

  // There is no pre-assigned run/mission id in scope here — startAgentRun has
  // not been called yet in the needs_approval branch below. The task text is
  // the only thing that identifies *what* this specific run-start attempt was
  // for, so a hash of it (never the raw text) is used as operation_identity:
  // stable across identical retries, distinct across different tasks, and
  // never itself secret-shaped content stored in the approval-request row.
  const operationIdentity = sha256Hex(task);
  const approvalKeyInput = {
    workspaceId: agent.workspaceId,
    connectionId: agent.connectionId,
    operationType: APPROVAL_OPERATION_TYPE_RUN_START,
    operationIdentity,
  };

  if (decision.status === "needs_approval") {
    const existing = await findApprovalRequestByIdempotencyKey(approvalKeyInput);
    if (existing?.status === "approved") {
      return startBearerRunAfterApproval(agent, body, task, preflight, existing.id);
    }
    if (existing?.status === "rejected") {
      return jsonError("This run start was rejected by a human reviewer.", 403, {
        error: "approval_rejected",
        approvalRequestId: existing.id,
        workspaceId: agent.workspaceId,
        dashboardPath: `/dashboard/approvals/${existing.id}`,
        preflight,
      });
    }

    const approvalRequest = await createOrGetPendingApprovalRequest({
      workspaceId: agent.workspaceId,
      connectionId: agent.connectionId,
      operationType: APPROVAL_OPERATION_TYPE_RUN_START,
      operationIdentity,
      riskClassification: decision.risk_level,
      requestSummary: preflight,
    });

    // Announce the request in the agent's DM the same way an evidence-review
    // request already does, so it can show as an inline Approve/Reject card
    // in the message feed instead of only existing in the Approval Center
    // drawer. Only the first time -- a retried/idempotent 403 must not repost.
    if (!approvalRequest.requestSummary.requestMessageId) {
      try {
        const conversationId = await findOrCreateAgentDmForBearer(agent);
        const message = await sendConversationMessage(agent, {
          conversationId,
          recipientConnectionId: null,
          kind: "notice",
          body: `Requesting approval to start a run (${decision.risk_level} risk): ${task.slice(0, 300)}`,
          parentMessageId: null,
          idempotencyKey: `approval-request-message:${approvalRequest.id}`,
        });
        await attachApprovalRequestMessage(approvalRequest.id, agent.workspaceId, message.id);
      } catch {
        // The drawer/full-page approval flow remains the source of truth;
        // the inline chat card is additive and must never block run-start.
      }
    }

    return NextResponse.json(
      {
        error: "approval_required",
        message: "Human approval is required before starting this run.",
        approvalRequestId: approvalRequest.id,
        workspaceId: agent.workspaceId,
        operationType: APPROVAL_OPERATION_TYPE_RUN_START,
        riskClassification: approvalRequest.riskClassification,
        approvalState: approvalRequest.status,
        dashboardPath: `/dashboard/approvals/${approvalRequest.id}`,
        nextAction: `Open /dashboard/approvals/${approvalRequest.id} to approve or reject this request.`,
        preflight,
      },
      { status: 403 },
    );
  }

  return startBearerRunAfterApproval(agent, body, task, preflight, null);
}

type AuthedAgentForStart = NonNullable<Awaited<ReturnType<typeof authenticateAgent>>>;

async function startBearerRunAfterApproval(
  agent: AuthedAgentForStart,
  body: StartBody,
  task: string,
  preflight: ReturnType<typeof compactPreflightSnapshot>,
  consumedApprovalRequestId: string | null,
): Promise<NextResponse> {
  // Note: body.agent_kind is intentionally ignored — the run is attributed to
  // the authenticated connection's stored agent kind, never caller input.
  const runMode = isRunMode(body.run_mode) ? body.run_mode : "solo";
  const result = await startAgentRun(agent, {
    taskTitle: task,
    repoHint: cleanOptionalString(body.repo_hint, 200) ?? agent.repoHint,
    runMode,
  });

  if (consumedApprovalRequestId) {
    await markApprovalRequestConsumed(consumedApprovalRequestId, agent.workspaceId).catch((err) => {
      console.error("markApprovalRequestConsumed failed:", err instanceof Error ? err.message : err);
    });
  }

  return NextResponse.json(
    {
      ...result,
      collaboration_policy: defaultPolicyForMode(runMode),
      preflight,
      preflight_persistence: PREFLIGHT_PERSISTENCE_SUPPORTED ? "stored" : "skipped_no_safe_field",
    },
    { status: 201 },
  );
}

export async function POST(req: NextRequest) {
  try {
    const token = bearerFrom(req.headers.get("authorization"));
    if (token) return bearerRunStart(req, token);
    return dashboardRunStart(req);
  } catch (err) {
    return handleAgentError(err);
  }
}
