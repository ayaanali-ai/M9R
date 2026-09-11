/**
 * CRUD for channel_workflows — the persisted form of a
 * ChannelWorkflowDef (mission-workflow-schema.ts). Same service-role,
 * app-code-scoped trust model as conversation-service.ts.
 */

import { parse as parseYaml } from "yaml";
import { supabase } from "@/lib/supabase";
import { parseChannelWorkflowDefinition, WorkflowDefinitionError, isScheduleTriggerFireable, parseIntervalMs, type ChannelWorkflowDef } from "./mission-workflow-schema";

export interface ChannelWorkflowRecord {
  id: string;
  workspaceId: string;
  conversationId: string;
  name: string;
  definitionYaml: string;
  definition: ChannelWorkflowDef;
  enabled: boolean;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function requireService() {
  if (!supabase) throw new Error("M9R backend is not configured.");
  return supabase;
}

function toRecord(row: {
  id: string; workspace_id: string; conversation_id: string; name: string;
  definition_yaml: string; definition_json: unknown; enabled: boolean; next_run_at?: string | null; created_at: string; updated_at: string;
}): ChannelWorkflowRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    name: row.name,
    definitionYaml: row.definition_yaml,
    definition: parseChannelWorkflowDefinition(row.definition_json),
    enabled: row.enabled,
    nextRunAt: row.next_run_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const WORKFLOW_COLUMNS = "id, workspace_id, conversation_id, name, definition_yaml, definition_json, enabled, next_run_at, created_at, updated_at";

/** Parses, validates, and persists a workflow authored as YAML text. Throws WorkflowDefinitionError on invalid YAML/schema. */
export async function createChannelWorkflow(input: {
  workspaceId: string; conversationId: string; definitionYaml: string; createdByUserId: string | null;
}): Promise<ChannelWorkflowRecord> {
  let parsedYaml: unknown;
  try {
    parsedYaml = parseYaml(input.definitionYaml);
  } catch (error) {
    throw new WorkflowDefinitionError(`Invalid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  const definition = parseChannelWorkflowDefinition(parsedYaml);

  const db = requireService();
  const { data, error } = await db.from("channel_workflows").insert({
    workspace_id: input.workspaceId,
    conversation_id: input.conversationId,
    name: definition.name,
    definition_yaml: input.definitionYaml,
    definition_json: definition,
    enabled: definition.enabled,
    created_by_user_id: input.createdByUserId,
  }).select(WORKFLOW_COLUMNS).single();
  if (error || !data) throw new Error(`Could not save the workflow: ${error?.message ?? "unknown error"}`);
  return toRecord(data);
}

export async function listChannelWorkflows(conversationId: string, workspaceId: string): Promise<ChannelWorkflowRecord[]> {
  const db = requireService();
  const { data, error } = await db.from("channel_workflows")
    .select(WORKFLOW_COLUMNS)
    .eq("conversation_id", conversationId).eq("workspace_id", workspaceId).order("created_at", { ascending: false });
  if (error) throw new Error(`Could not load workflows: ${error.message}`);
  return (data ?? []).map(toRecord);
}

/** Enabled workflows whose trigger is executable today (message_posted) for one conversation. Never throws on a single bad row — skips and logs it instead, so one corrupt definition can't take down every other workflow's execution. */
export async function listExecutableMessagePostedWorkflows(conversationId: string, workspaceId: string): Promise<ChannelWorkflowRecord[]> {
  const db = requireService();
  const { data, error } = await db.from("channel_workflows")
    .select(WORKFLOW_COLUMNS)
    .eq("conversation_id", conversationId).eq("workspace_id", workspaceId).eq("enabled", true);
  if (error) throw new Error(`Could not load workflows: ${error.message}`);
  const records: ChannelWorkflowRecord[] = [];
  for (const row of data ?? []) {
    try {
      const record = toRecord(row);
      if (record.definition.trigger.on === "message_posted") records.push(record);
    } catch (parseError) {
      console.warn(`Skipping corrupt channel_workflows row ${row.id}:`, parseError instanceof Error ? parseError.message : parseError);
    }
  }
  return records;
}

/**
 * Enabled schedule-triggered workflows across every workspace that are due
 * to fire right now: next_run_at is null (never swept yet) or in the past.
 * Global (not workspace-scoped) because the caller is the periodic sweep
 * itself (/api/internal/workflow-scheduler), not a signed-in owner's own
 * request — same reasoning as sweepStaleRuns being global. Skips, rather
 * than throws on, a row whose definition no longer parses or whose trigger
 * isn't schedule/interval (e.g. edited after being marked enabled) — one bad
 * row can't stall every other workspace's due workflows.
 */
export async function listDueScheduleWorkflows(nowIso: string): Promise<ChannelWorkflowRecord[]> {
  const db = requireService();
  const { data, error } = await db.from("channel_workflows")
    .select(WORKFLOW_COLUMNS)
    .eq("enabled", true)
    .or(`next_run_at.is.null,next_run_at.lte.${nowIso}`);
  if (error) throw new Error(`Could not load due schedule workflows: ${error.message}`);
  const records: ChannelWorkflowRecord[] = [];
  for (const row of data ?? []) {
    try {
      const record = toRecord(row);
      if (isScheduleTriggerFireable(record.definition.trigger)) records.push(record);
    } catch (parseError) {
      console.warn(`Skipping corrupt channel_workflows row ${row.id}:`, parseError instanceof Error ? parseError.message : parseError);
    }
  }
  return records;
}

/** Advances a schedule workflow's next_run_at by its own interval from now, after a sweep has run (or skipped, if disabled mid-sweep) it. Uses the record's own trigger.interval, not a caller-supplied duration, so a workflow can never be advanced by a schedule other than the one it was authored with. */
export async function advanceScheduleWorkflow(workflow: ChannelWorkflowRecord, ranAtIso: string): Promise<void> {
  if (workflow.definition.trigger.on !== "schedule" || !workflow.definition.trigger.interval) return;
  const intervalMs = parseIntervalMs(workflow.definition.trigger.interval);
  if (intervalMs === null) return;
  const nextRunAt = new Date(new Date(ranAtIso).getTime() + intervalMs).toISOString();
  const db = requireService();
  const { error } = await db.from("channel_workflows")
    .update({ last_run_at: ranAtIso, next_run_at: nextRunAt })
    .eq("id", workflow.id);
  if (error) console.warn(`Could not advance next_run_at for workflow ${workflow.id}:`, error.message);
}

export async function setChannelWorkflowEnabled(id: string, workspaceId: string, enabled: boolean): Promise<void> {
  const db = requireService();
  const { error } = await db.from("channel_workflows").update({ enabled, updated_at: new Date().toISOString() }).eq("id", id).eq("workspace_id", workspaceId);
  if (error) throw new Error(`Could not update the workflow: ${error.message}`);
}

export async function deleteChannelWorkflow(id: string, workspaceId: string): Promise<void> {
  const db = requireService();
  const { error } = await db.from("channel_workflows").delete().eq("id", id).eq("workspace_id", workspaceId);
  if (error) throw new Error(`Could not delete the workflow: ${error.message}`);
}

export async function recordChannelWorkflowRun(input: {
  workflowId: string; workspaceId: string; triggerMessageId: string | null;
  status: "completed" | "failed"; stepResults: Array<{ stepId: string; ok: boolean; detail?: string }>; error?: string | null;
}): Promise<void> {
  const db = requireService();
  const { error } = await db.from("channel_workflow_runs").insert({
    workflow_id: input.workflowId, workspace_id: input.workspaceId, trigger_message_id: input.triggerMessageId,
    status: input.status, step_results: input.stepResults, error: input.error ?? null,
  });
  if (error) console.warn(`Could not record channel_workflow_runs for ${input.workflowId}:`, error.message);
}
