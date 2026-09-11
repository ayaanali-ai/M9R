/**
 * Mission command authorization — ONE provider-neutral seam (Phase 4D §2).
 * ----------------------------------------------------------------------------
 * Before this module, authorization was ad hoc: two commands
 * (`AcceptAssignment`/`RejectAssignment`, `ApproveMissionPlan`) had an inline
 * human-required check; every other command — participant add/activate/
 * remove, assignment create/assign/start/block/submit/cancel/verify,
 * findings, messages, Plan lifecycle — had NONE. Any authenticated caller
 * could act as any actor for any entity.
 *
 * This module is the single place that decides "can THIS actor run THIS
 * command against THIS Mission state" for every command type. It is pure:
 * no I/O, no provider calls, no mutation — a function of
 * `(command, projection, actor)` to an allow/deny verdict. It never depends
 * on mutable provider state (a provider process reporting its own progress
 * cannot change what authority it holds) — the ONLY inputs are the actor
 * identity `applyMissionCommand`'s caller already supplies via
 * `CommandContext.actor`, and the durable Mission projection itself.
 *
 * `applyMissionCommand` calls `authorizeMissionCommand` once, after the
 * idempotency/existence/version checks and before EITHER the Mission-state
 * branch or the collaboration branch builds any payload — so a denied
 * command never reaches event emission, and idempotency/replay are
 * unaffected (a replayed command never re-runs authorization at all; see
 * mission-command-handler.ts's ordering comment).
 */

import type { MissionCommand, MissionCommandType } from "./mission-commands";
import type { EventActor } from "./mission-events";
import type { MissionProjection } from "./mission-projection";
import type { AssignmentId, ParticipantId } from "./mission-domain";

// ---------------------------------------------------------------------------
// Authority kinds
// ---------------------------------------------------------------------------

/**
 * What an actor IS, with respect to the specific entity a command targets —
 * never a global role. The same actor can hold `assignment_assignee` for one
 * assignment and nothing at all for another; authorities are recomputed per
 * command, per call.
 */
export const AUTHORITY_KINDS = [
  "human",
  "system",
  "mission_owner_or_administrator",
  "active_participant",
  "assignment_assignee",
  "assignment_reviewer",
  "finding_opener",
  "finding_responsible_participant",
] as const;
export type AuthorityKind = (typeof AUTHORITY_KINDS)[number];

export interface UnauthorizedCommandError {
  code: "unauthorized_command";
  commandType: MissionCommandType;
  actorKind: EventActor["kind"];
  actorId: string;
  requiredAnyOf: AuthorityKind[];
  detail: string;
}

export type AuthorizationResult = { ok: true } | { ok: false; error: UnauthorizedCommandError };

/**
 * Agent bearer identity is a connection id, while channel-bound Missions
 * deliberately persist a stable participant id derived from that connection.
 * Resolve the existing bound participant without weakening identity checks or
 * changing already-created Mission records.
 */
export function resolveAgentParticipantId(current: MissionProjection, actor: EventActor): ParticipantId | string {
  if (actor.kind !== "agent") return actor.id;
  if (current.participants[actor.id as ParticipantId]) return actor.id;
  const channelParticipantId = `${current.missionId}-agent-${actor.id}` as ParticipantId;
  return current.participants[channelParticipantId] ? channelParticipantId : actor.id;
}

// ---------------------------------------------------------------------------
// Deriving what authorities the current actor actually holds
// ---------------------------------------------------------------------------

function extractAssignmentId(command: MissionCommand): AssignmentId | null {
  switch (command.type) {
    case "StartAssignment":
    case "BlockAssignment":
    case "SubmitAssignment":
    case "AcceptAssignment":
    case "RejectAssignment":
    case "CancelAssignment":
    case "VerifyAssignment":
    case "AskAssignmentQuestion":
    case "AnswerAssignmentQuestion":
    case "AssignAssignment":
      return command.assignmentId;
    case "OpenFinding":
      return command.assignmentId;
    case "PostMessage":
      return command.assignmentId;
    default:
      return null;
  }
}

function extractFindingId(command: MissionCommand): string | null {
  return command.type === "TransitionFinding" ? command.findingId : null;
}

