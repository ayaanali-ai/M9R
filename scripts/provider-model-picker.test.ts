import assert from "node:assert/strict";
import test from "node:test";
import {
  providerModelUiState,
} from "../src/lib/native/provider-model-picker";
import {
  validateProviderModelCatalog,
  validateProviderModelSelection,
} from "../src/lib/native/provider-model-core";
import type { ManagedProviderConnectionSnapshot } from "../src/lib/native/managed-provider-contract";

const snapshot = (overrides: Partial<ManagedProviderConnectionSnapshot> = {}): ManagedProviderConnectionSnapshot => ({
  connectionId: "m9r:claude:picker",
  handle: "claude",
  provider: "claude",
  cwd: "c:/runleak/runleak",
  status: "ready",
  generation: 3,
  ...overrides,
});

test("model catalogs keep provider-reported efforts and reject duplicates", () => {
  const catalog = validateProviderModelCatalog([
    { id: "claude-sonnet", label: "Claude Sonnet", efforts: [{ id: "high", label: "High" }] },
  ]);
  assert.deepEqual(catalog, [{ id: "claude-sonnet", label: "Claude Sonnet", efforts: [{ id: "high", label: "High" }] }]);
  assert.equal(validateProviderModelCatalog([{ id: "same", label: "One" }, { id: "same", label: "Two" }]), null);
});

test("selection accepts only the exact live model and effort catalog", () => {
  const capabilities = {
    models: [{ id: "claude-sonnet", label: "Claude Sonnet", efforts: [{ id: "high", label: "High" }] }],
    currentModel: null,
  } as const;
  assert.deepEqual(validateProviderModelSelection(capabilities, { model: "claude-sonnet", effort: "high" }), {
    ok: true,
    selection: { model: "claude-sonnet", effort: "high" },
  });
  assert.equal(validateProviderModelSelection(capabilities, { model: "invented-model" }).ok, false);
  assert.equal(validateProviderModelSelection({ models: null, currentModel: null }, { model: "claude-sonnet" }).ok, false);
});

test("UI projection reports live, disconnected, and unavailable catalogs without guessing", () => {
  const state = providerModelUiState([
    {
      connectionId: "m9r:claude:picker",
      provider: "claude",
      generation: 3,
      models: [{ id: "claude-sonnet", label: "Claude Sonnet", efforts: null }],
      currentModel: "claude-sonnet",
      currentEffort: null,
    },
    {
      connectionId: "m9r:codex:picker",
      provider: "codex",
      generation: 4,
      models: null,
      currentModel: null,
      currentEffort: null,
    },
  ], [
    snapshot(),
    snapshot({ connectionId: "m9r:codex:picker", handle: "codex", provider: "codex", status: "failed", generation: 4 }),
  ]);
  assert.equal(state.agents[0].availability, "available");
  assert.equal(state.agents[1].availability, "not_connected");
  assert.deepEqual(state.agents[1].models, []);
});
