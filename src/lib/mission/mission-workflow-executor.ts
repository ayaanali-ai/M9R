/**
 * Runs a channel workflow's steps in order once its trigger matches — the
 * execution half of mission-workflow-schema.ts's definitions. Every step
 * failure is caught and recorded rather than thrown, mirroring the rest of
 * this Buzz-parity chat path's best-effort discipline (see
 * mission-channel-binding.ts / bindChannelMessageToMission's `.catch`):
 * a broken workflow definition must never take down message sending.
 */

import { renderWorkflowTemplate, matchesMessagePostedFilter, type ChannelWorkflowDef } from "./mission-workflow-schema";
import { postMissionMessage, requestMissionDecision } from "./mission-application-service";
import { recordChannelWorkflowRun, listExecutableMessagePostedWorkflows, type ChannelWorkflowRecord } from "./mission-workflow-store";
import type { MissionPrincipal } from "./mission-principal";
import { MISSION_BROADCAST_CHANNEL } from "./mission-domain";

export interface WorkflowTriggerContext {
  missionId: string;
  senderParticipantId: string;
  triggerMessageId: string;
  body: string;
  author: string;
}

interface StepResult {
  stepId: string;
  ok: boolean;
  detail?: string;
}

async function runStep(
  step: ChannelWorkflowDef["steps"][number],
  principal: MissionPrincipal,
  trigger: WorkflowTriggerContext,
): Promise<StepResult> {
  try {
    if (step.action.action === "send_message") {
      const text = renderWorkflowTemplate(step.action.text, { body: trigger.body, author: trigger.author });
      await postMissionMessage(principal, trigger.missionId, {
        senderParticipantId: trigger.senderParticipantId,
        messageType: "information",
        recipientParticipantIds: MISSION_BROADCAST_CHANNEL,
        body: text,
        clientRequestId: `workflow:${trigger.triggerMessageId}:${step.id}`,
      });
      return { stepId: step.id, ok: true };
    }
    if (step.action.action === "request_approval") {
      await requestMissionDecision(principal, trigger.missionId, {
        reason: step.action.message,
        clientRequestId: `workflow:${trigger.triggerMessageId}:${step.id}`,
      });
      return { stepId: step.id, ok: true };
    }
    return { stepId: step.id, ok: false, detail: "unrecognized action" };
  } catch (error) {
    return { stepId: step.id, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/** Evaluates one workflow's trigger against a just-posted message and, if it matches, runs its steps in order. Never throws — every failure mode ends in a recorded channel_workflow_runs row instead. */
export async function evaluateAndRunChannelWorkflow(
  workflow: ChannelWorkflowRecord,
  principal: MissionPrincipal,
  trigger: WorkflowTriggerContext,
): Promise<void> {
  if (workflow.definition.trigger.on !== "message_posted") return;
  if (!matchesMessagePostedFilter(workflow.definition.trigger, trigger.body)) return;

  const results: StepResult[] = [];
  for (const step of workflow.definition.steps) {
    const result = await runStep(step, principal, trigger);
    results.push(result);
    if (!result.ok) break; // Buzz's executor.rs also stops the run at the first failed step rather than continuing past a broken precondition.
  }

  const failed = results.find((result) => !result.ok);
  await recordChannelWorkflowRun({
    workflowId: workflow.id,
    workspaceId: workflow.workspaceId,
    triggerMessageId: trigger.triggerMessageId,
    status: failed ? "failed" : "completed",
    stepResults: results,
    error: failed?.detail ?? null,
  });
}

/** Runs every executable workflow bound to a conversation against one trigger message. Fetches its own workflow list so callers don't need to know the store's shape. */
export async function runChannelWorkflowsForMessage(
  conversationId: string,
  principal: MissionPrincipal,
  trigger: WorkflowTriggerContext,
): Promise<void> {
  const workflows = await listExecutableMessagePostedWorkflows(conversationId, principal.workspaceId);
  for (const workflow of workflows) {
    await evaluateAndRunChannelWorkflow(workflow, principal, trigger);
  }
}

/**
 * Runs a schedule-triggered workflow's steps, called by
 * workflow-scheduler-service.ts once per due workflow. No triggering
 * message exists, so `trigger.body`/`author` are empty/"schedule" — a
 * {{trigger.body}} template in a scheduled send_message step just renders
 * empty, which is a real (if unhelpful) outcome an author can see and fix,
 * not a crash. Never throws for the same reason evaluateAndRunChannelWorkflow
 * doesn't: one broken scheduled workflow can't stall the sweep for every
 * other due workflow.
 */
export async function runScheduleWorkflow(
  workflow: ChannelWorkflowRecord,
  principal: MissionPrincipal,
  missionId: string,
  senderParticipantId: string,
): Promise<void> {
  const trigger: WorkflowTriggerContext = { missionId, senderParticipantId, triggerMessageId: "", body: "", author: "schedule" };
  const results: StepResult[] = [];
  for (const step of workflow.definition.steps) {
    const result = await runStep(step, principal, { ...trigger, triggerMessageId: `schedule:${workflow.id}:${step.id}:${Date.now()}` });
    results.push(result);
    if (!result.ok) break;
  }
  const failed = results.find((result) => !result.ok);
  await recordChannelWorkflowRun({
    workflowId: workflow.id,
    workspaceId: workflow.workspaceId,
    triggerMessageId: null,
    status: failed ? "failed" : "completed",
    stepResults: results,
    error: failed?.detail ?? null,
  });
}
