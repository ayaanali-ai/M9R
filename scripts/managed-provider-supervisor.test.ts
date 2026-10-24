import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  normalizeManagedProviderProfile,
  type ManagedProviderConnection,
  type ManagedProviderConnectionProfile,
  type ManagedProviderConnectionSnapshot,
  type ManagedProviderContinuation,
  type ManagedProviderEvent,
  type ManagedProviderReady,
  type ManagedProviderStatus,
  type ManagedProviderTask,
} from "@/lib/native/managed-provider-contract";
import { createFileManagedProviderContinuationStore, createManagedProviderSupervisor, type ManagedProviderContinuationStore } from "@/lib/native/managed-provider-supervisor";

function profile(handle: string, provider = handle, cwd = "C:/Work/Project"): ManagedProviderConnectionProfile {
  return normalizeManagedProviderProfile({ handle, provider, cwd });
}

function task(connection: ManagedProviderConnectionProfile, generation: number, taskId: string): ManagedProviderTask {
  return {
    taskId,
    connectionId: connection.connectionId,
    handle: connection.handle,
    provider: connection.provider,
    cwd: connection.cwd,
    generation,
    prompt: "read-only supervisor test",
  };
}

function fakeConnectionFactory(log: string[], gates?: Map<string, { release?: () => void; wait?: Promise<void> }>) {
  const created = new Map<string, { starts: (ManagedProviderContinuation | undefined)[]; connection: ManagedProviderConnection }>();
  const create = (connectionProfile: ManagedProviderConnectionProfile): ManagedProviderConnection => {
    let generation = 0;
    let status: ManagedProviderStatus = "stopped";
    let activeTaskId: string | undefined;
    let doing = "Stopped";
    let continuationValue: ManagedProviderContinuation | undefined;
    let activeDone: Promise<void> | undefined;
    let resolveActiveDone: (() => void) | undefined;
    const starts: (ManagedProviderContinuation | undefined)[] = [];
    const gate = gates?.get(connectionProfile.connectionId);
    const snapshot = (): ManagedProviderConnectionSnapshot => ({
      connectionId: connectionProfile.connectionId,
      handle: connectionProfile.handle,
      provider: connectionProfile.provider,
      cwd: connectionProfile.cwd,
      status,
      generation,
      ...(activeTaskId ? { activeTaskId } : {}),
      doing,
    });
    const connection: ManagedProviderConnection = {
      profile: connectionProfile,
      async start(continuation) {
        starts.push(continuation);
        continuationValue = continuation;
        generation += 1;
        status = "ready";
        doing = "Ready";
        log.push(`start:${connectionProfile.connectionId}:${continuation?.providerSessionRef ?? "none"}`);
        return {
          connectionId: connectionProfile.connectionId,
          generation,
          ...(continuation ? { continuation } : {}),
        };
      },
      async *send(currentTask) {
        if (status !== "ready") throw new Error("fake connection is not ready");
        activeTaskId = currentTask.taskId;
        status = "working";
        doing = "Working";
        activeDone = new Promise((resolve) => { resolveActiveDone = resolve; });
        yield { kind: "status", status: "working", doing: "Working" } satisfies ManagedProviderEvent;
        if (gate?.wait) await gate.wait;
        activeTaskId = undefined;
        status = "ready";
        doing = "Ready";
        resolveActiveDone?.();
        resolveActiveDone = undefined;
        activeDone = undefined;
        continuationValue = { providerSessionRef: `session-${currentTask.taskId}` };
        yield { kind: "result", text: "done", isError: false } satisfies ManagedProviderEvent;
      },
      async cancel(taskId) {
        if (activeTaskId === taskId) {
          activeTaskId = undefined;
          status = "ready";
          resolveActiveDone?.();
          resolveActiveDone = undefined;
          activeDone = undefined;
        }
      },
      async pause() { status = "paused"; doing = "Paused"; },
      async resume() { status = "ready"; doing = "Ready"; },
      status: snapshot,
      async drain() {
        status = "draining";
        doing = "Draining";
        if (activeDone) await activeDone;
      },
      async stop() {
        log.push(`stop:${connectionProfile.connectionId}`);
        activeTaskId = undefined;
        status = "stopped";
        doing = "Stopped";
        resolveActiveDone?.();
        resolveActiveDone = undefined;
        activeDone = undefined;
      },
      continuation() { return continuationValue; },
    };
    created.set(connectionProfile.connectionId, { starts, connection });
    return connection;
  };
  return { create, created };
}

