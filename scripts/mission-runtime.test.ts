/**
 * runMissionCommand — the impure adapter, including genuine concurrent races.
 *
 * "Concurrent" here means real interleaving via Promise.all: every store
 * operation is async, so two calls racing on the same mission actually
 * interleave at each await point — this is not a simulated race, it exercises
 * the same interleaving a real request-handling process would see.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { runMissionCommand } from "../src/lib/mission/mission-runtime.ts";
import { InMemoryMissionStore, loadMissionProjection } from "../src/lib/mission/mission-store.ts";
import { InMemoryIdempotencyStore, deriveIdempotencyKey } from "../src/lib/mission/mission-idempotency.ts";
import { resolveCommandContext } from "../src/lib/mission/mission-commands.ts";
import type { CommandOutcomeRecord, MissionCommand } from "../src/lib/mission/mission-commands.ts";

const MISSION_ID = "m-1";
const ACTOR = { kind: "system" as const, id: "orchestrator" as const };

let idCounter = 0;
function mintEventId(): string {
  idCounter += 1;
  return `evt-${idCounter}`;
}

function freshStores() {
  return { missionStore: new InMemoryMissionStore(), idempotencyStore: new InMemoryIdempotencyStore<CommandOutcomeRecord>() };
}

function ctx() {
  return resolveCommandContext({ actor: ACTOR, timestamp: "2026-07-24T00:00:00.000Z" });
}

function keyFor(command: MissionCommand): string {
  return deriveIdempotencyKey({ missionId: command.missionId, commandType: command.type, payload: command });
}

// ---------------------------------------------------------------------------
// Sequential correctness
// ---------------------------------------------------------------------------

test("a sequence of commands persists to the log and the projection reflects it", async () => {
  const { missionStore, idempotencyStore } = freshStores();
  const create: MissionCommand = { type: "CreateMission", missionId: MISSION_ID, workspaceId: "w", repository: "r", goal: "Add SSO", mode: "solo" };
  const created = await runMissionCommand({ missionStore, idempotencyStore, command: create, context: ctx(), idempotencyKey: keyFor(create), mintEventId });
  assert.ok(created.ok);

  const plan: MissionCommand = { type: "BeginPlanning", missionId: MISSION_ID };
  const planned = await runMissionCommand({ missionStore, idempotencyStore, command: plan, context: ctx(), idempotencyKey: keyFor(plan), mintEventId });
  assert.ok(planned.ok);
  if (planned.ok) assert.equal(planned.projection.state, "planning");

  const events = await missionStore.loadEvents(MISSION_ID);
  assert.equal(events.length, 2);
  const { projection, version } = await loadMissionProjection(missionStore, MISSION_ID);
  assert.equal(projection.state, "planning");
  assert.equal(version, 2);
});

test("a genuine sequential replay (same key, called again later) does not re-append or double-remember", async () => {
  const { missionStore, idempotencyStore } = freshStores();
  const create: MissionCommand = { type: "CreateMission", missionId: MISSION_ID, workspaceId: "w", repository: "r", goal: "g", mode: "solo" };
  const key = keyFor(create);

  const first = await runMissionCommand({ missionStore, idempotencyStore, command: create, context: ctx(), idempotencyKey: key, mintEventId });
  assert.ok(first.ok);

  const second = await runMissionCommand({ missionStore, idempotencyStore, command: create, context: ctx(), idempotencyKey: key, mintEventId });
  assert.ok(second.ok);
  if (second.ok) assert.equal(second.replayed, true);

  assert.equal((await missionStore.loadEvents(MISSION_ID)).length, 1, "replay must not append a second time");
});

test("an invalid transition surfaces its error through the runtime unchanged", async () => {
  const { missionStore, idempotencyStore } = freshStores();
  const create: MissionCommand = { type: "CreateMission", missionId: MISSION_ID, workspaceId: "w", repository: "r", goal: "g", mode: "solo" };
  await runMissionCommand({ missionStore, idempotencyStore, command: create, context: ctx(), idempotencyKey: keyFor(create), mintEventId });

  const badCommand: MissionCommand = { type: "BeginExecution", missionId: MISSION_ID };
  const result = await runMissionCommand({ missionStore, idempotencyStore, command: badCommand, context: ctx(), idempotencyKey: keyFor(badCommand), mintEventId });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "invalid_transition");
  assert.equal((await missionStore.loadEvents(MISSION_ID)).length, 1, "a refused command must not append anything");
});

// ---------------------------------------------------------------------------
// Genuine concurrent races
// ---------------------------------------------------------------------------

test("two concurrent calls with the SAME idempotency key: exactly one append happens, both return the same events", async () => {
  const { missionStore, idempotencyStore } = freshStores();
  const create: MissionCommand = { type: "CreateMission", missionId: MISSION_ID, workspaceId: "w", repository: "r", goal: "g", mode: "solo" };
  const key = keyFor(create);

  const [a, b] = await Promise.all([
    runMissionCommand({ missionStore, idempotencyStore, command: create, context: ctx(), idempotencyKey: key, mintEventId }),
    runMissionCommand({ missionStore, idempotencyStore, command: create, context: ctx(), idempotencyKey: key, mintEventId }),
  ]);

  assert.ok(a.ok);
  assert.ok(b.ok);
  // The log must contain exactly one appended event, not two, regardless of
  // which call the store considers to have "won."
  assert.equal((await missionStore.loadEvents(MISSION_ID)).length, 1, "a genuine duplicate must never double-append");
  if (a.ok && b.ok) {
    assert.equal(a.events[0].eventId, b.events[0].eventId, "both callers must observe the SAME winning event, not two different ones");
  }
});

test("two concurrent calls with DIFFERENT commands racing on the same mission: one succeeds, the other gets a real conflict, not a false replay", async () => {
  const { missionStore, idempotencyStore } = freshStores();
  const create: MissionCommand = { type: "CreateMission", missionId: MISSION_ID, workspaceId: "w", repository: "r", goal: "g", mode: "solo" };
  await runMissionCommand({ missionStore, idempotencyStore, command: create, context: ctx(), idempotencyKey: keyFor(create), mintEventId });

  // Two genuinely different commands, both legal from "planning", racing.
  const planA: MissionCommand = { type: "BeginPlanning", missionId: MISSION_ID };
  const cancelB: MissionCommand = { type: "CancelMission", missionId: MISSION_ID, reason: { code: "duplicate_test", summary: "s", relatedEntityIds: [], recoverable: false, suggestedActions: [] } };

  const [a, b] = await Promise.all([
    runMissionCommand({ missionStore, idempotencyStore, command: planA, context: ctx(), idempotencyKey: keyFor(planA), mintEventId }),
    runMissionCommand({ missionStore, idempotencyStore, command: cancelB, context: ctx(), idempotencyKey: keyFor(cancelB), mintEventId }),
  ]);

  const results = [a, b];
  const succeeded = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  assert.equal(succeeded.length, 1, "exactly one of two genuinely different racing commands must win");
  assert.equal(failed.length, 1);
  if (failed[0] && !failed[0].ok) {
    assert.equal(failed[0].error.code, "version_conflict", "a real conflict must be reported as a conflict, never silently replayed");
  }
});

test("ten concurrent calls with the same idempotency key: still exactly one append", async () => {
  const { missionStore, idempotencyStore } = freshStores();
  const create: MissionCommand = { type: "CreateMission", missionId: MISSION_ID, workspaceId: "w", repository: "r", goal: "g", mode: "solo" };
  const key = keyFor(create);

  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      runMissionCommand({ missionStore, idempotencyStore, command: create, context: ctx(), idempotencyKey: key, mintEventId }),
    ),
  );
  assert.ok(results.every((r) => r.ok));
  assert.equal((await missionStore.loadEvents(MISSION_ID)).length, 1);
});

test("a lost append race for a genuine duplicate replays via the idempotency record rather than failing", async () => {
  // This specifically exercises the "recheck after losing the append race"
  // path in runMissionCommand: both calls pass the initial idempotency
  // check (neither sees a prior outcome yet), one wins the append and
  // records the outcome, and the LOSER must find that record on its recheck
  // and replay it — not report a version conflict for its own duplicate.
  const { missionStore, idempotencyStore } = freshStores();
  const create: MissionCommand = { type: "CreateMission", missionId: MISSION_ID, workspaceId: "w", repository: "r", goal: "g", mode: "solo" };
  const key = keyFor(create);

  const [a, b] = await Promise.all([
    runMissionCommand({ missionStore, idempotencyStore, command: create, context: ctx(), idempotencyKey: key, mintEventId }),
    runMissionCommand({ missionStore, idempotencyStore, command: create, context: ctx(), idempotencyKey: key, mintEventId }),
  ]);

  assert.ok(a.ok, "the loser of the append race must still succeed via replay, not fail");
  assert.ok(b.ok);
});
