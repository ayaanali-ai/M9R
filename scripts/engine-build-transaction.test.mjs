import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { publishGeneratedDirectory, publishRuntimeBuild, writeRuntimeBuildManifest } from "./engine-build-transaction.mjs";

test("runtime build manifest hashes every packaged file and publishes the verified set", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-engine-publish-"));
  const staged = join(root, "staged");
  const output = join(root, "dist");
  try {
    mkdirSync(join(staged, "cua-driver-runtime", "bin"), { recursive: true });
    mkdirSync(output, { recursive: true });
    writeFileSync(join(staged, "m9r-engine.exe"), "engine-new");
    writeFileSync(join(staged, "cua-driver-runtime", "bin", "cua-driver.exe"), "driver-new");
    writeFileSync(join(output, "preserved.txt"), "user artifact");
    writeFileSync(join(output, "m9r-engine.exe"), "engine-old");

    const manifest = writeRuntimeBuildManifest(staged, "2026-10-10T00:00:00.000Z");
    const published = publishRuntimeBuild(staged, output, ["m9r-engine.exe", "cua-driver-runtime"]);

    assert.equal(readFileSync(join(output, "m9r-engine.exe"), "utf8"), "engine-new");
    assert.equal(readFileSync(join(output, "cua-driver-runtime", "bin", "cua-driver.exe"), "utf8"), "driver-new");
    assert.equal(readFileSync(join(output, "preserved.txt"), "utf8"), "user artifact");
    assert.equal(readFileSync(join(output, "m9r-build-info.json"), "utf8"), JSON.stringify(manifest, null, 2) + "\n");
    assert.equal(published.buildId, manifest.buildId);
    assert.equal(manifest.artifacts["m9r-engine.exe"], createHash("sha256").update("engine-new").digest("hex"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a failed runtime publish restores the previous artifact set", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-engine-publish-rollback-"));
  const staged = join(root, "staged");
  const output = join(root, "dist");
  try {
    mkdirSync(staged, { recursive: true });
    mkdirSync(output, { recursive: true });
    writeFileSync(join(staged, "first.exe"), "new");
    mkdirSync(join(staged, "nested"), { recursive: true });
    writeFileSync(join(staged, "nested", "child.exe"), "new nested");
    writeRuntimeBuildManifest(staged, "2026-10-10T00:00:00.000Z");
    writeFileSync(join(output, "first.exe"), "old");
    writeFileSync(join(output, "nested"), "preserve me");

    assert.throws(
      () => publishRuntimeBuild(staged, output, ["first.exe", "nested/child.exe"]),
      /publish failed/i,
    );
    assert.equal(readFileSync(join(output, "first.exe"), "utf8"), "old");
    assert.equal(readFileSync(join(output, "nested"), "utf8"), "preserve me");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("generated CLI output is staged before replacing the previous distribution", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-cli-publish-"));
  const staged = join(root, ".dist-stage-test");
  const output = join(root, "dist");
  try {
    mkdirSync(staged, { recursive: true });
    mkdirSync(output, { recursive: true });
    writeFileSync(join(staged, "m9r.js"), "new CLI");
    writeFileSync(join(output, "m9r.js"), "old CLI");
    writeFileSync(join(output, "stale.js"), "old generated module");

    publishGeneratedDirectory(staged, output);
    assert.equal(readFileSync(join(output, "m9r.js"), "utf8"), "new CLI");
    assert.equal(existsSync(join(output, "stale.js")), false);
    assert.equal(existsSync(staged), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
