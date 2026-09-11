/**
 * Mission UI presenter — pure derivation functions consumed by the Mission
 * dashboard pages/components. No I/O, no React, no DOM: exactly the "extract
 * the logic, unit-test the module, keep the component a thin wrapper"
 * convention already used by agent-dashboard-presenter.ts (see
 * scripts/agent-dashboard-presenter.test.ts) — this repo has no jsdom/RTL,
 * so anything worth unit-testing about the Mission UI has to live here, not
 * inside a component body.
 */

import type { MissionState } from "./mission-domain";
import type {
  MissionAssignmentDto,
  MissionEvidenceDto,
  MissionExecutionDto,
  MissionSummaryDto,
  TimelineEntryDto,
} from "./mission-application-service";

// ---------------------------------------------------------------------------
// Status -> lozenge tone
// ---------------------------------------------------------------------------

export type PresenterTone = "neutral" | "active" | "draft" | "review" | "archived" | "ok" | "warn" | "danger" | "info" | "stale";

const MISSION_STATE_TONE: Record<MissionState, PresenterTone> = {
  draft: "draft",
  planning: "info",
  ready: "info",
  needs_input: "warn",
  initializing: "info",
  executing: "active",
  reviewing: "review",
  verifying: "review",
  blocked: "warn",
  paused: "stale",
  ready_for_decision: "review",
  accepted: "ok",
  rejected: "danger",
  cancelled: "archived",
  failed: "danger",
};

export function missionStateTone(state: MissionState): PresenterTone {
  return MISSION_STATE_TONE[state] ?? "neutral";
}

export function missionStateLabel(state: MissionState): string {
  return state.replace(/_/g, " ");
}

/**
 * Four-phase progress track for the Mission status bar. Only the states on
 * the actual happy path (draft/planning -> ready/initializing/executing ->
 * reviewing/verifying/ready_for_decision -> accepted) map to a phase index --
 * every interruption (needs_input, blocked, paused) and unsuccessful
 * terminal (rejected, cancelled, failed) is deliberately NOT forced onto the
 * track. There is no reliable prior-phase signal available on the client
 * (MissionSummaryDto carries only the current state, not history), so
 * guessing a "frozen at phase N" position for an exception state would
 * assert positional precision the data doesn't support. Exceptions instead
 * render as a distinct plain-language reason, tone-matched via
 * missionStateTone -- the same source of truth every other exception
 * rendering in this module already uses.
 */
export type MissionProgressPhase =
  | { kind: "phase"; index: 0 | 1 | 2 | 3 }
  | { kind: "exception"; tone: PresenterTone; reason: string };

const MISSION_PROGRESS_PHASE_INDEX: Partial<Record<MissionState, 0 | 1 | 2 | 3>> = {
  draft: 0,
  planning: 0,
  ready: 1,
  initializing: 1,
  executing: 1,
  reviewing: 2,
  verifying: 2,
  ready_for_decision: 2,
  accepted: 3,
};

const MISSION_EXCEPTION_REASON: Partial<Record<MissionState, string>> = {
  needs_input: "Waiting on your input",
  blocked: "Blocked — waiting on your decision",
  paused: "Paused",
  rejected: "Rejected",
  cancelled: "Cancelled",
  failed: "Failed",
};

export function missionProgressPhase(state: MissionState): MissionProgressPhase {
  const index = MISSION_PROGRESS_PHASE_INDEX[state];
  if (index !== undefined) return { kind: "phase", index };
  return { kind: "exception", tone: missionStateTone(state), reason: MISSION_EXCEPTION_REASON[state] ?? missionStateLabel(state) };
}

const TERMINAL_MISSION_STATES = new Set<MissionState>(["accepted", "rejected", "cancelled", "failed"]);

/** Whether a Mission's state should keep polling for updates — mirrors the domain's own terminal-state notion, never re-derived independently. */
export function isMissionPollable(state: MissionState): boolean {
  return !TERMINAL_MISSION_STATES.has(state);
}

/** Should a list of Missions keep polling? Yes iff at least one is non-terminal. */
export function shouldPollMissionList(missions: Array<{ state: MissionState }>): boolean {
  return missions.some((m) => isMissionPollable(m.state));
}

