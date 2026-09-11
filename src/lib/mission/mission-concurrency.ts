/**
 * Optimistic concurrency primitives (spec STATE_MODEL §13)
 * ----------------------------------------------------------------------------
 * Every aggregate carries a version. Commands supply the version they expect.
 * A mismatch returns `409` with the current version and the latest event
 * cursor so the caller can re-read and retry against fresh state.
 *
 * This exists because two workers acting on the same Mission is normal, not
 * exceptional: an orchestrator dispatching work while a human records a
 * decision is exactly the collision this prevents. Last-write-wins would
 * silently discard one of them.
 *
 * Pure and storage-agnostic — Phase 1 defines the primitives; the durable
 * store arrives with the schema in a later phase.
 */

import type { MissionId } from "./mission-domain";

/** HTTP status the API layer returns for a version conflict (spec §13). */
export const CONCURRENCY_CONFLICT_STATUS = 409 as const;

export interface VersionedAggregate {
  id: MissionId;
  aggregateVersion: number;
}

export interface ExpectedVersionCheck {
  /** Version the caller believes is current. */
  expectedVersion: number;
  /** Version actually stored. */
  currentVersion: number;
}

export interface ConcurrencyConflict {
  status: typeof CONCURRENCY_CONFLICT_STATUS;
  code: "version_conflict";
  missionId: MissionId;
  expectedVersion: number;
  currentVersion: number;
  /** Latest event id, so the caller can resume reading from a known point. */
  latestEventCursor: string | null;
  message: string;
}

export type ConcurrencyResult =
  | { ok: true; nextVersion: number }
  | { ok: false; conflict: ConcurrencyConflict };

/**
 * Check an expected version and compute the next one.
 *
 * A future expected version is rejected as firmly as a stale one: it means the
 * caller is reasoning about a state that does not exist, which is a bug worth
 * surfacing rather than tolerating.
 */
export function checkExpectedVersion(input: {
  missionId: MissionId;
  check: ExpectedVersionCheck;
  latestEventCursor?: string | null;
}): ConcurrencyResult {
  const { expectedVersion, currentVersion } = input.check;

  if (expectedVersion === currentVersion) {
    return { ok: true, nextVersion: currentVersion + 1 };
  }

  const direction = expectedVersion < currentVersion ? "stale" : "ahead of";
  return {
    ok: false,
    conflict: {
      status: CONCURRENCY_CONFLICT_STATUS,
      code: "version_conflict",
      missionId: input.missionId,
      expectedVersion,
      currentVersion,
      latestEventCursor: input.latestEventCursor ?? null,
      message: `Expected version ${expectedVersion} is ${direction} the current version ${currentVersion}. Re-read the mission and retry.`,
    },
  };
}

/** True when a result is a conflict — narrows the union for callers. */
export function isConcurrencyConflict(result: ConcurrencyResult): result is { ok: false; conflict: ConcurrencyConflict } {
  return result.ok === false;
}
