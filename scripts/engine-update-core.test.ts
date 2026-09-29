import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { verifyUpdateManifest } from "@/lib/native/engine-update-core";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pinnedKey = publicKey.export({ type: "spki", format: "pem" }).toString();
const valid = {
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
