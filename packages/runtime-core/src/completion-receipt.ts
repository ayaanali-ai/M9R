/**
 * Portable evidence-backed result contract for a Goal.
 *
 * A receipt records what was observed and what remains unresolved. It is not
 * a model-generated assertion that work is complete.
 */

export const COMPLETION_RECEIPT_VERSION = "m9r.completion_receipt.v1" as const;

export const COMPLETION_STATUSES = ["achieved", "failed", "blocked", "needs_decision"] as const;
export type CompletionStatus = (typeof COMPLETION_STATUSES)[number];

export const EVIDENCE_KINDS = ["artifact", "test", "diff", "observation", "approval", "run"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface ReceiptCondition {
  condition: string;
  satisfied: boolean;
  evidenceIds: string[];
}

export interface ReceiptEvidenceRef {
  id: string;
  kind: EvidenceKind;
  summary: string;
  digest: string | null;
}

export interface CompletionReceiptBody {
  receiptId: string;
  goalId: string;
  missionId: string | null;
  status: CompletionStatus;
  conditions: ReceiptCondition[];
  evidence: ReceiptEvidenceRef[];
  agentIds: string[];
  providerIds: string[];
  approvals: string[];
  unresolvedRisks: string[];
  decisionsRequired: string[];
  contextPacketIds: string[];
  startedAt: string | null;
  completedAt: string | null;
  generatedAt: string;
}

export interface CompletionReceipt {
  version: typeof COMPLETION_RECEIPT_VERSION;
  receipt: CompletionReceiptBody;
}

export interface CompletionReceiptValidationIssue {
  path: string;
  code: "required" | "type" | "format" | "range" | "unknown_value" | "policy";
  message: string;
}

export type CompletionReceiptValidation =
  | { ok: true; value: CompletionReceipt }
  | { ok: false; errors: CompletionReceiptValidationIssue[] };

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, path: string, errors: CompletionReceiptValidationIssue[], max = 240): string {
  if (typeof value !== "string" || !value.trim()) {
    errors.push({ path, code: "required", message: "must be a non-empty string" });
    return "";
  }
  const normalized = value.trim();
  if (normalized.length > max) errors.push({ path, code: "range", message: `must be at most ${max} characters` });
  if (!/^[^\u0000-\u001f\u007f]+$/.test(normalized)) errors.push({ path, code: "format", message: "contains control characters" });
  return normalized;
}

function idValue(value: unknown, path: string, errors: CompletionReceiptValidationIssue[]): string {
  const id = stringValue(value, path, errors, 160);
  if (id && !SAFE_ID.test(id)) errors.push({ path, code: "format", message: "contains unsupported identifier characters" });
  return id;
}

function optionalId(value: unknown, path: string, errors: CompletionReceiptValidationIssue[]): string | null {
  if (value === null || value === undefined) return null;
  return idValue(value, path, errors) || null;
}

function list(value: unknown, path: string, errors: CompletionReceiptValidationIssue[], max = 64): string[] {
  if (!Array.isArray(value)) {
    errors.push({ path, code: "type", message: "must be an array" });
    return [];
  }
  if (value.length > max) errors.push({ path, code: "range", message: `must contain at most ${max} items` });
  return value.slice(0, max).map((item, index) => stringValue(item, `${path}[${index}]`, errors));
}

function dateValue(value: unknown, path: string, errors: CompletionReceiptValidationIssue[], nullable: boolean): string | null {
  if (nullable && (value === null || value === undefined)) return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    errors.push({ path, code: "format", message: nullable ? "must be a valid ISO-8601 date or null" : "must be a valid ISO-8601 date" });
    return null;
  }
  return new Date(value).toISOString();
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], path: string, errors: CompletionReceiptValidationIssue[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    errors.push({ path, code: "unknown_value", message: `must be one of: ${allowed.join(", ")}` });
    return allowed[0];
  }
  return value as T;
}

