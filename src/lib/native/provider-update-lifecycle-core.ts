import {
  classifyProviderRuntime,
  normalizeProviderRuntimeObservation,
  planProviderReconciliation,
  type ProviderReconciliationPlan,
  type ProviderRuntimeComparison,
  type ProviderRuntimeObservation,
} from "./provider-update-compatibility-core";
import { redactSecrets } from "./inbox-core";

export const PROVIDER_UPDATE_STATE_VERSION = 1 as const;
const PROVIDER_RECORD_LIMIT = 128;
const ERROR_LIMIT = 512;

export type ProviderUpdateStatus = "healthy" | "reconciling" | "waiting";

export interface ProviderUpdateRecord {
  providerId: string;
  /** "healthy" means the compatibility observation and M9R-owned route were accepted;
   * live provider-task acceptance remains a separate end-to-end gate. */
  status: ProviderUpdateStatus;
  lastGoodObservation: ProviderRuntimeObservation | null;
  pendingObservation: ProviderRuntimeObservation | null;
  lastComparison: ProviderRuntimeComparison | null;
  plan: ProviderReconciliationPlan | null;
  failureCount: number;
  lastActionAtMs: number | null;
  lastError: string | null;
  /** True only when a healthy replacement exists but old-process retirement could not complete. */
  retirementPending: boolean;
}
export interface ProviderUpdateState {
  schemaVersion: typeof PROVIDER_UPDATE_STATE_VERSION;
  providers: Record<string, ProviderUpdateRecord>;
}

export interface ProviderUpdateActions {
  /** Refresh M9R-owned compatibility state; never rewrite provider credentials. */
  refreshAdapter?: (input: {
    providerId: string;
    previous: ProviderRuntimeObservation | null;
    current: ProviderRuntimeObservation;
    comparison: ProviderRuntimeComparison;
    plan: ProviderReconciliationPlan;
  }) => Promise<void> | void;
  /** Prove the replacement route is healthy before any old worker is retired. */
  reconnect?: (input: {
    providerId: string;
    previous: ProviderRuntimeObservation | null;
    current: ProviderRuntimeObservation;
  }) => Promise<{ healthy: boolean; detail?: string }> | { healthy: boolean; detail?: string };
  /** Retire only an old M9R-owned worker after the replacement is healthy. */
  retirePrevious?: (input: {
    providerId: string;
    previous: ProviderRuntimeObservation;
    current: ProviderRuntimeObservation;
  }) => Promise<void> | void;
}

export interface ReconcileProviderUpdateInput {
  state: ProviderUpdateState;
  providerId: string;
  current: ProviderRuntimeObservation | null;
  nowMs: number;
  actions?: ProviderUpdateActions;
  persist?: (state: ProviderUpdateState) => Promise<void> | void;
}

export interface ReconcileProviderUpdateResult {
  state: ProviderUpdateState;
  status: ProviderUpdateStatus;
  plan: ProviderReconciliationPlan;
  comparison: ProviderRuntimeComparison;
  error?: string;
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(message.replace(/[\u0000-\u001f\u007f]/g, " ").trim()).slice(0, ERROR_LIMIT) || "provider update reconciliation failed";
}

function providerIdOf(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) {
    throw new Error("provider update state contains an invalid provider id");
  }
  return value;
}

function cloneObservation(observation: ProviderRuntimeObservation | null): ProviderRuntimeObservation | null {
  return observation ? { ...observation } : null;
}

function clonePlan(plan: ProviderReconciliationPlan | null): ProviderReconciliationPlan | null {
  return plan ? { ...plan } : null;
}

function cloneComparison(comparison: ProviderRuntimeComparison | null): ProviderRuntimeComparison | null {
  return comparison
    ? { ...comparison, reasons: [...comparison.reasons] }
    : null;
}

function emptyRecord(providerId: string): ProviderUpdateRecord {
  return {
    providerId,
    status: "waiting",
    lastGoodObservation: null,
    pendingObservation: null,
    lastComparison: null,
    plan: null,
    failureCount: 0,
    lastActionAtMs: null,
    lastError: null,
    retirementPending: false,
  };
}

