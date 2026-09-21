/**
 * Compare-and-set writes for task contract items. Two agents (or an agent and a human) can touch the same item
 * at once; a plain read-modify-write let the last writer win, which could regress a finished item back to
 * in-progress, or bypass the reassignment cap when two confirmations raced. Every write here names the state it
 * read, and applies only if that state is still current.
 *
 * Takes the database client as a parameter and imports nothing from Next or Supabase, so it is unit tested with a fake.
 */

export type ItemStatus = "pending" | "in_progress" | "blocked" | "done" | "failed";

/** `done` and `failed` are final for an item: reopening work is a reassignment (a new item state), never a status write. */
const ALLOWED: Readonly<Record<ItemStatus, readonly ItemStatus[]>> = {
  pending: ["in_progress", "blocked", "done", "failed"],
  in_progress: ["pending", "blocked", "done", "failed"],
  blocked: ["pending", "in_progress", "failed"],
  done: [],
  failed: [],
};

export function canTransitionItem(from: ItemStatus, to: ItemStatus): boolean {
  return from === to || ALLOWED[from].includes(to);
}

export class TaskItemConflictError extends Error {
  readonly code = "TASK_ITEM_CONFLICT";
  readonly current: ItemStatus | null;

  constructor(message: string, current: ItemStatus | null) {
    super(message);
    this.current = current;
  }
}

const MAX_ATTEMPTS = 3;

type DbRow = Record<string, unknown>;
type ReadResult = { data: DbRow | null; error: unknown };
type WriteResult = { data: Array<{ id: string }> | null; error: unknown };
type ReadQuery = { eq(column: string, value: unknown): ReadQuery; maybeSingle(): Promise<ReadResult> };
type UpdateQuery = {
  eq(column: string, value: unknown): UpdateQuery;
  select(columns?: string): Promise<WriteResult>;
} & PromiseLike<WriteResult>;
type DbClient = {
  from(table: string): {
    select(columns: string): ReadQuery;
    update(patch: DbRow): UpdateQuery;
  };
};
type Db = unknown;

export async function setItemStatusCas(db: Db, input: { itemId: string; status: ItemStatus; resultMessageId?: string | null }): Promise<{ changed: boolean }> {
  const client = db as DbClient;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const { data: row, error: readError } = await client.from("task_contract_items").select("id, status").eq("id", input.itemId).maybeSingle();
    if (readError || !row) throw new Error("Could not read the task item.");
    const current = row.status as ItemStatus;

    if (current === input.status) {
      // Repeating the state is a no-op, except that a result message id can still be attached to the finished item.
      if (input.resultMessageId === undefined) return { changed: false };
      const { data: attached, error } = await client.from("task_contract_items")
        .update({ result_message_id: input.resultMessageId, updated_at: new Date().toISOString() })
        .eq("id", input.itemId).eq("status", current).select("id");
      if (error) throw new Error("Could not update the task item's status.");
      if (attached?.length) return { changed: true };
      continue;
    }
    if (!canTransitionItem(current, input.status)) {
      throw new TaskItemConflictError(`This task item is already ${current}; it cannot be set to ${input.status}.`, current);
    }

    const { data: updated, error } = await client.from("task_contract_items").update({
      status: input.status,
      // Any explicit status change clears a stale open change request rather than leaving it against a status it no longer describes.
      change_request: null,
      updated_at: new Date().toISOString(),
      ...(input.resultMessageId !== undefined ? { result_message_id: input.resultMessageId } : {}),
    }).eq("id", input.itemId).eq("status", current).select("id");
    if (error) throw new Error("Could not update the task item's status.");
    if (updated?.length) return { changed: true };
    // Someone else changed the item between our read and write: read again and decide against the new state.
  }
  throw new TaskItemConflictError("This task item changed while it was being updated; try again.", null);
}

export type ReassignResult =
  | { ok: true }
  | { ok: false; reason: "already_held" | "max_reassignments" | "conflict" };

export async function reassignItemCas(db: Db, input: { itemId: string; newConnectionId: string }, maxReassignments: number): Promise<ReassignResult> {
  const client = db as DbClient;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const { data: item, error: readError } = await client.from("task_contract_items").select("id, assignment_history, reassignment_count").eq("id", input.itemId).maybeSingle();
    if (readError || !item) throw new Error("Could not read the task item.");
    const history = (item.assignment_history as string[] | null) ?? [];
    const count = Number(item.reassignment_count ?? 0);

    // Rule 1: no-repeat. Rule 2: hard cap. Both send the item to blocked, never back into agent negotiation.
    const violation = history.includes(input.newConnectionId) ? "already_held" as const : count >= maxReassignments ? "max_reassignments" as const : null;
    if (violation) {
      await client.from("task_contract_items").update({ status: "blocked", updated_at: new Date().toISOString() }).eq("id", input.itemId);
      return { ok: false, reason: violation };
    }

    // The count is the version: two racing confirmations both read N, only one can write N+1.
    const { data: updated, error: updateError } = await client.from("task_contract_items").update({
      assigned_connection_id: input.newConnectionId,
      assignment_history: [...history, input.newConnectionId],
      reassignment_count: count + 1,
      status: "pending",
      change_request: null,
      updated_at: new Date().toISOString(),
    }).eq("id", input.itemId).eq("reassignment_count", count).select("id");
    if (updateError) throw new Error("Could not reassign the task item.");
    if (updated?.length) return { ok: true };
  }
  return { ok: false, reason: "conflict" };
}
