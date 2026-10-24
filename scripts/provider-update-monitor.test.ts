import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createLocalStore } from "../src/lib/native/local-store.ts";
import {
  runProviderUpdateCycle,
  shouldRunProviderUpdateMonitorForCommand,
  startProviderUpdateMonitor,
} from "../src/lib/native/provider-update-monitor.ts";

const scratchRoot = join(process.cwd(), ".test-tmp");
mkdirSync(scratchRoot, { recursive: true });
const fixtureRoot = mkdtempSync(join(scratchRoot, "oathlock-provider-update-monitor-"));

test("provider reconciliation is owned by the long-lived native feed, not the separate terminal runtime", () => {
  assert.equal(shouldRunProviderUpdateMonitorForCommand("feed", ["--watch"], true), true);
  assert.equal(shouldRunProviderUpdateMonitorForCommand("feed", ["--watch"], false), false, "a process without the feed writer lock cannot reconcile providers");
  assert.equal(shouldRunProviderUpdateMonitorForCommand("feed", [], true), false);
  assert.equal(shouldRunProviderUpdateMonitorForCommand("terminal", ["runtime"], true), false);
});

function tempStore(prefix: string): string {
  return mkdtempSync(join(fixtureRoot, prefix));
}

test("the monitor records installed providers and retains durable state when one disappears", async () => {
  const root = tempStore("cycle-");
  try {
    const installed = new Map([
      ["claude", "Claude Code 1.2.3"],
      ["codex", "codex-cli 2.0.0"],
    ]);
    const first = await runProviderUpdateCycle({
      root,
      nowMs: () => 100,
      probe: async (binary) => installed.get(binary) ?? null,
      actions: { reconnect: () => ({ healthy: true, detail: "fake live-session observer verified the fixture" }) },
    });
    assert.deepEqual(first.entries.map((entry) => [entry.providerId, entry.status]), [
      ["claude-code", "healthy"],
      ["codex", "healthy"],
    ]);

    installed.delete("codex");
    const second = await runProviderUpdateCycle({
      root,
      nowMs: () => 200,
      probe: async (binary) => installed.get(binary) ?? null,
      actions: { reconnect: () => ({ healthy: true, detail: "fake live-session observer verified the fixture" }) },
    });
    assert.equal(second.entries.find((entry) => entry.providerId === "codex")?.comparison, "unavailable");
    const state = createLocalStore(root).providerUpdateState();
    assert.equal(state.providers.codex?.status, "waiting");
    assert.equal(state.providers.codex?.lastGoodObservation?.version, "2.0.0");
    assert.equal(state.providers.codex?.pendingObservation, null);
    assert.doesNotMatch(readFileSync(join(root, "state.json"), "utf8"), /token|secret|password|bearer/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a provider update is not activated unless a caller supplies verified actions", async () => {
  const root = tempStore("actions-");
  try {
    let version = "Claude Code 1.2.3";
    const probe = async (binary: string) => binary === "claude" ? version : null;
    await runProviderUpdateCycle({
      root,
      nowMs: () => 100,
      probe,
      actions: { reconnect: () => ({ healthy: true, detail: "fake live-session observer verified the fixture" }) },
    });

    version = "Claude Code 1.3.0";
    const held = await runProviderUpdateCycle({ root, nowMs: () => 200, probe });
    assert.equal(held.entries[0]?.status, "waiting");
    assert.equal(createLocalStore(root).providerUpdateState().providers["claude-code"]?.lastGoodObservation?.version, "1.2.3");

    const events: string[] = [];
    const applied = await runProviderUpdateCycle({
      root,
      nowMs: () => 300,
      probe,
      actions: {
        refreshAdapter: () => { events.push("refresh"); },
        reconnect: () => { events.push("reconnect"); return { healthy: true }; },
      },
    });
    assert.equal(applied.entries[0]?.status, "healthy");
    assert.deepEqual(events, ["refresh", "reconnect"]);
    assert.equal(createLocalStore(root).providerUpdateState().providers["claude-code"]?.lastGoodObservation?.version, "1.3.0");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resident startup refreshes M9R-owned config once when provider versions are unchanged", async () => {
  const root = tempStore("startup-reconcile-");
  const probe = async (binary: string) => binary === "opencode" ? "OpenCode 1.2.3" : null;
  const initialActions = {
    refreshAdapter: () => {},
    reconnect: () => ({ healthy: true }),
  };
  let monitor: ReturnType<typeof startProviderUpdateMonitor> | null = null;
  try {
    await runProviderUpdateCycle({ root, nowMs: () => 100, probe, actions: initialActions });

    const events: string[] = [];
    monitor = startProviderUpdateMonitor({
      root,
      nowMs: () => 200,
      probe,
      reconcileOnStart: true,
      intervalMs: 60_000,
      actions: {
        refreshAdapter: ({ providerId }) => { events.push(`refresh:${providerId}`); },
        reconnect: () => { events.push("reconnect"); return { healthy: true }; },
      },
    });

    await monitor.runOnce();
    assert.deepEqual(events, ["refresh:opencode", "reconnect"], "startup refreshes M9R config and verifies/rebinds the live provider session without restarting it");
    await monitor.runOnce();
    assert.deepEqual(events, ["refresh:opencode", "reconnect", "reconnect"], "each cycle rechecks the session without rewriting configuration");
  } finally {
    await monitor?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup reconciliation retries only a provider that was unavailable on the first cycle", async () => {
  const root = tempStore("startup-reconcile-retry-");
  let available = false;
  const probe = async (binary: string) => binary === "opencode" && available ? "OpenCode 1.2.3" : null;
  const events: string[] = [];
  let monitor: ReturnType<typeof startProviderUpdateMonitor> | null = null;
  try {
    await runProviderUpdateCycle({
      root,
      nowMs: () => 100,
      probe: async (binary) => binary === "opencode" ? "OpenCode 1.2.3" : null,
      actions: { refreshAdapter: () => {}, reconnect: () => ({ healthy: true }) },
    });

    monitor = startProviderUpdateMonitor({
      root,
      nowMs: () => 200,
      probe,
      reconcileOnStart: true,
      intervalMs: 60_000,
      actions: {
        refreshAdapter: ({ providerId }) => { events.push(`refresh:${providerId}`); },
        reconnect: () => { events.push("reconnect"); return { healthy: true }; },
      },
    });

    const first = await monitor.runOnce();
    assert.equal(first.entries[0]?.comparison, "unavailable");
    assert.deepEqual(events, [], "an unavailable provider is retained, not guessed or rebound");

    available = true;
    const recovered = await monitor.runOnce();
    assert.equal(recovered.entries[0]?.status, "healthy");
    assert.deepEqual(events, ["refresh:opencode", "reconnect"], "returning provider gets config convergence and exact live-session rebind without session restart");

    await monitor.runOnce();
    assert.deepEqual(events, ["refresh:opencode", "reconnect", "reconnect"], "subsequent cycles recheck session health without rewriting configuration");
  } finally {
    await monitor?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a detector failure leaves the previous provider state untouched", async () => {
  const root = tempStore("detector-failure-");
  try {
    await runProviderUpdateCycle({
      root,
      nowMs: () => 100,
      probe: async (binary) => binary === "claude" ? "Claude Code 1.2.3" : null,
      actions: { reconnect: () => ({ healthy: true, detail: "fake live-session observer verified the fixture" }) },
    });
    await assert.rejects(
      runProviderUpdateCycle({ root, nowMs: () => 200, probe: async () => { throw new Error("probe unavailable"); } }),
      /probe unavailable/,
    );
    const state = createLocalStore(root).providerUpdateState();
    assert.equal(state.providers["claude-code"]?.status, "healthy");
    assert.equal(state.providers["claude-code"]?.lastGoodObservation?.version, "1.2.3");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
