import assert from "node:assert/strict";
import test from "node:test";

import {
  compareProviderVersions,
  classifyProviderRuntime,
  detectProviderRuntimeObservations,
  normalizeProviderRuntimeObservation,
  observationFromDetectedAgent,
  planProviderReconciliation,
  type ProviderRuntimeObservation,
} from "../src/lib/native/provider-update-compatibility-core.ts";

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

test("normalizes arbitrary provider version lines without depending on a provider name", () => {
  const result = normalizeProviderRuntimeObservation({
    providerId: "future-agent",
    binary: "future-agent",
    versionLine: "Future Agent v7.4.1-beta.2 (build 99)",
    transport: "cli-mcp",
    observedAtMs: 100,
  });

  assert.equal(result.providerId, "future-agent");
  assert.equal(result.version, "7.4.1-beta.2");
  assert.equal(result.executablePath, null);
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
});

test("fingerprints are stable across observation time but change when provider identity changes", () => {
  const first = observation({ observedAtMs: 100 });
  const sameLater = observation({ observedAtMs: 200 });
  const changed = observation({ versionLine: "Claude Code 1.2.4", observedAtMs: 200 });

  assert.equal(first.fingerprint, sameLater.fingerprint);
  assert.notEqual(first.fingerprint, changed.fingerprint);
  assert.equal(classifyProviderRuntime(first, sameLater).kind, "unchanged");
  assert.equal(classifyProviderRuntime(first, changed).kind, "provider_updated");
});

test("classification distinguishes provider updates, downgrades, adapter changes, configuration changes, and replacements", () => {
  const current = observation();

  assert.equal(classifyProviderRuntime(current, observation({ versionLine: "Claude Code 1.3.0" })).kind, "provider_updated");
  assert.equal(classifyProviderRuntime(current, observation({ versionLine: "Claude Code 1.1.9" })).kind, "provider_downgraded");
  assert.equal(classifyProviderRuntime(current, observation({ adapterContractVersion: "m9r.adapter-contract.v2" })).kind, "adapter_changed");
  assert.equal(classifyProviderRuntime(current, observation({ configFingerprint: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" })).kind, "configuration_changed");
  assert.equal(classifyProviderRuntime(current, observation({ executablePath: "D:/tools/claude.exe" })).kind, "installation_replaced");
});

test("first observation and unavailable provider are explicit lifecycle states", () => {
  const current = observation();
  assert.equal(classifyProviderRuntime(undefined, current).kind, "first_seen");
  assert.equal(classifyProviderRuntime(current, null).kind, "unavailable");
});

test("reconciliation plans never require a manual reconnect and preserve the existing CLI/MCP path", () => {
  const current = observation();
  const update = classifyProviderRuntime(current, observation({ versionLine: "Claude Code 1.3.0" }));
  const plan = planProviderReconciliation(update);

  assert.equal(plan.action, "refresh_adapter_and_reconnect");
  assert.equal(plan.userActionRequired, false);
  assert.equal(plan.preserveDurableTaskState, true);
  assert.equal(plan.preserveExistingCliMcpPath, true);
  assert.equal(plan.waitForHealthyReplacementBeforeRetiring, true);
});

test("replacement, downgrade, and unavailable states are conservative without discarding work", () => {
  const current = observation();

  for (const comparison of [
    classifyProviderRuntime(current, observation({ executablePath: "D:/tools/claude.exe" })),
    classifyProviderRuntime(current, observation({ versionLine: "Claude Code 1.1.0" })),
    classifyProviderRuntime(current, null),
  ]) {
    const plan = planProviderReconciliation(comparison);
    assert.equal(plan.preserveDurableTaskState, true);
    assert.equal(plan.preserveExistingCliMcpPath, true);
    assert.equal(plan.waitForHealthyReplacementBeforeRetiring, true);
  }
});

test("detected-agent observations remain generic for future provider slugs", () => {
  const result = observationFromDetectedAgent({
    kind: "future-agent",
    binary: "future-agent",
    versionLine: "future-agent 3.0.0",
  }, 123);

  assert.equal(result.providerId, "future-agent");
  assert.equal(result.version, "3.0.0");
  assert.equal(result.observedAtMs, 123);
});

test("the compatibility bridge consumes the existing side-effect-free probes without changing their result shape", async () => {
  const observed = await detectProviderRuntimeObservations(async (binary) => {
    if (binary === "codex") return "codex-cli 0.42.0";
    if (binary === "opencode") return "OpenCode 2.1.1";
    return null;
  }, 456);

  assert.deepEqual(observed.map((item) => item.providerId), ["codex", "opencode"]);
  assert.deepEqual(observed.map((item) => item.version), ["0.42.0", "2.1.1"]);
  assert.ok(observed.every((item) => item.transport === "cli-mcp" && item.observedAtMs === 456));
  assert.ok(observed.every((item) => item.adapterContractVersion === "m9r.adapter-contract.v1"));
  assert.ok(observed.every((item) => item.capabilityManifestVersion === "m9r.provider-capabilities.v1"));
});

test("provider version comparison is semver-aware, including prereleases", () => {
  assert.equal(compareProviderVersions("1.0.0", "1.0.1"), -1);
  assert.equal(compareProviderVersions("2.0.0", "1.99.99"), 1);
  assert.equal(compareProviderVersions("1.0.0-beta.2", "1.0.0-beta.10"), -1);
  assert.equal(compareProviderVersions("1.0.0", "1.0.0-beta.10"), 1);
  assert.equal(compareProviderVersions(null, "1.0.0"), null);
});

test("invalid observation identity is rejected instead of creating an unsafe compatibility record", () => {
  assert.throws(() => normalizeProviderRuntimeObservation({
    providerId: "../../other-provider",
    binary: "claude",
    versionLine: "1.0.0",
    observedAtMs: 100,
  }), /providerId/i);

  assert.throws(() => normalizeProviderRuntimeObservation({
    providerId: "claude-code",
    binary: "claude",
    versionLine: "1.0.0",
    configFingerprint: "raw-secret-or-config-value",
    observedAtMs: 100,
  }), /configFingerprint/i);
});
