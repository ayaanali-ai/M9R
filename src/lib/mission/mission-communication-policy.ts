/**
 * Communication policy — the enforceable gate every `PostMessage` command
 * passes through before a `mission.message_posted` event is ever
 * constructed (Phase 4A).
 * ----------------------------------------------------------------------------
 * A message is never itself Mission authority (see MissionMessage's doc
 * comment, mission-domain.ts) — but that alone doesn't stop a compromised or
 * buggy participant from spamming, addressing a removed/foreign identity, or
 * building a delegation loop. This module is the explicit, minimal check
 * that runs BEFORE `mission-command-handler.ts` ever emits the event, not a
 * best-effort filter applied after the fact.
 *
 * "Cross-Mission" addressing is refused structurally, not by comparing
 * mission ids: every check here only ever looks a recipient up in THIS
 * Mission's own `participants` map (the one `applyMissionCommand` is
 * already scoped to). A participant id belonging to a different Mission
 * simply isn't present in that map — it reads as `unknown_recipient`,
 * exactly the same as a typo'd id, which is the correct and sufficient
 * refusal for a caller that has no legitimate way to know a foreign
 * Mission's participant ids at all.
 */

import type { AssignmentId, AssignmentScope, MessageRecipients, MessageType, MissionAssignment, MissionParticipant, ParticipantId } from "./mission-domain";
import { MISSION_BROADCAST_CHANNEL } from "./mission-domain";
import { validateScopeNarrowing } from "./mission-collaboration-graph";

export type DelegationApprovalPolicy =
  | { mode: "participant_acceptance" }
  | { mode: "human_required" }
  | { mode: "auto_within_scope"; allowedPaths: string[] };

export interface CommunicationPolicyConfig {
  allowBroadcast: boolean;
  maxDelegationDepth: number;
  delegationApproval?: DelegationApprovalPolicy;
}

export const DEFAULT_COMMUNICATION_POLICY: CommunicationPolicyConfig = {
  allowBroadcast: false,
  maxDelegationDepth: 1,
  delegationApproval: { mode: "participant_acceptance" },
};

export type MessagePolicyViolation =
  | { code: "sender_not_active"; participantId: ParticipantId }
  | { code: "unknown_sender"; participantId: ParticipantId }
  | { code: "unknown_recipient"; participantId: ParticipantId }
  | { code: "recipient_not_active"; participantId: ParticipantId }
  | { code: "broadcast_not_allowed" }
  | { code: "invalid_assignment_reference"; assignmentId: AssignmentId }
  | { code: "delegation_depth_exceeded"; depth: number; maxDelegationDepth: number }
  | { code: "delegation_outside_scope"; assignmentId: AssignmentId }
  | { code: "self_referential_delegation"; participantId: ParticipantId }
  | { code: "delegation_not_permitted"; participantId: ParticipantId }
  // Phase 4B additions — see mission-collaboration-graph.ts for what derives these.
  | { code: "participant_delegation_cycle"; participantId: ParticipantId }
  | { code: "assignment_delegation_cycle"; assignmentId: AssignmentId }
  | { code: "delegation_target_not_active"; participantId: ParticipantId }
  | { code: "delegation_scope_exceeds_parent"; assignmentId: AssignmentId }
  | { code: "delegation_against_terminal_assignment"; assignmentId: AssignmentId }
  | { code: "delegation_approval_required"; assignmentId: AssignmentId }
  | { code: "delegation_scope_not_auto_approved"; assignmentId: AssignmentId; allowedPaths: string[] }
  | { code: "malformed_causal_chain"; messageId: string; reason: string }
  | { code: "duplicate_delegation_response"; originatingMessageId: string }
  // Phase 4C — typed protocol violations (mission-collaboration-protocol.ts)
  // folded into the SAME violation union rather than a parallel error
  // channel, so every message rejection surfaces through one place.
  | import("./mission-collaboration-protocol").ProtocolViolation;

