import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export const RUNTIME_BUILD_INFO_FILE = "m9r-build-info.json";

function normalizedRelativePath(value) {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
  if (!normalized || normalized.startsWith("/") || normalized.includes(":")
    || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Invalid runtime artifact path: ${value}`);
  }
  return normalized;
}

function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function listFiles(root, current = root) {
  const results = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Runtime build must not contain symbolic links: ${path}`);
    if (entry.isDirectory()) results.push(...listFiles(root, path));
    else if (entry.isFile()) {
      const pathFromRoot = relative(root, path).split(sep).join("/");
      if (pathFromRoot.toLowerCase() !== RUNTIME_BUILD_INFO_FILE) {
        results.push([normalizedRelativePath(pathFromRoot), hashFile(path)]);
      }
    } else {
      throw new Error(`Runtime build contains an unsupported filesystem entry: ${path}`);
    }
  }
  return results;
}

function normalizeArtifacts(entries) {
  const normalizedEntries = entries.map(([path, digest]) => [normalizedRelativePath(path), digest.toLowerCase()]);
  if (new Set(normalizedEntries.map(([path]) => path)).size !== normalizedEntries.length) {
    throw new Error("Runtime build contains duplicate artifact paths.");
  }
  const artifacts = Object.fromEntries(normalizedEntries);
  const sorted = Object.fromEntries(Object.entries(artifacts).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  if (!Object.keys(sorted).length || Object.keys(sorted).some((path) => !/^[a-f0-9]{64}$/.test(sorted[path]))) {
    throw new Error("Runtime build has no valid hashed artifacts.");
  }
  return sorted;
}

function buildIdFor(artifacts) {
  return createHash("sha256").update(JSON.stringify(Object.entries(artifacts))).digest("hex");
}

export function writeRuntimeBuildManifest(
  root,
  builtAt = new Date().toISOString(),
  source = { sourceCommit: "unknown", sourceDirty: true },
) {
  const artifacts = normalizeArtifacts(listFiles(resolve(root)));
  if (!source || typeof source !== "object"
    || typeof source.sourceCommit !== "string"
    || typeof source.sourceDirty !== "boolean") {
    throw new Error("Runtime build source provenance is invalid.");
  }
  const manifest = { schemaVersion: 1, buildId: buildIdFor(artifacts), builtAt, artifacts, source };
  writeFileSync(join(root, RUNTIME_BUILD_INFO_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function verifyRuntimeBuildManifest(root, { exact = false } = {}) {
  const absoluteRoot = resolve(root);
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(absoluteRoot, RUNTIME_BUILD_INFO_FILE), "utf8")); }
  catch { throw new Error("Runtime build manifest is missing or unreadable."); }

  if (!manifest || manifest.schemaVersion !== 1 || typeof manifest.buildId !== "string"
    || !/^[a-f0-9]{64}$/.test(manifest.buildId) || typeof manifest.builtAt !== "string"
    || !manifest.artifacts || typeof manifest.artifacts !== "object" || Array.isArray(manifest.artifacts)) {
    throw new Error("Runtime build manifest has an invalid schema.");
  }
  const artifacts = normalizeArtifacts(Object.entries(manifest.artifacts));
  if (buildIdFor(artifacts) !== manifest.buildId) throw new Error("Runtime build manifest digest does not match its artifact list.");

  const actualPaths = [];
  for (const [path, expectedHash] of Object.entries(artifacts)) {
    const absolutePath = join(absoluteRoot, ...path.split("/"));
    if (!existsSync(absolutePath) || !lstatSync(absolutePath).isFile()) throw new Error(`Runtime artifact is missing: ${path}`);
    const actualHash = hashFile(absolutePath);
    if (actualHash !== expectedHash) throw new Error(`Runtime artifact hash mismatch: ${path}`);
    actualPaths.push(path);
  }
  if (exact) {
    const presentPaths = listFiles(absoluteRoot).map(([path]) => path).sort();
    const expectedPaths = Object.keys(artifacts).sort();
    if (JSON.stringify(presentPaths) !== JSON.stringify(expectedPaths)) throw new Error("Runtime build contains unhashed or stale artifacts.");
  }
  return { ...manifest, artifacts };
}

function runtimePublishBackupPaths(output) {
  const parent = dirname(output);
  if (!existsSync(parent)) return [];
  return readdirSync(parent)
    .filter((name) => /^\.m9r-engine-publish-backup-\d+-[a-f0-9-]{36}$/i.test(name))
    .map((name) => join(parent, name));
}

function verifyRuntimeDirectory(path) {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Runtime output is not a regular directory: ${path}`);
  return verifyRuntimeBuildManifest(path, { exact: true });
}

function removeVerifiedRuntimeDirectory(path) {
  verifyRuntimeDirectory(path);
  rmSync(path, { recursive: true, force: true });
  if (existsSync(path)) throw new Error(`Verified prior runtime output remains after cleanup: ${path}`);
}

/** Recover only verified prior snapshots. Unknown files are never discarded. */
function recoverRuntimePublishBackups(output) {
  const backups = runtimePublishBackupPaths(output);
  if (backups.length === 0) return;
  if (existsSync(output)) {
    verifyRuntimeDirectory(output);
    for (const backup of backups) removeVerifiedRuntimeDirectory(backup);
    return;
  }
  if (backups.length !== 1) throw new Error(`Multiple prior runtime snapshots need review before publishing: ${backups.join(", ")}`);
  const backup = backups[0];
  verifyRuntimeDirectory(backup);
  renameSync(backup, output);
  verifyRuntimeDirectory(output);
}

/** Publish a complete exact runtime snapshot; no files from the prior output are carried forward. */
export function publishRuntimeBuild(stagedRoot, outputRoot) {
  const staged = resolve(stagedRoot);
  const output = resolve(outputRoot);
  const manifest = verifyRuntimeBuildManifest(staged, { exact: true });
  mkdirSync(dirname(output), { recursive: true });
  recoverRuntimePublishBackups(output);

  const hadPrevious = existsSync(output);
  if (hadPrevious) verifyRuntimeDirectory(output);
  const backup = join(dirname(output), `.m9r-engine-publish-backup-${process.pid}-${randomUUID()}`);
  if (hadPrevious) renameSync(output, backup);
  try {
    renameSync(staged, output);
    const publishedManifest = verifyRuntimeDirectory(output);
    if (publishedManifest.buildId !== manifest.buildId) throw new Error("Published runtime build identity does not match the staged build.");
  } catch (error) {
    const rollbackErrors = [];
    try { if (existsSync(output)) rmSync(output, { recursive: true, force: true }); }
    catch (rollbackError) { rollbackErrors.push(String(rollbackError)); }
    if (hadPrevious) {
      try {
        if (!existsSync(backup)) throw new Error("verified prior runtime snapshot is missing");
        renameSync(backup, output);
        verifyRuntimeDirectory(output);
      } catch (rollbackError) { rollbackErrors.push(String(rollbackError)); }
    }
    if (rollbackErrors.length) throw new Error(`Runtime build publish failed; recovery needs review. Prior runtime snapshot: ${backup}. ${rollbackErrors.join("; ")}`, { cause: error });
    throw new Error(`Runtime build publish failed; the previous exact runtime was restored. ${String(error)}`, { cause: error });
  }

  if (hadPrevious) {
    try { removeVerifiedRuntimeDirectory(backup); }
    catch (error) {
      throw new Error(`New runtime output is verified, but its prior snapshot still needs cleanup before packaging: ${backup}. ${String(error)}`, { cause: error });
    }
  }
  return manifest;
}

function generatedPublishBackupPaths(output) {
  const parent = dirname(output);
  if (!existsSync(parent)) return [];
  return readdirSync(parent)
    .filter((name) => /^\.m9r-generated-backup-\d+-[a-f0-9-]{36}$/i.test(name))
    .map((name) => join(parent, name));
}

function verifyGeneratedDirectory(path) {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Generated CLI output is incomplete or redirected: ${path}`);
  }
  const files = listFiles(path).map(([relativePath]) => relativePath);
  if (!files.includes("m9r.js") || !files.includes("build-info.json")) {
    throw new Error(`Generated CLI output is incomplete or redirected: ${path}`);
  }
}

