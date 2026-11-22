#!/usr/bin/env node
// Builds and signs the m9r-update/1 manifest for one release's engine ZIP.
// Run after scripts/package-engine-release.ps1 has produced the ZIP. Outputs
// m9r-update-manifest.json and m9r-update-manifest.json.sig into the same
// output directory as the ZIP; upload both as additional release assets
// alongside m9r-engine-windows-x64.zip / .sha256 / m9r-accepted-runtime.json.
import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

function usageError(message) {
  console.error(message);
  console.error("Usage: node scripts/sign-update-manifest.mjs --version <x.y.z> --zip <path> --key <private-key.pem>");
  process.exit(1);
}

const args = process.argv.slice(2);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const version = value("--version");
const zipPath = value("--zip");
const keyPath = value("--key");
if (!version || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) usageError("A semantic --version is required.");
if (!zipPath) usageError("--zip is required.");
if (!keyPath) usageError("--key (the private signing key PEM) is required.");

const zipFullPath = resolve(zipPath);
const bytes = readFileSync(zipFullPath);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const size = statSync(zipFullPath).size;

const manifest = {
  schema: "m9r-update/1",
  channel: "stable",
  version,
  platform: "windows-x64",
  artifact: {
    url: `https://github.com/ayaanali-ai/M9R/releases/download/m9r-engine-v${version}/m9r-engine-windows-x64.zip`,
    sha256,
    bytes: size,
  },
};

const raw = Buffer.from(JSON.stringify(manifest));
const privateKey = createPrivateKey(readFileSync(resolve(keyPath), "utf8"));
const signature = sign(null, raw, privateKey).toString("base64");

const outDir = resolve(zipFullPath, "..");
const manifestOut = resolve(outDir, "m9r-update-manifest.json");
const signatureOut = resolve(outDir, "m9r-update-manifest.json.sig");
writeFileSync(manifestOut, raw);
writeFileSync(signatureOut, signature);

console.log(`Wrote ${manifestOut}`);
console.log(`Wrote ${signatureOut}`);
console.log("Upload both as release assets on the m9r-engine-v" + version + " GitHub release.");
