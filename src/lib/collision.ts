/**
 * Collision — OathLock V2 Phase 4 (Scope + Collision control)
 * ----------------------------------------------------------------------------
 * Deterministic overlap detection on declared file scope across active runs.
 * No model call needed — this is a plain string-set intersection, per the
 * master spec's explicit requirement ("no second model call is needed to
 * detect the Collision").
 *
 * Scope is read from each run's most recent SCOPE_ANNOUNCED Dispatch (see
 * dispatch.ts) — there is no separate "declared scope" table. A run that has
 * never announced scope has none, and is never flagged.
 */

export interface RunScope {
  runId: string;
  sender: string;
  scope: string[];
}

export interface Collision {
  runIds: [string, string];
  senders: [string, string];
  overlappingPaths: string[];
}

/**
 * Pairwise overlap across all runs with declared scope. O(n^2) over active
 * runs in one workspace, which is small (single digits in practice) — no
 * indexing needed.
 */
export function detectCollisions(runs: RunScope[]): Collision[] {
  const collisions: Collision[] = [];
  const withScope = runs.filter((r) => r.scope.length > 0);

  for (let i = 0; i < withScope.length; i++) {
    for (let j = i + 1; j < withScope.length; j++) {
      const a = withScope[i];
      const b = withScope[j];
      if (a.runId === b.runId) continue;
      const bSet = new Set(b.scope);
      const overlappingPaths = a.scope.filter((path) => bSet.has(path));
      if (overlappingPaths.length > 0) {
        collisions.push({
          runIds: [a.runId, b.runId],
          senders: [a.sender, b.sender],
          overlappingPaths,
        });
      }
    }
  }

  return collisions;
}

/** True when this run's scope overlaps ANY other run's scope in the set. */
export function hasCollision(runId: string, runs: RunScope[]): boolean {
  return detectCollisions(runs).some((c) => c.runIds.includes(runId));
}
