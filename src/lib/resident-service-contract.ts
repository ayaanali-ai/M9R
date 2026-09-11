import {
  applyLaunchEvent,
  RESIDENT_LAUNCH_PROTOCOL_VERSION,
  type LaunchEvent,
  type LaunchState,
  type ResidentProvider,
} from "@/lib/resident-launch-contract";
import { AGENT_KIND_SLUG_PATTERN } from "@/lib/agent-join";
import type { AgentModelTier } from "@/lib/agent-task-routing";

export const RESIDENT_LEASE_MS = 90_000;
const RESIDENT_OWNED_EVENTS = new Set<LaunchEvent>([
  "launch", "acknowledge_process", "return_result", "fail_launch", "fail_provider", "timeout",
]);

export function validateResidentRegistration(
  payload: unknown,
  authenticatedProvider: string,
): { ok: boolean; reason: string | null; registration: { instanceKey: string; provider: ResidentProvider; capabilities: string[] } | null } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { ok: false, reason: "invalid_payload", registration: null };
  const row = payload as Record<string, unknown>;
  const instanceKey = typeof row.instanceKey === "string" ? row.instanceKey.trim() : "";
  const provider = typeof row.provider === "string" && AGENT_KIND_SLUG_PATTERN.test(row.provider)
    ? row.provider as ResidentProvider : null;
  if (row.protocolVersion !== RESIDENT_LAUNCH_PROTOCOL_VERSION) return { ok: false, reason: "unsupported_protocol", registration: null };
  if (!provider || provider !== authenticatedProvider) return { ok: false, reason: "provider_mismatch", registration: null };
  if (instanceKey.length < 8 || instanceKey.length > 100 || !/^[a-zA-Z0-9._:-]+$/.test(instanceKey)) {
    return { ok: false, reason: "invalid_instance_key", registration: null };
  }
  if (!Array.isArray(row.capabilities) || row.capabilities.length > 25) return { ok: false, reason: "invalid_capabilities", registration: null };
  const capabilities = row.capabilities.map((value) => typeof value === "string" ? value.trim() : "");
  if (capabilities.some((value) => !value || value.length > 100)) return { ok: false, reason: "invalid_capabilities", registration: null };
  return { ok: true, reason: null, registration: { instanceKey, provider, capabilities: [...new Set(capabilities)] } };
}

export function acceptResidentHeartbeat(
  payload: unknown,
  context: { now: string; previousSequence: number },
): { ok: boolean; reason: string | null; sequence: number | null; leaseExpiresAt: string | null } {
  const nowMs = Date.parse(context.now);
  const sequence = payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>).sequence : null;
  if (!Number.isFinite(nowMs) || !Number.isSafeInteger(sequence) || (sequence as number) < 1) {
    return { ok: false, reason: "invalid_payload", sequence: null, leaseExpiresAt: null };
  }
  if ((sequence as number) <= context.previousSequence) {
    return { ok: false, reason: "sequence_not_newer", sequence: sequence as number, leaseExpiresAt: null };
  }
  return { ok: true, reason: null, sequence: sequence as number, leaseExpiresAt: new Date(nowMs + RESIDENT_LEASE_MS).toISOString() };
}

export interface LaunchEventUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
}

/** Numeric or null only — never coerces a missing/malformed field to 0. */
function readUsageField(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function readUsage(row: Record<string, unknown>): LaunchEventUsage | null {
  const raw = row.usage;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const usageRow = raw as Record<string, unknown>;
  const usage: LaunchEventUsage = {
    inputTokens: readUsageField(usageRow, "inputTokens"),
    outputTokens: readUsageField(usageRow, "outputTokens"),
    totalTokens: readUsageField(usageRow, "totalTokens"),
    costUsd: readUsageField(usageRow, "costUsd"),
  };
  const hasAny = usage.inputTokens !== null || usage.outputTokens !== null || usage.totalTokens !== null || usage.costUsd !== null;
  return hasAny ? usage : null;
}

export type LaunchFailureCode = "timeout" | "nonzero_exit" | "provider_reported_error" | "missing_structured_result" | "provider_exception" | "token_budget_exceeded";

export function validateLaunchEventSubmission(
  payload: unknown,
  currentState: LaunchState,
  previousSequence: number,
): { ok: boolean; reason: string | null; event: LaunchEvent | null; sequence: number | null; nextState: LaunchState | null; resultText: string | null; usage: LaunchEventUsage | null; modelTier: AgentModelTier | null; requestedModel: string | null; reportedModel: string | null; failureCode: LaunchFailureCode | null } {
  const fail = (reason: string, event: LaunchEvent | null = null, sequence: number | null = null) =>
    ({ ok: false, reason, event, sequence, nextState: null, resultText: null, usage: null, modelTier: null, requestedModel: null, reportedModel: null, failureCode: null });
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return fail("invalid_payload");
  const row = payload as Record<string, unknown>;
  const event = typeof row.event === "string" ? row.event as LaunchEvent : null;
  const sequence = row.sequence;
  const resultText = typeof row.resultText === "string" ? row.resultText.trim() : null;
  const usage = event === "return_result" ? readUsage(row) : null;
  const modelTier = row.modelTier === "economy" || row.modelTier === "balanced" || row.modelTier === "frontier"
    ? row.modelTier as AgentModelTier : null;
  const boundedModel = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9._:/-]{1,200}$/.test(value) ? value : null;
  const requestedModel = boundedModel(row.requestedModel);
  const reportedModel = boundedModel(row.reportedModel);
  const failureCode = ["timeout", "nonzero_exit", "provider_reported_error", "missing_structured_result", "provider_exception", "token_budget_exceeded"].includes(String(row.failureCode))
    ? String(row.failureCode) as LaunchFailureCode
    : null;
  if (!event || !Number.isSafeInteger(sequence) || (sequence as number) < 1) return fail("invalid_payload");
  if (event === "return_result" && (!resultText || resultText.length > 100_000)) return fail("invalid_result", event, sequence as number);
  if (event !== "return_result" && resultText) return fail("unexpected_result", event, sequence as number);
  const suppliedModelMetadata = row.modelTier !== undefined || row.requestedModel !== undefined || row.reportedModel !== undefined;
  if (suppliedModelMetadata && (event !== "return_result" || !modelTier || !requestedModel
    || (row.reportedModel !== undefined && !reportedModel))) {
    return fail("invalid_model_metadata", event, sequence as number);
  }
  if (!RESIDENT_OWNED_EVENTS.has(event)) return fail("event_not_resident_owned", event, sequence as number);
  if (row.failureCode !== undefined && (!failureCode || !["fail_launch", "fail_provider", "timeout"].includes(event))) return fail("invalid_failure_code", event, sequence as number);
  if ((sequence as number) <= previousSequence) return fail("sequence_not_newer", event, sequence as number);
  const transition = applyLaunchEvent(currentState, event);
  if (!transition.ok) return fail("invalid_transition", event, sequence as number);
  return { ok: true, reason: null, event, sequence: sequence as number, nextState: transition.state, resultText, usage, modelTier, requestedModel, reportedModel, failureCode };
}
