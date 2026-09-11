/**
 * RealExecutionHost — Phase 3B tests
 *
 * Exercised against `InMemoryProcessExecutionHost` and `FakeProviderAdapter`
 * (Phase 3A's fakes) plus a real `InMemoryMissionSchedulerStore`, proving the
 * composition itself: capability gating happens BEFORE anything is
 * prepared/launched, a successful launch persists its process handle via
 * `attachProcessHandle` (closing Phase 3A's recovery gap), `poll` returns
 * null while running and a real outcome once finished, and `cancel` reaches
 * the process host's `terminate`.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { RealExecutionHost } from "../src/lib/mission/mission-real-execution-host.ts";
import { InMemoryProcessExecutionHost } from "../src/lib/mission/mission-process-host.ts";
import { FakeProviderAdapter } from "../src/lib/mission/mission-provider-adapter.ts";
import { ProviderAdapterRegistry } from "../src/lib/mission/mission-provider-registry.ts";
import { InMemoryMissionSchedulerStore, type InMemoryMissionRecord } from "../src/lib/mission/mission-scheduler-store.ts";
import { DISPATCHABLE_MISSION_STATES, DEFAULT_SCHEDULER_POLICY, type LeaseHolder } from "../src/lib/mission/mission-scheduler.ts";

const agentA: LeaseHolder = { kind: "agent", id: "agent-a" };

function missionRegistry(entries: Record<string, InMemoryMissionRecord>) {
  return new Map(Object.entries(entries));
}

async function claimOne(store: InMemoryMissionSchedulerStore) {
  const result = await store.claimCandidates({
    candidates: [{ missionId: "m-1", workspaceId: "ws-1", dispatchKey: "primary", missionState: "ready", adapterRequirement: "codex" }],
    holder: agentA,
    now: "2026-07-29T00:00:00.000Z",
    policy: DEFAULT_SCHEDULER_POLICY,
    dispatchableStates: DISPATCHABLE_MISSION_STATES,
  });
  return result.claimed[0].instruction;
}

test("start rejects before launching anything when the adapter lacks a required capability", async () => {
  const store = new InMemoryMissionSchedulerStore(missionRegistry({ "m-1": { workspaceId: "ws-1", repositoryId: null } }));
  const processHost = new InMemoryProcessExecutionHost();
  const registry = new ProviderAdapterRegistry();
  registry.register(new FakeProviderAdapter("codex")); // declares nothing

  const host = new RealExecutionHost({
    processHost,
    registry,
    schedulerStore: store,
    repositoryRef: "C:/repos/app",
    requiredCapabilities: ["non_interactive_execution"],
  });

  const instruction = await claimOne(store);
  await assert.rejects(() => host.start(instruction), /unsupported_capability/);

  const outstanding = await store.listOutstandingDispatchIntents("ws-1");
  assert.equal(outstanding[0]?.processHandle, null, "nothing should have been launched or persisted when the capability check failed");
});

test("start persists the launched process handle via attachProcessHandle", async () => {
  const store = new InMemoryMissionSchedulerStore(missionRegistry({ "m-1": { workspaceId: "ws-1", repositoryId: null } }));
  const processHost = new InMemoryProcessExecutionHost();
  const registry = new ProviderAdapterRegistry();
  registry.register(new FakeProviderAdapter("codex", { non_interactive_execution: true }));

  const host = new RealExecutionHost({
    processHost,
    registry,
    schedulerStore: store,
    repositoryRef: "C:/repos/app",
    requiredCapabilities: ["non_interactive_execution"],
  });

  const instruction = await claimOne(store);
  await host.start(instruction);

  const outstanding = await store.listOutstandingDispatchIntents("ws-1");
  assert.ok(outstanding[0]?.processHandle, "the launched process handle must be persisted, not only held in memory");
});

test("poll returns null while running, then a normalized outcome once the host reports completion", async () => {
  const store = new InMemoryMissionSchedulerStore(missionRegistry({ "m-1": { workspaceId: "ws-1", repositoryId: null } }));
  const processHost = new InMemoryProcessExecutionHost();
  const registry = new ProviderAdapterRegistry();
  registry.register(new FakeProviderAdapter("codex", { non_interactive_execution: true }));

  const host = new RealExecutionHost({
    processHost,
    registry,
    schedulerStore: store,
    repositoryRef: "C:/repos/app",
    requiredCapabilities: ["non_interactive_execution"],
  });

  const instruction = await claimOne(store);
  const handle = await host.start(instruction);

  assert.equal(await host.poll(handle), null, "must not report an outcome while the process host has no exit code yet");

  const outstanding = await store.listOutstandingDispatchIntents("ws-1");
  const persistedHandle = outstanding[0]?.processHandle;
  assert.ok(persistedHandle);
  processHost.setExitCode(persistedHandle as never, 0, [{ sequence: 1, emittedAt: "2026-07-29T00:00:01.000Z", raw: { kind: "output", text: "done" } }]);

  const outcome = await host.poll(handle);
  assert.ok(outcome);
  assert.equal(outcome?.success, true);
});

test("start refuses to launch when the fence goes stale DURING preparation, not just before entry", async () => {
  // A real audit finding: `start` validated the fence once at entry, then
  // did capability discovery / environment prep / invocation prep, then
  // launched WITHOUT rechecking. Simulate a claim on the same slot expiring
  // and being superseded by a later claim while our adapter's
  // `prepareInvocation` is still "in flight" — the exact race window that
  // existed between entry and launch.
  const store = new InMemoryMissionSchedulerStore(missionRegistry({ "m-1": { workspaceId: "ws-1", repositoryId: null } }));
  const processHost = new InMemoryProcessExecutionHost();
  const registry = new ProviderAdapterRegistry();

  class RaceAdapter extends FakeProviderAdapter {
    async prepareInvocation(assignment: Parameters<FakeProviderAdapter["prepareInvocation"]>[0], environment: Parameters<FakeProviderAdapter["prepareInvocation"]>[1]) {
      // Supersede the in-flight instruction's lease by claiming the SAME
      // slot again well after the original lease's expiry — a fresh
      // generation, a new (higher) fencingToken, exactly what a slow
      // preparation step racing a lease renewal/expiry looks like.
      await store.claimCandidates({
        candidates: [{ missionId: "m-1", workspaceId: "ws-1", dispatchKey: "primary", missionState: "ready", adapterRequirement: "codex" }],
        holder: { kind: "agent", id: "agent-b" },
        now: "2026-07-29T00:06:00.000Z", // 6 minutes later — past DEFAULT_SCHEDULER_POLICY's 5-minute lease
        policy: DEFAULT_SCHEDULER_POLICY,
        dispatchableStates: DISPATCHABLE_MISSION_STATES,
      });
      return super.prepareInvocation(assignment, environment);
    }
  }
  registry.register(new RaceAdapter("codex", { non_interactive_execution: true }));

  const host = new RealExecutionHost({
    processHost,
    registry,
    schedulerStore: store,
    repositoryRef: "C:/repos/app",
    requiredCapabilities: ["non_interactive_execution"],
  });

  const instruction = await claimOne(store);
  await assert.rejects(() => host.start(instruction), /fencing token became stale during preparation/);

  const outstanding = await store.listOutstandingDispatchIntents("ws-1");
  assert.equal(outstanding.length, 1, "only the SUPERSEDING claim's intent should exist — the stale one never got a launched process to persist a handle for");
  assert.equal(outstanding[0]?.processHandle, null, "the superseded instruction must never have reached processHost.launch");
});

test("start terminates the just-launched process and never leaves it tracked when persisting its handle fails", async () => {
  // A real audit finding: the process launches, THEN its handle is
  // persisted. If persistence throws, a prior version of `start` had
  // already returned past `launch` with nothing recorded locally — an
  // orphaned, running, untracked child. Fixed by tracking before the
  // persistence call and terminating + untracking on failure.
  const store = new InMemoryMissionSchedulerStore(missionRegistry({ "m-1": { workspaceId: "ws-1", repositoryId: null } }));
  const baseProcessHost = new InMemoryProcessExecutionHost();
  let capturedHandle: Awaited<ReturnType<InMemoryProcessExecutionHost["launch"]>> | null = null;
  const processHost: InMemoryProcessExecutionHost = new Proxy(baseProcessHost, {
    get(target, prop, receiver) {
      if (prop === "launch") {
        return async (...args: Parameters<InMemoryProcessExecutionHost["launch"]>) => {
          const handle = await target.launch(...args);
          capturedHandle = handle;
          return handle;
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  const registry = new ProviderAdapterRegistry();
  registry.register(new FakeProviderAdapter("codex", { non_interactive_execution: true }));

  const failingStore: InMemoryMissionSchedulerStore = new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "attachProcessHandle") {
        return async () => {
          throw new Error("simulated persistence failure");
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  const host = new RealExecutionHost({
    processHost,
    registry,
    schedulerStore: failingStore,
    repositoryRef: "C:/repos/app",
    requiredCapabilities: ["non_interactive_execution"],
  });

  const instruction = await claimOne(store);
  await assert.rejects(() => host.start(instruction), /simulated persistence failure/);

  assert.ok(capturedHandle, "the process must actually have been launched for this scenario to be meaningful");
  const status = await baseProcessHost.inspect(capturedHandle!);
  assert.equal(status.kind, "process_confirmed_dead", "a launched process whose handle failed to persist must be terminated, never left running and untracked");
});

test("cancel reaches the process host's terminate", async () => {
  const store = new InMemoryMissionSchedulerStore(missionRegistry({ "m-1": { workspaceId: "ws-1", repositoryId: null } }));
  const processHost = new InMemoryProcessExecutionHost();
  const registry = new ProviderAdapterRegistry();
  registry.register(new FakeProviderAdapter("codex", { non_interactive_execution: true }));

  const host = new RealExecutionHost({
    processHost,
    registry,
    schedulerStore: store,
    repositoryRef: "C:/repos/app",
    requiredCapabilities: ["non_interactive_execution"],
  });

  const instruction = await claimOne(store);
  const handle = await host.start(instruction);
  await host.cancel(handle);

  const outstanding = await store.listOutstandingDispatchIntents("ws-1");
  const persistedHandle = outstanding[0]?.processHandle as { executionId: string } | null;
  assert.ok(persistedHandle);
  const status = await processHost.inspect(persistedHandle as never);
  assert.equal(status.kind, "process_confirmed_dead");
});
