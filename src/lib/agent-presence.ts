/**
 * Server-state presentation for resident and linked agents.
 *
 * This module is intentionally deterministic and IO-free. It does not infer
 * provider activity from a connected account, a running timer, or UI state.
 * Callers must supply timestamps from authenticated, persisted observations.
 */

export const PRESENCE_FRESH_MS = 90_000;
export const PRESENCE_STALE_MS = 5 * 60_000;

export type AgentPresenceState =
  | "disconnected"
  | "asleep"
  | "awake"
  | "working"
  | "waiting"
  | "evidence"
  | "stale"
  | "error";

export interface AgentPresence {
  state: AgentPresenceState;
  label: string;
  truth: "observed" | "unknown";
  lastConfirmedAt: string | null;
}

export interface AgentPresenceInput {
  connectionStatus: "active" | "revoked" | "unavailable";
  connectionObservedAt?: string | null;
  run?: {
    status: string;
    observedAt: string | null;
  } | null;
  nowMs?: number;
}

const LABELS: Record<AgentPresenceState, string> = {
  disconnected: "Disconnected",
  asleep: "Asleep",
  awake: "Awake",
  working: "Working",
  waiting: "Waiting",
  evidence: "Preparing evidence",
  stale: "Status stale",
  error: "Failed",
};

const WAITING_STATUSES = new Set(["blocked", "waiting", "waiting_for_human"]);
const EVIDENCE_STATUSES = new Set(["evidence_ready", "completed"]);
const WORKING_STATUSES = new Set(["started", "working"]);
const ERROR_STATUSES = new Set(["failed", "error", "cancelled"]);
const EXPIRED_STATUSES = new Set(["expired"]);

function observedMs(value: string | null | undefined, nowMs: number): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed > nowMs) return null;
  return parsed;
}

function result(
  state: AgentPresenceState,
  observedAt: string | null,
  truth: AgentPresence["truth"] = observedAt ? "observed" : "unknown",
): AgentPresence {
  return { state, label: LABELS[state], truth, lastConfirmedAt: observedAt };
}

export function deriveAgentPresence(input: AgentPresenceInput): AgentPresence {
  const nowMs = input.nowMs ?? Date.now();
  if (input.connectionStatus !== "active") return result("disconnected", null);

  const runStatus = input.run?.status.trim().toLowerCase() ?? "";
  const runMs = observedMs(input.run?.observedAt, nowMs);
  const runObservedAt = runMs === null ? null : input.run?.observedAt ?? null;

  if (ERROR_STATUSES.has(runStatus) && runMs !== null) {
    return result("error", runObservedAt);
  }

  if (EXPIRED_STATUSES.has(runStatus) && runMs !== null) {
    return result("stale", runObservedAt);
  }

  if (runStatus && runMs !== null) {
    const age = nowMs - runMs;
    if (age > PRESENCE_FRESH_MS) return result("stale", runObservedAt);
    if (WAITING_STATUSES.has(runStatus)) return result("waiting", runObservedAt);
    if (EVIDENCE_STATUSES.has(runStatus)) return result("evidence", runObservedAt);
    if (WORKING_STATUSES.has(runStatus)) return result("working", runObservedAt);
  }

  const connectionMs = observedMs(input.connectionObservedAt, nowMs);
  if (connectionMs === null) return result("asleep", null);
  const connectionObservedAt = input.connectionObservedAt ?? null;
  const age = nowMs - connectionMs;
  if (age <= PRESENCE_FRESH_MS) return result("awake", connectionObservedAt);
  if (age <= PRESENCE_STALE_MS) return result("stale", connectionObservedAt);
  return result("asleep", connectionObservedAt);
}
