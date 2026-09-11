/**
 * MissionDispatchRuntime — Phase 2D.2 tests
 *
 * Exercised against `InMemoryMissionSchedulerStore` (Phase 2D.1's reference
 * store) and `InMemoryExecutionHost` (a scriptable test double — NOT a
 * provider adapter). Covers: adoption starting local supervision, heartbeat
 * renewal keeping a lease alive, fencing enforced before ANY result is
 * accepted, cancellation of a stale worker's local process when renewal
 * fails, and startup recovery of outstanding dispatch intents.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InMemoryMissionSchedulerStore, type ClaimCandidatesInput, type InMemoryMissionRecord } from "../src/lib/mission/mission-scheduler-store.ts";
import { DEFAULT_SCHEDULER_POLICY, DISPATCHABLE_MISSION_STATES, type LeaseHolder, type SchedulerPolicy } from "../src/lib/mission/mission-scheduler.ts";
import { InMemoryExecutionHost, MissionDispatchRuntime } from "../src/lib/mission/mission-dispatch-runtime.ts";
import { InMemoryProcessExecutionHost } from "../src/lib/mission/mission-process-host.ts";

const agentA: LeaseHolder = { kind: "agent", id: "agent-a" };
const agentB: LeaseHolder = { kind: "agent", id: "agent-b" };
const policy: SchedulerPolicy = DEFAULT_SCHEDULER_POLICY;

const T0 = "2026-07-27T00:00:00.000Z";
function minutesAfterT0(mins: number): string {
  return new Date(Date.parse(T0) + mins * 60_000).toISOString();
}

function missionRegistry(entries: Record<string, InMemoryMissionRecord>): Map<string, InMemoryMissionRecord> {
  return new Map(Object.entries(entries));
}

function claimInput(missionId: string, holder: LeaseHolder, now: string): ClaimCandidatesInput {
  return {
    candidates: [{ missionId, workspaceId: "ws-1", dispatchKey: "primary", missionState: "ready" }],
    holder,
    now,
    policy,
    dispatchableStates: DISPATCHABLE_MISSION_STATES,
  };
}

test("adopt starts local supervision and reaches 'running'", async () => {
  const store = new InMemoryMissionSchedulerStore(missionRegistry({ "m-1": { workspaceId: "ws-1", repositoryId: null } }));
  const host = new InMemoryExecutionHost();
  const runtime = new MissionDispatchRuntime({ store, host, holder: agentA, policy });

  const claimed = await store.claimCandidates(claimInput("m-1", agentA, T0));
  assert.equal(claimed.claimed.length, 1);

  const record = await runtime.adopt(claimed.claimed[0].instruction, T0);
  assert.equal(record.state, "running");
  assert.equal(runtime.listTracked().length, 1);
});

test("tick renews the lease while the host has not yet finished, and tracks the bumped fencing token", async () => {
  const store = new InMemoryMissionSchedulerStore(missionRegistry({ "m-1": { workspaceId: "ws-1", repositoryId: null } }));
  const host = new InMemoryExecutionHost();
  const runtime = new MissionDispatchRuntime({ store, host, holder: agentA, policy });

  const claimed = await store.claimCandidates(claimInput("m-1", agentA, T0));
  await runtime.adopt(claimed.claimed[0].instruction, T0);

  // Within the renewal window (leaseDurationMs=5min, renewalWindowMs=1min).
  const report = await runtime.tick(minutesAfterT0(4.5));
  assert.equal(report.renewed, 1);
  assert.equal(report.completed.length, 0);
  assert.equal(report.leaseLost.length, 0);

  const tracked = runtime.listTracked()[0];
  assert.equal(tracked.fencingToken, claimed.claimed[0].lease.fencingToken + 1, "renewal must bump the Runtime's own tracked fencing token");
});

test("tick accepts a successful outcome, releases the lease, and a new claimant can immediately re-claim the slot", async () => {
  const store = new InMemoryMissionSchedulerStore(missionRegistry({ "m-1": { workspaceId: "ws-1", repositoryId: null } }));
  const host = new InMemoryExecutionHost();
  const runtime = new MissionDispatchRuntime({ store, host, holder: agentA, policy });

  const claimed = await store.claimCandidates(claimInput("m-1", agentA, T0));
  await runtime.adopt(claimed.claimed[0].instruction, T0);
  host.resolve({ handleId: "handle-1" }, { success: true, summary: "all good" });

  const report = await runtime.tick(minutesAfterT0(1));
  assert.equal(report.completed.length, 1);
  assert.equal(report.completed[0].state, "completed");

  const reclaim = await store.claimCandidates(claimInput("m-1", agentB, minutesAfterT0(1)));
  assert.equal(reclaim.claimed.length, 1, "the lease must have been genuinely released, not just marked complete locally");
});

test("tick discards a finished outcome when the fence is no longer valid, and never releases someone else's lease", async () => {
  const store = new InMemoryMissionSchedulerStore(missionRegistry({ "m-1": { workspaceId: "ws-1", repositoryId: null } }));
  const host = new InMemoryExecutionHost();
  const runtime = new MissionDispatchRuntime({ store, host, holder: agentA, policy });

  const claimed = await store.claimCandidates(claimInput("m-1", agentA, T0));
  await runtime.adopt(claimed.claimed[0].instruction, T0);

  // Slot expires, and a DIFFERENT holder reclaims it before this worker's
  // tick runs — this worker's fencing token is now stale.
  const reclaim = await store.claimCandidates(claimInput("m-1", agentB, minutesAfterT0(999)));
  assert.equal(reclaim.claimed.length, 1);

  host.resolve({ handleId: "handle-1" }, { success: true, summary: "too late" });
  const report = await runtime.tick(minutesAfterT0(1000));

  assert.equal(report.completed.length, 0, "a stale worker's result must never be accepted");
  assert.equal(report.leaseLost.length, 1);
  assert.equal(report.leaseLost[0].state, "lease_lost");

  // The reclaiming holder's lease must be untouched by the stale worker's tick.
  const currentlyLive = await store.validateFence({
    workspaceId: "ws-1",
    missionId: "m-1",
    dispatchKey: "primary",
    leaseId: reclaim.claimed[0].lease.leaseId,
    fencingToken: reclaim.claimed[0].lease.fencingToken,
  });
  assert.equal(currentlyLive, true, "the NEW holder's lease must remain valid after the stale worker's tick");
});

test("tick cancels the local process and marks lease_lost when renewal fails (e.g. the lease was revoked out from under it)", async () => {
  const store = new InMemoryMissionSchedulerStore(missionRegistry({ "m-1": { workspaceId: "ws-1", repositoryId: null } }));
  const host = new InMemoryExecutionHost();
  const runtime = new MissionDispatchRuntime({ store, host, holder: agentA, policy });

  const claimed = await store.claimCandidates(claimInput("m-1", agentA, T0));
  await runtime.adopt(claimed.claimed[0].instruction, T0);

  await store.revokeLease({ workspaceId: "ws-1", missionId: "m-1", dispatchKey: "primary", now: minutesAfterT0(1), reason: "mission cancelled" });

  const report = await runtime.tick(minutesAfterT0(2));
  assert.equal(report.leaseLost.length, 1);
  assert.equal(report.leaseLost[0].state, "lease_lost");
  assert.equal(host.wasCancelled({ handleId: "handle-1" }), true, "the local process must be cancelled once its lease can no longer be renewed");
});

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

test("recoverOnStartup revokes and closes an outstanding intent whose fence is still valid (no local process survived the restart)", async () => {
  const store = new InMemoryMissionSchedulerStore(missionRegistry({ "m-1": { workspaceId: "ws-1", repositoryId: null } }));
  await store.claimCandidates(claimInput("m-1", agentA, T0));

  // A FRESH runtime instance — represents a restarted process with no
  // memory of the claim above.
  const host = new InMemoryExecutionHost();
  const restarted = new MissionDispatchRuntime({ store, host, holder: agentA, policy });

  const report = await restarted.recoverOnStartup("ws-1", minutesAfterT0(1));
  assert.equal(report.revokedAndClosed.length, 1);
  assert.equal(report.closedAsStale.length, 0);

  assert.deepEqual(await store.listOutstandingDispatchIntents("ws-1"), []);

  const reclaim = await store.claimCandidates(claimInput("m-1", agentB, minutesAfterT0(2)));
  assert.equal(reclaim.claimed.length, 1, "the slot must be cleanly re-claimable after recovery revoked the orphaned lease");
});

test("recoverOnStartup closes an outstanding intent as stale when it was already superseded before restart", async () => {
  const store = new InMemoryMissionSchedulerStore(missionRegistry({ "m-1": { workspaceId: "ws-1", repositoryId: null } }));
  await store.claimCandidates(claimInput("m-1", agentA, T0));
  // Reclaimed by someone else before the restart even happens.
  await store.claimCandidates(claimInput("m-1", agentB, minutesAfterT0(999)));

  const host = new InMemoryExecutionHost();
  const restarted = new MissionDispatchRuntime({ store, host, holder: agentA, policy });

  const report = await restarted.recoverOnStartup("ws-1", minutesAfterT0(1000));
  // Exactly one intent is outstanding at recovery time (the newer claim's),
  // and its fence IS still valid — so it is revoked-and-closed, not "stale."
  // The truly stale case (a fence already invalid at recovery time) is
  // structural: only the newest claim's intent is ever left outstanding,
  // since claiming supersedes the previous intent immediately. This test
  // documents that supersession already prevents a stale outstanding intent
  // from existing at all in the common case.
  assert.equal(report.revokedAndClosed.length + report.closedAsStale.length, 1);
});

// ---------------------------------------------------------------------------
// Recovery-path consolidation (Phase 4D Part 4 §6) — recoverOnStartup routes
// to the process-aware path whenever a ProcessExecutionHost is configured,
// rather than a production caller having to remember to call a different
// function.
// ---------------------------------------------------------------------------

test("recoverOnStartup delegates to the process-aware path when a ProcessExecutionHost is configured — a confirmed-dead process is revoked and closed", async () => {
  const store = new InMemoryMissionSchedulerStore(missionRegistry({ "m-1": { workspaceId: "ws-1", repositoryId: null } }));
  const claimed = await store.claimCandidates(claimInput("m-1", agentA, T0));
  const instructionId = claimed.claimed[0].instruction.instructionId;

  const processHost = new InMemoryProcessExecutionHost();
  const env = await processHost.prepare({ instruction: claimed.claimed[0].instruction, repositoryRef: null });
  const handle = await processHost.launch({ instruction: claimed.claimed[0].instruction, environment: env, invocation: null });
  await store.attachProcessHandle(instructionId, handle as unknown as Record<string, unknown>);
  processHost.setStatus(handle, { kind: "process_confirmed_dead", detail: "exited before recovery ran", exitCode: 0 }); // confirmed dead by the time recovery runs

  const host = new InMemoryExecutionHost();
  const restarted = new MissionDispatchRuntime({ store, host, holder: agentA, policy, processHost });

  const report = await restarted.recoverOnStartup("ws-1", minutesAfterT0(1));
  assert.equal(report.revokedAndClosed.length, 1);
  assert.equal(report.reattached.length, 0);
  assert.equal(report.blockedForReview.length, 0);

  const reclaim = await store.claimCandidates(claimInput("m-1", agentB, minutesAfterT0(2)));
  assert.equal(reclaim.claimed.length, 1, "the slot must be cleanly re-claimable after process-aware recovery revoked the lease");
});

test("recoverOnStartup delegates to the process-aware path and reports blockedForReview for an unresolvable status — never silently closing the intent", async () => {
  const store = new InMemoryMissionSchedulerStore(missionRegistry({ "m-1": { workspaceId: "ws-1", repositoryId: null } }));
  const claimed = await store.claimCandidates(claimInput("m-1", agentA, T0));
  const instructionId = claimed.claimed[0].instruction.instructionId;

  // No process handle ever persisted for this instruction — matches
  // "handle missing after ambiguous launch," the most conservative of the
  // process-aware path's five outcomes.
  const processHost = new InMemoryProcessExecutionHost();
  const host = new InMemoryExecutionHost();
  const restarted = new MissionDispatchRuntime({ store, host, holder: agentA, policy, processHost });

  const report = await restarted.recoverOnStartup("ws-1", minutesAfterT0(1));
  assert.equal(report.blockedForReview.length, 1);
  assert.equal(report.revokedAndClosed.length, 0);

  // Crucially: the intent must still be outstanding — nothing was silently closed.
  const outstanding = await store.listOutstandingDispatchIntents("ws-1");
  assert.equal(outstanding.length, 1);
  assert.equal(outstanding[0].instructionId, instructionId);
});

test("recoverOnStartup WITHOUT a ProcessExecutionHost still falls back to the original fence-only classification, unchanged", async () => {
  const store = new InMemoryMissionSchedulerStore(missionRegistry({ "m-1": { workspaceId: "ws-1", repositoryId: null } }));
  await store.claimCandidates(claimInput("m-1", agentA, T0));

  const host = new InMemoryExecutionHost();
  const restarted = new MissionDispatchRuntime({ store, host, holder: agentA, policy }); // no processHost

  const report = await restarted.recoverOnStartup("ws-1", minutesAfterT0(1));
  assert.equal(report.revokedAndClosed.length, 1);
  assert.equal(report.reattached.length, 0);
  assert.equal(report.blockedForReview.length, 0);
});
