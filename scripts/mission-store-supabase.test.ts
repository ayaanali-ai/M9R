/**
 * SupabaseMissionEventReader / SupabaseMissionCommandPersistence —
 * row-mapping and RPC-call shaping, verified against a fake SupabaseClient.
 *
 * This does NOT exercise the actual atomicity guarantee — that lives in the
 * `apply_mission_command_atomic` Postgres function
 * (supabase/migrations/20260725120000_mission_event_log.sql) and can only be
 * proven against a real Postgres instance, which this environment does not
 * have. What's verified here: the JS layer sends the RPC the correct
 * arguments, maps a DB row back into a well-formed `MissionEvent` that other
 * Mission-domain code (projectMission, event sequence validation) accepts
 * unmodified, and maps each of the four RPC outcomes (applied / replayed /
 * idempotency_conflict / version_conflict) into the exact shapes
 * `MissionCommandPersistence.applyCommand` promises.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { SupabaseMissionEventReader } from "../src/lib/mission/mission-store-supabase.ts";
import { SupabaseMissionCommandPersistence } from "../src/lib/mission/mission-command-persistence.ts";
import { createMissionEvent } from "../src/lib/mission/mission-events.ts";
import { projectMission } from "../src/lib/mission/mission-projection.ts";
import type { CommandOutcomeRecord } from "../src/lib/mission/mission-commands.ts";

const MISSION_ID = "m-1";

function sourceEvent() {
  return createMissionEvent({
    eventId: "evt-1",
    missionId: MISSION_ID,
    aggregateVersion: 1,
    actor: { kind: "system", id: "orchestrator" },
    correlationId: "corr-1",
    causationId: null,
    timestamp: "2026-07-25T00:00:00.000Z",
    provenance: "system_inference",
    payload: { type: "mission.created", goal: "g", repository: "r", workspaceId: "ws-1", repositoryId: null },
  });
}

function eventRow(event: ReturnType<typeof sourceEvent>) {
  return {
    event_id: event.eventId,
    event_type: event.type,
    aggregate_version: event.aggregateVersion,
    schema_version: 1,
    actor: event.actor,
    reason: event.reason,
    correlation_id: event.correlationId,
    causation_id: event.causationId,
    provenance: event.provenance,
    occurred_at: event.timestamp,
    payload: event.payload,
  };
}

function outcomeRecord() {
  return { idempotencyKey: "key-1", payloadDigest: "abc", events: [sourceEvent()], aggregateVersion: 1 };
}

/** Minimal fake covering only the query shapes these two adapters issue. */
function fakeClient(options: {
  eventRows?: ReturnType<typeof eventRow>[];
  rpcResult?: { data: unknown; error: { message: string } | null };
  outcomeResultRow?: { result: CommandOutcomeRecord } | null;
}) {
  const calls: { rpcName?: string; rpcArgs?: unknown }[] = [];
  const client = {
    from(table: string) {
      if (table === "mission_events") {
        return {
          select: () => ({
            eq: () => ({
              order: async () => ({ data: options.eventRows ?? [], error: null }),
            }),
          }),
        };
      }
      if (table === "mission_command_outcomes") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: options.outcomeResultRow ?? null, error: null }),
              }),
            }),
          }),
        };
      }
      throw new Error(`fakeClient: unexpected table ${table}`);
    },
    rpc: async (name: string, args: unknown) => {
      calls.push({ rpcName: name, rpcArgs: args });
      return options.rpcResult ?? { data: null, error: null };
    },
  };
  return { client, calls };
}

test("loadEvents maps DB rows into MissionEvents that projectMission accepts unmodified", async () => {
  const event = sourceEvent();
  const { client } = fakeClient({ eventRows: [eventRow(event)] });
  const reader = new SupabaseMissionEventReader(client as never);

  const events = await reader.loadEvents(MISSION_ID);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventId, "evt-1");
  assert.equal(events[0].type, "mission.created");
  assert.deepEqual(events[0].payload, { type: "mission.created", goal: "g", repository: "r", workspaceId: "ws-1", repositoryId: null });

  const projection = projectMission(MISSION_ID, events);
  assert.equal(projection.complete, true, "a round-tripped row must still form a valid, complete stream");
  assert.equal(projection.state, "draft");
});

test("lookupOutcome returns null for a miss and the stored record for a hit", async () => {
  const { client: missClient } = fakeClient({ outcomeResultRow: null });
  const missPersistence = new SupabaseMissionCommandPersistence(missClient as never);
  assert.equal(await missPersistence.lookupOutcome("ws-1", "key-1"), null);

  const record = outcomeRecord();
  const { client: hitClient } = fakeClient({ outcomeResultRow: { result: record } });
  const hitPersistence = new SupabaseMissionCommandPersistence(hitClient as never);
  const found = await hitPersistence.lookupOutcome("ws-1", "key-1");
  assert.deepEqual(found, record);
});