function createStore(): ManagedProviderContinuationStore & { values: Map<string, ManagedProviderContinuation | undefined> } {
  const values = new Map<string, ManagedProviderContinuation | undefined>();
  return {
    values,
    load(connectionId) { return values.get(connectionId); },
    save(connectionId, _profile, continuation) { values.set(connectionId, continuation); },
  };
}

test("owns exact logical connections and restores private continuation after stop", async () => {
  const logs: string[] = [];
  const factory = fakeConnectionFactory(logs);
  const store = createStore();
  const supervisor = createManagedProviderSupervisor({ createConnection: factory.create, continuationStore: store });
  const connectionProfile = profile("claude", "claude-code");

  const connection = await supervisor.ensureConnection(connectionProfile);
  assert.equal(connection.status().generation, 1);
  const events: ManagedProviderEvent[] = [];
  for await (const event of supervisor.dispatch(task(connectionProfile, connection.status().generation, "T-supervisor-1"))) events.push(event);
  assert.equal(events.some((event) => event.kind === "result"), true);
  assert.deepEqual(store.values.get(connectionProfile.connectionId), { providerSessionRef: "session-T-supervisor-1" });
  assert.equal("providerSessionRef" in connection.status(), false);

  await supervisor.stop();
  assert.equal(connection.status().status, "stopped");
  await supervisor.restore([connectionProfile]);
  assert.equal(factory.created.get(connectionProfile.connectionId)?.starts.at(-1)?.providerSessionRef, "session-T-supervisor-1");
  assert.equal(connection.status().status, "ready");
  assert.equal(logs.filter((entry) => entry.startsWith("start:")).length, 2);
});

test("drain blocks new work and waits for the active task before stop", async () => {
  const logs: string[] = [];
  let release!: () => void;
  const gate = { wait: new Promise<void>((resolve) => { release = resolve; }) };
  const connectionProfile = profile("codex");
  const factory = fakeConnectionFactory(logs, new Map([[connectionProfile.connectionId, gate]]));
  const supervisor = createManagedProviderSupervisor({ createConnection: factory.create });
  const connection = await supervisor.ensureConnection(connectionProfile);
  const stream = supervisor.dispatch(task(connectionProfile, connection.status().generation, "T-drain-1"));
  const iterator = stream[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.kind, "status");

  let drained = false;
  const draining = supervisor.drain().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);

  await assert.rejects(
    async () => { for await (const _event of supervisor.dispatch(task(connectionProfile, connection.status().generation, "T-drain-2"))) void _event; },
    /draining/,
  );
  release();
  while (!(await iterator.next()).done) { /* consume the provider result */ }
  await draining;
  assert.equal(drained, true);
  await supervisor.stop();
  assert.equal(connection.status().status, "stopped");
});

test("rejects stale generations and cross-connection task envelopes before adapter I/O", async () => {
  const factory = fakeConnectionFactory([]);
  const supervisor = createManagedProviderSupervisor({ createConnection: factory.create });
  const first = profile("claude", "claude-code", "C:/Work/One");
  const second = profile("claude", "claude-code", "C:/Work/Two");
  const firstConnection = await supervisor.ensureConnection(first);
  await supervisor.ensureConnection(second);

  await assert.rejects(
    async () => { for await (const _event of supervisor.dispatch(task(first, firstConnection.status().generation - 1, "T-stale"))) void _event; },
    /stale/,
  );
  await assert.rejects(
    async () => { for await (const _event of supervisor.dispatch(task({ ...first, connectionId: second.connectionId }, firstConnection.status().generation, "T-cross"))) void _event; },
    /connection/,
  );
});

test("does not create a second process for the same logical profile", async () => {
  const factory = fakeConnectionFactory([]);
  const supervisor = createManagedProviderSupervisor({ createConnection: factory.create });
  const connectionProfile = profile("opencode");
  const first = await supervisor.ensureConnection(connectionProfile);
  const second = await supervisor.ensureConnection({ ...connectionProfile });
  assert.equal(first, second);
  assert.equal(factory.created.size, 1);
});

test("file continuation metadata is profile-bound and contains no process or credential fields", () => {
  const root = mkdtempSync(join(process.cwd(), ".step9-managed-continuation-"));
  try {
    const store = createFileManagedProviderContinuationStore(root);
    const connectionProfile = profile("opencode");
    store.save(connectionProfile.connectionId, connectionProfile, { providerSessionRef: "session-safe-1" });
    assert.deepEqual(store.load(connectionProfile.connectionId, connectionProfile), { providerSessionRef: "session-safe-1" });
    assert.deepEqual(store.load(connectionProfile.connectionId, { ...connectionProfile, cwd: "c:/work/other" }), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
