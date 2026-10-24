import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyRuntimeBuildManifest } from "./engine-build-transaction.mjs";

export const RELEASE_PACKAGE_MANIFEST = "m9r-package-info.json";
export const RELEASE_PACKAGE_NAME = "m9r-engine-windows-x64";

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function normalizedRelativePath(value) {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.includes(":")
    || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Invalid release package path: ${value}`);
  }
  return normalized;
}

function listFiles(root, current = root) {
  const files = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Release package must not contain symbolic links: ${path}`);
    if (entry.isDirectory()) {
      files.push(...listFiles(root, path));
    } else if (entry.isFile()) {
      files.push({
        path: normalizedRelativePath(relative(root, path).split(sep).join("/")),
        sha256: sha256File(path),
      });
    } else {
      throw new Error(`Release package contains an unsupported filesystem entry: ${path}`);
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function readRuntime(root) {
  const runtimePath = join(resolve(root), "m9r-build-info.json");
  if (!existsSync(runtimePath)) throw new Error("Release package is missing m9r-build-info.json.");
  const runtime = verifyRuntimeBuildManifest(root, { exact: false });
  if (!/^[a-f0-9]{64}$/i.test(runtime.buildId)
    || !/^[a-f0-9]{40}$/i.test(runtime.source.sourceCommit)) {
    throw new Error("Release runtime identity has an invalid build or source commit.");
  }
  return runtime;
}

function assertCleanSource(runtime, requireCleanSource) {
  if (requireCleanSource && runtime.source.sourceDirty) {
    throw new Error(`Release package requires clean source; runtime ${runtime.buildId} was built from a dirty source tree.`);
  }
}

function packageFileMap(root) {
  return Object.fromEntries(
    listFiles(root)
      .filter((entry) => entry.path.toLowerCase() !== RELEASE_PACKAGE_MANIFEST)
      .map((entry) => [entry.path, entry.sha256]),
  );
}

function sortedObject(value) {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

export function createReleasePackageManifest(root, options = {}) {
  const absoluteRoot = resolve(root);
  const runtime = readRuntime(absoluteRoot);
  assertCleanSource(runtime, options.requireCleanSource === true);
  const manifest = {
    schemaVersion: 1,
    packageName: RELEASE_PACKAGE_NAME,
    runtimeBuildId: runtime.buildId,
    source: runtime.source,
    files: sortedObject(packageFileMap(absoluteRoot)),
  };
  writeFileSync(join(absoluteRoot, RELEASE_PACKAGE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

export function verifyReleasePackageManifest(root, options = {}) {
  const absoluteRoot = resolve(root);
  const runtime = readRuntime(absoluteRoot);
  const manifestPath = join(absoluteRoot, RELEASE_PACKAGE_MANIFEST);
  if (!existsSync(manifestPath)) throw new Error(`Release package is missing ${RELEASE_PACKAGE_MANIFEST}.`);

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Release package manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!manifest || manifest.schemaVersion !== 1 || manifest.packageName !== RELEASE_PACKAGE_NAME
    || !/^[a-f0-9]{64}$/i.test(String(manifest.runtimeBuildId ?? ""))
    || !manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) {
    throw new Error("Release package manifest has an invalid schema.");
  }
  if (manifest.runtimeBuildId !== runtime.buildId) {
    throw new Error("Release package manifest does not match the runtime build identity.");
  }
  if (!manifest.source || manifest.source.sourceCommit !== runtime.source.sourceCommit
    || manifest.source.sourceDirty !== runtime.source.sourceDirty) {
    throw new Error("Release package manifest source provenance does not match the runtime identity.");
  }
  assertCleanSource(runtime, options.requireCleanSource === true);

  const expected = {};
  for (const [path, digest] of Object.entries(manifest.files)) {
    const normalized = normalizedRelativePath(path);
    if (expected[normalized]) throw new Error(`Release package manifest contains duplicate path: ${path}`);
    if (!/^[a-f0-9]{64}$/i.test(String(digest))) throw new Error(`Release package manifest has an invalid hash: ${path}`);
    expected[normalized] = String(digest).toLowerCase();
  }
  const actual = packageFileMap(absoluteRoot);
  const expectedPaths = Object.keys(expected).sort();
  const actualPaths = Object.keys(actual).sort();
  if (JSON.stringify(expectedPaths) !== JSON.stringify(actualPaths)) {
    throw new Error("Release package manifest does not match the exact package file set.");
  }
  for (const path of expectedPaths) {
    if (actual[path].toLowerCase() !== expected[path]) throw new Error(`Release package file hash mismatch: ${path}`);
  }
  return manifest;
}

function argumentValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const root = argumentValue(args, "--root");
  if (!root || (!args.includes("--create") && !args.includes("--verify"))) {
    console.error("Usage: node scripts/release-package-manifest.mjs --create|--verify --root <directory> [--require-clean-source]");
    process.exitCode = 2;
  } else {
    try {
      const options = { requireCleanSource: args.includes("--require-clean-source") };
      const manifest = args.includes("--create")
        ? createReleasePackageManifest(root, options)
        : verifyReleasePackageManifest(root, options);
      console.log(`Release package ${args.includes("--create") ? "manifest created" : "verified"}: ${manifest.runtimeBuildId}`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
