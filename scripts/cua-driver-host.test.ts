import assert from "node:assert/strict";
import test from "node:test";
import { validateCuaDriverHostMetadata } from "../src/lib/native/cua-driver-host";

test("the standalone host accepts only the pinned driver and rejects configuration without retry classification by message", () => {
  assert.doesNotThrow(() => validateCuaDriverHostMetadata({ driverVersion: "0.34.0", embedded: false }));
  assert.throws(() => validateCuaDriverHostMetadata({ driverVersion: "0.33.4", embedded: false }), /requires 0\.34\.0/);
  assert.throws(() => validateCuaDriverHostMetadata({ driverVersion: "0.34.0", embedded: true }), /embedded mode/);
});
