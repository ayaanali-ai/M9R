/**
 * Supabase-backed planning diagnostics store — calls the atomic RPCs in
 * `supabase/migrations/20260727030000_mission_planning_diagnostics.sql`.
 * ----------------------------------------------------------------------------
 * Verified in `mission-planning-diagnostics-store-supabase.test.ts` only at
 * the RPC-argument-shape level, against a fake SupabaseClient — the same
 * boundary `mission-scheduler-store-supabase.test.ts` and
 * `mission-store-supabase.test.ts` draw. This does NOT exercise the actual
 * UNIQUE-constraint/idempotency enforcement — that lives in the migration's
 * `create_mission_planning_diagnostic` function and its
 * `idempotency_key` UNIQUE constraint, and can only be proven against a real
 * Postgres instance, which this environment does not have. What's verified
 * here: the idempotency key and content digest are computed identically to
 * `InMemoryPlanningDiagnosticsStore` (same field composition, same hash
 * function), the RPC receives exactly the arguments it needs, and every
 * returned status/reason is mapped into the same
 * `PlanningDiagnosticRecord` / `DiagnosticIdempotencyConflictError` contract
 * the in-memory store exposes — so `MissionPlanningWorker` can depend on
 * either implementation interchangeably.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { redactForDiagnostics } from "./mission-planning-redaction";
import {
  DiagnosticIdempotencyConflictError,
  MAX_DIAGNOSTIC_RECORD_BYTES,
  DEFAULT_DIAGNOSTIC_RETENTION_DAYS,
  type DiagnosticStage,
  type PlanningDiagnosticInput,
  type PlanningDiagnosticRecord,
} from "./mission-planning-diagnostics-store";

const NO_ATTEMPT_MARKER = "no-attempt";

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Byte-for-byte the same identity computation as InMemoryPlanningDiagnosticsStore's computeIdempotencyKey. */
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

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

let refCounter = 0;
function mintFallbackRef(): string {
  refCounter += 1;
  return `diag-supa-${Date.now().toString(36)}-${refCounter}`;
}

interface DiagnosticRpcRow {
  status: "ok" | "refused";
  reason: string;
  diagnostic: {
    diagnostic_ref: string;
    workspace_id: string;
    mission_id: string;
    planning_request_id: string;
    worker_attempt_id: string | null;
    diagnostic_kind: string;
    stage: DiagnosticStage;
    model_configuration_id: string;
    provider_request_id: string | null;
    context_hash: string;
    payload: Record<string, unknown>;
    payload_digest: string;
    redaction_status: PlanningDiagnosticRecord["redactionStatus"];
    retention_class: string;
    idempotency_key: string;
    created_at: string;
  } | null;
}

function rowToRecord(row: DiagnosticRpcRow["diagnostic"]): PlanningDiagnosticRecord {
  if (!row) throw new Error("Diagnostic RPC returned ok status with no diagnostic row.");
  const payload = row.payload as {
    promptMetadataSummary: string;
    detail: string;
    usage?: { inputTokens: number; outputTokens: number };
    finishReason: string | null;
    failureClassification: string | null;
    retentionDays: number;
  };
  const record: PlanningDiagnosticRecord = {
    ref: row.diagnostic_ref,
    workspaceId: row.workspace_id,
    missionId: row.mission_id,
    planningRequestId: row.planning_request_id,
    workerAttemptId: row.worker_attempt_id,
    diagnosticKind: row.diagnostic_kind,
    modelConfigurationId: row.model_configuration_id,
    providerRequestId: row.provider_request_id,
    contextHash: row.context_hash,
    stage: row.stage,
    promptMetadataSummary: payload.promptMetadataSummary,
    detail: payload.detail,
    redactionStatus: row.redaction_status,
    usage: payload.usage,
    finishReason: payload.finishReason,
    failureClassification: payload.failureClassification,
    createdAt: row.created_at,
    retentionDays: payload.retentionDays ?? DEFAULT_DIAGNOSTIC_RETENTION_DAYS,
    sizeBytes: byteLength(JSON.stringify(row.payload)),
    digest: row.payload_digest,
    idempotencyKey: row.idempotency_key,
  };
  return record;
}