export interface ValidateMessageInput {
  senderParticipantId: ParticipantId;
  recipientParticipantIds: MessageRecipients;
  assignmentId: AssignmentId | null;
  type: MessageType;
  /**
   * Phase 4B: how many delegation hops this specific message represents,
   * ALWAYS computed by walking the durable causal message chain
   * (`mission-collaboration-graph.ts`'s `deriveDelegationDepth`) — never a
   * value the caller/command declares. This function stays agnostic to
   * WHERE the number came from (that's what keeps it a pure, narrow policy
   * check); the guarantee that it was actually derived, not trusted, is
   * `mission-command-handler.ts`'s responsibility, not this function's.
   */
  derivedDelegationDepth: number;
  participants: Record<ParticipantId, MissionParticipant>;
  assignments: Record<AssignmentId, MissionAssignment>;
  policy: CommunicationPolicyConfig;
}

export type ValidateMessageResult = { ok: true } | { ok: false; violation: MessagePolicyViolation };

export function validateDelegationApproval(input: {
  policy: CommunicationPolicyConfig;
  assignmentId: AssignmentId;
  childScope: AssignmentScope;
}): ValidateMessageResult {
  const approval = input.policy.delegationApproval ?? DEFAULT_COMMUNICATION_POLICY.delegationApproval!;
  if (approval.mode === "human_required") {
    return { ok: false, violation: { code: "delegation_approval_required", assignmentId: input.assignmentId } };
  }
  if (approval.mode === "auto_within_scope") {
    const policyScope: AssignmentScope = { allowedPaths: approval.allowedPaths, prohibitedPaths: [] };
    if (!validateScopeNarrowing(policyScope, input.childScope).ok) {
      return {
        ok: false,
        violation: {
          code: "delegation_scope_not_auto_approved",
          assignmentId: input.assignmentId,
          allowedPaths: [...approval.allowedPaths],
        },
      };
    }
  }
  return { ok: true };
}

export function validateMessage(input: ValidateMessageInput): ValidateMessageResult {
  const sender = input.participants[input.senderParticipantId];
  if (!sender) return { ok: false, violation: { code: "unknown_sender", participantId: input.senderParticipantId } };
  if (sender.status !== "active") return { ok: false, violation: { code: "sender_not_active", participantId: input.senderParticipantId } };

  if (input.recipientParticipantIds === MISSION_BROADCAST_CHANNEL) {
    if (!input.policy.allowBroadcast || !sender.communicationPermissions.canBroadcast) {
      return { ok: false, violation: { code: "broadcast_not_allowed" } };
    }
  } else {
    for (const recipientId of input.recipientParticipantIds) {
      const recipient = input.participants[recipientId];
      if (!recipient) return { ok: false, violation: { code: "unknown_recipient", participantId: recipientId } };
      if (recipient.status === "removed") return { ok: false, violation: { code: "recipient_not_active", participantId: recipientId } };
    }
  }

  if (input.assignmentId !== null && !input.assignments[input.assignmentId]) {
    return { ok: false, violation: { code: "invalid_assignment_reference", assignmentId: input.assignmentId } };
  }

  if (input.type === "delegation_request") {
    if (!sender.communicationPermissions.canDelegate) {
      return { ok: false, violation: { code: "delegation_not_permitted", participantId: input.senderParticipantId } };
    }
    const maxDepth = Math.min(input.policy.maxDelegationDepth, sender.communicationPermissions.maxDelegationDepth);
    if (input.derivedDelegationDepth >= maxDepth) {
      return { ok: false, violation: { code: "delegation_depth_exceeded", depth: input.derivedDelegationDepth, maxDelegationDepth: maxDepth } };
    }
    if (input.recipientParticipantIds !== MISSION_BROADCAST_CHANNEL && input.recipientParticipantIds.includes(input.senderParticipantId)) {
      // A delegation request addressed back to its own sender is a
      // zero-length loop — refused unconditionally, not just discouraged.
      return { ok: false, violation: { code: "self_referential_delegation", participantId: input.senderParticipantId } };
    }
    if (input.assignmentId !== null) {
      const assignment = input.assignments[input.assignmentId];
      const senderAssignedHere = assignment.assigneeParticipantId === input.senderParticipantId;
      if (!senderAssignedHere) {
        // Delegating work on an assignment the sender doesn't actually hold
        // is out of scope by construction — nothing legitimizes it.
        return { ok: false, violation: { code: "delegation_outside_scope", assignmentId: input.assignmentId } };
      }
    }
  }

  return { ok: true };
}
