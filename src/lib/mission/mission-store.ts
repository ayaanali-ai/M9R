/**
 * Mission store — storage-agnostic event log
 * ----------------------------------------------------------------------------
 * The store holds the event log, not a materialized projection. `load`
 * reconstructs state by folding events through `projectMission` (Phase 1) —
 * there is deliberately no separate "projection storage" concept that could
 * drift from the event log it's supposed to represent.
 *
 * This is an INTERFACE plus a rigorous in-memory reference implementation.
 * No database, no schema, no migration — a later phase can back this same
 * interface with Postgres without any caller (including `runMissionCommand`)
 * changing. "Durable" here means the abstraction has real atomicity
 * semantics, not that anything is persisted to disk yet.
 */

import type { MissionId } from "./mission-domain";
import type { MissionEvent } from "./mission-events";
import { CONCURRENCY_CONFLICT_STATUS, type ConcurrencyConflict } from "./mission-concurrency";
import { projectMission, type MissionProjection } from "./mission-projection";

export interface AppendMissionEventsInput {
  missionId: MissionId;
  /** The version the caller believes is current — enforced atomically. */
  expectedVersion: number;
  events: MissionEvent[];
}

export type AppendResult =
  | { ok: true; version: number }
  | { ok: false; conflict: ConcurrencyConflict };

export interface MissionStore {
  /** All events for a mission, in order. Empty array when it doesn't exist. */
  loadEvents(missionId: MissionId): Promise<MissionEvent[]>;
  /**
   * Append events IF the stored version still equals `expectedVersion`.
   * Implementations MUST make the check and the write atomic with respect to
   * concurrent callers — the entire reason this method exists rather than a
   * plain "read version, then write" pair of calls.
   */
  append(input: AppendMissionEventsInput): Promise<AppendResult>;
}

/** Load and fold in one step — the common case for callers that just want current state. */
export async function loadMissionProjection(
  store: MissionStore,
  missionId: MissionId,
): Promise<{ projection: MissionProjection; version: number }> {
  const events = await store.loadEvents(missionId);
  const projection = projectMission(missionId, events);
  const version = events.length > 0 ? events[events.length - 1].aggregateVersion : 0;
  return { projection, version };
}

/**
 * Reference implementation. NOT for production: no durability across process
 * restarts, no cross-process locking. Its atomicity guarantee holds only
 * because JavaScript never interleaves execution within a single synchronous
 * block — `append` does its version check and its mutation with no `await`
 * between them, so even two calls raced via `Promise.all` serialize
 * correctly. A real backing store must provide the same guarantee (e.g. a
 * single `UPDATE ... WHERE version = $expected` statement), not merely
 * approximate it.
 */
export class InMemoryMissionStore implements MissionStore {
  private readonly logs = new Map<MissionId, MissionEvent[]>();

  async loadEvents(missionId: MissionId): Promise<MissionEvent[]> {
    // A copy — callers must never be able to mutate the store by mutating
    // what they read back from it.
    return [...(this.logs.get(missionId) ?? [])];
  }

  async append(input: AppendMissionEventsInput): Promise<AppendResult> {
    const existing = this.logs.get(input.missionId) ?? [];
    const currentVersion = existing.length > 0 ? existing[existing.length - 1].aggregateVersion : 0;

    // Check and mutate with no await between them — this is the atomicity.
    if (input.expectedVersion !== currentVersion) {
      return {
        ok: false,
        conflict: {
          status: CONCURRENCY_CONFLICT_STATUS,
          code: "version_conflict",
          missionId: input.missionId,
          expectedVersion: input.expectedVersion,
          currentVersion,
          latestEventCursor: existing.length > 0 ? existing[existing.length - 1].eventId : null,
          message: `Expected version ${input.expectedVersion} does not match current version ${currentVersion}.`,
        },
      };
    }

    const next = [...existing, ...input.events];
    this.logs.set(input.missionId, next);
    const version = next.length > 0 ? next[next.length - 1].aggregateVersion : 0;
    return { ok: true, version };
  }

  /** Test-only convenience — never part of the interface. */
  get missionCount(): number {
    return this.logs.size;
  }
}
