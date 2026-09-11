/**
 * Runtime protocol schemas — Phase 4D Part 3 §3/§5.
 * ----------------------------------------------------------------------------
 * Phase 4C's `mission-collaboration-protocol.ts` validators check DOMAIN
 * semantics (is this reviewer active, is this evidence known) but assume
 * `structuredPayload` already has the right SHAPE — a `payload as
 * ReviewRequestPayload` TypeScript cast, never actually checked at runtime.
 * A payload like `{ reviewPolicy: "definitely_review_it" }` or
 * `{ subject: "approval_request", grantedBy: "self" }` passed straight
 * through untouched.
 *
 * This module is the ONE place every `structuredPayload` is checked against
 * its message type's real shape BEFORE any domain-semantic validator in
 * mission-collaboration-protocol.ts ever sees it. No external schema
 * library is used — the repository has none (checked: no zod/ajv/yup/joi/
 * valibot/superstruct/io-ts in package.json) and this phase does not
 * introduce one; these are hand-written discriminated-union checks over
 * the same message-type union `mission-domain.ts`'s `MessageType` already
 * declares.
 *
 * Every schema is a CLOSED allow-list of keys — an unrecognized field is
 * rejected outright, never silently ignored. This is what stops a payload
 * from smuggling an authority-bearing field (e.g. a fabricated
 * `preApproved: true`) that no validator downstream would otherwise know
 * to check for, because it was never a field any type declares in the
 * first place.
 */

import type { MessageType } from "./mission-domain";
import { APPROVAL_SUBJECTS, BLOCKER_REASONS, EVIDENCE_NOTICE_KINDS, REVIEW_POLICIES } from "./mission-collaboration-protocol";

export type ProtocolSchemaErrorCode =
  | "unknown_message_type"
  | "payload_not_an_object"
  | "unknown_field"
  | "missing_required_field"
  | "wrong_type"
  | "invalid_enum_value"
  | "malformed_id"
  | "malformed_array";

export interface ProtocolSchemaError {
  code: ProtocolSchemaErrorCode;
  messageType: string;
  field?: string;
  detail: string;
}

export type ProtocolSchemaResult = { ok: true } | { ok: false; error: ProtocolSchemaError };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function err(messageType: string, code: ProtocolSchemaErrorCode, detail: string, field?: string): ProtocolSchemaResult {
  return { ok: false, error: { code, messageType, field, detail } };
}

/** Every key a payload for this message type is allowed to carry. A key outside this set is rejected — never silently passed through. */
const ALLOWED_KEYS: Record<string, readonly string[]> = {
  delegation_request: [],
  delegation_response: ["accepted", "childTitle", "childObjective", "allowedPaths", "prohibitedPaths"],
  review_request: ["reviewerParticipantIds", "scope", "requiredEvidence", "originatingExecutionRef", "reviewPolicy"],
  blocker: ["reason", "detail", "resolved"],
  evidence_notice: ["evidenceKind"],
  approval_request: ["subject", "assignmentId", "findingId"],
  completion_notice: ["dispatchKey"],
  question: [],
  answer: [],
  information: [],
  finding: [],
  finding_response: [],
};

function checkUnknownFields(messageType: string, payload: Record<string, unknown>): ProtocolSchemaResult | null {
  const allowed = ALLOWED_KEYS[messageType] ?? [];
  for (const key of Object.keys(payload)) {
    if (!allowed.includes(key)) return err(messageType, "unknown_field", `"${key}" is not a recognized field for message type "${messageType}" — an unrecognized field is never silently accepted, since it could carry unvalidated authority.`, key) as ProtocolSchemaResult;
  }
  return null;
}

function validateDelegationResponse(payload: Record<string, unknown>): ProtocolSchemaResult {
  if (typeof payload.accepted !== "boolean") return err("delegation_response", "missing_required_field", "delegation_response requires a boolean 'accepted'.", "accepted");
  // childTitle/childObjective are genuinely OPTIONAL — mission-command-handler.ts
  // falls back to `Delegated: ${parent.title}` / the parent's own objective
  // when absent. Only their TYPE is checked when present.
  if (payload.childTitle !== undefined && !isNonEmptyString(payload.childTitle)) return err("delegation_response", "wrong_type", "'childTitle', when present, must be a non-empty string.", "childTitle");
  if (payload.childObjective !== undefined && !isNonEmptyString(payload.childObjective)) return err("delegation_response", "wrong_type", "'childObjective', when present, must be a non-empty string.", "childObjective");
  if (payload.allowedPaths !== undefined && !isStringArray(payload.allowedPaths)) return err("delegation_response", "malformed_array", "'allowedPaths' must be a string array.", "allowedPaths");
  if (payload.prohibitedPaths !== undefined && !isStringArray(payload.prohibitedPaths)) return err("delegation_response", "malformed_array", "'prohibitedPaths' must be a string array.", "prohibitedPaths");
  return { ok: true };
}

