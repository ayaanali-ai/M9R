import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { refreshManagedOpenCodeIdentityPlugin } from "../src/lib/native/opencode-plugin-refresh.ts";

const manifestPath = "C:/Users/Ada/.m9r/web-setup-manifest.json";
const pluginPath = "C:/Users/Ada/.config/opencode/plugins/m9r-identity.js";
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

function setup() {
  const oldPlugin = Buffer.from("old M9R-owned plugin");
  const manifest = {
    version: 1,
    openCodeIdentityPluginPath: pluginPath,
    openCodeIdentityPluginHash: sha256(oldPlugin),
    extensionPath: "C:/Users/Ada/AppData/Local/M9R/extension",
    extensionFiles: [{ path: "C:/Users/Ada/AppData/Local/M9R/extension/manifest.json", hash: "keep" }],
    brokerConfigHash: "keep-too",
  };
  const files = new Map<string, Buffer>([
    [pluginPath, oldPlugin],
    [manifestPath, Buffer.from(JSON.stringify(manifest))],
  ]);
  const writes: string[] = [];
  let failManifestWrite = false;
  return {
    files,
    writes,
    manifest,
    dependencies: {
      async readFile(path: string) { return files.get(path) ?? null; },
      async writeAtomic(path: string, bytes: Buffer) {
        writes.push(path);
        if (failManifestWrite && path === manifestPath) throw new Error("simulated manifest write failure");
        files.set(path, Buffer.from(bytes));
      },
      async removeFile(path: string) { files.delete(path); },
      failManifestWrite() { failManifestWrite = true; },
    },
  };
}

test("managed OpenCode plugin refresh dry-run changes no files", async () => {
  const state = setup();
  const result = await refreshManagedOpenCodeIdentityPlugin({
    manifestPath,
    pluginPath,
    desiredContent: "new plugin",
    dryRun: true,
  }, state.dependencies);

  assert.equal(result.action, "upgrade");
  assert.equal(result.updated, false);
  assert.deepEqual(state.writes, []);
  assert.equal(state.files.get(pluginPath)?.toString(), "old M9R-owned plugin");
});

test("managed OpenCode plugin refresh updates only the owned plugin and its manifest hash", async () => {
  const state = setup();
  const result = await refreshManagedOpenCodeIdentityPlugin({ manifestPath, pluginPath, desiredContent: "new plugin" }, state.dependencies);

  assert.deepEqual(result, { action: "upgrade", updated: true });
  assert.deepEqual(state.writes, [pluginPath, manifestPath]);
  assert.equal(state.files.get(pluginPath)?.toString(), "new plugin");
  const updated = JSON.parse(state.files.get(manifestPath)!.toString("utf8"));
  assert.equal(updated.openCodeIdentityPluginHash, sha256("new plugin"));
  assert.equal(updated.extensionPath, state.manifest.extensionPath);
  assert.deepEqual(updated.extensionFiles, state.manifest.extensionFiles);
  assert.equal(updated.brokerConfigHash, state.manifest.brokerConfigHash);
});

test("managed OpenCode plugin refresh preserves a user-edited or unowned plugin", async () => {
  const state = setup();
  state.files.set(pluginPath, Buffer.from("owner edit"));
  const result = await refreshManagedOpenCodeIdentityPlugin({ manifestPath, pluginPath, desiredContent: "new plugin" }, state.dependencies);

  assert.deepEqual(result, { action: "preserve", updated: false });
  assert.deepEqual(state.writes, []);
  assert.equal(state.files.get(pluginPath)?.toString(), "owner edit");
});

test("managed OpenCode plugin refresh rolls back the plugin if the manifest commit fails", async () => {
  const state = setup();
  state.dependencies.failManifestWrite();

  await assert.rejects(
    refreshManagedOpenCodeIdentityPlugin({ manifestPath, pluginPath, desiredContent: "new plugin" }, state.dependencies),
    /simulated manifest write failure/,
  );
  assert.equal(state.files.get(pluginPath)?.toString(), "old M9R-owned plugin");
  assert.equal(JSON.parse(state.files.get(manifestPath)!.toString("utf8")).openCodeIdentityPluginHash, sha256("old M9R-owned plugin"));
});

test("canonical native install manifest ownership is refreshed without consulting a stale web manifest", async () => {
  const nativeManifestPath = "C:/Users/Ada/.m9r/install-manifest.json";
  const oldPlugin = Buffer.from("old native M9R-owned plugin");
  const nativeManifest = {
    version: 1,
    entries: [
      { path: pluginPath, kind: "opencode-plugin", sha256After: sha256(oldPlugin), backupPath: null },
      { path: "C:/Users/Ada/.codex/hooks.json", kind: "hooks-json", sha256After: "keep" },
    ],
    activeRuntime: { buildId: "current" },
  };
  const files = new Map<string, Buffer>([
    [pluginPath, oldPlugin],
    [nativeManifestPath, Buffer.from(JSON.stringify(nativeManifest))],
  ]);
  const writes: string[] = [];
  const result = await refreshManagedOpenCodeIdentityPlugin({
    manifestPath: nativeManifestPath,
    pluginPath,
    desiredContent: "new native plugin",
  }, {
    async readFile(path) { return files.get(path) ?? null; },
    async writeAtomic(path, bytes) { writes.push(path); files.set(path, Buffer.from(bytes)); },
    async removeFile(path) { files.delete(path); },
  });

  assert.deepEqual(result, { action: "upgrade", updated: true });
  assert.deepEqual(writes, [pluginPath, nativeManifestPath]);
  const updated = JSON.parse(files.get(nativeManifestPath)!.toString("utf8"));
  assert.equal(updated.entries[0].sha256After, sha256("new native plugin"));
  assert.equal(updated.entries[1].sha256After, "keep");
});
