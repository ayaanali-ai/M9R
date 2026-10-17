import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createRuntimeBuildInfo, readManagedWebBrokerIdentity, readRuntimeBuildId, readRuntimeBuildIdentity } from "../src/lib/native/runtime-build-identity";
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
    assert.equal(identity.sourceCommit, "unknown");
    assert.equal(identity.sourceDirty, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runtime identity labels a hash-only legacy install unmanaged instead of claiming source convergence", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-runtime-legacy-manifest-"));
  try {
    const executable = join(root, "m9r-engine.exe");
    writeFileSync(executable, "legacy engine");
    const digest = createHash("sha256").update("legacy engine").digest("hex");
    const manifest = createRuntimeBuildInfo({ "m9r-engine.exe": digest });
    const { source: _source, ...legacyManifest } = manifest;
    writeFileSync(join(root, "m9r-build-info.json"), JSON.stringify(legacyManifest));
    const identity = readRuntimeBuildIdentity(executable);
    assert.equal(identity.status, "unmanaged");
    assert.equal(identity.reason, "source_provenance_missing");
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

test("managed Web broker identity uses its separate ownership record", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-managed-broker-"));
  try {
    const executable = join(root, "bin", "m9r-web-broker.exe");
    const record = join(root, "web-broker-install.json");
    mkdirSync(dirname(executable), { recursive: true });
    const image = Buffer.from("managed broker image");
    writeFileSync(executable, image);
    const digest = createHash("sha256").update(image).digest("hex");
    writeFileSync(record, JSON.stringify({ version: 1, path: executable, sha256: digest }));

    const identity = readManagedWebBrokerIdentity(executable, record);
    assert.equal(identity.status, "verified");
    assert.equal(identity.reason, "managed_broker_record");
    assert.equal(identity.actualSha256, digest);
    assert.equal(identity.expectedSha256, digest);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("managed Web broker identity catches a changed executable", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-managed-broker-mismatch-"));
  try {
    const executable = join(root, "bin", "m9r-web-broker.exe");
    const record = join(root, "web-broker-install.json");
    mkdirSync(dirname(executable), { recursive: true });
    writeFileSync(executable, "current broker");
    writeFileSync(record, JSON.stringify({ version: 1, path: executable, sha256: "0".repeat(64) }));

    const identity = readManagedWebBrokerIdentity(executable, record);
    assert.equal(identity.status, "mismatch");
    assert.equal(identity.reason, "broker_executable_hash_mismatch");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runtime identity refuses tampered manifests and labels development processes unmanaged", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-runtime-manifest-"));
  try {
    const executable = join(root, "m9r-engine.exe");
    writeFileSync(executable, "engine");
    const digest = createHash("sha256").update("engine").digest("hex");
    const manifest = createRuntimeBuildInfo({ "m9r-engine.exe": digest });
    writeFileSync(join(root, "m9r-build-info.json"), JSON.stringify({ ...manifest, buildId: "not-a-build-id" }));
    assert.equal(readRuntimeBuildIdentity(executable).status, "invalid_manifest");
    rmSync(join(root, "m9r-build-info.json"));
    assert.equal(readRuntimeBuildIdentity(join(root, "node.exe")).status, "unmanaged");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runtime generation reads cheaply without hashing the executable", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-runtime-generation-"));
  try {
    const executable = join(root, "m9r-engine.exe");
    writeFileSync(executable, "engine");
    const digest = createHash("sha256").update("engine").digest("hex");
    const manifest = createRuntimeBuildInfo({ "m9r-engine.exe": digest });
    writeFileSync(join(root, "m9r-build-info.json"), JSON.stringify(manifest));
    assert.equal(readRuntimeBuildId(executable), manifest.buildId);
    writeFileSync(join(root, "m9r-build-info.json"), JSON.stringify({ ...manifest, buildId: "not-a-build-id" }));
    assert.equal(readRuntimeBuildId(executable), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the local oathlock command uses the current M9R CLI entrypoint", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { scripts?: { oathlock?: string } };
  assert.match(packageJson.scripts?.oathlock ?? "", /scripts\/m9r-cli\.ts$/);
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