function validateReviewRequest(payload: Record<string, unknown>): ProtocolSchemaResult {
  if (!isStringArray(payload.reviewerParticipantIds)) return err("review_request", "missing_required_field", "review_request requires a string array 'reviewerParticipantIds'.", "reviewerParticipantIds");
  if (payload.reviewerParticipantIds.some((id) => id.length === 0)) return err("review_request", "malformed_id", "reviewerParticipantIds must not contain empty ids.", "reviewerParticipantIds");
  if (payload.scope !== undefined && typeof payload.scope !== "string") return err("review_request", "wrong_type", "'scope' must be a string.", "scope");
  if (payload.requiredEvidence !== undefined && !isStringArray(payload.requiredEvidence)) return err("review_request", "malformed_array", "'requiredEvidence' must be a string array.", "requiredEvidence");
  if (payload.originatingExecutionRef !== undefined && payload.originatingExecutionRef !== null && typeof payload.originatingExecutionRef !== "string") {
    return err("review_request", "wrong_type", "'originatingExecutionRef' must be a string or null.", "originatingExecutionRef");
  }
  if (payload.reviewPolicy !== undefined && !(REVIEW_POLICIES as readonly string[]).includes(payload.reviewPolicy as string)) {
    return err("review_request", "invalid_enum_value", `"${String(payload.reviewPolicy)}" is not a recognized reviewPolicy.`, "reviewPolicy");
  }
  return { ok: true };
}

function validateBlocker(payload: Record<string, unknown>): ProtocolSchemaResult {
  if (payload.resolved !== undefined && typeof payload.resolved !== "boolean") return err("blocker", "wrong_type", "'resolved' must be a boolean.", "resolved");
  if (payload.resolved !== true) {
    if (payload.reason === undefined) return err("blocker", "missing_required_field", "a NEW blocker requires 'reason'.", "reason");
    if (!(BLOCKER_REASONS as readonly string[]).includes(payload.reason as string)) {
      return err("blocker", "invalid_enum_value", `"${String(payload.reason)}" is not a recognized blocker reason.`, "reason");
    }
  }
  if (payload.detail !== undefined && typeof payload.detail !== "string") return err("blocker", "wrong_type", "'detail' must be a string.", "detail");
  return { ok: true };
}

function validateEvidenceNotice(payload: Record<string, unknown>): ProtocolSchemaResult {
  if (payload.evidenceKind !== undefined && !(EVIDENCE_NOTICE_KINDS as readonly string[]).includes(payload.evidenceKind as string)) {
    return err("evidence_notice", "invalid_enum_value", `"${String(payload.evidenceKind)}" is not a recognized evidence kind.`, "evidenceKind");
  }
  return { ok: true };
}

function validateApprovalRequest(payload: Record<string, unknown>): ProtocolSchemaResult {
  if (!isNonEmptyString(payload.subject) || !(APPROVAL_SUBJECTS as readonly string[]).includes(payload.subject)) {
    return err("approval_request", "invalid_enum_value", `"${String(payload.subject)}" is not a recognized approval subject.`, "subject");
  }
  if (payload.assignmentId !== undefined && !isNonEmptyString(payload.assignmentId)) return err("approval_request", "malformed_id", "'assignmentId' must be a non-empty string.", "assignmentId");
  if (payload.findingId !== undefined && !isNonEmptyString(payload.findingId)) return err("approval_request", "malformed_id", "'findingId' must be a non-empty string.", "findingId");
  return { ok: true };
}

function validateCompletionNotice(payload: Record<string, unknown>): ProtocolSchemaResult {
  if (payload.dispatchKey !== undefined && payload.dispatchKey !== null && typeof payload.dispatchKey !== "string") {
    return err("completion_notice", "wrong_type", "'dispatchKey' must be a string or null.", "dispatchKey");
  }
  return { ok: true };
}

/**
 * Validates `structuredPayload`'s SHAPE for the given message type — real
 * runtime checks, never a TypeScript cast. Called BEFORE any domain-semantic
 * validator in mission-collaboration-protocol.ts. An unknown message type
 * (not in `MessageType`) is rejected outright rather than defaulting to "no
 * schema, anything goes."
 */
export function validateStructuredPayloadSchema(messageType: MessageType, structuredPayload: unknown): ProtocolSchemaResult {
  if (!(messageType in ALLOWED_KEYS)) {
    return err(messageType, "unknown_message_type", `"${messageType}" has no registered protocol schema.`);
  }
  const payload = structuredPayload ?? {};
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return err(messageType, "payload_not_an_object", "structuredPayload must be a plain object.");
  }
  const record = payload as Record<string, unknown>;

  const unknownFieldCheck = checkUnknownFields(messageType, record);
  if (unknownFieldCheck) return unknownFieldCheck;

  switch (messageType) {
    case "delegation_response":
      return validateDelegationResponse(record);
    case "review_request":
      return validateReviewRequest(record);
    case "blocker":
      return validateBlocker(record);
    case "evidence_notice":
      return validateEvidenceNotice(record);
    case "approval_request":
      return validateApprovalRequest(record);
    case "completion_notice":
      return validateCompletionNotice(record);
    // delegation_request, question, answer, information carry no
    // structuredPayload fields of their own today — an empty object is the
    // only valid shape, already enforced by checkUnknownFields above.
    case "delegation_request":
    case "question":
    case "answer":
    case "information":
    case "finding":
    case "finding_response":
      return { ok: true };
    default:
      return err(messageType, "unknown_message_type", `"${messageType}" has no registered protocol schema.`);
  }
}
