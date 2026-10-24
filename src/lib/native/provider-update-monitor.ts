import { createLocalStore } from "./local-store";
import {
  detectProviderRuntimeObservations,
  type ProviderRuntimeObservation,
} from "./provider-update-compatibility-core";
import {
  reconcileProviderUpdate,
  type ProviderUpdateActions,
  type ProviderUpdateStatus,
} from "./provider-update-lifecycle-core";
import type { VersionProbe } from "../agent-detection-core";

/** Five minutes is frequent enough to notice a provider upgrade without turning
 * version probes into a background process storm. The first check still runs
 * immediately when the terminal runtime starts. */
export const DEFAULT_PROVIDER_UPDATE_INTERVAL_MS = 5 * 60_000;
const MIN_PROVIDER_UPDATE_INTERVAL_MS = 5_000;
const MAX_PROVIDER_UPDATE_INTERVAL_MS = 24 * 60 * 60_000;

/**
 * The provider update/reconciliation loop belongs to the long-lived native
 * feed process that owns local delivery, not to the optional terminal runtime.
 */
export function shouldRunProviderUpdateMonitorForCommand(
  command: string,
  args: readonly string[],
  ownsFeedLock: boolean,
): boolean {
  return ownsFeedLock && command === "feed" && args.includes("--watch");
}

export interface ProviderUpdateCycleEntry {
  providerId: string;
  status: ProviderUpdateStatus;
  comparison: string;
  plan: string;
  error?: string;
}

export interface ProviderUpdateCycleResult {
  startedAtMs: number;
  finishedAtMs: number;
  observed: readonly ProviderRuntimeObservation[];
  entries: readonly ProviderUpdateCycleEntry[];
}

export interface ProviderUpdateMonitorOptions {
  /** The same local M9R root used by tasks, claims, and bindings. */
  root: string;
  /** Side-effect-free provider `--version` probe. */
  probe: VersionProbe;
  /** Optional adapter actions. Without them, changed providers remain waiting
   * and durable state is retained rather than pretending a reconnect happened. */
  actions?: ProviderUpdateActions;
  /** Reconcile M9R-owned provider config on resident startup, even when vendor versions are unchanged. */
  reconcileOnStart?: boolean;
  /** Internal first-cycle signal used by the startup reconciliation pass. */
  reconcileUnchanged?: boolean;
  /** Retry startup reconciliation only for providers whose prior pass did not become healthy. */
  reconcileUnchangedProviderIds?: ReadonlySet<string>;
  intervalMs?: number;
  nowMs?: () => number;
  onCycle?: (result: ProviderUpdateCycleResult) => void | Promise<void>;
  onError?: (error: unknown) => void;
}

function boundedInterval(value: number | undefined): number {
  const candidate = value ?? DEFAULT_PROVIDER_UPDATE_INTERVAL_MS;
  if (!Number.isFinite(candidate)) return DEFAULT_PROVIDER_UPDATE_INTERVAL_MS;
  return Math.min(MAX_PROVIDER_UPDATE_INTERVAL_MS, Math.max(MIN_PROVIDER_UPDATE_INTERVAL_MS, Math.floor(candidate)));
}

/**
 * Run one provider compatibility reconciliation.
 *
 * Detection is performed before any state is changed. If the detector itself
 * fails, the cycle throws and the previously persisted provider state is left
 * untouched; a transient probe failure must never be interpreted as proof that
 * every installed provider disappeared. Each successful per-provider result is
 * persisted atomically through the existing local store, which keeps tasks,
 * claims, bindings, and provider compatibility state under one lock.
 */
