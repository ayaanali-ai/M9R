import assert from "node:assert/strict";
import test from "node:test";
import {
  isValidLegacyNativeInputRegistration,
  LEGACY_NATIVE_INPUT_HOST_NAME,
  type LegacyBrowser,
} from "../src/lib/native/legacy-browser-extension-cleanup-core.ts";

test("legacy uninstall accepts only the recorded M9R browser registration and expected manifest path", () => {
  const path = "C:\\Users\\owner\\.m9r\\native-messaging\\com.m9r.native_input.json";
  const registration = { browser: "chrome", key: "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.m9r.native_input", manifestPath: path };
  assert.equal(LEGACY_NATIVE_INPUT_HOST_NAME, "com.m9r.native_input");
  assert.equal(isValidLegacyNativeInputRegistration({ ...registration, expectedManifestPath: path }), true);
  assert.equal(isValidLegacyNativeInputRegistration({ ...registration, expectedManifestPath: `${path}.other` }), false);
  assert.equal(isValidLegacyNativeInputRegistration({ ...registration, browser: "edge", expectedManifestPath: path }), false);
  assert.equal(isValidLegacyNativeInputRegistration({ ...registration, key: "HKCU\\Software\\other", expectedManifestPath: path }), false);
  const legacyBrowser: LegacyBrowser = "edge";
  assert.equal(legacyBrowser, "edge");
});
