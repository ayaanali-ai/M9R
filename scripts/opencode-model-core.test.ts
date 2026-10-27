import assert from "node:assert/strict";
import test from "node:test";
import { chooseOpenCodeModel, planOpenCodeModelStateRepair } from "../src/lib/native/opencode-model-core.ts";

const catalog = {
  data: {
    providers: [{
      id: "opencode",
      default: "beam-free",
      models: {
        "muse-spark-1.3-contributor-free": { status: "deprecated" },
        "beam-free": { status: "active" },
        "deepseek-v4.1-flash-free": { status: "active" },
      },
    }],
  },
};

const cachedCatalog = {
  opencode: {
    id: "opencode",
    models: {
      "muse-spark-1.3-contributor-free": { status: "deprecated" },
      "beam-free": { status: "active" },
    },
  },
};

test("OpenCode chooses the live provider default instead of a deprecated model", () => {
  assert.deepEqual(chooseOpenCodeModel(catalog), { providerID: "opencode", modelID: "beam-free" });
});

test("OpenCode accepts the provider-keyed cache catalog used by the installed runtime", () => {
  assert.deepEqual(chooseOpenCodeModel(cachedCatalog), { providerID: "opencode", modelID: "beam-free" });
});

test("OpenCode cache-shaped repair removes the deprecated model and keeps a usable replacement", () => {
  const result = planOpenCodeModelStateRepair({
    recent: [{ providerID: "opencode", modelID: "muse-spark-1.3-contributor-free" }],
  }, cachedCatalog);
  assert.equal(result.status, "updated");
  assert.deepEqual(result.selection, { providerID: "opencode", modelID: "beam-free" });
  assert.deepEqual(result.removedModelIDs, ["muse-spark-1.3-contributor-free"]);
  assert.deepEqual(result.state?.recent, [{ providerID: "opencode", modelID: "beam-free" }]);
});

test("OpenCode model-state repair removes only invalid references for the affected provider", () => {
  const result = planOpenCodeModelStateRepair({
    recent: [
      { providerID: "opencode", modelID: "muse-spark-1.3-contributor-free" },
      { providerID: "opencode", modelID: "union-alpha" },
      { providerID: "openai", modelID: "gpt-5.3-codex" },
    ],
    favorite: [{ providerID: "opencode", modelID: "muse-spark-1.3-contributor-free" }],
    variant: {
      "opencode/muse-spark-1.3-contributor-free": "default",
      "openai/gpt-5.3-codex": "default",
    },
    unrelated: "preserved",
  }, catalog);

  assert.equal(result.status, "updated");
  assert.deepEqual(result.selection, { providerID: "opencode", modelID: "beam-free" });
  assert.deepEqual(result.removedModelIDs.sort(), ["muse-spark-1.3-contributor-free", "union-alpha"].sort());
  assert.deepEqual(result.state?.recent, [{ providerID: "opencode", modelID: "beam-free" }, { providerID: "openai", modelID: "gpt-5.3-codex" }]);
  assert.deepEqual(result.state?.favorite, []);
  assert.deepEqual(result.state?.variant, { "openai/gpt-5.3-codex": "default" });
  assert.equal(result.state?.unrelated, "preserved");
});

test("OpenCode model-state repair fails closed when the live catalog is unavailable", () => {
  const state = { recent: [{ providerID: "opencode", modelID: "muse-spark-1.3-contributor-free" }] };
  const result = planOpenCodeModelStateRepair(state, null);
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.removedModelIDs, []);
  assert.equal(result.state, undefined);
});
