#!/usr/bin/env node
// One-time (or rotate-time) keypair for signing the M9R update manifest.
// The PRIVATE key must never be committed. The public key is committed to
// release-assets/update-public-key.pem and shipped inside the installed
// package so the pill can verify update manifests offline.
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const privateKeyOut = process.argv[2];
if (!privateKeyOut) {
  console.error("Usage: node scripts/generate-update-signing-key.mjs <path-to-save-private-key.pem>");
  console.error("The path must be OUTSIDE this repository. Back this file up; losing it means");
  console.error("generating a new keypair and re-publishing release-assets/update-public-key.pem.");
  process.exit(1);
}

const repoRoot = resolve(import.meta.dirname, "..");
const resolvedPrivatePath = resolve(privateKeyOut);
if (resolvedPrivatePath.startsWith(repoRoot)) {
  console.error(`Refusing to write the private key inside the repository: ${resolvedPrivatePath}`);
  process.exit(1);
}

const publicKeyOut = resolve(repoRoot, "release-assets", "update-public-key.pem");
if (existsSync(publicKeyOut)) {
  console.error(`${publicKeyOut} already exists. Delete it first if you intend to rotate the key`);
  console.error("(every previously-installed client's update-config.json pins the old key and will");
  console.error("simply fail its next check until it's reinstalled/updated with the new one).");
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();

mkdirSync(dirname(resolvedPrivatePath), { recursive: true });
writeFileSync(resolvedPrivatePath, privatePem, { mode: 0o600 });
mkdirSync(dirname(publicKeyOut), { recursive: true });
writeFileSync(publicKeyOut, publicPem, { mode: 0o644 });

console.log(`Private key written to ${resolvedPrivatePath} (keep this safe, never commit it).`);
console.log(`Public key written to ${publicKeyOut} (commit this).`);
