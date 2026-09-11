import test from "node:test";
import assert from "node:assert/strict";

import { InMemoryPlanningAttemptStore, type PlanningWorkerAttempt } from "../src/lib/mission/mission-planning-attempt-store.ts";
import { InMemoryPlanningLeaseStore, type PlanningLease } from "../src/lib/mission/mission-planning-lease-store.ts";
import type { PlanningRequestPort, MissionPlanningSnapshot } from "../src/lib/mission/mission-planning-request-port.ts";
import type { PlanningRequestRecord } from "../src/lib/mission/mission-domain.ts";
import {
  classifyRecoveryAction,
  recoverPlanningAttempts,
  type RequestSnapshotForRecovery,
} from "../src/lib/mission/mission-planning-recovery.ts";

let idCounter = 0;
function mintId(): string {
  idCounter += 1;
  return `attempt-${idCounter}`;
}

function baseAttempt(overrides: Partial<PlanningWorkerAttempt> = {}): PlanningWorkerAttempt {
  return {
    workerAttemptId: mintId(),
    workspaceId: "ws-1",
    missionId: "mission-1",
    planningRequestId: "req-1",
    leaseId: "lease-1",
    fencingToken: 1,
    workerIdentity: "worker-1",
    modelConfigurationId: "config-1",
    providerRequestId: null,
    attemptKind: "initial",
    attemptNumber: 1,
    state: "claimed",
    contextHash: "hash-1",
    startedAt: "2026-07-26T00:00:00.000Z",
    responseReceivedAt: null,
    completedAt: null,
    outcome: null,
    diagnosticRef: null,
    retryMetadata: { transportRetries: 0, throttleRetries: 0 },
    parentAttemptId: null,
    correlationId: "corr-1",
    causationId: null,
    transitions: [{ toState: "claimed", at: "2026-07-26T00:00:00.000Z" }],
    ...overrides,
  };
}

function baseRequest(overrides: Partial<PlanningRequestRecord> = {}): PlanningRequestRecord {
  return {
    id: "req-1",
    missionId: "mission-1",
    targetPlanVersion: 1,
    kind: "proposal",
    basePlanId: null,
    status: "in_progress",
    modelConfigurationId: "config-1",
    contextHash: "hash-1",
    attemptCount: 1,
    maxAttempts: 3,
    createdAt: "2026-07-26T00:00:00.000Z",
    startedAt: "2026-07-26T00:00:00.000Z",
    completedAt: null,
    correlationId: "corr-1",
    causationId: null,
    idempotencyKey: "idem-1",
    redactedDiagnosticRef: null,
    finalOutcome: null,
    resultingPlanId: null,
    ...overrides,
  };
}

function snapshotFor(request: PlanningRequestRecord | null, missionTerminal = false): RequestSnapshotForRecovery {
  return { request, missionTerminal };
}

const NOW = new Date("2026-07-26T01:00:00.000Z").getTime();

function expiredLease(overrides: Partial<PlanningLease> = {}): PlanningLease {
  return {
    workspaceId: "ws-1",
    missionId: "mission-1",
    planningRequestId: "req-1",
    ownerId: "worker-1",
    leaseId: "lease-1",
    fencingToken: 1,
    acquiredAt: "2026-07-26T00:00:00.000Z",
    expiresAt: "2026-07-26T00:05:00.000Z", // before NOW
    attempt: 1,
    status: "active",
    ...overrides,
  };
}

function liveLease(overrides: Partial<PlanningLease> = {}): PlanningLease {
  return expiredLease({ expiresAt: "2026-07-26T02:00:00.000Z", ...overrides });
}

test("crash before invocation (claimed, no providerRequestId) with expired lease -> retry_safe_no_external_call", () => {
  const attempt = baseAttempt({ state: "claimed", providerRequestId: null });
  const action = classifyRecoveryAction({ attempt, lease: expiredLease(), requestSnapshot: snapshotFor(baseRequest()), now: NOW });
  assert.equal(action, "retry_safe_no_external_call");
});

