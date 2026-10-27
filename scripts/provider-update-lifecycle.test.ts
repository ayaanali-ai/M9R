import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createLocalStore } from "../src/lib/native/local-store.ts";
import {
  reconcileProviderUpdate,
  createInitialProviderUpdateState,
  normalizeProviderUpdateState,
  type ProviderUpdateState,
} from "../src/lib/native/provider-update-lifecycle-core.ts";
import { normalizeProviderRuntimeObservation, type ProviderRuntimeObservation } from "../src/lib/native/provider-update-compatibility-core.ts";

const scratchRoot = join(process.cwd(), ".test-tmp");
mkdirSync(scratchRoot, { recursive: true });
const fixtureRoot = mkdtempSync(join(scratchRoot, "oathlock-provider-update-lifecycle-"));

function tempStore(prefix: string): string {
  return mkdtempSync(join(fixtureRoot, prefix));
}

function observation(overrides: Partial<ProviderRuntimeObservation> = {}): ProviderRuntimeObservation {
  return normalizeProviderRuntimeObservation({
    providerId: "claude-code",
    binary: "claude",
    versionLine: "Claude Code 1.2.3",
    executablePath: "C:/tools/claude.exe",
    transport: "cli-mcp",
    adapterContractVersion: "m9r.adapter-contract.v1",
    capabilityManifestVersion: "m9r.provider-capabilities.v1",
    configFingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    observedAtMs: 100,
    ...overrides,
  });
}

function verifiedLiveSessionActions() {
  return {
    refreshAdapter: async () => undefined,
    reconnect: async () => ({ healthy: true, detail: "test observer rebound a live provider session" }),
  };
}

test("unchanged provider versions cannot retain healthy status after their session disappears", async () => {
  const first = await reconcileProviderUpdate({ providerId: "claude-code", state: createInitialProviderUpdateState(), current: observation(), nowMs: 100, actions: verifiedLiveSessionActions() });
  const next = await reconcileProviderUpdate({ providerId: "claude-code", state: first.state, current: observation(), nowMs: 200,
    actions: { reconnect: async () => ({ healthy: false, detail: "session disconnected" }) } });
  assert.equal(next.status, "waiting");
  assert.match(next.error!, /session disconnected/);
});

