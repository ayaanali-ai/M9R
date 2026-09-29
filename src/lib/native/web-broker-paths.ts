import { join } from "node:path";
import { userInfo } from "node:os";
import { rootTag } from "./hook-server";

export const DEFAULT_BROKER_PORT = 47821;

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
