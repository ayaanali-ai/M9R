const DEVELOPMENT_EXTENSION_ID = "mahhaigfogjneccbmbpbedlnkhgdcmhb";
const CHROME_EXTENSION_ID_PATTERN = /^[a-p]{32}$/;

/**
 * Return the one M9R extension origin allowed to frame its isolated UI.
 * Development uses the fixed ID from the unpacked manifest. Production must
 * provide the Chrome Web Store ID once that listing exists; without it, CSP
 * stays fail-closed instead of permitting every extension origin.
 */
export function m9rExtensionFrameSource(
  configuredId: string | null | undefined,
  nodeEnv: string | undefined,
): string | null {
  const id = configuredId?.trim() || (nodeEnv === "development" ? DEVELOPMENT_EXTENSION_ID : "");
  if (!id) return null;
  if (!CHROME_EXTENSION_ID_PATTERN.test(id)) {
    throw new Error("M9R_WEB_EXTENSION_ID must be a 32-character Chrome extension ID using letters a-p");
  }
  return `chrome-extension://${id}`;
}
