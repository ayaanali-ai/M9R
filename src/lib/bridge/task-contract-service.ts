/**
 * Task negotiation / file-claiming (item 5). A human @-mentions 2+ agents in
 * one message; the first-mentioned agent proposes a decomposition; each
 * mentioned agent is dispatched only its own assigned sub-task.
 *
 * File claims (`expected_file_paths`) are informational only, shown in the
 * UI -- the real enforcement is the already-built live file-lock check at
 * actual write time (file-lock-service.ts). This is not a second locking
 * system.
 *
 * Reassignment loop-safety (human-mandated, 2026-09-02) -- deterministic,
 * code-enforced circuit breakers, never agent judgment:
 *   1. An item can never be reassigned to a connection already present in
 *      its assignment_history (kills simple ping-pong outright).
 *   2. A hard cap on total reassignments (catches longer cycles the
 *      no-repeat rule alone wouldn't).
 *   3. Every reassignment still requires human confirmation -- a second
 *      layer, not the primary defense.
 * Hitting either limit sends the item straight to `blocked`, never back
 * into agent negotiation. Decomposition itself is final once posted; an
 * agent can only *request* a change, never reassign unilaterally. A failed
 * item stops and waits for a human -- no auto-retry with a different agent.
 */
import { supabase } from "@/lib/supabase";

function requireService() {
  if (!supabase) throw new Error("M9R backend is not configured.");
  return supabase;
}

export const MAX_REASSIGNMENTS = 2;

export type ContractStatus = "decomposing" | "executing" | "completed" | "failed";
export type ItemStatus = "pending" | "in_progress" | "blocked" | "done" | "failed";

export interface TaskContractItemInput {
  description: string;
  expectedFilePaths?: string[];
  assignedConnectionId: string;
}

export type ChangeRequestReason = "wrong_scope" | "blocked_by_dependency" | "outside_capability" | "already_done_by_other" | "needs_split";

export interface ChangeRequest {
  reason: ChangeRequestReason;
  detail: string;
  suggestedConnectionId: string | null;
  requestedByConnectionId: string;
  requestedAt: string;
}

export interface TaskContractItem {
  id: string;
  contractId: string;
  description: string;
  expectedFilePaths: string[];
  assignedConnectionId: string | null;
  assignmentHistory: string[];
  reassignmentCount: number;
  status: ItemStatus;
  resultMessageId: string | null;
  changeRequest: ChangeRequest | null;
}

export interface TaskContract {
  id: string;
  workspaceId: string;
  conversationId: string;
  anchorMessageId: string | null;
  decomposedByConnectionId: string | null;
  status: ContractStatus;
  items: TaskContractItem[];
}

function toItem(row: Record<string, unknown>): TaskContractItem {
  return {
    id: String(row.id),
    contractId: String(row.contract_id),
    description: String(row.description),
    expectedFilePaths: (row.expected_file_paths as string[] | null) ?? [],
    assignedConnectionId: (row.assigned_connection_id as string | null) ?? null,
    assignmentHistory: (row.assignment_history as string[] | null) ?? [],
    reassignmentCount: Number(row.reassignment_count ?? 0),
    status: row.status as ItemStatus,
    resultMessageId: (row.result_message_id as string | null) ?? null,
    changeRequest: (row.change_request as ChangeRequest | null) ?? null,
  };
}

/**
 * Create a contract with its items in one shot. Called once the
 * first-mentioned agent has proposed a decomposition. Each item's
 * `assignedConnectionId` is recorded as the sole entry in its own
 * `assignment_history`, so a later reassignment back to the original owner
 * is correctly treated as "already held this" and refused by rule #1.
 */
