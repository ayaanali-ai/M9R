import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { compareSemanticVersions, evaluateUpdate, verifyUpdateManifest, type EngineUpdateManifest } from "@/lib/native/engine-update-core";
import { checkEngineUpdate } from "@/lib/native/update-lifecycle";
import { createInitialUpdateState, reduceUpdateState, shouldCheckAutomatically } from "@/lib/native/update-lifecycle-core";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pinnedKey = publicKey.export({ type: "spki", format: "pem" }).toString();
const valid: EngineUpdateManifest = {
  schema: "m9r-update/1",
  channel: "stable",
  version: "1.2.3",
  platform: "windows-x64",
  artifact: {
    url: "https://github.com/ayaanali-ai/M9R/releases/download/m9r-engine-v1.2.3/m9r-engine-windows-x64.zip",
    sha256: "a".repeat(64),
    bytes: 100_000_000,
  },
};
const signature = (bytes: Buffer) => sign(null, bytes, privateKey).toString("base64");

test("a signed official release manifest is accepted without trusting the download URL alone", () => {
  const raw = Buffer.from(JSON.stringify(valid));
  const result = verifyUpdateManifest(raw, signature(raw), pinnedKey);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.manifest.version, "1.2.3");
});

test("tampering, wrong keys, and signed off-repository downloads are rejected", () => {
  const raw = Buffer.from(JSON.stringify(valid));
  const wrongKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
  assert.equal(verifyUpdateManifest(raw, signature(raw), wrongKey).ok, false);
  const altered = Buffer.from(JSON.stringify({ ...valid, version: "1.2.4" }));
  assert.equal(verifyUpdateManifest(altered, signature(raw), pinnedKey).ok, false);
  const malicious = Buffer.from(JSON.stringify({ ...valid, artifact: { ...valid.artifact, url: "https://example.com/engine.zip" } }));
  assert.equal(verifyUpdateManifest(malicious, signature(malicious), pinnedKey).ok, false);
});

test("release comparison never treats an equal or older release as an update", () => {
  assert.equal(compareSemanticVersions("1.2.3", "1.2.3"), 0);
  assert.equal(compareSemanticVersions("1.2.3", "1.2.4"), -1);
  assert.equal(compareSemanticVersions("1.10.0", "1.9.99"), 1);
  assert.deepEqual(evaluateUpdate("1.2.3", valid), { kind: "up_to_date", currentVersion: "1.2.3" });
  assert.deepEqual(evaluateUpdate("1.2.4", valid), { kind: "up_to_date", currentVersion: "1.2.4" });
  assert.deepEqual(evaluateUpdate("1.2.2", valid), { kind: "available", currentVersion: "1.2.2", availableVersion: "1.2.3" });
});

test("automatic checks are periodic but can always be forced", () => {
  const now = 1_000_000;
  assert.equal(shouldCheckAutomatically({ nowMs: now, lastCheckedAtMs: undefined, intervalMs: 60_000 }), true);
  assert.equal(shouldCheckAutomatically({ nowMs: now, lastCheckedAtMs: now - 59_999, intervalMs: 60_000 }), false);
  assert.equal(shouldCheckAutomatically({ nowMs: now, lastCheckedAtMs: now - 60_000, intervalMs: 60_000 }), true);
  assert.equal(shouldCheckAutomatically({ nowMs: now, lastCheckedAtMs: now, intervalMs: 60_000, force: true }), true);
  assert.equal(shouldCheckAutomatically({ nowMs: now, lastCheckedAtMs: now - 1_000_000, intervalMs: 0 }), false);
});

test("the update state machine preserves honest progress and rollback outcomes", () => {
  let state = createInitialUpdateState("1.2.2");
  state = reduceUpdateState(state, { type: "check_started", at: 10 });
  state = reduceUpdateState(state, { type: "update_available", at: 20, version: "1.2.3" });
  state = reduceUpdateState(state, { type: "download_started", at: 30 });
  state = reduceUpdateState(state, { type: "download_progress", at: 40, percent: 50 });
  state = reduceUpdateState(state, { type: "download_ready", at: 50 });
  state = reduceUpdateState(state, { type: "apply_started", at: 60 });
  state = reduceUpdateState(state, { type: "apply_failed", at: 70, error: "runtime remained busy" });
  assert.equal(state.phase, "failed");
  assert.equal(state.availableVersion, "1.2.3");
  assert.equal(state.error, "runtime remained busy");

  state = reduceUpdateState(state, { type: "rollback_started", at: 80 });
  state = reduceUpdateState(state, { type: "rollback_succeeded", at: 90 });
  assert.equal(state.phase, "rolled_back");
  assert.equal(state.currentVersion, "1.2.2");
  assert.equal(state.requiresRestart, false);
});

test("invalid lifecycle transitions fail closed instead of claiming an update completed", () => {
  const state = createInitialUpdateState("1.2.2");
  assert.throws(() => reduceUpdateState(state, { type: "apply_succeeded", at: 10, version: "1.2.3" }), /cannot apply_succeeded from idle/);
  assert.throws(() => reduceUpdateState(state, { type: "download_progress", at: 10, percent: 20 }), /cannot download_progress from idle/);
});

test("the real check path verifies both signed response bodies before reporting availability", async () => {
  const raw = Buffer.from(JSON.stringify(valid));
  const rawArrayBuffer = Uint8Array.from(raw).buffer;
  const calls: string[] = [];
  const result = await checkEngineUpdate({
    currentVersion: "1.2.2",
    source: { manifestUrl: "https://updates.example.test/manifest.json", signatureUrl: "https://updates.example.test/manifest.sig", publicKeyPem: pinnedKey },
    fetcher: async (url) => {
      calls.push(url);
      return { ok: true, status: 200, arrayBuffer: async () => rawArrayBuffer, text: async () => signature(raw) };
    },
    nowMs: 123,
  });
  assert.deepEqual(calls, ["https://updates.example.test/manifest.json", "https://updates.example.test/manifest.sig"]);
  assert.equal(result.state.phase, "available");
  assert.equal(result.state.availableVersion, "1.2.3");
  assert.equal(result.manifest?.version, "1.2.3");
});

test("a failed manifest fetch or signature leaves a visible failed state and no update artifact", async () => {
  const result = await checkEngineUpdate({
    currentVersion: "1.2.2",
    source: { manifestUrl: "https://updates.example.test/manifest.json", signatureUrl: "https://updates.example.test/manifest.sig", publicKeyPem: pinnedKey },
    fetcher: async () => ({ ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0), text: async () => "" }),
    nowMs: 456,
  });
  assert.equal(result.state.phase, "failed");
  assert.match(result.state.error ?? "", /503/);
  assert.equal(result.manifest, undefined);
});
