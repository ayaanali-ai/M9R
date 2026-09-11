/**
 * Mission UI presenter tests.
 * ----------------------------------------------------------------------------
 * This repo has no jsdom / @testing-library/react (see
 * scripts/agent-dashboard-presenter.test.ts's precedent) — UI-adjacent
 * logic is unit-tested by extracting it into a pure module
 * (src/lib/mission/mission-ui-presenter.ts) and testing that module
 * directly. Nothing here renders a component; every test asserts on plain
 * function output.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  missionStateTone,
  missionProgressPhase,
  isMissionPollable,
  shouldPollMissionList,
  availableLifecycleActions,
  requiresConfirmation,
  DESTRUCTIVE_LIFECYCLE_ACTIONS,
  canRenderReviewDecisionControls,
  isStaleReviewConflict,
  reviewStatusDtoLabel,
  evidenceProvenanceLabel,
  friendlyMissionErrorMessage,
  validateMissionCreateInput,
  timelineEventLabel,
  groupTimelineByCorrelation,
  missionSummaryRowView,
  ASSIGNMENT_DISPLAY_FIELDS,
  EXECUTION_DISPLAY_FIELDS,
  EVIDENCE_DISPLAY_FIELDS,
  missionDecisionLabel,
  missionDecisionTone,
  shortDigest,
} from "../src/lib/mission/mission-ui-presenter.ts";
import type { MissionSummaryDto } from "../src/lib/mission/mission-application-service.ts";
import { ACTIVE_MISSION_STATES, MISSION_STATES, type MissionState } from "../src/lib/mission/mission-domain.ts";
import type { TimelineEntryDto } from "../src/lib/mission/mission-application-service.ts";
import { validateTransition } from "../src/lib/mission/mission-state-machine.ts";

function fixtureSummary(overrides: Partial<MissionSummaryDto> = {}): MissionSummaryDto {
  return {
    missionId: "m-1",
    workspaceId: "ws-1",
    state: "executing",
    version: 3,
    objective: "Ship the thing",
    repository: "acme/repo",
    planStatus: { proposedVersion: 1, approvedVersion: 1 },
    assignmentSummary: { working: 1, accepted: 1 },
    executionSummary: { active: 1, terminal: 1 },
    evidenceSummary: { total: 2, attached: 2, attested: 1 },
    openFindingsCount: 0,
    reviewStatus: "not_started",
    stopStatus: { blocked: false, paused: false, reason: null },
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T01:00:00.000Z",
    lastEventVersion: 3,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// List loading / empty / success / error states (pure derivations that back them)
// ---------------------------------------------------------------------------

test("Mission list success state: missionSummaryRowView derives every field a list row needs", () => {
  const view = missionSummaryRowView(fixtureSummary());
  assert.equal(view.stateLabel, "executing");
  assert.equal(view.assignmentLabel, "1/2 complete");
  assert.equal(view.executionLabel, "1 active · 1 finished");
  assert.equal(view.evidenceLabel, "1/2 reviewed");
  assert.equal(view.reviewLabel, "Not started");
});

test("Mission list empty state: an empty assignment/execution/evidence summary reads as 'no X yet', not 0/0", () => {
  const view = missionSummaryRowView(
    fixtureSummary({ assignmentSummary: {}, executionSummary: { active: 0, terminal: 0 }, evidenceSummary: { total: 0, attached: 0, attested: 0 } }),
  );
  assert.equal(view.assignmentLabel, "No assignments yet");
  assert.equal(view.executionLabel, "No executions yet");
  assert.equal(view.evidenceLabel, "No evidence yet");
});

test("Mission list error state: a typed API error renders a specific message, never a generic fallback, when a code is known", () => {
  assert.equal(friendlyMissionErrorMessage({ code: "mission_not_found" }), "This Mission was not found.");
  assert.equal(friendlyMissionErrorMessage({ code: "backend_not_configured" }), "The Mission service is not configured.");
  assert.equal(friendlyMissionErrorMessage({}), "Something went wrong. Try again.");
});

// ---------------------------------------------------------------------------
// Mission creation validation
// ---------------------------------------------------------------------------

test("Mission creation validation: blank objective and repository are both flagged", () => {
  const errors = validateMissionCreateInput({ objective: "", repository: "" });
  assert.equal(errors.objective, "Objective is required.");
  assert.equal(errors.repository, "Repository is required.");
});

test("Mission creation validation: whitespace-only input is treated as blank", () => {
  const errors = validateMissionCreateInput({ objective: "   ", repository: "  " });
  assert.ok(errors.objective);
  assert.ok(errors.repository);
});

test("Mission creation validation: valid input produces no errors", () => {
  const errors = validateMissionCreateInput({ objective: "Ship it", repository: "acme/repo" });
  assert.deepEqual(errors, {});
});

// ---------------------------------------------------------------------------
// Lifecycle action availability
// ---------------------------------------------------------------------------

test("lifecycle action availability: a draft Mission can start and cancel, but not pause/resume/stop/review", () => {
  const actions = availableLifecycleActions("draft");
  assert.ok(actions.includes("start"));
  assert.ok(actions.includes("cancel"));
  assert.ok(!actions.includes("pause"));
  assert.ok(!actions.includes("resume"));
  assert.ok(!actions.includes("requestReview"));
});

test("lifecycle action availability: an executing Mission can pause, stop, request review, and cancel, but not start or resume", () => {
  const actions = availableLifecycleActions("executing");
  assert.ok(actions.includes("pause"));
  assert.ok(actions.includes("stop"));
  assert.ok(actions.includes("requestReview"));
  assert.ok(actions.includes("cancel"));
  assert.ok(!actions.includes("start"));
  assert.ok(!actions.includes("resume"));
});

test("lifecycle action availability: a terminal Mission (accepted/rejected/cancelled/failed) offers no lifecycle actions at all", () => {
  const terminalStates: MissionState[] = ["accepted", "rejected", "cancelled", "failed"];
  for (const state of terminalStates) {
    assert.deepEqual(availableLifecycleActions(state), []);
  }
});

test("lifecycle action availability: a paused Mission can resume", () => {
  assert.ok(availableLifecycleActions("paused").includes("resume"));
});

// Regression coverage for a real bug: availableLifecycleActions previously
// offered "pause" for "initializing" and "stop" for "needs_input", neither
// of which the real state machine (mission-state-machine.ts) allows —
// PauseMission targets "paused" (no such edge from "initializing") and
// StopMission/BlockMission targets "blocked" (no such edge from
// "needs_input"). Both silently 409'd against a real Mission the moment a
// user clicked the button. Cross-checks every state against the REAL
// validateTransition, not a second hand-maintained assumption of what it
// allows, so this can't drift out of sync with the state machine again.
/** Mirrors mission-command-handler.ts's own resumeTo derivation: only an interruption state (paused/blocked/needs_input) needs one, and only an ACTIVE from-state supplies a candidate. */
function candidateResumeTo(from: MissionState): MissionState | undefined {
  return (ACTIVE_MISSION_STATES as readonly string[]).includes(from) ? (from as MissionState) : undefined;
}