test("applyCommand sends the single RPC every field it needs to decide atomically", async () => {
  const { client, calls } = fakeClient({
    rpcResult: { data: [{ status: "applied", current_version: 1, latest_event_id: "evt-1", stored_result: outcomeRecord() }], error: null },
  });
  const persistence = new SupabaseMissionCommandPersistence(client as never);

  const result = await persistence.applyCommand({
    missionId: MISSION_ID,
    workspaceId: "ws-1",
    idempotencyKey: "key-1",
    commandType: "CreateMission",
    payloadDigest: "abc",
    expectedVersion: 0,
    events: [sourceEvent()],
    result: outcomeRecord(),
  });

  assert.equal(result.status, "applied");
  assert.equal(calls.length, 1, "exactly one RPC call for one command — not a read-then-write pair");
  assert.equal(calls[0].rpcName, "apply_mission_command_atomic");
  assert.deepEqual(calls[0].rpcArgs, {
    p_mission_id: MISSION_ID,
    p_workspace_id: "ws-1",
    p_repository_id: null,
    p_idempotency_key: "key-1",
    p_command_type: "CreateMission",
    p_payload_digest: "abc",
    p_expected_version: 0,
    p_events: [sourceEvent()],
    p_result: outcomeRecord(),
  });
});

test("applyCommand maps a replayed row to the ORIGINAL stored result, not the caller's input", async () => {
  const original = { idempotencyKey: "key-1", payloadDigest: "abc", events: [sourceEvent()], aggregateVersion: 7 };
  const { client } = fakeClient({
    rpcResult: { data: [{ status: "replayed", current_version: 7, latest_event_id: null, stored_result: original }], error: null },
  });
  const persistence = new SupabaseMissionCommandPersistence(client as never);

  const result = await persistence.applyCommand({
    missionId: MISSION_ID,
    workspaceId: "ws-1",
    idempotencyKey: "key-1",
    commandType: "CreateMission",
    payloadDigest: "abc",
    expectedVersion: 0,
    events: [sourceEvent()],
    result: { idempotencyKey: "key-1", payloadDigest: "abc", events: [], aggregateVersion: 999 },
  });

  assert.equal(result.status, "replayed");
  if (result.status === "replayed") {
    assert.equal(result.aggregateVersion, 7, "must reflect the ORIGINAL committed version, not the caller's throwaway computation");
    assert.deepEqual(result.result, original);
  }
});

test("applyCommand maps idempotency_conflict without throwing", async () => {
  const { client } = fakeClient({
    rpcResult: { data: [{ status: "idempotency_conflict", current_version: 3, latest_event_id: null, stored_result: outcomeRecord() }], error: null },
  });
  const persistence = new SupabaseMissionCommandPersistence(client as never);

  const result = await persistence.applyCommand({
    missionId: MISSION_ID,
    workspaceId: "ws-1",
    idempotencyKey: "key-1",
    commandType: "CreateMission",
    payloadDigest: "different-digest",
    expectedVersion: 0,
    events: [sourceEvent()],
    result: outcomeRecord(),
  });

  assert.equal(result.status, "idempotency_conflict");
});

test("applyCommand maps version_conflict into a ConcurrencyConflict with the real current version", async () => {
  const { client } = fakeClient({
    rpcResult: { data: [{ status: "version_conflict", current_version: 4, latest_event_id: "evt-4", stored_result: null }], error: null },
  });
  const persistence = new SupabaseMissionCommandPersistence(client as never);

  const result = await persistence.applyCommand({
    missionId: MISSION_ID,
    workspaceId: "ws-1",
    idempotencyKey: "key-1",
    commandType: "CreateMission",
    payloadDigest: "abc",
    expectedVersion: 0,
    events: [sourceEvent()],
    result: outcomeRecord(),
  });

  assert.equal(result.status, "version_conflict");
  if (result.status === "version_conflict") {
    assert.equal(result.conflict.currentVersion, 4);
    assert.equal(result.conflict.expectedVersion, 0);
    assert.equal(result.conflict.latestEventCursor, "evt-4");
  }
});

test("applyCommand surfaces a Supabase-level error as a thrown Error, not a silent status", async () => {
  const { client } = fakeClient({ rpcResult: { data: null, error: { message: "connection reset" } } });
  const persistence = new SupabaseMissionCommandPersistence(client as never);

  await assert.rejects(
    () =>
      persistence.applyCommand({
        missionId: MISSION_ID,
        workspaceId: "ws-1",
        idempotencyKey: "key-1",
        commandType: "CreateMission",
        payloadDigest: "abc",
        expectedVersion: 0,
        events: [sourceEvent()],
        result: outcomeRecord(),
      }),
    /connection reset/,
  );
});
