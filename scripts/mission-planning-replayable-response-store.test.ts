/**
 * InMemoryPlanningReplayableResponseStore — in-memory contract tests
 * (Phase 5E Task B).
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  InMemoryPlanningReplayableResponseStore,
  computeReplayableResponseDigest,
  type StoreReplayableResponseInput,
} from "../src/lib/mission/mission-planning-replayable-response-store.ts";

function baseInput(overrides: Partial<StoreReplayableResponseInput> = {}): StoreReplayableResponseInput {
  return {
    workerAttemptId: "attempt-1",
    workspaceId: "ws-1",
    missionId: "m-1",
    planningRequestId: "preq-1",
    modelConfigurationId: "cfg-1",
    schemaVersion: 1,
    redactedRawOutput: '{"interpretedObjective":"fix it"}',
    outputDigest: "digest-a",
    createdAt: "2026-07-26T00:00:00.000Z",
    ...overrides,
  };
}

test("store() persists a fresh record and returns status ok/created", async () => {
  const store = new InMemoryPlanningReplayableResponseStore();
  const result = await store.store(baseInput());
  assert.equal(result.status, "ok");
  assert.equal(result.reason, "created");
  assert.equal(result.response.workerAttemptId, "attempt-1");
  assert.equal(result.response.redactedRawOutput, baseInput().redactedRawOutput);
});

test("store() is idempotent for the same workerAttemptId + same digest", async () => {
  const store = new InMemoryPlanningReplayableResponseStore();
  const first = await store.store(baseInput());
  const second = await store.store(baseInput());
  assert.equal(second.status, "ok");
  assert.equal(second.reason, "idempotent_replay");
  assert.equal(second.response.redactedRawOutput, first.response.redactedRawOutput);
});

test("store() refuses a same-attempt call with a different digest, never overwriting", async () => {
  const store = new InMemoryPlanningReplayableResponseStore();
  await store.store(baseInput());
  const conflict = await store.store(baseInput({ redactedRawOutput: "different content", outputDigest: "digest-b" }));
  assert.equal(conflict.status, "refused");
  assert.equal(conflict.reason, "digest_conflict");
  // Original material is preserved unchanged.
  const stored = store.get("ws-1", "attempt-1");
  assert.equal(stored?.outputDigest, "digest-a");
});

test("get() is workspace-scoped — a record from another workspace is never returned", async () => {
  const store = new InMemoryPlanningReplayableResponseStore();
  await store.store(baseInput());
  assert.equal(store.get("ws-other", "attempt-1"), null);
  assert.ok(store.get("ws-1", "attempt-1"));
});

test("get() returns null for an unknown workerAttemptId", async () => {
  const store = new InMemoryPlanningReplayableResponseStore();
  assert.equal(store.get("ws-1", "no-such-attempt"), null);
});

test("computeReplayableResponseDigest is deterministic for identical content and differs for different content", async () => {
  const a1 = await computeReplayableResponseDigest("same text");
  const a2 = await computeReplayableResponseDigest("same text");
  const b = await computeReplayableResponseDigest("different text");
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
});

test("two distinct attempts (different workerAttemptId) never collide, even with identical content", async () => {
  const store = new InMemoryPlanningReplayableResponseStore();
  const digest = await computeReplayableResponseDigest("shared content");
  const r1 = await store.store(baseInput({ workerAttemptId: "attempt-1", redactedRawOutput: "shared content", outputDigest: digest }));
  const r2 = await store.store(baseInput({ workerAttemptId: "attempt-2", redactedRawOutput: "shared content", outputDigest: digest }));
  assert.equal(r1.reason, "created");
  assert.equal(r2.reason, "created");
  assert.notEqual(r1.response.workerAttemptId, r2.response.workerAttemptId);
});