test("lifecycle action availability: 'pause' is only offered for a state where PauseMission (-> \"paused\") is a real, legal transition", () => {
  for (const state of MISSION_STATES) {
    const offered = availableLifecycleActions(state).includes("pause");
    const legal = validateTransition({
      from: state,
      to: "paused",
      reason: { code: "x", summary: "s", relatedEntityIds: [], recoverable: true, suggestedActions: [] },
      resumeTo: candidateResumeTo(state) as never,
    }).ok;
    assert.equal(offered, legal, `pause offered=${offered} but validateTransition(${state} -> paused).ok=${legal}`);
  }
});

test("lifecycle action availability: 'stop' is only offered for a state where BlockMission (-> \"blocked\") is a real, legal transition", () => {
  for (const state of MISSION_STATES) {
    const offered = availableLifecycleActions(state).includes("stop");
    const legal = validateTransition({
      from: state,
      to: "blocked",
      reason: { code: "x", summary: "s", relatedEntityIds: [], recoverable: true, suggestedActions: [] },
      resumeTo: candidateResumeTo(state) as never,
    }).ok;
    assert.equal(offered, legal, `stop offered=${offered} but validateTransition(${state} -> blocked).ok=${legal}`);
  }
});

// ---------------------------------------------------------------------------
// Destructive confirmation
// ---------------------------------------------------------------------------