function normalizeRecord(providerId: string, value: unknown): ProviderUpdateRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("provider update record is invalid");
  const record = value as Record<string, unknown>;
  if (record.providerId !== providerId) throw new Error("provider update record provider id does not match its key");
  if (record.status !== "healthy" && record.status !== "reconciling" && record.status !== "waiting") throw new Error("provider update record status is invalid");
  if (!Number.isSafeInteger(record.failureCount) || Number(record.failureCount) < 0 || Number(record.failureCount) > 1000) throw new Error("provider update failure count is invalid");
  if (record.lastActionAtMs !== null && (!Number.isSafeInteger(record.lastActionAtMs) || Number(record.lastActionAtMs) < 0)) throw new Error("provider update timestamp is invalid");
  if (record.lastError !== null && (typeof record.lastError !== "string" || record.lastError.length > ERROR_LIMIT)) throw new Error("provider update error is invalid");
  if (typeof record.retirementPending !== "boolean") throw new Error("provider update retirement state is invalid");

  const normalizeStoredObservation = (candidate: unknown, field: string): ProviderRuntimeObservation | null => {
    if (candidate === null) return null;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error(`${field} is invalid`);
    const input = candidate as Record<string, unknown>;
    const normalized = normalizeProviderRuntimeObservation({
      providerId: String(input.providerId ?? ""),
      binary: String(input.binary ?? ""),
      versionLine: String(input.versionLine ?? ""),
      executablePath: typeof input.executablePath === "string" ? input.executablePath : null,
      transport: typeof input.transport === "string" ? input.transport : undefined,
      adapterContractVersion: typeof input.adapterContractVersion === "string" ? input.adapterContractVersion : null,
      capabilityManifestVersion: typeof input.capabilityManifestVersion === "string" ? input.capabilityManifestVersion : null,
      configFingerprint: typeof input.configFingerprint === "string" ? input.configFingerprint : null,
      observedAtMs: Number(input.observedAtMs),
    });
    if (input.schema !== normalized.schema || input.fingerprint !== normalized.fingerprint) throw new Error(`${field} fingerprint is invalid`);
    return normalized;
  };

  const comparison = record.lastComparison === null ? null : record.lastComparison;
  if (comparison !== null && (typeof comparison !== "object" || Array.isArray(comparison))) throw new Error("provider update comparison is invalid");
  const plan = record.plan === null ? null : record.plan;
  if (plan !== null && (typeof plan !== "object" || Array.isArray(plan))) throw new Error("provider update plan is invalid");
  return {
    providerId,
    status: record.status,
    lastGoodObservation: normalizeStoredObservation(record.lastGoodObservation, "lastGoodObservation"),
    pendingObservation: normalizeStoredObservation(record.pendingObservation, "pendingObservation"),
    lastComparison: cloneComparison(comparison as ProviderRuntimeComparison | null),
    plan: clonePlan(plan as ProviderReconciliationPlan | null),
    failureCount: Number(record.failureCount),
    lastActionAtMs: record.lastActionAtMs === null ? null : Number(record.lastActionAtMs),
    lastError: record.lastError === null ? null : String(record.lastError),
    retirementPending: record.retirementPending,
  };
}

export function createInitialProviderUpdateState(): ProviderUpdateState {
  return { schemaVersion: PROVIDER_UPDATE_STATE_VERSION, providers: {} };
}

/** Validate persisted state before it can influence a provider reconnect. */
export function normalizeProviderUpdateState(value: unknown): ProviderUpdateState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("provider update state is invalid");
  const data = value as Record<string, unknown>;
  if (data.schemaVersion !== PROVIDER_UPDATE_STATE_VERSION || !data.providers || typeof data.providers !== "object" || Array.isArray(data.providers)) {
    throw new Error("provider update state schema is invalid");
  }
  const entries = Object.entries(data.providers as Record<string, unknown>);
  if (entries.length > PROVIDER_RECORD_LIMIT) throw new Error("provider update state has too many providers");
  const providers: Record<string, ProviderUpdateRecord> = {};
  for (const [key, record] of entries) {
    const providerId = providerIdOf(key);
    providers[providerId] = normalizeRecord(providerId, record);
  }
  return { schemaVersion: PROVIDER_UPDATE_STATE_VERSION, providers };
}

