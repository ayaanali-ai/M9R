import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntimeBuildInfo, readRuntimeBuildIdentity } from "../src/lib/native/runtime-build-identity";
import { writeRuntimeBuildManifest } from "./engine-build-transaction.mjs";

test("runtime identity verifies the running executable against the adjacent build manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-runtime-identity-"));
  try {
    const executable = join(root, "m9r-engine.exe");
    const image = Buffer.from("current engine image");
    writeFileSync(executable, image);
    const digest = createHash("sha256").update(image).digest("hex");
    writeFileSync(join(root, "m9r-build-info.json"), JSON.stringify(createRuntimeBuildInfo({ "m9r-engine.exe": digest })));

    const identity = readRuntimeBuildIdentity(executable);
    assert.equal(identity.status, "verified");
    assert.equal(identity.artifact, "m9r-engine.exe");
    assert.equal(identity.actualSha256, digest);
    assert.match(identity.buildId ?? "", /^[a-f0-9]{64}$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runtime identity detects a stale or replaced executable without declaring the broker healthy", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-runtime-mismatch-"));
  try {
    const executable = join(root, "m9r-web-broker.exe");
    writeFileSync(executable, "stale executable");
    writeFileSync(join(root, "m9r-build-info.json"), JSON.stringify(createRuntimeBuildInfo({
      "m9r-web-broker.exe": createHash("sha256").update("expected executable").digest("hex"),
    })));

    const identity = readRuntimeBuildIdentity(executable);
    assert.equal(identity.status, "mismatch");
    assert.notEqual(identity.actualSha256, identity.expectedSha256);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runtime identity refuses tampered manifests and labels development processes unmanaged", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-runtime-manifest-"));
  try {
    const executable = join(root, "m9r-engine.exe");
    writeFileSync(executable, "engine");
    const digest = createHash("sha256").update("engine").digest("hex");
    const manifest = createRuntimeBuildInfo({ "m9r-engine.exe": digest });
    writeFileSync(join(root, "m9r-build-info.json"), JSON.stringify({ ...manifest, buildId: "0".repeat(64) }));
    assert.equal(readRuntimeBuildIdentity(executable).status, "invalid_manifest");
    rmSync(join(root, "m9r-build-info.json"));
    assert.equal(readRuntimeBuildIdentity(join(root, "node.exe")).status, "unmanaged");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the engine packager manifest is accepted by the runtime identity verifier", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-runtime-packager-parity-"));
  try {
    const executable = join(root, "m9r-engine.exe");
    writeFileSync(executable, "packaged engine");
    const manifest = writeRuntimeBuildManifest(root, "2026-10-10T00:00:00.000Z");
    const identity = readRuntimeBuildIdentity(executable);
    assert.equal(identity.status, "verified");
    assert.equal(identity.buildId, manifest.buildId);
    assert.equal(identity.actualSha256, createHash("sha256").update("packaged engine").digest("hex"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
