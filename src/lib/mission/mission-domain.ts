/**
 * Mission domain — core types
 * ----------------------------------------------------------------------------
 * A Mission is ONE piece of repository work a human cares about the outcome of.
 * Runs are attempts at it and remain internal execution records.
 *
 * Naming: the specs in `oathlock-specs/` say "Objective". We use **Mission**
 * because 28 files already use `objective` to mean *impartial/measurable*
 * (`objective signals`, `objectiveChecksPassed`, `objectiveSuccessCriteria`).
 * See `oathlock-specs/NAMING_DECISION.md` for the translation table.
 *
 * Phase 1 scope: pure domain types only. No database, no API, no orchestrator.
 */

import type { AgentKindKey } from "@/lib/agent-workspace-data";
import type { RunMode } from "@/lib/run-mode";

export const MISSION_SCHEMA_VERSION = "oathlock.mission.v1" as const;

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export type MissionId = string;
export type ParticipantId = string;
export type AssignmentId = string;

// ---------------------------------------------------------------------------
// State (spec STATE_MODEL §3, Objective → Mission)
// ---------------------------------------------------------------------------

export const MISSION_STATES = [
  "draft",
  "planning",
  "ready",
  "needs_input",
  "initializing",
  "executing",
  "reviewing",
  "verifying",
  "blocked",
  "paused",
  "ready_for_decision",
  "accepted",
  "rejected",
  "cancelled",
  "failed",
] as const;

export type MissionState = (typeof MISSION_STATES)[number];

/**
 * States that represent live work. `needs_input`, `blocked`, and `paused` all
 * resume into one of these, so the interruption must remember which.
 */
export const ACTIVE_MISSION_STATES = ["initializing", "executing", "reviewing", "verifying"] as const;
export type ActiveMissionState = (typeof ACTIVE_MISSION_STATES)[number];

/**
 * Terminal states (spec STATE_MODEL §16). Immutable except for annotations,
 * archival, redaction, and retention metadata. Further work creates a
 * successor Mission rather than reopening this one.
 */
export const TERMINAL_MISSION_STATES = ["accepted", "rejected", "cancelled", "failed"] as const;
export type TerminalMissionState = (typeof TERMINAL_MISSION_STATES)[number];

export function isMissionState(value: unknown): value is MissionState {
  return typeof value === "string" && (MISSION_STATES as readonly string[]).includes(value);
}

export function isActiveMissionState(state: MissionState): state is ActiveMissionState {
  return (ACTIVE_MISSION_STATES as readonly string[]).includes(state);
}

export function isTerminalMissionState(state: MissionState): state is TerminalMissionState {
  return (TERMINAL_MISSION_STATES as readonly string[]).includes(state);
}

// ---------------------------------------------------------------------------
// State reasons (spec STATE_MODEL §10)
// ---------------------------------------------------------------------------

/** Every non-happy-path state requires one of these. */
export interface StateReason {
  code: string;
  summary: string;
  details?: string;
  relatedEntityIds: string[];
  recoverable: boolean;
  suggestedActions: string[];
}

// ---------------------------------------------------------------------------
// Participants (spec PRODUCT §6)
// ---------------------------------------------------------------------------

export const PARTICIPANT_KINDS = ["human", "agent", "verifier", "planner", "system"] as const;
export type ParticipantKind = (typeof PARTICIPANT_KINDS)[number];

export const PARTICIPANT_ROLES = ["owner", "implementer", "reviewer", "verifier", "planner", "observer"] as const;
export type ParticipantRole = (typeof PARTICIPANT_ROLES)[number];

/**
 * A participant is a MISSION-LEVEL identity, not a provider session. One
 * participant may, over a Mission's life, be behind several execution
 * attempts (Phase 2D's `ExecutionRecord`s) or provider sessions — the
 * participant persists across all of them. Conflating "participant" with
 * "session" was the mistake Phase 1 left room for by only ever emitting
 * `mission.participant_added`'s bare `{participantId}`; this phase's richer
 * `mission.participant_registered` event and `MissionParticipant` shape
 * fix that without touching the old event (still emitted by nothing,
 * broken by nothing).
 */
export const PARTICIPANT_STATUSES = ["proposed", "ready", "active", "waiting", "blocked", "completed", "failed", "removed"] as const;
export type ParticipantStatus = (typeof PARTICIPANT_STATUSES)[number];

