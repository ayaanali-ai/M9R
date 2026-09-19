/**
 * Callsign Service — DB-facing reads/writes for the private agent directory
 * (Phase 7). Capability Card writes are agent-initiated (Bearer, own
 * connection only); Service Record is a read-only aggregation over existing
 * runs/findings/review-decisions — no new source of truth, just counts.
 */

import { supabase } from "@/lib/supabase";
import { createClient } from "@/lib/supabase/server";
import { AgentJoinError, type AuthedAgent } from "@/lib/agent-join-service";
import { validateCapabilities } from "@/lib/capability-card";
import { validateAvailableModels } from "@/lib/available-model-options";
import { buildServiceRecord, type ServiceRecordView } from "@/lib/service-record";
import { REVIEW_DECISION_EVENT_TYPE, humanReviewFromEvents, type RunReviewEventRow } from "@/lib/run-review-decision-service";

function requireService() {
  if (!supabase) {
    throw new AgentJoinError("M9R agent backend is not configured.", "DB_NOT_CONFIGURED", 503);
  }
  return supabase;
}

function isMissingColumnError(err: { code?: string | null; message?: string | null } | null): boolean {
  if (!err) return false;
  return err.code === "42703" || /column .* does not exist/i.test(err.message ?? "");
}

export interface SetCapabilitiesResult {
  ok: boolean;
  capabilities: string[];
  errors: string[];
}

/** Set the calling agent's own declared capabilities. Never another connection's. */
export async function setCapabilities(agent: AuthedAgent, raw: unknown): Promise<SetCapabilitiesResult> {
  const result = validateCapabilities(raw);
  if (!result.ok) return { ok: false, capabilities: [], errors: result.errors };

  const db = requireService();
  const { error } = await db.from("agent_connections").update({ capabilities: result.normalized }).eq("id", agent.connectionId);
  if (error) {
    if (isMissingColumnError(error)) return { ok: true, capabilities: result.normalized, errors: [] };
    console.error("setCapabilities failed:", error.message, error.code);
    return { ok: false, capabilities: [], errors: [error.message] };
  }
  return { ok: true, capabilities: result.normalized, errors: [] };
}

export interface SetAvailableModelsResult {
  ok: boolean;
  availableModels: { id: string; label: string }[] | null;
  errors: string[];
}

/**
 * Best-effort self-report of the calling connection's own real, live ACP
 * model options (see AgentSessionHandle.availableModels) -- never another
 * connection's, and never a guessed/hardcoded catalog. This is what lets the
 * dashboard's model-override control render a real dropdown instead of a
 * hardcoded, partially-empty one.
 */
export async function setAvailableModels(agent: AuthedAgent, raw: unknown): Promise<SetAvailableModelsResult> {
  const result = validateAvailableModels(raw);
  if (!result.ok) return { ok: false, availableModels: null, errors: result.errors };

  const db = requireService();
  const { error } = await db.from("agent_connections").update({ available_models: result.normalized }).eq("id", agent.connectionId);
  if (error) {
    if (isMissingColumnError(error)) return { ok: true, availableModels: result.normalized, errors: [] };
    console.error("setAvailableModels failed:", error.message, error.code);
    return { ok: false, availableModels: null, errors: [error.message] };
  }
  return { ok: true, availableModels: result.normalized, errors: [] };
}

