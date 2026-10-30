import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { publishGeneratedDirectory, publishRuntimeBuild, writeRuntimeBuildManifest } from "./engine-build-transaction.mjs";

test("runtime build manifest publishes one exact directory and removes obsolete generated files", () => {
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
    writeRuntimeBuildManifest(output, "2026-10-09T00:00:00.000Z");

    const manifest = writeRuntimeBuildManifest(staged, "2026-10-10T00:00:00.000Z");
    const published = publishRuntimeBuild(staged, output);

    assert.equal(readFileSync(join(output, "m9r-engine.exe"), "utf8"), "engine-new");
    assert.equal(readFileSync(join(output, "cua-driver-runtime", "bin", "cua-driver.exe"), "utf8"), "driver-new");
    assert.equal(existsSync(join(output, "preserved.txt")), false, "old output files do not survive publication");
    assert.equal(readFileSync(join(output, "m9r-build-info.json"), "utf8"), JSON.stringify(manifest, null, 2) + "\n");
    assert.equal(published.buildId, manifest.buildId);
    assert.equal(manifest.artifacts["m9r-engine.exe"], createHash("sha256").update("engine-new").digest("hex"));
    assert.equal(readdirSync(root).some((name) => name.startsWith(".m9r-engine-publish-backup-")), false,
      "successful publication leaves no prior runtime directory behind");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an unverified existing runtime output is preserved and blocks publication", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-engine-publish-rollback-"));
  const staged = join(root, "staged");
  const output = join(root, "dist");
  try {
    mkdirSync(staged, { recursive: true });
    mkdirSync(output, { recursive: true });
    writeFileSync(join(staged, "first.exe"), "new");
    writeRuntimeBuildManifest(staged, "2026-10-10T00:00:00.000Z");
    writeFileSync(join(output, "first.exe"), "old but not covered by a valid output manifest");

    assert.throws(
      () => publishRuntimeBuild(staged, output),
      /Runtime build manifest is missing or unreadable/,
    );
    assert.equal(readFileSync(join(output, "first.exe"), "utf8"), "old but not covered by a valid output manifest");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("verified leftover runtime snapshots are removed when a complete current output exists", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-engine-publish-retry-"));
  const staged = join(root, "staged");
  const output = join(root, "dist");
  const backup = join(root, ".m9r-engine-publish-backup-123-12345678-1234-1234-1234-123456789abc");
  try {
    mkdirSync(staged, { recursive: true });
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "old.exe"), "old runtime");
    writeRuntimeBuildManifest(output, "2026-10-10T00:00:00.000Z");
    cpSync(output, backup, { recursive: true });
    writeFileSync(join(staged, "new.exe"), "new runtime");
    writeRuntimeBuildManifest(staged, "2026-10-11T00:00:00.000Z");

    publishRuntimeBuild(staged, output);
    assert.equal(existsSync(backup), false, "a verified previous snapshot is drained before publication");
    assert.equal(existsSync(join(output, "old.exe")), false);
    assert.equal(existsSync(join(output, "new.exe")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an unverified leftover runtime snapshot is retained and blocks publication", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-engine-publish-unsafe-backup-"));
  const staged = join(root, "staged");
  const output = join(root, "dist");
  const backup = join(root, ".m9r-engine-publish-backup-123-12345678-1234-1234-1234-123456789abc");
  try {
    mkdirSync(staged, { recursive: true });
    mkdirSync(output, { recursive: true });
    mkdirSync(backup, { recursive: true });
    writeFileSync(join(output, "old.exe"), "current runtime");
    writeRuntimeBuildManifest(output, "2026-10-10T00:00:00.000Z");
    writeFileSync(join(backup, "unknown.bin"), "unverified data");
    writeFileSync(join(staged, "new.exe"), "new runtime");
    writeRuntimeBuildManifest(staged, "2026-10-11T00:00:00.000Z");

    assert.throws(() => publishRuntimeBuild(staged, output), /Runtime build manifest is missing or unreadable/);
    assert.equal(existsSync(join(backup, "unknown.bin")), true, "unverified old data is preserved for audit");
    assert.equal(readFileSync(join(output, "old.exe"), "utf8"), "current runtime");
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
    writeFileSync(join(staged, "build-info.json"), "{}");
    writeFileSync(join(output, "m9r.js"), "old CLI");
    writeFileSync(join(output, "stale.js"), "old generated module");
    writeFileSync(join(output, "build-info.json"), "{}");

    publishGeneratedDirectory(staged, output);
    assert.equal(readFileSync(join(output, "m9r.js"), "utf8"), "new CLI");
    assert.equal(existsSync(join(output, "stale.js")), false);
    assert.equal(existsSync(staged), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("verified leftover CLI output snapshots are drained before the next publication", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-cli-publish-retry-"));
  const staged = join(root, ".dist-stage-test");
  const output = join(root, "dist");
  const backup = join(root, ".m9r-generated-backup-123-12345678-1234-1234-1234-123456789abc");
  try {
    mkdirSync(staged, { recursive: true });
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "m9r.js"), "current CLI");
    writeFileSync(join(output, "stale.js"), "old generated module");
    writeFileSync(join(output, "build-info.json"), "{}");
    cpSync(output, backup, { recursive: true });
    writeFileSync(join(staged, "m9r.js"), "new CLI");
    writeFileSync(join(staged, "build-info.json"), "{}");

    publishGeneratedDirectory(staged, output);
    assert.equal(existsSync(backup), false, "a verified prior CLI snapshot is deleted after publication");
    assert.equal(existsSync(join(output, "stale.js")), false);
    assert.equal(readFileSync(join(output, "m9r.js"), "utf8"), "new CLI");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
