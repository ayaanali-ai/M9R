import assert from "node:assert/strict";
import test from "node:test";
import { SupabaseMissionUsageLedger } from "@/lib/mission/mission-usage-store-supabase";

function fakeClient(runtimeRows: Record<string, unknown>[], existingEventIds: string[] = []) {
  const upserts: Record<string, unknown>[][] = [];
  const calls: string[] = [];
  const runtimeQuery = {
    select: () => runtimeQuery,
    eq: () => runtimeQuery,
    gte: () => runtimeQuery,
    order: () => runtimeQuery,
    limit: async () => ({ data: runtimeRows, error: null }),
  };
  const existingQuery = {
    select: () => existingQuery,
    eq: () => existingQuery,
    gte: () => existingQuery,
    limit: async () => ({ data: existingEventIds.map((event_id) => ({ event_id })), error: null }),
  };
  const ledgerQuery = {
    ...existingQuery,
    upsert: (rows: Record<string, unknown>[]) => {
      upserts.push(rows);
      return {
        select: async () => ({ data: rows.map((row) => ({ event_id: row.event_id })), error: null }),
      };
    },
  };
  const client = {
    from(table: string) {
      calls.push(table);
      if (table === "mission_runtime_events") return runtimeQuery;
      if (table === "mission_usage_ledger") return ledgerQuery;
      throw new Error(`Unexpected table ${table}`);
    },
  };
  return { client: client as never, upserts, calls };
}

const usageRow = (event_id: string, total_tokens: number) => ({
  workspace_id: "workspace-1",
  mission_id: "mission-1",
  execution_id: "execution-1",
  participant_id: "agent-1",
  assignment_id: null,
  event_id,
  turn_id: "turn-1",
  event_type: "provider.usage_updated",
  adapter_id: "codex-acp",
  provider_session_ref: "provider-session-1",
  occurred_at: "2026-08-01T00:00:00.000Z",
  payload: { inputTokens: total_tokens - 20, outputTokens: 20, totalTokens: total_tokens, usageBasis: "prompt_turn" },
});

test("reconcileFromRuntimeEvents backfills provider usage after a projection miss", async () => {
  const { client, upserts, calls } = fakeClient([usageRow("usage-1", 120)]);
  const ledger = new SupabaseMissionUsageLedger(client);
  const result = await ledger.reconcileFromRuntimeEvents({ workspaceId: "workspace-1", since: "2026-07-25T00:00:00.000Z" });

  assert.deepEqual(result, { stored: 1, ignored: 0 });
  assert.deepEqual(calls, ["mission_usage_ledger", "mission_runtime_events", "mission_usage_ledger"]);
  assert.equal(upserts[0]?.[0]?.workspace_id, "workspace-1");
  assert.equal(upserts[0]?.[0]?.event_id, "usage-1");
  assert.equal(upserts[0]?.[0]?.total_tokens, 120);
});

test("reconcileFromRuntimeEvents does not rewrite already-projected event ids", async () => {
  const { client, upserts } = fakeClient([usageRow("usage-1", 120)], ["usage-1"]);
  const ledger = new SupabaseMissionUsageLedger(client);
  const result = await ledger.reconcileFromRuntimeEvents({ workspaceId: "workspace-1", since: "2026-07-25T00:00:00.000Z" });

  assert.deepEqual(result, { stored: 0, ignored: 1 });
  assert.equal(upserts.length, 0);
});
