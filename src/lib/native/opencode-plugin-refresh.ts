import { createHash } from "node:crypto";
import { planOpenCodeIdentityPluginInstall, type OpenCodeIdentityPluginInstallAction } from "./web-setup-core";

export type ManagedOpenCodeIdentityPluginRefreshAction = OpenCodeIdentityPluginInstallAction | "not-managed";

export interface ManagedOpenCodeIdentityPluginRefreshResult {
  action: ManagedOpenCodeIdentityPluginRefreshAction;
  updated: boolean;
}

export interface ManagedOpenCodeIdentityPluginRefreshDependencies {
  readFile(path: string): Promise<Buffer | null>;
  writeAtomic(path: string, bytes: Buffer): Promise<void>;
  removeFile(path: string): Promise<void>;
}

/** Update only the M9R-owned OpenCode identity plugin; never adopt or overwrite user edits. */
export async function refreshManagedOpenCodeIdentityPlugin(
  input: {
    manifestPath: string;
    pluginPath: string;
    desiredContent: string | Buffer;
    dryRun?: boolean;
  },
  dependencies: ManagedOpenCodeIdentityPluginRefreshDependencies,
): Promise<ManagedOpenCodeIdentityPluginRefreshResult> {
  const manifestBytes = await dependencies.readFile(input.manifestPath);
  if (!manifestBytes) return { action: "not-managed", updated: false };

  let manifest: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(manifestBytes.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { action: "not-managed", updated: false };
    manifest = parsed as Record<string, unknown>;
  } catch {
    return { action: "not-managed", updated: false };
  }

  const ownedPath = typeof manifest.openCodeIdentityPluginPath === "string"
    ? manifest.openCodeIdentityPluginPath
    : undefined;
  const ownedHash = typeof manifest.openCodeIdentityPluginHash === "string"
    ? manifest.openCodeIdentityPluginHash
    : undefined;
  if (!ownedPath || !ownedHash) return { action: "not-managed", updated: false };

  const currentBytes = await dependencies.readFile(input.pluginPath);
  const desiredBytes = Buffer.isBuffer(input.desiredContent)
    ? Buffer.from(input.desiredContent)
    : Buffer.from(input.desiredContent, "utf8");
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const action = planOpenCodeIdentityPluginInstall({
    targetPath: input.pluginPath,
    currentHash: currentBytes ? hash(currentBytes) : null,
    desiredHash: hash(desiredBytes),
    ownedPath,
    ownedHash,
  });

  if (action === "preserve" || action === "path-changed" || action === "unchanged" || input.dryRun) {
    return { action, updated: false };
  }

  let pluginWritten = false;
  try {
    await dependencies.writeAtomic(input.pluginPath, desiredBytes);
    pluginWritten = true;
    const verifiedBytes = await dependencies.readFile(input.pluginPath);
    if (!verifiedBytes || hash(verifiedBytes) !== hash(desiredBytes)) {
      throw new Error("The OpenCode plugin did not verify after its atomic update.");
    }

    const nextManifest = {
      ...manifest,
      openCodeIdentityPluginPath: input.pluginPath,
      openCodeIdentityPluginHash: hash(desiredBytes),
    };
    await dependencies.writeAtomic(input.manifestPath, Buffer.from(`${JSON.stringify(nextManifest, null, 2)}\n`, "utf8"));
  } catch (error) {
    if (pluginWritten) {
      try {
        if (currentBytes) await dependencies.writeAtomic(input.pluginPath, currentBytes);
        else await dependencies.removeFile(input.pluginPath);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "OpenCode plugin refresh failed and rollback also failed; inspect the M9R plugin and setup manifest before retrying.");
      }
    }
    throw error;
  }

  return { action, updated: true };
}
