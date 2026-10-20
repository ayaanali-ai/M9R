import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = join(import.meta.dirname, "..");
const minimumMcpSdkVersion = [1, 32, 0];

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(repoRoot, relativePath), "utf8"));
}

function parseVersion(version) {
  const match = /^([0-9]+)\.([0-9]+)\.([0-9]+)(?:-|$)/.exec(version ?? "");
  assert.ok(match, `expected a concrete MCP SDK version, received ${String(version)}`);
  return match.slice(1).map(Number);
}

function assertAtLeast(version, minimum, source) {
  const actual = parseVersion(version);
  const isPatched = actual[0] > minimum[0] ||
    (actual[0] === minimum[0] && actual[1] > minimum[1]) ||
    (actual[0] === minimum[0] && actual[1] === minimum[1] && actual[2] >= minimum[2]);
  assert.ok(
    isPatched,
    `${source} must resolve >= ${minimum.join(".")}; found ${version}`,
  );
}

test("root MCP SDK security floor is declared and locked", () => {
  const manifest = readJson("package.json");
  const lockfile = readJson("package-lock.json");

  assertAtLeast(manifest.overrides?.["@modelcontextprotocol/sdk"], minimumMcpSdkVersion, "root override");
  assertAtLeast(
    lockfile.packages?.["node_modules/@modelcontextprotocol/sdk"]?.version,
    minimumMcpSdkVersion,
    "root lockfile",
  );
});

test("CLI MCP SDK security floor is declared and locked", () => {
  const manifest = readJson(join("cli", "package.json"));
  const lockfile = readJson(join("cli", "package-lock.json"));

  assertAtLeast(manifest.dependencies?.["@modelcontextprotocol/sdk"], minimumMcpSdkVersion, "CLI dependency");
  assertAtLeast(
    lockfile.packages?.["node_modules/@modelcontextprotocol/sdk"]?.version,
    minimumMcpSdkVersion,
    "CLI lockfile",
  );
});

test("published dev-tool dependency floors are locked", () => {
  const lockfile = readJson("package-lock.json");
  const packages = lockfile.packages ?? {};
  const postcssVersion = packages["node_modules/postcss-selector-parser"]?.version;

  assertAtLeast(postcssVersion, [7, 1, 6], "postcss-selector-parser lockfile");

  const braceEntries = Object.entries(packages).filter(([path]) => path.endsWith("brace-expansion"));
  assert.ok(braceEntries.length > 0, "expected brace-expansion entries in the root lockfile");
  for (const [path, entry] of braceEntries) {
    const version = parseVersion(entry.version);
    const patched = (version[0] === 1 && (version[1] > 1 || (version[1] === 1 && version[2] >= 21))) ||
      (version[0] === 5 && (version[1] > 0 || (version[1] === 0 && version[2] >= 12))) ||
      version[0] === 2 || version[0] === 3;
    assert.ok(patched, `${path} must avoid published brace-expansion vulnerable ranges; found ${entry.version}`);
  }
});
