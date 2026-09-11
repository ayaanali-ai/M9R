import { supabase } from "@/lib/supabase";
import { AgentJoinError, type AuthedAgent } from "@/lib/agent-join-service";
import { validateResultAdoption } from "@/lib/result-adoption";
import type { LaunchEventUsage } from "@/lib/resident-service-contract";
import type { RunBehavior } from "@/lib/agent-run-service";

function db() {
  if (!supabase) throw new AgentJoinError("M9R agent backend is not configured.", "DB_NOT_CONFIGURED", 503);
  return supabase;
}

export async function listReturnedResultsForAgent(agent: AuthedAgent, runId: string) {
  const client = db();
  const { data: run } = await client.from("agent_runs").select("id")
    .eq("id", runId).eq("workspace_id", agent.workspaceId).eq("connection_id", agent.connectionId).maybeSingle();
  if (!run) throw new AgentJoinError("Run was not found.", "RUN_NOT_FOUND", 404);

  const { data: routed, error: routedError } = await client.from("dispatches").select("launch_grant_id")
    .eq("workspace_id", agent.workspaceId).eq("run_id", runId).not("launch_grant_id", "is", null);
  if (routedError) throw new AgentJoinError("Could not list returned provider results.", "RESULT_LIST_FAILED", 500);
  const routedGrantIds = [...new Set((routed ?? []).map((row: { launch_grant_id: string | null }) => row.launch_grant_id).filter((id): id is string => Boolean(id)))];
  if (routedGrantIds.length === 0) return [];

  const { data: grants, error: grantsError } = await client.from("launch_grants")
    .select("id, provider, state")
    .eq("workspace_id", agent.workspaceId)
    .eq("requesting_connection_id", agent.connectionId)
    .eq("state", "returning")
    .in("id", routedGrantIds)
    .order("updated_at", { ascending: false })
    .limit(50);
  if (grantsError) throw new AgentJoinError("Could not list returned provider results.", "RESULT_LIST_FAILED", 500);
  const grantRows = (grants ?? []) as Array<{ id: string; provider: string; state: string }>;
  if (grantRows.length === 0) return [];

  const grantIds = grantRows.map((grant) => grant.id);
  const [{ data: events, error: eventsError }, { data: adoptions, error: adoptionsError }] = await Promise.all([
    client.from("launch_events").select("launch_grant_id, payload, occurred_at")
      .in("launch_grant_id", grantIds).eq("event_type", "return_result").order("sequence", { ascending: false }),
    client.from("result_adoptions").select("launch_grant_id, decision").eq("run_id", runId).in("launch_grant_id", grantIds),
  ]);
  if (eventsError || adoptionsError) throw new AgentJoinError("Could not read returned provider results.", "RESULT_LIST_FAILED", 500);
  const adoptedIds = new Set((adoptions ?? []).map((row: { launch_grant_id: string }) => row.launch_grant_id));
  const latestByGrant = new Map<string, { payload: Record<string, unknown>; occurred_at: string }>();
  for (const row of (events ?? []) as Array<{ launch_grant_id: string; payload: Record<string, unknown> | null; occurred_at: string }>) {
    if (!latestByGrant.has(row.launch_grant_id)) latestByGrant.set(row.launch_grant_id, { payload: row.payload ?? {}, occurred_at: row.occurred_at });
  }
  return grantRows.flatMap((grant) => {
    if (adoptedIds.has(grant.id)) return [];
    const event = latestByGrant.get(grant.id);
    if (!event) return [];
    return [{
      launch_grant_id: grant.id,
      provider: grant.provider,
      model_tier: event.payload.model_tier ?? null,
      requested_model: event.payload.requested_model ?? null,
      reported_model: event.payload.reported_model ?? null,
      result_text: event.payload.result_text ?? "",
      usage: event.payload.usage ?? null,
      returned_at: event.occurred_at,
    }];
  });
}

/**
 * Provides custody-state visibility for a requesting agent without exposing a
 * provider transcript. A missing returned result is otherwise ambiguous: it
 * could be queued, running, timed out, or failed.
 */