/**
 * Implements the SAME interface shape `MissionPlanningWorker` depends on
 * (`store`, `get`, `has`) so it is swappable with
 * `InMemoryPlanningDiagnosticsStore` without touching worker code.
 */
export class SupabasePlanningDiagnosticsStore {
  private readonly client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.client = client;
  }

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

    const payload = {
      promptMetadataSummary: input.promptMetadataSummary.slice(0, 500),
      detail: redacted.text,
      usage: input.usage,
      finishReason: input.finishReason ?? null,
      failureClassification: input.failureClassification ?? null,
      retentionDays: input.retentionDays ?? DEFAULT_DIAGNOSTIC_RETENTION_DAYS,
    };
    let payloadJson = JSON.stringify(payload);
    let redactionStatus = redacted.status;

    if (byteLength(payloadJson) > MAX_DIAGNOSTIC_RECORD_BYTES) {
      payload.detail = "[diagnostic detail omitted: exceeded max record size]";
      redactionStatus = "fully_removed";
      payloadJson = JSON.stringify(payload);
    }

    const payloadDigestSource = JSON.stringify({
      workspaceId: input.workspaceId,
      missionId: input.missionId,
      planningRequestId: input.planningRequestId,
      stage: input.stage,
      contextHash: input.contextHash,
      detail: payload.detail,
    });
    const payloadDigest = await sha256Hex(payloadDigestSource);

    const { data, error } = await this.client.rpc("create_mission_planning_diagnostic", {
      p_diagnostic_ref: mintFallbackRef(),
      p_workspace_id: input.workspaceId,
      p_mission_id: input.missionId,
      p_planning_request_id: input.planningRequestId,
      p_worker_attempt_id: workerAttemptId,
      p_fencing_token: null,
      p_diagnostic_kind: diagnosticKind,
      p_stage: input.stage,
      p_model_configuration_id: input.modelConfigurationId,
      p_provider_request_id: input.providerRequestId,
      p_context_hash: input.contextHash,
      p_payload: JSON.parse(payloadJson),
      p_payload_digest: payloadDigest,
      p_redaction_status: redactionStatus,
      p_retention_class: "default",
      p_idempotency_key: idempotencyKey,
    });

    if (error) throw new Error(`Failed to store Mission planning diagnostic: ${error.message}`);

    const row = Array.isArray(data) ? (data[0] as DiagnosticRpcRow | undefined) : undefined;
    if (!row) throw new Error("create_mission_planning_diagnostic RPC returned no row.");

    if (row.status === "refused") {
      if (row.reason === "idempotency_conflict") {
        const existingRef = row.diagnostic?.diagnostic_ref ?? "unknown";
        throw new DiagnosticIdempotencyConflictError(idempotencyKey, existingRef);
      }
      throw new Error(`Mission planning diagnostic refused: ${row.reason}`);
    }

    return rowToRecord(row.diagnostic);
  }

  async get(workspaceId: string, ref: string): Promise<PlanningDiagnosticRecord | null> {
    const { data, error } = await this.client.rpc("get_mission_planning_diagnostic", {
      p_workspace_id: workspaceId,
      p_diagnostic_ref: ref,
    });
    if (error) throw new Error(`Failed to load Mission planning diagnostic ${ref}: ${error.message}`);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || !row.diagnostic_ref) return null;
    return rowToRecord(row as DiagnosticRpcRow["diagnostic"]);
  }

  async has(workspaceId: string, ref: string): Promise<boolean> {
    return (await this.get(workspaceId, ref)) !== null;
  }
}

/** Guarded factory — throws if OathLock's Supabase env is not configured, matching the rest of the service layer. */
export function createSupabasePlanningDiagnosticsStore(): SupabasePlanningDiagnosticsStore {
  if (!supabase) throw new Error("M9R agent backend is not configured.");
  return new SupabasePlanningDiagnosticsStore(supabase);
}
