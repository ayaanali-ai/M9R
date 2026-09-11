/**
 * Collaboration bridge — turns a finished agent execution's own output into
 * real Mission commands, and turns a Mission's pending messages into launch
 * context for the next dispatched agent.
 * ----------------------------------------------------------------------------
 * This is the piece that was missing for agents to act like a coordinated
 * team instead of isolated one-shot workers: the Agent Message Protocol
 * (`mission-collaboration-protocol.ts`, `PostMessage`/`OpenFinding`) has
 * existed since Phase 4A, but nothing ever produced those commands FROM an
 * agent's own output, and nothing ever fed a participant's PENDING messages
 * INTO the next agent's launch prompt. Both directions are pure, testable
 * translation — no I/O, no provider calls — so this module has neither.
 *
 * The pure translations in this module are now called by the Phase 1 runtime
 * result bridge after the fenced accepted-result boundary succeeds. Durable
 * writes still happen only through the existing Mission command port.
 *
 * Seven directive kinds, chosen because each maps onto a `MessageType` whose
 * structured-payload schema (`mission-protocol-schema.ts`) is either empty
 * or small enough for an agent's own free-text output to reliably produce:
 *   - "message" — a general note (`messageType: "information"`).
 *   - "finding" — posted as `messageType: "finding"` and immediately
 *     opened as a real `OpenFinding`, which requires an
 *     `originatingMessageId` — so a finding directive always emits its own
 *     message first.
 *   - "delegation_request" — propose delegating (part of) an assignment to
 *     specific participant(s). Carries no structured payload at all
 *     (`mission-protocol-schema.ts`'s schema for it is empty).
 *   - "delegation_response" — accept or decline a delegation_request. An
 *     `accepted: true` response ATOMICALLY creates the real child
 *     assignment in the same command
 *     (`mission-command-handler.ts`'s delegation_response orchestration) —
 *     no separate `CreateAssignment`/`AssignAssignment`, no human/system
 *     gate, since `PostMessage` itself is open to any `active_participant`.
 *     This is the actual mechanism by which one agent can bring another
 *     into a Mission on its own.
 * Every OTHER `MessageType` (`review_request`/`blocker`/`evidence_notice`/
 * `approval_request`/`completion_notice`) requires a richer validated
 * structured payload that an agent's free-text output has no reliable way
 * to produce correctly — building THAT bridge is real, separate work, not
 * something to fake with a best-effort guess at a payload shape.
 */

import type { AssignmentId, MessageRecipients, MissionId, MissionMessage, ParticipantId } from "./mission-domain";
import { MISSION_BROADCAST_CHANNEL } from "./mission-domain";
import type { MissionCommand } from "./mission-commands";

// ---------------------------------------------------------------------------
// The directive format an agent's own output is asked to emit
// ---------------------------------------------------------------------------

const DIRECTIVE_FENCE = "```oathlock-collaboration" as const;

export interface MessageDirective {
  type: "message";
  recipients: string[] | "broadcast";
  body: string;
  evidenceRefs?: string[];
}

export interface FindingDirective {
  type: "finding";
  recipients: string[] | "broadcast";
  statement: string;
  responsibleParticipantId?: string | null;
  evidenceRefs?: string[];
}

/**
 * Propose delegating (part of) an assignment to another participant.
 * `recipients` is always an explicit list here, never "broadcast" — a
 * delegation targets specific participant(s) who may accept it, not
 * everyone on the Mission. Requires no structured payload
 * (`mission-protocol-schema.ts`'s schema for `delegation_request` is
 * empty) — the request itself carries no commitment, only the response
 * does.
 */
export interface DelegationRequestDirective {
  type: "delegation_request";
  assignmentId: string;
  recipients: string[];
  body: string;
  evidenceRefs?: string[];
}

