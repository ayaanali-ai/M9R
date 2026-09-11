/**
 * Provider-reported usage projection and rolling-window presenter.
 *
 * This module deliberately does not know provider quotas. It only aggregates
 * token and cost fields that arrived from the provider runtime path. A window
 * with no token fields is unavailable, never a fabricated zero-usage window.
 */

export const MISSION_USAGE_FIVE_HOURS_MS = 5 * 60 * 60 * 1_000;
export const MISSION_USAGE_SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000;

export type MissionUsageSource = "provider_runtime_events";

export interface MissionUsageSnapshot {
  turnId: string;
  provider: string;
  occurredAt: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  contextUsedTokens: number | null;
  contextWindowTokens: number | null;
  eventId: string;
}

export interface MissionUsageProviderView {
  provider: string;
  usedTokens: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

export interface MissionUsageWindowView {
  windowHours: 5 | 168;
  available: boolean;
  usedTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  contextUsedTokens: number | null;
  contextWindowTokens: number | null;
  resetAtMs: number | null;
  byProvider: MissionUsageProviderView[];
}

export interface MissionUsageView {
  source: MissionUsageSource;
  isProviderAllowance: false;
  observedAt: string;
  fiveHour: MissionUsageWindowView;
  sevenDay: MissionUsageWindowView;
}

export function missionUsageSnapshotFromRuntimeEvent(input: {
  eventType: string;
  turnId?: string | null;
  eventId: string;
  adapterId: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}): MissionUsageSnapshot | null {
  if (input.eventType !== "provider.usage_updated") return null;
  const numberOrNull = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  const snapshot: MissionUsageSnapshot = {
    turnId: input.turnId ?? input.eventId,
    provider: input.adapterId,
    occurredAt: input.occurredAt,
    inputTokens: numberOrNull(input.payload.inputTokens),
    outputTokens: numberOrNull(input.payload.outputTokens),
    totalTokens: numberOrNull(input.payload.totalTokens),
    costUsd: numberOrNull(input.payload.costUsd),
    contextUsedTokens: numberOrNull(input.payload.contextUsedTokens),
    contextWindowTokens: numberOrNull(input.payload.contextWindowTokens),
    eventId: input.eventId,
  };
  return snapshot.inputTokens !== null || snapshot.outputTokens !== null || snapshot.totalTokens !== null || snapshot.costUsd !== null || snapshot.contextUsedTokens !== null
    ? snapshot
    : null;
}

function nonNegativeNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function tokenTotal(snapshot: MissionUsageSnapshot): number | null {
  const explicitTotal = nonNegativeNumber(snapshot.totalTokens);
  if (explicitTotal !== null) return explicitTotal;
  const input = nonNegativeNumber(snapshot.inputTokens);
  const output = nonNegativeNumber(snapshot.outputTokens);
  if (input === null && output === null) return null;
  return (input ?? 0) + (output ?? 0);
}

function latestSnapshotByTurn(snapshots: readonly MissionUsageSnapshot[]): MissionUsageSnapshot[] {
  const latest = new Map<string, MissionUsageSnapshot>();
  for (const snapshot of snapshots) {
    if (!snapshot.turnId || !snapshot.provider || !Number.isFinite(Date.parse(snapshot.occurredAt))) continue;
    const prior = latest.get(snapshot.turnId);
    if (!prior || Date.parse(snapshot.occurredAt) > Date.parse(prior.occurredAt) || (snapshot.occurredAt === prior.occurredAt && snapshot.eventId > prior.eventId)) {
      latest.set(snapshot.turnId, {
        ...snapshot,
        inputTokens: snapshot.inputTokens ?? prior?.inputTokens ?? null,
        outputTokens: snapshot.outputTokens ?? prior?.outputTokens ?? null,
        totalTokens: snapshot.totalTokens ?? prior?.totalTokens ?? null,
        costUsd: snapshot.costUsd ?? prior?.costUsd ?? null,
        contextUsedTokens: snapshot.contextUsedTokens ?? prior?.contextUsedTokens ?? null,
        contextWindowTokens: snapshot.contextWindowTokens ?? prior?.contextWindowTokens ?? null,
      });
    }
  }
  return [...latest.values()];
}

function nullableSum(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length > 0 ? present.reduce((sum, value) => sum + value, 0) : null;
}

function buildWindow(snapshots: readonly MissionUsageSnapshot[], nowMs: number, windowMs: number, windowHours: 5 | 168): MissionUsageWindowView {
  const startMs = nowMs - windowMs;
  const contributing = snapshots.filter((snapshot) => {
    const occurredAtMs = Date.parse(snapshot.occurredAt);
    return occurredAtMs >= startMs && occurredAtMs <= nowMs && tokenTotal(snapshot) !== null;
  });
  const byProvider = new Map<string, MissionUsageProviderView>();
  for (const snapshot of contributing) {
    const usedTokens = tokenTotal(snapshot);
    if (usedTokens === null) continue;
    const prior = byProvider.get(snapshot.provider);
    const inputTokens = nonNegativeNumber(snapshot.inputTokens);
    const outputTokens = nonNegativeNumber(snapshot.outputTokens);
    const costUsd = nonNegativeNumber(snapshot.costUsd);
    byProvider.set(snapshot.provider, {
      provider: snapshot.provider,
      usedTokens: (prior?.usedTokens ?? 0) + usedTokens,
      inputTokens: nullableSum([prior?.inputTokens ?? null, inputTokens]),
      outputTokens: nullableSum([prior?.outputTokens ?? null, outputTokens]),
      costUsd: nullableSum([prior?.costUsd ?? null, costUsd]),
    });
  }
  const sorted = [...byProvider.values()].sort((left, right) => left.provider.localeCompare(right.provider));
  const oldest = contributing.reduce<number | null>((oldestMs, snapshot) => {
    const occurredAtMs = Date.parse(snapshot.occurredAt);
    return oldestMs === null ? occurredAtMs : Math.min(oldestMs, occurredAtMs);
  }, null);
  return {
    windowHours,
    available: contributing.length > 0,
    usedTokens: contributing.length > 0 ? sorted.reduce((sum, provider) => sum + provider.usedTokens, 0) : null,
    inputTokens: contributing.length > 0 ? nullableSum(contributing.map((snapshot) => nonNegativeNumber(snapshot.inputTokens))) : null,
    outputTokens: contributing.length > 0 ? nullableSum(contributing.map((snapshot) => nonNegativeNumber(snapshot.outputTokens))) : null,
    costUsd: contributing.length > 0 ? nullableSum(contributing.map((snapshot) => nonNegativeNumber(snapshot.costUsd))) : null,
    contextUsedTokens: contributing.length > 0 ? nullableSum(contributing.map((snapshot) => nonNegativeNumber(snapshot.contextUsedTokens))) : null,
    contextWindowTokens: contributing.length > 0 ? nullableSum(contributing.map((snapshot) => nonNegativeNumber(snapshot.contextWindowTokens))) : null,
    resetAtMs: oldest === null ? null : oldest + windowMs,
    byProvider: sorted,
  };
}

export function aggregateMissionUsage(snapshots: readonly MissionUsageSnapshot[], nowMs = Date.now()): MissionUsageView {
  const deduped = latestSnapshotByTurn(snapshots);
  return {
    source: "provider_runtime_events",
    isProviderAllowance: false,
    observedAt: new Date(nowMs).toISOString(),
    fiveHour: buildWindow(deduped, nowMs, MISSION_USAGE_FIVE_HOURS_MS, 5),
    sevenDay: buildWindow(deduped, nowMs, MISSION_USAGE_SEVEN_DAYS_MS, 168),
  };
}