/**
 * Audit item 5 — is there a real gap between "owner" and "administrator"?
 * Decision: NO. `owner` IS the administrator concept for a Mission — there
 * is exactly one tier of participant-side elevated authority in this
 * domain, and inventing a second, functionally-identical `administrator`
 * role/flag would be a distinction without a difference: nothing in this
 * codebase's command matrix, workspace-permission model, or provider
 * adapters would ever treat the two differently. `mission_owner_or_administrator`
 * keeps its name (renaming it is a much wider, purely-cosmetic diff across
 * every call site in `COMMAND_AUTHORITY_MATRIX` below, for no behavior
 * change) but is no longer documented as papering over a missing role —
 * it names a real equivalence: `ParticipantRole === "owner"`
 * (`PARTICIPANT_ROLES` already includes `"owner"`) IS "administrator" for
 * every purpose this authority is checked for. If a genuinely distinct
 * administrator tier (e.g. one that is NOT also a participant/owner) is
 * ever needed, that is a new authority kind to add deliberately, not a gap
 * this comment should keep implying already exists.
 */
export function deriveActorAuthorities(command: MissionCommand, current: MissionProjection | null, actor: EventActor): Set<AuthorityKind> {
  const held = new Set<AuthorityKind>();
  if (actor.kind === "human") held.add("human");
  if (actor.kind === "system") held.add("system");

  // No projection yet (CreateMission) — only the actor's own kind is knowable.
  if (!current) return held;

  const resolvedParticipantId = resolveAgentParticipantId(current, actor);
  const participant = actor.kind === "agent" ? current.participants[resolvedParticipantId as ParticipantId] : undefined;
  // "Removed or inactive participants cannot exercise participant authority"
  // — status must be exactly "active", never merely "exists".
  const isActiveParticipant = actor.kind === "agent" && participant?.status === "active";
  if (isActiveParticipant) {
    held.add("active_participant");
    if (participant!.role === "owner") held.add("mission_owner_or_administrator");
  }

  const assignmentId = extractAssignmentId(command);
  if (assignmentId) {
    const assignment = current.assignments[assignmentId];
    if (assignment && isActiveParticipant) {
      if (assignment.assigneeParticipantId === resolvedParticipantId) {
        held.add("assignment_assignee");
      } else if (participant!.role === "reviewer" && assignment.reviewerParticipantIds.includes(resolvedParticipantId as ParticipantId)) {
        // Audit item 4 — scoped to reviewers actually on THIS assignment's
        // registry (`MissionAssignment.reviewerParticipantIds`,
        // mission-domain.ts), populated when a `review_request` names them
        // (mission-projection.ts). Previously ANY active participant with
        // role "reviewer" held this authority Mission-wide, regardless of
        // whether they were ever asked to review this particular
        // assignment — closed here, not merely documented as a limitation.
        held.add("assignment_reviewer");
      }
    }
  }

  const findingId = extractFindingId(command);
  if (findingId) {
    const finding = current.findings[findingId];
    if (finding && isActiveParticipant) {
      if (finding.openedByParticipantId === resolvedParticipantId) held.add("finding_opener");
      if (finding.responsibleParticipantId === resolvedParticipantId) held.add("finding_responsible_participant");
    }
  }

  return held;
}

// ---------------------------------------------------------------------------
// The command -> allowed-authority matrix
// ---------------------------------------------------------------------------

/**
 * Base allow-list per command: the command succeeds authorization if the
 * actor holds ANY ONE of these. `refineRequiredAuthority` below can NARROW
 * (never broaden) this per-call for commands whose real requirement depends
 * on entity state (e.g. an assignment's own `human_required` policy).
 *
 * `mission_owner_or_administrator` is listed wherever `human`/`system` are,
 * never as the SOLE allowed authority — an owner participant is additive
 * authority on top of the base human/system grant, not a replacement for
 * it, matching the domain's actual actor model (owners are still `agent`
 * actors from `EventActor`'s point of view).
 */
