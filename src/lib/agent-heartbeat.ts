/** Deterministic validation for authenticated adapter heartbeats. */

export const HEARTBEAT_PROTOCOL_VERSION = "m9r.presence.v1";
export const HEARTBEAT_LEASE_MS = 90_000;

export type ExecutionOrigin = "linked" | "resident";

export interface HeartbeatObservation {
  protocolVersion: typeof HEARTBEAT_PROTOCOL_VERSION;
  adapterInstanceId: string;
  sequence: number;
  executionOrigin: ExecutionOrigin;
  provider: string;
  idempotencyKey: string;
  receivedAt: string;
  leaseExpiresAt: string;
}

export type HeartbeatResult =
  | { ok: true; observation: HeartbeatObservation }
  | {
      ok: false;
      reason:
        | "invalid_payload"
        | "unsupported_protocol"
        | "invalid_server_time"
        | "sequence_not_newer";
    };

interface AcceptanceContext {
  /** Must be assigned by the trusted server, never copied from the adapter. */
  receivedAt: string;
  /** Last accepted sequence for this exact adapter instance. */
  previousSequence: number | null;
}

function boundedString(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

export function acceptHeartbeat(payload: unknown, context: AcceptanceContext): HeartbeatResult {
  const receivedMs = Date.parse(context.receivedAt);
  if (!Number.isFinite(receivedMs)) return { ok: false, reason: "invalid_server_time" };
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reason: "invalid_payload" };
  }

  const row = payload as Record<string, unknown>;
  if (row.protocolVersion !== HEARTBEAT_PROTOCOL_VERSION) {
    return { ok: false, reason: "unsupported_protocol" };
  }

  const sequence = row.sequence;
  const executionOrigin = row.executionOrigin;
  if (
    !boundedString(row.adapterInstanceId, 8, 128)
    || !Number.isSafeInteger(sequence)
    || (sequence as number) < 1
    || (executionOrigin !== "linked" && executionOrigin !== "resident")
    || !boundedString(row.provider, 2, 64)
    || !boundedString(row.idempotencyKey, 16, 128)
  ) {
    return { ok: false, reason: "invalid_payload" };
  }

  if (context.previousSequence !== null && sequence as number <= context.previousSequence) {
    return { ok: false, reason: "sequence_not_newer" };
  }

  return {
    ok: true,
    observation: {
      protocolVersion: HEARTBEAT_PROTOCOL_VERSION,
      adapterInstanceId: row.adapterInstanceId,
      sequence: sequence as number,
      executionOrigin,
      provider: row.provider,
      idempotencyKey: row.idempotencyKey,
      receivedAt: new Date(receivedMs).toISOString(),
      leaseExpiresAt: new Date(receivedMs + HEARTBEAT_LEASE_MS).toISOString(),
    },
  };
}
