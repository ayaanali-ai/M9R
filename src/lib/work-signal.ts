export const WORK_SIGNAL_VERSION = "oathlock.work-signal.v1" as const;
const TYPES = new Set(["RUN_STARTED", "SCOPE_ANNOUNCED", "WORKING", "PHASE_CHANGED", "BLOCKED", "HUMAN_DECISION_REQUIRED", "EVIDENCE_READY", "RUN_COMPLETED", "HELP_REQUESTED", "CHECK_REQUESTED", "CHECK_RESULT_RETURNED"]);
const SOURCES = new Set(["observed", "reported", "derived"]);

function boundedString(v: unknown, min: number, max: number): string | null {
  return typeof v === "string" && v.length >= min && v.length <= max ? v : null;
}

export interface AcceptedWorkSignal { protocolVersion: typeof WORK_SIGNAL_VERSION; adapterInstanceId: string; clientSequence: number; idempotencyKey: string; type: string; source: "observed" | "reported" | "derived"; summary: string; scope: string[]; repo: string; correlationId: string | null; parentEventId: string | null; receivedAt: string }
export type WorkSignalResult = { ok: true; signal: AcceptedWorkSignal } | { ok: false; reason: "invalid_payload" | "unsupported_protocol" | "sequence_not_newer" | "invalid_server_time" };

export function acceptWorkSignal(payload: unknown, context: { previousSequence: number | null; receivedAt: string }): WorkSignalResult {
  const time = Date.parse(context.receivedAt);
  if (!Number.isFinite(time)) return { ok: false, reason: "invalid_server_time" };
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { ok: false, reason: "invalid_payload" };
  const p = payload as Record<string, unknown>;
  if (p.protocolVersion !== WORK_SIGNAL_VERSION) return { ok: false, reason: "unsupported_protocol" };
  if (typeof p.clientSequence !== "number" || !Number.isSafeInteger(p.clientSequence) || p.clientSequence < 1 || (context.previousSequence !== null && p.clientSequence <= context.previousSequence)) return { ok: false, reason: "sequence_not_newer" };
  if (typeof p.adapterInstanceId !== "string" || p.adapterInstanceId.length < 8 || p.adapterInstanceId.length > 128 || typeof p.idempotencyKey !== "string" || p.idempotencyKey.length < 16 || p.idempotencyKey.length > 128 || typeof p.type !== "string" || !TYPES.has(p.type) || typeof p.source !== "string" || !SOURCES.has(p.source) || typeof p.summary !== "string" || !p.summary.trim() || p.summary.length > 200) return { ok: false, reason: "invalid_payload" };
  const repo = boundedString(p.repo, 1, 300);
  if (!repo) return { ok: false, reason: "invalid_payload" };
  if (p.correlationId !== undefined && p.correlationId !== null && !boundedString(p.correlationId, 1, 128)) return { ok: false, reason: "invalid_payload" };
  if (p.parentEventId !== undefined && p.parentEventId !== null && !boundedString(p.parentEventId, 1, 128)) return { ok: false, reason: "invalid_payload" };
  const scope = Array.isArray(p.scope) && p.scope.length <= 50 && p.scope.every((v) => typeof v === "string" && v.length <= 300) ? p.scope as string[] : [];
  if (p.scope !== undefined && (!Array.isArray(p.scope) || scope.length !== p.scope.length)) return { ok: false, reason: "invalid_payload" };
  return { ok: true, signal: { protocolVersion: WORK_SIGNAL_VERSION, adapterInstanceId: p.adapterInstanceId, clientSequence: p.clientSequence, idempotencyKey: p.idempotencyKey, type: p.type, source: p.source as AcceptedWorkSignal["source"], summary: p.summary.replace(/\s+/g, " ").trim(), scope, repo, correlationId: boundedString(p.correlationId, 1, 128), parentEventId: boundedString(p.parentEventId, 1, 128), receivedAt: new Date(time).toISOString() } };
}
