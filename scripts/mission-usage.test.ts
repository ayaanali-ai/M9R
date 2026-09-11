import assert from "node:assert/strict";
import test from "node:test";
import { aggregateMissionUsage, missionUsageSnapshotFromRuntimeEvent, type MissionUsageSnapshot } from "@/lib/mission/mission-usage";

const NOW = Date.parse("2026-08-09T20:00:00.000Z");

function snapshot(overrides: Partial<MissionUsageSnapshot> = {}): MissionUsageSnapshot {
  return {
    turnId: "turn-1",
    provider: "claude-code",
    occurredAt: new Date(NOW - 60 * 60 * 1_000).toISOString(),
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    costUsd: null,
    contextUsedTokens: null,
    contextWindowTokens: null,
    eventId: "event-1",
    ...overrides,
  };
}

test("aggregates provider-reported totals into rolling windows without inventing an allowance", () => {
  const usage = aggregateMissionUsage([
    snapshot({ turnId: "turn-claude", totalTokens: 1_500, eventId: "event-claude", provider: "claude-code" }),
    snapshot({
      turnId: "turn-codex",
      provider: "codex",
      occurredAt: new Date(NOW - 2 * 24 * 60 * 60 * 1_000).toISOString(),
      inputTokens: 200,
      outputTokens: 300,
      costUsd: 0.2,
      totalTokens: null,
      eventId: "event-codex",
    }),
    snapshot({
      turnId: "turn-old",
      occurredAt: new Date(NOW - 8 * 24 * 60 * 60 * 1_000).toISOString(),
      totalTokens: 99_999,
      eventId: "event-old",
    }),
  ], NOW);

  assert.equal(usage.source, "provider_runtime_events");
  assert.equal(usage.isProviderAllowance, false);
  assert.equal(usage.fiveHour.available, true);
  assert.equal(usage.fiveHour.usedTokens, 1_500);
  assert.equal(usage.fiveHour.inputTokens, null);
  assert.equal(usage.sevenDay.usedTokens, 2_000);
  assert.equal(usage.sevenDay.costUsd, 0.2);
  assert.deepEqual(usage.sevenDay.byProvider, [
    { provider: "claude-code", usedTokens: 1_500, inputTokens: null, outputTokens: null, costUsd: null },
    { provider: "codex", usedTokens: 500, inputTokens: 200, outputTokens: 300, costUsd: 0.2 },
  ]);
});

test("keeps only the latest cumulative usage snapshot for a turn", () => {
  const usage = aggregateMissionUsage([
    snapshot({
      turnId: "turn-1",
      occurredAt: new Date(NOW - 55 * 60 * 1_000).toISOString(),
      totalTokens: 100,
      contextUsedTokens: 100,
      eventId: "event-1a",
    }),
    snapshot({
      turnId: "turn-1",
      occurredAt: new Date(NOW - 50 * 60 * 1_000).toISOString(),
      totalTokens: 250,
      contextUsedTokens: 250,
      contextWindowTokens: 200_000,
      eventId: "event-1b",
    }),
  ], NOW);

  assert.equal(usage.fiveHour.usedTokens, 250);
  assert.equal(usage.fiveHour.byProvider[0]?.usedTokens, 250);
  assert.equal(usage.fiveHour.byProvider[0]?.provider, "claude-code");
});

test("keeps cost and context metadata when the final token snapshot omits those fields", () => {
  const usage = aggregateMissionUsage([
    snapshot({
      turnId: "turn-1",
      occurredAt: new Date(NOW - 55 * 60 * 1_000).toISOString(),
      totalTokens: null,
      costUsd: 0.42,
      contextUsedTokens: 4_000,
      contextWindowTokens: 200_000,
      eventId: "event-1a",
    }),
    snapshot({
      turnId: "turn-1",
      occurredAt: new Date(NOW - 50 * 60 * 1_000).toISOString(),
      totalTokens: 900,
      costUsd: null,
      contextUsedTokens: null,
      contextWindowTokens: null,
      eventId: "event-1b",
    }),
  ], NOW);

  assert.equal(usage.fiveHour.usedTokens, 900);
  assert.equal(usage.fiveHour.costUsd, 0.42);
  assert.equal(usage.fiveHour.contextUsedTokens, 4_000);
  assert.equal(usage.fiveHour.contextWindowTokens, 200_000);
});

test("returns unavailable windows when no provider token fields were recorded", () => {
  const usage = aggregateMissionUsage([
    snapshot({
      turnId: "turn-no-usage",
      contextUsedTokens: 12_000,
      contextWindowTokens: 200_000,
    }),
  ], NOW);

  assert.equal(usage.fiveHour.available, false);
  assert.equal(usage.fiveHour.usedTokens, null);
  assert.equal(usage.fiveHour.byProvider.length, 0);
  assert.equal(usage.sevenDay.available, false);
});

test("preserves provider-reported totals and separates context metadata", () => {
  const usage = aggregateMissionUsage([
    snapshot({
      totalTokens: 4_200,
      contextUsedTokens: 8_400,
      contextWindowTokens: 128_000,
    }),
  ], NOW);

  assert.equal(usage.fiveHour.usedTokens, 4_200);
  assert.equal(usage.fiveHour.contextUsedTokens, 8_400);
  assert.equal(usage.fiveHour.contextWindowTokens, 128_000);
});

test("runtime projection accepts exact usage events and ignores unrelated runtime events", () => {
  assert.equal(missionUsageSnapshotFromRuntimeEvent({
    eventType: "provider.output",
    eventId: "output-1",
    adapterId: "claude-code-acp",
    occurredAt: new Date(NOW).toISOString(),
    payload: {},
  }), null);

  const snapshot = missionUsageSnapshotFromRuntimeEvent({
    eventType: "provider.usage_updated",
    turnId: "turn-1",
    eventId: "usage-1",
    adapterId: "claude-code-acp",
    occurredAt: new Date(NOW).toISOString(),
    payload: { inputTokens: 1_000, outputTokens: 600, totalTokens: 1_600 },
  });
  assert.deepEqual(snapshot, {
    turnId: "turn-1",
    provider: "claude-code-acp",
    occurredAt: new Date(NOW).toISOString(),
    inputTokens: 1_000,
    outputTokens: 600,
    totalTokens: 1_600,
    costUsd: null,
    contextUsedTokens: null,
    contextWindowTokens: null,
    eventId: "usage-1",
  });
});