/** The provider's own id for the newest session M9R started for this connection, so a person can resume it natively. */
export async function setProviderSession(agent: AuthedAgent, raw: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  if (typeof raw !== "string") return { ok: false, error: "provider_session_ref must be a string." };
  const ref = raw.trim();
  if (!ref || ref.length > 256 || ref.split("").some((c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127)) return { ok: false, error: "provider_session_ref must be 1-256 characters with no whitespace." };
  const db = requireService();
  const { error } = await db.from("agent_connections")
    .update({ last_provider_session_ref: ref, last_provider_session_at: new Date().toISOString() })
    .eq("id", agent.connectionId);
  if (error) {
    if (isMissingColumnError(error)) return { ok: true };
    console.error("setProviderSession failed:", error.message, error.code);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

/**
 * Build the Service Record for one agent_kind within one workspace. Grouped
 * by agent_kind rather than a single connection id, matching how the rest of
 * the codebase already treats agent_kind as the durable identity (AgentView,
 * the Agent Workspace dock) — a reconnect gets a new connection_id but the
 * same agent_kind, and Service Record should survive that.
 */
export async function buildServiceRecordForAgentKind(workspaceId: string, agentKind: string): Promise<ServiceRecordView> {
  const db = requireService();

  const { data: runRows, error: runError } = await db
    .from("agent_runs")
    .select("id, last_seen_at")
    .eq("workspace_id", workspaceId)
    .eq("agent_kind", agentKind);
  if (runError) throw runError;
  const runs = (runRows ?? []) as Array<{ id: string; last_seen_at: string | null }>;
  const runIds = runs.map((r) => r.id);
  const lastActiveAt = runs.reduce<string | null>((latest, r) => {
    if (!r.last_seen_at) return latest;
    if (!latest || r.last_seen_at > latest) return r.last_seen_at;
    return latest;
  }, null);

  let runsNeedingFollowUp = 0;
  if (runIds.length > 0) {
    const { data: eventRows, error: eventError } = await db
      .from("agent_run_events")
      .select("run_id, event_type, message, created_at")
      .in("run_id", runIds)
      .eq("event_type", REVIEW_DECISION_EVENT_TYPE);
    if (eventError) throw eventError;
    const byRun = new Map<string, RunReviewEventRow[]>();
    for (const row of (eventRows ?? []) as Array<RunReviewEventRow & { run_id: string }>) {
      const list = byRun.get(row.run_id) ?? [];
      list.push(row);
      byRun.set(row.run_id, list);
    }
    for (const events of byRun.values()) {
      if (humanReviewFromEvents(events).decision === "needs_follow_up") runsNeedingFollowUp += 1;
    }
  }

  const { data: findingRows, error: findingError } = await db
    .from("findings")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("originating_sender", agentKind);
  const findingsPublished = findingError ? 0 : (findingRows ?? []).length;
  const findingIds = (findingRows ?? []).map((f) => (f as { id: string }).id);

  let findingsAdopted = 0;
  if (findingIds.length > 0) {
    const { data: adoptionRows, error: adoptionError } = await db
      .from("findings_adoptions")
      .select("id")
      .in("finding_id", findingIds);
    findingsAdopted = adoptionError ? 0 : (adoptionRows ?? []).length;
  }

  return buildServiceRecord({
    runsParticipated: runs.length,
    runsNeedingFollowUp,
    findingsPublished,
    findingsAdopted,
    lastActiveAt,
  });
}

export interface CallsignView {
  agentKind: string;
  connectionId: string;
  workspaceId: string;
  status: string;
  capabilities: string[];
  repoHint: string;
  lastSeenAt: string | null;
  createdAt: string;
}

/** The signed-in user's connected Callsigns (RLS-scoped). One row per connection — see dedupeCallsigns. */
export async function listCallsignsForUser(): Promise<CallsignView[]> {
  const db = await createClient();
  if (!db) return [];
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return [];

  const { data, error } = await db
    .from("agent_connections")
    .select("id, workspace_id, agent_kind, repo_hint, status, capabilities, last_seen_at, created_at")
    .neq("status", "revoked")
    .order("last_seen_at", { ascending: false })
    .limit(50);
  if (error) {
    if (isMissingColumnError(error)) {
      // capabilities column not migrated yet — fall back without it.
      const { data: fallback, error: fallbackError } = await db
        .from("agent_connections")
        .select("id, workspace_id, agent_kind, repo_hint, status, last_seen_at, created_at")
        .neq("status", "revoked")
        .order("last_seen_at", { ascending: false })
        .limit(50);
      if (fallbackError) throw fallbackError;
      return ((fallback ?? []) as Array<{
        id: string;
        workspace_id: string;
        agent_kind: string;
        repo_hint: string;
        status: string;
        last_seen_at: string | null;
        created_at: string;
      }>).map((row) => ({
        agentKind: row.agent_kind,
        connectionId: row.id,
        workspaceId: row.workspace_id,
        status: row.status,
        capabilities: [],
        repoHint: row.repo_hint,
        lastSeenAt: row.last_seen_at,
        createdAt: row.created_at,
      }));
    }
    throw error;
  }

  return ((data ?? []) as Array<{
    id: string;
    workspace_id: string;
    agent_kind: string;
    repo_hint: string;
    status: string;
    capabilities: string[] | null;
    last_seen_at: string | null;
    created_at: string;
  }>).map((row) => ({
    agentKind: row.agent_kind,
    connectionId: row.id,
    workspaceId: row.workspace_id,
    status: row.status,
    capabilities: row.capabilities ?? [],
    repoHint: row.repo_hint,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
  }));
}