function cloneState(state: ProviderUpdateState): ProviderUpdateState {
  const normalized = normalizeProviderUpdateState(state);
  return {
    schemaVersion: normalized.schemaVersion,
    providers: Object.fromEntries(Object.entries(normalized.providers).map(([providerId, record]) => [providerId, {
      ...record,
      lastGoodObservation: cloneObservation(record.lastGoodObservation),
      pendingObservation: cloneObservation(record.pendingObservation),
      lastComparison: cloneComparison(record.lastComparison),
      plan: clonePlan(record.plan),
    }])),
  };
}

async function persist(input: ReconcileProviderUpdateInput, state: ProviderUpdateState): Promise<void> {
  if (input.persist) await input.persist(state);
}

/**
 * Reconcile one provider observation without touching credentials, provider
 * configuration, tasks, or the existing CLI/MCP route. The pending candidate
 * is written before any refresh/reconnect side effect; a crash therefore
 * leaves enough information for the next boot to retry safely.
 */
export async function reconcileProviderUpdate(input: ReconcileProviderUpdateInput): Promise<ReconcileProviderUpdateResult> {
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0) throw new Error("provider update time is invalid");
  const providerId = providerIdOf(input.providerId);
  const state = cloneState(input.state);
  const record = state.providers[providerId] ?? emptyRecord(providerId);
  const current = input.current ? normalizeProviderRuntimeObservation(input.current) : null;
  const comparison = classifyProviderRuntime(record.lastGoodObservation ?? undefined, current);
  const plan = planProviderReconciliation(comparison);
  record.lastComparison = comparison;
  record.plan = plan;
  record.lastActionAtMs = input.nowMs;

  if (comparison.kind === "unavailable") {
    record.status = "waiting";
    record.lastError = "Provider is temporarily unavailable; durable work was retained.";
    record.retirementPending = false;
    state.providers[providerId] = record;
    await persist(input, state);
    return { state, status: "waiting", plan, comparison, error: record.lastError };
  }

  // A first observation is only immediately healthy when the caller has no
  // activation boundary. The resident runtime supplies refresh/reconnect
  // actions, so it must initialize the provider route before declaring it
  // healthy; otherwise a newly observed provider could remain on stale
  // configuration while durable state claimed success.
  if (comparison.kind === "unchanged" || (comparison.kind === "first_seen" && (!input.actions?.refreshAdapter || !input.actions.reconnect))) {
    record.status = "healthy";
    record.lastGoodObservation = cloneObservation(current);
    record.pendingObservation = null;
    record.failureCount = 0;
    record.lastError = null;
    record.retirementPending = false;
    state.providers[providerId] = record;
    await persist(input, state);
    return { state, status: "healthy", plan, comparison };
  }

  const previous = record.lastGoodObservation;
  if (!current) throw new Error("provider update candidate is missing");
  record.status = "reconciling";
  record.pendingObservation = cloneObservation(current);
  record.lastError = null;
  state.providers[providerId] = record;
  await persist(input, state);

  try {
    if (!input.actions?.refreshAdapter || !input.actions.reconnect) {
      throw new Error("provider update actions are not configured; replacement was not activated");
    }
    await input.actions.refreshAdapter({ providerId, previous: cloneObservation(previous), current, comparison, plan });
    const health = await input.actions.reconnect({ providerId, previous: cloneObservation(previous), current });
    if (!health.healthy) throw new Error(health.detail || "replacement provider route did not become healthy");

    let retirementPending = false;
    let retirementError: string | null = null;
    if (previous && input.actions.retirePrevious) {
      try {
        await input.actions.retirePrevious({ providerId, previous, current });
      } catch (error) {
        retirementPending = true;
        retirementError = boundedError(error);
      }
    }

    record.status = "healthy";
    record.lastGoodObservation = cloneObservation(current);
    record.pendingObservation = null;
    record.failureCount = 0;
    record.retirementPending = retirementPending;
    record.lastError = retirementError;
    state.providers[providerId] = record;
    await persist(input, state);
    return { state, status: "healthy", plan, comparison, ...(retirementError ? { error: retirementError } : {}) };
  } catch (error) {
    record.status = "waiting";
    record.failureCount += 1;
    record.lastError = boundedError(error);
    record.retirementPending = false;
    state.providers[providerId] = record;
    await persist(input, state);
    return { state, status: "waiting", plan, comparison, error: record.lastError };
  }
}
