/**
 * Efficiency Metrics — OathLock V2 Phase 11
 * ----------------------------------------------------------------------------
 * Pure aggregation only. The master spec's acceptance criteria for this phase
 * are explicit: "No public savings percentage without supporting data" and
 * "the product can identify cases where coordination cost more than it
 * helped." That means every number here must come from a real count, and
 * every rate must report "unknown" (null) rather than assume 0 when the
 * underlying data isn't known — same discipline as
 * quality-signal-extraction.ts's "a bare passed with no command is ignored."
 */

export interface RunTokenSample {
  mode: "solo" | "coordinated" | "assurance" | "collaborative";
  knownTokens: number | null;
  knownInputTokens?: number | null;
  knownOutputTokens?: number | null;
  knownCostUsd?: number | null;
}

export interface ModeTokenSummary {
  runCount: number;
  knownTokenRuns: number;
  /** Average of KNOWN-token runs only. Null when no run in this mode has known tokens. */
  averageKnownTokens: number | null;
  averageKnownInputTokens: number | null;
  averageKnownOutputTokens: number | null;
  /** Sum of KNOWN cost across this mode's runs. Null when no run in this mode has a known cost. */
  totalKnownCostUsd: number | null;
  knownCostRuns: number;
}

export interface TokenEfficiencyReport {
  byMode: Record<"solo" | "coordinated" | "assurance" | "collaborative", ModeTokenSummary>;
  totalRuns: number;
  /** Share of ALL runs whose token usage is unknown — reported honestly, never hidden. */
  unknownTokenCoverage: number;
  /** Sum of KNOWN cost across every run. Null when no run has a known cost. */
  totalKnownCostUsd: number | null;
}

function average(values: number[]): number | null {
  return values.length > 0 ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
}

function sum(values: number[]): number | null {
  return values.length > 0 ? values.reduce((sum, v) => sum + v, 0) : null;
}

export function summarizeTokenEfficiency(samples: RunTokenSample[]): TokenEfficiencyReport {
  const modes: Array<RunTokenSample["mode"]> = ["solo", "coordinated", "assurance", "collaborative"];
  const byMode = {} as Record<RunTokenSample["mode"], ModeTokenSummary>;

  for (const mode of modes) {
    const inMode = samples.filter((s) => s.mode === mode);
    const known = inMode.filter((s) => typeof s.knownTokens === "number");
    const knownInput = inMode.filter((s) => typeof s.knownInputTokens === "number").map((s) => s.knownInputTokens as number);
    const knownOutput = inMode.filter((s) => typeof s.knownOutputTokens === "number").map((s) => s.knownOutputTokens as number);
    const knownCost = inMode.filter((s) => typeof s.knownCostUsd === "number").map((s) => s.knownCostUsd as number);
    byMode[mode] = {
      runCount: inMode.length,
      knownTokenRuns: known.length,
      averageKnownTokens: known.length > 0 ? known.reduce((total, s) => total + (s.knownTokens ?? 0), 0) / known.length : null,
      averageKnownInputTokens: average(knownInput),
      averageKnownOutputTokens: average(knownOutput),
      totalKnownCostUsd: sum(knownCost),
      knownCostRuns: knownCost.length,
    };
  }

  const totalRuns = samples.length;
  const knownTotal = samples.filter((s) => typeof s.knownTokens === "number").length;
  const knownCostAll = samples.filter((s) => typeof s.knownCostUsd === "number").map((s) => s.knownCostUsd as number);
  return {
    byMode,
    totalRuns,
    unknownTokenCoverage: totalRuns === 0 ? 0 : 1 - knownTotal / totalRuns,
    totalKnownCostUsd: sum(knownCostAll),
  };
}

export interface FindingReuseReport {
  totalAvailable: number;
  adoptedCount: number;
  /** Null (not 0) when there are no available Findings to have a rate over. */
  reuseRate: number | null;
}

export function summarizeFindingReuse(available: Array<{ adoptedCount: number }>): FindingReuseReport {
  const totalAvailable = available.length;
  const adoptedCount = available.filter((f) => f.adoptedCount > 0).length;
  return {
    totalAvailable,
    adoptedCount,
    reuseRate: totalAvailable === 0 ? null : adoptedCount / totalAvailable,
  };
}

export interface CoordinationCostReport {
  coordinatedOrAssuranceRuns: number;
  /**
   * Runs that used coordination (requested help/a check) but were never
   * resolved with an accepted Response — the case the spec explicitly wants
   * surfaced: "coordination cost more than it helped."
   */
  unresolvedCoordinationRuns: number;
}

export function summarizeCoordinationCost(
  runs: Array<{ mode: "solo" | "coordinated" | "assurance" | "collaborative"; requestsIssued: number; requestsResolved: number }>,
): CoordinationCostReport {
  const coordinating = runs.filter((r) => r.mode !== "solo" && r.requestsIssued > 0);
  return {
    coordinatedOrAssuranceRuns: coordinating.length,
    unresolvedCoordinationRuns: coordinating.filter((r) => r.requestsResolved < r.requestsIssued).length,
  };
}
