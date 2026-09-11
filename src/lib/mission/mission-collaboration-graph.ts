/**
 * Mission collaboration graph — chain-derived delegation depth, cycle
 * detection, and scope-narrowing checks (Phase 4B).
 * ----------------------------------------------------------------------------
 * The critical correction this phase makes: Phase 4A trusted a caller-
 * supplied `delegationDepth` number on `PostMessage`. Nothing stopped a
 * participant (or a bug) from declaring `0` forever. This module replaces
 * that trust with a value computed from durable, already-validated history —
 * `MissionMessage.replyToMessageId`/`causationId` chains and
 * `MissionAssignment.parentAssignmentId` chains — which a caller cannot
 * lower or falsify because it is never read from the command at all.
 *
 * Every function here is pure: given the same message/assignment maps, the
 * same answer comes back every time. `mission-command-handler.ts` is the
 * only caller, and it always passes `current.messages`/`current.assignments`
 * — the projection's own state — never anything the command itself supplies.
 */

import type { AssignmentId, MissionAssignment, MissionMessage, ParticipantId } from "./mission-domain";
import { isRepoPathContained, isRepoPathContainedByAny } from "./mission-path-containment";

// ---------------------------------------------------------------------------
// Delegation depth
// ---------------------------------------------------------------------------

export interface DeriveDelegationDepthResult {
  ok: true;
  depth: number;
}

export interface DeriveDelegationDepthFailure {
  ok: false;
  reason: string;
}

const MAX_CHAIN_WALK = 64;

/**
 * Walks a `delegation_request` message's own reply/causation chain backward
 * counting how many PRIOR `delegation_request` messages it descends from.
 * A root request (nothing upstream is itself a delegation) has depth 0; a
 * request replying to (or caused by) another delegation_request has depth
 * `parent's depth + 1`.
 *
 * Fails closed, per instruction, on a malformed chain: a `replyToMessageId`/
 * `causationId` that points at a message id not present in `messages` at
 * all is NOT treated as "must be a root" — it's reported as an error, since
 * a caller could otherwise fabricate an unlinked message and have it read as
 * depth 0. A chain longer than `MAX_CHAIN_WALK` is also refused rather than
 * walked forever, protecting against a very long or cyclic message history.
 */
export function deriveDelegationDepth(message: Pick<MissionMessage, "id" | "replyToMessageId" | "causationId" | "type">, messages: readonly MissionMessage[]): DeriveDelegationDepthResult | DeriveDelegationDepthFailure {
  const byId = new Map(messages.map((m) => [m.id, m]));
  let depth = 0;
  let cursor: string | null = message.replyToMessageId ?? message.causationId;
  const visited = new Set<string>([message.id]);

  for (let steps = 0; cursor !== null; steps += 1) {
    if (steps >= MAX_CHAIN_WALK) return { ok: false, reason: `Delegation chain exceeds ${MAX_CHAIN_WALK} hops — refusing to walk further.` };
    if (visited.has(cursor)) return { ok: false, reason: `Delegation chain is cyclic at message ${cursor}.` };
    visited.add(cursor);

    const parent = byId.get(cursor);
    if (!parent) {
      // The chain references a message id we don't have. Only a problem if
      // we needed to know whether IT was a delegation_request — since we
      // can no longer tell, fail closed rather than assume "not a delegation".
      return { ok: false, reason: `Delegation chain references unknown message ${cursor}.` };
    }
    if (parent.type === "delegation_request") depth += 1;
    cursor = parent.replyToMessageId ?? parent.causationId;
  }

  return { ok: true, depth };
}

// ---------------------------------------------------------------------------
// Cycle detection
// ---------------------------------------------------------------------------

/** True if `candidateParticipantId` already appears among the delegator chain leading to `assignment` — i.e. delegating TO them would hand work back to someone already upstream in this same delegation lineage. */
export function wouldCreateParticipantCycle(candidateParticipantId: ParticipantId, parentAssignmentId: AssignmentId, assignments: Record<AssignmentId, MissionAssignment>): boolean {
  let cursor: AssignmentId | null = parentAssignmentId;
  const visited = new Set<AssignmentId>();
  for (let steps = 0; cursor !== null && steps < MAX_CHAIN_WALK; steps += 1) {
    if (visited.has(cursor)) return true; // the ASSIGNMENT chain itself is already cyclic — refuse rather than loop forever
    visited.add(cursor);
    const current: MissionAssignment | undefined = assignments[cursor];
    if (!current) break;
    if (current.delegatorParticipantId === candidateParticipantId || current.assigneeParticipantId === candidateParticipantId) return true;
    cursor = current.parentAssignmentId;
  }
  return false;
}

/** True if `parentAssignmentId`'s own ancestor chain is already cyclic (a malformed/corrupted assignment graph) — checked independently of any specific candidate participant. */
export function hasAssignmentCycle(assignmentId: AssignmentId, assignments: Record<AssignmentId, MissionAssignment>): boolean {
  let cursor: AssignmentId | null = assignmentId;
  const visited = new Set<AssignmentId>();
  for (let steps = 0; cursor !== null && steps < MAX_CHAIN_WALK; steps += 1) {
    if (visited.has(cursor)) return true;
    visited.add(cursor);
    cursor = assignments[cursor]?.parentAssignmentId ?? null;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Scope narrowing
// ---------------------------------------------------------------------------

export interface ScopeNarrowingResult {
  ok: boolean;
  /** Allowed paths the child requested that are not covered by the parent's own allowed paths. */
  excessAllowedPaths: string[];
  /** Prohibited paths the parent required that the child tried to drop. */
  droppedProhibitedPaths: string[];
}

/**
 * A child's allowed paths must each be covered by the parent's allowed
 * paths (exact match or a subdirectory of one), and the child's prohibited
 * paths must be a SUPERSET of the parent's (a child may add restrictions,
 * never remove one the parent already imposed). Never the reverse in
 * either direction — that would be broadening authority through
 * delegation, which is exactly what this function exists to catch before
 * a child assignment is ever created.
 *
 * Containment is CANONICAL segment comparison
 * (mission-path-containment.ts), not raw string-prefix matching — the
 * previous implementation (`path.startsWith(allowed + "/")`) never resolved
 * `..`, never normalized separators, and accepted `src/../outside` as
 * "covered by src" simply because the raw string started with "src". A
 * child allowed/prohibited path that fails to canonicalize (absolute,
 * drive-letter, UNC, or root-escaping `..`) is NEVER treated as covered —
 * traversal escapes fail closed, reported as excess/dropped like any other
 * uncovered path.
 */
export function validateScopeNarrowing(parent: { allowedPaths: string[]; prohibitedPaths: string[] }, child: { allowedPaths: string[]; prohibitedPaths: string[] }): ScopeNarrowingResult {
  const excessAllowedPaths = child.allowedPaths.filter((childAllowed) => !isRepoPathContainedByAny(childAllowed, parent.allowedPaths));
  // A parent prohibition is preserved if the child still has SOME
  // prohibited entry that covers it (equal to it, or a broader ancestor
  // prohibition) — the child narrowing to a MORE specific prohibition than
  // the parent's is not "dropping" it, but reporting nothing under the
  // parent's prohibited subtree at all is.
  const droppedProhibitedPaths = parent.prohibitedPaths.filter(
    (parentProhibited) => !child.prohibitedPaths.some((childProhibited) => isRepoPathContained(parentProhibited, childProhibited)),
  );
  return { ok: excessAllowedPaths.length === 0 && droppedProhibitedPaths.length === 0, excessAllowedPaths, droppedProhibitedPaths };
}
