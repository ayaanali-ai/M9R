/**
 * Diagnostic idempotency identity — closes the gap called out in
 * `scripts/mission-planning-diagnostics-store.test.ts`'s original header
 * comment ("no idempotency key, no dedup-by-key behavior").
 *
 * Identity fields under test: workspaceId, missionId, planningRequestId,
 * workerAttemptId (or a fixed no-attempt marker), diagnosticKind, stage,
 * contextHash. Content digest is computed separately over the
 * already-redacted, already-bounded stored content.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  InMemoryPlanningDiagnosticsStore,
  DiagnosticIdempotencyConflictError,
  type PlanningDiagnosticInput,
} from "../src/lib/mission/mission-planning-diagnostics-store.ts";

function baseInput(overrides: Partial<PlanningDiagnosticInput> = {}): PlanningDiagnosticInput {
  return {
    workspaceId: "ws-1",
    missionId: "m-1",
    planningRequestId: "preq-1",
    workerAttemptId: "attempt-1",
    diagnosticKind: "invocation_response",
    modelConfigurationId: "cfg-1",
    providerRequestId: "prov-1",
    contextHash: "hash-a",
    stage: "invocation",
    promptMetadataSummary: "3 constraints, 2 snippets",
    detail: "some redactable detail",
    createdAt: "2026-07-26T00:00:00.000Z",
    ...overrides,
  };
}

test("same identity, same content: retry returns the exact same stored record (same ref)", async () => {
  const store = new InMemoryPlanningDiagnosticsStore();
  const first = await store.store(baseInput());
  const second = await store.store(baseInput());
  assert.equal(second.ref, first.ref);
  assert.equal(second.digest, first.digest);
  assert.equal(second.idempotencyKey, first.idempotencyKey);
});

test("same identity, different content: refuses with a typed conflict error, does not overwrite", async () => {
  const store = new InMemoryPlanningDiagnosticsStore();
  const first = await store.store(baseInput());
  await assert.rejects(
    () => store.store(baseInput({ detail: "a completely different detail" })),
    (err: unknown) => {
      assert.ok(err instanceof DiagnosticIdempotencyConflictError);
      assert.equal(err.existingRef, first.ref);
      return true;
    },
  );
  // The original record must be untouched.
  const stillOriginal = store.get("ws-1", first.ref);
  assert.ok(stillOriginal);
  assert.equal(stillOriginal?.detail, "some redactable detail");
});

test("cross-workspace key reuse never collides even with identical logical fields", async () => {
  const store = new InMemoryPlanningDiagnosticsStore();
  const a = await store.store(baseInput({ workspaceId: "ws-a" }));
  const b = await store.store(baseInput({ workspaceId: "ws-b" }));
  assert.notEqual(a.ref, b.ref);
  assert.notEqual(a.idempotencyKey, b.idempotencyKey);
  // Cross-workspace resolution is refused, not silently returned.
  assert.equal(store.get("ws-b", a.ref), null);
  assert.equal(store.get("ws-a", b.ref), null);
});

test("differing workerAttemptId (including omitted) produces distinct identities", async () => {
  const store = new InMemoryPlanningDiagnosticsStore();
  const withAttempt = await store.store(baseInput({ workerAttemptId: "attempt-1" }));
  const otherAttempt = await store.store(baseInput({ workerAttemptId: "attempt-2" }));
  const noAttempt = await store.store(baseInput({ workerAttemptId: null }));
  const keys = new Set([withAttempt.idempotencyKey, otherAttempt.idempotencyKey, noAttempt.idempotencyKey]);
  assert.equal(keys.size, 3);
});

test("reference stable after simulated restart: new store instance backed by the same underlying snapshot resolves the same ref and re-enforces idempotency", async () => {
  const store1 = new InMemoryPlanningDiagnosticsStore();
  const original = await store1.store(baseInput());
  const snapshot = store1.exportRecords();

  // Simulate a process restart: a fresh store instance rehydrated from the
  // same underlying persisted data.
  const store2 = new InMemoryPlanningDiagnosticsStore(snapshot);

  // The ref still resolves.
  const resolved = store2.get("ws-1", original.ref);
  assert.ok(resolved);
  assert.equal(resolved?.ref, original.ref);

  // A retry with the same identity/content after "restart" is still an
  // idempotent no-op against the rehydrated store.
  const retried = await store2.store(baseInput());
  assert.equal(retried.ref, original.ref);

  // A conflicting retry after "restart" is still refused.
  await assert.rejects(() => store2.store(baseInput({ detail: "different after restart" })), DiagnosticIdempotencyConflictError);
});

test("a non-null ref always resolves via get()", async () => {
  const store = new InMemoryPlanningDiagnosticsStore();
  const record = await store.store(baseInput());
  assert.ok(record.ref);
  const resolved = store.get(record.workspaceId, record.ref);
  assert.ok(resolved);
  assert.equal(resolved?.ref, record.ref);
});

test("a refused (conflicting) store() call never leaves any ref, dangling or otherwise", async () => {
  const store = new InMemoryPlanningDiagnosticsStore();
  const original = await store.store(baseInput());
  const beforeCount = store.exportRecords().records.length;

  await assert.rejects(() => store.store(baseInput({ detail: "conflicting content" })));

  const afterCount = store.exportRecords().records.length;
  assert.equal(afterCount, beforeCount, "a refused store() call must not mint or commit any new record");
  // The only ref that exists is still the original one.
  assert.equal(store.exportRecords().records[0]?.ref, original.ref);
});

test("differing diagnosticKind (same stage) produces distinct identities, not a collision", async () => {
  const store = new InMemoryPlanningDiagnosticsStore();
  const a = await store.store(baseInput({ diagnosticKind: "invocation_response" }));
  const b = await store.store(baseInput({ diagnosticKind: "invocation_request_summary" }));
  assert.notEqual(a.ref, b.ref);
  assert.notEqual(a.idempotencyKey, b.idempotencyKey);
});

test("differing contextHash (same everything else) produces distinct identities", async () => {
  const store = new InMemoryPlanningDiagnosticsStore();
  const a = await store.store(baseInput({ contextHash: "hash-a" }));
  const b = await store.store(baseInput({ contextHash: "hash-b" }));
  assert.notEqual(a.idempotencyKey, b.idempotencyKey);
});

test("oversized content is bounded (redactForDiagnostics truncates before storage) and still stored/idempotent under its identity", async () => {
  const store = new InMemoryPlanningDiagnosticsStore();
  const huge = "x".repeat(20_000);
  const first = await store.store(baseInput({ detail: huge }));
  assert.ok(first.sizeBytes <= 8_192, `expected bounded record, got ${first.sizeBytes} bytes`);
  // Retrying with the same (already-bounded-the-same-way) content is still idempotent.
  const second = await store.store(baseInput({ detail: huge }));
  assert.equal(second.ref, first.ref);
});