test("crash during invocation, provider request id unknown, lease gone -> retry_safe_no_external_call", () => {
  const attempt = baseAttempt({ state: "invoking", providerRequestId: null });
  const action = classifyRecoveryAction({ attempt, lease: null, requestSnapshot: snapshotFor(baseRequest()), now: NOW });
  assert.equal(action, "retry_safe_no_external_call");
});

test("crash after provider request id known but no response -> unsafe_requires_new_attempt_decision", () => {
  const attempt = baseAttempt({ state: "invoking", providerRequestId: "provider-req-1", responseReceivedAt: null });
  const action = classifyRecoveryAction({ attempt, lease: expiredLease(), requestSnapshot: snapshotFor(baseRequest()), now: NOW });
  assert.equal(action, "unsafe_requires_new_attempt_decision");
});

test("unsafe case wins even if lease looks expired AND request looks outstanding", () => {
  const attempt = baseAttempt({ state: "invoking", providerRequestId: "provider-req-1", responseReceivedAt: null });
  const action = classifyRecoveryAction({ attempt, lease: null, requestSnapshot: snapshotFor(baseRequest({ status: "requested" })), now: NOW });
  assert.equal(action, "unsafe_requires_new_attempt_decision");
});

test("crash after response before diagnostic persisted -> rerun_deterministic_pipeline_only", () => {
  const attempt = baseAttempt({
    state: "response_received",
    providerRequestId: "provider-req-1",
    responseReceivedAt: "2026-07-26T00:10:00.000Z",
  });
  const action = classifyRecoveryAction({ attempt, lease: expiredLease(), requestSnapshot: snapshotFor(baseRequest()), now: NOW });
  assert.equal(action, "rerun_deterministic_pipeline_only");
});

test("crash mid-parsing (response received, state parsing) -> rerun_deterministic_pipeline_only", () => {
  const attempt = baseAttempt({
    state: "parsing",
    providerRequestId: "provider-req-1",
    responseReceivedAt: "2026-07-26T00:10:00.000Z",
  });
  const action = classifyRecoveryAction({ attempt, lease: expiredLease(), requestSnapshot: snapshotFor(baseRequest()), now: NOW });
  assert.equal(action, "rerun_deterministic_pipeline_only");
});

// Crash after diagnostic persisted (attempt has diagnosticRef) before the
// result command lands: this repo's state model puts "validate/simulate ran
// locally" at states validating/simulating/repairing/recording_result, all
// of which occur strictly AFTER parsing. Since a diagnosticRef is attached
// once parsing succeeds (see mission-planning-attempt-store.ts
// attachDiagnosticRef doc comment) but validate/simulate are pure functions
// that either ran (advancing state past "parsing") or didn't (state stuck at
// "parsing"), the two are cleanly distinguished by `state`, not by
// `diagnosticRef` presence alone:
//  - state still "parsing"/"response_received" -> rerun_deterministic_pipeline_only
//    (validate/simulate have not run yet, redo them from the diagnostic).
//  - state "validating"/"simulating"/"repairing"/"recording_result" -> the
//    local result IS computed (or the repair loop already decided a
//    fresh model call is needed, which is out of scope for this crash point)
//    -> replay_persistence_only, gated on the authoritative status.
test("crash after diagnostic persisted, validate/simulate already ran locally (state=simulating) -> replay_persistence_only", () => {
  const attempt = baseAttempt({
    state: "simulating",
    providerRequestId: "provider-req-1",
    responseReceivedAt: "2026-07-26T00:10:00.000Z",
    diagnosticRef: "diag-1",
  });
  const action = classifyRecoveryAction({ attempt, lease: expiredLease(), requestSnapshot: snapshotFor(baseRequest({ status: "in_progress" })), now: NOW });
  assert.equal(action, "replay_persistence_only");
});

