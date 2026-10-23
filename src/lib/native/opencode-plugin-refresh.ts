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

/**
 * The installer has had two manifest shapes over time:
 *
 * - the older web-setup manifest stores the plugin path/hash at the top level;
 * - the canonical native install manifest stores it as an `opencode-plugin`
 *   entry in `entries`.
 *
 * Both shapes are supported here so an update does not mistake M9R's own
 * current plugin for an external edit merely because the older manifest is
 * stale. A file is still overwritten only when its current hash matches the
 * hash recorded by the manifest we actually trust.
 */
interface ManagedPluginOwnership {
  path: string;
  hash: string;
  entryIndex?: number;
}

function readManagedPluginOwnership(manifest: Record<string, unknown>): ManagedPluginOwnership | null {
  if (typeof manifest.openCodeIdentityPluginPath === "string" && typeof manifest.openCodeIdentityPluginHash === "string") {
    return {
      path: manifest.openCodeIdentityPluginPath,
      hash: manifest.openCodeIdentityPluginHash,
    };
  }

  if (!Array.isArray(manifest.entries)) return null;
  const candidates = manifest.entries.flatMap((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    return record.kind === "opencode-plugin"
      && typeof record.path === "string"
      && typeof record.sha256After === "string"
      ? [{ path: record.path, hash: record.sha256After, entryIndex: index }]
      : [];
  });
  return candidates.length === 1 ? candidates[0]! : null;
}

function updateManagedPluginOwnership(
  manifest: Record<string, unknown>,
  ownership: ManagedPluginOwnership,
  pluginPath: string,
  hash: string,
): Record<string, unknown> {
  if (ownership.entryIndex !== undefined && Array.isArray(manifest.entries)) {
    const entries = [...manifest.entries];
    const entry = entries[ownership.entryIndex];
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      entries[ownership.entryIndex] = { ...(entry as Record<string, unknown>), path: pluginPath, sha256After: hash };
      return { ...manifest, entries };
    }
  }
  return {
    ...manifest,
    openCodeIdentityPluginPath: pluginPath,
    openCodeIdentityPluginHash: hash,
  };
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

  const ownership = readManagedPluginOwnership(manifest);
  if (!ownership) return { action: "not-managed", updated: false };

  const currentBytes = await dependencies.readFile(input.pluginPath);
  const desiredBytes = Buffer.isBuffer(input.desiredContent)
    ? Buffer.from(input.desiredContent)
    : Buffer.from(input.desiredContent, "utf8");
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const action = planOpenCodeIdentityPluginInstall({
    targetPath: input.pluginPath,
    currentHash: currentBytes ? hash(currentBytes) : null,
    desiredHash: hash(desiredBytes),
    ownedPath: ownership.path,
    ownedHash: ownership.hash,
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

    const nextManifest = updateManagedPluginOwnership(manifest, ownership, input.pluginPath, hash(desiredBytes));
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
