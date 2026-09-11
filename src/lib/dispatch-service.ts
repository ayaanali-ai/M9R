/**
 * Dispatch Service — DB-facing writes/reads for the Wire (V2 Phase 2).
 * ----------------------------------------------------------------------------
 * Mirrors the trust model in agent-run-service.ts / evidence-contract.ts:
 *  - Writes use the service-role client, scoped in app code to the caller's
 *    own run/workspace — never a client-supplied workspace id trusted blind.
 *  - Reads use the cookie client, so RLS limits results to workspaces the
 *    signed-in user owns.
 *  - Publishing is idempotent: a Postgres unique-violation on
 *    (run_id, idempotency_key) means "already published," not an error.
 */

import { supabase } from "@/lib/supabase";
import { createClient } from "@/lib/supabase/server";
import { AgentJoinError } from "@/lib/agent-join-service";
import { validateDispatch, type DispatchInput, type DispatchType } from "@/lib/dispatch";

const UNIQUE_VIOLATION = "23505";

/**
 * True when the `dispatches` migration hasn't been applied to this Supabase
 * instance yet — either the raw Postgres "undefined_table" code, or
 * PostgREST's own "table not found in schema cache" code (PGRST205), which is
 * what actually surfaces through supabase-js in practice.
 */
function isMissingTableError(err: { code?: string | null; message?: string | null } | null): boolean {
  if (!err) return false;
  return err.code === "42P01" || err.code === "PGRST205" || /Could not find the table/i.test(err.message ?? "");
}

function requireService() {
  if (!supabase) {
    throw new AgentJoinError("M9R agent backend is not configured.", "DB_NOT_CONFIGURED", 503);
  }
  return supabase;
}

export interface PublishDispatchResult {
  ok: boolean;
  /** True only when this call actually inserted a new row (not a dedup hit). */
  newlyPublished: boolean;
  id: string | null;
  errors: string[];
}

/**
 * Validate and publish a Dispatch. Best-effort like recordRunEvent: a failure
 * here never blocks the run-lifecycle action that triggered it (callers treat
 * this as a side channel, not the source of truth).
 */
export async function publishDispatch(input: DispatchInput): Promise<PublishDispatchResult> {
  const result = validateDispatch(input);
  if (!result.ok || !result.normalized) {
    return { ok: false, newlyPublished: false, id: null, errors: result.errors.map((e) => `${e.field}: ${e.message}`) };
  }
  const d = result.normalized;

  try {
    const db = requireService();
    const { data, error } = await db
      .from("dispatches")
      .insert({
        workspace_id: d.workspaceId,
        run_id: d.runId,
        schema_version: d.schemaVersion,
        type: d.type,
        sender: d.sender,
        summary: d.summary,
        detail: d.detail,
        scope: d.scope,
        visibility: d.visibility,
        resolution_state: d.resolutionState,
        expires_at: d.expiresAt,
        idempotency_key: d.idempotencyKey,
      })
      .select("id")
      .single();

    if (error) {
      if (error.code === UNIQUE_VIOLATION) {
        const { data: existing, error: lookupError } = await db.from("dispatches")
          .select("id")
          .eq("run_id", d.runId)
          .eq("idempotency_key", d.idempotencyKey)
          .maybeSingle();
        if (lookupError || !existing?.id) {
          console.error("publishDispatch dedupe lookup failed:", lookupError?.code ?? "missing", lookupError?.message ?? "row not found");
          return { ok: false, newlyPublished: false, id: null, errors: ["Dispatch dedupe lookup failed."] };
        }
        return { ok: true, newlyPublished: false, id: existing.id as string, errors: [] };
      }
      if (isMissingTableError(error)) {
        return { ok: true, newlyPublished: false, id: null, errors: [] };
      }
      console.error("publishDispatch failed:", error.message, error.code);
      return { ok: false, newlyPublished: false, id: null, errors: [error.message] };
    }
    return { ok: true, newlyPublished: true, id: (data as { id: string }).id, errors: [] };
  } catch (err) {
    console.error("publishDispatch threw:", err instanceof Error ? err.message : err);
    return { ok: false, newlyPublished: false, id: null, errors: ["Dispatch publish failed."] };
  }
}

export interface WireEntry {
  id: string;
  runId: string;
  type: DispatchType;
  sender: string;
  summary: string;
  detail: Record<string, unknown> | null;
  scope: string[];
  resolutionState: string;
  createdAt: string;
  targetConnectionId?: string | null;
  residentInstanceId?: string | null;
  assignmentId?: string | null;
  routingReason?: string | null;
  approvalState?: string;
}

/** Fail closed when deciding whether an equivalent unresolved request exists. */
export async function hasOpenSimilarDispatch(input: {
  workspaceId: string;
  runId: string;
  type: "HELP_REQUESTED" | "CHECK_REQUESTED";
  summary: string;
}): Promise<boolean> {
  const db = requireService();
  const { data, error } = await db.from("dispatches")
    .select("id")
    .eq("workspace_id", input.workspaceId)
    .eq("run_id", input.runId)
    .eq("type", input.type)
    .eq("summary", input.summary)
    .eq("resolution_state", "open")
    .limit(1);
  if (error) throw new AgentJoinError("Could not verify coordination request uniqueness.", "DISPATCH_READ_FAILED", 500);
  return (data?.length ?? 0) > 0;
}

