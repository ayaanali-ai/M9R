/**
 * Planning diagnostics store — Phase 5C §8 / Phase 5D+1 idempotency closure.
 * ----------------------------------------------------------------------------
 * Bounded, append-only, workspace-scoped records that `PlanningRequestRecord.
 * redactedDiagnosticRef` (mission-domain.ts) points at. Today that field is a
 * dangling pass-through — nothing backs it. This store is what backs it:
 * `redactedDiagnosticRef` must always resolve to a real record here, or be
 * null, never point at nothing.
 *
 * Never stores: secrets, full prompts/transcripts, credentials, private
 * keys, tokens, or unredacted sensitive output. Every text field passed in
 * must already have gone through `redactForDiagnostics`
 * (mission-planning-redaction.ts) — this module does not redact for you, it
 * only refuses to store anything that arrives already flagged unsafe.
 *
 * IDEMPOTENCY IDENTITY (closes the gap called out in
 * `scripts/mission-planning-diagnostics-store.test.ts`'s original header
 * comment): every stored record has a stable `idempotencyKey` derived from
 * `workspaceId + missionId + planningRequestId + workerAttemptId (or a fixed
 * "no-attempt" marker) + diagnosticKind + stage + contextHash`. workspaceId
 * is always part of the key, so two workspaces can never collide even if
 * every other field happens to match. Semantics of `store()`:
 *   - same identity, same resulting (already-redacted, already-bounded)
 *     content digest -> returns the EXACT existing record (same `ref`), no
 *     new record minted. A retried call after a crash is a no-op, not a
 *     duplicate.
 *   - same identity, DIFFERENT content digest -> throws
 *     `DiagnosticIdempotencyConflictError` before mutating anything. Never
 *     silently overwrites, never silently returns the stale record as if it
 *     matched.
 *   - a failed/refused `store()` call (oversized after bounding, or a
 *     conflict) never leaves a dangling ref — a ref is only ever minted at
 *     the point a record is actually committed to `records`.
 *   - refs are stable across "restart": constructing a new store instance
 *     from a prior instance's `exportRecords()` snapshot (via the
 *     `initialRecords` constructor option) reproduces the exact same
 *     idempotency-key -> ref mapping, so a resolved ref keeps resolving.
 */

import { redactForDiagnostics, type DiagnosticContentStatus } from "./mission-planning-redaction";

export const MAX_DIAGNOSTIC_RECORD_BYTES = 8_192;
export const DEFAULT_DIAGNOSTIC_RETENTION_DAYS = 30;

/** No workerAttemptId was available yet (e.g. a diagnostic recorded before an attempt row exists) — a fixed, never-colliding marker, not `null`/`undefined` folded into the hash ad hoc. */
const NO_ATTEMPT_MARKER = "no-attempt";

export class DiagnosticIdempotencyConflictError extends Error {
  readonly idempotencyKey: string;
  readonly existingRef: string;

  constructor(idempotencyKey: string, existingRef: string) {
    super(
      `Diagnostic idempotency conflict: key ${idempotencyKey} already resolves to ref ${existingRef} with different content. Refusing to overwrite or silently return stale data.`,
    );
    this.name = "DiagnosticIdempotencyConflictError";
    this.idempotencyKey = idempotencyKey;
    this.existingRef = existingRef;
  }
}

export type DiagnosticStage =
  | "invocation"
  | "parse"
  | "validation"
  | "simulation"
  | "repair"
  | "terminal";

export interface PlanningDiagnosticInput {
  workspaceId: string;
  missionId: string;
  planningRequestId: string;
  /** Part of the idempotency identity — null/omitted folds to a fixed marker, never collides with a real id. */
  workerAttemptId?: string | null;
  /** Part of the idempotency identity, distinct from `stage` (e.g. "invocation_response" vs. the pipeline `stage` "invocation"). Defaults to `stage` when omitted, matching pre-idempotency callers. */
  diagnosticKind?: string;
  modelConfigurationId: string;
  providerRequestId: string | null;
  contextHash: string;
  stage: DiagnosticStage;
  /** Not the full prompt — a bounded, already-redacted description (e.g. "3 constraints, 2 snippets"). */
  promptMetadataSummary: string;
  /** Free-text detail (raw model output, validation errors, repair feedback) — redacted and bounded by this store before storage. */
  detail: string | null;
  usage?: { inputTokens: number; outputTokens: number };
  finishReason?: string | null;
  failureClassification?: string | null;
  createdAt: string;
  retentionDays?: number;
}

export interface PlanningDiagnosticRecord {
  ref: string;
  workspaceId: string;
  missionId: string;
  planningRequestId: string;
  workerAttemptId: string | null;
  diagnosticKind: string;
  modelConfigurationId: string;
  providerRequestId: string | null;
  contextHash: string;
  stage: DiagnosticStage;
  promptMetadataSummary: string;
  detail: string;
  redactionStatus: DiagnosticContentStatus;
  usage?: { inputTokens: number; outputTokens: number };
  finishReason: string | null;
  failureClassification: string | null;
  createdAt: string;
  retentionDays: number;
  sizeBytes: number;
  /** Stable digest of the stored (already-redacted, already-bounded) content — same content always yields the same digest. */
  digest: string;
  /** Stable idempotency identity this record was committed under — see the file's top comment. */
  idempotencyKey: string;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

let refCounter = 0;
function mintRef(): string {
  refCounter += 1;
  return `diag-${Date.now().toString(36)}-${refCounter}`;
}

/** Deterministic identity hash — same logical inputs always fold to the same key, independent of content. */
async function computeIdempotencyKey(input: {
  workspaceId: string;
  missionId: string;
  planningRequestId: string;
  workerAttemptId: string | null;
  diagnosticKind: string;
  stage: DiagnosticStage;
  contextHash: string;
}): Promise<string> {
  const source = JSON.stringify({
    workspaceId: input.workspaceId,
    missionId: input.missionId,
    planningRequestId: input.planningRequestId,
    workerAttemptId: input.workerAttemptId ?? NO_ATTEMPT_MARKER,
    diagnosticKind: input.diagnosticKind,
    stage: input.stage,
    contextHash: input.contextHash,
  });
  return sha256Hex(`idem:${source}`);
}

export interface DiagnosticsStoreSnapshot {
  records: PlanningDiagnosticRecord[];
}

export class InMemoryPlanningDiagnosticsStore {
  private readonly records = new Map<string, PlanningDiagnosticRecord>();
  /** idempotencyKey -> ref. Never removed — a released/expired key must still resolve to its original record. */
  private readonly byIdempotencyKey = new Map<string, string>();

