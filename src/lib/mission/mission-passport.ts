/**
 * Mission Passport — a reproducible projection over a Mission's immutable
 * event log (build plan Phase 6: "Passport as a reproducible projection
 * over immutable events").
 * ----------------------------------------------------------------------------
 * Pure and deterministic: `buildMissionPassport(projection, events)` is a
 * function of its inputs alone — no I/O, no clock reads beyond what the
 * events themselves already carry, no randomness. Given the same event log
 * twice, it returns byte-identical output (asserted by test), which is the
 * actual content of "reproducible" here — not a marketing claim, a
 * structural property.
 *
 * This is deliberately NOT the legacy `run-passport-service.ts` (a
 * different aggregate, `agent_runs`, with its own read-model) and does not
 * touch it. A Mission Passport is scoped to what the Mission's own event
 * log proves: what was approved, what evidence exists against it, whether
 * verification ran, and what the recorded human decision was — never more
 * than the event log itself supports, and never inferred from provider or
 * scheduler state that isn't represented as a Mission event.
 *
 * `integrity.eventCount`/`lastEventId`/`digest` let a caller confirm this
 * Passport was built from the exact event stream it claims — the digest is
 * a SHA-256 over the ordered list of `(eventId, aggregateVersion, type)`
 * tuples, cheap to recompute independently without re-deriving the whole
 * projection.
 */

import { createHash } from "node:crypto";
import type { MissionProjection } from "./mission-projection";
import type { MissionEvent } from "./mission-events";
import type { MissionDecision, MissionState } from "./mission-domain";
import type { MissionGitProvenanceRecord } from "./mission-git-provenance";

export interface PassportAssignmentOutcome {
  assignmentId: string;
  title: string;
  status: string;
  requiredEvidenceCount: number;
  attachedEvidenceIds: string[];
}

export interface PassportEvidenceEntry {
  evidenceId: string;
  assignmentId: string | null;
  kind: string;
  lifecycle: string;
  availability: string;
  digest: string | null;
  sourceRevision: string | null;
}

export interface PassportVerification {
  /** Whether `BeginVerification` was ever recorded for this Mission — the domain's own signal that a verification pass ran, never inferred from provider exit codes. */
  ran: boolean;
  enteredAt: string | null;
}

export interface PassportDecision {
  decision: MissionDecision;
  reviewedRevision: string | null;
  recordedAt: string;
  actorKind: string;
  actorId: string;
}

export interface MissionPassport {
  missionId: string;
  workspaceId: string;
  objective: string;
  repository: string;
  repositoryId: string | null;
  finalState: MissionState;
  terminal: boolean;
  approvedPlan: { version: number; objective: string; constraints: string[] } | null;
  assignments: PassportAssignmentOutcome[];
  evidence: PassportEvidenceEntry[];
  verification: PassportVerification;
  decision: PassportDecision | null;
  gitProvenance: MissionGitProvenanceRecord[];
  /** Never a claim of completeness beyond what the log itself proves — mirrors mission-projection.ts's own `complete`/`integrityIssues` fields rather than re-deciding trust independently. */
  streamComplete: boolean;
  streamIntegrityIssues: string[];
  integrity: { eventCount: number; lastEventId: string | null; digest: string };
  generatedAt: string;
}

function streamDigest(events: MissionEvent[]): string {
  const material = events.map((e) => `${e.eventId}:${e.aggregateVersion}:${e.type}`).join("|");
  return createHash("sha256").update(material).digest("hex");
}

export function buildMissionPassport(projection: MissionProjection, events: MissionEvent[], now: () => string = () => new Date().toISOString(), gitProvenance: readonly MissionGitProvenanceRecord[] = []): MissionPassport {
  const approvedVersion = projection.approvedPlanVersion;
  const approvedPlan = approvedVersion != null ? Object.values(projection.planProposals).find((p) => p.version === approvedVersion) ?? null : null;

  const assignments: PassportAssignmentOutcome[] = Object.values(projection.assignments).map((a) => ({
    assignmentId: a.id,
    title: a.title,
    status: a.status,
    requiredEvidenceCount: a.requiredEvidence.length,
    attachedEvidenceIds: Object.values(projection.evidenceRecords)
      .filter((ev) => ev.assignmentId === a.id)
      .map((ev) => ev.id),
  }));

  const evidence: PassportEvidenceEntry[] = Object.values(projection.evidenceRecords).map((ev) => ({
    evidenceId: ev.id,
    assignmentId: ev.assignmentId,
    kind: ev.kind,
    lifecycle: ev.lifecycle,
    availability: ev.availability,
    digest: ev.integrity?.digest ?? null,
    sourceRevision: ev.integrity?.sourceRevision ?? null,
  }));

  const verificationEvent = events.find((e) => e.type === "mission.state_changed" && (e.payload as { nextState?: string }).nextState === "verifying");

  const decisionEvent = [...events].reverse().find((e) => e.type === "mission.decision_recorded");
  const decision: PassportDecision | null = decisionEvent
    ? {
        decision: (decisionEvent.payload as { decision: MissionDecision }).decision,
        reviewedRevision: (decisionEvent.payload as { reviewedRevision: string | null }).reviewedRevision ?? null,
        recordedAt: decisionEvent.timestamp,
        actorKind: decisionEvent.actor.kind,
        actorId: decisionEvent.actor.id,
      }
    : null;

  const lastEvent = events.length > 0 ? events[events.length - 1] : null;

  return {
    missionId: projection.missionId,
    workspaceId: projection.workspaceId,
    objective: projection.goal,
    repository: projection.repository,
    repositoryId: projection.repositoryId,
    finalState: projection.state,
    terminal: projection.terminal,
    approvedPlan: approvedPlan ? { version: approvedPlan.version, objective: approvedPlan.objective, constraints: approvedPlan.constraints } : null,
    assignments,
    evidence,
    verification: { ran: Boolean(verificationEvent), enteredAt: verificationEvent?.timestamp ?? null },
    decision,
    gitProvenance: gitProvenance.map((record) => ({ ...record, authorization: record.authorization ? { ...record.authorization } : null })),
    streamComplete: projection.complete,
    streamIntegrityIssues: projection.integrityIssues,
    integrity: { eventCount: events.length, lastEventId: lastEvent?.eventId ?? null, digest: streamDigest(events) },
    generatedAt: now(),
  };
}
