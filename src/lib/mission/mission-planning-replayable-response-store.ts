/**
 * Planning replayable-response store — Phase 5E Task B.
 * ----------------------------------------------------------------------------
 * Durably captures the bounded, redacted raw model output for a worker
 * attempt so `rerun_deterministic_pipeline_only` recovery
 * (`mission-planning-recovery.ts` / a future recovery executor) has real
 * replay material to re-run the deterministic pipeline against, closing the
 * gap documented in `docs/PHASE_5E_REPLAY_MATERIAL_AUDIT.md`.
 *
 * One row per `workerAttemptId` (never per stage, unlike the diagnostics
 * store) — a worker attempt gets exactly one model response worth
 * replaying. A later `store()` call for the same `workerAttemptId` with a
 * DIFFERENT `outputDigest` is refused, never silently overwritten: the
 * stored material a replay might already depend on must never change out
 * from under it. Same `workerAttemptId` + same digest is an idempotent
 * no-op (retried call after a crash), matching the diagnostics store's
 * idempotency semantics.
 *
 * Callers MUST pass already-redacted text (via
 * `redactForDiagnostics`/`mission-planning-redaction.ts`) — this store does
 * not redact for you, exactly like `mission-planning-diagnostics-store.ts`.
 */

export interface PlanningReplayableResponseRecord {
  workerAttemptId: string;
  workspaceId: string;
  missionId: string;
  planningRequestId: string;
  modelConfigurationId: string;
  schemaVersion: number;
  redactedRawOutput: string;
  outputDigest: string;
  createdAt: string;
}

export interface StoreReplayableResponseInput {
  workerAttemptId: string;
  workspaceId: string;
  missionId: string;
  planningRequestId: string;
  modelConfigurationId: string;
  schemaVersion: number;
  /** Already redacted by the caller — see the file header. */
  redactedRawOutput: string;
  outputDigest: string;
  createdAt: string;
}

export type StoreReplayableResponseResult =
  | { status: "ok"; reason: "created" | "idempotent_replay"; response: PlanningReplayableResponseRecord }
  | { status: "refused"; reason: "digest_conflict"; response: PlanningReplayableResponseRecord };

export interface PlanningReplayableResponseStore {
  store(input: StoreReplayableResponseInput): Promise<StoreReplayableResponseResult> | StoreReplayableResponseResult;
  get(workspaceId: string, workerAttemptId: string): Promise<PlanningReplayableResponseRecord | null> | (PlanningReplayableResponseRecord | null);
}

/** Byte-for-byte the same digest algorithm `mission-planning-diagnostics-store.ts` uses (SHA-256 hex over a JSON-stable source). */
export async function computeReplayableResponseDigest(redactedRawOutput: string): Promise<string> {
  const data = new TextEncoder().encode(redactedRawOutput);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class InMemoryPlanningReplayableResponseStore implements PlanningReplayableResponseStore {
  private readonly records = new Map<string, PlanningReplayableResponseRecord>();

  async store(input: StoreReplayableResponseInput): Promise<StoreReplayableResponseResult> {
    const existing = this.records.get(input.workerAttemptId);
    if (existing) {
      if (existing.outputDigest === input.outputDigest) {
        return { status: "ok", reason: "idempotent_replay", response: existing };
      }
      return { status: "refused", reason: "digest_conflict", response: existing };
    }
    const record: PlanningReplayableResponseRecord = {
      workerAttemptId: input.workerAttemptId,
      workspaceId: input.workspaceId,
      missionId: input.missionId,
      planningRequestId: input.planningRequestId,
      modelConfigurationId: input.modelConfigurationId,
      schemaVersion: input.schemaVersion,
      redactedRawOutput: input.redactedRawOutput,
      outputDigest: input.outputDigest,
      createdAt: input.createdAt,
    };
    this.records.set(input.workerAttemptId, record);
    return { status: "ok", reason: "created", response: record };
  }

  get(workspaceId: string, workerAttemptId: string): PlanningReplayableResponseRecord | null {
    const record = this.records.get(workerAttemptId);
    if (!record) return null;
    if (record.workspaceId !== workspaceId) return null;
    return record;
  }
}
