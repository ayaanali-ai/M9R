import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryMissionRuntimeEventJournal, normalizeMissionRuntimeEvent } from "@/lib/mission/mission-runtime-event";
import { InMemoryMissionRuntimeActivityRelay } from "@/lib/mission/mission-runtime-activity-relay";
import { MissionAcceptedResultService } from "@/lib/mission/mission-accepted-result-service";
import { MissionCollaborationResultBridge } from "@/lib/mission/mission-collaboration-result-bridge";
import { buildCollaborationCommands, parseCollaborationDirectives } from "@/lib/mission/mission-collaboration-bridge";
import { InMemoryExecutionHost, MissionDispatchRuntime, type ExecutionHandle } from "@/lib/mission/mission-dispatch-runtime";
import { InMemoryMissionSchedulerStore } from "@/lib/mission/mission-scheduler-store";
import { DEFAULT_SCHEDULER_POLICY, DISPATCHABLE_MISSION_STATES, type LeaseHolder } from "@/lib/mission/mission-scheduler";
import type { DispatchInstruction } from "@/lib/mission/mission-scheduler-store";
import type { ProviderEvent } from "@/lib/mission/mission-provider-adapter";
import type { MissionExecutionResultStore } from "@/lib/mission/mission-execution-result-store";

const now = "2026-07-31T00:00:00.000Z";
const holder: LeaseHolder = { kind: "system", id: "scheduler" };

function missionStore() {
  return new InMemoryMissionSchedulerStore(new Map([["mission-1", { workspaceId: "workspace-1", repositoryId: null }]]), () => "lease-1");
}

async function instructionFrom(store: InMemoryMissionSchedulerStore): Promise<DispatchInstruction> {
  const result = await store.claimCandidates({
    holder,
    now,
    policy: { ...DEFAULT_SCHEDULER_POLICY, leaseDurationMs: 60_000, renewalWindowMs: 30_000, maxConcurrentLeasesPerWorkspace: 2 },
    dispatchableStates: DISPATCHABLE_MISSION_STATES,
    candidates: [{ workspaceId: "workspace-1", missionId: "mission-1", repositoryId: null, missionState: "ready", assignmentId: "assignment-1", dispatchKey: "primary", adapterRequirement: "codex", executionConstraints: { goal: "Inspect the bounded task.", participantId: "agent-1", assignmentId: "assignment-1" } }],
  });
  assert.equal(result.claimed.length, 1);
  return result.claimed[0].instruction;
}

class EventHost extends InMemoryExecutionHost {
  startedInstruction: DispatchInstruction | null = null;
  events: ProviderEvent[] = [];

  async start(instruction?: DispatchInstruction): Promise<ExecutionHandle> {
    this.startedInstruction = instruction ?? null;
    return super.start();
  }

  async pollEvents(): Promise<ProviderEvent[]> {
    const events = this.events;
    this.events = [];
    return events;
  }
}

test("runtime consumes bounded provider events, accepts terminal results, injects pending context, and routes directives", async () => {
  const store = missionStore();
  const instruction = await instructionFrom(store);
  const host = new EventHost();
  const journal = new InMemoryMissionRuntimeEventJournal();
  const relay = new InMemoryMissionRuntimeActivityRelay();
  const liveActivityIds: string[] = [];
  relay.subscribe((activity) => { liveActivityIds.push(activity.activityId); });
  const accepted: string[] = [];
  const commands: string[] = [];
  const boundary = {
    async accept(input: { resultKind: string; execution: { executionId: string } }) {
      accepted.push(`${input.resultKind}:${input.execution.executionId}`);
      return { ok: true as const, duplicate: false, acceptedResultId: `${input.resultKind}-1`, applicationStatus: "pending" as const };
    },
  };
  const collaboration = new MissionCollaborationResultBridge({
    run: async ({ command }) => { commands.push(command.type); return { ok: true }; },
  });
  const runtime = new MissionDispatchRuntime({
    store,
    host,
    holder,
    policy: { ...DEFAULT_SCHEDULER_POLICY, leaseDurationMs: 60_000, renewalWindowMs: 30_000, maxConcurrentLeasesPerWorkspace: 2 },
    runtimeEventJournal: journal,
    runtimeActivityRelay: relay,
    acceptedResultBoundary: boundary,
    collaborationResultBridge: collaboration,
    pendingMessageSource: { loadPendingMessages: async () => "Messages from another participant." },
  });

  const record = await runtime.adopt(instruction, now);
  assert.equal(record.executionId, instruction.instructionId, "default execution identity must match the dispatch intent");
  assert.match(host.startedInstruction?.executionConstraints.pendingMessagesContext as string, /another participant/);
  host.events.push({
    type: "provider.progress",
    executionId: "provider-handle",
    adapterId: "codex",
    providerSessionRef: null,
    correlationId: "provider-correlation",
    causationId: null,
    timestamp: now,
    rawEventRef: null,
    redactionStatus: "redacted",
    eventId: "provider-event-1",
    participantId: "agent-1",
    assignmentId: "assignment-1",
    payload: { type: "provider.progress", summary: "finished with Bearer oak_supersecretvalue1234" },
  });
  host.events.push({
    type: "provider.activity",
    executionId: "provider-handle",
    adapterId: "codex",
    providerSessionRef: null,
    correlationId: "provider-correlation",
    causationId: null,
    timestamp: now,
    rawEventRef: null,
    redactionStatus: "redacted",
    eventId: "provider-activity-1",
    participantId: "agent-1",
    assignmentId: "assignment-1",
    payload: { type: "provider.activity", activityKind: "file.changed", status: "succeeded", summary: "Changed file.", filePath: "src/lib/mission/example.ts" },
  });
  host.resolve({ handleId: "handle-1" }, { success: true, summary: "done\n```oathlock-collaboration\n[{\"type\":\"message\",\"recipients\":\"broadcast\",\"body\":\"handoff ready\"}]\n```" });

  const report = await runtime.tick("2026-07-31T00:01:00.000Z");
  assert.equal(report.runtimeEventsPersisted, 2);
  assert.equal(report.runtimeEventErrors, 0);
  assert.equal(report.runtimeActivitiesPublished, 1);
  assert.equal(report.runtimeActivityErrors, 0);
  assert.equal(liveActivityIds.length, 1);
  assert.deepEqual(accepted, [`started:${instruction.instructionId}`, `completed:${instruction.instructionId}`]);
  assert.equal(report.collaborationCommands, 1);
  assert.deepEqual(commands, ["PostMessage"]);
  assert.equal(report.completed.length, 1);
  assert.doesNotMatch(journal.list()[0].summary, /oak_supersecretvalue1234/);
});