test("crash after diagnostic persisted, validate/simulate NOT yet run (state=parsing) -> rerun_deterministic_pipeline_only", () => {
  const attempt = baseAttempt({
    state: "parsing",
    providerRequestId: "provider-req-1",
    responseReceivedAt: "2026-07-26T00:10:00.000Z",
    diagnosticRef: "diag-1",
  });
  const action = classifyRecoveryAction({ attempt, lease: expiredLease(), requestSnapshot: snapshotFor(baseRequest({ status: "in_progress" })), now: NOW });
  assert.equal(action, "rerun_deterministic_pipeline_only");
});

test("crash after result command succeeds but ack lost, command did NOT land (status still outstanding) -> replay_persistence_only", () => {
  const attempt = baseAttempt({
    state: "recording_result",
    providerRequestId: "provider-req-1",
    responseReceivedAt: "2026-07-26T00:10:00.000Z",
  });
  const action = classifyRecoveryAction({
    attempt,
    lease: expiredLease(),
    requestSnapshot: snapshotFor(baseRequest({ status: "in_progress" })),
    now: NOW,
  });
  assert.equal(action, "replay_persistence_only");
});

test("crash after result command succeeds, ack lost but command DID land (status now completed) -> terminal_closed", () => {
  const attempt = baseAttempt({
    state: "recording_result",
    providerRequestId: "provider-req-1",
    responseReceivedAt: "2026-07-26T00:10:00.000Z",
  });
  const action = classifyRecoveryAction({
    attempt,
    lease: expiredLease(),
    requestSnapshot: snapshotFor(baseRequest({ status: "completed", finalOutcome: "created_plan" })),
    now: NOW,
  });
  assert.equal(action, "terminal_closed");
});

test("crash during repair (attemptKind repair) follows the same rules", () => {
  const attempt = baseAttempt({
    state: "invoking",
    attemptKind: "repair",
    parentAttemptId: "attempt-parent-1",
    providerRequestId: null,
  });
  const action = classifyRecoveryAction({ attempt, lease: expiredLease(), requestSnapshot: snapshotFor(baseRequest()), now: NOW });
  assert.equal(action, "retry_safe_no_external_call");
});

test("crash during repair with provider request id known but no response -> unsafe_requires_new_attempt_decision", () => {
  const attempt = baseAttempt({
    state: "invoking",
    attemptKind: "repair",
    parentAttemptId: "attempt-parent-1",
    providerRequestId: "provider-req-2",
    responseReceivedAt: null,
  });
  const action = classifyRecoveryAction({ attempt, lease: expiredLease(), requestSnapshot: snapshotFor(baseRequest()), now: NOW });
  assert.equal(action, "unsafe_requires_new_attempt_decision");
});

test("expired lease explicit case: lease present but its expiresAt is in the past -> proceeds past the live-lease short-circuit", () => {
  const attempt = baseAttempt({ state: "claimed", providerRequestId: null });
  const lease = expiredLease();
  assert.ok(new Date(lease.expiresAt).getTime() <= NOW, "fixture sanity: lease must actually be expired relative to NOW");
  const action = classifyRecoveryAction({ attempt, lease, requestSnapshot: snapshotFor(baseRequest()), now: NOW });
  assert.equal(action, "retry_safe_no_external_call");
});

test("live lease (not expired) -> skip_owned_by_live_worker regardless of attempt state", () => {
  const attempt = baseAttempt({ state: "invoking", providerRequestId: "provider-req-1", responseReceivedAt: null });
  const action = classifyRecoveryAction({ attempt, lease: liveLease(), requestSnapshot: snapshotFor(baseRequest()), now: NOW });
  assert.equal(action, "skip_owned_by_live_worker");
});

