import test from "node:test";
import assert from "node:assert/strict";

import { InMemoryPlanningAttemptStore } from "../src/lib/mission/mission-planning-attempt-store.ts";

let idCounter = 0;
function mintId(): string {
  idCounter += 1;
  return `id-${idCounter}`;
}

function makeStore() {
  return new InMemoryPlanningAttemptStore();
}

function baseCreateInput(overrides: Partial<Parameters<InMemoryPlanningAttemptStore["create"]>[0]> = {}) {
  return {
    workspaceId: "ws-1",
    missionId: "mission-1",
    planningRequestId: "req-1",
    leaseId: "lease-1",
    fencingToken: 1,
    workerIdentity: "worker-1",
    modelConfigurationId: "config-1",
    attemptKind: "initial" as const,
    attemptNumber: 1,
    contextHash: "hash-1",
    correlationId: "corr-1",
    now: "2026-07-26T00:00:00.000Z",
    mintId,
    ...overrides,
  };
}

test("claim creates an attempt in the 'claimed' state with one transition entry", () => {
  const store = makeStore();
  const attempt = store.create(baseCreateInput());
  assert.equal(attempt.state, "claimed");
  assert.equal(attempt.transitions.length, 1);
  assert.equal(attempt.transitions[0].toState, "claimed");
  assert.equal(attempt.providerRequestId, null);
  assert.equal(attempt.parentAttemptId, null);
});

test("legal transitions apply in order and append to history", () => {
  const store = makeStore();
  const attempt = store.create(baseCreateInput());
  const r1 = store.transition(attempt.workerAttemptId, 1, "invoking", "t1");
  assert.equal(r1.ok, true);
  const r2 = store.transition(attempt.workerAttemptId, 1, "response_received", "t2");
  assert.equal(r2.ok, true);
  if (r2.ok) {
    assert.equal(r2.attempt.responseReceivedAt, "t2");
    assert.equal(r2.attempt.transitions.length, 3);
  }
});

test("stale fence blocks further transitions", () => {
  const store = makeStore();
  const attempt = store.create(baseCreateInput());
  const result = store.transition(attempt.workerAttemptId, 999 /* wrong fencing token */, "invoking", "t1");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "stale_fencing_token");
});

test("duplicate terminal write with the same terminal state is idempotent (no-op)", () => {
  const store = makeStore();
  const attempt = store.create(baseCreateInput());
  const first = store.transition(attempt.workerAttemptId, 1, "completed", "t1", { outcome: "success" });
  assert.equal(first.ok, true);
  const second = store.transition(attempt.workerAttemptId, 1, "completed", "t2", { outcome: "success" });
  assert.equal(second.ok, true);
  if (second.ok) {
    assert.equal(second.noop, true);
    // No new transition entry, completedAt unchanged from the first write.
    if (first.ok) {
      assert.deepEqual(second.attempt, first.attempt);
    }
  }
});

test("conflicting terminal write (different terminal state) on an already-terminal attempt is rejected", () => {
  const store = makeStore();
  const attempt = store.create(baseCreateInput());
  const first = store.transition(attempt.workerAttemptId, 1, "completed", "t1", { outcome: "success" });
  assert.equal(first.ok, true);
  const conflicting = store.transition(attempt.workerAttemptId, 1, "failed", "t2", { outcome: "provider_rejected" });
  assert.equal(conflicting.ok, false);
  if (!conflicting.ok) assert.equal(conflicting.reason, "conflicting_terminal_write");
});

test("providerRequestId is attachable after invocation begins, not required at creation, and preserved once attached", () => {
  const store = makeStore();
  const attempt = store.create(baseCreateInput());
  assert.equal(attempt.providerRequestId, null);
  const attached = store.attachProviderRequestId(attempt.workerAttemptId, 1, "provider-req-abc");
  assert.equal(attached.ok, true);
  if (attached.ok) assert.equal(attached.attempt.providerRequestId, "provider-req-abc");

  // Re-attaching the SAME id is fine (idempotent).
  const reattachSame = store.attachProviderRequestId(attempt.workerAttemptId, 1, "provider-req-abc");
  assert.equal(reattachSame.ok, true);

  // Attaching a DIFFERENT id afterward is rejected — would indicate two invocations for one attempt.
  const reattachDifferent = store.attachProviderRequestId(attempt.workerAttemptId, 1, "provider-req-xyz");
  assert.equal(reattachDifferent.ok, false);
});

test("repair attempt links to its parent via parentAttemptId", () => {
  const store = makeStore();
  const initial = store.create(baseCreateInput());
  const repair = store.create(
    baseCreateInput({ attemptKind: "repair", attemptNumber: 2, parentAttemptId: initial.workerAttemptId, fencingToken: 1 }),
  );
  assert.equal(repair.attemptKind, "repair");
  assert.equal(repair.parentAttemptId, initial.workerAttemptId);
});

test("outcome_unknown is preserved as-is, never silently coerced to success/failure by the store", () => {
  const store = makeStore();
  const attempt = store.create(baseCreateInput());
  const result = store.transition(attempt.workerAttemptId, 1, "outcome_unknown", "t1", { outcome: "outcome_unknown" });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.attempt.state, "outcome_unknown");
    assert.equal(result.attempt.outcome, "outcome_unknown");
  }
  // A duplicate write of the same ambiguous outcome stays a no-op, not auto-resolved.
  const again = store.transition(attempt.workerAttemptId, 1, "outcome_unknown", "t2", { outcome: "outcome_unknown" });
  assert.equal(again.ok, true);
  if (again.ok) assert.equal(again.noop, true);
});

test("transition against an unknown workerAttemptId is not_found", () => {
  const store = makeStore();
  const result = store.transition("nonexistent", 1, "invoking", "t1");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "not_found");
});

test("listForRequest and listNonTerminal scope correctly", () => {
  const store = makeStore();
  const a = store.create(baseCreateInput({ planningRequestId: "req-a" }));
  const b = store.create(baseCreateInput({ planningRequestId: "req-a", fencingToken: 2 }));
  store.create(baseCreateInput({ planningRequestId: "req-b", fencingToken: 3 }));
  store.transition(a.workerAttemptId, 1, "completed", "t1", { outcome: "success" });

  const forReqA = store.listForRequest("ws-1", "mission-1", "req-a");
  assert.equal(forReqA.length, 2);

  const nonTerminal = store.listNonTerminal();
  assert.ok(nonTerminal.some((att) => att.workerAttemptId === b.workerAttemptId));
  assert.ok(!nonTerminal.some((att) => att.workerAttemptId === a.workerAttemptId));
});
