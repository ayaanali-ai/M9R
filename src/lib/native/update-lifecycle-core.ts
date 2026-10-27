import { compareSemanticVersions } from "./engine-update-core";

export type UpdatePhase =
  | "idle"
  | "checking"
  | "up_to_date"
  | "available"
  | "downloading"
  | "ready_to_apply"
  | "applying"
  | "succeeded"
  | "failed"
  | "rolling_back"
  | "rolled_back";

export interface UpdateState {
  phase: UpdatePhase;
  currentVersion: string;
  availableVersion?: string;
  percent?: number;
  checkedAt?: number;
  updatedAt?: number;
  error?: string;
  requiresRestart: boolean;
}

export type UpdateEvent =
  | { type: "check_started"; at: number }
  | { type: "up_to_date"; at: number }
  | { type: "update_available"; at: number; version: string }
  | { type: "check_failed"; at: number; error: string }
  | { type: "download_started"; at: number }
  | { type: "download_progress"; at: number; percent: number }
  | { type: "download_ready"; at: number }
  | { type: "apply_started"; at: number }
  | { type: "apply_succeeded"; at: number; version: string }
  | { type: "apply_failed"; at: number; error: string }
  | { type: "rollback_started"; at: number }
  | { type: "rollback_succeeded"; at: number }
  | { type: "rollback_failed"; at: number; error: string };

const transitions: Record<UpdatePhase, readonly UpdateEvent["type"][]> = {
  idle: ["check_started"],
  checking: ["up_to_date", "update_available", "check_failed"],
  up_to_date: ["check_started"],
  available: ["check_started", "download_started"],
  downloading: ["download_progress", "download_ready", "check_failed"],
  ready_to_apply: ["apply_started", "check_started"],
  applying: ["apply_succeeded", "apply_failed"],
  succeeded: ["check_started"],
  failed: ["check_started", "rollback_started"],
  rolling_back: ["rollback_succeeded", "rollback_failed"],
  rolled_back: ["check_started"],
};

export function createInitialUpdateState(currentVersion: string): UpdateState {
  return { phase: "idle", currentVersion, requiresRestart: false };
}

function assertTransition(state: UpdateState, event: UpdateEvent): void {
  if (!transitions[state.phase].includes(event.type)) {
    throw new Error(`cannot ${event.type} from ${state.phase}`);
  }
}

function checkedPercent(percent: number): number {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new Error("update progress must be between 0 and 100");
  return Math.round(percent);
}

/**
 * Small, serializable update contract shared by the future pill UI and the
 * updater implementation. It refuses impossible transitions so the UI can
 * never display a successful update before the runtime was actually applied.
 */
export function reduceUpdateState(state: UpdateState, event: UpdateEvent): UpdateState {
  assertTransition(state, event);
  const base = { ...state, updatedAt: event.at, error: undefined };
  switch (event.type) {
    case "check_started":
      return { ...base, phase: "checking", checkedAt: event.at, percent: undefined };
    case "up_to_date":
      return { ...base, phase: "up_to_date", checkedAt: event.at, percent: undefined, requiresRestart: false };
    case "update_available":
      if (compareSemanticVersions(state.currentVersion, event.version) >= 0) throw new Error("available update must be newer than the current version");
      return { ...base, phase: "available", availableVersion: event.version, checkedAt: event.at, percent: undefined, requiresRestart: false };
    case "check_failed":
      return { ...base, phase: "failed", checkedAt: event.at, error: event.error, percent: undefined, requiresRestart: false };
    case "download_started":
      return { ...base, phase: "downloading", percent: 0, requiresRestart: false };
    case "download_progress":
      return { ...base, phase: "downloading", percent: checkedPercent(event.percent), requiresRestart: false };
    case "download_ready":
      return { ...base, phase: "ready_to_apply", percent: 100, requiresRestart: true };
    case "apply_started":
      return { ...base, phase: "applying", percent: 100, requiresRestart: true };
    case "apply_succeeded":
      if (state.availableVersion !== event.version) throw new Error("applied version does not match the offered update");
      return { ...base, phase: "succeeded", currentVersion: event.version, availableVersion: undefined, percent: 100, requiresRestart: false };
    case "apply_failed":
      return { ...base, phase: "failed", error: event.error, requiresRestart: true };
    case "rollback_started":
      return { ...base, phase: "rolling_back", requiresRestart: true };
    case "rollback_succeeded":
      return { ...base, phase: "rolled_back", percent: undefined, requiresRestart: false };
    case "rollback_failed":
      return { ...base, phase: "failed", error: event.error, requiresRestart: true };
  }
}

export function shouldCheckAutomatically(options: {
  nowMs: number;
  lastCheckedAtMs?: number;
  intervalMs: number;
  force?: boolean;
}): boolean {
  if (options.force === true) return true;
  if (!Number.isFinite(options.nowMs) || !Number.isFinite(options.intervalMs) || options.intervalMs <= 0) return false;
  if (options.lastCheckedAtMs === undefined) return true;
  return options.nowMs - options.lastCheckedAtMs >= options.intervalMs;
}
