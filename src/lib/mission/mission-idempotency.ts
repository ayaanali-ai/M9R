/**
 * Idempotency primitives (spec STATE_MODEL §12)
 * ----------------------------------------------------------------------------
 * State-changing commands require an idempotency key. A duplicate command
 * returns the PRIOR result rather than performing the work twice.
 *
 * This matters concretely: a retried dispatch must not create a second
 * provider session, a double-clicked review must not record two decisions, and
 * a resubmitted evidence payload must not produce a duplicate Passport. Those
 * exact duplications are visible in the existing data today.
 *
 * Phase 1 scope: key derivation and the store INTERFACE only. The
 * database-backed store is deliberately not built yet — it belongs with the
 * schema in a later phase. `InMemoryIdempotencyStore` exists for tests, not
 * production.
 */

import { createHash } from "node:crypto";
import type { MissionId } from "./mission-domain";

export type IdempotencyKey = string;

/**
 * Derive a stable key from the command's meaningful content. Two structurally
 * identical commands produce the same key regardless of when they were sent.
 */
export function deriveIdempotencyKey(input: {
  missionId: MissionId;
  commandType: string;
  /** Caller-supplied key wins when present — clients often have a better one. */
  clientKey?: string | null;
  /** Command payload; serialized deterministically. */
  payload: unknown;
}): IdempotencyKey {
  if (input.clientKey && input.clientKey.trim()) return input.clientKey.trim();

  const canonical = JSON.stringify({
    mission: input.missionId,
    command: input.commandType,
    payload: input.payload ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** A previously-recorded outcome, replayed for duplicate commands. */
export interface IdempotentOutcome<T> {
  key: IdempotencyKey;
  missionId: MissionId;
  commandType: string;
  /** The result produced the first time this command succeeded. */
  result: T;
  recordedAt: string;
  /** Aggregate version produced by the original execution. */
  aggregateVersion: number;
}

/**
 * Storage contract. Implementations must make `remember` atomic with the
 * command's own state change — recording an outcome for work that did not
 * commit is worse than not recording it at all.
 */
export interface IdempotencyStore<T = unknown> {
  lookup(key: IdempotencyKey): Promise<IdempotentOutcome<T> | null>;
  remember(outcome: IdempotentOutcome<T>): Promise<void>;
}

export type IdempotencyCheck<T> =
  | { duplicate: false }
  | { duplicate: true; outcome: IdempotentOutcome<T> };

/** Look up a key and report whether this command already ran. */
export async function checkIdempotency<T>(
  store: IdempotencyStore<T>,
  key: IdempotencyKey,
): Promise<IdempotencyCheck<T>> {
  const existing = await store.lookup(key);
  return existing ? { duplicate: true, outcome: existing } : { duplicate: false };
}

/**
 * Test double. Not for production use — it has no durability, no atomicity
 * with the aggregate write, and no eviction.
 */
export class InMemoryIdempotencyStore<T = unknown> implements IdempotencyStore<T> {
  private readonly entries = new Map<IdempotencyKey, IdempotentOutcome<T>>();

  async lookup(key: IdempotencyKey): Promise<IdempotentOutcome<T> | null> {
    return this.entries.get(key) ?? null;
  }

  async remember(outcome: IdempotentOutcome<T>): Promise<void> {
    // First write wins: the whole point is that a retry cannot overwrite the
    // original result with a differently-computed one.
    if (!this.entries.has(outcome.key)) this.entries.set(outcome.key, outcome);
  }

  get size(): number {
    return this.entries.size;
  }
}