export const COMMAND_AUTHORITY_MATRIX: Record<MissionCommandType, AuthorityKind[]> = {
  // ---- Mission lifecycle ---------------------------------------------------
  CreateMission: ["human", "system"],
  BeginPlanning: ["human", "system", "mission_owner_or_administrator"],
  MarkMissionReady: ["human", "system", "mission_owner_or_administrator"],
  BeginInitialization: ["human", "system", "mission_owner_or_administrator"],
  BeginExecution: ["human", "system", "mission_owner_or_administrator"],
  BeginReview: ["human", "system", "mission_owner_or_administrator"],
  BeginVerification: ["human", "system", "mission_owner_or_administrator"],
  // Interruption may be self-reported by the active participant hitting the
  // blocker/needing input — never only human/system.
  RequestInput: ["human", "system", "active_participant"],
  BlockMission: ["human", "system", "active_participant"],
  PauseMission: ["human", "system", "mission_owner_or_administrator"],
  ResumeMission: ["human", "system", "mission_owner_or_administrator"],
  MarkReadyForDecision: ["human", "system", "mission_owner_or_administrator"],
  // Unlike assignments/Plans, a Mission itself carries no per-entity
  // `approvalPolicy` field to escalate on — so, matching every other
  // Mission-lifecycle command, completion is human/system/owner rather than
  // human-only. If a future phase adds a Mission-level approval policy,
  // this is the row to escalate via `refineRequiredAuthority`.
  AcceptMission: ["human", "system", "mission_owner_or_administrator"],
  RejectMission: ["human", "system", "mission_owner_or_administrator"],
  RequestMissionChanges: ["human", "system", "mission_owner_or_administrator"],
  ContinueMissionInvestigation: ["human", "system", "mission_owner_or_administrator"],
  EscalateMission: ["human"],
  CancelMission: ["human", "system", "mission_owner_or_administrator"],
  // An agent can self-report an unrecoverable failure of its own work.
  FailMission: ["human", "system", "active_participant"],

  // ---- Participants ---------------------------------------------------------
  AddParticipant: ["human", "system", "mission_owner_or_administrator"],
  ActivateParticipant: ["human", "system", "mission_owner_or_administrator"],
  RemoveParticipant: ["human", "system", "mission_owner_or_administrator"],

  // ---- Assignments -----------------------------------------------------------
  CreateAssignment: ["human", "system", "mission_owner_or_administrator"],
  AssignAssignment: ["human", "system", "mission_owner_or_administrator"],
  StartAssignment: ["assignment_assignee", "human", "system"],
  BlockAssignment: ["assignment_assignee", "human", "system"],
  SubmitAssignment: ["assignment_assignee", "human", "system"],
  // Verification is deliberately NOT open to `assignment_assignee` — a
  // participant verifies someone else's submitted work, never its own
  // (there is no `human_required`-style policy field to escalate on for
  // verification specifically, so this is enforced structurally by simply
  // never granting the assignee this authority, rather than by a runtime
  // policy check).
  VerifyAssignment: ["assignment_reviewer", "human", "system"],
  // Accept/Reject: the assignee itself IS allowed to accept/reject its own
  // submitted work — this is the domain's actual "auto" policy behavior
  // (an implementer can self-close routine work). `refineRequiredAuthority`
  // escalates to human-only when `approvalPolicy === "human_required"`,
  // which is what actually prevents self-approval on gated assignments: an
  // agent assignee is never `human`, so the escalation alone closes the
  // self-approval gap the audit flagged — no separate "forbid the assignee"
  // rule is needed on top of it.
  AcceptAssignment: ["assignment_assignee", "assignment_reviewer", "human", "system"],
  RejectAssignment: ["assignment_assignee", "assignment_reviewer", "human", "system"],
  CancelAssignment: ["human", "system", "mission_owner_or_administrator"],

  // ---- Messages and collaboration --------------------------------------------
  PostMessage: ["active_participant", "human", "system"],
  AskAssignmentQuestion: ["active_participant", "assignment_assignee", "assignment_reviewer", "human", "system"],
  AnswerAssignmentQuestion: ["active_participant", "human", "system"],

  // ---- Findings ---------------------------------------------------------------
  // Opening is any active participant (whoever notices something can raise
  // it); transitioning one is scoped to the finding's own opener/
  // responsible party (or human/system), never any unrelated participant.
  OpenFinding: ["active_participant", "human", "system"],
  TransitionFinding: ["finding_opener", "finding_responsible_participant", "human", "system"],

  // ---- Plans --------------------------------------------------------------------
  ProposeMissionPlan: ["human", "system", "mission_owner_or_administrator"],
  ValidateMissionPlan: ["human", "system", "mission_owner_or_administrator"],
  // Refined below: escalates to human-only when the Plan proposes any
  // human_required assignment.
  ApproveMissionPlan: ["human", "system", "mission_owner_or_administrator"],
  RejectMissionPlan: ["human", "system", "mission_owner_or_administrator"],
  SupersedeMissionPlan: ["human", "system", "mission_owner_or_administrator"],
  MaterializeMissionPlan: ["human", "system", "mission_owner_or_administrator"],

  // ---- Evidence provenance (Phase 4D Part 4) ---------------------------------
  // Any active participant may record evidence of its OWN work; human/system
  // may record on behalf of anyone (e.g. attaching human-supplied evidence).
  RecordEvidence: ["active_participant", "human", "system"],
  SupersedeEvidence: ["human", "system", "mission_owner_or_administrator"],

  // Execution lifecycle is submitted only by the trusted runtime/result port.
  // A provider process or bearer participant may supply evidence, never assert
  // authoritative execution state, approval, or a terminal Mission outcome.
  RecordExecutionStarted: ["system"],
  RecordExecutionCompleted: ["system"],
  RecordExecutionFailed: ["system"],
  RecordExecutionCancelled: ["system"],
  RecordExecutionLeaseLost: ["system"],

  // ---- Plan cancellation (Phase 5B §14) --------------------------------------
  CancelMissionPlan: ["human", "system", "mission_owner_or_administrator"],

  // ---- Model-assisted planning (Phase 5B) ------------------------------------
  // Only human/system/owner may REQUEST planning or cancel a request — an
  // agent participant proposing its own planning work would be exactly the
  // "provider process grants itself new authority" pattern this domain
  // refuses everywhere else. Recording a RESULT is system-only: only the
  // impure worker that actually made the external model call (never a
  // human directly, never an arbitrary agent) may report what it got back.
  RequestModelPlanning: ["human", "system", "mission_owner_or_administrator"],
  RecordModelPlanningResult: ["system"],
  CancelModelPlanningRequest: ["human", "system", "mission_owner_or_administrator"],
};