test("superseded request -> terminal_closed", () => {
  const attempt = baseAttempt({ state: "invoking", providerRequestId: null });
  const action = classifyRecoveryAction({
    attempt,
    lease: expiredLease(),
    requestSnapshot: snapshotFor(baseRequest({ status: "superseded", finalOutcome: "superseded" })),
    now: NOW,
  });
  assert.equal(action, "terminal_closed");
});

test("cancelled request -> terminal_closed", () => {
  const attempt = baseAttempt({ state: "invoking", providerRequestId: "provider-req-1", responseReceivedAt: null });
  const action = classifyRecoveryAction({
    attempt,
    lease: expiredLease(),
    requestSnapshot: snapshotFor(baseRequest({ status: "cancelled", finalOutcome: "cancelled" })),
    now: NOW,
  });
  // Request-terminal check (rule 2) runs before provider-id/response rules,
  // so a cancelled request closes even an otherwise-"unsafe" looking attempt.
  assert.equal(action, "terminal_closed");
});

test("terminal Mission -> terminal_closed, wins over precedence even against an otherwise-unsafe attempt", () => {
  const attempt = baseAttempt({ state: "invoking", providerRequestId: "provider-req-1", responseReceivedAt: null });
  const action = classifyRecoveryAction({
    attempt,
    lease: expiredLease(),
    requestSnapshot: snapshotFor(baseRequest({ status: "in_progress" }), true),
    now: NOW,
  });
  assert.equal(action, "terminal_closed");
});

test("outcome_unknown attempt (already terminal locally) -> terminal_closed, not re-litigated", () => {
  const attempt = baseAttempt({ state: "outcome_unknown", providerRequestId: "provider-req-1", responseReceivedAt: null, outcome: "outcome_unknown" });
  const action = classifyRecoveryAction({ attempt, lease: expiredLease(), requestSnapshot: snapshotFor(baseRequest()), now: NOW });
  assert.equal(action, "terminal_closed");
});

test("outcome_unknown precursor (providerRequestId set, no response, still non-terminal) -> unsafe_requires_new_attempt_decision, never auto-retried", async () => {
  const attempt = baseAttempt({ state: "invoking", providerRequestId: "provider-req-1", responseReceivedAt: null });
  const action = classifyRecoveryAction({ attempt, lease: expiredLease(), requestSnapshot: snapshotFor(baseRequest()), now: NOW });
  assert.equal(action, "unsafe_requires_new_attempt_decision");

  // Prove the runner never issues a side-effecting call for this case: spy on
  // recordModelPlanningResult and assert it is never invoked.
  const attemptStore = new InMemoryPlanningAttemptStore();
  const leaseStore = new InMemoryPlanningLeaseStore();
  const created = attemptStore.create({
    workspaceId: "ws-1",
    missionId: "mission-1",
    planningRequestId: "req-1",
    leaseId: "lease-1",
    fencingToken: 1,
    workerIdentity: "worker-1",
    modelConfigurationId: "config-1",
    attemptKind: "initial",
    attemptNumber: 1,
    contextHash: "hash-1",
    correlationId: "corr-1",
    now: "2026-07-26T00:00:00.000Z",
    mintId,
  });
  attemptStore.transition(created.workerAttemptId, 1, "invoking", "2026-07-26T00:01:00.000Z");
  attemptStore.attachProviderRequestId(created.workerAttemptId, 1, "provider-req-1");

  let recordCalls = 0;
  const port: PlanningRequestPort = {
    async loadSnapshot(): Promise<MissionPlanningSnapshot | null> {
      return {
        missionId: "mission-1",
        workspaceId: "ws-1",
        terminal: false,
        planningRequests: { "req-1": baseRequest({ status: "in_progress" }) },
        planVersions: {},
      };
    },
    async loadPlanningRequest() {
      return baseRequest({ status: "in_progress" });
    },
    async recordModelPlanningResult() {
      recordCalls += 1;
      return { ok: true, nextStatus: "completed", finalOutcome: "created_plan", resultingPlanId: "plan-1" };
    },
  };

  const results = await recoverPlanningAttempts(attemptStore, leaseStore, port, NOW);
  assert.equal(results.length, 1);
  assert.equal(results[0].action, "unsafe_requires_new_attempt_decision");
  assert.equal(recordCalls, 0, "runner must never call recordModelPlanningResult for the unsafe/outcome_unknown-precursor case");
});

