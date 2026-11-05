import assert from "node:assert/strict";
import test from "node:test";
import { CUA_DRIVER_ARCHIVE_ASSETS, CUA_DRIVER_RUNTIME_ASSETS } from "./cua-runtime-assets.mjs";

test("CUA archive integrity covers every upstream file while runtime ships no compile-time ABI header", () => {
  assert.deepEqual([...CUA_DRIVER_ARCHIVE_ASSETS].sort(), [
    "cua-cursor-theme.exe",
    "cua-driver-uia.exe",
    "cua-driver.exe",
    "cua_driver_abi.h",
    "cua_driver_node_runtime.node",
    "cua_driver_sdk.dll",
  ]);
  assert.deepEqual(CUA_DRIVER_RUNTIME_ASSETS, [
    "cua-driver.exe",
    "cua-cursor-theme.exe",
    "cua-driver-uia.exe",
    "cua_driver_sdk.dll",
    "cua_driver_node_runtime.node",
  ]);
  assert.ok(!CUA_DRIVER_RUNTIME_ASSETS.includes("cua_driver_abi.h"));
});
