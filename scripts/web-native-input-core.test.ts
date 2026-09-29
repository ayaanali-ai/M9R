import assert from "node:assert/strict";
import test from "node:test";
import {
  buildNativeInputManifest,
  isNativeInputRegistrationConflict,
  isValidNativeInputRegistration,
  nativeInputRegistryKey,
  NATIVE_INPUT_HOST_NAME,
} from "../src/lib/native/web-native-input-core.ts";

const extensionId = "mahhaigfogjneccbmbpbedlnkhgdcmhb";
const manifestPath = "C:\\Users\\owner\\.m9r\\native-messaging\\com.m9r.native_input.json";

test("native input uses only the current user's Chrome and Edge Native Messaging keys", () => {
  assert.equal(nativeInputRegistryKey("chrome"), "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.m9r.native_input");
  assert.equal(nativeInputRegistryKey("edge"), "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.m9r.native_input");
});

test("native input manifest grants exactly the fixed extension origin and an absolute host path", () => {
  const parsed = JSON.parse(buildNativeInputManifest("C:\\Users\\owner\\.m9r\\bin\\m9r-native-input-host.exe", extensionId));
  assert.deepEqual(parsed, {
    name: NATIVE_INPUT_HOST_NAME,
    description: "M9R trusted pointer input for the currently visible Chrome or Edge page",
    path: "C:\\Users\\owner\\.m9r\\bin\\m9r-native-input-host.exe",
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  });
  assert.throws(() => buildNativeInputManifest("C:\\host.exe", "<all_urls>"), /extension ID is invalid/);
  assert.throws(() => buildNativeInputManifest("bad\npath.exe", extensionId), /host path must be absolute and valid/);
});

test("registry setup reuses only the exact manifest path previously recorded as M9R-owned", () => {
  assert.equal(isNativeInputRegistrationConflict({ registeredPath: null, manifestPath, previouslyOwned: false }), false);
  assert.equal(isNativeInputRegistrationConflict({ registeredPath: manifestPath, manifestPath, previouslyOwned: true }), false);
  assert.equal(isNativeInputRegistrationConflict({ registeredPath: manifestPath, manifestPath, previouslyOwned: false }), true);
  assert.equal(isNativeInputRegistrationConflict({ registeredPath: "C:\\other\\host.json", manifestPath, previouslyOwned: true }), true);
  assert.equal(isValidNativeInputRegistration({ browser: "chrome", key: nativeInputRegistryKey("chrome"), manifestPath, expectedManifestPath: manifestPath }), true);
  assert.equal(isValidNativeInputRegistration({ browser: "chrome", key: nativeInputRegistryKey("edge"), manifestPath, expectedManifestPath: manifestPath }), false);
  assert.equal(isValidNativeInputRegistration({ browser: "other", key: "HKCU\\bad", manifestPath, expectedManifestPath: manifestPath }), false);
});
