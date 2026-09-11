/**
 * Agent Track Record (pure, server-free)
 * ----------------------------------------------------------------------------
 * Aggregates one agent's retained history — runs, human review decisions, and
 * command-tied verification results — into a compact record the Watchfloor can
 * show next to the agent.
 *
 * Truth contract (same rules as the rest of the workspace):
 *  - Every number is a count of retained records: runs, saved review decisions
 *    (run-review-decision-service), and command-tied verification provenance.
 *  - There is no synthetic score. Standing is a coarse label derived from the
 *    counts, and it stays at "building" until enough human decisions exist to
 *    mean anything (MIN_DECIDED_FOR_STANDING).
 *  - An empty record is reported as exactly that — never dressed up.
 *
 * IO-free so the aggregation is unit-testable without a DB or React.
 */

import type { RunReviewDecision } from "@/lib/run-review-decision-service";

/** Structural subset of a run row — anything with an id qualifies. */
export interface TrackRecordRun {
  id: string;
}

/** Structural subset of a Run Passport — only the fields the record reads. */
export interface TrackRecordPassport {
  run_id: string;
  submitted_at?: string | null;
  human_review: { decision: RunReviewDecision | null; reviewed_at: string | null };
  evidence: {
    verification_provenance: Array<{ result: "passed" | "failed" }>;
    changed_files?: string[];
  };
}

/** Human decisions required before the record claims any standing beyond "building". */
export const MIN_DECIDED_FOR_STANDING = 3;

/** Reviewed share (of decided runs) at or above which standing is "consistent". */
export const CONSISTENT_APPROVAL_RATE = 0.7;

export type TrackRecordStanding =
  /** No human review decision retained yet. */
  | "no_record"
  /** Decisions exist but fewer than MIN_DECIDED_FOR_STANDING. */
  | "building"
  /** Enough decisions, no rejections, reviewed share at/above threshold. */
  | "consistent"
  /** Enough decisions and at least one rejection or a low reviewed share. */
  | "attention";

export interface AgentTrackRecord {
  runsTotal: number;
  /** Runs with a saved human review decision. */
  decided: number;
  reviewed: number;
  needsFollowUp: number;
  notAccepted: number;
  /** Runs without a saved decision (still open, stale, or abandoned). */
  undecided: number;
  /** reviewed / decided. Null until at least one decision exists — never fabricated. */
  approvalRate: number | null;
  /** Passports carrying at least one command-tied verification result. */
  verificationRan: number;
  /** Of those, passports where every command-tied result passed. */
  verificationClean: number;
  /**
   * Reviewed runs whose changed files were later touched by another run's
   * recorded evidence. A weak proxy for reverts/rework — it is reported as a
   * signal only and deliberately does NOT move standing; only saved human
   * decisions do that.
   */
  reworkSignals: number;
  lastDecision: { decision: RunReviewDecision; reviewedAt: string | null } | null;
  standing: TrackRecordStanding;
}

const STANDING_LABELS: Record<TrackRecordStanding, string> = {
  no_record: "No reviewed runs yet",
  building: "Record building",
  consistent: "Consistent record",
  attention: "Needs attention",
};

export function trackRecordStandingLabel(standing: TrackRecordStanding): string {
  return STANDING_LABELS[standing];
}

function deriveStanding(record: Pick<AgentTrackRecord, "decided" | "reviewed" | "notAccepted">): TrackRecordStanding {
  if (record.decided === 0) return "no_record";
  if (record.decided < MIN_DECIDED_FOR_STANDING) return "building";
  if (record.notAccepted > 0) return "attention";
  return record.reviewed / record.decided >= CONSISTENT_APPROVAL_RATE ? "consistent" : "attention";
}

/**
 * A reviewed passport gains a rework signal when ANOTHER run's evidence,
 * recorded after the review decision, touches one of the same files. Missing
 * timestamps or file manifests mean no signal — never a guessed one.
 */
function hasReworkSignal(reviewed: TrackRecordPassport, all: TrackRecordPassport[]): boolean {
  const reviewedAtMs = Date.parse(reviewed.human_review.reviewed_at ?? "");
  const files = reviewed.evidence.changed_files ?? [];
  if (!Number.isFinite(reviewedAtMs) || files.length === 0) return false;
  const fileSet = new Set(files);
  return all.some((later) => {
    if (later.run_id === reviewed.run_id) return false;
    const submittedMs = Date.parse(later.submitted_at ?? "");
    if (!Number.isFinite(submittedMs) || submittedMs <= reviewedAtMs) return false;
    return (later.evidence.changed_files ?? []).some((file) => fileSet.has(file));
  });
}

/**
 * Build one agent's track record from its runs and the passports for those
 * runs. Passports for other agents' runs are ignored via the run-id join for
 * counting, but still scanned for rework signals — so callers should pass the
 * full workspace passport list unfiltered.
 */
export function buildAgentTrackRecord(
  runs: TrackRecordRun[],
  passports: TrackRecordPassport[],
): AgentTrackRecord {
  const runIds = new Set(runs.map((run) => run.id));
  const owned = passports.filter((passport) => runIds.has(passport.run_id));

  let reviewed = 0;
  let needsFollowUp = 0;
  let notAccepted = 0;
  let verificationRan = 0;
  let verificationClean = 0;
  let reworkSignals = 0;
  let lastDecision: AgentTrackRecord["lastDecision"] = null;
  let lastDecisionMs = -1;

  for (const passport of owned) {
    const decision = passport.human_review.decision;
    if (decision === "reviewed") reviewed += 1;
    else if (decision === "needs_follow_up") needsFollowUp += 1;
    else if (decision === "not_accepted") notAccepted += 1;

    if (decision) {
      const at = passport.human_review.reviewed_at;
      const atMs = at ? Date.parse(at) || 0 : 0;
      if (atMs >= lastDecisionMs) {
        lastDecisionMs = atMs;
        lastDecision = { decision, reviewedAt: at };
      }
    }

    const provenance = passport.evidence.verification_provenance;
    if (provenance.length > 0) {
      verificationRan += 1;
      if (provenance.every((entry) => entry.result === "passed")) verificationClean += 1;
    }

    if (decision === "reviewed" && hasReworkSignal(passport, passports)) reworkSignals += 1;
  }

  const decided = reviewed + needsFollowUp + notAccepted;
  const record = {
    runsTotal: runIds.size,
    decided,
    reviewed,
    needsFollowUp,
    notAccepted,
    undecided: runIds.size - decided,
    approvalRate: decided > 0 ? reviewed / decided : null,
    verificationRan,
    verificationClean,
    reworkSignals,
    lastDecision,
  };
  return { ...record, standing: deriveStanding(record) };
}
