import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

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
  if (!source || typeof source.sourceCommit !== "string" || !source.sourceCommit
    || typeof source.sourceDirty !== "boolean") {
    throw new Error("Runtime build source provenance is required.");
  }
  const artifacts = normalizeArtifacts(listFiles(resolve(root)));
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
    || !manifest.artifacts || typeof manifest.artifacts !== "object" || Array.isArray(manifest.artifacts)
    || !manifest.source || typeof manifest.source !== "object" || Array.isArray(manifest.source)
    || typeof manifest.source.sourceCommit !== "string" || !manifest.source.sourceCommit
    || typeof manifest.source.sourceDirty !== "boolean") {
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

function safeManagedPath(value) {
  const normalized = value.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.includes(":")
    || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Invalid managed runtime path: ${value}`);
  }
  return normalized;
}

function isCoveredByManagedPath(path, managedPaths) {
  return managedPaths.some((managed) => path === managed.toLowerCase() || path.startsWith(`${managed.toLowerCase()}/`));
}

/**
 * Windows security scanners can briefly hold a newly copied directory while
 * the transactional publisher is swapping it into place. Retry only that
 * transient rename condition; do not weaken ACLs or fall back to deleting a
 * live runtime. All other filesystem errors remain fail-closed.
 */
function renameWithWindowsRetry(source, destination) {
  const attempts = process.platform === "win32" ? 20 : 1;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      renameSync(source, destination);
      return;
    } catch (error) {
      lastError = error;
      if (process.platform !== "win32" || !["EPERM", "EBUSY"].includes(error?.code) || attempt === attempts - 1) throw error;
      const waitMs = Math.min(250, 25 * (attempt + 1));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
    }
  }
  throw lastError;
}

/**
 * Publish only after the complete staged artifact set has a valid hash manifest.
 * Managed paths are swapped with rollback; unrelated files in engine/dist stay untouched.
 */
export function publishRuntimeBuild(stagedRoot, outputRoot, managedPaths) {
  const staged = resolve(stagedRoot);
  const output = resolve(outputRoot);
  const manifest = verifyRuntimeBuildManifest(staged, { exact: true });
  const roots = [...new Set(managedPaths.map(safeManagedPath))];
  const lowerRoots = roots.map((path) => path.toLowerCase()).sort();
  if (lowerRoots.includes(RUNTIME_BUILD_INFO_FILE)
    || lowerRoots.some((path, index) => lowerRoots.slice(index + 1).some((other) => other.startsWith(`${path}/`)))) {
    throw new Error("Managed runtime paths must not overlap or include the identity manifest.");
  }
  for (const artifact of Object.keys(manifest.artifacts)) {
    if (!isCoveredByManagedPath(artifact, roots)) throw new Error(`Managed runtime paths do not include artifact: ${artifact}`);
  }
  for (const root of roots) {
    if (!existsSync(join(staged, ...root.split("/")))) throw new Error(`Staged runtime output is missing: ${root}`);
  }

  mkdirSync(dirname(output), { recursive: true });
  mkdirSync(output, { recursive: true });
  const backup = join(dirname(output), `.m9r-engine-publish-backup-${process.pid}-${randomUUID()}`);
  mkdirSync(backup, { recursive: true });
  const backedUp = [];
  const published = [];
  const orderedRoots = [...roots, RUNTIME_BUILD_INFO_FILE];

  try {
    for (const path of orderedRoots) {
      const source = join(staged, ...path.split("/"));
      const destination = join(output, ...path.split("/"));
      const previous = join(backup, ...path.split("/"));
      mkdirSync(dirname(destination), { recursive: true });
      if (existsSync(destination)) {
        mkdirSync(dirname(previous), { recursive: true });
        renameWithWindowsRetry(destination, previous);
        backedUp.push(path);
      }
      renameWithWindowsRetry(source, destination);
      published.push(path);
    }
    const publishedManifest = verifyRuntimeBuildManifest(output);
    if (publishedManifest.buildId !== manifest.buildId) throw new Error("Published runtime build identity does not match the staged build.");
  } catch (error) {
    const rollbackErrors = [];
    for (const path of published.reverse()) {
      try { rmSync(join(output, ...path.split("/")), { recursive: true, force: true }); }
      catch (rollbackError) { rollbackErrors.push(String(rollbackError)); }
    }
    for (const path of backedUp.reverse()) {
      const previous = join(backup, ...path.split("/"));
      const destination = join(output, ...path.split("/"));
      try {
        if (existsSync(previous)) {
          mkdirSync(dirname(destination), { recursive: true });
          renameSync(previous, destination);
        }
      } catch (rollbackError) { rollbackErrors.push(String(rollbackError)); }
    }
    if (rollbackErrors.length) {
      throw new Error(`Runtime build publish failed and rollback needs recovery. Prior files remain in ${backup}. ${rollbackErrors.join("; ")}`, { cause: error });
    }
    rmSync(backup, { recursive: true, force: true });
    throw new Error(`Runtime build publish failed; previous artifacts were restored. ${String(error)}`, { cause: error });
  }

  try { rmSync(backup, { recursive: true, force: true }); }
  catch { /* A locked retired artifact is recoverable; it is not part of the published build. */ }
  return manifest;
}

/** Replace a generated directory only after it is complete; never clear the last output before the build passes. */
export function publishGeneratedDirectory(stagedRoot, outputRoot) {
  const staged = resolve(stagedRoot);
  const output = resolve(outputRoot);
  if (!existsSync(staged) || !lstatSync(staged).isDirectory()) throw new Error("Generated output staging directory is missing.");
  if (dirname(staged) !== dirname(output)) throw new Error("Generated output staging and destination must share a parent directory.");
  const backup = join(dirname(output), `.m9r-generated-backup-${process.pid}-${randomUUID()}`);
  const hadPrevious = existsSync(output);
  if (hadPrevious) renameWithWindowsRetry(output, backup);
  try {
    renameWithWindowsRetry(staged, output);
  } catch (error) {
    if (hadPrevious && existsSync(backup)) {
      try { renameWithWindowsRetry(backup, output); }
      catch (rollbackError) {
        throw new Error(`Generated output publish failed; the prior directory remains at ${backup}. ${String(rollbackError)}`, { cause: error });
      }
    }
    throw new Error(`Generated output publish failed; the previous directory was restored. ${String(error)}`, { cause: error });
  }
  if (hadPrevious) {
    try { rmSync(backup, { recursive: true, force: true }); }
    catch { /* Published output is valid; a locked prior output remains recoverable beside it. */ }
  }
}
