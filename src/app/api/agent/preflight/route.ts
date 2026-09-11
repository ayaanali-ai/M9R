import { NextRequest, NextResponse } from "next/server";

import {
  authenticateAgent,
  bearerFrom,
  listActiveRulesForAgent,
} from "@/lib/agent-join-service";
import {
  buildPreflightDecision,
  sanitizePreflightText,
  type PreflightRule,
} from "@/lib/agent-preflight-service";
import { createClient } from "@/lib/supabase/server";
import { listWorkspaceRules, WorkspaceRulesError } from "@/lib/workspace-rules-service";

export const dynamic = "force-dynamic";

const MAX_TASK_LENGTH = 4000;
const MAX_APPROVAL_NOTE_LENGTH = 1000;
const MAX_PATH_HINTS = 40;
const MAX_PATH_HINT_LENGTH = 240;
const MAX_PATH_HINT_TOTAL_LENGTH = 4000;

type PreflightRequestBody = {
  connection_id?: unknown;
  task?: unknown;
  path_hints?: unknown;
  approval_note?: unknown;
};

function jsonError(error: string, status: number): NextResponse {
  return NextResponse.json({ ok: false, error }, { status });
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = sanitizePreflightText(value);
  return clean || undefined;
}

function parsePathHints(value: unknown): { hints?: string[]; response?: NextResponse } {
  if (value == null) return { hints: [] };
  if (!Array.isArray(value)) {
    return { response: jsonError("path_hints must be an array of strings.", 400) };
  }
  if (value.length > MAX_PATH_HINTS) {
    return { response: jsonError("Too many path hints.", 413) };
  }

  const hints: string[] = [];
  let totalLength = 0;
  for (const item of value) {
    if (typeof item !== "string") {
      return { response: jsonError("path_hints must be an array of strings.", 400) };
    }
    if (item.length > MAX_PATH_HINT_LENGTH) {
      return { response: jsonError("Path hint is too large.", 413) };
    }
    totalLength += item.length;
    if (totalLength > MAX_PATH_HINT_TOTAL_LENGTH) {
      return { response: jsonError("Path hints are too large.", 413) };
    }
    const clean = sanitizePreflightText(item);
    if (clean) hints.push(clean);
  }
  return { hints };
}

async function activeRulesForDashboard(connectionId: string | undefined): Promise<PreflightRule[]> {
  let workspaceId: string | undefined;

  if (connectionId) {
    const db = await createClient();
    if (!db) throw new WorkspaceRulesError("M9R is not configured.", "DB_NOT_CONFIGURED", 503);
    const {
      data: { user },
    } = await db.auth.getUser();
    if (!user) throw new WorkspaceRulesError("Sign in to run preflight.", "UNAUTHENTICATED", 401);

    const { data, error } = await db
      .from("agent_connections")
      .select("id, workspace_id, status")
      .eq("id", connectionId)
      .eq("status", "active")
      .maybeSingle();

    if (error) throw new WorkspaceRulesError("Failed to resolve agent workspace.", "WORKSPACE_LOOKUP_FAILED", 500);
    if (!data) throw new WorkspaceRulesError("Agent connection was not found.", "CONNECTION_NOT_FOUND", 404);
    workspaceId = (data as { workspace_id?: string | null }).workspace_id ?? undefined;
  }

  const rules = await listWorkspaceRules(workspaceId);
  return rules.filter((rule) => rule.status === "active");
}

export async function POST(req: NextRequest) {
  let body: PreflightRequestBody;
  try {
    body = (await req.json()) as PreflightRequestBody;
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }

  if (typeof body.task !== "string") {
    return jsonError("Task is required.", 400);
  }
  if (body.task.length > MAX_TASK_LENGTH) {
    return jsonError("Task is too large.", 413);
  }

  const task = sanitizePreflightText(body.task);
  if (!task) {
    return jsonError("Task is required.", 400);
  }

  const parsedPathHints = parsePathHints(body.path_hints);
  if (parsedPathHints.response) return parsedPathHints.response;

  let approvalNote = optionalString(body.approval_note);
  if (typeof body.approval_note === "string" && body.approval_note.length > MAX_APPROVAL_NOTE_LENGTH) {
    return jsonError("Approval note is too large.", 413);
  }
  approvalNote = approvalNote ? approvalNote.slice(0, MAX_APPROVAL_NOTE_LENGTH) : undefined;

  const connectionId = optionalString(body.connection_id);

  try {
    const agent = await authenticateAgent(bearerFrom(req.headers.get("authorization")));
    let activeRules: PreflightRule[];

    if (agent) {
      if (!agent.scopes.includes("rules:read")) {
        return jsonError("Token lacks rules:read scope.", 403);
      }
      if (connectionId && connectionId !== agent.connectionId) {
        return jsonError("Agent token does not match the requested connection.", 403);
      }
      activeRules = await listActiveRulesForAgent(agent);
    } else {
      activeRules = await activeRulesForDashboard(connectionId);
    }

    const decision = buildPreflightDecision(
      {
        task,
        pathHints: parsedPathHints.hints ?? [],
        approvalNote,
      },
      activeRules,
    );

    return NextResponse.json(decision);
  } catch (err) {
    if (err instanceof WorkspaceRulesError) {
      return NextResponse.json({ ok: false, error: err.message, code: err.code }, { status: err.status });
    }
    return jsonError("Preflight check failed.", 500);
  }
}