export async function runProviderUpdateCycle(options: ProviderUpdateMonitorOptions): Promise<ProviderUpdateCycleResult> {
  const now = options.nowMs ?? Date.now;
  const startedAtMs = now();
  if (!Number.isSafeInteger(startedAtMs) || startedAtMs < 0) throw new Error("provider update monitor time is invalid");

  const observations = await detectProviderRuntimeObservations(options.probe, startedAtMs);
  const store = createLocalStore(options.root);
  let state = store.providerUpdateState();
  const entries: ProviderUpdateCycleEntry[] = [];
  const seen = new Set<string>();

  for (const current of observations) {
    seen.add(current.providerId);
    const result = await reconcileProviderUpdate({
      state,
      providerId: current.providerId,
      current,
      nowMs: startedAtMs,
      reconcileUnchanged: options.reconcileUnchanged || options.reconcileUnchangedProviderIds?.has(current.providerId),
      actions: options.actions,
      persist: (next) => store.saveProviderUpdateState(next),
    });
    state = result.state;
    entries.push({
      providerId: current.providerId,
      status: result.status,
      comparison: result.comparison.kind,
      plan: result.plan.action,
      ...(result.error ? { error: result.error } : {}),
    });
  }

  // A previously observed provider may be temporarily closed, updating, or
  // unavailable. Mark it waiting while preserving its last-known-good record;
  // never delete it and never clear durable work because a probe missed once.
  for (const providerId of Object.keys(state.providers)) {
    if (seen.has(providerId)) continue;
    const result = await reconcileProviderUpdate({
      state,
      providerId,
      current: null,
      nowMs: startedAtMs,
      actions: options.actions,
      persist: (next) => store.saveProviderUpdateState(next),
    });
    state = result.state;
    entries.push({
      providerId,
      status: result.status,
      comparison: result.comparison.kind,
      plan: result.plan.action,
      ...(result.error ? { error: result.error } : {}),
    });
  }

  const finishedAtMs = now();
  const result = { startedAtMs, finishedAtMs, observed: observations, entries } satisfies ProviderUpdateCycleResult;
  await options.onCycle?.(result);
  return result;
}

export interface ProviderUpdateMonitor {
  runOnce(): Promise<ProviderUpdateCycleResult>;
  stop(): Promise<void>;
}

/**
 * Start the resident provider-update monitor. The returned monitor is
 * deliberately small and disposable so terminal-runtime shutdown can stop it
 * without touching provider processes or task state.
 */
export function startProviderUpdateMonitor(options: ProviderUpdateMonitorOptions): ProviderUpdateMonitor {
  const intervalMs = boundedInterval(options.intervalMs);
  let stopped = false;
  let startupReconciliationPending = options.reconcileOnStart === true && Boolean(options.actions?.reconnect);
  let startupReconciliationProviderIds: Set<string> | null = null;
  let inFlight: Promise<ProviderUpdateCycleResult> | null = null;

  const runOnce = (): Promise<ProviderUpdateCycleResult> => {
    if (inFlight) return inFlight;
    const reconcileUnchanged = startupReconciliationPending && startupReconciliationProviderIds === null;
    inFlight = runProviderUpdateCycle({
      ...options,
      reconcileUnchanged,
      reconcileUnchangedProviderIds: startupReconciliationProviderIds ?? undefined,
    })
      .then((result) => {
        // Healthy providers are refreshed once. Preserve only providers whose
        // first startup reconciliation was unavailable or failed, so their
        // return can converge without repeatedly rewriting healthy providers.
        if (startupReconciliationPending) {
          startupReconciliationProviderIds = new Set(
            result.entries.filter((entry) => entry.status !== "healthy").map((entry) => entry.providerId),
          );
          startupReconciliationPending = startupReconciliationProviderIds.size > 0;
          if (!startupReconciliationPending) startupReconciliationProviderIds = null;
        }
        return result;
      })
      .catch((error) => {
        options.onError?.(error);
        throw error;
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  };

  const timer = setInterval(() => {
    if (stopped || inFlight) return;
    void runOnce().catch(() => { /* onError receives the bounded diagnostic */ });
  }, intervalMs);
  timer.unref?.();
  void runOnce().catch(() => { /* startup diagnostics are reported through onError */ });

  return {
    runOnce,
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      await inFlight?.catch(() => { /* startup/probe errors are already reported */ });
    },
  };
}
