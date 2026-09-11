/**
 * Evidence Contract — OathLock V2 Phase 1
 * ----------------------------------------------------------------------------
 * A versioned, structured shape for agent-submitted evidence, replacing "paste
 * some free text and hope it's parseable" with a schema the agent fills in and
 * OathLock validates before a human ever sees it.
 *
 * This does not replace the existing free-text evidence path
 * (approved-evidence-record.ts) — sessions submitted without a contract still
 * flow through that parser (the legacy-record fallback). When a contract IS
 * present, it is validated here first.
 *
 * Claim discipline (same rules as quality-signal-extraction.ts and
 * agent-run-core.ts, applied to structured evidence instead of free text):
 *  - A verification result with no command is not evidence — reject it.
 *  - A command with no result state is incomplete — reject it.
 *  - Two entries for the same command with contradictory results are a
 *    contradiction — reject it, do not silently prefer one.
 *  - Secret-shaped content and active script/markup are never allowed through,
 *    in any string field.
 *  - Agents cannot mark their own evidence approved (human_approved must be an
 *    externally-supplied flag, not a field inside the contract body).
 */

import { looksLikeSourceCode, SECRET_PATTERNS } from "./agent-run-core";
import { containsActiveContent } from "./agent-join";

export const EVIDENCE_CONTRACT_SCHEMA_VERSION = "m9r.evidence.v1" as const;

export type EvidenceSource = "agent_recorded" | "human_confirmed";

export interface EvidenceChange {
  summary: string;
  files: string[];
}

export interface EvidenceVerification {
  command: string;
  result: "passed" | "failed";
  exit_code: number;
  source: EvidenceSource;
  observed_at: string;
  artifact_digest: string;
}

export interface EvidenceContract {
  schemaVersion: typeof EVIDENCE_CONTRACT_SCHEMA_VERSION;
  task: {
    requested: string;
    scope_changes: string[];
  };
  changes: EvidenceChange[];
  verification: EvidenceVerification[];
  failed_commands: string[];
  limitations: string[];
  sensitive_areas: string[];
}

const MAX_CONTRACT_CHARS = 50_000;
const MAX_LIST_ITEMS = 200;

export interface EvidenceValidationIssue {
  field: string;
  message: string;
}

export interface EvidenceValidationResult {
  ok: boolean;
  /** Hard failures — the contract must not be stored or shown for approval. */
  errors: EvidenceValidationIssue[];
  /** Soft flags — stored and shown, but surfaced to the human reviewer. */
  warnings: EvidenceValidationIssue[];
  /** The contract with strings trimmed/capped, only meaningful when ok. */
  normalized: EvidenceContract | null;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string").slice(0, MAX_LIST_ITEMS);
}

/** True when any string in the contract looks like a raw secret or active script/markup. */
function scanForUnsafeContent(strings: string[]): string | null {
  for (const s of strings) {
    if (containsActiveContent(s)) return "active script or markup content";
    if (looksLikeSourceCode(s)) return "raw source code content";
    for (const [pattern] of SECRET_PATTERNS) {
      if (pattern.test(s)) return "secret-shaped content";
      pattern.lastIndex = 0;
    }
  }
  return null;
}

/**
 * Validate a candidate Evidence Contract payload.
 *
 * `humanApprovedSubmission` must come from the caller's own auth/consent check
 * (e.g. the existing `human_approved_submission` gate on session submission) —
 * never from a field inside the untrusted payload, so an agent cannot mark its
 * own evidence approved by including the right JSON key.
 */
