import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolveActiveOrDefaultProjectId } from "@/lib/projects-service";
import { supabase } from "@/lib/supabase";
import { listPendingChatEvidenceRequestsForWorkspace, listPendingChatEvidenceForWorkspace } from "@/lib/bridge/chat-evidence-service";
import { listPendingPermissionsForWorkspace } from "@/lib/bridge/bridge-permission-service";
import { countUnreadDashboardNotifications, listDashboardNotifications } from "@/lib/conversation-service";
import { isMissingOptionalTableError } from "@/lib/dashboard-optional-fallback";

async function currentUserAndWorkspace(): Promise<{ userId: string; workspaceId: string } | null> {
  const db = await createClient();
  if (!db) return null;
  const { data: { user } } = await db.auth.getUser();
  if (!user) return null;
  let workspaceId: string;
  try {
    workspaceId = await resolveActiveOrDefaultProjectId(db, { id: user.id, email: user.email });
  } catch {
    return null;
  }
  return { userId: user.id, workspaceId };
}

interface PendingRunStartApproval {
  id: string;
  connectionId: string;
  riskClassification: string;
  sensitiveAreas: string[];
  requestMessageId: string | null;
  createdAt: string;
  expiresAt: string;
}

async function loadRunStartApprovals(workspaceId: string): Promise<PendingRunStartApproval[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.from("approval_requests")
    .select("id, connection_id, risk_classification, request_summary, created_at, expires_at")
    .eq("workspace_id", workspaceId).eq("status", "pending").gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: true }).limit(100);
  if (error) throw error;
  return (data ?? [])
    .map((row) => ({
      id: String(row.id),
      connectionId: String(row.connection_id),
      riskClassification: String(row.risk_classification),
      requestMessageId: typeof (row.request_summary as Record<string, unknown> | null)?.requestMessageId === "string"
        ? (row.request_summary as Record<string, unknown>).requestMessageId as string
        : null,
      sensitiveAreas: Array.isArray((row.request_summary as Record<string, unknown> | null)?.sensitive_areas)
        ? ((row.request_summary as Record<string, unknown>).sensitive_areas as unknown[]).filter((v): v is string => typeof v === "string")
        : [],
      createdAt: String(row.created_at),
      expiresAt: String(row.expires_at),
    }))
    .filter((approval) => approval.requestMessageId !== null);
}

interface PendingFinding {
  id: string;
  title: string;
  observedBehavior: string;
  evidenceLevel: string;
  announcementMessageId: string | null;
  createdAt: string;
}

async function loadFindings(workspaceId: string): Promise<PendingFinding[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.from("findings")
    .select("id, title, observed_behavior, evidence_level, announcement_message_id, created_at")
    .eq("workspace_id", workspaceId).eq("review_state", "observed").not("announcement_message_id", "is", null)
    .order("created_at", { ascending: true }).limit(100);
  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: String(row.id),
    title: String(row.title),
    observedBehavior: String(row.observed_behavior),
    evidenceLevel: String(row.evidence_level),
    announcementMessageId: (row.announcement_message_id as string | null) ?? null,
    createdAt: String(row.created_at),
  }));
}

interface PendingRuleDraft {
  id: string;
  title: string;
  body: string;
  announcementMessageId: string | null;
  createdAt: string;
}

async function loadRuleDrafts(workspaceId: string): Promise<PendingRuleDraft[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.from("workspace_rules")
    .select("id, title, body, announcement_message_id, created_at")
    .eq("workspace_id", workspaceId).eq("status", "needs_review").not("announcement_message_id", "is", null)
    .order("created_at", { ascending: true }).limit(100);
  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: String(row.id),
    title: String(row.title),
    body: String(row.body),
    announcementMessageId: (row.announcement_message_id as string | null) ?? null,
    createdAt: String(row.created_at),
  }));
}

export type TaskContractItemStatus = "pending" | "in_progress" | "blocked" | "done" | "failed";
export type TaskContractStatus = "decomposing" | "executing" | "completed" | "failed";

export interface PendingTaskContractItem {
  id: string;
  description: string;
  status: TaskContractItemStatus;
  assignedConnectionId: string | null;
  reassignmentCount: number;
  resultMessageId: string | null;
}

export interface PendingTaskContract {
  id: string;
  conversationId: string;
  anchorMessageId: string;
  status: TaskContractStatus;
  decomposedByConnectionId: string | null;
  createdAt: string;
  items: PendingTaskContractItem[];
}

/**
 * Item #4 (task-contract protocol): every contract anchored to a real
 * message, for the Task Card that renders inline on that anchor message.
 * Deliberately returns raw connectionIds only, no agent label/mark
 * resolution here -- ConversationPanel already has a client-side
 * `byConnectionId` roster map every other agent-attributed card (delegation
 * cards, approval cards) resolves labels/marks through, so duplicating that
 * resolution server-side would just be a second source of truth that could
 * drift from the first.
 */