export const TERMINAL_PARTICIPANT_STATUSES = ["completed", "failed", "removed"] as const;
export type TerminalParticipantStatus = (typeof TERMINAL_PARTICIPANT_STATUSES)[number];

export function isParticipantStatus(value: unknown): value is ParticipantStatus {
  return typeof value === "string" && (PARTICIPANT_STATUSES as readonly string[]).includes(value);
}

export function isTerminalParticipantStatus(status: ParticipantStatus): status is TerminalParticipantStatus {
  return (TERMINAL_PARTICIPANT_STATUSES as readonly string[]).includes(status);
}

export interface ParticipantWorkspacePermissions {
  allowedPaths: string[];
  prohibitedPaths: string[];
}

export interface ParticipantCommunicationPermissions {
  canBroadcast: boolean;
  canDelegate: boolean;
  /** How many delegation hops this participant's own requests may still traverse — see mission-communication-policy.ts. */
  maxDelegationDepth: number;
}

export interface MissionParticipant {
  id: ParticipantId;
  kind: ParticipantKind;
  role: ParticipantRole;
  /** Provider identity for agent participants; null for humans and system actors. */
  agentKind: AgentKindKey | null;
  displayName: string;
  status: ParticipantStatus;
  /** e.g. "codex" | "claude-code" — the `ProviderAdapter.id` this participant's execution attempts run under. Null for humans/system actors. */
  provider: string | null;
  /** Provider runtime identity distinct from `provider` when one adapter serves several runtime configurations. Null when not applicable. */
  adapterId: string | null;
  /** Opaque capability names — deliberately untyped here to avoid a layering dependency from the domain module onto mission-provider-adapter.ts's ProviderCapability; validated against that type only where both are in scope (mission-collaboration.ts). */
  capabilities: string[];
  assignmentScope: { allowedPaths: string[]; prohibitedPaths: string[] };
  workspacePermissions: ParticipantWorkspacePermissions;
  communicationPermissions: ParticipantCommunicationPermissions;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Assignments — bounded work given to one participant
// ---------------------------------------------------------------------------

export const ASSIGNMENT_STATUSES = [
  "proposed",
  "ready",
  "claimed",
  "running",
  "waiting_for_input",
  "blocked",
  "submitted",
  "verified",
  "accepted",
  "rejected",
  "cancelled",
  "failed",
] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

export const TERMINAL_ASSIGNMENT_STATUSES = ["accepted", "rejected", "cancelled", "failed"] as const;
export type TerminalAssignmentStatus = (typeof TERMINAL_ASSIGNMENT_STATUSES)[number];

export function isAssignmentStatus(value: unknown): value is AssignmentStatus {
  return typeof value === "string" && (ASSIGNMENT_STATUSES as readonly string[]).includes(value);
}

export function isTerminalAssignmentStatus(status: AssignmentStatus): status is TerminalAssignmentStatus {
  return (TERMINAL_ASSIGNMENT_STATUSES as readonly string[]).includes(status);
}

export const ASSIGNMENT_APPROVAL_POLICIES = ["auto", "human_required"] as const;
export type AssignmentApprovalPolicy = (typeof ASSIGNMENT_APPROVAL_POLICIES)[number];

export interface AssignmentScope {
  allowedPaths: string[];
  prohibitedPaths: string[];
}

export interface AssignmentBudget {
  maxDurationMs: number | null;
  maxEstimatedTokens: number | null;
}

/**
 * Bounded work given to one participant. Coordinates existing Mission
 * dispatch/execution primitives (mission-scheduler.ts's `DispatchKey`,
 * mission-dispatch-runtime.ts's `ExecutionRecord`) rather than replacing
 * them — `dispatchKey` is the seam: once an assignment is claimed, it names
 * the scheduler slot (`workspaceId + missionId + dispatchKey`) that actually
 * gets leased and dispatched. No second execution state machine exists
 * here; `status` tracks the ASSIGNMENT's own coordination lifecycle
 * (proposed → ... → accepted), which is a different question from what a
 * dispatch lease or execution record is doing at any given moment, the same
 * three-way separation Phase 2D.2 drew between Mission state, lease state,
 * and execution state.
 */
export interface MissionAssignment {
  id: AssignmentId;
  missionId: MissionId;
  assigneeParticipantId: ParticipantId | null;
  title: string;
  objective: string;
  scope: AssignmentScope;
  dependencies: AssignmentId[];
  requiredEvidence: string[];
  approvalPolicy: AssignmentApprovalPolicy;
  budget: AssignmentBudget;
  status: AssignmentStatus;
  /**
   * Audit item 4 — per-assignment reviewer registry. Previously
   * `assignment_reviewer` authority (mission-authorization.ts) was granted
   * Mission-wide to ANY active participant with role `"reviewer"`, not
   * scoped to this assignment. Populated by the projection
   * (mission-projection.ts) the moment a `review_request` message names
   * `reviewerParticipantIds` for THIS assignment — there is no separate
   * "assign reviewer" command; naming a reviewer in the request IS how a
   * reviewer gets added, which is also the only place the domain already
   * captures that fact (mission-collaboration-protocol.ts's
   * `ReviewRequestPayload`). Additive/append-only across multiple
   * review_requests — a reviewer named once stays scoped to this
   * assignment even after a later request adds a different reviewer.
   */
  reviewerParticipantIds: ParticipantId[];
  /** Set once `AssignAssignment` runs — the scheduler slot this assignment's dispatch work uses. Plain string, not `mission-scheduler.ts`'s `DispatchKey` type, to keep this domain module independent of the scheduler module. */
  dispatchKey: string | null;
  /**
   * Phase 4B — bounded delegation. Null for a root assignment. A delegated
   * child assignment ALWAYS has: the parent's id here, the message that
   * caused the delegation, who delegated, and the effective delegation
   * depth — computed once, at creation, from the causal message history
   * (mission-collaboration-graph.ts), never trusted from a caller at any
   * later point. A child's `scope`/allowed paths are validated at creation
   * to never broaden the parent's — see `deriveChildAssignmentScope`.
   */
  parentAssignmentId: AssignmentId | null;
  originatingMessageId: string | null;
  delegatorParticipantId: ParticipantId | null;
  /** 0 for a root assignment; parent's depth + 1 for a delegated child. */
  delegationDepth: number;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Agent Message Protocol — durable, provider-neutral communication
// ---------------------------------------------------------------------------

export const MESSAGE_TYPES = [
  "information",
  "question",
  "answer",
  "review_request",
  "finding",
  "finding_response",
  "blocker",
  "delegation_request",
  "delegation_response",
  "evidence_notice",
  "approval_request",
  "completion_notice",
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export function isMessageType(value: unknown): value is MessageType {
  return typeof value === "string" && (MESSAGE_TYPES as readonly string[]).includes(value);
}

/** A bounded Mission-wide channel, distinct from an explicit recipient list — only reachable when the sender's `communicationPermissions.canBroadcast` is true (mission-communication-policy.ts). */
export const MISSION_BROADCAST_CHANNEL = "mission_broadcast" as const;
export type MessageRecipients = ParticipantId[] | typeof MISSION_BROADCAST_CHANNEL;

/**
 * A durable Mission record, not ephemeral provider chat. Never itself an
 * authority over Mission state — a message may cause a separately
 * validated Mission command (e.g. a `finding` message prompting a human to
 * issue `BlockMission`), but posting a message never mutates anything by
 * itself. Enforced structurally: nothing in mission-command-handler.ts's
 * `PostMessage` handling emits any event but `mission.message_posted`.
 */
export interface MissionMessage {
  id: string;
  missionId: MissionId;
  senderParticipantId: ParticipantId;
  recipientParticipantIds: MessageRecipients;
  assignmentId: AssignmentId | null;
  type: MessageType;
  body: string;
  evidenceRefs: string[];
  correlationId: string;
  causationId: string | null;
  replyToMessageId: string | null;
  createdAt: string;
  /**
   * Phase 4B — the typed payload protocol semantics are actually decided
   * from (mission-collaboration-protocol.ts validates required fields per
   * `type`). `body` remains free-form supporting text; it is NEVER
   * consulted to decide a state transition. Optional/untyped here to avoid
   * a union of twelve payload shapes in the domain module itself — the
   * protocol module owns interpreting it.
   */
  structuredPayload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Finding lifecycle (Phase 4B)
// ---------------------------------------------------------------------------

export const FINDING_STATUSES = [
  "opened",
  "acknowledged",
  "disputed",
  "remediation_requested",
  "remediation_submitted",
  "verified",
  "withdrawn",
  "unresolved",
  "closed",
] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

/** "verified" is deliberately NOT terminal — it must still be closable (`verified` -> `closed`). Only `withdrawn`/`closed` end a finding's lifecycle. */
export const TERMINAL_FINDING_STATUSES = ["withdrawn", "closed"] as const;
export type TerminalFindingStatus = (typeof TERMINAL_FINDING_STATUSES)[number];

export function isFindingStatus(value: unknown): value is FindingStatus {
  return typeof value === "string" && (FINDING_STATUSES as readonly string[]).includes(value);
}

export function isTerminalFindingStatus(status: FindingStatus): status is TerminalFindingStatus {
  return (TERMINAL_FINDING_STATUSES as readonly string[]).includes(status);
}

/**
 * A finding is explicitly NOT equivalent to assignment rejection — a finding
 * can be opened, disputed, remediated, and closed while the assignment it's
 * attached to is still `running`. Whether an unresolved finding actually
 * blocks verification/acceptance is a POLICY decision
 * (mission-collaboration-protocol.ts's `findingBlocksVerification`), applied
 * explicitly at `VerifyAssignment`/`AcceptAssignment` time — never assumed
 * here.
 */
export interface MissionFinding {
  id: string;
  missionId: MissionId;
  assignmentId: AssignmentId;
  openedByParticipantId: ParticipantId;
  /** Who is expected to act on it — the assignment's current assignee unless explicitly reassigned. Null when nobody has been designated yet. */
  responsibleParticipantId: ParticipantId | null;
  statement: string;
  evidenceRefs: string[];
  originatingMessageId: string;
  status: FindingStatus;
  resolutionEvidenceRefs: string[];
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Evidence — TWO INDEPENDENT AXES, deliberately not one enum
// ---------------------------------------------------------------------------

/**
 * Axis 1 — lifecycle: how far evidence has travelled toward being part of the
 * record. Each step is a different trust claim and they must never collapse
 * into a single boolean (that conflation is what made "agent supplied" and
 * "human vouched" indistinguishable).
 *
 * Notably `attached` ≠ `attested`: the system attaching validated evidence is
 * NOT a human approving it (spec PASSPORT_EVIDENCE §9).
 */
export const EVIDENCE_LIFECYCLE = ["captured", "validated", "attached", "attested", "accepted"] as const;
export type EvidenceLifecycle = (typeof EVIDENCE_LIFECYCLE)[number];

/**
 * Axis 2 — availability/integrity: whether the artifact itself is usable.
 * Orthogonal to lifecycle: evidence can be `attached` on axis 1 while being
 * `redacted` on axis 2, and that combination must remain expressible.
 */
export const EVIDENCE_AVAILABILITY = ["available", "invalid", "redacted", "unavailable"] as const;
export type EvidenceAvailability = (typeof EVIDENCE_AVAILABILITY)[number];

export function isEvidenceLifecycle(v: unknown): v is EvidenceLifecycle {
  return typeof v === "string" && (EVIDENCE_LIFECYCLE as readonly string[]).includes(v);
}

export function isEvidenceAvailability(v: unknown): v is EvidenceAvailability {
  return typeof v === "string" && (EVIDENCE_AVAILABILITY as readonly string[]).includes(v);
}

/** Evidence integrity descriptor (spec PASSPORT_EVIDENCE §4). */
export interface EvidenceIntegrity {
  algorithm: "sha256";
  digest: string;
  capturedAt: string;
  sourceRevision?: string;
  sourceExecutionId?: string;
}

/** The two axes travel together and are never merged. */
export interface MissionEvidenceRef {
  id: string;
  lifecycle: EvidenceLifecycle;
  availability: EvidenceAvailability;
  integrity: EvidenceIntegrity | null;
}

// ---------------------------------------------------------------------------
// Evidence provenance model (Phase 4D Part 4 §7)
// ---------------------------------------------------------------------------
//
// `MissionEvidenceRef` above was defined in Phase 1 but never actually
// wired into the projection — the real evidence store in production today
// is `MissionProjection.attachedEvidenceIds`/`attestedEvidenceIds`, two flat
// string arrays with NO metadata: no assignment association, no producer
// identity, no execution/dispatch correlation. That is the real domain gap
// this audit flagged (evidence/dispatch/execution reference matching is
// impossible without SOMETHING to check the references against).
//
// `MissionEvidenceRecord` below is the smallest coherent model that closes
// it: it reuses `EvidenceLifecycle`/`EvidenceAvailability`/`EvidenceIntegrity`
// VERBATIM (no new axis reinvented) and adds only the associative fields
// needed for reference enforcement. `EVIDENCE_NOTICE_KINDS` moved here from
// `mission-collaboration-protocol.ts` (Phase 4C), which now re-exports it —
// evidence KIND is a domain concept, not a message-protocol one, and having
// two independent enums for the same idea was itself a small duplication
// worth fixing while touching this area.
//
// This is a NEW event-sourced entity, not a mutation of `mission.evidence_attached`/
// `mission.evidence_attested` (Phase 1's bare `{evidenceId, digest}` pair) —
// same disambiguation precedent as Phase 5A's `MissionPlanProposal` vs. the
// pre-existing `mission.plan_proposed`/`mission.plan_approved`. The old
// events and `attachedEvidenceIds`/`attestedEvidenceIds` are untouched.

export const EVIDENCE_NOTICE_KINDS = [
  "test_result",
  "build_result",
  "lint_result",
  "diff_or_patch",
  "screenshot_or_artifact",
  "review_evidence",
  "remediation_evidence",
  "provider_execution_evidence",
] as const;
export type EvidenceNoticeKind = (typeof EVIDENCE_NOTICE_KINDS)[number];

export const EVIDENCE_PRODUCER_KINDS = ["agent", "human", "system"] as const;
export type EvidenceProducerKind = (typeof EVIDENCE_PRODUCER_KINDS)[number];

/**
 * The authoritative evidence record. Created ONLY through `RecordEvidence`
 * (never inferred from a message payload — a `PostMessage` `evidence_notice`
 * may only REFERENCE an already-recorded id, it never creates one itself).
 * Immutable once created except for `lifecycle`/`availability`/
 * `supersededByEvidenceId`, which move forward through `SupersedeEvidence`;
 * every prior state remains in event history, same discipline as every
 * other Mission entity.
 */
export interface MissionEvidenceRecord {
  id: string;
  missionId: MissionId;
  /** Null only for Mission-level evidence not tied to a specific assignment (rare — most evidence is assignment-scoped). */
  assignmentId: AssignmentId | null;
  /** Producer identity — null for genuinely anonymous system-captured evidence (e.g. an automated scan with no attributable actor). */
  producerParticipantId: ParticipantId | null;
  producerKind: EvidenceProducerKind;
  /** The execution attempt (Phase 2D's ExecutionRecord id) that produced this evidence, where applicable — null for human-supplied evidence. */
  executionId: string | null;
  /** The dispatch slot (mission-scheduler.ts's DispatchKey) active when this evidence was produced, where applicable. */
  dispatchKey: string | null;
  /** Provider adapter id (e.g. "codex", "claude-code") that produced this evidence, where applicable. */
  provider: string | null;
  kind: EvidenceNoticeKind;
  /** Free-text description of how/where this was captured — never itself a trust claim. */
  source: string;
  lifecycle: EvidenceLifecycle;
  availability: EvidenceAvailability;
  integrity: EvidenceIntegrity | null;
  /** Set by `SupersedeEvidence` — a superseded record is never deleted, only pointed forward. Null while current. */
  supersededByEvidenceId: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Model-assisted planning requests (Phase 5B) — durable request/result
// lifecycle. NEVER Mission authority itself: a `PlanningRequestRecord`
// tracks that a model was ASKED to produce/revise a Plan and what came of
// it; only a successful, fully-validated outcome ever produces a real
// `mission.plan_proposal_created`/`mission.plan_proposal_status_changed`
// event through the EXACT SAME command path Phase 5A's deterministic
// Planner uses (RecordModelPlanningResult, mission-command-handler.ts).
// ---------------------------------------------------------------------------

export const PLANNING_REQUEST_KINDS = ["proposal", "revision"] as const;
export type PlanningRequestKind = (typeof PLANNING_REQUEST_KINDS)[number];

export const PLANNING_REQUEST_STATUSES = ["requested", "in_progress", "completed", "failed", "cancelled", "stale", "superseded"] as const;
export type PlanningRequestStatus = (typeof PLANNING_REQUEST_STATUSES)[number];

export const TERMINAL_PLANNING_REQUEST_STATUSES = ["completed", "failed", "cancelled", "stale", "superseded"] as const;
export type TerminalPlanningRequestStatus = (typeof TERMINAL_PLANNING_REQUEST_STATUSES)[number];

export function isTerminalPlanningRequestStatus(status: PlanningRequestStatus): status is TerminalPlanningRequestStatus {
  return (TERMINAL_PLANNING_REQUEST_STATUSES as readonly string[]).includes(status);
}

/**
 * One durable record per external model call this Mission has ever
 * requested. Never stores secrets or an unrestricted raw prompt — only a
 * `redactedDiagnosticRef` (an opaque pointer into a separate, bounded
 * diagnostic store — Phase 5B §17 — never the Mission projection itself).
 */
export interface PlanningRequestRecord {
  id: string;
  missionId: MissionId;
  /** The Plan version this request targets — for `kind: "proposal"` this is the NEW version being created; for `kind: "revision"` it is likewise the new version, one greater than `basePlanId`'s. */
  targetPlanVersion: number;
  kind: PlanningRequestKind;
  /** Null for `kind: "proposal"`. Required for `kind: "revision"` — the Plan version being revised. */
  basePlanId: PlanId | null;
  status: PlanningRequestStatus;
  modelConfigurationId: string;
  /** From `buildPlanningContext` (mission-planning-context.ts) — proves two requests saw the identical bounded context. */
  contextHash: string;
  attemptCount: number;
  maxAttempts: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  correlationId: string;
  causationId: string | null;
  idempotencyKey: string;
  /** Opaque pointer into a separate diagnostic store — never the raw model response itself. Null until at least one attempt has been recorded. */
  redactedDiagnosticRef: string | null;
  /** Set only once this request reaches a terminal status. */
  finalOutcome: "created_plan" | "rejected" | "cancelled" | "stale" | "superseded" | null;
  /** The real Plan id this request produced, once successful. Null otherwise. */
  resultingPlanId: PlanId | null;
}

// ---------------------------------------------------------------------------
// Provenance (spec PRODUCT §7 "truthful state")
// ---------------------------------------------------------------------------

export const PROVENANCE_KINDS = [
  "observed_fact",
  "provider_claim",
  "system_inference",
  "agent_claim",
  "human_decision",
] as const;
export type ProvenanceKind = (typeof PROVENANCE_KINDS)[number];

// ---------------------------------------------------------------------------
// Decision (spec PRODUCT §15)
// ---------------------------------------------------------------------------

export const MISSION_DECISIONS = [
  "accept",
  "reject",
  "request_changes",
  "continue_investigation",
  "escalate",
] as const;
export type MissionDecision = (typeof MISSION_DECISIONS)[number];

// ---------------------------------------------------------------------------
// The aggregate
// ---------------------------------------------------------------------------

export interface Mission {
  schemaVersion: typeof MISSION_SCHEMA_VERSION;
  id: MissionId;
  /** Genesis identity: set once at creation, never changed by any later event. */
  workspaceId: string;
  repository: string;
  /**
   * Genesis identity, optional: a stable identifier for the repository
   * (distinct from `repository`, the human-facing name/path). Null when the
   * caller did not supply one. Immutable for the same reason `workspaceId`
   * is — set on `mission.created` and never revisited.
   */
  repositoryId: string | null;
  /** What the human asked for, in their own words. */
  goal: string;
  state: MissionState;
  /**
   * Where an interrupted Mission resumes. Set when entering `needs_input`,
   * `blocked`, or `paused`; null otherwise. The spec's
   * "needs_input → previous_active_state" transition is unimplementable
   * without it.
   */
  resumeTo: ActiveMissionState | null;
  /** Required for every non-happy-path state. */
  reason: StateReason | null;
  /** Execution mode and its coordination budget — reuses the existing model. */
  mode: RunMode;
  participants: MissionParticipant[];
  planVersion: number;
  /** Optimistic-concurrency version; incremented on every applied event. */
  aggregateVersion: number;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Mission Plan (Phase 5A)
// ---------------------------------------------------------------------------
//
// NAMED "MissionPlanProposal" in code and in every event/type identifier
// below, deliberately NOT "MissionPlan" — Phase 1 already defined
// `mission.plan_proposed`/`mission.plan_approved` events carrying
// `MissionPlanPayload { planVersion: number }`, the Mission's own bare,
// ever-incrementing plan-version counter (bumped by `MarkMissionReady`, a
// completely different and much thinner concept than the rich, reviewable
// proposal this phase introduces). Reusing those event names or the bare
// "MissionPlan" identifier would either collide with or be confused for
// that existing counter. This is a genuine domain gap found during this
// phase's audit, resolved by disambiguation rather than by repurposing
// Phase 1's fields.

export type PlanId = string;

export const PLAN_STATUSES = [
  "draft",
  "validating",
  "valid",
  "invalid",
  "approved",
  "materializing",
  "active",
  "superseded",
  "rejected",
  "cancelled",
] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const TERMINAL_PLAN_STATUSES = ["active", "superseded", "rejected", "cancelled"] as const;
export type TerminalPlanStatus = (typeof TERMINAL_PLAN_STATUSES)[number];

export function isPlanStatus(value: unknown): value is PlanStatus {
  return typeof value === "string" && (PLAN_STATUSES as readonly string[]).includes(value);
}

export function isTerminalPlanStatus(status: PlanStatus): status is TerminalPlanStatus {
  return (TERMINAL_PLAN_STATUSES as readonly string[]).includes(status);
}

export const PLANNER_OPERATING_MODES = ["solo", "review_pair", "specialist_team", "human_led"] as const;
export type PlannerOperatingMode = (typeof PLANNER_OPERATING_MODES)[number];

/**
 * What the Planner proposes for one participant — never a materialized
 * `MissionParticipant` itself. `providerConstraint` is deliberately a
 * CONSTRAINT (a specific provider id, or just required capabilities),
 * because "which provider" may not be resolvable until validation checks
 * it against `PlannerInput.availableProviders` — see
 * `mission-planner-validator.ts`.
 */
export interface ProposedParticipant {
  proposedParticipantId: string;
  role: ParticipantRole;
  providerConstraint: { provider: string | null; requiredCapabilities: string[] };
  workspacePermissions: ParticipantWorkspacePermissions;
  communicationPermissions: ParticipantCommunicationPermissions;
  rationale: string;
}

/** What the Planner proposes for one assignment. Dependencies/assignee reference OTHER `proposedAssignmentId`/`proposedParticipantId` values — never a real `AssignmentId`/`ParticipantId` until materialization mints one. */
export interface ProposedAssignment {
  proposedAssignmentId: string;
  proposedAssigneeId: string | null;
  objective: string;
  scope: AssignmentScope;
  dependencies: string[];
  requiredEvidence: string[];
  approvalPolicy: AssignmentApprovalPolicy;
  budget: AssignmentBudget;
  /** Named conditions under which this assignment becomes dispatch-eligible — opaque strings validated against a small recognized vocabulary (mission-planner-validator.ts), not free text interpreted at dispatch time. */
  dispatchEligibilityConditions: string[];
  /** Named conditions under which this assignment is considered done — same "recognized vocabulary" discipline as `dispatchEligibilityConditions`. */
  completionCriteria: string[];
}

export interface PlanCollaborationEdge {
  fromProposedId: string;
  toProposedId: string;
  kind: "review" | "delegation" | "dependency";
}

export interface PlanExecutionLimits {
  maxDurationMs: number | null;
  maxEstimatedTokens: number | null;
}

/**
 * A structured PROPOSAL, never a provider prompt and never itself Mission
 * authority — materialization (`MaterializeMissionPlan`) is the only thing
 * that turns an approved proposal into real participants/assignments, and
 * even that still goes through `applyMissionCommand` like everything else.
 */
export interface MissionPlanProposal {
  id: PlanId;
  missionId: MissionId;
  version: number;
  status: PlanStatus;
  objective: string;
  assumptions: string[];
  constraints: string[];
  participantProposals: ProposedParticipant[];
  assignmentProposals: ProposedAssignment[];
  collaborationTopology: PlanCollaborationEdge[];
  evidenceRequirements: string[];
  approvalGates: string[];
  executionLimits: PlanExecutionLimits;
  unresolvedQuestions: string[];
  warnings: string[];
  /** Set once validation actually runs — null while still `draft`. */
  validationErrors: string[];
  createdAt: string;
  createdBy: string;
  /** Set when this Plan version was created to replace a prior one. Null for the first version. */
  supersedesPlanId: PlanId | null;
}
