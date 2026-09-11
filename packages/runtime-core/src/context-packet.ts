/**
 * Provider-neutral context exchange contract.
 *
 * A packet references governed content; it does not embed an unbounded
 * transcript or silently turn one principal's memory into shared memory.
 */

export const CONTEXT_PACKET_VERSION = "m9r.context_packet.v1" as const;

export const CONTEXT_SENSITIVITIES = ["public", "workspace", "private", "restricted"] as const;
export type ContextSensitivity = (typeof CONTEXT_SENSITIVITIES)[number];

export const CONTEXT_REDACTION_STATUSES = ["not_required", "redacted", "verified"] as const;
export type ContextRedactionStatus = (typeof CONTEXT_REDACTION_STATUSES)[number];

export interface ContextPacketBody {
  id: string;
  sourcePrincipalId: string;
  sourceAgentId: string;
  intendedRecipientPrincipalId: string | null;
  purpose: string;
  contentRef: string;
  sensitivity: ContextSensitivity;
  allowedTransformations: string[];
  redactionStatus: ContextRedactionStatus;
  digest: string;
  expiresAt: string | null;
  createdAt: string;
}

export interface ContextPacket {
  version: typeof CONTEXT_PACKET_VERSION;
  packet: ContextPacketBody;
}

export interface ContextPacketValidationIssue {
  path: string;
  code: "required" | "type" | "format" | "range" | "unknown_value" | "policy";
  message: string;
}

export type ContextPacketValidation =
  | { ok: true; value: ContextPacket }
  | { ok: false; errors: ContextPacketValidationIssue[] };

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/;
const DIGEST = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
  value: unknown,
  path: string,
  maxLength: number,
  errors: ContextPacketValidationIssue[],
  id = false,
): string {
  if (typeof value !== "string") {
    errors.push({ path, code: "required", message: "must be a string" });
    return "";
  }
  const normalized = value.trim();
  if (!normalized) errors.push({ path, code: "required", message: "must not be empty" });
  if (normalized.length > maxLength) errors.push({ path, code: "range", message: `must be at most ${maxLength} characters` });
  if (!(id ? SAFE_ID : SAFE_TEXT).test(normalized)) errors.push({ path, code: "format", message: "contains unsupported characters" });
  return normalized;
}

function optionalId(value: unknown, path: string, errors: ContextPacketValidationIssue[]): string | null {
  if (value === null || value === undefined) return null;
  return requiredString(value, path, 160, errors, true) || null;
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
  errors: ContextPacketValidationIssue[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    errors.push({ path, code: "unknown_value", message: `must be one of: ${allowed.join(", ")}` });
    return allowed[0];
  }
  return value as T;
}

function stringList(value: unknown, path: string, errors: ContextPacketValidationIssue[]): string[] {
  if (!Array.isArray(value)) {
    errors.push({ path, code: "type", message: "must be an array" });
    return [];
  }
  if (value.length > 32) errors.push({ path, code: "range", message: "must contain at most 32 items" });
  return value.slice(0, 32).map((item, index) => requiredString(item, `${path}[${index}]`, 240, errors));
}

function isoDate(value: unknown, path: string, errors: ContextPacketValidationIssue[], nullable: boolean): string | null {
  if (nullable && (value === null || value === undefined)) return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    errors.push({ path, code: "format", message: nullable ? "must be a valid ISO-8601 date or null" : "must be a valid ISO-8601 date" });
    return null;
  }
  return new Date(value).toISOString();
}

/** Validate and normalize a packet without reading or copying its content. */
export function parseContextPacket(input: unknown): ContextPacketValidation {
  const errors: ContextPacketValidationIssue[] = [];
  if (!isRecord(input)) return { ok: false, errors: [{ path: "$", code: "type", message: "must be an object" }] };
  if (input.version !== CONTEXT_PACKET_VERSION) {
    errors.push({ path: "version", code: "unknown_value", message: `must equal ${CONTEXT_PACKET_VERSION}` });
  }
  if (!isRecord(input.packet)) {
    return { ok: false, errors: [...errors, { path: "packet", code: "required", message: "must be an object" }] };
  }
  const raw = input.packet;
  const sensitivity = enumValue(raw.sensitivity, CONTEXT_SENSITIVITIES, "packet.sensitivity", errors);
  const redactionStatus = enumValue(raw.redactionStatus, CONTEXT_REDACTION_STATUSES, "packet.redactionStatus", errors);
  const packet: ContextPacketBody = {
    id: requiredString(raw.id, "packet.id", 160, errors, true),
    sourcePrincipalId: requiredString(raw.sourcePrincipalId, "packet.sourcePrincipalId", 160, errors, true),
    sourceAgentId: requiredString(raw.sourceAgentId, "packet.sourceAgentId", 160, errors, true),
    intendedRecipientPrincipalId: optionalId(raw.intendedRecipientPrincipalId, "packet.intendedRecipientPrincipalId", errors),
    purpose: requiredString(raw.purpose, "packet.purpose", 240, errors),
    contentRef: requiredString(raw.contentRef, "packet.contentRef", 500, errors),
    sensitivity,
    allowedTransformations: stringList(raw.allowedTransformations, "packet.allowedTransformations", errors),
    redactionStatus,
    digest: requiredString(raw.digest, "packet.digest", 64, errors).toLowerCase(),
    expiresAt: isoDate(raw.expiresAt, "packet.expiresAt", errors, true),
    createdAt: isoDate(raw.createdAt, "packet.createdAt", errors, false) ?? "",
  };
  if (!DIGEST.test(packet.digest)) errors.push({ path: "packet.digest", code: "format", message: "must be a lowercase SHA-256 hex digest" });
  if (sensitivity === "restricted" && redactionStatus !== "verified") {
    errors.push({ path: "packet.redactionStatus", code: "policy", message: "restricted packets require verified redaction" });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: { version: CONTEXT_PACKET_VERSION, packet } };
}

export function isContextPacketExpired(packet: ContextPacket, nowMs = Date.now()): boolean {
  return packet.packet.expiresAt !== null && Date.parse(packet.packet.expiresAt) <= nowMs;
}