export async function createTaskContract(input: {
  workspaceId: string;
  conversationId: string;
  anchorMessageId: string | null;
  decomposedByConnectionId: string;
  items: TaskContractItemInput[];
}): Promise<TaskContract> {
  if (input.items.length === 0) throw new Error("A task contract needs at least one item.");
  const db = requireService();

  // A multi-mention message already opened a contract in `decomposing`
  // (openTaskContractForMultiMention, called server-side at send time).
  // The decomposer submitting its split attaches items to THAT contract
  // rather than opening a second one for the same anchor message.
  const existing = input.anchorMessageId
    ? (await db.from("task_contracts").select("id, workspace_id, conversation_id, anchor_message_id, decomposed_by_connection_id, status").eq("anchor_message_id", input.anchorMessageId).maybeSingle()).data
    : null;

  const contract = existing ?? (await db
    .from("task_contracts")
    .insert({
      workspace_id: input.workspaceId,
      conversation_id: input.conversationId,
      anchor_message_id: input.anchorMessageId,
      decomposed_by_connection_id: input.decomposedByConnectionId,
      status: "executing",
    })
    .select("id, workspace_id, conversation_id, anchor_message_id, decomposed_by_connection_id, status")
    .single()).data;
  if (!contract) throw new Error("Could not create the task contract.");
  if (existing) {
    await db.from("task_contracts").update({ status: "executing", updated_at: new Date().toISOString() }).eq("id", contract.id);
  }

  const { data: items, error: itemsError } = await db
    .from("task_contract_items")
    .insert(input.items.map((item) => ({
      contract_id: contract.id,
      description: item.description,
      expected_file_paths: item.expectedFilePaths ?? [],
      assigned_connection_id: item.assignedConnectionId,
      assignment_history: [item.assignedConnectionId],
    })))
    .select("id, contract_id, description, expected_file_paths, assigned_connection_id, assignment_history, reassignment_count, status, result_message_id, change_request");
  if (itemsError || !items) throw new Error("Could not create the task contract's items.");

  return {
    id: String(contract.id),
    workspaceId: String(contract.workspace_id),
    conversationId: String(contract.conversation_id),
    anchorMessageId: (contract.anchor_message_id as string | null) ?? null,
    decomposedByConnectionId: (contract.decomposed_by_connection_id as string | null) ?? null,
    status: contract.status as ContractStatus,
    items: items.map(toItem),
  };
}

/**
 * Opens a contract in `decomposing` for a multi-mention human message,
 * before any split exists. Idempotent per anchor message: the same message
 * delivered twice (relay + poll both offer it) must not open two contracts.
 */
export async function openTaskContractForMultiMention(input: {
  workspaceId: string;
  conversationId: string;
  anchorMessageId: string;
  decomposerConnectionId: string;
}): Promise<{ contractId: string; created: boolean }> {
  const db = requireService();
  const { data: existing } = await db
    .from("task_contracts")
    .select("id")
    .eq("anchor_message_id", input.anchorMessageId)
    .maybeSingle();
  if (existing) return { contractId: String(existing.id), created: false };

  const { data, error } = await db.from("task_contracts").insert({
    workspace_id: input.workspaceId,
    conversation_id: input.conversationId,
    anchor_message_id: input.anchorMessageId,
    decomposed_by_connection_id: input.decomposerConnectionId,
    status: "decomposing",
  }).select("id").single();
  if (error || !data) throw new Error("Could not open the task contract.");
  return { contractId: String(data.id), created: true };
}

export type MessageContractRole =
  | { role: "none" }
  | { role: "decomposer"; contractId: string }
  | { role: "participant"; contractId: string };

/**
 * A `decomposing` contract had no expiry at all until this was added --
 * live-caught: a message naming 2+ agents opens one purely on mention count
 * (no check that the message is actually delegable multi-step work, see
 * openTaskContractForMultiMention's caller), and a decomposer that just
 * replies in prose instead of POSTing a real split (exactly what a casual
 * "talk to each other" request produces) leaves the contract in
 * `decomposing` forever. Every OTHER mentioned agent's `roleForMessage` call
 * for that same anchor message keeps coming back "participant" (hold)
 * indefinitely, and the bridge's poll loop treats a held message as a
 * reason to stop advancing the whole conversation's cursor -- so the entire
 * channel goes silent, not just the one message. This TTL bounds that: past
 * it, the hold is treated as abandoned and every mentioned agent falls
 * through to answering normally.
 */
const TASK_CONTRACT_DECOMPOSE_TTL_MS = 45_000;

/**
 * What one connection should do about a given message: propose the split,
 * hold (it's mentioned but another agent is decomposing), or nothing. The
 * bridge calls this only when it locally sees a human message naming more
 * than one provider, so the common single-mention path pays no round-trip.
 */
export async function roleForMessage(input: { messageId: string; connectionId: string }): Promise<MessageContractRole> {
  const db = requireService();
  const { data: contract } = await db
    .from("task_contracts")
    .select("id, decomposed_by_connection_id, status, created_at")
    .eq("anchor_message_id", input.messageId)
    .maybeSingle();
  if (!contract) return { role: "none" };
  if (contract.status !== "decomposing") return { role: "none" };
  const ageMs = Date.now() - new Date(String(contract.created_at)).getTime();
  if (ageMs > TASK_CONTRACT_DECOMPOSE_TTL_MS) {
    // Best-effort marker so the dashboard doesn't show this stuck in
    // "decomposing" forever; the role decision below does not depend on
    // this write succeeding.
    void db.from("task_contracts").update({ status: "failed", updated_at: new Date().toISOString() }).eq("id", contract.id).then(() => undefined, () => undefined);
    return { role: "none" };
  }
  return contract.decomposed_by_connection_id === input.connectionId
    ? { role: "decomposer", contractId: String(contract.id) }
    : { role: "participant", contractId: String(contract.id) };
}

