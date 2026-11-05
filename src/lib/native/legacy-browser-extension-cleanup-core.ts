/**
 * Compatibility validation for uninstalling registrations created by the
 * retired browser extension. This module cannot create or install a host.
 */
export type LegacyBrowser = "chrome" | "edge";

export const LEGACY_NATIVE_INPUT_HOST_NAME = "com.m9r.native_input";

function legacyNativeInputRegistryKey(browser: LegacyBrowser): string {
  const vendor = browser === "chrome" ? "Google\\Chrome" : "Microsoft\\Edge";
  return `HKCU\\Software\\${vendor}\\NativeMessagingHosts\\${LEGACY_NATIVE_INPUT_HOST_NAME}`;
}

export function isValidLegacyNativeInputRegistration(input: {
  browser: string;
  key: string;
  manifestPath: string;
  expectedManifestPath: string;
}): input is typeof input & { browser: LegacyBrowser } {
  return (input.browser === "chrome" || input.browser === "edge")
    && input.key === legacyNativeInputRegistryKey(input.browser)
    && input.manifestPath === input.expectedManifestPath;
}