/**
 * Respond to a `delegation_request` message. An `accepted: true` response
 * ATOMICALLY creates the real child assignment in the same command
 * (`mission-command-handler.ts`'s `delegation_response` orchestration) —
 * no separate `CreateAssignment`/`AssignAssignment` call, and no human/
 * system gate, since `PostMessage` itself is open to any
 * `active_participant`. This is the actual mechanism by which one agent
 * can bring another into a Mission on its own — not a proposal a human
 * has to manually turn into real work.
 */
export interface DelegationResponseDirective {
  type: "delegation_response";
  replyToMessageId: string;
  /** Typically just the original requester's participant id. */
  recipients: string[];
  accepted: boolean;
  childTitle?: string;
  childObjective?: string;
  allowedPaths?: string[];
  prohibitedPaths?: string[];
}

export interface ReviewRequestDirective {
  type: "review_request";
  recipients: string[];
  reviewerParticipantIds: string[];
  body: string;
  scope?: string;
  requiredEvidence?: string[];
  reviewPolicy?: "single_reviewer" | "any_of" | "all_of";
  evidenceRefs?: string[];
}

export interface CompletionNoticeDirective {
  type: "completion_notice";
  recipients: string[] | "broadcast";
  body: string;
  dispatchKey?: string | null;
  evidenceRefs?: string[];
}

export interface RemediationDirective {
  type: "remediation";
  recipients: string[] | "broadcast";
  findingId: string;
  nextStatus: "acknowledged" | "disputed" | "remediation_requested" | "remediation_submitted" | "verified" | "unresolved" | "closed";
  body: string;
  evidenceRefs?: string[];
}

export type CollaborationDirective = MessageDirective | FindingDirective | DelegationRequestDirective | DelegationResponseDirective | ReviewRequestDirective | CompletionNoticeDirective | RemediationDirective;