async function loadTaskContracts(workspaceId: string): Promise<PendingTaskContract[]> {
  if (!supabase) return [];
  const { data: contracts, error } = await supabase.from("task_contracts")
    .select("id, conversation_id, anchor_message_id, decomposed_by_connection_id, status, created_at")
    .eq("workspace_id", workspaceId)
    .not("anchor_message_id", "is", null)
    .order("created_at", { ascending: true }).limit(100);
  if (error) throw error;
  if (!contracts || contracts.length === 0) return [];

  const contractIds = contracts.map((row) => row.id as string);
  const { data: items, error: itemsError } = await supabase.from("task_contract_items")
    .select("id, contract_id, description, assigned_connection_id, status, reassignment_count, result_message_id")
    .in("contract_id", contractIds);
  if (itemsError) throw itemsError;

  const itemsByContractId = new Map<string, PendingTaskContractItem[]>();
  for (const item of items ?? []) {
    const contractId = String(item.contract_id);
    const bucket = itemsByContractId.get(contractId) ?? [];
    bucket.push({
      id: String(item.id),
      description: String(item.description),
      status: item.status as TaskContractItemStatus,
      assignedConnectionId: (item.assigned_connection_id as string | null) ?? null,
      reassignmentCount: Number(item.reassignment_count ?? 0),
      resultMessageId: (item.result_message_id as string | null) ?? null,
    });
    itemsByContractId.set(contractId, bucket);
  }

  return contracts
    .map((row) => ({
      id: String(row.id),
      conversationId: String(row.conversation_id),
      anchorMessageId: String(row.anchor_message_id),
      status: row.status as TaskContractStatus,
      decomposedByConnectionId: (row.decomposed_by_connection_id as string | null) ?? null,
      createdAt: String(row.created_at),
      items: itemsByContractId.get(String(row.id)) ?? [],
    }))
    // A contract opens the moment a message names 2+ agents (see
    // openTaskContractForMultiMention), before any split is known to exist
    // yet -- but plenty of those never get a real split posted at all (the
    // decomposer just answers directly, which is correct and common for a
    // simple ask). Live-caught: that left an empty "split this into 0
    // pieces" Task Card permanently attached to an ordinary message with
    // nothing to show. A contract with no items has nothing worth
    // displaying regardless of its status, so it's filtered out here rather
    // than rendered awkwardly on the client.
    .filter((contract) => contract.items.length > 0);
}

/**
 * A-4: one endpoint replacing the seven separate 5s pollers ConversationPanel
 * used to run independently (evidence-requests, run-start-approvals,
 * pending-findings, pending-rule-drafts, permissions, evidence, notifications)
 * -- each its own network round trip and its own DB query, all firing on their
 * own unsynced 5s timer. Each underlying query is unchanged (same tables, same
 * filters); only the transport is consolidated into one request. The seven
 * original routes are left in place -- other callers may still use them --
 * this is additive, not a removal.
 */
export async function GET() {
  const ctx = await currentUserAndWorkspace();
  const empty = { notifications: [], unreadNotificationCount: 0, requests: [], approvals: [], findings: [], drafts: [], permissions: [], submissions: [], taskContracts: [] };
  if (!ctx) return NextResponse.json(empty);
  try {
    const [notifications, unreadNotificationCount, requests, approvals, findings, drafts, permissions, submissions, taskContracts] = await Promise.all([
      listDashboardNotifications().catch(() => []),
      // The Inbox badge reads this, not notifications.filter(!read_at): the
      // list above is capped at 100 rows of mixed read/unread, so filtering
      // it undercounts once a workspace grows past that page.
      countUnreadDashboardNotifications().catch(() => 0),
      listPendingChatEvidenceRequestsForWorkspace(ctx.workspaceId).catch((error) => { if (isMissingOptionalTableError(error)) return []; throw error; }),
      loadRunStartApprovals(ctx.workspaceId).catch((error) => { if (isMissingOptionalTableError(error)) return []; throw error; }),
      loadFindings(ctx.workspaceId).catch((error) => { if (isMissingOptionalTableError(error)) return []; throw error; }),
      loadRuleDrafts(ctx.workspaceId).catch((error) => { if (isMissingOptionalTableError(error)) return []; throw error; }),
      listPendingPermissionsForWorkspace(ctx.workspaceId).catch(() => []),
      listPendingChatEvidenceForWorkspace(ctx.workspaceId).catch((error) => { if (isMissingOptionalTableError(error)) return []; throw error; }),
      loadTaskContracts(ctx.workspaceId).catch((error) => { if (isMissingOptionalTableError(error)) return []; throw error; }),
    ]);
    return NextResponse.json({ notifications, unreadNotificationCount, requests, approvals, findings, drafts, permissions, submissions, taskContracts }, { headers: { "cache-control": "no-store" } });
  } catch {
    // One failing sub-query must never blank every other already-working
    // decision type -- degrade to the safe empty shape rather than 500.
    return NextResponse.json(empty, { headers: { "cache-control": "no-store" } });
  }
}
