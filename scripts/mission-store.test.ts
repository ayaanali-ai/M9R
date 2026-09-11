/**
 * InMemoryMissionStore — atomicity of append under real concurrent races.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InMemoryMissionStore } from "../src/lib/mission/mission-store.ts";
import { createMissionEvent, type MissionEvent } from "../src/lib/mission/mission-events.ts";

const MISSION_ID = "m-1";

function createdEvent(version: number): MissionEvent {
  return createMissionEvent({
    eventId: `evt-${version}`,
    missionId: MISSION_ID,
    aggregateVersion: version,
    actor: { kind: "system", id: "orchestrator" },
    correlationId: "corr-1",
    causationId: null,
    timestamp: "2026-07-24T00:00:00.000Z",
    provenance: "system_inference",
    payload: { type: "mission.created", goal: "g", repository: "r", workspaceId: "ws-1", repositoryId: null },
  });
}

test("loadEvents on an unknown mission returns an empty array, not an error", async () => {
  const store = new InMemoryMissionStore();
  assert.deepEqual(await store.loadEvents("missing"), []);
});

test("append at expectedVersion 0 on a new mission succeeds", async () => {
  const store = new InMemoryMissionStore();
  const result = await store.append({ missionId: MISSION_ID, expectedVersion: 0, events: [createdEvent(1)] });
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.version, 1);
  assert.equal((await store.loadEvents(MISSION_ID)).length, 1);
});

test("a stale expectedVersion is refused with the real current version", async () => {
  const store = new InMemoryMissionStore();
  await store.append({ missionId: MISSION_ID, expectedVersion: 0, events: [createdEvent(1)] });
  const result = await store.append({ missionId: MISSION_ID, expectedVersion: 0, events: [createdEvent(2)] });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.conflict.currentVersion, 1);
    assert.equal(result.conflict.expectedVersion, 0);
  }
  // The rejected append must not have been applied.
  assert.equal((await store.loadEvents(MISSION_ID)).length, 1);
});

test("loadEvents returns a copy — mutating it cannot corrupt the store", async () => {
  const store = new InMemoryMissionStore();
  await store.append({ missionId: MISSION_ID, expectedVersion: 0, events: [createdEvent(1)] });
  const events = await store.loadEvents(MISSION_ID);
  events.push(createdEvent(99));
  assert.equal((await store.loadEvents(MISSION_ID)).length, 1, "external mutation must not leak into the store");
});

test("two concurrent appends at the same expectedVersion: exactly one wins", async () => {
  const store = new InMemoryMissionStore();
  await store.append({ missionId: MISSION_ID, expectedVersion: 0, events: [createdEvent(1)] });

  const [a, b] = await Promise.all([
    store.append({ missionId: MISSION_ID, expectedVersion: 1, events: [createdEvent(2)] }),
    store.append({ missionId: MISSION_ID, expectedVersion: 1, events: [createdEvent(2)] }),
  ]);

  const oks = [a, b].filter((r) => r.ok);
  const conflicts = [a, b].filter((r) => !r.ok);
  assert.equal(oks.length, 1, "exactly one concurrent append at the same version must succeed");
  assert.equal(conflicts.length, 1, "the other must observe a version conflict, never silently drop");
  assert.equal((await store.loadEvents(MISSION_ID)).length, 2, "the log must not contain both racing writes");
});

test("many concurrent appends racing on the same version: exactly one wins, log length matches", async () => {
  const store = new InMemoryMissionStore();
  await store.append({ missionId: MISSION_ID, expectedVersion: 0, events: [createdEvent(1)] });

  const attempts = Array.from({ length: 10 }, (_, i) =>
    store.append({ missionId: MISSION_ID, expectedVersion: 1, events: [createdEvent(2 + i)] }),
  );
  const results = await Promise.all(attempts);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal((await store.loadEvents(MISSION_ID)).length, 2);
});

test("appends to different missions never conflict with each other", async () => {
  const store = new InMemoryMissionStore();
  const [a, b] = await Promise.all([
    store.append({ missionId: "m-a", expectedVersion: 0, events: [createdEvent(1)] }),
    store.append({ missionId: "m-b", expectedVersion: 0, events: [createdEvent(1)] }),
  ]);
  assert.ok(a.ok);
  assert.ok(b.ok);
  assert.equal(store.missionCount, 2);
});