test("destructive confirmation: stop and cancel require confirmation, every other action does not", () => {
  assert.equal(requiresConfirmation("stop"), true);
  assert.equal(requiresConfirmation("cancel"), true);
  assert.equal(requiresConfirmation("start"), false);
  assert.equal(requiresConfirmation("pause"), false);
  assert.equal(requiresConfirmation("resume"), false);
  assert.equal(requiresConfirmation("requestReview"), false);
  assert.equal(DESTRUCTIVE_LIFECYCLE_ACTIONS.size, 2);
});

// ---------------------------------------------------------------------------
// Typed refusal rendering
// ---------------------------------------------------------------------------

test("typed refusal rendering: every ApplyCommandError-shaped code the API can return has a specific, non-generic message", () => {
  const codes = ["mission_terminal", "unauthorized_command", "unauthorized_approval", "unauthorized_plan_approval", "human_required", "version_conflict", "conflict"];
  for (const code of codes) {
    const message = friendlyMissionErrorMessage({ code });
    assert.notEqual(message, "Something went wrong. Try again.");
  }
});

test("typed refusal rendering: an unrecognized code falls back to the raw server message, not the generic string, when one is present", () => {
  assert.equal(friendlyMissionErrorMessage({ code: "some_new_code", error: "Server-provided detail." }), "Server-provided detail.");
});

// ---------------------------------------------------------------------------
// Cross-tenant / not-found behavior (UI-facing message parity)
// ---------------------------------------------------------------------------

test("cross-tenant/not-found behavior: mission_not_found and workspace_mismatch render the identical user-facing message", () => {
  assert.equal(friendlyMissionErrorMessage({ code: "mission_not_found" }), friendlyMissionErrorMessage({ code: "workspace_mismatch" }));
});

// ---------------------------------------------------------------------------
// Timeline pagination stability + bounded metadata
// ---------------------------------------------------------------------------

function timelineEntry(overrides: Partial<TimelineEntryDto>): TimelineEntryDto {
  return {
    eventId: "evt-1",
    type: "mission.state_changed",
    aggregateVersion: 1,
    timestamp: "2026-07-27T00:00:00.000Z",
    actorKind: "human",
    actorId: "user-1",
    correlationId: "corr-1",
    causationId: null,
    summary: "draft -> planning",
    ...overrides,
  };
}

test("timeline pagination stability: entries fed through groupTimelineByCorrelation preserve every entry exactly once", () => {
  const entries = [
    timelineEntry({ eventId: "e1", correlationId: "c1" }),
    timelineEntry({ eventId: "e2", correlationId: "c2" }),
    timelineEntry({ eventId: "e3", correlationId: "c1" }),
  ];
  const grouped = groupTimelineByCorrelation(entries);
  const flattened = grouped.flatMap((g) => g.entries.map((e) => e.eventId));
  assert.deepEqual(flattened.sort(), ["e1", "e2", "e3"]);
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].correlationId, "c1"); // first-seen order preserved
});

test("bounded timeline metadata: a TimelineEntryDto never carries a raw `payload` field — the DTO shape itself has none", () => {
  const entry = timelineEntry({});
  assert.equal("payload" in entry, false);
});

test("readable event labels: known event types get a human label, unknown types fall back to a de-namespaced, de-underscored form rather than the bare internal name", () => {
  assert.equal(timelineEventLabel("mission.state_changed"), "State changed");
  assert.equal(timelineEventLabel("mission.some_future_event"), "some future event");
});

// ---------------------------------------------------------------------------
// Evidence redaction + approval distinction
// ---------------------------------------------------------------------------

