import { join } from "node:path";
import { userInfo } from "node:os";

export const DEFAULT_BROKER_PORT = 47821;

/** Stable per-M9R-home suffix for the owner named pipe. Kept here so the
 * broker path has no dependency on the retired provider-hook server. */
export function rootTag(root: string): string {
  let norm = root.replaceAll("/", "\\").toLowerCase();
  while (norm.endsWith("\\")) norm = norm.slice(0, -1);
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(norm, "utf8")) { hash ^= byte; hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash.toString(16).padStart(8, "0");
}

export function brokerKeyPath(root: string): string {
  return join(root, "web-broker.key");
}

function safeUser(): string {
  try { return userInfo().username.replace(/[^A-Za-z0-9_-]/g, "_"); } catch { return "user"; }
}

/** OS-user-owned control endpoint; never expose this path to browser/agent MCP clients. */
export function ownerPipePath(root: string, platform: NodeJS.Platform = process.platform, user = safeUser()): string {
  if (platform === "win32") return `\\\\.\\pipe\\m9r-owner-${user}-${rootTag(root)}`;
  return join(root, "owner.sock");
}