test("a new provider observation is committed as healthy and survives a fresh store instance", async () => {
  const root = tempStore("m9r-provider-update-store-");
  try {
    const store = createLocalStore(root);
    const next = await reconcileProviderUpdate({
      providerId: "claude-code",
      state: store.providerUpdateState(),
      current: observation(),
      nowMs: 100,
      actions: verifiedLiveSessionActions(),
    });
    assert.equal(next.status, "healthy");
    store.saveProviderUpdateState(next.state);

    const restarted = createLocalStore(root);
    const persisted = restarted.providerUpdateState();
    assert.equal(persisted.schemaVersion, 1);
    assert.equal(persisted.providers["claude-code"]?.lastGoodObservation?.fingerprint, observation().fingerprint);
    assert.equal(persisted.providers["claude-code"]?.pendingObservation, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unchanged provider rechecks its session without rewriting configuration", async () => {
  const first = await reconcileProviderUpdate({ providerId: "claude-code", state: createInitialProviderUpdateState(), current: observation(), nowMs: 100, actions: verifiedLiveSessionActions() });
  let refreshes = 0;
  let reconnects = 0;
  const second = await reconcileProviderUpdate({
    providerId: "claude-code",
    state: first.state,
    current: observation({ observedAtMs: 200 }),
    nowMs: 200,
    actions: {
      refreshAdapter: async () => { refreshes += 1; },
      reconnect: async () => { reconnects += 1; return { healthy: true }; },
    },
  });
  assert.equal(second.status, "healthy");
  assert.equal(second.plan.action, "reuse_connection");
  assert.equal(refreshes, 0);
  assert.equal(reconnects, 1);
});

test("startup reconciliation reconnects an unchanged provider session and stays waiting until it is actually bound", async () => {
  const first = await reconcileProviderUpdate({
    providerId: "claude-code",
    state: createInitialProviderUpdateState(),
    current: observation(),
    nowMs: 100,
    actions: verifiedLiveSessionActions(),
  });
  const events: string[] = [];
  const next = await reconcileProviderUpdate({
    providerId: "claude-code",
    state: first.state,
    current: observation({ observedAtMs: 200 }),
    nowMs: 200,
    reconcileUnchanged: true,
    actions: {
      refreshAdapter: async () => { events.push("refresh"); },
      reconnect: async () => { events.push("reconnect"); return { healthy: false, detail: "no live Claude session was rebound" }; },
    },
  });
  assert.equal(next.status, "waiting");
  assert.equal(next.state.providers["claude-code"]?.lastGoodObservation?.version, "1.2.3");
  assert.match(next.error ?? "", /no live Claude session was rebound/);
  assert.deepEqual(events, ["refresh", "reconnect"]);
});

test("the first provider observation runs the configured initialization callback before becoming healthy", async () => {
  const events: string[] = [];
  const first = await reconcileProviderUpdate({
    providerId: "claude-code",
    state: createInitialProviderUpdateState(),
    current: observation(),
    nowMs: 100,
    actions: {
      refreshAdapter: async () => { events.push("refresh"); },
      reconnect: async () => { events.push("reconnect"); return { healthy: true }; },
    },
  });
  assert.equal(first.status, "healthy");
  assert.deepEqual(events, ["refresh", "reconnect"]);
  assert.equal(first.state.providers["claude-code"]?.lastGoodObservation?.version, "1.2.3");
});

test("a provider update persists a pending candidate before refresh and retires old state only after health", async () => {
  const first = await reconcileProviderUpdate({ providerId: "claude-code", state: createInitialProviderUpdateState(), current: observation(), nowMs: 100, actions: verifiedLiveSessionActions() });
  const events: string[] = [];
  const next = await reconcileProviderUpdate({
    providerId: "claude-code",
    state: first.state,
    current: observation({ versionLine: "Claude Code 1.3.0", observedAtMs: 200 }),
    nowMs: 200,
    persist: async (state) => { events.push(state.providers["claude-code"]?.status ?? "missing"); },
    actions: {
      refreshAdapter: async () => { events.push("refresh"); },
      reconnect: async () => { events.push("reconnect"); return { healthy: true }; },
      retirePrevious: async () => { events.push("retire"); },
    },
  });
  assert.equal(next.status, "healthy");
  assert.equal(next.state.providers["claude-code"]?.lastGoodObservation?.version, "1.3.0");
  assert.deepEqual(events, ["reconciling", "refresh", "reconnect", "retire", "healthy"]);
});

test("the real local store contains the pending candidate before side effects run", async () => {
  const root = tempStore("pending-before-side-effect-");
  try {
    const store = createLocalStore(root);
    const first = await reconcileProviderUpdate({ providerId: "claude-code", state: store.providerUpdateState(), current: observation(), nowMs: 100, actions: verifiedLiveSessionActions() });
    store.saveProviderUpdateState(first.state);
    let pendingSeenByRefresh = false;
    const next = await reconcileProviderUpdate({
      providerId: "claude-code",
      state: store.providerUpdateState(),
      current: observation({ versionLine: "Claude Code 1.3.0", observedAtMs: 200 }),
      nowMs: 200,
      persist: (state) => { store.saveProviderUpdateState(state); },
      actions: {
        refreshAdapter: async () => {
          const persisted = createLocalStore(root).providerUpdateState().providers["claude-code"];
          pendingSeenByRefresh = persisted?.status === "reconciling" && persisted.pendingObservation?.version === "1.3.0";
        },
        reconnect: async () => ({ healthy: true }),
      },
    });
    assert.equal(next.status, "healthy");
    assert.equal(pendingSeenByRefresh, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed refresh retains the last-known-good provider and does not retire the old connection", async () => {
  const first = await reconcileProviderUpdate({ providerId: "claude-code", state: createInitialProviderUpdateState(), current: observation(), nowMs: 100, actions: verifiedLiveSessionActions() });
  let retired = false;
  const next = await reconcileProviderUpdate({
    providerId: "claude-code",
    state: first.state,
    current: observation({ versionLine: "Claude Code 1.3.0", observedAtMs: 200 }),
    nowMs: 200,
    actions: {
      refreshAdapter: async () => { throw new Error("adapter refresh unavailable"); },
      reconnect: async () => ({ healthy: true }),
      retirePrevious: async () => { retired = true; },
    },
  });
  assert.equal(next.status, "waiting");
  assert.equal(next.state.providers["claude-code"]?.lastGoodObservation?.version, "1.2.3");
  assert.equal(next.state.providers["claude-code"]?.pendingObservation?.version, "1.3.0");
  assert.equal(retired, false);
  assert.match(next.state.providers["claude-code"]?.lastError ?? "", /adapter refresh unavailable/);
});

test("provider failure diagnostics are redacted before durable persistence", async () => {
  const first = await reconcileProviderUpdate({ providerId: "claude-code", state: createInitialProviderUpdateState(), current: observation(), nowMs: 100, actions: verifiedLiveSessionActions() });
  const next = await reconcileProviderUpdate({
    providerId: "claude-code",
    state: first.state,
    current: observation({ versionLine: "Claude Code 1.3.0", observedAtMs: 200 }),
    nowMs: 200,
    actions: {
      refreshAdapter: async () => { throw new Error("provider api_key=secret-value-123456 leaked"); },
      reconnect: async () => ({ healthy: true }),
    },
  });
  assert.equal(next.status, "waiting");
  assert.doesNotMatch(next.state.providers["claude-code"]?.lastError ?? "", /secret-value-123456/);
  assert.match(next.state.providers["claude-code"]?.lastError ?? "", /\[redacted\]/);
});

test("an unhealthy replacement is retained as pending and cannot retire the healthy previous state", async () => {
  const first = await reconcileProviderUpdate({ providerId: "claude-code", state: createInitialProviderUpdateState(), current: observation(), nowMs: 100, actions: verifiedLiveSessionActions() });
  let retired = false;
  const next = await reconcileProviderUpdate({
    providerId: "claude-code",
    state: first.state,
    current: observation({ versionLine: "Claude Code 1.3.0", observedAtMs: 200 }),
    nowMs: 200,
    actions: {
      refreshAdapter: async () => undefined,
      reconnect: async () => ({ healthy: false, detail: "MCP health did not settle" }),
      retirePrevious: async () => { retired = true; },
    },
  });
  assert.equal(next.status, "waiting");
  assert.equal(next.state.providers["claude-code"]?.lastGoodObservation?.version, "1.2.3");
  assert.equal(retired, false);
});

test("temporary provider absence retains durable state without creating a reconnect loop or clearing tasks", async () => {
  const first = await reconcileProviderUpdate({ providerId: "claude-code", state: createInitialProviderUpdateState(), current: observation(), nowMs: 100, actions: verifiedLiveSessionActions() });
  const next = await reconcileProviderUpdate({ providerId: "claude-code", state: first.state, current: null, nowMs: 200 });
  assert.equal(next.status, "waiting");
  assert.equal(next.plan.action, "wait_without_mutation");
  assert.equal(next.state.providers["claude-code"]?.lastGoodObservation?.version, "1.2.3");
  assert.equal(next.state.providers["claude-code"]?.pendingObservation, null);
});

test("persisted provider state rejects credentials and tampered observation fingerprints", () => {
  const good = createInitialProviderUpdateState();
  assert.throws(() => normalizeProviderUpdateState({
    ...good,
    providers: { "claude-code": { token: "secret" } },
  } as unknown as ProviderUpdateState), /invalid|observation|record/i);

  const current = observation();
  assert.throws(() => normalizeProviderUpdateState({
    ...good,
    providers: {
      "claude-code": {
        providerId: "claude-code",
        status: "healthy",
        lastGoodObservation: { ...current, fingerprint: "0".repeat(64) },
        pendingObservation: null,
        failureCount: 0,
        lastComparison: null,
        plan: null,
        lastActionAtMs: 100,
        lastError: null,
      },
    },
  }), /fingerprint|invalid/i);
});

test("the local store state remains bounded and contains no provider credentials", async () => {
  const root = tempStore("m9r-provider-update-bounded-");
  try {
    const store = createLocalStore(root);
    const state = (await reconcileProviderUpdate({ providerId: "claude-code", state: store.providerUpdateState(), current: observation(), nowMs: 100, actions: verifiedLiveSessionActions() })).state;
    store.saveProviderUpdateState(state);
    const raw = readFileSync(join(root, "state.json"), "utf8");
    assert.doesNotMatch(raw, /token|secret|password|bearer/i);
    assert.ok(raw.length < 1_000_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