// ---------------------------------------------------------------------------
// Lifecycle control availability — never inferred from provider state, only
// from the Mission's own reported state (MissionSummaryDto.state).
// ---------------------------------------------------------------------------

export type LifecycleAction = "start" | "pause" | "resume" | "stop" | "cancel" | "requestReview";

const STARTABLE_STATES = new Set<MissionState>(["draft", "ready", "initializing"]);
// PauseMission targets "paused" — only legal from a state whose
// MISSION_TRANSITIONS row (mission-state-machine.ts) actually lists
// "paused". "initializing" -> ["executing","blocked","failed","cancelled"]
// has no "paused" edge; a fixed bug (this set previously included it,
// which meant the UI offered a Pause button the domain refused with a 409
// every time — caught by an audit against the real state machine, not by
// a user hitting it first).
const PAUSABLE_STATES = new Set<MissionState>(["executing", "reviewing", "verifying"]);
const RESUMABLE_STATES = new Set<MissionState>(["paused", "blocked", "needs_input"]);
// StopMission targets "blocked" (via BlockMission) — only legal from a
// state whose MISSION_TRANSITIONS row lists "blocked". "needs_input" ->
// [...ACTIVE_MISSION_STATES, "cancelled", "failed"] has no "blocked" edge
// (ACTIVE_MISSION_STATES itself never includes "blocked") — same class of
// bug as PAUSABLE_STATES above, fixed the same way: cross-checked against
// the actual transition table instead of assumed.
const STOPPABLE_STATES = new Set<MissionState>(["initializing", "executing", "reviewing", "verifying"]);
const REVIEW_REQUESTABLE_STATES = new Set<MissionState>(["executing"]);

/** Available lifecycle actions for a Mission's current state — drives which control buttons a page renders. Never shows a control the API would refuse outright. */
export function availableLifecycleActions(state: MissionState): LifecycleAction[] {
  if (TERMINAL_MISSION_STATES.has(state)) return [];
  const actions: LifecycleAction[] = [];
  if (STARTABLE_STATES.has(state)) actions.push("start");
  if (PAUSABLE_STATES.has(state)) actions.push("pause");
  if (RESUMABLE_STATES.has(state)) actions.push("resume");
  if (STOPPABLE_STATES.has(state)) actions.push("stop");
  if (REVIEW_REQUESTABLE_STATES.has(state)) actions.push("requestReview");
  actions.push("cancel"); // cancel is refusable by the domain (mission_terminal) but always plausibly offered for any non-terminal Mission.
  return actions;
}

export const DESTRUCTIVE_LIFECYCLE_ACTIONS = new Set<LifecycleAction>(["stop", "cancel"]);

/** Whether clicking this lifecycle action must go through a confirmation dialog before firing. Kept as a named predicate (not inlined at the call site) so the "destructive = confirm-gated" rule is one testable fact, not something duplicated per button. */
export function requiresConfirmation(action: LifecycleAction): boolean {
  return DESTRUCTIVE_LIFECYCLE_ACTIONS.has(action);
}

export function lifecycleActionLabel(action: LifecycleAction): string {
  switch (action) {
    case "start":
      return "Start";
    case "pause":
      return "Pause";
    case "resume":
      return "Resume";
    case "stop":
      return "Stop";
    case "cancel":
      return "Cancel";
    case "requestReview":
      return "Request review";
  }
}

// ---------------------------------------------------------------------------
// Review decision controls — human-only. `principalKind` comes from the
// server-resolved session, never guessed client-side.
// ---------------------------------------------------------------------------

export type PrincipalKind = "human" | "agent" | "unknown";

/** Whether the CURRENT VIEWER may see usable accept/reject controls. Bearer/agent principals never do — matches the API route's `requireHuman: true` gate at the service layer, enforced again here so the UI never renders a control that would only fail server-side. */
export function canRenderReviewDecisionControls(principalKind: PrincipalKind, state: MissionState): boolean {
  if (principalKind !== "human") return false;
  return state === "reviewing" || state === "verifying" || state === "ready_for_decision";
}

