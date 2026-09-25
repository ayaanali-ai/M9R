/**
 * The structured, typed Activity feed -- distinct row kinds (file activity,
 * permission requests, human interrupts) merged into one chronological
 * list, instead of the Files rail's file-only view or free-form chat text.
 * Every row here is composed from tables that already exist and are already
 * durable (workspace_file_activity, bridge_permission_requests,
 * bridge_cancel_turn_requests) -- nothing new is persisted by this module,
 * it only reads and merges.
 *
 * Deliberately does NOT include turn-started/turn-completed rows or a
 * "spawned subagent" row kind: neither is durably persisted anywhere in
 * this codebase (turn timing is in-memory telemetry only, and subagents
 * are not a concept this system has) -- inventing a row type with no real
 * backing data would be exactly the kind of fabrication this app's own
 * design principle (never claim something that isn't real) forbids.
 */
import { supabase } from "@/lib/supabase";

export type WorkspaceActivityEvent =
  | {
      kind: "native";
      id: string;
      at: string;
      connectionId: string;
      eventKind: "agent_connected" | "task_created" | "task_delivered" | "task_approved" | "task_result";
      taskId: string | null;
      handle: string | null;
    }
  | {
      kind: "file";
      id: string;
      at: string;
      connectionId: string | null;
      source: "agent_tool_call" | "fs_watch";
      filePath: string;
      activityKind: "read" | "changed" | "create" | "delete";
      status: "started" | "succeeded" | "failed";
    }
  | {
      kind: "permission";
      id: string;
      at: string;
      summary: string;
      command: string | null;
      filePath: string | null;
      status: "pending" | "approved" | "denied" | "consumed";
    }
  | {
      kind: "interrupt";
      id: string;
      at: string;
      connectionId: string;
      requestedByUserId: string;
      status: "pending" | "consumed";
    };

function requireService() {
  if (!supabase) throw new Error("M9R backend is not configured.");
  return supabase;
}

const FEED_LIMIT_PER_SOURCE = 80;

export async function listWorkspaceActivityFeed(workspaceId: string): Promise<WorkspaceActivityEvent[]> {
  const db = requireService();
  const [fileResult, permissionResult, interruptResult, nativeResult] = await Promise.all([
    db.from("workspace_file_activity")
      .select("id, connection_id, file_path, activity_kind, status, source, created_at")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false })
      .limit(FEED_LIMIT_PER_SOURCE),
    db.from("bridge_permission_requests")
      .select("id, summary, command, file_path, status, created_at")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false })
      .limit(FEED_LIMIT_PER_SOURCE),
    db.from("bridge_cancel_turn_requests")
      .select("id, connection_id, requested_by_user_id, status, created_at")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false })
      .limit(FEED_LIMIT_PER_SOURCE),
    db.from("native_events")
      .select("id, connection_id, kind, task_id, handle, occurred_at")
      .eq("workspace_id", workspaceId)
      .order("occurred_at", { ascending: false })
      .limit(FEED_LIMIT_PER_SOURCE),
  ]);
  if (fileResult.error) throw new Error(`Could not load file activity: ${fileResult.error.message}`);
  if (permissionResult.error) throw new Error(`Could not load permission requests: ${permissionResult.error.message}`);
  if (interruptResult.error) throw new Error(`Could not load interrupt requests: ${interruptResult.error.message}`);
  // Older deployments may not yet have the additive W1 migration. Keep the existing feed available.
  if (nativeResult.error && nativeResult.error.code !== "42P01" && nativeResult.error.code !== "PGRST205") throw new Error(`Could not load native events: ${nativeResult.error.message}`);

  const events: WorkspaceActivityEvent[] = [
    ...(nativeResult.data ?? []).map((row): WorkspaceActivityEvent => ({
      kind: "native", id: String(row.id), at: String(row.occurred_at), connectionId: String(row.connection_id),
      eventKind: row.kind as Extract<WorkspaceActivityEvent, { kind: "native" }>["eventKind"],
      taskId: (row.task_id as string | null) ?? null, handle: (row.handle as string | null) ?? null,
    })),
    ...(fileResult.data ?? []).map((row): WorkspaceActivityEvent => ({
      kind: "file",
      id: String(row.id),
      at: String(row.created_at),
      connectionId: (row.connection_id as string | null) ?? null,
      source: (row.source as "agent_tool_call" | "fs_watch" | undefined) ?? "agent_tool_call",
      filePath: String(row.file_path),
      activityKind: row.activity_kind as "read" | "changed" | "create" | "delete",
      status: row.status as "started" | "succeeded" | "failed",
    })),
    ...(permissionResult.data ?? []).map((row): WorkspaceActivityEvent => ({
      kind: "permission",
      id: String(row.id),
      at: String(row.created_at),
      summary: String(row.summary),
      command: (row.command as string | null) ?? null,
      filePath: (row.file_path as string | null) ?? null,
      status: row.status as "pending" | "approved" | "denied" | "consumed",
    })),
    ...(interruptResult.data ?? []).map((row): WorkspaceActivityEvent => ({
      kind: "interrupt",
      id: String(row.id),
      at: String(row.created_at),
      connectionId: String(row.connection_id),
      requestedByUserId: String(row.requested_by_user_id),
      status: row.status as "pending" | "consumed",
    })),
  ];

  events.sort((a, b) => b.at.localeCompare(a.at));
  return events.slice(0, 150);
}
