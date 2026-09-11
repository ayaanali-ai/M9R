import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ADAPTER_CONTRACT_VERSION,
  CAPABILITY_MANIFEST_VERSION,
  KNOWN_ADAPTER_ACTIONS,
  adapterContractManifest,
  negotiateAdapterActions,
} from "@/lib/adapter-contract";

test("the manifest is versioned and lists the known actions", () => {
  const manifest = adapterContractManifest();
  assert.equal(manifest.protocolVersion, ADAPTER_CONTRACT_VERSION);
  assert.deepEqual(manifest.actions, KNOWN_ADAPTER_ACTIONS);
  assert.ok(manifest.actions.length > 0);
});

test("the manifest publishes per-provider capability truth without implying live verification", () => {
  const manifest = adapterContractManifest();
  assert.equal(manifest.capabilityManifestVersion, CAPABILITY_MANIFEST_VERSION);
  assert.deepEqual(
    manifest.providers.map((provider) => provider.id),
    ["codex", "claude-code", "grok-build", "other"],
  );

  for (const provider of manifest.providers) {
    assert.equal(provider.executionMode, "linked");
    assert.equal(provider.transport, "generic_cli");
    assert.equal(provider.liveLifecycleVerified, false);
    assert.equal(provider.residentExecutionSupported, false);
    assert.ok(provider.supportedActions.every((action) => KNOWN_ADAPTER_ACTIONS.some((known) => known.id === action)));
    assert.ok(provider.limitations.length > 0);
  }
  assert.equal(manifest.providers.find((provider) => provider.id === "codex")?.crossRuntimeExchangeVerified, true);
  assert.equal(manifest.providers.find((provider) => provider.id === "claude-code")?.crossRuntimeExchangeVerified, true);
  assert.equal(manifest.providers.find((provider) => provider.id === "grok-build")?.crossRuntimeExchangeVerified, false);
});

test("provider capability entries distinguish implemented protocol support from verification", () => {
  const codex = adapterContractManifest().providers.find((provider) => provider.id === "codex");
  assert.ok(codex);
  assert.ok(codex.supportedActions.includes("heartbeat"));
  assert.ok(codex.supportedActions.includes("work_signal_emit"));
  assert.equal(codex.verificationStatus, "protocol_exchange_verified");
  assert.match(codex.executionDisclosure, /outside M9R/i);
});

test("negotiation only reports actions present in the known contract as supported", () => {
  const { supported, unsupported } = negotiateAdapterActions(["work_signal_emit", "not_a_real_action", "rules_read"]);
  assert.deepEqual(supported.sort(), ["rules_read", "work_signal_emit"]);
  assert.deepEqual(unsupported, ["not_a_real_action"]);
});

test("negotiation deduplicates and ignores non-string entries", () => {
  const { supported } = negotiateAdapterActions(["rules_read", "rules_read", 42, null, {}]);
  assert.deepEqual(supported, ["rules_read"]);
});

test("negotiation accepts a non-default known contract, e.g. a live-fetched manifest that has dropped an action", () => {
  const olderManifest = KNOWN_ADAPTER_ACTIONS.filter((a) => a.id !== "work_signal_ack");
  const { supported, unsupported } = negotiateAdapterActions(["work_signal_emit", "work_signal_ack"], olderManifest);
  assert.deepEqual(supported, ["work_signal_emit"]);
  assert.deepEqual(unsupported, ["work_signal_ack"]);
});

test("negotiation never lets an adapter grant itself an unrecognized capability", () => {
  const { supported } = negotiateAdapterActions(["delete_workspace", "impersonate_owner"]);
  assert.deepEqual(supported, []);
});

test("the contract route is unauthenticated and serves the manifest", async () => {
  const route = await readFile(new URL("../src/app/api/agent/contract/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(route, /authenticateAgent/);
  assert.match(route, /adapterContractManifest/);
});
