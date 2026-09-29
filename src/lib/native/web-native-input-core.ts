import { isAbsolute, win32 } from "node:path";

export type NativeInputBrowser = "chrome" | "edge";

export const NATIVE_INPUT_HOST_NAME = "com.m9r.native_input";

export function nativeInputRegistryKey(browser: NativeInputBrowser): string {
  const vendor = browser === "chrome" ? "Google\\Chrome" : "Microsoft\\Edge";
  return `HKCU\\Software\\${vendor}\\NativeMessagingHosts\\${NATIVE_INPUT_HOST_NAME}`;
}

export function buildNativeInputManifest(hostPath: string, extensionId: string): string {
  if (!hostPath || (!isAbsolute(hostPath) && !win32.isAbsolute(hostPath)) || /[\u0000-\u001f]/.test(hostPath)) {
    throw new Error("native input host path must be absolute and valid");
  }
  if (!/^[a-p]{32}$/.test(extensionId)) throw new Error("native input extension ID is invalid");
  return JSON.stringify({
    name: NATIVE_INPUT_HOST_NAME,
    description: "M9R trusted pointer input for the currently visible Chrome or Edge page",
    path: hostPath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  }, null, 2) + "\n";
}

export function isNativeInputRegistrationConflict(input: {
  registeredPath: string | null;
  manifestPath: string;
  previouslyOwned: boolean;
}): boolean {
  return input.registeredPath !== null && (input.registeredPath !== input.manifestPath || !input.previouslyOwned);
}

export function isValidNativeInputRegistration(input: {
  browser: string;
  key: string;
  manifestPath: string;
  expectedManifestPath: string;
}): input is typeof input & { browser: NativeInputBrowser } {
  return (input.browser === "chrome" || input.browser === "edge")
    && input.key === nativeInputRegistryKey(input.browser)
    && input.manifestPath === input.expectedManifestPath;
}
