import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const candidatesRoot = resolve(root, "engine", "candidates");
const acceptedPath = resolve(root, "release-assets", "accepted-runtime.json");
const candidateArg = process.argv[2];
const dryRun = process.argv.includes("--dry-run");

if (!candidateArg || candidateArg === "--dry-run") {
  console.error("Usage: node scripts/promote-runtime-candidate.mjs <candidate-directory> [--dry-run]");
  process.exit(2);
}

const candidateRoot = resolve(root, candidateArg);
const relativeCandidate = relative(candidatesRoot, candidateRoot);
if (!relativeCandidate || relativeCandidate.startsWith("..") || isAbsolute(relativeCandidate)) {
  throw new Error("A runtime candidate must be inside engine/candidates.");
}

const receiptPath = join(candidateRoot, "candidate.json");
const runtimePath = join(candidateRoot, "runtime", "m9r-build-info.json");
if (!existsSync(receiptPath) || !existsSync(runtimePath)) throw new Error("The candidate is incomplete; candidate.json and runtime/m9r-build-info.json are required.");

const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
const runtime = JSON.parse(readFileSync(runtimePath, "utf8"));
if (receipt.schemaVersion !== 1 || receipt.sourceDirty !== false || typeof receipt.sourceCommit !== "string" || !/^[a-f0-9]{40}$/i.test(receipt.sourceCommit)) {
  throw new Error("The candidate is not a clean, identified release candidate.");
}
if (receipt.runtimeBuildId !== runtime.buildId || typeof runtime.buildId !== "string" || !/^[a-f0-9]{64}$/i.test(runtime.buildId)) {
  throw new Error("The candidate receipt and runtime build identity do not match.");
}

const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const accepted = JSON.parse(readFileSync(acceptedPath, "utf8"));
if (!accepted || accepted.schemaVersion !== 1 || !accepted.artifacts || !runtime.artifacts) throw new Error("The accepted or candidate runtime manifest is malformed.");
const acceptedPill = accepted.artifacts["m9r-overlay.exe"];
const candidatePill = receipt.pillSha256;
if (typeof acceptedPill !== "string" || acceptedPill !== candidatePill) throw new Error("The candidate pill is not the owner-accepted pill; promote the pill first.");

const runtimeRoot = join(candidateRoot, "runtime");
for (const [relativePath, expectedHash] of Object.entries(runtime.artifacts)) {
  const artifactPath = resolve(runtimeRoot, relativePath);
  const withinRuntime = relative(runtimeRoot, artifactPath);
  if (!withinRuntime || withinRuntime.startsWith("..") || isAbsolute(withinRuntime) || !existsSync(artifactPath)) {
    throw new Error(`Candidate runtime is missing or escapes its root: ${relativePath}`);
  }
  if (sha256File(artifactPath) !== expectedHash) throw new Error(`Candidate artifact hash mismatch: ${relativePath}`);
}
if (receipt.package?.path && receipt.package?.sha256) {
  const packagePath = resolve(candidateRoot, receipt.package.path);
  if (!existsSync(packagePath) || sha256File(packagePath) !== receipt.package.sha256) throw new Error("Candidate package checksum does not match candidate.json.");
}

if (dryRun) {
  console.log(`Candidate ${basename(candidateRoot)} is eligible for runtime promotion (${runtime.buildId}).`);
  process.exit(0);
}

const tempPath = `${acceptedPath}.pending-${randomUUID()}`;
writeFileSync(tempPath, `${JSON.stringify(runtime, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
try {
  renameSync(tempPath, acceptedPath);
} catch (error) {
  try { unlinkSync(tempPath); } catch { /* preserve the old accepted policy if cleanup is denied */ }
  throw error;
}
console.log(`Promoted runtime ${runtime.buildId} from candidate ${basename(candidateRoot)}.`);