function removeVerifiedGeneratedDirectory(path) {
  verifyGeneratedDirectory(path);
  rmSync(path, { recursive: true, force: true });
  if (existsSync(path)) throw new Error(`Verified prior CLI output remains after cleanup: ${path}`);
}

function recoverGeneratedPublishBackups(output) {
  const backups = generatedPublishBackupPaths(output);
  if (backups.length === 0) return;
  if (existsSync(output)) {
    verifyGeneratedDirectory(output);
    for (const backup of backups) removeVerifiedGeneratedDirectory(backup);
    return;
  }
  if (backups.length !== 1) throw new Error(`Multiple prior CLI outputs need review before publishing: ${backups.join(", ")}`);
  verifyGeneratedDirectory(backups[0]);
  renameSync(backups[0], output);
  verifyGeneratedDirectory(output);
}

/** Replace a generated directory only after it is complete; remove only verified prior output. */
export function publishGeneratedDirectory(stagedRoot, outputRoot) {
  const staged = resolve(stagedRoot);
  const output = resolve(outputRoot);
  if (!existsSync(staged) || !lstatSync(staged).isDirectory()) throw new Error("Generated output staging directory is missing.");
  if (dirname(staged) !== dirname(output)) throw new Error("Generated output staging and destination must share a parent directory.");
  recoverGeneratedPublishBackups(output);
  const hadPrevious = existsSync(output);
  if (hadPrevious) verifyGeneratedDirectory(output);
  const backup = join(dirname(output), `.m9r-generated-backup-${process.pid}-${randomUUID()}`);
  if (hadPrevious) renameSync(output, backup);
  try {
    renameSync(staged, output);
    verifyGeneratedDirectory(output);
  } catch (error) {
    if (hadPrevious && existsSync(backup)) {
      try { renameSync(backup, output); }
      catch (rollbackError) {
        throw new Error(`Generated output publish failed; the prior directory remains at ${backup}. ${String(rollbackError)}`, { cause: error });
      }
    }
    throw new Error(`Generated output publish failed; the previous directory was restored. ${String(error)}`, { cause: error });
  }
  if (hadPrevious) {
    try { removeVerifiedGeneratedDirectory(backup); }
    catch (error) {
      throw new Error(`New CLI output is published, but its prior snapshot still needs cleanup: ${backup}. ${String(error)}`, { cause: error });
    }
  }
}