test("runtime-event normalization is bounded and the journal is idempotent", async () => {
  const event = {
    type: "provider.output",
    executionId: "provider-handle",
    adapterId: "codex",
    providerSessionRef: null,
    correlationId: "c",
    causationId: null,
    timestamp: now,
    rawEventRef: null,
    redactionStatus: "redacted" as const,
    payload: { type: "provider.output", text: "x".repeat(10_000) },
  } satisfies ProviderEvent;
  const normalized = normalizeMissionRuntimeEvent({ event, workspaceId: "workspace-1", missionId: "mission-1", executionId: "execution-1", participantId: null, assignmentId: null, eventId: "event-1", correlationId: "c", causationId: null });
  assert.equal(normalized.redactionStatus, "redacted");
  assert.ok(Buffer.byteLength(JSON.stringify(normalized.payload), "utf8") <= 8_192);
  const journal = new InMemoryMissionRuntimeEventJournal();
  assert.deepEqual(await journal.append([normalized, normalized]), { stored: 1, duplicates: 1 });
});

test("accepted-result service constructs a redacted, intent-linked result", async () => {
  let captured: Record<string, unknown> | null = null;
  const store: MissionExecutionResultStore = {
    acceptResult: async (input) => { captured = input as unknown as Record<string, unknown>; return { ok: true, duplicate: false, acceptedResultId: "accepted-1", applicationStatus: "pending" }; },
    claimUnapplied: async () => [], markLifecycleApplied: async () => {}, markEvidenceApplied: async () => {}, markFullyApplied: async () => {}, markApplicationFailed: async () => {}, releaseApplicationClaim: async () => {},
  };
  const service = new MissionAcceptedResultService(store);
  const instruction = { instructionId: "intent-1", missionId: "mission-1", workspaceId: "workspace-1", assignmentId: "assignment-1", repositoryId: null, dispatchKey: "primary", adapterRequirement: "codex", leaseId: "lease-1", fencingToken: 3, attempt: 1, executionConstraints: {}, createdAt: now, deliveredAt: now, supersededAt: null, processHandle: null } satisfies DispatchInstruction;
  const result = await service.accept({ instruction, execution: { executionId: "intent-1", instructionId: "intent-1", missionId: "mission-1", workspaceId: "workspace-1", dispatchKey: "primary", leaseId: "lease-1", fencingToken: 3, attempt: 1, state: "completed", startedAt: now, endedAt: now, lastHeartbeatAt: now, outcome: null, terminationReason: null }, resultKind: "started", outcome: { success: true, summary: "safe summary Bearer oak_supersecretvalue1234" }, now });
  assert.equal(result.ok, true);
  assert.ok(captured);
  const acceptedInput = captured as unknown as { executionId: string; metadata: { redactionState: string; summary: string } };
  assert.equal(acceptedInput.executionId, "intent-1");
  assert.equal(acceptedInput.metadata.redactionState, "redacted");
  assert.equal(acceptedInput.metadata.summary.includes("oak_supersecretvalue1234"), false);
});

test("typed review, completion, and remediation directives become existing Mission commands", () => {
  const parsed = parseCollaborationDirectives(`
    \`\`\`oathlock-collaboration
    [{"type":"review_request","recipients":["agent-b"],"reviewerParticipantIds":["agent-b"],"body":"Please review","scope":"auth","reviewPolicy":"single_reviewer"},
     {"type":"completion_notice","recipients":"broadcast","body":"Assignment complete","dispatchKey":"primary"},
     {"type":"remediation","recipients":["agent-b"],"findingId":"finding-1","nextStatus":"remediation_submitted","body":"Fix applied"}]
    \`\`\`
  `);
  assert.equal(parsed.parseErrors.length, 0);
  const commands = buildCollaborationCommands({ missionId: "mission-1", assignmentId: "assignment-1", senderParticipantId: "agent-a", directives: parsed.directives, originatingExecutionRef: "execution-1", mintMessageId: (() => { let i = 0; return () => `message-${++i}`; })() });
  assert.deepEqual(commands.map((command) => command.type), ["PostMessage", "PostMessage", "PostMessage", "TransitionFinding"]);
  assert.deepEqual((commands[0] as { structuredPayload?: Record<string, unknown> }).structuredPayload?.originatingExecutionRef, "execution-1");
  assert.equal((commands[1] as { messageType: string }).messageType, "completion_notice");
  assert.equal((commands[2] as { messageType: string }).messageType, "finding");
});
