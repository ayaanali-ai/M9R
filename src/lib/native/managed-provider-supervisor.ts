import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  normalizeManagedProviderProfile,
  validateManagedProviderTask,
  type ManagedProviderConnection,
  type ManagedProviderConnectionProfile,
  type ManagedProviderConnectionSnapshot,
  type ManagedProviderContinuation,
  type ManagedProviderEvent,
  type ManagedProviderSupervisor,
  type ManagedProviderTask,
} from "./managed-provider-contract";
import { createRuntimeReadinessCache, type RuntimeReadinessCache, type RuntimeReadinessInvalidationReason } from "./runtime-readiness";

const CONTINUATION_REF = /^[A-Za-z0-9_-]{1,200}$/;

/**
 * The supervisor owns only logical connection state. Provider-specific wire
 * details stay behind the injected adapter factory, and private continuation
 * metadata stays behind this store. No process ID, token, or executable path
 * is used to select a connection or is returned to UI callers.
 */
export interface ManagedProviderContinuationStore {
  load(
    connectionId: string,
    profile: ManagedProviderConnectionProfile,
  ): ManagedProviderContinuation | undefined | Promise<ManagedProviderContinuation | undefined>;
  save(
    connectionId: string,
    profile: ManagedProviderConnectionProfile,
    continuation: ManagedProviderContinuation | undefined,
  ): void | Promise<void>;
}

export interface ManagedProviderSupervisorOptions {
  createConnection(profile: ManagedProviderConnectionProfile): ManagedProviderConnection;
  continuationStore?: ManagedProviderContinuationStore;
  /** Optional Phase 9 proof cache. It never replaces the adapter health check on a cache miss. */
  readinessCache?: RuntimeReadinessCache;
  /** Build identity used to invalidate cached runtime proofs after an update. */
  buildFingerprint?: string;
}

interface PersistedContinuation {
  version: 1;
  connectionId: string;
  handle: string;
  provider: string;
  cwd: string;
  continuation?: ManagedProviderContinuation;
}

interface Entry {
  readonly profile: ManagedProviderConnectionProfile;
  readonly connection: ManagedProviderConnection;
}

function canonicalProfile(profile: ManagedProviderConnectionProfile): ManagedProviderConnectionProfile {
  try {
    return normalizeManagedProviderProfile(profile);
  } catch {
    return profile;
  }
}

function sameProfile(left: ManagedProviderConnectionProfile, right: ManagedProviderConnectionProfile): boolean {
  const canonicalLeft = canonicalProfile(left);
  const canonicalRight = canonicalProfile(right);
  return canonicalLeft.connectionId === canonicalRight.connectionId
    && canonicalLeft.handle === canonicalRight.handle
    && canonicalLeft.provider === canonicalRight.provider
    && canonicalLeft.cwd === canonicalRight.cwd
    && canonicalLeft.model === canonicalRight.model
    && canonicalLeft.effort === canonicalRight.effort;
}

function normalizeContinuation(value: unknown): ManagedProviderContinuation | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("managed provider continuation metadata is invalid");
  const input = value as { providerSessionRef?: unknown };
  if (input.providerSessionRef === undefined) return undefined;
  if (typeof input.providerSessionRef !== "string" || !CONTINUATION_REF.test(input.providerSessionRef)) {
    throw new Error("managed provider continuation reference is invalid");
  }
  return { providerSessionRef: input.providerSessionRef };
}

function continuationFile(root: string, connectionId: string): string {
  const key = createHash("sha256").update(connectionId, "utf8").digest("hex");
  return join(resolve(root), `${key}.json`);
}

/**
 * Durable continuation storage for an owner supervisor. The filename is a
 * one-way digest of the logical connection ID; the record is profile-bound so
 * metadata from another provider or folder can never be reused accidentally.
 */