export function validateEvidenceContract(
  raw: unknown,
  opts: { humanApprovedSubmission: boolean; nowMs?: number; maxEvidenceAgeMs?: number },
): EvidenceValidationResult {
  const errors: EvidenceValidationIssue[] = [];
  const warnings: EvidenceValidationIssue[] = [];

  if (!opts.humanApprovedSubmission) {
    errors.push({ field: "$", message: "Evidence cannot be recorded without human_approved_submission." });
  }

  if (typeof raw !== "object" || raw === null) {
    errors.push({ field: "$", message: "Evidence contract must be an object." });
    return { ok: false, errors, warnings, normalized: null };
  }

  const size = JSON.stringify(raw).length;
  if (size > MAX_CONTRACT_CHARS) {
    errors.push({ field: "$", message: `Evidence contract exceeds ${MAX_CONTRACT_CHARS} characters.` });
  }

  const body = raw as Record<string, unknown>;

  if (body.schemaVersion !== EVIDENCE_CONTRACT_SCHEMA_VERSION) {
    errors.push({
      field: "schemaVersion",
      message: `Expected schemaVersion "${EVIDENCE_CONTRACT_SCHEMA_VERSION}", got ${JSON.stringify(body.schemaVersion)}.`,
    });
  }

  const taskRaw = (body.task ?? {}) as Record<string, unknown>;
  const requested = isNonEmptyString(taskRaw.requested) ? taskRaw.requested.trim() : "";
  if (!requested) errors.push({ field: "task.requested", message: "task.requested is required." });
  const scopeChanges = asStringArray(taskRaw.scope_changes);

  const changesRaw = Array.isArray(body.changes) ? body.changes : [];
  const changes: EvidenceChange[] = [];
  const allChangedFiles: string[] = [];
  for (const [i, c] of changesRaw.entries()) {
    const change = (c ?? {}) as Record<string, unknown>;
    const summary = isNonEmptyString(change.summary) ? change.summary.trim() : "";
    if (!summary) {
      errors.push({ field: `changes[${i}].summary`, message: "Each change needs a summary." });
      continue;
    }
    const files = asStringArray(change.files);
    if (files.length === 0) {
      warnings.push({ field: `changes[${i}].files`, message: "Change has no listed files." });
    }
    allChangedFiles.push(...files);
    changes.push({ summary, files });
  }
  if (changesRaw.length > 0 && allChangedFiles.length === 0) {
    errors.push({
      field: "changes",
      message: "Changed-file count does not reconcile: changes were reported but no files were listed.",
    });
  }

  const verificationRaw = Array.isArray(body.verification) ? body.verification : [];
  const verification: EvidenceVerification[] = [];
  const seenCommands = new Map<string, "passed" | "failed">();
  for (const [i, v] of verificationRaw.entries()) {
    const entry = (v ?? {}) as Record<string, unknown>;
    const command = isNonEmptyString(entry.command) ? entry.command.trim() : "";
    const result = entry.result === "passed" || entry.result === "failed" ? entry.result : null;
    const source = entry.source === "agent_recorded" || entry.source === "human_confirmed" ? entry.source : null;

    if (!command && result) {
      errors.push({ field: `verification[${i}]`, message: "A result with no command is not evidence." });
      continue;
    }
    if (command && !result) {
      errors.push({ field: `verification[${i}]`, message: `Command "${command}" has no result state.` });
      continue;
    }
    if (!command || !result) continue;
    if (!source) {
      errors.push({ field: `verification[${i}].source`, message: "Missing source classification (agent_recorded | human_confirmed)." });
      continue;
    }

    const prior = seenCommands.get(command);
    if (prior && prior !== result) {
      errors.push({
        field: `verification[${i}]`,
        message: `Contradictory results for "${command}": both passed and failed were reported.`,
      });
      continue;
    }
    seenCommands.set(command, result);

    const exitCode = Number.isSafeInteger(entry.exit_code) ? entry.exit_code as number : null;
    if (exitCode === null) {
      errors.push({ field: `verification[${i}].exit_code`, message: "A recorded integer exit_code is required." });
      continue;
    }
    if ((result === "passed" && exitCode !== 0) || (result === "failed" && exitCode === 0)) {
      errors.push({ field: `verification[${i}].exit_code`, message: "exit_code contradicts the reported result." });
      continue;
    }
    const observedMs = typeof entry.observed_at === "string" ? Date.parse(entry.observed_at) : NaN;
    const nowMs = opts.nowMs ?? Date.now();
    const maxAge = opts.maxEvidenceAgeMs ?? 24 * 60 * 60_000;
    if (!Number.isFinite(observedMs) || observedMs > nowMs + 60_000 || nowMs - observedMs > maxAge) {
      errors.push({ field: `verification[${i}].observed_at`, message: "Verification timestamp is invalid, stale, or in the future." });
      continue;
    }
    const digest = typeof entry.artifact_digest === "string" ? entry.artifact_digest.toLowerCase() : "";
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
      errors.push({ field: `verification[${i}].artifact_digest`, message: "A sha256 artifact_digest is required." });
      continue;
    }
    verification.push({ command, result, exit_code: exitCode, source, observed_at: new Date(observedMs).toISOString(), artifact_digest: digest });
  }

  const failedCommands = asStringArray(body.failed_commands);
  const limitations = asStringArray(body.limitations);
  const sensitiveAreas = asStringArray(body.sensitive_areas);

  if (scopeChanges.length > 0) {
    warnings.push({ field: "task.scope_changes", message: "Run reported scope changes — confirm they were approved before recording." });
  }

  const allStrings = [
    requested,
    ...scopeChanges,
    ...changes.flatMap((c) => [c.summary, ...c.files]),
    ...verification.flatMap((v) => [v.command, v.observed_at, v.artifact_digest]),
    ...failedCommands,
    ...limitations,
    ...sensitiveAreas,
  ];
  const unsafe = scanForUnsafeContent(allStrings);
  if (unsafe) errors.push({ field: "$", message: `Rejected: ${unsafe} found in evidence.` });

  if (errors.length > 0) {
    return { ok: false, errors, warnings, normalized: null };
  }

  const normalized: EvidenceContract = {
    schemaVersion: EVIDENCE_CONTRACT_SCHEMA_VERSION,
    task: { requested, scope_changes: scopeChanges },
    changes,
    verification,
    failed_commands: failedCommands,
    limitations,
    sensitive_areas: sensitiveAreas,
  };

  return { ok: true, errors, warnings, normalized };
}

/**
 * The human-facing approval preview described in the V2 spec: what was
 * recorded, and what remains unknown/unsupported. Never claims more than the
 * validated contract actually contains.
 */
export interface EvidenceApprovalPreview {
  changedFileCount: number;
  commandTiedChecks: number;
  limitationsStated: number;
  scopeChangesDeclared: number;
  sensitiveAreasDeclared: number;
}

export function buildEvidenceApprovalPreview(contract: EvidenceContract): EvidenceApprovalPreview {
  const changedFileCount = new Set(contract.changes.flatMap((c) => c.files)).size;
  return {
    changedFileCount,
    commandTiedChecks: contract.verification.length,
    limitationsStated: contract.limitations.length,
    scopeChangesDeclared: contract.task.scope_changes.length,
    sensitiveAreasDeclared: contract.sensitive_areas.length,
  };
}
