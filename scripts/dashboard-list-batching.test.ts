import assert from "node:assert/strict";
import test from "node:test";
import { isMissingDbFunctionError, loadDashboardMessageWindows, loadDashboardUnreadCounts, type DashboardAuthShape } from "@/lib/dashboard-list-batching";

type Call = { kind: "select" | "rpc"; detail: string };
type DashboardAuth = DashboardAuthShape;
type DashboardQuery = ReturnType<DashboardAuth["from"]>;
type DashboardResult = Awaited<ReturnType<DashboardQuery["limit"]>>;

/** A fake Supabase client that records every query, so the tests can assert how many round trips a list load makes. */
function fakeAuth(options: { previews?: Array<Record<string, unknown>>; selected?: Array<Record<string, unknown>>; rpcError?: { code?: string; message?: string } | null; unread?: Array<{ conversation_id: string; unread_count: number }> }) {
  const calls: Call[] = [];
  const chain = (table: string) => {
    const state = { conversationId: null as string | null };
    const builder = {} as DashboardQuery;
    builder.select = () => builder;
    builder.eq = (column: string, value: unknown) => { if (column === "conversation_id" && typeof value === "string") state.conversationId = value; return builder; };
    builder.order = () => builder;
    builder.gt = () => builder;
    builder.not = () => builder;
    builder.limit = (n: number): Promise<DashboardResult> => { calls.push({ kind: "select", detail: `${table}:${state.conversationId}:limit${n}` }); const rows = n === 80 ? options.selected ?? [] : (options.previews ?? []).filter((row) => row.conversation_id === state.conversationId); return Promise.resolve({ data: rows, error: null }); };
    return builder;
  };
  const auth: DashboardAuth = {
    from: (table: string) => chain(table),
    rpc: (name: string) => {
      calls.push({ kind: "rpc", detail: name });
      if (options.rpcError) return Promise.resolve({ data: null, error: options.rpcError });
      return Promise.resolve({ data: name === "latest_messages_per_conversation" ? options.previews ?? [] : options.unread ?? [], error: null });
    },
  };
  return { auth, calls };
}

const msg = (conversation: string, id: string, extra: Record<string, unknown> = {}) => ({ id, conversation_id: conversation, body: id, created_at: "2026-09-19T00:00:00Z", idempotency_key: "secret", ...extra });

test("with the batch function, a 30-channel list makes exactly two queries: the open channel's window and one preview call", async () => {
  const ids = Array.from({ length: 30 }, (_, i) => `c${i}`);
  const { auth, calls } = fakeAuth({ selected: [msg("c0", "m2"), msg("c0", "m1")], previews: ids.slice(1).map((id) => msg(id, `latest-${id}`)) });
  const { rows, error } = await loadDashboardMessageWindows(auth, "w1", ids, "c0");
  assert.equal(error, null);
  assert.equal(calls.length, 2, JSON.stringify(calls));
  assert.deepEqual(calls.map((call) => call.kind).sort(), ["rpc", "select"]);
  assert.equal(rows.length, 2 + 29);
});

test("the open channel is returned oldest-first and every other channel contributes its one latest message", async () => {
  const { auth } = fakeAuth({ selected: [msg("c0", "newest"), msg("c0", "older"), msg("c0", "oldest")], previews: [msg("c1", "p1"), msg("c2", "p2")] });
  const { rows } = await loadDashboardMessageWindows(auth, "w1", ["c0", "c1", "c2"], "c0");
  assert.deepEqual(rows.map((row) => row.id), ["oldest", "older", "newest", "p1", "p2"]);
});

test("rows carry only the columns the dashboard selects: the function returns whole rows, so extras such as idempotency keys are dropped", async () => {
  const { auth } = fakeAuth({ previews: [msg("c1", "p1")] });
  const { rows } = await loadDashboardMessageWindows(auth, "w1", ["c1"], null);
  assert.equal("idempotency_key" in rows[0], false);
  assert.equal(rows[0].body, "p1");
});

test("with no channel open, every channel is a preview and nothing else is queried", async () => {
  const { auth, calls } = fakeAuth({ previews: [msg("c1", "p1"), msg("c2", "p2")] });
  await loadDashboardMessageWindows(auth, "w1", ["c1", "c2"], null);
  assert.deepEqual(calls, [{ kind: "rpc", detail: "latest_messages_per_conversation" }]);
});

test("if the migration is not applied yet, previews fall back to one query per channel and the list still loads", async () => {
  const { auth, calls } = fakeAuth({ rpcError: { code: "PGRST202", message: "Could not find the function public.latest_messages_per_conversation" }, previews: [msg("c1", "p1"), msg("c2", "p2")] });
  const { rows, error } = await loadDashboardMessageWindows(auth, "w1", ["c1", "c2"], null);
  assert.equal(error, null);
  assert.deepEqual(rows.map((row) => row.id), ["p1", "p2"]);
  assert.equal(calls.filter((call) => call.kind === "select").length, 2);
});

test("a real database error is reported, not swallowed by the fallback", async () => {
  const { auth } = fakeAuth({ rpcError: { code: "57014", message: "canceling statement due to statement timeout" } });
  const { error } = await loadDashboardMessageWindows(auth, "w1", ["c1"], null);
  assert.ok(error);
  assert.equal(isMissingDbFunctionError({ code: "57014", message: "statement timeout" }), false);
  assert.equal(isMissingDbFunctionError({ code: "PGRST202" }), true);
  assert.equal(isMissingDbFunctionError({ code: "42883" }), true);
  assert.equal(isMissingDbFunctionError(null), false);
});

test("unread counts come from one call, keyed by channel, and count as numbers", async () => {
  const { auth, calls } = fakeAuth({ unread: [{ conversation_id: "c1", unread_count: 3 }, { conversation_id: "c2", unread_count: "0" as unknown as number }] });
  const counts = await loadDashboardUnreadCounts(auth, "w1", "u1", ["c1", "c2"], ["archived-1"], new Map());
  assert.equal(counts.get("c1"), 3);
  assert.equal(counts.get("c2"), 0);
  assert.deepEqual(calls, [{ kind: "rpc", detail: "unread_counts_per_conversation" }]);
});

test("unread counts fall back to per-channel counting when the function is missing, and an empty list makes no call", async () => {
  const { auth: missing } = fakeAuth({ rpcError: { code: "42883", message: "function does not exist" } });
  const chain = missing.from;
  missing.from = (table: string) => {
    const builder = chain(table);
    const countQuery = {} as DashboardQuery;
    countQuery.eq = () => countQuery;
    countQuery.gt = () => countQuery;
    countQuery.not = () => countQuery;
    countQuery.select = () => countQuery;
    countQuery.limit = () => Promise.resolve({ data: [], error: null });
    countQuery.then = ((resolve) => Promise.resolve(resolve?.({ data: null, error: null, count: 4 }))) as DashboardQuery["then"];
    builder.select = () => countQuery;
    return builder;
  };
  const counts = await loadDashboardUnreadCounts(missing, "w1", "u1", ["c1"], [], new Map());
  assert.equal(counts.get("c1"), 4);
  const { auth, calls } = fakeAuth({});
  assert.equal((await loadDashboardUnreadCounts(auth, "w1", "u1", [], [], new Map())).size, 0);
  assert.equal(calls.length, 0);
});
