import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderEvent } from "@/lib/mission/mission-provider-adapter";
import {
  normalizeMissionRuntimeActivity,
  projectMissionRuntimeActivity,
  activityFromProviderEvent,
} from "@/lib/mission/mission-runtime-activity";

const now = "2026-08-01T00:00:00.000Z";

function activityEvent(payload: ProviderEvent["payload"]): ProviderEvent {
  return {
    type: "provider.activity",
    executionId: "execution-1",
    adapterId: "codex",
    providerSessionRef: "session-1",
    correlationId: "correlation-1",
    causationId: null,
    timestamp: now,
    rawEventRef: "raw-1",
    redactionStatus: "redacted",
    eventId: "event-1",
    payload,
  } as ProviderEvent;
}

test("structured provider activity retains file, command, test, and provenance details", () => {
  const event = activityEvent({
    type: "provider.activity",
    activityKind: "file.changed",
    status: "succeeded",
    summary: "Updated the command handler.",
    filePath: "src/lib/mission/mission-command-handler.ts",
  });
  const activity = normalizeMissionRuntimeActivity({
    event,
    workspaceId: "workspace-1",
    missionId: "mission-1",
    executionId: "execution-1",
    participantId: "agent-1",
    assignmentId: "assignment-1",
    eventId: "event-1",
  });

  assert.equal(activity?.kind, "file.changed");
  assert.equal(activity?.source, "provider_observed");
  assert.equal(activity?.status, "succeeded");
  assert.equal(activity?.filePath, "src/lib/mission/mission-command-handler.ts");
  assert.equal(projectMissionRuntimeActivity(activity!).title, "Edited");
  assert.equal(projectMissionRuntimeActivity(activity!).detail, "src/lib/mission/mission-command-handler.ts");
});

test("activity projection exposes real work without inferring it from the assignment goal", () => {
  const event = activityEvent({
    type: "provider.activity",
    activityKind: "test.completed",
    status: "succeeded",
    summary: "Focused mission tests passed.",
    testName: "mission-live-activity",
    testPassed: 8,
    testFailed: 0,
  });
  const activity = normalizeMissionRuntimeActivity({
    event,
    workspaceId: "workspace-1",
    missionId: "mission-1",
    executionId: "execution-1",
    participantId: null,
    assignmentId: null,
    eventId: "event-1",
  });

  assert.equal(projectMissionRuntimeActivity(activity!).title, "Tests passed");
  assert.match(projectMissionRuntimeActivity(activity!).detail, /mission-live-activity/);
  assert.match(projectMissionRuntimeActivity(activity!).detail, /8 passed/);
});

test("generic progress is not promoted into file or review activity", () => {
  const event = {
    ...activityEvent({ type: "provider.progress", summary: "Reviewing src/lib/secret.ts" }),
    type: "provider.progress",
    payload: { type: "provider.progress", summary: "Reviewing src/lib/secret.ts" },
  } as ProviderEvent;

  assert.equal(activityFromProviderEvent(event), null);
  assert.equal(normalizeMissionRuntimeActivity({
    event,
    workspaceId: "workspace-1",
    missionId: "mission-1",
    executionId: "execution-1",
    participantId: null,
    assignmentId: null,
    eventId: "event-1",
  }), null);
});

test("activity normalization redacts secrets and rejects absolute file paths", () => {
  const event = activityEvent({
    type: "provider.activity",
    activityKind: "command.completed",
    status: "failed",
    summary: "Command failed with Bearer oak_supersecretvalue1234",
    command: "npm test --token Bearer oak_supersecretvalue1234",
    filePath: "C:/RunLeak/runleak/src/lib/secret.ts",
  });
  const activity = normalizeMissionRuntimeActivity({
    event,
    workspaceId: "workspace-1",
    missionId: "mission-1",
    executionId: "execution-1",
    participantId: null,
    assignmentId: null,
    eventId: "event-1",
  });

  assert.equal(activity?.filePath, null);
  assert.doesNotMatch(activity?.summary ?? "", /oak_supersecretvalue1234/);
  assert.doesNotMatch(activity?.command ?? "", /oak_supersecretvalue1234/);
  assert.equal(activity?.status, "failed");
});