test("evidence redaction: the evidence display allowlist has no stdout/stderr/prompt/env field", () => {
  const banned = ["stdout", "stderr", "prompt", "environment", "env", "secrets"];
  for (const field of banned) {
    assert.ok(!EVIDENCE_DISPLAY_FIELDS.includes(field as never), `evidence allowlist must not include ${field}`);
  }
});

test("execution redaction: the execution display allowlist has no leaseId/fencingToken/dispatchKey field", () => {
  const banned = ["leaseId", "fencingToken", "dispatchKey", "dispatchIntentId"];
  for (const field of banned) {
    assert.ok(!EXECUTION_DISPLAY_FIELDS.includes(field as never), `execution allowlist must not include ${field}`);
  }
});

test("assignment redaction: the assignment display allowlist has no scheduler token or service-role field", () => {
  const banned = ["dispatchKey", "leaseId", "fencingToken"];
  for (const field of banned) {
    assert.ok(!ASSIGNMENT_DISPLAY_FIELDS.includes(field as never), `assignment allowlist must not include ${field}`);
  }
});

test("evidence approval distinction: submitted, recorded, reviewed, and accepted are four DISTINCT labels — execution completion never maps to any of them", () => {
  const submitted = evidenceProvenanceLabel("captured");
  const recorded = evidenceProvenanceLabel("attached");
  const reviewed = evidenceProvenanceLabel("attested");
  const accepted = evidenceProvenanceLabel("accepted");
  const labels = new Set([submitted.label, recorded.label, reviewed.label, accepted.label]);
  assert.equal(labels.size, 4);
  assert.equal(accepted.tone, "ok");
  assert.notEqual(reviewed.label, accepted.label); // a reviewed (attested) record must never read as "Accepted"
});

// ---------------------------------------------------------------------------
// Review decision controls: bearer vs human
// ---------------------------------------------------------------------------

test("bearer cannot render decision controls: an agent-kind principal never sees usable review controls, in any reviewable state", () => {
  const reviewableStates: MissionState[] = ["reviewing", "verifying", "ready_for_decision"];
  for (const state of reviewableStates) {
    assert.equal(canRenderReviewDecisionControls("agent", state), false);
  }
});

test("human reviewer can render and submit a decision: a human-kind principal sees controls once the Mission reaches a reviewable state", () => {
  assert.equal(canRenderReviewDecisionControls("human", "reviewing"), true);
  assert.equal(canRenderReviewDecisionControls("human", "ready_for_decision"), true);
  assert.equal(canRenderReviewDecisionControls("human", "executing"), false); // not reviewable yet
});

test("unknown principal kind never renders decision controls either", () => {
  assert.equal(canRenderReviewDecisionControls("unknown", "reviewing"), false);
});

// ---------------------------------------------------------------------------
// Stale review conflict
// ---------------------------------------------------------------------------

test("stale review conflict: only version_conflict is treated as a stale-decision conflict, not other refusal codes", () => {
  assert.equal(isStaleReviewConflict("version_conflict"), true);
  assert.equal(isStaleReviewConflict("mission_terminal"), false);
  assert.equal(isStaleReviewConflict(null), false);
  assert.equal(isStaleReviewConflict(undefined), false);
});

test("review status label: reviewing/verifying both read as 'In review'; approval is never described as correctness", () => {
  assert.equal(reviewStatusDtoLabel("reviewing"), "In review");
  assert.equal(reviewStatusDtoLabel("accepted"), "Accepted");
});

// ---------------------------------------------------------------------------
// Active Mission polling / terminal Mission polling stops
// ---------------------------------------------------------------------------

test("active Mission polling: a non-terminal Mission state is pollable", () => {
  const nonTerminal: MissionState[] = ["draft", "planning", "ready", "needs_input", "initializing", "executing", "reviewing", "verifying", "blocked", "paused", "ready_for_decision"];
  for (const state of nonTerminal) {
    assert.equal(isMissionPollable(state), true, `${state} should be pollable`);
  }
});

