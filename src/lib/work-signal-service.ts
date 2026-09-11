import { supabase } from "@/lib/supabase";
import { AgentJoinError, type AuthedAgent } from "@/lib/agent-join-service";
import { acceptWorkSignal } from "@/lib/work-signal";

/** Coordination budget: max Work Signals a single connection may submit within the rolling window. */
const COORDINATION_BUDGET_LIMIT = 120;
const COORDINATION_BUDGET_WINDOW_MS = 60_000;

/** A connection scoped to a repo may only report signals for that repo. Unscoped connections may report any repo. */
function repoInScope(repoHint: string | null, repo: string): boolean {
  if (!repoHint) return true;
  return repoHint === repo;
}

export async function recordWorkSignal(agent: AuthedAgent, payload: unknown, runId: string | null) {
  if (!supabase) throw new AgentJoinError("M9R backend is not configured.", "DB_NOT_CONFIGURED", 503);
  const adapter = payload && typeof payload === "object" ? (payload as Record<string, unknown>).adapterInstanceId : null;
  if (typeof adapter !== "string") throw new AgentJoinError("Invalid Work Signal.", "BAD_SIGNAL", 400);
  if (runId) {
    const { data } = await supabase.from("agent_runs").select("id").eq("id", runId).eq("connection_id", agent.connectionId).eq("workspace_id", agent.workspaceId).maybeSingle();
    if (!data) throw new AgentJoinError("Run was not found for this connection.", "RUN_NOT_FOUND", 404);
  }

  const windowStart = new Date(Date.now() - COORDINATION_BUDGET_WINDOW_MS).toISOString();
  const { count: recentCount } = await supabase.from("work_signals").select("id", { count: "exact", head: true }).eq("connection_id", agent.connectionId).eq("workspace_id", agent.workspaceId).gte("received_at", windowStart);
  if (typeof recentCount === "number" && recentCount >= COORDINATION_BUDGET_LIMIT) {
    throw new AgentJoinError("Coordination budget exceeded for this connection.", "BUDGET_EXCEEDED", 429);
  }

  const { data: previous } = await supabase.from("work_signals").select("client_sequence").eq("connection_id", agent.connectionId).eq("workspace_id", agent.workspaceId).eq("adapter_instance_id", adapter).order("client_sequence", { ascending: false }).limit(1).maybeSingle();
  const accepted = acceptWorkSignal(payload, { previousSequence: typeof previous?.client_sequence === "number" ? previous.client_sequence : null, receivedAt: new Date().toISOString() });
  if (!accepted.ok) throw new AgentJoinError("Invalid or replayed Work Signal.", accepted.reason === "sequence_not_newer" ? "SIGNAL_REPLAY" : "BAD_SIGNAL", accepted.reason === "sequence_not_newer" ? 409 : 400);
  const s = accepted.signal;
  if (!repoInScope(agent.repoHint, s.repo)) throw new AgentJoinError("This connection is not scoped to that repository.", "REPO_OUT_OF_SCOPE", 403);
  const { data, error } = await supabase.from("work_signals").insert({ workspace_id: agent.workspaceId, connection_id: agent.connectionId, run_id: runId, protocol_version: s.protocolVersion, adapter_instance_id: s.adapterInstanceId, client_sequence: s.clientSequence, idempotency_key: s.idempotencyKey, type: s.type, source: s.source, summary: s.summary, scope: s.scope, repo: s.repo, correlation_id: s.correlationId, parent_event_id: s.parentEventId, received_at: s.receivedAt }).select("id, server_sequence, received_at").single();
  if (error) throw new AgentJoinError(error.code === "23505" ? "Work Signal was already recorded." : "Could not record Work Signal.", error.code === "23505" ? "SIGNAL_REPLAY" : "SIGNAL_WRITE_FAILED", error.code === "23505" ? 409 : 500);
  return data;
}
