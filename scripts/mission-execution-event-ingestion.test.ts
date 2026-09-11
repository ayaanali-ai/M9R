/**
 * Provider event ingestion — Phase 4B
 *
 * Proves `RealExecutionHost.pollEvents` consumes `parseEvent` output DURING
 * actual execution (not only at completion), attaches Mission/participant/
 * assignment identity the adapter itself never knows, preserves the order
 * output arrived in, never re-emits an already-ingested event, never
 * fabricates a tool-call or session-start event for lines that don't
 * genuinely carry one, and behaves identically for Codex and Claude Code
 * except for their already-documented, honest capability differences.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { CodexProviderAdapter } from "../src/lib/mission/mission-provider-adapter-codex.ts";
import { ClaudeCodeProviderAdapter } from "../src/lib/mission/mission-provider-adapter-claude-code.ts";
import type { ProviderAdapter } from "../src/lib/mission/mission-provider-adapter.ts";
import { ProviderAdapterRegistry } from "../src/lib/mission/mission-provider-registry.ts";
import { InMemoryProcessExecutionHost } from "../src/lib/mission/mission-process-host.ts";
import { RealExecutionHost } from "../src/lib/mission/mission-real-execution-host.ts";
import { InMemoryMissionSchedulerStore, type InMemoryMissionRecord } from "../src/lib/mission/mission-scheduler-store.ts";
import { DEFAULT_SCHEDULER_POLICY, DISPATCHABLE_MISSION_STATES, type LeaseHolder } from "../src/lib/mission/mission-scheduler.ts";

const providers: { name: string; adapterId: string; factory: () => ProviderAdapter; resultLine: (text: string) => string; progressLine: () => string }[] = [
  {
    name: "Codex",
    adapterId: "codex",
    factory: () => new CodexProviderAdapter(),
    resultLine: (text) => JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }) + "\n",
    progressLine: () => JSON.stringify({ type: "item.completed", item: { type: "reasoning" } }) + "\n",
  },
  {
    name: "Claude Code",
    adapterId: "claude-code",
    factory: () => new ClaudeCodeProviderAdapter(),
    resultLine: (text) => JSON.stringify({ type: "result", result: text, is_error: false }) + "\n",
    progressLine: () => JSON.stringify({ type: "assistant" }) + "\n",
  },
];

const agentA: LeaseHolder = { kind: "agent", id: "agent-a" };
const T0 = "2026-08-05T00:00:00.000Z";

function missionRegistry(entries: Record<string, InMemoryMissionRecord>) {
  return new Map(Object.entries(entries));
}

async function setupHost(provider: (typeof providers)[number]) {
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
      {
        missionId: "m-1",
        workspaceId: "ws-1",
        dispatchKey: "primary",
        missionState: "ready",
        adapterRequirement: provider.adapterId,
        executionConstraints: { goal: "task", participantId: "p-1", assignmentId: "a-1" },
      },
    ],
    holder: agentA,
    now: T0,
    policy: DEFAULT_SCHEDULER_POLICY,
    dispatchableStates: DISPATCHABLE_MISSION_STATES,
  });

  const handle = await host.start(claimed.claimed[0].instruction);
  const outstanding = await store.listOutstandingDispatchIntents("ws-1");
  const persistableHandle = outstanding[0].processHandle;
  return { host, processHost, handle, persistableHandle };
}

for (const provider of providers) {
  test(`[${provider.name}] pollEvents ingests output DURING execution (before completion) and attaches Mission/participant/assignment identity`, async () => {
    const { host, processHost, handle, persistableHandle } = await setupHost(provider);

    processHost.appendEvents(persistableHandle as never, [{ sequence: 1, emittedAt: T0, raw: { kind: "output", stream: "stdout", text: provider.resultLine("hello") } }]);

    const events = await host.pollEvents(handle);
    assert.ok(events.length > 0, "at least one normalized event must be produced");
    for (const event of events) {
      assert.equal(event.executionId, handle.handleId);
      assert.equal(event.participantId, "p-1");
      assert.equal(event.assignmentId, "a-1");
    }
  });

  test(`[${provider.name}] pollEvents never re-emits an already-ingested event on a repeated call`, async () => {
    const { host, processHost, handle, persistableHandle } = await setupHost(provider);
    processHost.appendEvents(persistableHandle as never, [{ sequence: 1, emittedAt: T0, raw: { kind: "output", stream: "stdout", text: provider.resultLine("hello") } }]);

    const first = await host.pollEvents(handle);
    assert.ok(first.length > 0);
    const second = await host.pollEvents(handle);
    assert.deepEqual(second, [], "nothing new arrived since the last poll");
  });

  test(`[${provider.name}] pollEvents preserves the order output arrived in across multiple appends`, async () => {
    const { host, processHost, handle, persistableHandle } = await setupHost(provider);
    processHost.appendEvents(persistableHandle as never, [{ sequence: 1, emittedAt: T0, raw: { kind: "output", stream: "stdout", text: provider.progressLine() } }]);
    processHost.appendEvents(persistableHandle as never, [{ sequence: 2, emittedAt: T0, raw: { kind: "output", stream: "stdout", text: provider.resultLine("done") } }]);

    const events = await host.pollEvents(handle);
    assert.ok(events.length >= 2, "both appended chunks must be ingested in one poll");
    // The completion-shaped event must come after the progress-shaped one —
    // never reordered.
    const completedIndex = events.findIndex((e) => e.type === "provider.completed" || e.type === "provider.output");
    const progressIndex = events.findIndex((e) => e.type === "provider.progress");
    if (completedIndex !== -1 && progressIndex !== -1) assert.ok(progressIndex < completedIndex);
  });

  test(`[${provider.name}] a malformed / unparseable line never fabricates a provider event`, async () => {
    const { host, processHost, handle, persistableHandle } = await setupHost(provider);
    processHost.appendEvents(persistableHandle as never, [{ sequence: 1, emittedAt: T0, raw: { kind: "output", stream: "stdout", text: "not valid json at all {{{" } }]);

    const events = await host.pollEvents(handle);
    assert.deepEqual(events, [], "an unparseable line must produce zero events, never an invented one");
  });

  test(`[${provider.name}] no fabricated tool-call event for output that merely mentions tools in prose`, async () => {
    const { host, processHost, handle, persistableHandle } = await setupHost(provider);
    const text = provider.name === "Codex"
      ? JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "I will now run the test runner tool." } }) + "\n"
      : JSON.stringify({ type: "assistant", message: "I will now run the test runner tool." }) + "\n";
    processHost.appendEvents(persistableHandle as never, [{ sequence: 1, emittedAt: T0, raw: { kind: "output", stream: "stdout", text } }]);

    const events = await host.pollEvents(handle);
    assert.ok(events.every((e) => e.type !== "provider.tool_requested" && e.type !== "provider.tool_completed"));
  });
}

test("Codex CAN emit provider.session_started for a genuine thread.started line; Claude Code never does — an honest, documented capability difference, not a bug", async () => {
  const codex = await setupHost(providers[0]);
  codex.processHost.appendEvents(codex.persistableHandle as never, [{ sequence: 1, emittedAt: T0, raw: { kind: "output", stream: "stdout", text: JSON.stringify({ type: "thread.started", thread_id: "thread-1" }) + "\n" } }]);
  const codexEvents = await codex.host.pollEvents(codex.handle);
  assert.ok(codexEvents.some((e) => e.type === "provider.session_started"));

  const claude = await setupHost(providers[1]);
  claude.processHost.appendEvents(claude.persistableHandle as never, [{ sequence: 1, emittedAt: T0, raw: { kind: "output", stream: "stdout", text: JSON.stringify({ type: "assistant", session_id: "session-1" }) + "\n" } }]);
  const claudeEvents = await claude.host.pollEvents(claude.handle);
  assert.ok(claudeEvents.every((e) => e.type !== "provider.session_started"), "Claude Code's adapter never fabricates a session_started marker it has no reliable signal for");
});