/** Validate a receipt without trusting its status or evidence claims. */
export function parseCompletionReceipt(input: unknown): CompletionReceiptValidation {
  const errors: CompletionReceiptValidationIssue[] = [];
  if (!isRecord(input)) return { ok: false, errors: [{ path: "$", code: "type", message: "must be an object" }] };
  if (input.version !== COMPLETION_RECEIPT_VERSION) errors.push({ path: "version", code: "unknown_value", message: `must equal ${COMPLETION_RECEIPT_VERSION}` });
  if (!isRecord(input.receipt)) return { ok: false, errors: [...errors, { path: "receipt", code: "required", message: "must be an object" }] };
  const raw = input.receipt;
  const status = enumValue(raw.status, COMPLETION_STATUSES, "receipt.status", errors);
  const conditionsRaw = Array.isArray(raw.conditions) ? raw.conditions : [];
  if (!Array.isArray(raw.conditions)) errors.push({ path: "receipt.conditions", code: "type", message: "must be an array" });
  if (conditionsRaw.length > 64) errors.push({ path: "receipt.conditions", code: "range", message: "must contain at most 64 items" });
  const conditions: ReceiptCondition[] = conditionsRaw.slice(0, 64).map((item, index) => {
    if (!isRecord(item)) {
      errors.push({ path: `receipt.conditions[${index}]`, code: "type", message: "must be an object" });
      return { condition: "", satisfied: false, evidenceIds: [] };
    }
    const evidenceIds = list(item.evidenceIds, `receipt.conditions[${index}].evidenceIds`, errors, 64).map((id, evidenceIndex) => {
      if (!SAFE_ID.test(id)) errors.push({ path: `receipt.conditions[${index}].evidenceIds[${evidenceIndex}]`, code: "format", message: "contains unsupported identifier characters" });
      return id;
    });
    if (typeof item.satisfied !== "boolean") errors.push({ path: `receipt.conditions[${index}].satisfied`, code: "type", message: "must be a boolean" });
    return { condition: stringValue(item.condition, `receipt.conditions[${index}].condition`, errors, 500), satisfied: item.satisfied === true, evidenceIds };
  });
  const evidenceRaw = Array.isArray(raw.evidence) ? raw.evidence : [];
  if (!Array.isArray(raw.evidence)) errors.push({ path: "receipt.evidence", code: "type", message: "must be an array" });
  const evidence: ReceiptEvidenceRef[] = evidenceRaw.slice(0, 128).map((item, index) => {
    if (!isRecord(item)) {
      errors.push({ path: `receipt.evidence[${index}]`, code: "type", message: "must be an object" });
      return { id: "", kind: "observation", summary: "", digest: null };
    }
    let digest: string | null = null;
    if (item.digest !== null && item.digest !== undefined) {
      digest = stringValue(item.digest, `receipt.evidence[${index}].digest`, errors, 64).toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(digest)) errors.push({ path: `receipt.evidence[${index}].digest`, code: "format", message: "must be a lowercase SHA-256 hex digest or null" });
    }
    return {
      id: idValue(item.id, `receipt.evidence[${index}].id`, errors),
      kind: enumValue(item.kind, EVIDENCE_KINDS, `receipt.evidence[${index}].kind`, errors),
      summary: stringValue(item.summary, `receipt.evidence[${index}].summary`, errors, 500),
      digest,
    };
  });
  if (evidenceRaw.length > 128) errors.push({ path: "receipt.evidence", code: "range", message: "must contain at most 128 items" });
  const receipt: CompletionReceiptBody = {
    receiptId: idValue(raw.receiptId, "receipt.receiptId", errors),
    goalId: idValue(raw.goalId, "receipt.goalId", errors),
    missionId: optionalId(raw.missionId, "receipt.missionId", errors),
    status,
    conditions,
    evidence,
    agentIds: list(raw.agentIds, "receipt.agentIds", errors).map((id, index) => { if (!SAFE_ID.test(id)) errors.push({ path: `receipt.agentIds[${index}]`, code: "format", message: "contains unsupported identifier characters" }); return id; }),
    providerIds: list(raw.providerIds, "receipt.providerIds", errors),
    approvals: list(raw.approvals, "receipt.approvals", errors),
    unresolvedRisks: list(raw.unresolvedRisks, "receipt.unresolvedRisks", errors, 32),
    decisionsRequired: list(raw.decisionsRequired, "receipt.decisionsRequired", errors, 32),
    contextPacketIds: list(raw.contextPacketIds, "receipt.contextPacketIds", errors),
    startedAt: dateValue(raw.startedAt, "receipt.startedAt", errors, true),
    completedAt: dateValue(raw.completedAt, "receipt.completedAt", errors, true),
    generatedAt: dateValue(raw.generatedAt, "receipt.generatedAt", errors, false) ?? "",
  };
  const evidenceIds = new Set(receipt.evidence.map((item) => item.id));
  for (const [conditionIndex, condition] of receipt.conditions.entries()) {
    for (const [evidenceIndex, evidenceId] of condition.evidenceIds.entries()) {
      if (!evidenceIds.has(evidenceId)) {
        errors.push({
          path: `receipt.conditions[${conditionIndex}].evidenceIds[${evidenceIndex}]`,
          code: "policy",
          message: "must reference an evidence item in this receipt",
        });
      }
    }
  }
  if (status === "achieved" && (receipt.conditions.length === 0 || receipt.conditions.some((condition) => !condition.satisfied))) {
    errors.push({ path: "receipt.conditions", code: "policy", message: "achieved receipts require every declared condition to be satisfied" });
  }
  if (status === "achieved" && receipt.evidence.length === 0) errors.push({ path: "receipt.evidence", code: "policy", message: "achieved receipts require evidence" });
  if (status === "achieved" && receipt.evidence.some((item) => item.digest === null)) errors.push({ path: "receipt.evidence", code: "policy", message: "achieved receipts require a digest for every evidence item" });
  if (status === "needs_decision" && receipt.decisionsRequired.length === 0) errors.push({ path: "receipt.decisionsRequired", code: "policy", message: "needs_decision receipts require at least one decision" });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: { version: COMPLETION_RECEIPT_VERSION, receipt } };
}
