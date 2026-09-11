/**
 * Periodic sweep for schedule-triggered channel workflows (workflow
 * automation, gap 3) — the counterpart to agent-run-service.ts's
 * sweepStaleRuns, run by the same kind of unattended Vercel Cron caller
 * (see /api/internal/workflow-scheduler, stale-run-sweep's sibling).
 *
 * A schedule trigger has no requesting human or agent behind it, so this
 * builds a `system` MissionPrincipal directly rather than resolving one from
 * a request — posted messages still need a mission_id and a real registered
 * participant id, so a workflow whose channel was never bound to a mission
 * (never mentioned an agent) is skipped, same refusal discipline as every
 * other mission-channel-binding.ts consumer.
 *
 * Honest precision limit: vercel.json's existing crons (work-signal-sweep,
 * stale-run-sweep) both run once daily, which reads as this project being on
 * Vercel's Hobby tier -- Hobby caps cron invocation to once per day. This
 * sweep is registered on the same daily cadence rather than guessing a
 * finer one that would fail deploy validation. A workflow authored with
 * trigger.interval: "30m" is real and will fire -- just at most once per day
 * until the project is on a plan that allows a shorter cron, since the sweep
 * itself is what's rate-limited, not the workflow's own interval math.
 */

import { supabase } from "@/lib/supabase";
import { listDueScheduleWorkflows, advanceScheduleWorkflow, type ChannelWorkflowRecord } from "./mission-workflow-store";
import { runScheduleWorkflow } from "./mission-workflow-executor";
import { missionOwnerParticipantId } from "./mission-channel-binding";
import type { MissionPrincipal } from "./mission-principal";

function requireService() {
  if (!supabase) throw new Error("M9R backend is not configured.");
  return supabase;
}

async function resolveScheduleContext(workflow: ChannelWorkflowRecord): Promise<{ missionId: string; ownerUserId: string } | null> {
  const db = requireService();
  const { data: conversation } = await db.from("agent_conversations").select("mission_id").eq("id", workflow.conversationId).maybeSingle();
  const missionId = conversation?.mission_id as string | null | undefined;
  if (!missionId) return null;

  const { data: project } = await db.from("projects").select("owner_id").eq("id", workflow.workspaceId).maybeSingle();
  const ownerUserId = project?.owner_id as string | null | undefined;
  if (!ownerUserId) return null;

  return { missionId, ownerUserId };
}

export interface WorkflowSweepResult {
  due: number;
  ran: number;
  skipped: number;
}

/** Runs every due schedule-triggered workflow once, then advances its next_run_at regardless of outcome — a workflow whose channel isn't mission-bound yet is skipped (and left due) rather than silently marked as having run. */
export async function sweepScheduledWorkflows(now: Date = new Date()): Promise<WorkflowSweepResult> {
  const nowIso = now.toISOString();
  const due = await listDueScheduleWorkflows(nowIso);
  let ran = 0;
  let skipped = 0;

  for (const workflow of due) {
    const context = await resolveScheduleContext(workflow);
    if (!context) {
      skipped += 1;
      continue;
    }
    const principal: MissionPrincipal = {
      actor: { kind: "system", id: "orchestrator" },
      workspaceId: workflow.workspaceId,
      kind: "system",
      userId: null,
      agent: null,
    };
    const senderParticipantId = missionOwnerParticipantId(context.missionId, context.ownerUserId);
    try {
      await runScheduleWorkflow(workflow, principal, context.missionId, senderParticipantId);
      ran += 1;
    } catch (error) {
      console.warn(`Scheduled workflow ${workflow.id} failed:`, error instanceof Error ? error.message : error);
    }
    await advanceScheduleWorkflow(workflow, nowIso);
  }

  return { due: due.length, ran, skipped };
}