test("duplicate recovery invocation is idempotent: running recoverPlanningAttempts twice produces identical classification with no additional mutation", async () => {
  const attemptStore = new InMemoryPlanningAttemptStore();
  const leaseStore = new InMemoryPlanningLeaseStore();
  const created = attemptStore.create({
    workspaceId: "ws-1",
    missionId: "mission-1",
    planningRequestId: "req-1",
    leaseId: "lease-1",
    fencingToken: 1,
    workerIdentity: "worker-1",
    modelConfigurationId: "config-1",
    attemptKind: "initial",
    attemptNumber: 1,
    contextHash: "hash-1",
    correlationId: "corr-1",
    now: "2026-07-26T00:00:00.000Z",
    mintId,
  });
  // Never invoked — retry_safe_no_external_call territory. No lease claimed at all (gone).

  const port: PlanningRequestPort = {
    async loadSnapshot(): Promise<MissionPlanningSnapshot | null> {
      return {
        missionId: "mission-1",
        workspaceId: "ws-1",
        terminal: false,
        planningRequests: { "req-1": baseRequest({ status: "in_progress" }) },
        planVersions: {},
      };
    },
    async loadPlanningRequest() {
      return baseRequest({ status: "in_progress" });
    },
    async recordModelPlanningResult() {
      throw new Error("must not be called");
    },
  };

  const firstRun = await recoverPlanningAttempts(attemptStore, leaseStore, port, NOW);
  assert.equal(firstRun.length, 1);
  assert.equal(firstRun[0].action, "retry_safe_no_external_call");

  const afterFirst = attemptStore.get(created.workerAttemptId);
  assert.equal(afterFirst?.state, "stale");
  const transitionsAfterFirst = afterFirst?.transitions.length;

  // Second run: the attempt is now terminal (`stale`), so it no longer
  // appears in listNonTerminal() at all — proving no re-classification and
  // no further mutation happens.
  const secondRun = await recoverPlanningAttempts(attemptStore, leaseStore, port, NOW);
  assert.equal(secondRun.length, 0, "attempt already marked stale must not be re-scanned");

  const afterSecond = attemptStore.get(created.workerAttemptId);
  assert.equal(afterSecond?.state, "stale");
  assert.equal(afterSecond?.transitions.length, transitionsAfterFirst, "no additional transition recorded by the second run");
});

test("request snapshot missing entirely -> requires_human_review", () => {
  const attempt = baseAttempt({ state: "invoking", providerRequestId: null });
  const action = classifyRecoveryAction({ attempt, lease: expiredLease(), requestSnapshot: snapshotFor(null), now: NOW });
  assert.equal(action, "requires_human_review");
});

test("state doesn't cleanly match any rule -> requires_human_review", () => {
  // Contradictory/corrupt combination: state regressed to "claimed" even
  // though a providerRequestId AND a response were already recorded. This
  // does not match rule 5 (response is not null), rule 6/7 (state is
  // "claimed", not response_received/parsing/validating/simulating/
  // repairing/recording_result), or rule 8 (providerRequestId is not null)
  // — it is a genuinely inconsistent state that must not be guessed at.
  const attempt = baseAttempt({
    state: "claimed",
    providerRequestId: "provider-req-1",
    responseReceivedAt: "2026-07-26T00:10:00.000Z",
  });
  const action = classifyRecoveryAction({ attempt, lease: expiredLease(), requestSnapshot: snapshotFor(baseRequest({ status: "in_progress" })), now: NOW });
  assert.equal(action, "requires_human_review");
});
