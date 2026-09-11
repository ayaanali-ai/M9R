/**
 * Legacy Run → Mission compatibility mapping
 * ----------------------------------------------------------------------------
 * Spec IMPLEMENTATION_PLAN §2: "Build the Mission abstraction over existing
 * Runs... Hide legacy complexity in the UI before removing it from storage."
 *
 * This module is READ-ONLY over legacy data. It changes no Run behavior and
 * writes nothing. It exists so the 166 real runs already recorded can appear
 * inside Missions retroactively, rather than the new surface launching empty.
 *
 * The mapping is deliberately lossy in one direction only: a Run's status is
 * narrower than a Mission's state, so every Run maps to exactly one Mission
 * state, but not every Mission state has a Run equivalent. Where a Run cannot
 * justify a richer state, the mapping returns the conservative one instead of
 * inventing progress.
 */

import type { RunStatus } from "@/lib/agent-run-core";
import type { ActiveMissionState, MissionState, StateReason } from "./mission-domain";

/**
 * Legacy Run status → Mission state.
 *
 * Notes on the non-obvious choices:
 *  - `waiting_for_human` becomes `needs_input`, not `blocked`: the work is
 *    fine, it is waiting on a person.
 *  - `submitted` becomes `ready_for_decision`: evidence exists and a human
 *    still owes a decision. It is NOT `accepted` — that conflation is exactly
 *    what made "submitted" read as "done" in the current UI.
 *  - `completed` also becomes `ready_for_decision` rather than `accepted`.
 *    A Run marked completed means the AGENT finished, which is not a human
 *    acceptance of the outcome.
 */
const RUN_STATUS_TO_MISSION_STATE: Readonly<Record<RunStatus, MissionState>> = {
  started: "initializing",
  working: "executing",
  blocked: "blocked",
  waiting_for_human: "needs_input",
  submitted: "ready_for_decision",
  completed: "ready_for_decision",
  failed: "failed",
  expired: "cancelled",
} as const;

export interface LegacyRunInput {
  id: string;
  status: RunStatus;
  taskTitle: string | null;
  repoHint: string | null;
  startedAt: string | null;
  completedAt: string | null;
  lastSeenAt: string | null;
}

export interface LegacyMissionView {
  /** Derived, stable Mission identity for this legacy run. */
  missionId: string;
  sourceRunId: string;
  goal: string;
  repository: string;
  state: MissionState;
  resumeTo: ActiveMissionState | null;
  reason: StateReason | null;
  /** True when this view was derived from legacy data rather than authored. */
  derivedFromLegacyRun: true;
  /** Inconsistencies found in the legacy row, surfaced rather than hidden. */
  inconsistencies: string[];
}

export function mapRunStatusToMissionState(status: RunStatus): MissionState {
  return RUN_STATUS_TO_MISSION_STATE[status];
}

/**
 * Project a legacy Run into a Mission-shaped read model.
 *
 * Known-real data problem this surfaces rather than hides: runs exist with a
 * `completed_at` timestamp while still carrying a live status. The mapping
 * reports that as an inconsistency instead of silently trusting either field —
 * repairing those rows is reconciliation work, not mapping work.
 */
export function mapLegacyRunToMission(run: LegacyRunInput): LegacyMissionView {
  const inconsistencies: string[] = [];

  const liveStatuses: readonly RunStatus[] = ["started", "working", "blocked", "waiting_for_human"];
  if (run.completedAt && liveStatuses.includes(run.status)) {
    inconsistencies.push(
      `Run has completed_at (${run.completedAt}) but status "${run.status}" — state is unreliable until reconciled.`,
    );
  }
  if (!run.startedAt) {
    inconsistencies.push("Run has no started_at timestamp.");
  }

  const state = mapRunStatusToMissionState(run.status);

  // Legacy rows never recorded where an interruption should resume to, so we
  // do not fabricate one. Reconciliation supplies it later if it can.
  const resumeTo: ActiveMissionState | null = null;

  const reason: StateReason | null =
    state === "blocked" || state === "needs_input" || state === "failed" || state === "cancelled"
      ? {
          code: "legacy_run_mapping",
          summary: `Derived from legacy run status "${run.status}".`,
          relatedEntityIds: [run.id],
          recoverable: state !== "failed",
          suggestedActions: ["Reconcile this run against provider and runtime state."],
        }
      : null;

  return {
    missionId: `legacy:${run.id}`,
    sourceRunId: run.id,
    goal: run.taskTitle?.trim() || "Untitled work",
    repository: run.repoHint?.trim() || "unknown",
    state,
    resumeTo,
    reason,
    derivedFromLegacyRun: true,
    inconsistencies,
  };
}

/**
 * Group legacy runs into Missions.
 *
 * Hybrid sourcing (auto-derive now, manual override later): runs are grouped
 * by repository + normalized task title, so re-runs of the same work collapse
 * into one Mission rather than adding rows. Grouping is intentionally
 * conservative — an imperfect merge is fixable by hand, whereas silently
 * splitting related work is invisible.
 */
export function groupLegacyRunsIntoMissions(runs: readonly LegacyRunInput[]): Map<string, LegacyMissionView[]> {
  const groups = new Map<string, LegacyMissionView[]>();

  for (const run of runs) {
    const view = mapLegacyRunToMission(run);
    const key = `${view.repository}::${view.goal.toLowerCase().replace(/\s+/g, " ").trim()}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(view);
    else groups.set(key, [view]);
  }

  return groups;
}
