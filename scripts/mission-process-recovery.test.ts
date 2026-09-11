/**
 * Process-aware recovery — Phase 3A tests
 *
 * This is where the "critical recovery correction" is proven: a restarted
 * Runtime with a persisted process handle no longer always revokes a
 * still-valid lease — it inspects the real process first and follows the
 * five-rule model. Also covers duplicate-dispatch resolution after
 * recovery, a stale execution's result never committing even when routed
 * through a provider adapter, and terminal-execution immutability holding
 * through this phase's new paths.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { determineRecoveryAction, recoverOutstandingIntentsWithProcessHost } from "../src/lib/mission/mission-process-recovery.ts";
import { InMemoryProcessExecutionHost, type PersistableProcessHandle } from "../src/lib/mission/mission-process-host.ts";
import { InMemoryMissionSchedulerStore, type InMemoryMissionRecord } from "../src/lib/mission/mission-scheduler-store.ts";
import { DEFAULT_SCHEDULER_POLICY, DISPATCHABLE_MISSION_STATES, type LeaseHolder } from "../src/lib/mission/mission-scheduler.ts";
import { FakeProviderAdapter } from "../src/lib/mission/mission-provider-adapter.ts";
import { completeExecution, markLeaseLost } from "../src/lib/mission/mission-execution.ts";
import { InMemoryExecutionHost, MissionDispatchRuntime } from "../src/lib/mission/mission-dispatch-runtime.ts";

const agentA: LeaseHolder = { kind: "agent", id: "agent-a" };
const agentB: LeaseHolder = { kind: "agent", id: "agent-b" };
const policy = DEFAULT_SCHEDULER_POLICY;
const T0 = "2026-07-28T00:00:00.000Z";
function minutesAfterT0(mins: number) {
  return new Date(Date.parse(T0) + mins * 60_000).toISOString();
}

function missionRegistry(entries: Record<string, InMemoryMissionRecord>) {
  return new Map(Object.entries(entries));
}

// ---------------------------------------------------------------------------
// Pure decision table
// ---------------------------------------------------------------------------

test("determineRecoveryAction implements all five rules", () => {
  assert.equal(determineRecoveryAction("process_confirmed_dead", "disposable"), "revoke_and_allow_redispatch");
  assert.equal(determineRecoveryAction("process_confirmed_dead", "shared"), "revoke_and_allow_redispatch");
  assert.equal(determineRecoveryAction("process_alive_reattachable", "disposable"), "restore_supervision");
  assert.equal(determineRecoveryAction("process_alive_not_reattachable", "shared"), "terminate_then_revoke");
  assert.equal(determineRecoveryAction("process_status_unknown", "disposable"), "quarantine_and_allow_redispatch");
  assert.equal(determineRecoveryAction("process_status_unknown", "shared"), "block_redispatch_requires_review");
});

// ---------------------------------------------------------------------------
// Helper: claim + attach a process handle, as MissionDispatchRuntime.adopt +
// a future ProcessExecutionHost-backed launch would together produce.
// ---------------------------------------------------------------------------

async function claimAndAttachHandle(
  store: InMemoryMissionSchedulerStore,
  processHost: InMemoryProcessExecutionHost,
  missionId: string,
  holder: LeaseHolder,
  now: string,
  environmentKind: "disposable" | "shared" = "disposable",
): Promise<{ instructionId: string; handle: PersistableProcessHandle }> {
  const claimed = await store.claimCandidates({
    candidates: [{ missionId, workspaceId: "ws-1", dispatchKey: "primary", missionState: "ready", adapterRequirement: "codex" }],
    holder,
    now,
    policy,
    dispatchableStates: DISPATCHABLE_MISSION_STATES,
  });
  const instruction = claimed.claimed[0].instruction;
  const env = await processHost.prepare({ instruction, repositoryRef: null });
  const forcedEnv = { ...env, kind: environmentKind };
  const handle = await processHost.launch({ instruction, environment: forcedEnv, invocation: null });
  await store.attachProcessHandle(instruction.instructionId, handle as unknown as Record<string, unknown>);
  return { instructionId: instruction.instructionId, handle };
}

// ---------------------------------------------------------------------------
// The five rules, end to end through the coordinator
// ---------------------------------------------------------------------------

test("rule 1 — confirmed dead: revokes and allows a clean redispatch", async () => {
  const store = new InMemoryMissionSchedulerStore(missionRegistry({ "m-1": { workspaceId: "ws-1", repositoryId: null } }));
  const processHost = new InMemoryProcessExecutionHost();
  const { handle } = await claimAndAttachHandle(store, processHost, "m-1", agentA, T0);
  processHost.setStatus(handle, { kind: "process_confirmed_dead", detail: "exited", exitCode: 0 });

  const report = await recoverOutstandingIntentsWithProcessHost({ schedulerStore: store, processHost, workspaceId: "ws-1", now: minutesAfterT0(1) });
  assert.equal(report.outcomes.length, 1);
  assert.equal(report.outcomes[0].outcome, "process_confirmed_dead");
  assert.equal(report.outcomes[0].requiresHumanReview, false);

  const redispatch = await store.claimCandidates({
    candidates: [{ missionId: "m-1", workspaceId: "ws-1", dispatchKey: "primary", missionState: "ready" }],
    holder: agentB,
    now: minutesAfterT0(2),
    policy,
    dispatchableStates: DISPATCHABLE_MISSION_STATES,
  });
  assert.equal(redispatch.claimed.length, 1, "the slot must be cleanly re-claimable after a confirmed-dead recovery");
});

test("rule 2 — reattachable: restores supervision and retains the existing lease, never redispatching", async () => {
  const store = new InMemoryMissionSchedulerStore(missionRegistry({ "m-1": { workspaceId: "ws-1", repositoryId: null } }));
  const processHost = new InMemoryProcessExecutionHost();
  const { handle } = await claimAndAttachHandle(store, processHost, "m-1", agentA, T0);
  processHost.setStatus(handle, { kind: "process_alive_reattachable", detail: "still running", exitCode: null });

  const report = await recoverOutstandingIntentsWithProcessHost({ schedulerStore: store, processHost, workspaceId: "ws-1", now: minutesAfterT0(1) });
  assert.equal(report.outcomes[0].outcome, "process_reattached");
  assert.ok(report.outcomes[0].reattached);

  // The intent must remain outstanding (still legitimately in flight) and
  // the slot must NOT be claimable by someone else.
  const stillOutstanding = await store.listOutstandingDispatchIntents("ws-1");
  assert.equal(stillOutstanding.length, 1);

  const redispatchAttempt = await store.claimCandidates({
    candidates: [{ missionId: "m-1", workspaceId: "ws-1", dispatchKey: "primary", missionState: "ready" }],
    holder: agentB,
    now: minutesAfterT0(2),
    policy,
    dispatchableStates: DISPATCHABLE_MISSION_STATES,
  });
  assert.equal(redispatchAttempt.claimed.length, 0, "a reattached process's lease must not be up for grabs");
});

test("rule 3 — alive but not reattachable: terminates, confirms, THEN revokes", async () => {
  const store = new InMemoryMissionSchedulerStore(missionRegistry({ "m-1": { workspaceId: "ws-1", repositoryId: null } }));
  const processHost = new InMemoryProcessExecutionHost();
  const { handle } = await claimAndAttachHandle(store, processHost, "m-1", agentA, T0);
  processHost.setStatus(handle, { kind: "process_alive_not_reattachable", detail: "running, no session to resume", exitCode: null });

  const report = await recoverOutstandingIntentsWithProcessHost({ schedulerStore: store, processHost, workspaceId: "ws-1", now: minutesAfterT0(1) });
  assert.equal(report.outcomes[0].outcome, "process_terminated");

  const inspectAfter = await processHost.inspect(handle);
  assert.equal(inspectAfter.kind, "process_confirmed_dead", "termination must actually have happened, not just been reported");

  const redispatch = await store.claimCandidates({
    candidates: [{ missionId: "m-1", workspaceId: "ws-1", dispatchKey: "primary", missionState: "ready" }],
    holder: agentB,
    now: minutesAfterT0(2),
    policy,
    dispatchableStates: DISPATCHABLE_MISSION_STATES,
  });
  assert.equal(redispatch.claimed.length, 1, "the slot must be re-claimable only AFTER confirmed termination");
});

test("rule 4 — unknown status in a disposable environment: quarantines the old environment, allows redispatch", async () => {
  const store = new InMemoryMissionSchedulerStore(missionRegistry({ "m-1": { workspaceId: "ws-1", repositoryId: null } }));
  const processHost = new InMemoryProcessExecutionHost();
  const { handle } = await claimAndAttachHandle(store, processHost, "m-1", agentA, T0, "disposable");
  // Left at its just-launched default: process_status_unknown.

  const report = await recoverOutstandingIntentsWithProcessHost({ schedulerStore: store, processHost, workspaceId: "ws-1", now: minutesAfterT0(1) });
  assert.equal(report.outcomes[0].outcome, "environment_quarantined");
  assert.equal(processHost.isQuarantined(handle.environmentId), true);

  const redispatch = await store.claimCandidates({
    candidates: [{ missionId: "m-1", workspaceId: "ws-1", dispatchKey: "primary", missionState: "ready" }],
    holder: agentB,
    now: minutesAfterT0(2),
    policy,
    dispatchableStates: DISPATCHABLE_MISSION_STATES,
  });
  assert.equal(redispatch.claimed.length, 1, "redispatch must use a fresh environment/worktree, never the quarantined one — that's the caller's next `prepare()` call, which this test proves is now free to happen");
});

test("rule 5 — unknown status in a shared environment: blocks redispatch and requires human review", async () => {
  const store = new InMemoryMissionSchedulerStore(missionRegistry({ "m-1": { workspaceId: "ws-1", repositoryId: null } }));
  const processHost = new InMemoryProcessExecutionHost();
  const { handle } = await claimAndAttachHandle(store, processHost, "m-1", agentA, T0, "shared");

  const report = await recoverOutstandingIntentsWithProcessHost({ schedulerStore: store, processHost, workspaceId: "ws-1", now: minutesAfterT0(1) });
  assert.equal(report.outcomes[0].outcome, "process_status_unknown");
  assert.equal(report.outcomes[0].requiresHumanReview, true);
  assert.equal(processHost.isQuarantined(handle.environmentId), false, "a shared environment must never be silently quarantined/discarded");

  const redispatchAttempt = await store.claimCandidates({
    candidates: [{ missionId: "m-1", workspaceId: "ws-1", dispatchKey: "primary", missionState: "ready" }],
    holder: agentB,
    now: minutesAfterT0(2),
    policy,
    dispatchableStates: DISPATCHABLE_MISSION_STATES,
  });
  assert.equal(redispatchAttempt.claimed.length, 0, "must NOT immediately redispatch when status is unknown in a shared environment");

  const stillOutstanding = await store.listOutstandingDispatchIntents("ws-1");
  assert.equal(stillOutstanding.length, 1, "the intent stays outstanding for a human or a later, better-informed pass");
});

test("no persisted process handle at all is treated as conservatively as rule 5, never assumed disposable", async () => {
  const store = new InMemoryMissionSchedulerStore(missionRegistry({ "m-1": { workspaceId: "ws-1", repositoryId: null } }));
  const processHost = new InMemoryProcessExecutionHost();
  await store.claimCandidates({
    candidates: [{ missionId: "m-1", workspaceId: "ws-1", dispatchKey: "primary", missionState: "ready" }],
    holder: agentA,
    now: T0,
    policy,
    dispatchableStates: DISPATCHABLE_MISSION_STATES,
  });
  // Deliberately never call attachProcessHandle.

  const report = await recoverOutstandingIntentsWithProcessHost({ schedulerStore: store, processHost, workspaceId: "ws-1", now: minutesAfterT0(1) });
  assert.equal(report.outcomes[0].outcome, "process_status_unknown");
  assert.equal(report.outcomes[0].requiresHumanReview, true);
});

// ---------------------------------------------------------------------------
// Duplicate dispatch resolves to one authoritative execution
// ---------------------------------------------------------------------------

test("duplicate dispatch after recovery resolves to exactly one authoritative execution", async () => {
  const store = new InMemoryMissionSchedulerStore(missionRegistry({ "m-1": { workspaceId: "ws-1", repositoryId: null } }));
  const processHost = new InMemoryProcessExecutionHost();
  const { handle } = await claimAndAttachHandle(store, processHost, "m-1", agentA, T0);
  processHost.setStatus(handle, { kind: "process_confirmed_dead", detail: "exited", exitCode: 0 });

  await recoverOutstandingIntentsWithProcessHost({ schedulerStore: store, processHost, workspaceId: "ws-1", now: minutesAfterT0(1) });

  // Two workers race to redispatch onto the now-freed slot.
  const [a, b] = await Promise.all([
    store.claimCandidates({
      candidates: [{ missionId: "m-1", workspaceId: "ws-1", dispatchKey: "primary", missionState: "ready" }],
      holder: agentA,
      now: minutesAfterT0(2),
      policy,
      dispatchableStates: DISPATCHABLE_MISSION_STATES,
    }),
    store.claimCandidates({
      candidates: [{ missionId: "m-1", workspaceId: "ws-1", dispatchKey: "primary", missionState: "ready" }],
      holder: agentB,
      now: minutesAfterT0(2),
      policy,
      dispatchableStates: DISPATCHABLE_MISSION_STATES,
    }),
  ]);

  const claimedCount = a.claimed.length + b.claimed.length;
  assert.equal(claimedCount, 1, "exactly one redispatch attempt must win — never two authoritative executions for the same slot");
});

// ---------------------------------------------------------------------------
// Stale execution cannot commit through an adapter
// ---------------------------------------------------------------------------

test("stale execution cannot commit through an adapter — MissionDispatchRuntime.tick still enforces fencing when the outcome came from a ProviderAdapter", async () => {
  const store = new InMemoryMissionSchedulerStore(missionRegistry({ "m-1": { workspaceId: "ws-1", repositoryId: null } }));
  const host = new InMemoryExecutionHost();
  const runtime = new MissionDispatchRuntime({ store, host, holder: agentA, policy });
  const adapter = new FakeProviderAdapter("codex", { non_interactive_execution: true });

  const claimed = await store.claimCandidates({
    candidates: [{ missionId: "m-1", workspaceId: "ws-1", dispatchKey: "primary", missionState: "ready" }],
    holder: agentA,
    now: T0,
    policy,
    dispatchableStates: DISPATCHABLE_MISSION_STATES,
  });
  await runtime.adopt(claimed.claimed[0].instruction, T0);

  // Someone else reclaims the slot before this worker's adapter reports a result.
  await store.claimCandidates({
    candidates: [{ missionId: "m-1", workspaceId: "ws-1", dispatchKey: "primary", missionState: "ready" }],
    holder: agentB,
    now: minutesAfterT0(999),
    policy,
    dispatchableStates: DISPATCHABLE_MISSION_STATES,
  });

  // The adapter itself has no idea any of this happened — it just reports
  // what the (fake) process told it, via the SAME provider-neutral path a
  // real Codex/Claude Code adapter would use.
  const providerResult = await adapter.collectResult({ events: [], exitCode: 0 });
  assert.equal(providerResult.success, true, "the adapter's own view of the work is a genuine success");

  host.resolve({ handleId: "handle-1" }, { success: providerResult.success, summary: providerResult.summary });
  const report = await runtime.tick(minutesAfterT0(1000));

  assert.equal(report.completed.length, 0, "a successful adapter result must still never commit once the fence has moved on");
  assert.equal(report.leaseLost.length, 1);
});

// ---------------------------------------------------------------------------
// Terminal execution remains immutable through this phase's paths
// ---------------------------------------------------------------------------

test("a terminal ExecutionRecord stays immutable even when a recovery-style completion is attempted afterward", () => {
  const terminated = markLeaseLost(
    {
      executionId: "exec-1",
      instructionId: "intent-1",
      missionId: "m-1",
      workspaceId: "ws-1",
      dispatchKey: "primary",
      leaseId: "lease-1",
      fencingToken: 1,
      attempt: 1,
      state: "running",
      startedAt: T0,
      endedAt: null,
      lastHeartbeatAt: T0,
      outcome: null,
      terminationReason: null,
    },
    minutesAfterT0(1),
    "superseded during recovery",
  );
  assert.ok(terminated.ok);
  if (!terminated.ok) return;

  const secondAttempt = completeExecution(terminated.record, minutesAfterT0(2), { success: true, summary: "too late" });
  assert.equal(secondAttempt.ok, false);
  if (!secondAttempt.ok) assert.equal(secondAttempt.error.code, "execution_already_terminal");
});