/**
 * Posts one system-authored sub-task notice per item, addressed to the
 * assigned connection, so each agent is woken with only its own piece.
 *
 * `sender_connection_id` is deliberately NULL: per the bridge's own
 * loop-prevention contract (`agentAmbientMessageMayWake`), a `notice` may
 * wake a session only when it has no sender connection -- i.e. only when
 * it's genuinely OathLock-authored text. Authoring these as a real agent
 * connection is exactly what caused a live feedback loop earlier (an
 * agent-authored notice re-triggered that agent's own turn), so this must
 * stay system-authored.
 */
export async function dispatchContractItems(contractId: string): Promise<number> {
  const db = requireService();
  const { data: contract } = await db
    .from("task_contracts")
    .select("id, workspace_id, conversation_id")
    .eq("id", contractId)
    .maybeSingle();
  if (!contract) throw new Error("Contract not found.");
  const { data: items } = await db
    .from("task_contract_items")
    .select("id, description, assigned_connection_id, expected_file_paths")
    .eq("contract_id", contractId);

  let dispatched = 0;
  for (const item of items ?? []) {
    if (!item.assigned_connection_id) continue;
    const files = (item.expected_file_paths as string[] | null) ?? [];
    const filesLine = files.length > 0 ? ` Expected files: ${files.join(", ")}.` : "";
    const { error } = await db.from("conversation_messages").insert({
      workspace_id: contract.workspace_id,
      conversation_id: contract.conversation_id,
      sender_connection_id: null,
      sender_user_id: null,
      recipient_connection_id: item.assigned_connection_id,
      kind: "notice",
      body: `Your part of this task: ${String(item.description)}.${filesLine} Other agents are handling the rest — do only this piece. When you're done, call update_task_item_status with itemId "${item.id}" and status "done" (or "failed" if it can't be completed) — the contract stays open until every item reports in.`,
      idempotency_key: `task-item-dispatch:${item.id}`,
    });
    // 23505 = this item was already dispatched (idempotency key); not an error.
    if (error && error.code !== "23505") {
      console.warn(`Could not dispatch task item ${item.id}:`, error.message);
      continue;
    }
    dispatched += 1;
  }
  await db.from("task_contracts").update({ status: "executing", updated_at: new Date().toISOString() }).eq("id", contractId);
  return dispatched;
}

export async function getTaskContract(contractId: string): Promise<TaskContract | null> {
  const db = requireService();
  const { data: contract } = await db
    .from("task_contracts")
    .select("id, workspace_id, conversation_id, anchor_message_id, decomposed_by_connection_id, status")
    .eq("id", contractId)
    .maybeSingle();
  if (!contract) return null;
  const { data: items } = await db
    .from("task_contract_items")
    .select("id, contract_id, description, expected_file_paths, assigned_connection_id, assignment_history, reassignment_count, status, result_message_id, change_request")
    .eq("contract_id", contractId)
    .order("created_at", { ascending: true });
  return {
    id: String(contract.id),
    workspaceId: String(contract.workspace_id),
    conversationId: String(contract.conversation_id),
    anchorMessageId: (contract.anchor_message_id as string | null) ?? null,
    decomposedByConnectionId: (contract.decomposed_by_connection_id as string | null) ?? null,
    status: contract.status as ContractStatus,
    items: (items ?? []).map(toItem),
  };
}

/** Every open (executing) contract's items assigned to a connection -- what a resident dispatches as that connection's actual sub-task prompt. */
export async function listActiveItemsForConnection(connectionId: string): Promise<TaskContractItem[]> {
  const db = requireService();
  const { data } = await db
    .from("task_contract_items")
    .select("id, contract_id, description, expected_file_paths, assigned_connection_id, assignment_history, reassignment_count, status, result_message_id, change_request")
    .eq("assigned_connection_id", connectionId)
    .in("status", ["pending", "in_progress"]);
  return (data ?? []).map(toItem);
}

export async function setItemStatus(input: { itemId: string; status: ItemStatus; resultMessageId?: string | null }): Promise<void> {
  const db = requireService();
  const { error } = await db.from("task_contract_items").update({
    status: input.status,
    // Any explicit status change (including the "Fail it" change-request
    // resolution path) clears a stale open request rather than leaving it
    // to dangle against a status it no longer describes.
    change_request: null,
    updated_at: new Date().toISOString(),
    ...(input.resultMessageId !== undefined ? { result_message_id: input.resultMessageId } : {}),
  }).eq("id", input.itemId);
  if (error) throw new Error("Could not update the task item's status.");
}

export type ReassignResult =
  | { ok: true }
  | { ok: false; reason: "already_held" | "max_reassignments" };

/**
 * Reassign one item to a new connection. Only ever called after a human has
 * explicitly confirmed the request (the caller's responsibility -- this
 * function does not itself gate on approval, callers must not invoke it
 * from an unconfirmed agent request). Both loop-safety rules are enforced
 * here regardless of caller, since they must hold independent of how
 * carefully anything upstream is checking.
 */
