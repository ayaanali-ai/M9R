import { supabase } from "@/lib/supabase";
import type { AuthedAgent, RecommendedRuleInput } from "@/lib/agent-join-service";
import { REVIEW_DECISION_EVENT_TYPE } from "@/lib/run-review-decision-service";

/**
 * Derive only repeat-pattern candidates from reviewed coordination outcomes.
 * A single rejected secondary result can be healthy disagreement; two or more
 * make a review-only workspace instruction worth showing to the human.
 */
export function deriveCoordinationRuleCandidates(input: { rejected: number; challenged: number }): RecommendedRuleInput[] {
  const nonAdopted = input.rejected + input.challenged;
  if (nonAdopted < 2) return [];
  return [{
    title: "Give secondary agents a distinct purpose",
    body: "Before invoking a secondary agent, state the distinct question, specialization, or independent check it owns. Do not ask it to repeat the primary agent's implementation unless the run explicitly requires independent assurance.",
    ruleType: "cost_control",
    confidence: nonAdopted >= 4 ? "high" : "medium",
    evidenceSummary: `${nonAdopted} secondary-agent results in reviewed workspace runs were rejected or challenged instead of adopted.`,
    sourceFindingId: null,
    expectedPrevention: "May reduce duplicated provider work and token spend that does not change the primary agent's plan.",
  }];
}

export async function loadCoordinationRuleCandidates(agent: AuthedAgent): Promise<RecommendedRuleInput[]> {
  if (!supabase) return [];
  const { data: reviewedRuns, error: runError } = await supabase
    .from("agent_runs")
    .select("id")
    .eq("workspace_id", agent.workspaceId)
    .not("latest_session_id", "is", null)
    .in("status", ["completed", "submitted"])
    .order("completed_at", { ascending: false })
    .limit(50);
  if (runError || !reviewedRuns?.length) return [];
  const candidateRunIds = reviewedRuns.map((run) => run.id as string);
  const { data: reviewEvents, error: reviewError } = await supabase
    .from("agent_run_events")
    .select("run_id")
    .in("run_id", candidateRunIds)
    .eq("event_type", REVIEW_DECISION_EVENT_TYPE);
  if (reviewError || !reviewEvents?.length) return [];
  const runIds = [...new Set(reviewEvents.map((event) => event.run_id as string).filter(Boolean))];
  if (runIds.length === 0) return [];
  const { data: decisions, error: decisionError } = await supabase
    .from("result_adoptions")
    .select("decision")
    .in("run_id", runIds);
  if (decisionError) return [];
  const counts = (decisions ?? []).reduce((result, row) => {
    if (row.decision === "rejected") result.rejected += 1;
    if (row.decision === "challenged") result.challenged += 1;
    return result;
  }, { rejected: 0, challenged: 0 });
  return deriveCoordinationRuleCandidates(counts);
}
