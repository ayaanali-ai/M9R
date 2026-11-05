import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CUA_DRIVER_VERSION, validateCuaDriverHostMetadata, validateCuaDriverPackageVersion } from "../src/lib/native/cua-driver-host";

test("the standalone host accepts only the pinned driver and rejects configuration without retry classification by message", () => {
  const requiresVersion = new RegExp(`requires ${CUA_DRIVER_VERSION.replace(/\./g, "\\.")}`);
  assert.doesNotThrow(() => validateCuaDriverHostMetadata({ driverVersion: CUA_DRIVER_VERSION, embedded: false }));
  assert.throws(() => validateCuaDriverHostMetadata({ driverVersion: "0.33.4", embedded: false }), requiresVersion);
  assert.throws(() => validateCuaDriverHostMetadata({ driverVersion: CUA_DRIVER_VERSION, embedded: true }), /embedded mode/);
});

test("the installed CLI and engine SDK package records stay aligned with the pinned cursor host", () => {
  const rootPackage = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string> };
  const rootLock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")) as { packages: Record<string, { version?: string; resolved?: string; integrity?: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }> };
  const cliPackage = JSON.parse(readFileSync(new URL("../cli/package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string> };
  const cliLock = JSON.parse(readFileSync(new URL("../cli/package-lock.json", import.meta.url), "utf8")) as { packages: Record<string, { version?: string; resolved?: string; integrity?: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }> };
  const rootSdk = rootLock.packages["node_modules/@trycua/cua-driver"];
  const cliSdk = cliLock.packages["node_modules/@trycua/cua-driver"];

  assert.equal(rootPackage.dependencies["@trycua/cua-driver"], CUA_DRIVER_VERSION);
  assert.equal(cliPackage.dependencies["@trycua/cua-driver"], CUA_DRIVER_VERSION);
  assert.equal(cliLock.packages[""]?.dependencies?.["@trycua/cua-driver"], CUA_DRIVER_VERSION);
  assert.equal(rootSdk?.version, CUA_DRIVER_VERSION);
  assert.deepEqual(cliSdk, rootSdk);
  const driverPackages = Object.keys(rootLock.packages).filter((name) => name.startsWith("node_modules/@trycua/cua-driver"));
  assert.ok(driverPackages.length > 1, "expected the pinned SDK and its platform packages in the root lockfile");
  for (const packageName of driverPackages) assert.deepEqual(cliLock.packages[packageName], rootLock.packages[packageName], packageName);
});

test("the SDK package version validator rejects a different Cua Driver release", () => {
  assert.doesNotThrow(() => validateCuaDriverPackageVersion(CUA_DRIVER_VERSION, "Installed Cua Driver package"));
  assert.throws(() => validateCuaDriverPackageVersion("0.33.2", "Installed Cua Driver package"), /requires 0\.37\.0/);
});