export async function reassignTaskItem(input: { itemId: string; newConnectionId: string }): Promise<ReassignResult> {
  const db = requireService();
  const { data: item, error: readError } = await db
    .from("task_contract_items")
    .select("id, assignment_history, reassignment_count")
    .eq("id", input.itemId)
    .maybeSingle();
  if (readError || !item) throw new Error("Could not read the task item.");

  const history = (item.assignment_history as string[] | null) ?? [];
  const count = Number(item.reassignment_count ?? 0);

  // Rule 1: no-repeat. Deterministic, not agent judgment.
  if (history.includes(input.newConnectionId)) {
    await db.from("task_contract_items").update({ status: "blocked", updated_at: new Date().toISOString() }).eq("id", input.itemId);
    return { ok: false, reason: "already_held" };
  }
  // Rule 2: hard cap.
  if (count >= MAX_REASSIGNMENTS) {
    await db.from("task_contract_items").update({ status: "blocked", updated_at: new Date().toISOString() }).eq("id", input.itemId);
    return { ok: false, reason: "max_reassignments" };
  }

  const { error: updateError } = await db.from("task_contract_items").update({
    assigned_connection_id: input.newConnectionId,
    assignment_history: [...history, input.newConnectionId],
    reassignment_count: count + 1,
    status: "pending",
    change_request: null,
    updated_at: new Date().toISOString(),
  }).eq("id", input.itemId);
  if (updateError) throw new Error("Could not reassign the task item.");
  return { ok: true };
}

/**
 * The agent-initiated half of a change request (#4, resolved 2026-09-06).
 * Grants exactly one capability -- set a flag on the caller's own item and
 * stop -- never assign, never re-decompose, never target another agent.
 * Server-enforced ownership: `itemId` must currently be assigned to the
 * caller, not trusted from agent input. Flips the item to `blocked`
 * immediately so the agent stops working on a task it just declared wrong,
 * mirroring `recomputeContractStatus`'s existing handling of blocked items.
 */
export async function requestAssignmentChange(input: {
  itemId: string;
  requestedByConnectionId: string;
  reason: ChangeRequestReason;
  detail: string;
  suggestedConnectionId?: string | null;
}): Promise<{ ok: true } | { ok: false; reason: "not_assigned_to_you" }> {
  const db = requireService();
  const { data: item, error: readError } = await db
    .from("task_contract_items")
    .select("id, assigned_connection_id")
    .eq("id", input.itemId)
    .maybeSingle();
  if (readError || !item) throw new Error("Could not read the task item.");
  if (item.assigned_connection_id !== input.requestedByConnectionId) {
    return { ok: false, reason: "not_assigned_to_you" };
  }

  const changeRequest: ChangeRequest = {
    reason: input.reason,
    detail: input.detail,
    suggestedConnectionId: input.suggestedConnectionId ?? null,
    requestedByConnectionId: input.requestedByConnectionId,
    requestedAt: new Date().toISOString(),
  };
  const { error: updateError } = await db.from("task_contract_items").update({
    change_request: changeRequest,
    status: "blocked",
    updated_at: new Date().toISOString(),
  }).eq("id", input.itemId);
  if (updateError) throw new Error("Could not record the change request.");
  return { ok: true };
}

/**
 * "Keep as-is" resolution path (human-initiated, per #4's spec): clears the
 * request and returns the item to work rather than reassigning it. The
 * request's reason/detail is not otherwise persisted beyond this call --
 * the spec's whispers-drawer surfacing of the resolution is UI-layer, not
 * this function's concern.
 */
export async function dismissAssignmentChange(itemId: string): Promise<void> {
  const db = requireService();
  const { error } = await db.from("task_contract_items").update({
    change_request: null,
    status: "in_progress",
    updated_at: new Date().toISOString(),
  }).eq("id", itemId);
  if (error) throw new Error("Could not dismiss the change request.");
}

/** Recomputes a contract's own status from its items: executing while any item is pending/in_progress, completed once every item is done, failed if any item is failed or blocked and nothing is still active. Called after any item status change. */
export async function recomputeContractStatus(contractId: string): Promise<ContractStatus> {
  const db = requireService();
  const { data: items } = await db.from("task_contract_items").select("status").eq("contract_id", contractId);
  const statuses = (items ?? []).map((r) => r.status as ItemStatus);
  let next: ContractStatus;
  if (statuses.some((s) => s === "pending" || s === "in_progress")) next = "executing";
  else if (statuses.every((s) => s === "done")) next = "completed";
  else next = "failed"; // any blocked/failed item with nothing still active -- stop and wait for a human, no auto-retry.
  await db.from("task_contracts").update({ status: next, updated_at: new Date().toISOString() }).eq("id", contractId);
  return next;
}