export interface ParseCollaborationDirectivesResult {
  directives: CollaborationDirective[];
  /** Human-readable, never thrown — a malformed directive is dropped and reported, not a reason to fail the whole execution. */
  parseErrors: string[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function parseRecipients(value: unknown): string[] | "broadcast" | null {
  if (value === "broadcast") return "broadcast";
  if (isStringArray(value) && value.length > 0) return value;
  return null;
}

function parseOneDirective(raw: unknown, index: number, errors: string[]): CollaborationDirective | null {
  if (typeof raw !== "object" || raw === null) {
    errors.push(`Directive ${index}: not an object.`);
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const recipients = parseRecipients(obj.recipients);
  if (!recipients) {
    errors.push(`Directive ${index}: "recipients" must be "broadcast" or a non-empty array of participant ids.`);
    return null;
  }
  const evidenceRefs = obj.evidenceRefs === undefined ? [] : isStringArray(obj.evidenceRefs) ? obj.evidenceRefs : null;
  if (evidenceRefs === null) {
    errors.push(`Directive ${index}: "evidenceRefs" must be an array of strings when present.`);
    return null;
  }

  if (obj.type === "message") {
    if (!isNonEmptyString(obj.body)) {
      errors.push(`Directive ${index}: message directive requires a non-empty "body".`);
      return null;
    }
    return { type: "message", recipients, body: obj.body, evidenceRefs };
  }
  if (obj.type === "finding") {
    if (!isNonEmptyString(obj.statement)) {
      errors.push(`Directive ${index}: finding directive requires a non-empty "statement".`);
      return null;
    }
    const responsibleParticipantId = obj.responsibleParticipantId;
    if (responsibleParticipantId !== undefined && responsibleParticipantId !== null && typeof responsibleParticipantId !== "string") {
      errors.push(`Directive ${index}: "responsibleParticipantId" must be a string or null when present.`);
      return null;
    }
    return {
      type: "finding",
      recipients,
      statement: obj.statement,
      responsibleParticipantId: (responsibleParticipantId as string | null | undefined) ?? null,
      evidenceRefs,
    };
  }
  if (obj.type === "delegation_request") {
    if (recipients === "broadcast") {
      errors.push(`Directive ${index}: delegation_request must target explicit participant id(s), not "broadcast".`);
      return null;
    }
    if (!isNonEmptyString(obj.assignmentId)) {
      errors.push(`Directive ${index}: delegation_request requires a non-empty "assignmentId" (the parent assignment being delegated from).`);
      return null;
    }
    if (!isNonEmptyString(obj.body)) {
      errors.push(`Directive ${index}: delegation_request requires a non-empty "body" describing what needs delegating.`);
      return null;
    }
    return { type: "delegation_request", assignmentId: obj.assignmentId, recipients, body: obj.body, evidenceRefs };
  }
  if (obj.type === "delegation_response") {
    if (recipients === "broadcast") {
      errors.push(`Directive ${index}: delegation_response must target the requester's participant id, not "broadcast".`);
      return null;
    }
    if (!isNonEmptyString(obj.replyToMessageId)) {
      errors.push(`Directive ${index}: delegation_response requires a non-empty "replyToMessageId" (the delegation_request being answered).`);
      return null;
    }
    if (typeof obj.accepted !== "boolean") {
      errors.push(`Directive ${index}: delegation_response requires a boolean "accepted".`);
      return null;
    }
    for (const field of ["childTitle", "childObjective"] as const) {
      if (obj[field] !== undefined && !isNonEmptyString(obj[field])) {
        errors.push(`Directive ${index}: "${field}", when present, must be a non-empty string.`);
        return null;
      }
    }
    for (const field of ["allowedPaths", "prohibitedPaths"] as const) {
      if (obj[field] !== undefined && !isStringArray(obj[field])) {
        errors.push(`Directive ${index}: "${field}", when present, must be an array of strings.`);
        return null;
      }
    }
    return {
      type: "delegation_response",
      replyToMessageId: obj.replyToMessageId,
      recipients,
      accepted: obj.accepted,
      childTitle: obj.childTitle as string | undefined,
      childObjective: obj.childObjective as string | undefined,
      allowedPaths: obj.allowedPaths as string[] | undefined,
      prohibitedPaths: obj.prohibitedPaths as string[] | undefined,
    };
  }

  errors.push(`Directive ${index}: unknown "type" ${JSON.stringify(obj.type)} — expected "message", "finding", "delegation_request", or "delegation_response".`);
  if (obj.type === "review_request") {
    errors.pop();
    if (recipients === "broadcast") {
      errors.push(`Directive ${index}: review_request must target explicit reviewer participant id(s), not "broadcast".`);
      return null;
    }
    if (!isStringArray(obj.reviewerParticipantIds) || obj.reviewerParticipantIds.length === 0 || obj.reviewerParticipantIds.some((id) => !isNonEmptyString(id))) {
      errors.push(`Directive ${index}: review_request requires a non-empty string array "reviewerParticipantIds".`);
      return null;
    }
    if (!isNonEmptyString(obj.body)) {
      errors.push(`Directive ${index}: review_request requires a non-empty "body".`);
      return null;
    }
    if (obj.scope !== undefined && !isNonEmptyString(obj.scope)) {
      errors.push(`Directive ${index}: review_request "scope", when present, must be a non-empty string.`);
      return null;
    }
    if (obj.requiredEvidence !== undefined && (!isStringArray(obj.requiredEvidence) || obj.requiredEvidence.some((value) => !isNonEmptyString(value)))) {
      errors.push(`Directive ${index}: review_request "requiredEvidence", when present, must be an array of strings.`);
      return null;
    }
    if (obj.reviewPolicy !== undefined && !["single_reviewer", "any_of", "all_of"].includes(obj.reviewPolicy as string)) {
      errors.push(`Directive ${index}: review_request "reviewPolicy" is invalid.`);
      return null;
    }
    return { type: "review_request", recipients, reviewerParticipantIds: obj.reviewerParticipantIds, body: obj.body, scope: obj.scope as string | undefined, requiredEvidence: obj.requiredEvidence as string[] | undefined, reviewPolicy: obj.reviewPolicy as ReviewRequestDirective["reviewPolicy"], evidenceRefs };
  }

  if (obj.type === "completion_notice") {
    errors.pop();
    if (!isNonEmptyString(obj.body)) {
      errors.push(`Directive ${index}: completion_notice requires a non-empty "body".`);
      return null;
    }
    if (obj.dispatchKey !== undefined && obj.dispatchKey !== null && !isNonEmptyString(obj.dispatchKey)) {
      errors.push(`Directive ${index}: completion_notice "dispatchKey", when present, must be a non-empty string or null.`);
      return null;
    }
    return { type: "completion_notice", recipients, body: obj.body, dispatchKey: obj.dispatchKey as string | null | undefined, evidenceRefs };
  }

  if (obj.type === "remediation") {
    errors.pop();
    if (!isNonEmptyString(obj.findingId)) {
      errors.push(`Directive ${index}: remediation requires a non-empty "findingId".`);
      return null;
    }
    if (!["acknowledged", "disputed", "remediation_requested", "remediation_submitted", "verified", "unresolved", "closed"].includes(obj.nextStatus as string)) {
      errors.push(`Directive ${index}: remediation "nextStatus" is invalid.`);
      return null;
    }
    if (!isNonEmptyString(obj.body)) {
      errors.push(`Directive ${index}: remediation requires a non-empty "body".`);
      return null;
    }
    return { type: "remediation", recipients, findingId: obj.findingId, nextStatus: obj.nextStatus as RemediationDirective["nextStatus"], body: obj.body, evidenceRefs };
  }

  return null;
}

/**
 * Extracts every ```oathlock-collaboration fenced block from an agent's
 * (already-redacted) final output, parses each as a JSON array of
 * directives, and validates each entry independently — one malformed
 * directive never discards the rest of a well-formed block, and a
 * malformed block never throws. An agent that emits no such block (the
 * overwhelmingly common case) yields an empty, valid result.
 */
export function parseCollaborationDirectives(summary: string): ParseCollaborationDirectivesResult {
  const directives: CollaborationDirective[] = [];
  const errors: string[] = [];

  let searchFrom = 0;
  for (;;) {
    const fenceStart = summary.indexOf(DIRECTIVE_FENCE, searchFrom);
    if (fenceStart === -1) break;
    const bodyStart = fenceStart + DIRECTIVE_FENCE.length;
    const fenceEnd = summary.indexOf("```", bodyStart);
    if (fenceEnd === -1) {
      errors.push("Found an opening ```oathlock-collaboration fence with no closing ``` — block ignored.");
      break;
    }
    const raw = summary.slice(bodyStart, fenceEnd).trim();
    searchFrom = fenceEnd + 3;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      errors.push(`Collaboration block is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (!Array.isArray(parsed)) {
      errors.push("Collaboration block must be a JSON array of directives.");
      continue;
    }
    parsed.forEach((entry, i) => {
      const directive = parseOneDirective(entry, i, errors);
      if (directive) directives.push(directive);
    });
  }

  return { directives, parseErrors: errors };
}

// ---------------------------------------------------------------------------
// Directive -> real Mission commands
// ---------------------------------------------------------------------------

export interface BuildCollaborationCommandsInput {
  missionId: MissionId;
  assignmentId: AssignmentId | null;
  senderParticipantId: ParticipantId;
  directives: CollaborationDirective[];
  originatingExecutionRef?: string | null;
  /** Injectable for deterministic tests; defaults to crypto.randomUUID(). */
  mintMessageId?: () => string;
  mintFindingId?: () => string;
}

function toRecipients(recipients: string[] | "broadcast"): MessageRecipients {
  return recipients === "broadcast" ? MISSION_BROADCAST_CHANNEL : (recipients as ParticipantId[]);
}

/**
 * Pure translation, one directive at a time, into the real command shapes
 * `mission-command-handler.ts` already accepts unmodified — no new command
 * types, no new event types. A "finding" directive always produces its
 * PostMessage first and threads that message's id into the OpenFinding
 * command as `originatingMessageId`, matching the domain's own requirement
 * that a finding can never exist without the message that raised it.
 */
export function buildCollaborationCommands(input: BuildCollaborationCommandsInput): MissionCommand[] {
  const mintMessageId = input.mintMessageId ?? (() => crypto.randomUUID());
  const mintFindingId = input.mintFindingId ?? (() => crypto.randomUUID());
  const commands: MissionCommand[] = [];

  for (const directive of input.directives) {
    if (directive.type === "message") {
      commands.push({
        type: "PostMessage",
        missionId: input.missionId,
        messageId: mintMessageId(),
        senderParticipantId: input.senderParticipantId,
        recipientParticipantIds: toRecipients(directive.recipients),
        assignmentId: input.assignmentId,
        messageType: "information",
        body: directive.body,
        evidenceRefs: directive.evidenceRefs ?? [],
        replyToMessageId: null,
      });
      continue;
    }

    if (directive.type === "finding") {
      const messageId = mintMessageId();
      commands.push({
        type: "PostMessage",
        missionId: input.missionId,
        messageId,
        senderParticipantId: input.senderParticipantId,
        recipientParticipantIds: toRecipients(directive.recipients),
        assignmentId: input.assignmentId,
        messageType: "finding",
        body: directive.statement,
        evidenceRefs: directive.evidenceRefs ?? [],
        replyToMessageId: null,
      });

      if (input.assignmentId) {
        commands.push({
          type: "OpenFinding",
          missionId: input.missionId,
          findingId: mintFindingId(),
          assignmentId: input.assignmentId,
          openedByParticipantId: input.senderParticipantId,
          responsibleParticipantId: (directive.responsibleParticipantId ?? null) as ParticipantId | null,
          statement: directive.statement,
          evidenceRefs: directive.evidenceRefs ?? [],
          originatingMessageId: messageId,
        });
      }
      // No assignmentId (a Mission-level execution with no assignment
      // context) -> the message alone is posted; OpenFinding requires a
      // real assignmentId (mission-commands.ts), so it is skipped rather
      // than guessed at.
      continue;
    }

    if (directive.type === "delegation_request") {
      commands.push({
        type: "PostMessage",
        missionId: input.missionId,
        messageId: mintMessageId(),
        senderParticipantId: input.senderParticipantId,
        recipientParticipantIds: toRecipients(directive.recipients),
        assignmentId: directive.assignmentId as AssignmentId,
        messageType: "delegation_request",
        body: directive.body,
        evidenceRefs: directive.evidenceRefs ?? [],
        replyToMessageId: null,
      });
      continue;
    }

    // directive.type === "delegation_response" — an `accepted: true`
    if (directive.type === "delegation_response") {
    // response is what actually, atomically creates the child assignment
    // (mission-command-handler.ts's delegation_response orchestration);
    // this bridge only builds the command, it never decides acceptance
    // itself.
    commands.push({
      type: "PostMessage",
      missionId: input.missionId,
      messageId: mintMessageId(),
      senderParticipantId: input.senderParticipantId,
      recipientParticipantIds: toRecipients(directive.recipients),
      assignmentId: input.assignmentId,
      messageType: "delegation_response",
      body: directive.accepted ? "Delegation accepted." : "Delegation declined.",
      evidenceRefs: [],
      replyToMessageId: directive.replyToMessageId,
      structuredPayload: {
        accepted: directive.accepted,
        ...(directive.childTitle ? { childTitle: directive.childTitle } : {}),
        ...(directive.childObjective ? { childObjective: directive.childObjective } : {}),
        ...(directive.allowedPaths ? { allowedPaths: directive.allowedPaths } : {}),
        ...(directive.prohibitedPaths ? { prohibitedPaths: directive.prohibitedPaths } : {}),
      },
    });
      continue;
    }

    if (directive.type === "review_request") {
      commands.push({
        type: "PostMessage",
        missionId: input.missionId,
        messageId: mintMessageId(),
        senderParticipantId: input.senderParticipantId,
        recipientParticipantIds: directive.recipients as ParticipantId[],
        assignmentId: input.assignmentId,
        messageType: "review_request",
        body: directive.body,
        evidenceRefs: directive.evidenceRefs ?? [],
        replyToMessageId: null,
        structuredPayload: {
          reviewerParticipantIds: directive.reviewerParticipantIds,
          ...(directive.scope ? { scope: directive.scope } : {}),
          ...(directive.requiredEvidence ? { requiredEvidence: directive.requiredEvidence } : {}),
          originatingExecutionRef: input.originatingExecutionRef ?? null,
          ...(directive.reviewPolicy ? { reviewPolicy: directive.reviewPolicy } : {}),
        },
      });
      continue;
    }

    if (directive.type === "completion_notice") {
      commands.push({
        type: "PostMessage",
        missionId: input.missionId,
        messageId: mintMessageId(),
        senderParticipantId: input.senderParticipantId,
        recipientParticipantIds: toRecipients(directive.recipients),
        assignmentId: input.assignmentId,
        messageType: "completion_notice",
        body: directive.body,
        evidenceRefs: directive.evidenceRefs ?? [],
        replyToMessageId: null,
        structuredPayload: { dispatchKey: directive.dispatchKey ?? null },
      });
      continue;
    }

    // A remediation is a typed finding transition plus a bounded message.
    // The command handler remains the authority on whether this status
    // transition is legal for the referenced finding.
    const remediationMessageId = mintMessageId();
    commands.push({
      type: "PostMessage",
      missionId: input.missionId,
      messageId: remediationMessageId,
      senderParticipantId: input.senderParticipantId,
      recipientParticipantIds: toRecipients(directive.recipients),
      assignmentId: input.assignmentId,
      messageType: "finding",
      body: directive.body,
      evidenceRefs: directive.evidenceRefs ?? [],
      replyToMessageId: null,
    });
    commands.push({
      type: "TransitionFinding",
      missionId: input.missionId,
      findingId: directive.findingId,
      nextStatus: directive.nextStatus,
      resolutionEvidenceRefs: directive.evidenceRefs ?? [],
    });
  }

  return commands;
}

// ---------------------------------------------------------------------------
// Pending messages -> launch context for the NEXT dispatched agent
// ---------------------------------------------------------------------------

export interface PendingMessageView {
  messageId: string;
  senderParticipantId: string;
  type: string;
  body: string;
  postedAt: string;
}

/**
 * Every message addressed to `participantId` (directly, or via broadcast)
 * posted after `since`. There is no per-recipient delivery/read tracking
 * anywhere in the Mission domain today (`MissionMessage` carries no
 * delivery-status field) — honestly reflecting that here rather than
 * inventing one. "Pending" is therefore time-based: the caller passes the
 * cutoff (typically this participant's own last dispatched execution's
 * `startedAt`, or `null` to mean "everything ever addressed to them") —
 * this function never claims to know what an agent has "seen."
 */
export function pendingMessagesFor(messages: MissionMessage[], participantId: ParticipantId, since: string | null): PendingMessageView[] {
  const cutoff = since ? Date.parse(since) : null;
  return messages
    .filter((m) => m.recipientParticipantIds === MISSION_BROADCAST_CHANNEL || m.recipientParticipantIds.includes(participantId))
    .filter((m) => m.senderParticipantId !== participantId) // never re-show a participant their own message
    .filter((m) => cutoff === null || Date.parse(m.createdAt) > cutoff)
    .map((m) => ({ messageId: m.id, senderParticipantId: m.senderParticipantId, type: m.type, body: m.body, postedAt: m.createdAt }));
}

/**
 * Renders pending messages as plain text suitable for splicing into a
 * launch grant's task/context field — bounded (`maxMessages`) so a chatty
 * Mission never blows out an agent's context window with unread backlog.
 */
export function renderPendingMessagesForLaunch(pending: PendingMessageView[], maxMessages = 10): string | null {
  if (pending.length === 0) return null;
  const shown = pending.slice(0, maxMessages);
  const omitted = pending.length - shown.length;
  const lines = shown.map((m) => `- [${m.type} from ${m.senderParticipantId}] ${m.body}`);
  if (omitted > 0) lines.push(`- (${omitted} more message(s) not shown)`);
  return ["Messages from other participants on this Mission you have not yet seen:", ...lines].join("\n");
}

/**
 * The exact instructions spliced into a provider launch grant so an agent
 * knows this protocol exists and how to use it. Kept as one exported
 * constant, not duplicated per adapter, so both Codex and Claude Code are
 * told the identical contract. Deliberately terse: `resident-provider-
 * adapters.ts`'s `validateGrant` hard-caps the ENTIRE task string (goal +
 * this + any pending-message context) at 1000 characters — this is not a
 * budget this module owns or may change, so the instructions have to fit
 * inside whatever headroom the goal leaves, not the other way around.
 */
export const COLLABORATION_DIRECTIVE_INSTRUCTIONS = `Optional Mission actions. If needed, end with this JSON fence:
${DIRECTIVE_FENCE}
[{"type":"message","recipients":"broadcast","body":"..."},{"type":"finding","recipients":["id"],"statement":"..."},{"type":"review_request","recipients":["id"],"reviewerParticipantIds":["id"],"body":"..."},{"type":"completion_notice","recipients":"broadcast","body":"..."},{"type":"remediation","recipients":["id"],"findingId":"...","nextStatus":"remediation_submitted","body":"..."},{"type":"delegation_request","assignmentId":"...","recipients":["id"],"body":"..."},{"type":"delegation_response","replyToMessageId":"...","recipients":["id"],"accepted":true}]
\`\`\`
Use explicit participant ids for review/delegation; omit the fence if nothing needs reporting.`;

/** The hard ceiling `resident-provider-adapters.ts`'s `validateGrant` enforces on a launch grant's whole `task` string — mirrored here, not imported, since that module has no exported constant for it and this function must never silently exceed it. */
const PROVIDER_TASK_MAX_LENGTH = 1000;

/**
 * The one place a provider adapter's launch-grant task text is composed
 * with the collaboration contract — used by both `mission-provider-
 * adapter-codex.ts` and `mission-provider-adapter-claude-code.ts` so
 * Codex and Claude Code are given the identical instructions in the
 * identical position, never two adapter-specific variants that could
 * silently drift apart.
 *
 * Defensively bounded against `PROVIDER_TASK_MAX_LENGTH`: the goal always
 * wins the budget in full; pending-message context is dropped first if
 * space is short, then the collaboration instructions themselves — never
 * silently truncated mid-JSON (which would hand the agent a corrupt
 * example), and never left to throw at the provider boundary instead.
 */
export function composeTaskWithCollaborationContext(goal: string, pendingMessagesContext?: string | null): string {
  const withPending = pendingMessagesContext ? [goal, COLLABORATION_DIRECTIVE_INSTRUCTIONS, pendingMessagesContext].join("\n\n") : null;
  if (withPending && withPending.length <= PROVIDER_TASK_MAX_LENGTH) return withPending;

  const withInstructionsOnly = [goal, COLLABORATION_DIRECTIVE_INSTRUCTIONS].join("\n\n");
  if (withInstructionsOnly.length <= PROVIDER_TASK_MAX_LENGTH) return withInstructionsOnly;

  return goal;
}
