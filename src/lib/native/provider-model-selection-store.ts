import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ManagedProviderConnectionProfile } from "./managed-provider-contract";
import type { ProviderModelSelection } from "./provider-model-core";

export interface ManagedProviderModelSelectionStore {
  load(connectionId: string, profile: ManagedProviderConnectionProfile): ProviderModelSelection | undefined;
  save(connectionId: string, profile: ManagedProviderConnectionProfile, selection: ProviderModelSelection): void;
}

interface PersistedSelection {
  version: 1;
  connectionId: string;
  handle: string;
  provider: string;
  cwd: string;
  model?: string;
  effort?: string;
}

function selectionPath(root: string, connectionId: string): string {
  const digest = createHash("sha256").update(connectionId, "utf8").digest("hex");
  return join(resolve(root), `${digest}.json`);
}

function normalizedSelection(selection: ProviderModelSelection): ProviderModelSelection {
  const model = typeof selection.model === "string" ? selection.model.trim() : "";
  const effort = typeof selection.effort === "string" ? selection.effort.trim() : "";
  if (effort && !model) throw new Error("a persisted provider effort requires a model");
  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
}

function isPersistedSelection(value: unknown, connectionId: string, profile: ManagedProviderConnectionProfile): value is PersistedSelection {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<PersistedSelection>;
  return record.version === 1
    && record.connectionId === connectionId
    && record.handle === profile.handle
    && record.provider === profile.provider
    && record.cwd === profile.cwd
    && (record.model === undefined || typeof record.model === "string")
    && (record.effort === undefined || typeof record.effort === "string")
    && !(record.effort && !record.model);
}

/**
 * Owner-local model selection state. It is profile-bound, atomic, and stores
 * only provider IDs; authentication, session IDs, prompts, and credentials
 * never enter this file. An empty selection removes the override so the
 * provider default/configured model is used on the next owner restart.
 */
export function createFileManagedProviderModelSelectionStore(root: string): ManagedProviderModelSelectionStore {
  const directory = resolve(root);
  return {
    load(connectionId, profile) {
      const path = selectionPath(directory, connectionId);
      if (!existsSync(path)) return undefined;
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
        if (!isPersistedSelection(parsed, connectionId, profile)) return undefined;
        return normalizedSelection({ model: parsed.model, effort: parsed.effort });
      } catch {
        return undefined;
      }
    },
    save(connectionId, profile, selection) {
      const normalized = normalizedSelection(selection);
      const path = selectionPath(directory, connectionId);
      if (!normalized.model && !normalized.effort) {
        rmSync(path, { force: true });
        return;
      }
      mkdirSync(directory, { recursive: true });
      const record: PersistedSelection = {
        version: 1,
        connectionId,
        handle: profile.handle,
        provider: profile.provider,
        cwd: profile.cwd,
        ...(normalized.model ? { model: normalized.model } : {}),
        ...(normalized.effort ? { effort: normalized.effort } : {}),
      };
      const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
      try {
        writeFileSync(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
        try { chmodSync(temporary, 0o600); } catch { /* Windows ACLs inherit from the M9R state root. */ }
        renameSync(temporary, path);
      } catch (error) {
        rmSync(temporary, { force: true });
        throw error;
      }
    },
  };
}
