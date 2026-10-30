// Accept a newly-built, owner-reviewed m9r-overlay.exe as the live pill.
//
// This exists because release-assets/accepted-ui/ + release-assets/accepted-runtime.json
// is a separate, older convention from the engine/candidates/ + engine-build-transaction.mjs
// system (that one expects a full runtime directory with its own internal manifest; this one
// has only ever held the single overlay exe plus a flat top-level manifest). The three most
// recent "release: promote/accept/restore" commits on this branch were hand-edits of exactly
// that one artifacts["m9r-overlay.exe"] entry, with no backup taken automatically. This script
// does the same single-artifact update, but verified end to end and with an automatic backup,
// instead of by hand.
//
// It touches ONLY the m9r-overlay.exe entry in accepted-runtime.json and the exe file itself.
// Every other artifact in the manifest (m9r-engine.exe, cua-driver-runtime/*, etc.) is left
// byte-for-byte as-is. It never restarts or installs anything, and it never touches
// engine/candidates/ or any ACL-locked directory.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(root, "release-assets", "accepted-runtime.json");
const acceptedDir = join(root, "release-assets", "accepted-ui");
const acceptedExePath = join(acceptedDir, "m9r-overlay.exe");
const recoveryDir = join(root, "release-assets", "recovery");

const candidatePath = resolve(process.argv[2] ?? "");
if (!process.argv[2] || !existsSync(candidatePath)) {
  console.error("Usage: node scripts/accept-overlay-candidate.mjs <path-to-new-m9r-overlay.exe>");
  process.exit(1);
}
if (basename(candidatePath).toLowerCase() !== "m9r-overlay.exe") {
  console.error(`Refusing: candidate file must be named m9r-overlay.exe, got ${basename(candidatePath)}`);
  process.exit(1);
}

// Must match engine-build-transaction.mjs's private buildIdFor() exactly, or build-engine.mjs's
// consumers of this manifest's buildId would disagree with that system's own notion of identity.
function buildIdFor(artifacts) {
  const sorted = Object.fromEntries(Object.entries(artifacts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return createHash("sha256").update(JSON.stringify(Object.entries(sorted))).digest("hex");
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

if (!existsSync(manifestPath)) throw new Error(`Missing ${manifestPath}`);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.schemaVersion !== 1 || typeof manifest.artifacts !== "object" || !manifest.artifacts["m9r-overlay.exe"]) {
  throw new Error("accepted-runtime.json is not in the expected shape; refusing to touch it.");
}

const newHash = sha256(candidatePath);
const oldHash = manifest.artifacts["m9r-overlay.exe"];
if (newHash === oldHash) {
  console.log(`Candidate is byte-identical to the already-accepted m9r-overlay.exe (${oldHash.slice(0, 8)}). Nothing to do.`);
  process.exit(0);
}

mkdirSync(recoveryDir, { recursive: true });
const backupPath = join(recoveryDir, `m9r-overlay-pre-accept-${oldHash.slice(0, 8)}-${Date.now()}.exe`);
if (existsSync(acceptedExePath)) {
  copyFileSync(acceptedExePath, backupPath);
  if (sha256(backupPath) !== oldHash) throw new Error("Backup copy did not match the exe it was backing up; aborting before touching anything live.");
}

mkdirSync(acceptedDir, { recursive: true });
copyFileSync(candidatePath, acceptedExePath);
if (sha256(acceptedExePath) !== newHash) throw new Error("Copied exe does not match the candidate's hash; aborting. The prior accepted exe is unchanged.");

const updatedArtifacts = { ...manifest.artifacts, "m9r-overlay.exe": newHash };
const updatedManifest = {
  ...manifest,
  buildId: buildIdFor(updatedArtifacts),
  builtAt: new Date().toISOString(),
  artifacts: updatedArtifacts,
};
writeFileSync(manifestPath, `${JSON.stringify(updatedManifest, null, 2)}\n`);

console.log(`Accepted new m9r-overlay.exe: ${oldHash.slice(0, 8)} -> ${newHash.slice(0, 8)}`);
console.log(`Previous exe backed up to: ${backupPath}`);
console.log(`Updated: ${manifestPath}`);
console.log(`Nothing was installed or restarted. Review the diff, then commit if it looks right.`);