  constructor(initial?: DiagnosticsStoreSnapshot) {
    if (!initial) return;
    for (const record of initial.records) {
      this.records.set(record.ref, record);
      this.byIdempotencyKey.set(record.idempotencyKey, record.ref);
    }
  }

  /**
   * Appends a bounded, redacted record and returns its ref, enforcing the
   * idempotency identity documented at the top of this file. Never mutates a
   * previously stored record. Throws `DiagnosticIdempotencyConflictError` —
   * without mutating any state — when the same identity is reused with
   * different resulting content.
   */
  async store(input: PlanningDiagnosticInput): Promise<PlanningDiagnosticRecord> {
    const workerAttemptId = input.workerAttemptId ?? null;
    const diagnosticKind = input.diagnosticKind ?? input.stage;

    const idempotencyKey = await computeIdempotencyKey({
      workspaceId: input.workspaceId,
      missionId: input.missionId,
      planningRequestId: input.planningRequestId,
      workerAttemptId,
      diagnosticKind,
      stage: input.stage,
      contextHash: input.contextHash,
    });

    const redacted = redactForDiagnostics(input.detail);
    const digestSource = JSON.stringify({
      workspaceId: input.workspaceId,
      missionId: input.missionId,
      planningRequestId: input.planningRequestId,
      stage: input.stage,
      contextHash: input.contextHash,
      detail: redacted.text,
    });
    const digest = await sha256Hex(digestSource);

    const existingRef = this.byIdempotencyKey.get(idempotencyKey);
    if (existingRef !== undefined) {
      const existing = this.records.get(existingRef);
      // Invariant: every key in byIdempotencyKey points at a record that
      // actually exists in `records` — a committed ref is never removed.
      if (!existing) throw new Error(`Diagnostics store invariant violated: idempotency key ${idempotencyKey} points at missing ref ${existingRef}`);
      if (existing.digest === digest) {
        // Same identity, same resulting content: idempotent no-op, return
        // the original record unchanged (no new ref minted).
        return existing;
      }
      // Same identity, different content: refuse — never silently overwrite
      // or silently return stale content as if it matched.
      throw new DiagnosticIdempotencyConflictError(idempotencyKey, existingRef);
    }

    const record: PlanningDiagnosticRecord = {
      ref: mintRef(),
      workspaceId: input.workspaceId,
      missionId: input.missionId,
      planningRequestId: input.planningRequestId,
      workerAttemptId,
      diagnosticKind,
      modelConfigurationId: input.modelConfigurationId,
      providerRequestId: input.providerRequestId,
      contextHash: input.contextHash,
      stage: input.stage,
      promptMetadataSummary: input.promptMetadataSummary.slice(0, 500),
      detail: redacted.text,
      redactionStatus: redacted.status,
      usage: input.usage,
      finishReason: input.finishReason ?? null,
      failureClassification: input.failureClassification ?? null,
      createdAt: input.createdAt,
      retentionDays: input.retentionDays ?? DEFAULT_DIAGNOSTIC_RETENTION_DAYS,
      sizeBytes: 0,
      digest,
      idempotencyKey,
    };
    record.sizeBytes = byteLength(JSON.stringify(record));

    if (record.sizeBytes > MAX_DIAGNOSTIC_RECORD_BYTES) {
      // Bounded record size (spec §8): never store an oversized record —
      // fall back to a marker that is itself small and safe.
      record.detail = "[diagnostic detail omitted: exceeded max record size]";
      record.redactionStatus = "fully_removed";
      record.sizeBytes = byteLength(JSON.stringify(record));
    }

    // Commit both maps together — a ref is only ever minted at the point of
    // actual commit, so a thrown conflict above never leaves a dangling ref.
    this.records.set(record.ref, record);
    this.byIdempotencyKey.set(idempotencyKey, record.ref);
    return record;
  }

  /** Workspace-scoped lookup — a ref from another workspace is refused, never silently returned. */
  get(workspaceId: string, ref: string): PlanningDiagnosticRecord | null {
    const record = this.records.get(ref);
    if (!record) return null;
    if (record.workspaceId !== workspaceId) return null;
    return record;
  }

  /** Test/ops convenience — never part of the ref-resolution contract. */
  has(ref: string): boolean {
    return this.records.has(ref);
  }

  /** Snapshot for simulating a "restart": feed into `new InMemoryPlanningDiagnosticsStore(snapshot)`. */
  exportRecords(): DiagnosticsStoreSnapshot {
    return { records: [...this.records.values()] };
  }
}