export function reviewStatusLabel(state: MissionState): string {
  switch (state) {
    case "reviewing":
    case "verifying":
      return "In review";
    case "ready_for_decision":
      return "Awaiting decision";
    case "accepted":
      return "Accepted";
    case "rejected":
      return "Rejected";
    default:
      return "Not started";
  }
}

/** A stale review decision (Mission moved on since the reviewer loaded the page) is a distinct, precise conflict — never rendered as a generic error. */
export function isStaleReviewConflict(errorCode: string | null | undefined): boolean {
  return errorCode === "version_conflict";
}

// ---------------------------------------------------------------------------
// Assignment / execution / evidence display helpers
// ---------------------------------------------------------------------------

export function assignmentStatusTone(status: string): PresenterTone {
  switch (status) {
    case "working":
    case "assigned":
      return "active";
    case "under_review":
      return "review";
    case "accepted":
    case "verified":
      return "ok";
    case "blocked":
      return "warn";
    case "rejected":
    case "cancelled":
      return "danger";
    case "queued":
    case "draft":
      return "draft";
    default:
      return "neutral";
  }
}

export function executionStatusTone(status: string): PresenterTone {
  switch (status) {
    case "started":
      return "active";
    case "completed":
      return "ok";
    case "failed":
    case "lease_lost":
      return "danger";
    case "cancelled":
      return "archived";
    default:
      return "neutral";
  }
}

export interface EvidenceProvenanceLabel {
  label: string;
  tone: PresenterTone;
}

/**
 * Maps `MissionEvidenceRecord.lifecycle` to a plain-language provenance
 * label. The four stages the spec calls out — submitted / recorded /
 * reviewed / accepted — are distinct display states, never collapsed: a
 * `captured` record reads as "submitted", `validated`/`attached` as
 * "recorded", `attested` as "reviewed", `accepted` as "accepted". Execution
 * completion (an executions-tab concept) never appears here — evidence
 * provenance is reported ONLY from the evidence record's own lifecycle
 * field, so a completed execution can never visually imply approval.
 */
export function evidenceProvenanceLabel(lifecycle: string): EvidenceProvenanceLabel {
  switch (lifecycle) {
    case "captured":
      return { label: "Submitted", tone: "neutral" };
    case "validated":
    case "attached":
      return { label: "Recorded", tone: "info" };
    case "attested":
      return { label: "Reviewed", tone: "review" };
    case "accepted":
      return { label: "Accepted", tone: "ok" };
    default:
      return { label: lifecycle, tone: "neutral" };
  }
}

export function evidenceAvailabilityLabel(availability: string): string {
  switch (availability) {
    case "available":
      return "Available";
    case "invalid":
      return "Invalid";
    case "redacted":
      return "Redacted";
    case "unavailable":
      return "Unavailable";
    default:
      return availability;
  }
}

// ---------------------------------------------------------------------------
// Timeline — readable labels, bounded metadata, correlation grouping
// ---------------------------------------------------------------------------

const TIMELINE_EVENT_LABELS: Record<string, string> = {
  "mission.created": "Mission created",
  "mission.plan_proposed": "Plan proposed",
  "mission.plan_approved": "Plan approved",
  "mission.state_changed": "State changed",
  "mission.participant_added": "Participant added",
  "mission.participant_registered": "Participant registered",
  "mission.participant_status_changed": "Participant status changed",
  "mission.participant_removed": "Participant removed",
  "mission.assignment_created": "Assignment created",
  "mission.assignment_status_changed": "Assignment status changed",
  "mission.message_posted": "Message posted",
  "mission.finding_opened": "Finding opened",
  "mission.finding_status_changed": "Finding status changed",
  "mission.plan_proposal_created": "Plan proposal created",
  "mission.plan_proposal_status_changed": "Plan proposal status changed",
  "mission.evidence_attached": "Evidence attached",
  "mission.evidence_attested": "Evidence attested",
  "mission.evidence_recorded": "Evidence recorded",
  "mission.evidence_superseded": "Evidence superseded",
  "mission.decision_recorded": "Decision recorded",
  "mission.model_plan_request_created": "Planning request created",
  "mission.model_plan_request_status_changed": "Planning request status changed",
};