/**
 * Read recent Dispatches for the signed-in human's workspaces — the Wire.
 * Mirrors listAgentRunsForUser() in agent-run-service.ts: no explicit
 * workspace filter needed, RLS on `dispatches` already scopes rows to
 * workspaces the signed-in user owns (see supabase-dispatches.sql).
 */
export async function listWireForUser(opts: { limit?: number } = {}): Promise<WireEntry[]> {
  const db = await createClient();
  if (!db) return [];
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return [];

  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const { data, error } = await db
    .from("dispatches")
    .select("id, run_id, type, sender, summary, detail, scope, resolution_state, created_at, target_connection_id, resident_instance_id, assignment_id, routing_reason, approval_state")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    if (isMissingTableError(error)) return [];
    throw error;
  }

  return ((data ?? []) as Array<{
    id: string;
    run_id: string;
    type: string;
    sender: string;
    summary: string;
    detail: Record<string, unknown> | null;
    scope: string[] | null;
    resolution_state: string;
    created_at: string;
    target_connection_id?: string | null;
    resident_instance_id?: string | null;
    assignment_id?: string | null;
    routing_reason?: string | null;
    approval_state?: string;
  }>).map((row) => ({
    id: row.id,
    runId: row.run_id,
    type: row.type as DispatchType,
    sender: row.sender,
    summary: row.summary,
    detail: row.detail,
    scope: row.scope ?? [],
    resolutionState: row.resolution_state,
    createdAt: row.created_at,
    targetConnectionId: row.target_connection_id ?? null,
    residentInstanceId: row.resident_instance_id ?? null,
    assignmentId: row.assignment_id ?? null,
    routingReason: row.routing_reason ?? null,
    approvalState: row.approval_state ?? "not_applicable",
  }));
}

function reduceLatestScope(
  rows: Array<{ run_id: string; sender: string; scope: string[] | null }>,
): Map<string, { sender: string; scope: string[] }> {
  const latest = new Map<string, { sender: string; scope: string[] }>();
  for (const row of rows) {
    if (!latest.has(row.run_id)) {
      latest.set(row.run_id, { sender: row.sender, scope: row.scope ?? [] });
    }
  }
  return latest;
}

/**
 * The most recently announced scope for each run that has published a
 * SCOPE_ANNOUNCED Dispatch, for the signed-in user's workspaces (RLS-scoped).
 * Used by collision.ts — there is no separate "declared scope" table.
 */
export async function listLatestScopeByRun(): Promise<Map<string, { sender: string; scope: string[] }>> {
  const db = await createClient();
  const empty = new Map<string, { sender: string; scope: string[] }>();
  if (!db) return empty;
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return empty;

  const { data, error } = await db
    .from("dispatches")
    .select("run_id, sender, scope, created_at")
    .eq("type", "SCOPE_ANNOUNCED")
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) {
    if (isMissingTableError(error)) return empty;
    throw error;
  }
  return reduceLatestScope((data ?? []) as Array<{ run_id: string; sender: string; scope: string[] | null }>);
}

/**
 * Service-role variant for Bearer-authenticated (agent) callers with no
 * cookie session to rely on RLS — explicitly scoped to one workspace, since
 * the service-role client bypasses RLS entirely.
 */
export async function listLatestScopeByRunForWorkspace(
  workspaceId: string,
): Promise<Map<string, { sender: string; scope: string[] }>> {
  const empty = new Map<string, { sender: string; scope: string[] }>();
  const db = requireService();
  const { data, error } = await db
    .from("dispatches")
    .select("run_id, sender, scope, created_at")
    .eq("type", "SCOPE_ANNOUNCED")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) {
    if (isMissingTableError(error)) return empty;
    throw error;
  }
  return reduceLatestScope((data ?? []) as Array<{ run_id: string; sender: string; scope: string[] | null }>);
}

/** Read all Dispatches for one run (RLS-scoped) — used to build the Run Thread. */
export async function listDispatchesForRun(runId: string): Promise<WireEntry[]> {
  const db = await createClient();
  if (!db) return [];
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return [];

  const { data, error } = await db
    .from("dispatches")
    .select("id, run_id, type, sender, summary, detail, scope, resolution_state, created_at, target_connection_id, resident_instance_id, assignment_id, routing_reason, approval_state")
    .eq("run_id", runId)
    .order("created_at", { ascending: true })
    .limit(500);

  if (error) {
    if (isMissingTableError(error)) return [];
    throw error;
  }

  return ((data ?? []) as Array<{
    id: string;
    run_id: string;
    type: string;
    sender: string;
    summary: string;
    detail: Record<string, unknown> | null;
    scope: string[] | null;
    resolution_state: string;
    created_at: string;
    target_connection_id?: string | null;
    resident_instance_id?: string | null;
    assignment_id?: string | null;
    routing_reason?: string | null;
    approval_state?: string;
  }>).map((row) => ({
    id: row.id,
    runId: row.run_id,
    type: row.type as DispatchType,
    sender: row.sender,
    summary: row.summary,
    detail: row.detail,
    scope: row.scope ?? [],
    resolutionState: row.resolution_state,
    createdAt: row.created_at,
    targetConnectionId: row.target_connection_id ?? null,
    residentInstanceId: row.resident_instance_id ?? null,
    assignmentId: row.assignment_id ?? null,
    routingReason: row.routing_reason ?? null,
    approvalState: row.approval_state ?? "not_applicable",
  }));
}
