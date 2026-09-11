/** Pure Work Signal delivery/replay logic, free of any Next.js or Supabase runtime dependency so it can be unit tested directly. */

/** Hard ceiling on how many signals a single replay page can return. */
export const MAX_REPLAY_PAGE = 200;
const DEFAULT_REPLAY_PAGE = 50;

/** A connection's own outbox rows are marked stale (and eligible for 'failed') once pending this long. */
export const OUTBOX_STALE_MS = 10 * 60_000;

/** Clamp a client-supplied `since` cursor to a safe non-negative integer, or null if absent/invalid. */
export function clampSince(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) return null;
  return n;
}

/** Clamp a client-supplied page size to a safe, bounded integer. */
export function clampLimit(raw: unknown): number {
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1) return DEFAULT_REPLAY_PAGE;
  return Math.min(n, MAX_REPLAY_PAGE);
}

/** Validate an acknowledgement cursor: must be a safe, non-negative integer. */
export function validateAckSequence(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) return null;
  return raw;
}

/** An outbox row is stale (its owning connection never confirmed receipt) once `available_at` is older than the window. */
export function isOutboxRowStale(availableAt: string, now: number, staleAfterMs = OUTBOX_STALE_MS): boolean {
  const t = Date.parse(availableAt);
  return Number.isFinite(t) && now - t >= staleAfterMs;
}