/**
 * Dynamic narrowing for the handful of commands whose real requirement
 * depends on entity state, not just command type. Returns a STRICT SUBSET
 * of the base matrix row (never a superset) — this function can only make
 * a command harder to authorize, never easier. Returning `null` leaves the
 * base row untouched.
 *
 * Note: this is the SAME behavior `mission-command-handler.ts` implemented
 * inline before this module existed (`unauthorized_approval`/
 * `unauthorized_plan_approval`) — centralized here, not changed, so the
 * existing error codes and existing tests for those two commands are
 * preserved exactly.
 */
export function refineRequiredAuthority(command: MissionCommand, current: MissionProjection | null): AuthorityKind[] | null {
  if (!current) return null;

  if (command.type === "AcceptAssignment" || command.type === "RejectAssignment") {
    const assignment = current.assignments[command.assignmentId];
    if (assignment?.approvalPolicy === "human_required") return ["human"];
    return null;
  }

  if (command.type === "VerifyAssignment") {
    // Never the assignee's own call, regardless of role overlap.
    return ["assignment_reviewer", "human", "system"];
  }

  if (command.type === "ApproveMissionPlan") {
    const plan = current.planProposals[command.planId];
    const requiresHuman = plan?.assignmentProposals.some((a) => a.approvalPolicy === "human_required") ?? false;
    if (requiresHuman) return ["human"];
    return null;
  }

  return null;
}

export function authorizeMissionCommand(command: MissionCommand, current: MissionProjection | null, actor: EventActor): AuthorizationResult {
  const required = refineRequiredAuthority(command, current) ?? COMMAND_AUTHORITY_MATRIX[command.type];
  const held = deriveActorAuthorities(command, current, actor);

  const authorized = required.some((kind) => held.has(kind));
  if (!authorized) {
    return {
      ok: false,
      error: {
        code: "unauthorized_command",
        commandType: command.type,
        actorKind: actor.kind,
        actorId: actor.id,
        requiredAnyOf: required,
        detail: `Actor ${actor.kind}:${actor.id} holds none of [${required.join(", ")}] required for ${command.type}.`,
      },
    };
  }

  return { ok: true };
}
