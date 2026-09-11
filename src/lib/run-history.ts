/**
 * Run History — OathLock Phase 1 (client-side)
 *
 * A lightweight localStorage record of analyzed runs, so the Improvement view
 * can show honest trends over time without any backend. Each report generated
 * on the upload page appends one RunRecord.
 *
 * Honesty: cost/token fields stay null when the trace didn't carry the data.
 * The Improvement view must render those as "not measurable", never as 0.
 */

import type { TraceMetrics } from "@/lib/trace-metrics";

const STORAGE_KEY = "oathlock-run-history";
const MAX_RECORDS = 100;

export interface RunRecord {
  id: string;
  sessionId: string;
  taskSummary: string;
  createdAt: string; // ISO

  // Measured run characteristics (from trace-metrics).
  stepCount: number;
  failedSteps: number;
  retries: number;
  retryRate: number;
  hasTokenUsage: boolean;
  hasCostData: boolean;
  totalTokens: number | null;
  costUsd: number | null;

  // Report-derived.
  findings: number;
  highSeverity: number;

  // Rule evaluation outcome for this run.
  rulesApplied: number;
  /** High-severity findings addressed by a matched rule (before - after). */
  highSeverityAddressed: number;
}

function isBrowser(): boolean {
  return typeof window !== "undefined" && !!window.localStorage;
}

/** Read all run records, oldest → newest. Never throws. */
export function getRuns(): RunRecord[] {
  if (!isBrowser()) return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RunRecord[]) : [];
  } catch {
    return [];
  }
}

/** Append a run record (capped at MAX_RECORDS). Returns the saved record. */
export function recordRun(
  input: Omit<RunRecord, "id" | "createdAt"> & { createdAt?: string },
): RunRecord {
  const record: RunRecord = {
    ...input,
    id: `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  if (!isBrowser()) return record;
  try {
    const all = [...getRuns(), record].slice(-MAX_RECORDS);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Storage full / disabled — non-fatal; history is best-effort.
  }
  return record;
}

export function clearRuns(): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* no-op */
  }
}

/** Helper to build a RunRecord payload from metrics + report counts. */
export function buildRunRecord(args: {
  metrics: TraceMetrics;
  sessionId: string;
  taskSummary: string;
  findings: number;
  highSeverity: number;
  rulesApplied: number;
  highSeverityAddressed: number;
}): Omit<RunRecord, "id" | "createdAt"> {
  const { metrics, ...rest } = args;
  return {
    ...rest,
    stepCount: metrics.stepCount,
    failedSteps: metrics.failedSteps,
    retries: metrics.retries,
    retryRate: metrics.retryRate,
    hasTokenUsage: metrics.hasTokenUsage,
    hasCostData: metrics.hasCostData,
    totalTokens: metrics.totalTokens,
    costUsd: metrics.costUsd,
  };
}