/** Readable label for a timeline entry — falls back to a de-namespaced, de-underscored version of the raw type rather than ever leaving a bare internal event name on screen. */
export function timelineEventLabel(type: string): string {
  return TIMELINE_EVENT_LABELS[type] ?? type.replace(/^mission\./, "").replace(/_/g, " ");
}

export function actorCategoryLabel(actorKind: string): string {
  switch (actorKind) {
    case "human":
      return "Human";
    case "agent":
      return "Agent";
    case "system":
      return "System";
    default:
      return actorKind;
  }
}

/** Group a page of timeline entries by correlationId, preserving first-seen order — lets the UI visually cluster every event one logical command produced. */
export function groupTimelineByCorrelation(entries: TimelineEntryDto[]): Array<{ correlationId: string; entries: TimelineEntryDto[] }> {
  const order: string[] = [];
  const groups = new Map<string, TimelineEntryDto[]>();
  for (const entry of entries) {
    if (!groups.has(entry.correlationId)) {
      groups.set(entry.correlationId, []);
      order.push(entry.correlationId);
    }
    groups.get(entry.correlationId)!.push(entry);
  }
  return order.map((correlationId) => ({ correlationId, entries: groups.get(correlationId)! }));
}

// ---------------------------------------------------------------------------
// Summary formatting shared by list + detail views
// ---------------------------------------------------------------------------

export function assignmentProgressLabel(summary: MissionSummaryDto["assignmentSummary"]): string {
  const total = Object.values(summary).reduce((sum, n) => sum + n, 0);
  if (total === 0) return "No assignments yet";
  const done = (summary.accepted ?? 0) + (summary.verified ?? 0);
  return `${done}/${total} complete`;
}

export function executionSummaryLabel(summary: MissionSummaryDto["executionSummary"]): string {
  if (summary.active === 0 && summary.terminal === 0) return "No executions yet";
  return `${summary.active} active · ${summary.terminal} finished`;
}

export function evidenceSummaryLabel(summary: MissionSummaryDto["evidenceSummary"]): string {
  if (summary.total === 0) return "No evidence yet";
  return `${summary.attested}/${summary.total} reviewed`;
}

export function reviewStatusDtoLabel(reviewStatus: MissionSummaryDto["reviewStatus"]): string {
  switch (reviewStatus) {
    case "not_started":
      return "Not started";
    case "reviewing":
      return "In review";
    case "accepted":
      return "Accepted";
    case "rejected":
      return "Rejected";
    default:
      return "In progress";
  }
}

export interface MissionSummaryRowView {
  stateLabel: string;
  stateTone: PresenterTone;
  planLabel: string;
  assignmentLabel: string;
  executionLabel: string;
  evidenceLabel: string;
  reviewLabel: string;
  updatedLabel: string;
}

/** Every field a Mission list/detail row needs to render, derived once from the DTO — the single place list and detail views agree on formatting. */
export function missionSummaryRowView(mission: MissionSummaryDto, now: number = Date.now()): MissionSummaryRowView {
  return {
    stateLabel: missionStateLabel(mission.state),
    stateTone: missionStateTone(mission.state),
    planLabel:
      mission.planStatus.approvedVersion != null
        ? `Plan v${mission.planStatus.approvedVersion} approved`
        : `Plan v${mission.planStatus.proposedVersion} proposed`,
    assignmentLabel: assignmentProgressLabel(mission.assignmentSummary),
    executionLabel: executionSummaryLabel(mission.executionSummary),
    evidenceLabel: evidenceSummaryLabel(mission.evidenceSummary),
    reviewLabel: reviewStatusDtoLabel(mission.reviewStatus),
    updatedLabel: mission.updatedAt ? relativeTime(mission.updatedAt, now) : "—",
  };
}

