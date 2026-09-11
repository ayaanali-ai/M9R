/**
 * Mission collaboration — execution integration (Phase 4A)
 *
 * Proves participant/assignment identity reaches `RealExecutionHost.start`'s
 * constructed `ProviderAssignment` via the same opaque `executionConstraints`
 * bag every other adapter-specific field already rides — no new dispatch
 * schema, no second lease/worktree/process system. Run parametrized over
 * both `CodexProviderAdapter` and `ClaudeCodeProviderAdapter` to prove
 * identical coordination behavior for both providers, matching Phase 3C's
 * parity-suite pattern.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { CodexProviderAdapter } from "../src/lib/mission/mission-provider-adapter-codex.ts";
import { ClaudeCodeProviderAdapter } from "../src/lib/mission/mission-provider-adapter-claude-code.ts";
import type { ProviderAdapter, ProviderAssignment } from "../src/lib/mission/mission-provider-adapter.ts";
import { ProviderAdapterRegistry } from "../src/lib/mission/mission-provider-registry.ts";
import { InMemoryProcessExecutionHost } from "../src/lib/mission/mission-process-host.ts";
import { RealExecutionHost } from "../src/lib/mission/mission-real-execution-host.ts";
import { InMemoryMissionSchedulerStore, type InMemoryMissionRecord } from "../src/lib/mission/mission-scheduler-store.ts";
import { DEFAULT_SCHEDULER_POLICY, DISPATCHABLE_MISSION_STATES, type LeaseHolder } from "../src/lib/mission/mission-scheduler.ts";

const providers: { name: string; adapterId: string; factory: () => ProviderAdapter }[] = [
  { name: "Codex", adapterId: "codex", factory: () => new CodexProviderAdapter() },
  { name: "Claude Code", adapterId: "claude-code", factory: () => new ClaudeCodeProviderAdapter() },
];

const agentA: LeaseHolder = { kind: "agent", id: "agent-a" };
const T0 = "2026-08-01T00:00:00.000Z";

function missionRegistry(entries: Record<string, InMemoryMissionRecord>) {
  return new Map(Object.entries(entries));
}

for (const provider of providers) {
  test(`[${provider.name}] assignment and participant identity set on a dispatch reach RealExecutionHost's constructed ProviderAssignment`, async () => {
    const store = new InMemoryMissionSchedulerStore(missionRegistry({ "m-1": { workspaceId: "ws-1", repositoryId: null } }));
    const processHost = new InMemoryProcessExecutionHost();
    const registry = new ProviderAdapterRegistry();

    let capturedAssignment: ProviderAssignment | null = null;
    class SpyAdapter implements ProviderAdapter {
      private readonly inner: ProviderAdapter;
      readonly id: string;
      constructor(inner: ProviderAdapter) {
        this.inner = inner;
        this.id = inner.id;
      }
      discoverCapabilities(context: Parameters<ProviderAdapter["discoverCapabilities"]>[0]) {
        return this.inner.discoverCapabilities(context);
      }
      async prepareInvocation(assignment: ProviderAssignment, environment: Parameters<ProviderAdapter["prepareInvocation"]>[1]) {
        capturedAssignment = assignment;
        return this.inner.prepareInvocation(assignment, environment);
      }
      parseEvent(event: Parameters<ProviderAdapter["parseEvent"]>[0]) {
        return this.inner.parseEvent(event);
      }
      collectResult(output: Parameters<ProviderAdapter["collectResult"]>[0]) {
        return this.inner.collectResult(output);
      }
    }
    registry.register(new SpyAdapter(provider.factory()));

    const host = new RealExecutionHost({
      processHost,
      registry,
      schedulerStore: store,
      repositoryRef: "C:/repos/app",
      requiredCapabilities: ["non_interactive_execution"],
    });

    const claimed = await store.claimCandidates({
      candidates: [
        {
          missionId: "m-1",
          workspaceId: "ws-1",
          dispatchKey: "primary",
          missionState: "ready",
          adapterRequirement: provider.adapterId,
          executionConstraints: { goal: "implement the fix", participantId: "p-1", assignmentId: "a-1" },
        },
      ],
      holder: agentA,
      now: T0,
      policy: DEFAULT_SCHEDULER_POLICY,
      dispatchableStates: DISPATCHABLE_MISSION_STATES,
    });

    await host.start(claimed.claimed[0].instruction);

    if (capturedAssignment === null) throw new Error("prepareInvocation must have been called");
    const assignment: ProviderAssignment = capturedAssignment;
    assert.equal(assignment.participantId, "p-1");
    assert.equal(assignment.assignmentId, "a-1");
    assert.equal(assignment.missionId, "m-1");
  });

  test(`[${provider.name}] a dispatch with no participant/assignment metadata leaves both null, never fabricated`, async () => {
    const store = new InMemoryMissionSchedulerStore(missionRegistry({ "m-1": { workspaceId: "ws-1", repositoryId: null } }));
    const processHost = new InMemoryProcessExecutionHost();
    const registry = new ProviderAdapterRegistry();

    const captured: { assignment: ProviderAssignment | null } = { assignment: null };
    const inner = provider.factory();
    const spy: ProviderAdapter = {
      id: inner.id,
      discoverCapabilities: (c) => inner.discoverCapabilities(c),
      prepareInvocation: async (assignment, environment) => {
        captured.assignment = assignment;
        return inner.prepareInvocation(assignment, environment);
      },
      parseEvent: (e) => inner.parseEvent(e),
      collectResult: (o) => inner.collectResult(o),
    };
    registry.register(spy);

    const host = new RealExecutionHost({
      processHost,
      registry,
      schedulerStore: store,
      repositoryRef: "C:/repos/app",
      requiredCapabilities: ["non_interactive_execution"],
    });

    const claimed = await store.claimCandidates({
      candidates: [
        { missionId: "m-1", workspaceId: "ws-1", dispatchKey: "primary", missionState: "ready", adapterRequirement: provider.adapterId, executionConstraints: { goal: "task" } },
      ],
      holder: agentA,
      now: T0,
      policy: DEFAULT_SCHEDULER_POLICY,
      dispatchableStates: DISPATCHABLE_MISSION_STATES,
    });

    await host.start(claimed.claimed[0].instruction);

    assert.equal(captured.assignment?.participantId, null);
    assert.equal(captured.assignment?.assignmentId, null);
  });
}
