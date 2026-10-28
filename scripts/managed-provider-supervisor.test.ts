import assert from "node:assert/strict";
import test from "node:test";
import { createManagedProviderSupervisor } from "../src/lib/native/managed-provider-supervisor";
import type {
  ManagedProviderConnection,
  ManagedProviderConnectionProfile,
  ManagedProviderConnectionSnapshot,
  ManagedProviderEvent,
  ManagedProviderModelApply,
  ManagedProviderReadiness,
  ManagedProviderReady,
} from "../src/lib/native/managed-provider-contract";

const profile: ManagedProviderConnectionProfile = {
  connectionId: "m9r:codex:supervisor-test",
  handle: "codex",
  provider: "codex",
  cwd: "C:/RunLeak/runleak",
};

function fakeConnection(
  start: (continuation?: { providerSessionRef?: string }) => Promise<ManagedProviderReady>,
  readiness: () => ManagedProviderReadiness,
  status: () => ManagedProviderConnectionSnapshot,
): ManagedProviderConnection {
  const emptyEvents = async function* (): AsyncIterable<ManagedProviderEvent> { /* no-op */ };
  const modelApply: ManagedProviderModelApply = { ok: true, applies: "next-turn" };
  return {
    profile,
    start,
    send: emptyEvents,
    cancel: async () => undefined,
    pause: async () => undefined,
    resume: async () => undefined,
    status,
    readiness,
    capabilities: () => ({ connectionId: profile.connectionId, provider: profile.provider, generation: status().generation, models: [], currentModel: null, currentEffort: null }),
    applyModelSelection: async () => modelApply,
    continuation: () => undefined,
    drain: async () => undefined,
    stop: async () => undefined,
  };
}

test("coalesces concurrent starts for one M9R-owned connection", async () => {
  let starts = 0;
  let generation = 0;
  let state: ManagedProviderConnectionSnapshot["status"] = "stopped";
  let healthy = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const connection = fakeConnection(async () => {
    starts += 1;
    await gate;
    generation += 1;
    state = "ready";
    healthy = true;
    return { connectionId: profile.connectionId, generation };
  }, () => ({ healthy }), () => ({ ...profile, status: state, generation }));
  const supervisor = createManagedProviderSupervisor({ createConnection: () => connection });

  const first = supervisor.ensureConnection(profile);
  const second = supervisor.ensureConnection(profile);
  await Promise.resolve();
  assert.equal(starts, 1);
  release();
  const [left, right] = await Promise.all([first, second]);
  assert.strictEqual(left, right);
  assert.equal(starts, 1);
});

test("restarts a dead provider runtime once and preserves the logical connection", async () => {
  let starts = 0;
  let generation = 0;
  let state: ManagedProviderConnectionSnapshot["status"] = "stopped";
  let healthy = false;
  const connection = fakeConnection(async (continuation) => {
    starts += 1;
    generation += 1;
    state = "ready";
    healthy = true;
    assert.equal(continuation?.providerSessionRef, starts === 1 ? undefined : "thread-1");
    return { connectionId: profile.connectionId, generation, continuation: { providerSessionRef: "thread-1" } };
  }, () => ({ healthy }), () => ({ ...profile, status: state, generation }));
  const supervisor = createManagedProviderSupervisor({ createConnection: () => connection });

  await supervisor.ensureConnection(profile);
  healthy = false;
  state = "failed";
  const recovered = await supervisor.ensureConnection(profile);
  assert.strictEqual(recovered, connection);
  assert.equal(starts, 2);
  assert.equal(supervisor.snapshots()[0]?.generation, 2);
});
