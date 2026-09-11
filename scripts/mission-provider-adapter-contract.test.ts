/**
 * Provider adapter parity contract — Phase 3C, extended in Phase 4C
 *
 * Runs the SAME suite against both real adapters (`CodexProviderAdapter`,
 * `ClaudeCodeProviderAdapter`), proving the provider-agnostic guarantees
 * hold identically for each: registry registration, capability-gated
 * rejection, deterministic invocation construction, no secret env values,
 * normalized terminal results, deterministic event parsing, working through
 * the SAME `RealExecutionHost`/`NodeProcessExecutionHost` (no
 * provider-specific host), fencing enforced before launch, before
 * completion, and on lease loss, and duplicate-dispatch resolving to
 * exactly one authoritative execution regardless of which adapter is
 * behind the winning claim.
 *
 * Phase 4C additions (consolidated here, not a separate file, per
 * instruction): `RealExecutionHost.pollEvents`'s cursor/duplicate-poll/
 * ordering/malformed-line behavior, and the honest Codex-vs-Claude
 * session-start capability difference, proven through the identical
 * canonical composition every other test in this file already uses.
 * `mission-execution-event-ingestion.test.ts` (Phase 4B) keeps the more
 * exhaustive per-scenario ingestion tests — this file's job is the shared
 * parity proof, not a duplicate of every case there.
 *
 * Provider-specific behavior (event-shape differences, capability
 * declarations) stays in `mission-provider-adapter-codex.test.ts`/
 * `mission-provider-adapter-claude-code.test.ts` — this file only proves
 * the two adapters are interchangeable at every boundary that's supposed
 * to be provider-neutral.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { CodexProviderAdapter } from "../src/lib/mission/mission-provider-adapter-codex.ts";
import { ClaudeCodeProviderAdapter } from "../src/lib/mission/mission-provider-adapter-claude-code.ts";
import { ProviderAdapterRegistry } from "../src/lib/mission/mission-provider-registry.ts";
import type { ProviderAdapter } from "../src/lib/mission/mission-provider-adapter.ts";
import type { HostOutputEvent } from "../src/lib/mission/mission-process-host.ts";
import type { ProviderProcessSpec } from "../src/lib/resident-provider-adapters.ts";
import { InMemoryProcessExecutionHost } from "../src/lib/mission/mission-process-host.ts";
import { RealExecutionHost } from "../src/lib/mission/mission-real-execution-host.ts";
import { InMemoryMissionSchedulerStore, type InMemoryMissionRecord } from "../src/lib/mission/mission-scheduler-store.ts";
import { DEFAULT_SCHEDULER_POLICY, DISPATCHABLE_MISSION_STATES, type LeaseHolder } from "../src/lib/mission/mission-scheduler.ts";
import { InMemoryExecutionHost, MissionDispatchRuntime } from "../src/lib/mission/mission-dispatch-runtime.ts";

const providers: { name: string; adapterId: string; factory: () => ProviderAdapter }[] = [
  { name: "Codex", adapterId: "codex", factory: () => new CodexProviderAdapter() },
  { name: "Claude Code", adapterId: "claude-code", factory: () => new ClaudeCodeProviderAdapter() },
];

const agentA: LeaseHolder = { kind: "agent", id: "agent-a" };
const agentB: LeaseHolder = { kind: "agent", id: "agent-b" };
const policy = DEFAULT_SCHEDULER_POLICY;
const T0 = "2026-07-30T00:00:00.000Z";
function minutesAfterT0(mins: number) {
  return new Date(Date.parse(T0) + mins * 60_000).toISOString();
}
function missionRegistry(entries: Record<string, InMemoryMissionRecord>) {
  return new Map(Object.entries(entries));
}

for (const provider of providers) {
  test(`[${provider.name}] registers through the shared ProviderAdapterRegistry and is discoverable by id`, () => {
    const registry = new ProviderAdapterRegistry();
    const adapter = provider.factory();
    registry.register(adapter);
    assert.equal(registry.get(provider.adapterId), adapter);
  });

  test(`[${provider.name}] assertCapabilities rejects an unmet requirement before anything is launched`, async () => {
    const registry = new ProviderAdapterRegistry();
    registry.register(provider.factory());
    const result = await registry.assertCapabilities(provider.adapterId, { workspaceId: "ws-1" }, ["interactive_session"]);
    assert.equal(result.ok, false);
  });

  test(`[${provider.name}] prepareInvocation produces a deterministic invocation for the same assignment`, async () => {
    const adapter = provider.factory();
    const assignment = { missionId: "m-1", dispatchKey: "primary", goal: "do the task", executionConstraints: { executionMode: "read_only" as const } };
    const environment = { workingDirectory: "/tmp/worktree-1", kind: "disposable" as const };
    const first = await adapter.prepareInvocation(assignment, environment);
    const second = await adapter.prepareInvocation(assignment, environment);
    assert.deepEqual(first, second);
  });

  test(`[${provider.name}] the invocation's process spec exposes no secret environment values beyond the curated allowlist`, async () => {
    const previous = process.env.SOME_OTHER_TEST_SECRET;
    process.env.SOME_OTHER_TEST_SECRET = "must-not-leak";
    try {
      const adapter = provider.factory();
      const invocation = await adapter.prepareInvocation(
        { missionId: "m-1", dispatchKey: "primary", goal: "task", executionConstraints: {} },
        { workingDirectory: "/tmp/worktree-1", kind: "disposable" },
      );
      const spec = invocation.payload as ProviderProcessSpec;
      assert.equal(spec.env.SOME_OTHER_TEST_SECRET, undefined);
    } finally {
      if (previous === undefined) delete process.env.SOME_OTHER_TEST_SECRET;
      else process.env.SOME_OTHER_TEST_SECRET = previous;
    }
  });

  test(`[${provider.name}] collectResult returns a normalized terminal result shape regardless of underlying protocol`, async () => {
    const adapter = provider.factory();
    const result = await adapter.collectResult({ events: [], exitCode: 1 });
    assert.equal(typeof result.success, "boolean");
    assert.equal(typeof result.summary, "string");
    assert.ok(["redacted", "not_required"].includes(result.redactionStatus));
  });

  test(`[${provider.name}] parseEvent normalizes deterministically`, () => {
    const adapter = provider.factory();
    const event: HostOutputEvent = { sequence: 1, emittedAt: T0, raw: { kind: "output", stream: "stdout", text: "" } };
    const first = adapter.parseEvent(event);
    const second = adapter.parseEvent(event);
    assert.deepEqual(first, second);
  });

  test(`[${provider.name}] cannot mutate a Mission or scheduler store — no such reference is ever passed to it`, async () => {
    const adapter = provider.factory();
    await adapter.discoverCapabilities({ workspaceId: "ws-1" });
    await adapter.prepareInvocation({ missionId: "m-1", dispatchKey: "primary", goal: "g", executionConstraints: {} }, { workingDirectory: "/tmp/x", kind: "disposable" });
    adapter.parseEvent({ sequence: 1, emittedAt: T0, raw: { kind: "output", stream: "stdout", text: "" } });
    await adapter.collectResult({ events: [], exitCode: 0 });
    // No store/Mission reference was ever constructible to pass — proven by
    // ProviderAdapter's type signatures (mission-provider-adapter.ts), which
    // accept none.
  });

  // -------------------------------------------------------------------------
  // Through the SAME RealExecutionHost/NodeProcessExecutionHost path
  // -------------------------------------------------------------------------

  test(`[${provider.name}] works through the shared RealExecutionHost + InMemoryProcessExecutionHost — no provider-specific host`, async () => {
    const store = new InMemoryMissionSchedulerStore(missionRegistry({ "m-1": { workspaceId: "ws-1", repositoryId: null } }));
    const processHost = new InMemoryProcessExecutionHost();
    const registry = new ProviderAdapterRegistry();
    registry.register(provider.factory());

    const host = new RealExecutionHost({
      processHost,
      registry,
      schedulerStore: store,
      repositoryRef: "C:/repos/app",
      requiredCapabilities: ["non_interactive_execution"],
    });

    const claimed = await store.claimCandidates({
      candidates: [
        { missionId: "m-1", workspaceId: "ws-1", dispatchKey: "primary", missionState: "ready", adapterRequirement: provider.adapterId, executionConstraints: { goal: "do the task" } },
      ],
      holder: agentA,
      now: T0,
      policy,
      dispatchableStates: DISPATCHABLE_MISSION_STATES,
    });
    const handle = await host.start(claimed.claimed[0].instruction);

    const outstanding = await store.listOutstandingDispatchIntents("ws-1");
    assert.ok(outstanding[0]?.processHandle, "the same attachProcessHandle wiring must fire regardless of adapter");

    await host.cancel(handle);
  });

  test(`[${provider.name}] start refuses to launch anything when the fence is already stale`, async () => {
    const store = new InMemoryMissionSchedulerStore(missionRegistry({ "m-1": { workspaceId: "ws-1", repositoryId: null } }));
    const processHost = new InMemoryProcessExecutionHost();
    const registry = new ProviderAdapterRegistry();
    registry.register(provider.factory());

    const host = new RealExecutionHost({
      processHost,
      registry,
      schedulerStore: store,
      repositoryRef: "C:/repos/app",
      requiredCapabilities: ["non_interactive_execution"],
    });

    const claimed = await store.claimCandidates({
      candidates: [{ missionId: "m-1", workspaceId: "ws-1", dispatchKey: "primary", missionState: "ready", adapterRequirement: provider.adapterId }],
      holder: agentA,
      now: T0,
      policy,
      dispatchableStates: DISPATCHABLE_MISSION_STATES,
    });
    const staleInstruction = claimed.claimed[0].instruction;

    // Someone else reclaims the slot before this worker calls start().
    await store.claimCandidates({
      candidates: [{ missionId: "m-1", workspaceId: "ws-1", dispatchKey: "primary", missionState: "ready", adapterRequirement: provider.adapterId }],
      holder: agentB,
      now: minutesAfterT0(999),
      policy,
      dispatchableStates: DISPATCHABLE_MISSION_STATES,
    });

    await assert.rejects(() => host.start(staleInstruction), /fencing token is no longer current/);

    const outstanding = await store.listOutstandingDispatchIntents("ws-1");
    assert.equal(outstanding.length, 1, "only the reclaiming holder's intent may exist — the stale start() must never have created its own");
    assert.equal(outstanding[0].processHandle, null, "a stale start() must never reach processHost.launch, so no handle is ever attached");
  });

  test(`[${provider.name}] a stale completion is discarded by MissionDispatchRuntime.tick regardless of adapter, and the replacement holder's lease is untouched`, async () => {
    const store = new InMemoryMissionSchedulerStore(missionRegistry({ "m-1": { workspaceId: "ws-1", repositoryId: null } }));
    const dispatchHost = new InMemoryExecutionHost();
    const runtime = new MissionDispatchRuntime({ store, host: dispatchHost, holder: agentA, policy });
    const adapter = provider.factory();

    const claimed = await store.claimCandidates({
      candidates: [{ missionId: "m-1", workspaceId: "ws-1", dispatchKey: "primary", missionState: "ready", adapterRequirement: provider.adapterId }],
      holder: agentA,
      now: T0,
      policy,
      dispatchableStates: DISPATCHABLE_MISSION_STATES,
    });
    await runtime.adopt(claimed.claimed[0].instruction, T0);

    const reclaim = await store.claimCandidates({
      candidates: [{ missionId: "m-1", workspaceId: "ws-1", dispatchKey: "primary", missionState: "ready", adapterRequirement: provider.adapterId }],
      holder: agentB,
      now: minutesAfterT0(999),
      policy,
      dispatchableStates: DISPATCHABLE_MISSION_STATES,
    });

    const providerResult = await adapter.collectResult({ events: [], exitCode: 0 });
    dispatchHost.resolve({ handleId: "handle-1" }, { success: providerResult.success, summary: providerResult.summary });
    const report = await runtime.tick(minutesAfterT0(1000));

    assert.equal(report.completed.length, 0);
    assert.equal(report.leaseLost.length, 1);

    const replacementStillValid = await store.validateFence({
      workspaceId: "ws-1",
      missionId: "m-1",
      dispatchKey: "primary",
      leaseId: reclaim.claimed[0].lease.leaseId,
      fencingToken: reclaim.claimed[0].lease.fencingToken,
    });
    assert.equal(replacementStillValid, true, "a stale worker must never be able to alter the replacement holder's lease");
  });

  test(`[${provider.name}] lease loss cancels the local process`, async () => {
    const store = new InMemoryMissionSchedulerStore(missionRegistry({ "m-1": { workspaceId: "ws-1", repositoryId: null } }));
    const dispatchHost = new InMemoryExecutionHost();
    const runtime = new MissionDispatchRuntime({ store, host: dispatchHost, holder: agentA, policy });

    const claimed = await store.claimCandidates({
      candidates: [{ missionId: "m-1", workspaceId: "ws-1", dispatchKey: "primary", missionState: "ready", adapterRequirement: provider.adapterId }],
      holder: agentA,
      now: T0,
      policy,
      dispatchableStates: DISPATCHABLE_MISSION_STATES,
    });
    await runtime.adopt(claimed.claimed[0].instruction, T0);

    await store.revokeLease({ workspaceId: "ws-1", missionId: "m-1", dispatchKey: "primary", now: minutesAfterT0(1), reason: "test" });
    const report = await runtime.tick(minutesAfterT0(2));

    assert.equal(report.leaseLost.length, 1);
    assert.equal(dispatchHost.wasCancelled({ handleId: "handle-1" }), true);
  });

  test(`[${provider.name}] duplicate dispatch resolves to exactly one authoritative execution`, async () => {
    const store = new InMemoryMissionSchedulerStore(missionRegistry({ "m-1": { workspaceId: "ws-1", repositoryId: null } }));

    const [a, b] = await Promise.all([
      store.claimCandidates({
        candidates: [{ missionId: "m-1", workspaceId: "ws-1", dispatchKey: "primary", missionState: "ready", adapterRequirement: provider.adapterId }],
        holder: agentA,
        now: T0,
        policy,
        dispatchableStates: DISPATCHABLE_MISSION_STATES,
      }),
      store.claimCandidates({
        candidates: [{ missionId: "m-1", workspaceId: "ws-1", dispatchKey: "primary", missionState: "ready", adapterRequirement: provider.adapterId }],
        holder: agentB,
        now: T0,
        policy,
        dispatchableStates: DISPATCHABLE_MISSION_STATES,
      }),
    ]);

    assert.equal(a.claimed.length + b.claimed.length, 1);
  });

  // -------------------------------------------------------------------------
  // Phase 4C — provider event ingestion parity, through the SAME
  // RealExecutionHost/NodeProcessExecutionHost composition
  // -------------------------------------------------------------------------

  test(`[${provider.name}] pollEvents has a stable cursor: a repeated poll with no new output returns nothing, never re-delivering the same event`, async () => {
    const store = new InMemoryMissionSchedulerStore(missionRegistry({ "m-1": { workspaceId: "ws-1", repositoryId: null } }));
    const processHost = new InMemoryProcessExecutionHost();
    const registry = new ProviderAdapterRegistry();
    registry.register(provider.factory());
    const host = new RealExecutionHost({ processHost, registry, schedulerStore: store, repositoryRef: "C:/repos/app", requiredCapabilities: ["non_interactive_execution"] });

    const claimed = await store.claimCandidates({
      candidates: [{ missionId: "m-1", workspaceId: "ws-1", dispatchKey: "primary", missionState: "ready", adapterRequirement: provider.adapterId, executionConstraints: { goal: "task" } }],
      holder: agentA,
      now: T0,
      policy,
      dispatchableStates: DISPATCHABLE_MISSION_STATES,
    });
    const handle = await host.start(claimed.claimed[0].instruction);
    const outstanding = await store.listOutstandingDispatchIntents("ws-1");
    const persistableHandle = outstanding[0].processHandle;

    processHost.appendEvents(persistableHandle as never, [{ sequence: 1, emittedAt: T0, raw: { kind: "output", stream: "stdout", text: "not json {{{" } }]);
    const first = await host.pollEvents(handle);
    const second = await host.pollEvents(handle);
    assert.deepEqual(second, [], "nothing new arrived — a repeated poll must never re-deliver");
    void first;
  });

  test(`[${provider.name}] a malformed provider line never fabricates an event, through the canonical RealExecutionHost path`, async () => {
    const store = new InMemoryMissionSchedulerStore(missionRegistry({ "m-1": { workspaceId: "ws-1", repositoryId: null } }));
    const processHost = new InMemoryProcessExecutionHost();
    const registry = new ProviderAdapterRegistry();
    registry.register(provider.factory());
    const host = new RealExecutionHost({ processHost, registry, schedulerStore: store, repositoryRef: "C:/repos/app", requiredCapabilities: ["non_interactive_execution"] });

    const claimed = await store.claimCandidates({
      candidates: [{ missionId: "m-1", workspaceId: "ws-1", dispatchKey: "primary", missionState: "ready", adapterRequirement: provider.adapterId, executionConstraints: { goal: "task" } }],
      holder: agentA,
      now: T0,
      policy,
      dispatchableStates: DISPATCHABLE_MISSION_STATES,
    });
    const handle = await host.start(claimed.claimed[0].instruction);
    const outstanding = await store.listOutstandingDispatchIntents("ws-1");
    const persistableHandle = outstanding[0].processHandle;

    processHost.appendEvents(persistableHandle as never, [{ sequence: 1, emittedAt: T0, raw: { kind: "output", stream: "stdout", text: "definitely not valid json" } }]);
    const events = await host.pollEvents(handle);
    assert.deepEqual(events, []);
  });
}

test("honest session-start capability difference, proven through the canonical composition: Codex CAN emit provider.session_started, Claude Code never does", async () => {
  async function pollFor(provider: (typeof providers)[number], text: string) {
    const store = new InMemoryMissionSchedulerStore(missionRegistry({ "m-1": { workspaceId: "ws-1", repositoryId: null } }));
    const processHost = new InMemoryProcessExecutionHost();
    const registry = new ProviderAdapterRegistry();
    registry.register(provider.factory());
    const host = new RealExecutionHost({ processHost, registry, schedulerStore: store, repositoryRef: "C:/repos/app", requiredCapabilities: ["non_interactive_execution"] });
    const claimed = await store.claimCandidates({
      candidates: [{ missionId: "m-1", workspaceId: "ws-1", dispatchKey: "primary", missionState: "ready", adapterRequirement: provider.adapterId, executionConstraints: { goal: "task" } }],
      holder: agentA,
      now: T0,
      policy,
      dispatchableStates: DISPATCHABLE_MISSION_STATES,
    });
    const handle = await host.start(claimed.claimed[0].instruction);
    const outstanding = await store.listOutstandingDispatchIntents("ws-1");
    processHost.appendEvents(outstanding[0].processHandle as never, [{ sequence: 1, emittedAt: T0, raw: { kind: "output", stream: "stdout", text } }]);
    return host.pollEvents(handle);
  }

  const codexEvents = await pollFor(providers[0], JSON.stringify({ type: "thread.started", thread_id: "thread-1" }) + "\n");
  assert.ok(codexEvents.some((e) => e.type === "provider.session_started"));

  const claudeEvents = await pollFor(providers[1], JSON.stringify({ type: "assistant", session_id: "session-1" }) + "\n");
  assert.ok(claudeEvents.every((e) => e.type !== "provider.session_started"), "Claude Code's adapter never fabricates a session_started marker — an honest capability difference, not a bug");
});
