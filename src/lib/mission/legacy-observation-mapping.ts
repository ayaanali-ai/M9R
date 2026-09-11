/**
 * Legacy observation mapping — the compatibility boundary
 * ----------------------------------------------------------------------------
 * Two incompatible state machines exist today: the legacy `RunStatus`
 * (`agent-run-core.ts`) and the legacy `AssignmentState` (`assignment.ts`,
 * `requested → accepted → … → completed`). Neither is replaced here — Phase 1
 * already decided that (see IMPLEMENTATION_NOTES.md, "not reused").
 *
 * This module only TRANSLATES both into one shared, coarser vocabulary that
 * reconciliation can compare against a Mission's state, without pretending
 * either legacy machine has been unified. Every mapping records whether it
 * lost information, and what, rather than presenting a clean translation that
 * quietly isn't one.
 */

import type { AssignmentState } from "@/lib/assignment";
import type { RunStatus } from "@/lib/agent-run-core";

/**
 * The shared vocabulary. Deliberately coarser than either source machine —
 * it exists only to answer "is this still live, waiting on a human, or
 * finished," which is all reconciliation needs.
 */
export const ORCHESTRATION_PHASES = [
  "queued",
  "working",
  "waiting_on_human",
  "completed",
  "failed",
  "cancelled",
  "unknown",
] as const;

export type NormalizedOrchestrationPhase = (typeof ORCHESTRATION_PHASES)[number];

export interface NormalizedOrchestrationObservation {
  sourceKind: "legacy_run" | "legacy_assignment";
  sourceId: string;
  phase: NormalizedOrchestrationPhase;
  observedAt: string | null;
  /** True when this mapping discarded information the source actually had. */
  lossy: boolean;
  lossNotes: string[];
}

/**
 * Run status → orchestration phase.
 *
 * Lossy points, recorded explicitly rather than smoothed over:
 *  - "started" cannot distinguish queued-but-not-yet-working from actively
 *    working, so it is mapped to the more useful "working" with a note.
 *  - "blocked" in RunStatus can mean blocked on many things, not only a
 *    human — mapped to "waiting_on_human" because that is reconciliation's
 *    only actionable bucket for it, with a note that the real cause may
 *    differ.
 *  - "submitted" means the agent handed over evidence, which is NOT the same
 *    claim as "a human accepted the outcome." Mapped to "completed" (the
 *    agent's work is done) with an explicit note that this is not acceptance.
 *  - "expired" is treated as "cancelled" for reconciliation purposes, though
 *    it is not an explicit cancellation decision by anyone.
 */
export function mapRunStatusToObservation(input: {
  runId: string;
  status: RunStatus;
  observedAt: string | null;
}): NormalizedOrchestrationObservation {
  const base = { sourceKind: "legacy_run" as const, sourceId: input.runId, observedAt: input.observedAt };

  switch (input.status) {
    case "started":
      return { ...base, phase: "working", lossy: true, lossNotes: ['"started" cannot distinguish queued from actively working; treated as working.'] };
    case "working":
      return { ...base, phase: "working", lossy: false, lossNotes: [] };
    case "blocked":
      return {
        ...base,
        phase: "waiting_on_human",
        lossy: true,
        lossNotes: ['"blocked" may be blocked on something other than a human decision; treated as waiting_on_human.'],
      };
    case "waiting_for_human":
      return { ...base, phase: "waiting_on_human", lossy: false, lossNotes: [] };
    case "submitted":
      return {
        ...base,
        phase: "completed",
        lossy: true,
        lossNotes: ['"submitted" means the agent returned evidence, not that a human accepted the outcome.'],
      };
    case "completed":
      return {
        ...base,
        phase: "completed",
        lossy: true,
        lossNotes: ['"completed" (agent_runs) reflects agent-reported completion, not a human Mission decision.'],
      };
    case "failed":
      return { ...base, phase: "failed", lossy: false, lossNotes: [] };
    case "expired":
      return {
        ...base,
        phase: "cancelled",
        lossy: true,
        lossNotes: ['"expired" is a timeout, not an explicit cancellation decision; treated as cancelled.'],
      };
  }
}

/**
 * Assignment state → orchestration phase.
 *
 * Lossy points:
 *  - "accepted" means the receiving agent may begin, not that it has —
 *    reconciliation cannot tell queued from working from this alone.
 *  - "rejected" is a decision not to proceed at all, distinct from
 *    "cancelled" (which usually means something that was proceeding got
 *    stopped) — mapped to cancelled anyway, since orchestration's shared
 *    vocabulary has no separate "declined" bucket, with a note.
 */
export function mapAssignmentStateToObservation(input: {
  assignmentId: string;
  state: AssignmentState;
  observedAt: string | null;
}): NormalizedOrchestrationObservation {
  const base = { sourceKind: "legacy_assignment" as const, sourceId: input.assignmentId, observedAt: input.observedAt };

  switch (input.state) {
    case "requested":
      return { ...base, phase: "queued", lossy: false, lossNotes: [] };
    case "accepted":
      return {
        ...base,
        phase: "working",
        lossy: true,
        lossNotes: ['"accepted" only means the assignee may begin; cannot distinguish queued from actively working.'],
      };
    case "rejected":
      return {
        ...base,
        phase: "cancelled",
        lossy: true,
        lossNotes: ['"rejected" is a decision not to proceed, distinct from a cancellation of in-progress work; no separate bucket exists.'],
      };
    case "cancelled":
      return { ...base, phase: "cancelled", lossy: false, lossNotes: [] };
    case "expired":
      return {
        ...base,
        phase: "failed",
        lossy: true,
        lossNotes: ['"expired" (assignment) is a timeout, not an explicit failure; treated as failed for reconciliation purposes.'],
      };
    case "completed":
      return { ...base, phase: "completed", lossy: false, lossNotes: [] };
  }
}