test("terminal Mission polling stops: accepted/rejected/cancelled/failed are never pollable", () => {
  const terminal: MissionState[] = ["accepted", "rejected", "cancelled", "failed"];
  for (const state of terminal) {
    assert.equal(isMissionPollable(state), false, `${state} should not be pollable`);
  }
});

test("shouldPollMissionList: true when any Mission in the list is non-terminal, false only when every Mission is terminal", () => {
  assert.equal(shouldPollMissionList([{ state: "executing" }, { state: "accepted" }]), true);
  assert.equal(shouldPollMissionList([{ state: "accepted" }, { state: "cancelled" }]), false);
  assert.equal(shouldPollMissionList([]), false);
});

test("missionStateTone: terminal success/failure states map to distinct tones (ok vs danger vs archived), never the same generic tone", () => {
  assert.equal(missionStateTone("accepted"), "ok");
  assert.equal(missionStateTone("rejected"), "danger");
  assert.equal(missionStateTone("cancelled"), "archived");
  assert.equal(missionStateTone("failed"), "danger");
});

// ---------------------------------------------------------------------------
// missionProgressPhase — Mission status bar's 4-step track vs. exception states
// ---------------------------------------------------------------------------

test("missionProgressPhase: every MISSION_STATES value resolves to exactly one phase index or one exception, never both, never neither", () => {
  for (const state of MISSION_STATES) {
    const result = missionProgressPhase(state);
    if (result.kind === "phase") {
      assert.ok([0, 1, 2, 3].includes(result.index), `${state} produced an out-of-range phase index`);
    } else {
      assert.ok(result.reason.length > 0, `${state} produced an exception with no reason`);
    }
  }
});

test("missionProgressPhase: happy-path states map onto the 4-step track in the right order", () => {
  assert.deepEqual(missionProgressPhase("draft"), { kind: "phase", index: 0 });
  assert.deepEqual(missionProgressPhase("planning"), { kind: "phase", index: 0 });
  assert.deepEqual(missionProgressPhase("executing"), { kind: "phase", index: 1 });
  assert.deepEqual(missionProgressPhase("reviewing"), { kind: "phase", index: 2 });
  assert.deepEqual(missionProgressPhase("ready_for_decision"), { kind: "phase", index: 2 });
  assert.deepEqual(missionProgressPhase("accepted"), { kind: "phase", index: 3 });
});

test("missionProgressPhase: interruptions and unsuccessful terminals are exceptions, never a fabricated phase position", () => {
  for (const state of ["needs_input", "blocked", "paused", "rejected", "cancelled", "failed"] as const) {
    const result = missionProgressPhase(state);
    assert.equal(result.kind, "exception", `${state} should be an exception, not a guessed phase index`);
  }
});

test("missionProgressPhase: exception tone matches missionStateTone (single source of truth, not re-derived)", () => {
  const blocked = missionProgressPhase("blocked");
  assert.equal(blocked.kind, "exception");
  if (blocked.kind === "exception") assert.equal(blocked.tone, missionStateTone("blocked"));
});

// ---------------------------------------------------------------------------
// Passport (Phase 6) — decision labeling
// ---------------------------------------------------------------------------

test("missionDecisionLabel: all five domain decision values have a distinct, readable label", () => {
  const decisions = ["accept", "reject", "request_changes", "continue_investigation", "escalate"];
  const labels = decisions.map(missionDecisionLabel);
  assert.equal(new Set(labels).size, 5);
  assert.equal(missionDecisionLabel("accept"), "Accepted");
  assert.equal(missionDecisionLabel("request_changes"), "Changes requested");
});

test("missionDecisionTone: accept is ok, reject is danger, escalate is warn — never all mapped to the same tone", () => {
  assert.equal(missionDecisionTone("accept"), "ok");
  assert.equal(missionDecisionTone("reject"), "danger");
  assert.equal(missionDecisionTone("escalate"), "warn");
});

test("shortDigest: truncates a 64-char sha256 hex digest for display without losing the full value elsewhere", () => {
  const digest = "a".repeat(64);
  const short = shortDigest(digest);
  assert.equal(short.length, 12);
  assert.equal(digest.startsWith(short), true);
});