export function createFileManagedProviderContinuationStore(root: string): ManagedProviderContinuationStore {
  const directory = resolve(root);
  return {
    load(connectionId, profile) {
      const path = continuationFile(directory, connectionId);
      if (!existsSync(path)) return undefined;
      try {
        const record = JSON.parse(readFileSync(path, "utf8")) as Partial<PersistedContinuation>;
        if (record.version !== 1 || record.connectionId !== connectionId || record.handle !== profile.handle
          || record.provider !== profile.provider || record.cwd !== profile.cwd) return undefined;
        return normalizeContinuation(record.continuation);
      } catch {
        // Corrupt private metadata is ignored, never passed to a provider or
        // allowed to select a different logical connection.
        return undefined;
      }
    },
    save(connectionId, profile, continuation) {
      const path = continuationFile(directory, connectionId);
      if (continuation === undefined) {
        rmSync(path, { force: true });
        return;
      }
      const normalized = normalizeContinuation(continuation);
      if (!normalized) {
        rmSync(path, { force: true });
        return;
      }
      mkdirSync(directory, { recursive: true });
      const record: PersistedContinuation = {
        version: 1,
        connectionId,
        handle: profile.handle,
        provider: profile.provider,
        cwd: profile.cwd,
        continuation: normalized,
      };
      const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
      try {
        writeFileSync(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
        try { chmodSync(temporary, 0o600); } catch { /* Windows inherits the owner-only ACL from the M9R state root. */ }
        renameSync(temporary, path);
      } catch (error) {
        rmSync(temporary, { force: true });
        throw error;
      }
    },
  };
}

function profileForConnection(connection: ManagedProviderConnection, expected: ManagedProviderConnectionProfile): void {
  if (!sameProfile(connection.profile, expected)) {
    throw new Error(`managed provider adapter returned a profile different from ${expected.connectionId}`);
  }
}

function snapshotForConnection(connection: ManagedProviderConnection, profile: ManagedProviderConnectionProfile): ManagedProviderConnectionSnapshot {
  const snapshot = connection.status();
  const snapshotProfile: ManagedProviderConnectionProfile = {
    connectionId: snapshot.connectionId,
    handle: snapshot.handle,
    provider: snapshot.provider,
    cwd: snapshot.cwd,
  };
  if (!sameProfile(snapshotProfile, profile)) {
    throw new Error(`managed provider adapter returned an identity different from ${profile.connectionId}`);
  }
  return snapshot;
}

function generationFromReady(
  connection: ManagedProviderConnection,
  profile: ManagedProviderConnectionProfile,
  ready: { connectionId: string; generation: number },
): number {
  if (ready.connectionId !== profile.connectionId || !Number.isSafeInteger(ready.generation) || ready.generation < 1) {
    throw new Error(`managed provider adapter did not return a valid generation for ${profile.connectionId}`);
  }
  const snapshot = snapshotForConnection(connection, profile);
  if (snapshot.generation !== ready.generation) {
    throw new Error(`managed provider adapter generation disagreed for ${profile.connectionId}`);
  }
  return ready.generation;
}

export function createManagedProviderSupervisor(options: ManagedProviderSupervisorOptions): ManagedProviderSupervisor {
  const entries = new Map<string, Entry>();
  // Keep the latest private continuation in memory even when a durable store
  // is not configured. A provider restart within this supervisor must resume
  // the same logical session rather than silently starting a new one.
  const continuations = new Map<string, ManagedProviderContinuation | undefined>();
  // A logical connection may be requested by startup reconciliation and a
  // delivery at the same time. Coalesce those requests before they reach the
  // provider adapter so one profile can never launch two runtimes for one
  // generation.
  const starting = new Map<string, Promise<ManagedProviderConnection>>();
  const store = options.continuationStore;
  const readinessCache = options.readinessCache ?? createRuntimeReadinessCache({ buildFingerprint: options.buildFingerprint });
  let draining = false;

  const readinessIdentity = (profile: ManagedProviderConnectionProfile, snapshot: ManagedProviderConnectionSnapshot) => ({
    connectionId: snapshot.connectionId,
    handle: snapshot.handle,
    provider: snapshot.provider,
    cwd: snapshot.cwd,
    generation: snapshot.generation,
    buildFingerprint: options.buildFingerprint ?? "unknown",
  });

  const invalidate = (connectionId: string, reason: RuntimeReadinessInvalidationReason): void => {
    readinessCache.invalidate(connectionId, reason);
  };

  const persist = async (entry: Entry, returnedContinuation?: ManagedProviderContinuation): Promise<void> => {
    const continuation = normalizeContinuation(returnedContinuation ?? entry.connection.continuation());
    continuations.set(entry.profile.connectionId, continuation);
    if (store) await store.save(entry.profile.connectionId, entry.profile, continuation);
  };

  const load = async (profile: ManagedProviderConnectionProfile, explicit?: ManagedProviderContinuation): Promise<ManagedProviderContinuation | undefined> => {
    if (explicit !== undefined) return normalizeContinuation(explicit);
    if (store) {
      const persisted = await store.load(profile.connectionId, profile);
      if (persisted !== undefined) return normalizeContinuation(persisted);
    }
    return continuations.get(profile.connectionId);
  };

  const waitForStarts = async (): Promise<void> => {
    const pending = [...new Set(starting.values())];
    if (pending.length === 0) return;
    await Promise.all(pending.map((promise) => promise.catch(() => undefined)));
  };

  const ensureConnection = async (
    input: ManagedProviderConnectionProfile,
    explicitContinuation?: ManagedProviderContinuation,
  ): Promise<ManagedProviderConnection> => {
    if (draining) throw new Error("M9R owner supervisor is draining; new provider work is blocked");
    const profile = normalizeManagedProviderProfile(input);
    if (profile.connectionId !== input.connectionId) throw new Error("managed provider profile must carry its normalized connection ID");

    let entry = entries.get(profile.connectionId);
    if (entry) {
      if (!sameProfile(entry.profile, profile)) throw new Error(`managed provider connection ID is already bound to a different profile: ${profile.connectionId}`);
      profileForConnection(entry.connection, profile);
    } else {
      const connection = options.createConnection(profile);
      profileForConnection(connection, profile);
      entry = { profile, connection };
      entries.set(profile.connectionId, entry);
    }

    const snapshot = snapshotForConnection(entry.connection, profile);
    if (snapshot.status === "stopped" || snapshot.status === "failed") {
      invalidate(profile.connectionId, "process-exit");
    }
    if (snapshot.status === "ready" || snapshot.status === "working" || snapshot.status === "paused") {
      // A status snapshot alone is not proof that the provider process or SDK
      // transport is still alive. Reuse only after the adapter verifies its
      // own live binding; otherwise start() replaces the stale runtime through
      // the normal generation/continuation path.
      const identity = readinessIdentity(profile, snapshot);
      if (readinessCache.isValid(identity)) return entry.connection;
      const readiness = entry.connection.readiness();
      const verified = readinessCache.verify(identity, readiness.healthy);
      if (verified.ok) return entry.connection;
      invalidate(profile.connectionId, verified.reason === "unhealthy" ? "health-failure" : "manual");
    }
    if (snapshot.status === "draining") throw new Error(`managed provider connection is draining: ${profile.connectionId}`);

    const inFlight = starting.get(profile.connectionId);
    if (inFlight) return inFlight;

    const startPromise = (async (): Promise<ManagedProviderConnection> => {
      const continuation = await load(profile, explicitContinuation);
      const ready = await entry!.connection.start(continuation);
      generationFromReady(entry!.connection, profile, ready);
      const live = snapshotForConnection(entry!.connection, profile);
      // `start()` is the adapter's explicit lifecycle receipt. Cache that
      // receipt without immediately performing a second health probe; the
      // next reuse still has the adapter probe as a cache-miss fallback.
      const verified = readinessCache.verify(readinessIdentity(profile, live), true);
      if (!verified.ok) throw new Error(`managed provider readiness verification failed for ${profile.connectionId}: ${verified.reason}`);
      await persist(entry!, ready.continuation);
      return entry!.connection;
    })();
    starting.set(profile.connectionId, startPromise);
    try {
      return await startPromise;
    } finally {
      if (starting.get(profile.connectionId) === startPromise) starting.delete(profile.connectionId);
    }
  };

  const dispatch = async function* (task: ManagedProviderTask): AsyncIterable<ManagedProviderEvent> {
    if (draining) throw new Error("M9R owner supervisor is draining; new provider work is blocked");
    const entry = entries.get(task.connectionId);
    if (!entry) throw new Error(`managed provider connection is not registered: ${task.connectionId}`);
    const snapshot = snapshotForConnection(entry.connection, entry.profile);
    const validation = validateManagedProviderTask(task, entry.profile, snapshot.generation);
    if (!validation.ok) throw new Error(validation.error);
    if (snapshot.status !== "ready") throw new Error(`managed provider connection is not ready: ${snapshot.status}`);
    try {
      for await (const event of entry.connection.send(task)) yield event;
    } catch (error) {
      // A transport/process failure invalidates the proof immediately. The
      // next turn must perform a fresh readiness check and, if necessary,
      // replace the runtime generation instead of reusing a stale handle.
      invalidate(entry.profile.connectionId, "transport-error");
      throw error;
    } finally {
      await persist(entry);
    }
  };

  const cancel = async (connectionId: string, taskId: string): Promise<void> => {
    const entry = entries.get(connectionId);
    if (!entry) throw new Error(`managed provider connection is not registered: ${connectionId}`);
    await entry.connection.cancel(taskId);
    await persist(entry);
  };

  const pause = async (connectionId: string): Promise<void> => {
    const entry = entries.get(connectionId);
    if (!entry) throw new Error(`managed provider connection is not registered: ${connectionId}`);
    await entry.connection.pause();
  };

  const resume = async (connectionId: string): Promise<void> => {
    const entry = entries.get(connectionId);
    if (!entry) throw new Error(`managed provider connection is not registered: ${connectionId}`);
    await entry.connection.resume();
  };

  const snapshots = (): readonly ManagedProviderConnectionSnapshot[] => [...entries.values()]
    .map((entry) => snapshotForConnection(entry.connection, entry.profile));

  const drain = async (): Promise<void> => {
    draining = true;
    readinessCache.invalidateAll("manual");
    await waitForStarts();
    await Promise.all([...entries.values()].map((entry) => entry.connection.drain()));
    await Promise.all([...entries.values()].map((entry) => persist(entry)));
  };

  const stop = async (): Promise<void> => {
    draining = true;
    readinessCache.invalidateAll("process-exit");
    await waitForStarts();
    // `drain()` is a separate boundary. Once the caller has bounded active
    // work, stop only the exact connections this supervisor owns; never scan
    // or kill processes by provider name.
    await Promise.all([...entries.values()].map(async (entry) => {
      await persist(entry);
      await entry.connection.stop();
      await persist(entry);
    }));
  };

  const restore = async (profiles?: readonly ManagedProviderConnectionProfile[]): Promise<readonly ManagedProviderConnectionSnapshot[]> => {
    draining = false;
    readinessCache.restartBroker();
    const requested = profiles ?? [...entries.values()].map((entry) => entry.profile);
    try {
      await Promise.all(requested.map((profile) => ensureConnection(profile)));
      return snapshots();
    } catch (error) {
      draining = true;
      throw error;
    }
  };

  return {
    ensureConnection,
    dispatch,
    cancel,
    pause,
    resume,
    snapshots,
    drain,
    stop,
    restore,
  };
}
