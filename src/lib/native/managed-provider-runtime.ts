import type {
  ManagedProviderConnectionProfile,
  ManagedProviderConnectionSnapshot,
  ManagedProviderStatus,
} from "./managed-provider-contract";

export interface ManagedProviderRuntimeRegistration {
  readonly profile: ManagedProviderConnectionProfile;
  readonly status?: ManagedProviderStatus;
  readonly doing?: string;
}

interface RuntimeEntry {
  readonly profile: ManagedProviderConnectionProfile;
  status: ManagedProviderStatus;
  doing?: string;
  generation: number;
  stopping: boolean;
  activeTaskId?: string;
}

/**
 * Provider-neutral lifecycle state for the M9R-owned supervisor.
 *
 * The provider adapters still own their wire protocols. This module owns the
 * boundaries that must be identical for every adapter: one logical connection
 * per profile, generation fencing for late callbacks, explicit stop/drain
 * invalidation, and single-task ownership. It intentionally stores no process
 * IDs, tokens, or provider session references.
 */
export interface ManagedProviderRuntime {
  register(registration: ManagedProviderRuntimeRegistration): void;
  beginStart(connectionId: string): number;
  beginStop(connectionId: string): number;
  finishStop(connectionId: string, generation: number, doing?: string): boolean;
  currentGeneration(connectionId: string): number;
  isCurrent(connectionId: string, generation: number): boolean;
  isStopping(connectionId: string): boolean;
  transition(connectionId: string, status: ManagedProviderStatus, doing?: string): boolean;
  transitionFor(connectionId: string, generation: number, status: ManagedProviderStatus, doing?: string): boolean;
  claimTask(connectionId: string, generation: number, taskId: string): boolean;
  clearTask(connectionId: string, generation: number, taskId?: string): boolean;
  snapshot(connectionId: string): ManagedProviderConnectionSnapshot | undefined;
  snapshots(): readonly ManagedProviderConnectionSnapshot[];
}

function requireEntry(entries: Map<string, RuntimeEntry>, connectionId: string): RuntimeEntry {
  const entry = entries.get(connectionId);
  if (!entry) throw new Error(`managed provider connection is not registered: ${connectionId}`);
  return entry;
}

function publicSnapshot(entry: RuntimeEntry): ManagedProviderConnectionSnapshot {
  return {
    connectionId: entry.profile.connectionId,
    handle: entry.profile.handle,
    provider: entry.profile.provider,
    cwd: entry.profile.cwd,
    status: entry.status,
    generation: entry.generation,
    ...(entry.activeTaskId ? { activeTaskId: entry.activeTaskId } : {}),
    ...(entry.doing ? { doing: entry.doing } : {}),
  };
}

export function createManagedProviderRuntime(
  registrations: readonly ManagedProviderRuntimeRegistration[] = [],
): ManagedProviderRuntime {
  const entries = new Map<string, RuntimeEntry>();

  const register = (registration: ManagedProviderRuntimeRegistration): void => {
    const { profile } = registration;
    if (entries.has(profile.connectionId)) {
      throw new Error(`managed provider connection is already registered: ${profile.connectionId}`);
    }
    entries.set(profile.connectionId, {
      profile,
      status: registration.status ?? "stopped",
      doing: registration.doing,
      generation: 0,
      stopping: false,
    });
  };

  for (const registration of registrations) register(registration);

  return {
    register,

    beginStart(connectionId) {
      const entry = requireEntry(entries, connectionId);
      entry.generation += 1;
      entry.stopping = false;
      entry.status = "starting";
      entry.doing = "Starting";
      return entry.generation;
    },

    beginStop(connectionId) {
      const entry = requireEntry(entries, connectionId);
      if (!entry.stopping) {
        entry.generation += 1;
        entry.stopping = true;
      }
      entry.status = "draining";
      entry.doing = "Draining";
      return entry.generation;
    },

    finishStop(connectionId, generation, doing = "Stopped by you") {
      const entry = requireEntry(entries, connectionId);
      if (entry.generation !== generation) return false;
      entry.stopping = false;
      entry.status = "stopped";
      entry.doing = doing;
      entry.activeTaskId = undefined;
      return true;
    },

    currentGeneration(connectionId) {
      return requireEntry(entries, connectionId).generation;
    },

    isCurrent(connectionId, generation) {
      const entry = entries.get(connectionId);
      return Boolean(entry && entry.generation === generation);
    },

    isStopping(connectionId) {
      return requireEntry(entries, connectionId).stopping;
    },

    transition(connectionId, status, doing) {
      const entry = requireEntry(entries, connectionId);
      if (entry.stopping && status !== "draining" && status !== "stopped") return false;
      entry.status = status;
      entry.doing = doing;
      if (status === "stopped") entry.stopping = false;
      return true;
    },

    transitionFor(connectionId, generation, status, doing) {
      const entry = entries.get(connectionId);
      if (!entry || entry.generation !== generation) return false;
      if (entry.stopping && status !== "draining" && status !== "stopped") return false;
      entry.status = status;
      entry.doing = doing;
      if (status === "stopped") entry.stopping = false;
      return true;
    },

    claimTask(connectionId, generation, taskId) {
      const entry = entries.get(connectionId);
      if (!entry || entry.generation !== generation || entry.stopping || !taskId.trim() || entry.activeTaskId) return false;
      entry.activeTaskId = taskId;
      return true;
    },

    clearTask(connectionId, generation, taskId) {
      const entry = entries.get(connectionId);
      if (!entry || entry.generation !== generation) return false;
      if (taskId !== undefined && entry.activeTaskId !== taskId) return false;
      entry.activeTaskId = undefined;
      return true;
    },

    snapshot(connectionId) {
      const entry = entries.get(connectionId);
      return entry ? publicSnapshot(entry) : undefined;
    },

    snapshots() {
      return [...entries.values()].map(publicSnapshot);
    },
  };
}
