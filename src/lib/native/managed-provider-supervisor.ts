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

function sameProfile(left: ManagedProviderConnectionProfile, right: ManagedProviderConnectionProfile): boolean {
  return left.connectionId === right.connectionId
    && left.handle === right.handle
    && left.provider === right.provider
    && left.cwd === right.cwd
    && left.model === right.model
    && left.effort === right.effort;
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
  if (snapshot.connectionId !== profile.connectionId
    || snapshot.handle !== profile.handle
    || snapshot.provider !== profile.provider
    || snapshot.cwd !== profile.cwd) {
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
  const store = options.continuationStore;
  let draining = false;

  const persist = async (entry: Entry): Promise<void> => {
    if (!store) return;
    const continuation = normalizeContinuation(entry.connection.continuation());
    await store.save(entry.profile.connectionId, entry.profile, continuation);
  };

  const load = async (profile: ManagedProviderConnectionProfile, explicit?: ManagedProviderContinuation): Promise<ManagedProviderContinuation | undefined> => {
    if (explicit !== undefined) return normalizeContinuation(explicit);
    if (!store) return undefined;
    return normalizeContinuation(await store.load(profile.connectionId, profile));
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
    if (snapshot.status === "ready" || snapshot.status === "working" || snapshot.status === "paused") return entry.connection;
    if (snapshot.status === "draining") throw new Error(`managed provider connection is draining: ${profile.connectionId}`);

    const continuation = await load(profile, explicitContinuation);
    const ready = await entry.connection.start(continuation);
    generationFromReady(entry.connection, profile, ready);
    await persist(entry);
    return entry.connection;
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
    await Promise.all([...entries.values()].map((entry) => entry.connection.drain()));
    await Promise.all([...entries.values()].map((entry) => persist(entry)));
  };

  const stop = async (): Promise<void> => {
    draining = true;
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
