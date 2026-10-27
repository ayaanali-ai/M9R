import assert from "node:assert/strict";
import test from "node:test";

import { createProviderNeutralUpdateActions } from "../src/lib/native/provider-update-route-actions.ts";

test("provider updates verify the M9R route then reconnect a provider session without touching credentials", async () => {
  let refreshed = false;
  let callbackProvider = "";
  let callbackRoute = "";
  let reconnected = false;
  const actions = createProviderNeutralUpdateActions({
    execPath: process.execPath,
    platform: process.platform,
    refreshProviderConfig: (input) => {
      refreshed = true;
      callbackProvider = input.providerId;
      callbackRoute = input.route;
    },
    reconcileProviderSession: async (input) => {
      reconnected = true;
      assert.equal(input.providerId, "claude-code");
      return { healthy: true, detail: "one live Claude session rebound" };
    },
  });
  await actions.refreshAdapter?.({
    providerId: "claude-code",
    previous: null,
    current: {
      schema: "m9r.provider-update-compat.v1",
      providerId: "claude-code",
      binary: "claude",
      versionLine: "Claude Code 1.2.3",
      version: "1.2.3",
      executablePath: null,
      transport: "cli-mcp",
      adapterContractVersion: null,
      capabilityManifestVersion: null,
      configFingerprint: null,
      observedAtMs: 100,
      fingerprint: "a".repeat(64),
    },
    comparison: {
      kind: "provider_updated",
      reasons: ["provider_version"],
      previousFingerprint: "b".repeat(64),
      currentFingerprint: "a".repeat(64),
      previousVersion: "1.1.0",
      currentVersion: "1.2.3",
    },
    plan: {
      action: "refresh_adapter_and_reconnect",
      userActionRequired: false,
      preserveDurableTaskState: true,
      preserveExistingCliMcpPath: true,
      waitForHealthyReplacementBeforeRetiring: true,
      reason: "test",
    },
  });
  assert.equal(refreshed, true);
  assert.equal(callbackProvider, "claude-code");
  assert.equal(callbackRoute, process.execPath);
  const health = await actions.reconnect?.({ providerId: "claude-code", previous: null, current: {} as never });
  assert.equal(health?.healthy, true);
  assert.equal(reconnected, true);
  assert.match(health?.detail ?? "", /live Claude session rebound/);
});

test("a valid M9R route alone is not reported as a reconnected provider session", async () => {
  const actions = createProviderNeutralUpdateActions({ execPath: process.execPath, platform: process.platform });
  const health = await actions.reconnect?.({ providerId: "codex", previous: null, current: {} as never });
  assert.equal(health?.healthy, false);
  assert.match(health?.detail ?? "", /session.*reconcil|live provider session/i);
});

test("a missing route fails closed before attempting provider-session reconciliation", async () => {
  let reconciled = false;
  const actions = createProviderNeutralUpdateActions({
    execPath: "C:/missing/m9r-mcp.exe",
    platform: "win32",
    reconcileProviderSession: async () => { reconciled = true; return { healthy: true }; },
  });
  const health = await actions.reconnect?.({ providerId: "codex", previous: null, current: {} as never });
  assert.equal(health?.healthy, false);
  assert.match(health?.detail ?? "", /missing/i);
  assert.equal(reconciled, false);
});
