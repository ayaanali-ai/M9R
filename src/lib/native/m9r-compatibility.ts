import { copyFileSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export const M9R_DATA_DIRECTORY = ".m9r";
export const LEGACY_OATHLOCK_DATA_DIRECTORY = ".oathlock";
export const LEGACY_ENV_PREFIX = "OATHLOCK_";
export const M9R_ENV_PREFIX = "M9R_";

export interface M9rDirectoryMigrationResult {
  copiedFiles: number;
  preservedFiles: number;
  skippedSymlinks: number;
  legacyDirectoryPresent: boolean;
}

/**
 * Copy old project-local state to the M9R directory without deleting or
 * overwriting anything. Existing M9R files win; symlinks are never followed.
 */
export function migrateLegacyM9rDirectory(rootPath: string): M9rDirectoryMigrationResult {
  const root = resolve(rootPath);
  const legacyRoot = join(root, LEGACY_OATHLOCK_DATA_DIRECTORY);
  const m9rRoot = join(root, M9R_DATA_DIRECTORY);
  const result: M9rDirectoryMigrationResult = { copiedFiles: 0, preservedFiles: 0, skippedSymlinks: 0, legacyDirectoryPresent: false };

  let legacyStat;
  try { legacyStat = lstatSync(legacyRoot); }
  catch { return result; }
  result.legacyDirectoryPresent = true;
  if (legacyStat.isSymbolicLink()) { result.skippedSymlinks += 1; return result; }
  if (!legacyStat.isDirectory()) return result;

  try {
    const current = lstatSync(m9rRoot);
    if (current.isSymbolicLink() || !current.isDirectory()) { result.skippedSymlinks += Number(current.isSymbolicLink()); return result; }
  } catch {
    mkdirSync(m9rRoot, { recursive: true, mode: 0o700 });
  }

  const copyDirectory = (source: string, destination: string, top = false): void => {
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      const from = join(source, entry.name);
      const to = join(destination, entry.name);
      // Agent worktrees are disposable, tied to absolute paths, and can be gigabytes: they are never copied.
      if (top && entry.isDirectory() && entry.name === "worktrees") continue;
      if (entry.isSymbolicLink()) { result.skippedSymlinks += 1; continue; }
      if (entry.isDirectory()) {
        try {
          const destStat = lstatSync(to);
          if (destStat.isSymbolicLink() || !destStat.isDirectory()) {
            result.skippedSymlinks += Number(destStat.isSymbolicLink());
            result.preservedFiles += Number(!destStat.isSymbolicLink());
            continue;
          }
        } catch { mkdirSync(to, { recursive: true, mode: 0o700 }); }
        copyDirectory(from, to);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const destStat = lstatSync(to);
        if (destStat.isSymbolicLink()) result.skippedSymlinks += 1;
        else result.preservedFiles += 1;
        continue;
      } catch { /* target does not exist; copy the old file */ }
      copyFileSync(from, to);
      result.copiedFiles += 1;
    }
  };

  copyDirectory(legacyRoot, m9rRoot, true);
  return result;
}

/** Prefer M9R_ names, but expose old OATHLOCK_ values to this process for one compatibility release. */
export function normalizeLegacyM9rEnvironment(env: Record<string, string | undefined>): number {
  let legacyVariablesSeen = 0;
  for (const [legacyName, value] of Object.entries(env)) {
    if (!legacyName.startsWith(LEGACY_ENV_PREFIX) || value === undefined) continue;
    legacyVariablesSeen += 1;
    const currentName = `${M9R_ENV_PREFIX}${legacyName.slice(LEGACY_ENV_PREFIX.length)}`;
    if (env[currentName] === undefined) env[currentName] = value;
  }
  return legacyVariablesSeen;
}

/** Read one canonical M9R variable while accepting its old OATHLOCK alias. */
export function m9rEnvironmentValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const canonicalName = name.startsWith(M9R_ENV_PREFIX) ? name : `${M9R_ENV_PREFIX}${name}`;
  const legacyName = `${LEGACY_ENV_PREFIX}${canonicalName.slice(M9R_ENV_PREFIX.length)}`;
  return env[canonicalName] ?? env[legacyName];
}
