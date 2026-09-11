/**
 * ProviderAdapterRegistry — Phase 3A tests
 *
 * Covers: unknown adapter lookup, unsupported capabilities rejected BEFORE
 * launch (never discovered by trying and failing at launch time), and a
 * fully-satisfied capability requirement succeeding.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { ProviderAdapterRegistry } from "../src/lib/mission/mission-provider-registry.ts";
import { FakeProviderAdapter } from "../src/lib/mission/mission-provider-adapter.ts";

test("assertCapabilities refuses an unknown adapter id", async () => {
  const registry = new ProviderAdapterRegistry();
  const result = await registry.assertCapabilities("does-not-exist", { workspaceId: "ws-1" }, ["non_interactive_execution"]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "unknown_adapter");
});

test("assertCapabilities rejects, before launch, when a required capability is not supported", async () => {
  const registry = new ProviderAdapterRegistry();
  registry.register(new FakeProviderAdapter("fake-1", { non_interactive_execution: true }));

  const result = await registry.assertCapabilities("fake-1", { workspaceId: "ws-1" }, ["non_interactive_execution", "session_resume"]);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "unsupported_capability");
    assert.deepEqual(result.error.missing, ["session_resume"]);
  }
});

test("assertCapabilities succeeds when every required capability is declared true", async () => {
  const registry = new ProviderAdapterRegistry();
  registry.register(new FakeProviderAdapter("fake-1", { non_interactive_execution: true, cancellation: true }));

  const result = await registry.assertCapabilities("fake-1", { workspaceId: "ws-1" }, ["non_interactive_execution", "cancellation"]);
  assert.equal(result.ok, true);
});

test("get/list expose registered adapters", () => {
  const registry = new ProviderAdapterRegistry();
  const adapter = new FakeProviderAdapter("fake-1");
  registry.register(adapter);

  assert.equal(registry.get("fake-1"), adapter);
  assert.equal(registry.get("missing"), null);
  assert.deepEqual(registry.list(), [adapter]);
});
