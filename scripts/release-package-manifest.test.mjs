import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createReleasePackageManifest,
  verifyReleasePackageManifest,
} from "./release-package-manifest.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function writeStage({ sourceDirty = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "m9r-release-manifest-"));
  const engine = Buffer.from("engine-artifact");
  mkdirSync(join(root, "extension"), { recursive: true });
  mkdirSync(join(root, "licenses"), { recursive: true });
  writeFileSync(join(root, "m9r-engine.exe"), engine);
  writeFileSync(join(root, "INSTALLATION.txt"), "M9R package\n");
  writeFileSync(join(root, "extension", "manifest.json"), "{}\n");
  writeFileSync(join(root, "licenses", "MIT.txt"), "license\n");
  const artifacts = { "m9r-engine.exe": sha256(engine) };
  writeFileSync(join(root, "m9r-build-info.json"), `${JSON.stringify({
    schemaVersion: 1,
    buildId: sha256(JSON.stringify(Object.entries(artifacts))),
    builtAt: "2026-10-24T00:00:00.000Z",
    artifacts,
    source: { sourceCommit: "a".repeat(40), sourceDirty },
  }, null, 2)}\n`);
  return root;
}

test("release package manifest records and verifies the exact staged file set", () => {
  const root = writeStage();
  try {
    const created = createReleasePackageManifest(root, { requireCleanSource: true });
    assert.equal(created.schemaVersion, 1);
    assert.equal(created.source.sourceDirty, false);
    assert.equal(verifyReleasePackageManifest(root, { requireCleanSource: true }).runtimeBuildId, created.runtimeBuildId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release verification rejects a stale file added after manifest creation", () => {
  const root = writeStage();
  try {
    createReleasePackageManifest(root);
    writeFileSync(join(root, "stale-runtime-copy.exe"), "stale\n");
    assert.throws(() => verifyReleasePackageManifest(root), /exact package file set/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release verification rejects runtime identity drift", () => {
  const root = writeStage();
  try {
    createReleasePackageManifest(root);
    const runtimePath = join(root, "m9r-build-info.json");
    const runtime = JSON.parse(readFileSync(runtimePath, "utf8"));
    runtime.source.sourceCommit = "b".repeat(40);
    writeFileSync(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`);
    assert.throws(() => verifyReleasePackageManifest(root), /source provenance/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clean release mode rejects a dirty runtime source identity", () => {
  const root = writeStage({ sourceDirty: true });
  try {
    assert.throws(() => createReleasePackageManifest(root, { requireCleanSource: true }), /dirty source/i);
    const manifest = createReleasePackageManifest(root);
    assert.equal(manifest.source.sourceDirty, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
