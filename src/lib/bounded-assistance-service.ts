/**
 * Bounded Assistance Service — DB-facing writes/reads for Phase 8.
 * ----------------------------------------------------------------------------
 * Depth tracking is deliberately shallow: `currentDelegationDepth` is 0 for a
 * root run, 1 if the requesting run is itself a Linked (supporting) Run
 * (parent_run_id is set). This is sufficient because every defined
 * CoordinationPolicy caps maxDelegationDepth at 1 — a supporting run's own
 * policy is what actually prevents it from delegating further (see
 * run-mode.ts's ASSURANCE_POLICY comment).
 */

import { supabase } from "@/lib/supabase";
import { AgentJoinError, type AuthedAgent } from "@/lib/agent-join-service";
import { defaultPolicyForMode, isRunMode, type RunMode, type CoordinationUsage } from "@/lib/run-mode";
import type { DispatchType } from "@/lib/dispatch";

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

const REQUEST_TYPES: DispatchType[] = ["HELP_REQUESTED", "CHECK_REQUESTED"];

export interface RunCoordinationState {
  mode: RunMode;
  usage: CoordinationUsage;
}

/** Read a run's mode + current coordination usage — all real counts, nothing assumed. */
export async function readRunCoordinationState(runId: string, workspaceId: string): Promise<RunCoordinationState> {
  const db = requireService();

  const { data: runRow, error: runError } = await db
    .from("agent_runs")
    .select("run_mode, parent_run_id")
    .eq("id", runId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (runError && !isMissingColumnError(runError)) throw runError;
  const mode: RunMode = isRunMode((runRow as { run_mode?: string } | null)?.run_mode) ? (runRow!.run_mode as RunMode) : "solo";
  const currentDelegationDepth = (runRow as { parent_run_id?: string | null } | null)?.parent_run_id ? 1 : 0;

  const { data: requestRows, error: requestError } = await db
    .from("dispatches")
    .select("id, routing_reason")
    .eq("run_id", runId)
    .eq("workspace_id", workspaceId)
    .in("type", REQUEST_TYPES);
  // Provider budget measures work that could actually be delivered. A
  // retained no-eligible-resident attempt is useful audit history, but it did
  // not invoke a model and must not strand a one-request coordinated run.
  const requestsUsed = requestError
    ? 0
    : (requestRows ?? []).filter((row) => row.routing_reason !== "no_eligible_resident").length;

  const { data: linkedRows, error: linkedError } = await db
    .from("agent_runs")
    .select("connection_id")
    .eq("parent_run_id", runId)
    .eq("workspace_id", workspaceId);
  const supportingAgentsUsed = linkedError || isMissingColumnError(linkedError)
    ? 0
    : new Set((linkedRows ?? []).map((row) => row.connection_id).filter(Boolean)).size;

  return { mode, usage: { requestsUsed, supportingAgentsUsed, currentDelegationDepth } };
}

export function policyForRun(state: RunCoordinationState) {
  return defaultPolicyForMode(state.mode);
}

export interface ClaimResult {
  ok: boolean;
  error?: string;
  linkedRunId?: string;
  alreadyClaimed?: boolean;
}

/**
 * Atomically claim an open HELP_REQUESTED/CHECK_REQUESTED Dispatch and create
 * its Linked Run. "One claimant per request" is enforced by the conditional
 * UPDATE (`WHERE resolution_state = 'open'`) — a second concurrent claim
 * attempt gets zero rows back and is told the request was already claimed,
 * never silently double-accepted.
 */
export async function claimBoundedRequest(
  claimant: AuthedAgent,
  dispatchId: string,
  taskTitle: string | null,
): Promise<ClaimResult> {
  const db = requireService();

  const { data: dispatch, error: dispatchError } = await db
    .from("dispatches")
    .select("id, run_id, workspace_id, type, sender, summary, resolution_state")
    .eq("id", dispatchId)
    .maybeSingle();
  if (dispatchError) return { ok: false, error: dispatchError.message };
  if (!dispatch) return { ok: false, error: "Request not found." };
  const d = dispatch as { id: string; run_id: string; workspace_id: string; type: string; sender: string; summary: string; resolution_state: string };
  if (!REQUEST_TYPES.includes(d.type as DispatchType)) return { ok: false, error: "That Dispatch is not a bounded request." };
  if (d.workspace_id !== claimant.workspaceId) return { ok: false, error: "Request belongs to another workspace." };

  const { data: claimed, error: claimError } = await db
    .from("dispatches")
    .update({ resolution_state: "resolved" })
    .eq("id", dispatchId)
    .eq("resolution_state", "open")
    .select("id")
    .maybeSingle();
  if (claimError) return { ok: false, error: claimError.message };
  if (!claimed) return { ok: false, alreadyClaimed: true, error: "This request was already claimed." };

  const runMode: RunMode = d.type === "CHECK_REQUESTED" ? "assurance" : "coordinated";
  const { data: linkedRun, error: linkedRunError } = await db
    .from("agent_runs")
    .insert({
      connection_id: claimant.connectionId,
      workspace_id: claimant.workspaceId,
      agent_kind: claimant.agentKind ?? null,
      task_title: taskTitle ?? d.summary,
      status: "started",
      current_phase: "started",
      parent_run_id: d.run_id,
      run_mode: runMode,
    })
    .select("id")
    .single();
  if (linkedRunError) {
    if (isMissingColumnError(linkedRunError)) {
      return { ok: false, error: "Linked Run columns are not migrated on this deployment yet." };
    }
    return { ok: false, error: linkedRunError.message };
  }

  return { ok: true, linkedRunId: (linkedRun as { id: string }).id };
}