export async function listCoordinationStatusesForAgent(agent: AuthedAgent, runId: string) {
  const client = db();
  const { data: run } = await client.from("agent_runs").select("id")
    .eq("id", runId).eq("workspace_id", agent.workspaceId).eq("connection_id", agent.connectionId).maybeSingle();
  if (!run) throw new AgentJoinError("Run was not found.", "RUN_NOT_FOUND", 404);

  const { data: routed, error: routedError } = await client.from("dispatches").select("launch_grant_id")
    .eq("workspace_id", agent.workspaceId).eq("run_id", runId).not("launch_grant_id", "is", null);
  if (routedError) throw new AgentJoinError("Could not list coordination statuses.", "RESULT_LIST_FAILED", 500);
  const grantIds = [...new Set((routed ?? []).map((row: { launch_grant_id: string | null }) => row.launch_grant_id).filter((id): id is string => Boolean(id)))];
  if (grantIds.length === 0) return [];

  const { data: grants, error: grantsError } = await client.from("launch_grants")
    .select("id, provider, state, updated_at, expires_at")
    .eq("workspace_id", agent.workspaceId)
    .eq("requesting_connection_id", agent.connectionId)
    .in("id", grantIds)
    .order("updated_at", { ascending: false })
    .limit(50);
  if (grantsError) throw new AgentJoinError("Could not list coordination statuses.", "RESULT_LIST_FAILED", 500);
  const rows = (grants ?? []) as Array<{ id: string; provider: string; state: string; updated_at: string; expires_at: string }>;
  // This status readout is requester-scoped and must stay transcript-free --
  // select only the one derived scalar (failure_code) via Postgres's JSON
  // arrow operator, never the raw event payload/transcript blob itself.
  const { data: events, error: eventsError } = await client.from("launch_events")
    .select("launch_grant_id, event_type, sequence, failure_code:payload->>failure_code")
    .in("launch_grant_id", rows.map((grant) => grant.id))
    .order("sequence", { ascending: false });
  if (eventsError) throw new AgentJoinError("Could not list coordination statuses.", "RESULT_LIST_FAILED", 500);
  const latestEventByGrant = new Map<string, { event_type: string; failure_code: string | null }>();
  for (const event of (events ?? []) as Array<{ launch_grant_id: string; event_type: string; failure_code: string | null }>) {
    if (!latestEventByGrant.has(event.launch_grant_id)) latestEventByGrant.set(event.launch_grant_id, event);
  }
  return rows.map((grant) => ({
    launch_grant_id: grant.id,
    provider: grant.provider,
    state: grant.state,
    updated_at: grant.updated_at,
    expires_at: grant.expires_at,
    last_event: latestEventByGrant.get(grant.id)?.event_type ?? null,
    failure_code: latestEventByGrant.get(grant.id)?.failure_code ?? null,
  }));
}

/**
 * Adoption is the first point where a resident launch's provider result is
 * tied to a real run id — so it's also the natural point to carry over the
 * usage/cost the provider CLI reported on its own `return_result` event
 * (see resident-provider-adapters.ts's extractProviderUsage). A failure here
 * must never block the adoption decision itself; usage is a bonus, not the
 * point of this record.
 */
async function mergeAdoptedUsageIntoRunBehavior(
  client: NonNullable<typeof supabase>,
  runId: string,
  launchGrantId: string,
): Promise<void> {
  try {
    const { data: event } = await client.from("launch_events").select("payload")
      .eq("launch_grant_id", launchGrantId).eq("event_type", "return_result")
      .order("sequence", { ascending: false }).limit(1).maybeSingle();
    const usage = (event?.payload as { usage?: LaunchEventUsage } | null)?.usage;
    if (!usage) return;

    const { data: run } = await client.from("agent_runs").select("behavior").eq("id", runId).maybeSingle();
    const existing = (run?.behavior as RunBehavior | null) ?? {};
    const merged: RunBehavior = {
      ...existing,
      totalTokens: usage.totalTokens ?? existing.totalTokens ?? null,
      inputTokens: usage.inputTokens ?? existing.inputTokens ?? null,
      outputTokens: usage.outputTokens ?? existing.outputTokens ?? null,
      costUsd: usage.costUsd ?? existing.costUsd ?? null,
    };
    await client.from("agent_runs").update({ behavior: merged }).eq("id", runId);
  } catch {
    // Usage carryover is best-effort — never let it block or fail an adoption decision.
  }
}

export async function recordResultAdoption(agent: AuthedAgent, runId: string, launchGrantId: string, payload: unknown) {
  const validated = validateResultAdoption(payload);
  if (!validated.ok || !validated.adoption) throw new AgentJoinError("Result adoption is invalid.", "INVALID_ADOPTION", 400);
  const client = db();
  const { data: run } = await client.from("agent_runs").select("id, workspace_id, connection_id")
    .eq("id", runId).eq("workspace_id", agent.workspaceId).eq("connection_id", agent.connectionId).maybeSingle();
  if (!run) throw new AgentJoinError("Run was not found.", "RUN_NOT_FOUND", 404);
  const { data: grant } = await client.from("launch_grants")
    .select("id, workspace_id, assignment_id, requesting_connection_id, state")
    .eq("id", launchGrantId).eq("workspace_id", agent.workspaceId).eq("requesting_connection_id", agent.connectionId).maybeSingle();
  if (!grant) throw new AgentJoinError("Returned launch grant was not found.", "GRANT_NOT_FOUND", 404);
  if (grant.state !== "returning") throw new AgentJoinError("Only a returned provider result can be adopted.", "RESULT_NOT_RETURNED", 409);
  const { data, error } = await client.rpc("record_result_adoption_atomic", {
    p_workspace_id: agent.workspaceId,
    p_run_id: run.id,
    p_launch_grant_id: grant.id,
    p_requesting_connection_id: agent.connectionId,
    p_decision: validated.adoption.decision,
    p_rationale: validated.adoption.rationale,
    p_plan_effect: validated.adoption.planEffect,
    p_occurred_at: new Date().toISOString(),
  });
  const result = Array.isArray(data) ? data[0] as { accepted?: boolean; reason?: string; adoption_id?: string; decision?: string; created_at?: string } | undefined : null;
  if (result?.reason === "already_recorded") throw new AgentJoinError("This provider result already has an adoption decision.", "ADOPTION_ALREADY_RECORDED", 409);
  if (error || !result?.accepted || !result.adoption_id) throw new AgentJoinError("Could not record and close result adoption.", "ADOPTION_RECORD_FAILED", 500);
  await mergeAdoptedUsageIntoRunBehavior(client, run.id, grant.id);
  return { id: result.adoption_id, decision: result.decision, created_at: result.created_at };
}
