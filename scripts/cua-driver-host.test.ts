import assert from "node:assert/strict";
import test from "node:test";
import { CUA_DRIVER_VERSION, validateCuaDriverHostMetadata } from "../src/lib/native/cua-driver-host";

test("the standalone host accepts only the pinned driver and rejects configuration without retry classification by message", () => {
  const requiresVersion = new RegExp(`requires ${CUA_DRIVER_VERSION.replace(/\./g, "\\.")}`);
  assert.doesNotThrow(() => validateCuaDriverHostMetadata({ driverVersion: CUA_DRIVER_VERSION, embedded: false }));
  assert.throws(() => validateCuaDriverHostMetadata({ driverVersion: "0.33.4", embedded: false }), requiresVersion);
  assert.throws(() => validateCuaDriverHostMetadata({ driverVersion: CUA_DRIVER_VERSION, embedded: true }), /embedded mode/);
});
