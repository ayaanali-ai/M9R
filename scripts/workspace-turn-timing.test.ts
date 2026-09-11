import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkspaceTurnTelemetry,
  createWorkspaceTurnTiming,
} from "../src/lib/bridge/workspace-turn-timing.ts";
import { createMissionRelayWorkspaceTimingFrame } from "../src/lib/mission/mission-relay-client.ts";
import { parseRelayFrame } from "../src/lib/mission/mission-relay-protocol.ts";

const context = {
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  messageId: "message-1",
  source: "relay" as const,
  bridgeInstanceId: "bridge-1",
};

test("workspace turn timing records redacted milestones and derives useful durations", () => {
  let now = 1_000;
  const events: unknown[] = [];
  const timing = createWorkspaceTurnTiming({
    timingId: "timing-test-1",
    context,
    now: () => now,
    emit: (event) => events.push(event),
  });

  timing.mark("message.received", { source: "poll" });
  now = 1_012;
  timing.mark("message.enqueued", { queueDepth: 2 });
  now = 1_020;
  timing.mark("ack.completed", { outcome: "ok" });
  now = 1_035;
  timing.mark("prompt.started", { batchSize: 1 });
  now = 1_048;
  timing.mark("provider.first_event", { providerEventType: "provider.activity" });
  now = 1_100;
  timing.mark("turn.completed", { outcome: "ok" });
  now = 1_115;
  timing.mark("report.observed", { outcome: "observed" });

  const snapshot = timing.snapshot();
  assert.equal(snapshot.timingId, "timing-test-1");
  assert.deepEqual(snapshot.context, context);
  assert.deepEqual(snapshot.durations, {
    receiptToEnqueueMs: 12,
    receiptToAckMs: 20,
    ackToPromptMs: 15,
    promptToFirstProviderEventMs: 13,
    promptToCompletionMs: 65,
    receiptToCompletionMs: 100,
    receiptToReportMs: 115,
  });
  assert.equal(snapshot.firstProviderEventType, "provider.activity");
  assert.equal(events.length, 7);
  assert.equal((events[0] as { messageId: string }).messageId, "message-1");
  assert.equal((events[0] as { correlationId: string }).correlationId, "workspace-turn:timing-test-1");
  assert.ok((events[1] as { causationId: string | null }).causationId);
  assert.ok(events.every((event) => !JSON.stringify(event).includes("secret message")));
});

test("provider first-event timing is recorded only once", () => {
  let now = 2_000;
  const timing = createWorkspaceTurnTiming({ timingId: "timing-test-2", context, now: () => now, emit: () => undefined });

  timing.mark("message.received", { source: "relay" });
  timing.mark("prompt.started", { batchSize: 1 });
  now = 2_025;
  assert.equal(timing.mark("provider.first_event", { providerEventType: "provider.activity" }), true);
  now = 2_050;
  assert.equal(timing.mark("provider.first_event", { providerEventType: "provider.completed" }), false);
  assert.equal(timing.snapshot().durations.promptToFirstProviderEventMs, 25);
  assert.equal(timing.snapshot().firstProviderEventType, "provider.activity");
});

test("out-of-order acknowledgement timing stays unknown instead of reporting a fake zero", () => {
  let now = 2_500;
  const timing = createWorkspaceTurnTiming({ timingId: "timing-test-order", context, now: () => now, emit: () => undefined });

  timing.mark("message.received");
  now = 2_510;
  timing.mark("prompt.started");
  now = 2_520;
  timing.mark("ack.completed", { outcome: "ok" });

  assert.equal(timing.snapshot().durations.ackToPromptMs, null);
});

test("failed turns remain measurable without inventing completion or report timings", () => {
  let now = 3_000;
  const timing = createWorkspaceTurnTiming({ timingId: "timing-test-3", context, now: () => now, emit: () => undefined });

  timing.mark("message.received", { source: "relay" });
  now = 3_010;
  timing.mark("prompt.started", { batchSize: 1 });
  now = 3_040;
  timing.mark("turn.failed", { outcome: "failed" });

  const snapshot = timing.snapshot();
  assert.equal(snapshot.durations.promptToCompletionMs, 30);
  assert.equal(snapshot.durations.receiptToCompletionMs, 40);
  assert.equal(snapshot.durations.promptToFirstProviderEventMs, null);
  assert.equal(snapshot.durations.receiptToReportMs, null);
  assert.equal(snapshot.finalStage, "turn.failed");
});

test("workspace turn timing binds one provider session without losing the message trace", () => {
  const events: Array<Record<string, unknown>> = [];
  const timing = createWorkspaceTurnTiming({
    timingId: "timing-test-session",
    context,
    now: () => 4_000,
    emit: (event) => events.push(event as unknown as Record<string, unknown>),
  });

  timing.mark("message.received");
  timing.bindSession({ sessionId: "session-1", provider: "codex" });
  timing.mark("session.ready");

  assert.equal(timing.snapshot().context.sessionId, "session-1");
  assert.equal(timing.snapshot().context.provider, "codex");
  assert.equal(events[1].sessionId, "session-1");
  assert.equal(events[1].provider, "codex");
});

test("workspace telemetry retains bounded completed traces and exposes latency aggregates", () => {
  let now = 5_000;
  const emitted: Array<Record<string, unknown>> = [];
  const telemetry = createWorkspaceTurnTelemetry({
    maxRecentTurns: 2,
    now: () => now,
    emit: (event) => emitted.push(event as unknown as Record<string, unknown>),
  });
  const timing = telemetry.create({ ...context, messageId: "message-telemetry" });

  timing.mark("message.received");
  now = 5_010;
  timing.mark("ack.completed", { outcome: "ok" });
  now = 5_050;
  timing.mark("prompt.started");
  now = 5_150;
  timing.mark("turn.completed", { outcome: "ok" });
  now = 5_175;
  timing.mark("report.observed", { outcome: "observed" });
  telemetry.finish(timing.snapshot().timingId);

  const snapshot = telemetry.snapshot();
  assert.equal(snapshot.schema, "oathlock.workspace_telemetry.v1");
  assert.equal(snapshot.activeTurns, 0);
  assert.equal(snapshot.completedTurns, 1);
  assert.equal(snapshot.observedReports, 1);
  assert.equal(snapshot.recent.length, 1);
  assert.equal(snapshot.latency.receiptToReportMs.count, 1);
  assert.equal(snapshot.latency.receiptToReportMs.p50Ms, 175);
  assert.equal(snapshot.latency.receiptToReportMs.p95Ms, 175);
  assert.ok(emitted.every((event) => event.schema === "oathlock.workspace_timing.v1"));
});

test("workspace timing frames preserve correlation and causal ordering on the relay", () => {
  let event: Parameters<typeof createMissionRelayWorkspaceTimingFrame>[0] | undefined;
  const timing = createWorkspaceTurnTiming({ context, emit: (next) => { event = next; } });
  timing.mark("message.received");
  timing.mark("prompt.started");
  assert.ok(event);

  const frame = createMissionRelayWorkspaceTimingFrame(event);
  const parsed = parseRelayFrame(frame);
  assert.equal(parsed.ok, true);
  assert.equal(frame.type, "workspace.timing");
  assert.equal(frame.correlationId, event.correlationId);
  assert.equal(frame.causationId, event.causationId);
  assert.equal(frame.idempotencyKey, event.eventId);
});
