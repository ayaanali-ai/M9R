import assert from "node:assert/strict";
import test from "node:test";
import { TaskItemConflictError, canTransitionItem, reassignItemCas, setItemStatusCas } from "@/lib/bridge/task-item-cas";

type Row = Record<string, unknown>;
type ReadQuery = { eq: () => ReadQuery; maybeSingle: () => Promise<{ data: Row; error: null }> };
type WriteQuery = {
  eq: (column: string, value: unknown) => WriteQuery;
  select: () => Promise<{ data: Array<{ id: string }>; error: null }>;
  then: (resolve: (value: { error: null }) => void) => void;
};

/**
 * An in-memory stand-in for the one table these functions use. `beforeWrite` runs between the function's read and its
 * write, which is where a concurrent writer would land.
 */
function fakeDb(initial: Row, hooks: { beforeWrite?: (row: Row, writeIndex: number) => void } = {}) {
  const row: Row = { id: "item-1", ...initial };
  let writes = 0;
  const log: string[] = [];
  const db = {
    from: () => ({
      select: () => { const q: ReadQuery = { eq: () => q, maybeSingle: () => Promise.resolve({ data: { ...row }, error: null }) }; return q; },
      update: (patch: Row) => {
        const filters: Array<[string, unknown]> = [];
        const q: WriteQuery = {
          eq: (column: string, value: unknown) => { filters.push([column, value]); return q; },
          select: () => {
            hooks.beforeWrite?.(row, writes);
            writes += 1;
            const matches = filters.every(([column, value]) => row[column] === value);
            if (matches) { Object.assign(row, patch); log.push(`applied ${JSON.stringify(Object.keys(patch))}`); }
            else log.push("rejected: state changed");
            return Promise.resolve({ data: matches ? [{ id: String(row.id) }] : [], error: null });
          },
          then: (resolve: (v: { error: null }) => void) => { Object.assign(row, patch); resolve({ error: null }); },
        };
        return q;
      },
    }),
  };
  return { db, row, log };
}

test("the transition table: work moves forward, blocked can resume, done and failed are final", () => {
  assert.equal(canTransitionItem("pending", "in_progress"), true);
  assert.equal(canTransitionItem("in_progress", "done"), true);
  assert.equal(canTransitionItem("blocked", "in_progress"), true);
  assert.equal(canTransitionItem("done", "in_progress"), false);
  assert.equal(canTransitionItem("done", "failed"), false);
  assert.equal(canTransitionItem("failed", "done"), false);
  assert.equal(canTransitionItem("done", "done"), true, "repeating a state is always allowed");
});

test("a normal status write applies and clears a stale change request", async () => {
  const { db, row } = fakeDb({ status: "pending", change_request: { reason: "wrong_scope" } });
  assert.deepEqual(await setItemStatusCas(db, { itemId: "item-1", status: "in_progress" }), { changed: true });
  assert.equal(row.status, "in_progress");
  assert.equal(row.change_request, null);
});

test("a stale in_progress report can no longer regress a finished item", async () => {
  const { db, row } = fakeDb({ status: "done" });
  await assert.rejects(setItemStatusCas(db, { itemId: "item-1", status: "in_progress" }), (error: unknown) => error instanceof TaskItemConflictError && error.current === "done");
  assert.equal(row.status, "done");
});

test("repeating the current status is a no-op, but a result message can still be attached to a finished item", async () => {
  const { db, row } = fakeDb({ status: "done", result_message_id: null });
  assert.deepEqual(await setItemStatusCas(db, { itemId: "item-1", status: "done" }), { changed: false });
  assert.deepEqual(await setItemStatusCas(db, { itemId: "item-1", status: "done", resultMessageId: "msg-9" }), { changed: true });
  assert.equal(row.result_message_id, "msg-9");
  assert.equal(row.status, "done");
});

test("a write that loses a race is retried against the new state instead of overwriting it", async () => {
  // Between our read (pending) and our write, another writer finishes the item.
  const { db, row, log } = fakeDb({ status: "pending" }, { beforeWrite: (r, i) => { if (i === 0) r.status = "done"; } });
  await assert.rejects(setItemStatusCas(db, { itemId: "item-1", status: "in_progress" }), TaskItemConflictError);
  assert.equal(row.status, "done", "the racing writer's result stands");
  assert.deepEqual(log, ["rejected: state changed"]);
});

test("a race that only changes the state to something still valid is retried and then applied", async () => {
  const { db, row } = fakeDb({ status: "pending" }, { beforeWrite: (r, i) => { if (i === 0) r.status = "in_progress"; } });
  assert.deepEqual(await setItemStatusCas(db, { itemId: "item-1", status: "done" }), { changed: true });
  assert.equal(row.status, "done");
});

test("reassignment applies once and records the history", async () => {
  const { db, row } = fakeDb({ assignment_history: ["a"], reassignment_count: 0, status: "blocked", assigned_connection_id: "a" });
  assert.deepEqual(await reassignItemCas(db, { itemId: "item-1", newConnectionId: "b" }, 2), { ok: true });
  assert.deepEqual(row.assignment_history, ["a", "b"]);
  assert.equal(row.reassignment_count, 1);
  assert.equal(row.status, "pending");
});

test("the no-repeat and hard-cap rules still send the item to blocked", async () => {
  const repeat = fakeDb({ assignment_history: ["a", "b"], reassignment_count: 1, status: "pending" });
  assert.deepEqual(await reassignItemCas(repeat.db, { itemId: "item-1", newConnectionId: "a" }, 2), { ok: false, reason: "already_held" });
  assert.equal(repeat.row.status, "blocked");
  const capped = fakeDb({ assignment_history: ["a", "b"], reassignment_count: 2, status: "pending" });
  assert.deepEqual(await reassignItemCas(capped.db, { itemId: "item-1", newConnectionId: "c" }, 2), { ok: false, reason: "max_reassignments" });
  assert.equal(capped.row.status, "blocked");
});

test("two racing confirmations cannot both spend the last reassignment slot", async () => {
  // Both confirmations read count 1 (cap 2). The first writes; the second's write is rejected, it re-reads count 2,
  // and hits the cap instead of writing a third assignment.
  const { db, row } = fakeDb({ assignment_history: ["a", "b"], reassignment_count: 1, status: "pending" });
  const first = await reassignItemCas(db, { itemId: "item-1", newConnectionId: "c" }, 2);
  assert.deepEqual(first, { ok: true });
  // A second confirmation that read the item before the first wrote: simulate by rewinding its view, then racing.
  const { db: db2, row: row2 } = fakeDb({ assignment_history: ["a", "b"], reassignment_count: 1, status: "pending" }, {
    beforeWrite: (r, i) => { if (i === 0) { r.assignment_history = ["a", "b", "c"]; r.reassignment_count = 2; } },
  });
  assert.deepEqual(await reassignItemCas(db2, { itemId: "item-1", newConnectionId: "d" }, 2), { ok: false, reason: "max_reassignments" });
  assert.equal(row2.reassignment_count, 2, "the cap held");
  assert.deepEqual(row2.assignment_history, ["a", "b", "c"]);
  assert.equal(row.reassignment_count, 2);
});

test("a reassignment that keeps losing the race reports a conflict instead of looping forever", async () => {
  const { db } = fakeDb({ assignment_history: [], reassignment_count: 0, status: "pending" }, { beforeWrite: (r) => { r.reassignment_count = Number(r.reassignment_count ?? 0) + 0.5; } });
  const result = await reassignItemCas(db, { itemId: "item-1", newConnectionId: "b" }, 99);
  assert.deepEqual(result, { ok: false, reason: "conflict" });
});