/** Relative time, matching the "Xs/Xm/Xh ago" convention already used by LiveRunsPanel.tsx (`rel()`), reused here so Mission timestamps read the same way as run timestamps elsewhere in the dashboard. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const secs = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

export function shortId(id: string, length = 8): string {
  return id.length > length ? id.slice(0, length) : id;
}

// ---------------------------------------------------------------------------
// Typed API error rendering — never a generic "Something went wrong."
// ---------------------------------------------------------------------------

export interface MissionApiErrorLike {
  error?: string;
  code?: string;
}

const FRIENDLY_ERROR_MESSAGE: Record<string, string> = {
  mission_not_found: "This Mission was not found.",
  workspace_mismatch: "This Mission was not found.",
  version_conflict: "This Mission changed since the page loaded. Refresh and try again.",
  mission_terminal: "This Mission is finished and can no longer be changed.",
  unauthorized_command: "You are not authorized to perform this action.",
  unauthorized_approval: "You are not authorized to approve this.",
  unauthorized_plan_approval: "You are not authorized to approve this plan.",
  human_required: "Only a signed-in human can record this decision.",
  unauthenticated: "Sign in to continue.",
  validation_error: "Check the form and try again.",
  conflict: "This Mission cannot perform that action right now.",
  backend_not_configured: "The Mission service is not configured.",
};

export interface MissionCreateFormInput {
  objective: string;
  repository: string;
}

export interface MissionCreateFormErrors {
  objective?: string;
  repository?: string;
}

/** Pure validation for the Mission creation form — only fields the API actually requires (`goal`, `repository`); no invented domain fields. Extracted so this rule is unit-testable without jsdom, matching MissionCreateForm.tsx's own validate() call. */
export function validateMissionCreateInput(input: MissionCreateFormInput): MissionCreateFormErrors {
  const errors: MissionCreateFormErrors = {};
  if (!input.objective.trim()) errors.objective = "Objective is required.";
  if (!input.repository.trim()) errors.repository = "Repository is required.";
  return errors;
}

export function friendlyMissionErrorMessage(body: MissionApiErrorLike): string {
  if (body.code && FRIENDLY_ERROR_MESSAGE[body.code]) return FRIENDLY_ERROR_MESSAGE[body.code];
  if (body.error) return body.error;
  return "Something went wrong. Try again.";
}

// ---------------------------------------------------------------------------
// Redaction allowlists — asserted by tests so a future field addition to the
// DTOs can't silently leak internal identifiers into the UI without the
// presenter (and its test) being touched first.
// ---------------------------------------------------------------------------

export const ASSIGNMENT_DISPLAY_FIELDS: ReadonlyArray<keyof MissionAssignmentDto> = [
  "id",
  "title",
  "objective",
  "status",
  "assigneeParticipantId",
  "approvalPolicy",
  "parentAssignmentId",
  "dependencies",
];

export const EXECUTION_DISPLAY_FIELDS: ReadonlyArray<keyof MissionExecutionDto> = [
  "executionId",
  "assignmentId",
  "providerAdapterId",
  "attempt",
  "status",
  "startedAt",
  "terminalAt",
  "terminalReason",
  "evidenceIds",
];

export const EVIDENCE_DISPLAY_FIELDS: ReadonlyArray<keyof MissionEvidenceDto> = [
  "id",
  "assignmentId",
  "producerKind",
  "kind",
  "lifecycle",
  "availability",
  "source",
  "supersededByEvidenceId",
];

// ---------------------------------------------------------------------------
// Passport (Phase 6) — decision + verification labeling
// ---------------------------------------------------------------------------

const DECISION_LABELS: Record<string, string> = {
  accept: "Accepted",
  reject: "Rejected",
  request_changes: "Changes requested",
  continue_investigation: "Investigation continued",
  escalate: "Escalated",
};

export function missionDecisionLabel(decision: string): string {
  return DECISION_LABELS[decision] ?? decision.replace(/_/g, " ");
}

export function missionDecisionTone(decision: string): PresenterTone {
  switch (decision) {
    case "accept":
      return "ok";
    case "reject":
      return "danger";
    case "escalate":
      return "warn";
    default:
      return "info";
  }
}

/** Short digest form for on-screen display — never the full 64 hex chars inline, matching `shortId`'s existing convention for other identifiers. */
export function shortDigest(digest: string): string {
  return digest.slice(0, 12);
}
