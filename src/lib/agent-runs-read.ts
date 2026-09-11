/**
 * Agent runs — resilient column read (pure, server-free)
 * ----------------------------------------------------------------------------
 * The dashboard reads agent_runs with an analytics-rich column set. The optional
 * columns (rule_health, behavior) were added in a later migration revision. If
 * the deployed schema is a step behind, selecting a missing column makes the
 * WHOLE query error — which previously made a started run silently vanish from
 * the dashboard. This module degrades gracefully: it tries the full column set,
 * and falls back to the guaranteed core columns (with optional fields nulled).
 *
 * Pure: it takes an injected query builder, so it is unit-testable with no DB and
 * imports nothing server-only.
 */

// Columns guaranteed by the base agent_runs migration.
export const CORE_RUN_COLUMNS =
  "id, connection_id, workspace_id, agent_kind, repo_hint, task_title, status, current_phase, rules_loaded_count, latest_session_id, started_at, last_seen_at, completed_at, error_message";
// Analytics columns added later; queried when present.
export const OPTIONAL_RUN_COLUMNS = "rule_health, behavior";
export const RUN_COLUMNS = `${CORE_RUN_COLUMNS}, ${OPTIONAL_RUN_COLUMNS}`;

export interface QueryResult {
  data: unknown;
  error: { code?: string; message?: string } | null;
}

/** A Supabase "undefined column" error (deployed schema behind the code). */
export function isMissingColumnError(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  return err.code === "42703" || /column .* does not exist/i.test(err.message ?? "");
}

/**
 * Run a select with the full column set, falling back to core columns when an
 * optional column is missing. On fallback, optional fields are set to null —
 * never fabricated. Logs safely (no tokens) so the schema gap is visible.
 */
export async function selectRunsResilient<T>(
  build: (cols: string) => PromiseLike<QueryResult>,
): Promise<T[]> {
  const full = await build(RUN_COLUMNS);
  if (!full.error) return (full.data ?? []) as T[];

  if (isMissingColumnError(full.error)) {
    console.warn(
      "agent_runs: optional columns missing in deployed schema — apply the latest supabase-agent-runs.sql. Falling back to core columns.",
    );
    const core = await build(CORE_RUN_COLUMNS);
    if (!core.error) {
      return ((core.data ?? []) as Array<Record<string, unknown>>).map(
        (r) => ({ ...r, rule_health: null, behavior: null }) as unknown as T,
      );
    }
    console.error("listAgentRunsForUser core fallback failed:", core.error.message, core.error.code);
    return [];
  }

  console.error("listAgentRunsForUser failed:", full.error.message, full.error.code);
  return [];
}
