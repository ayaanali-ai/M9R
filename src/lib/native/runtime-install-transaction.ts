import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

type RuntimeFile = { from: string; to: string };
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const DEFAULT_COMPLETED_TRANSACTION_RETENTION = 0;

function isCompletedFileManifest(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const file = entry as Record<string, unknown>;
    if (typeof file.path !== "string" || !file.path || file.path.includes("\0")
      || isAbsolute(file.path) || file.path.includes(":")
      || file.path.split(/[\\/]+/).some((segment) => !segment || segment === "." || segment === "..")
      || !/^[a-f0-9]{64}$/i.test(String(file.sha256 ?? ""))
      || typeof file.existed !== "boolean") return false;
    const previousHashValid = file.existed
      ? typeof file.previousSha256 === "string" && /^[a-f0-9]{64}$/i.test(file.previousSha256)
      : file.previousSha256 === null;
    if (!previousHashValid) return false;
    const key = process.platform === "win32" ? file.path.toLowerCase() : file.path;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

type SnapshotManifest = ReadonlyMap<string, string>;

function normalizeSnapshotPath(path: string): string {
  // Journals are written with the host platform's separator, while snapshot
  // traversal below deliberately builds portable `/`-separated relative
  // paths. Normalize both forms before comparing them; otherwise every
  // Windows transaction containing a nested runtime file is treated as
  // unverifiable and is retained forever.
  const normalized = path.replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function inspectSnapshot(snapshotRoot: string, expectedFiles: SnapshotManifest): Array<{ path: string; sha256: string }> | null {
  if (!existsSync(snapshotRoot)) return [];
  try {
    const rootInfo = lstatSync(snapshotRoot);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) return null;

    const expectedDirectories = new Set<string>();
    for (const filePath of expectedFiles.keys()) {
      const segments = filePath.split(/[\\/]+/);
      for (let index = 1; index < segments.length; index += 1) {
        expectedDirectories.add(normalizeSnapshotPath(segments.slice(0, index).join("/")));
      }
    }

    const found: Array<{ path: string; sha256: string }> = [];
    const visit = (directory: string, relativeDirectory: string): boolean => {
      for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
        const key = normalizeSnapshotPath(relativePath);
        const info = lstatSync(path);
        if (info.isSymbolicLink()) return false;
        if (info.isDirectory()) {
          if (!expectedDirectories.has(key) || !visit(path, relativePath)) return false;
          continue;
        }
        if (!info.isFile()) return false;
        const sha256 = expectedFiles.get(key);
        if (!sha256 || digest(path) !== sha256) return false;
        found.push({ path, sha256 });
      }
      return true;
    };

    return visit(snapshotRoot, "") ? found : null;
  } catch {
    return null;
  }
}

function removeVerifiedSnapshot(snapshotRoot: string, expectedFiles: SnapshotManifest): void {
  const files = inspectSnapshot(snapshotRoot, expectedFiles);
  if (!files) throw new Error("Completed runtime snapshot contains unexpected or changed data.");
  if (!existsSync(snapshotRoot)) return;

  const directories: string[] = [];
  const collectDirectories = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) throw new Error("Completed runtime snapshot changed during cleanup.");
      if (info.isDirectory()) collectDirectories(path);
    }
    directories.push(directory);
  };
  collectDirectories(snapshotRoot);

  for (const file of files) {
    const info = lstatSync(file.path);
    if (info.isSymbolicLink() || !info.isFile() || digest(file.path) !== file.sha256) {
      throw new Error("Completed runtime snapshot changed during cleanup.");
    }
    unlinkSync(file.path);
  }
  for (const directory of directories) rmdirSync(directory);
}

function rejectRedirectedAncestors(path: string): void {
  for (let ancestor = resolve(path); ; ancestor = dirname(ancestor)) {
    if (existsSync(ancestor) && lstatSync(ancestor).isSymbolicLink()) throw new Error("Runtime path traverses a symbolic link.");
    if (ancestor === dirname(ancestor)) break;
  }
}

export function hasPendingRuntimeTransaction(targetDir: string): boolean {
  const backupRoot = join(dirname(resolve(targetDir)), "runtime-backups");
  if (!existsSync(backupRoot)) return false;
  rejectRedirectedAncestors(backupRoot);
  return readdirSync(backupRoot).some((name) => {
    if (!/^[a-f0-9-]{36}$/.test(name)) return false;
    const journal = join(backupRoot, name, "transaction.json");
    if (!existsSync(journal)) return false;
    rejectRedirectedAncestors(journal);
    if (!lstatSync(journal).isFile() || lstatSync(journal).size > 2 * 1024 * 1024) throw new Error("Runtime recovery journal is unsafe; preserved for inspection.");
    try {
      const record = JSON.parse(readFileSync(journal, "utf8"));
      return record.status === "applying" || record.status === "rollback_failed";
    } catch { throw new Error("Runtime recovery journal is unreadable; preserved for inspection."); }
  });
}

/**
 * Remove completed runtime transaction snapshots without touching evidence
 * needed to recover an interrupted or failed update. The previous files exist
 * only until the new runtime verifies or the prior runtime is fully restored;
 * retaining completed copies creates stale generations on disk.
 *
 * Unknown, malformed, foreign-target, applying, and rollback_failed journals
 * are deliberately retained.  They may be needed for recovery or inspection,
 * and an updater must never turn uncertainty into deletion.
 */
export function pruneCompletedRuntimeTransactions(targetDir: string, keepCount = DEFAULT_COMPLETED_TRANSACTION_RETENTION): string[] {
  if (!Number.isInteger(keepCount) || keepCount < 0 || keepCount > 32) throw new Error("Runtime backup retention count is invalid.");
  const root = resolve(targetDir);
  const backupRoot = join(dirname(root), "runtime-backups");
  const pruned: string[] = [];
  try {
    if (!existsSync(backupRoot)) return pruned;
    rejectRedirectedAncestors(backupRoot);
    const backupRootInfo = lstatSync(backupRoot);
    if (backupRootInfo.isSymbolicLink() || !backupRootInfo.isDirectory()) return pruned;

    const normalizedRoot = process.platform === "win32" ? root.toLowerCase() : root;
    const completed: Array<{
      path: string;
      mtimeMs: number;
      journalHash: string;
      nextFiles: SnapshotManifest;
      previousFiles: SnapshotManifest;
    }> = [];
    for (const name of readdirSync(backupRoot)) {
      if (!/^[a-f0-9-]{36}$/.test(name)) continue;
      const transaction = join(backupRoot, name);
      let transactionInfo: ReturnType<typeof lstatSync>;
      try { transactionInfo = lstatSync(transaction); } catch { continue; }
      if (transactionInfo.isSymbolicLink() || !transactionInfo.isDirectory()) continue;
      const journal = join(transaction, "transaction.json");
      if (!existsSync(journal)) {
        // A crash can occur after creating the UUID directory but before writing
        // its journal. Remove only a provably empty directory; never guess about
        // unjournaled contents.
        try {
          if (readdirSync(transaction).length === 0) rmdirSync(transaction);
        } catch { /* inaccessible or non-empty directories are preserved */ }
        continue;
      }
      let journalInfo: ReturnType<typeof lstatSync>;
      try { journalInfo = lstatSync(journal); } catch { continue; }
      if (journalInfo.isSymbolicLink() || !journalInfo.isFile() || journalInfo.size > 2 * 1024 * 1024) continue;
      let record: { status?: unknown; targetDir?: unknown; files?: unknown };
      try { record = JSON.parse(readFileSync(journal, "utf8")) as typeof record; } catch { continue; }
      const recordedTarget = typeof record.targetDir === "string" ? resolve(record.targetDir) : "";
      if ((record.status !== "committed" && record.status !== "rolled_back")
        || (process.platform === "win32" ? recordedTarget.toLowerCase() : recordedTarget) !== normalizedRoot
        || !isCompletedFileManifest(record.files)) continue;
      const manifest = record.files as Array<{ path: string; sha256: string; existed: boolean; previousSha256: string | null }>;
      const nextFiles = new Map(manifest.map((file) => [normalizeSnapshotPath(file.path), file.sha256.toLowerCase()]));
      const previousFiles = new Map(manifest
        .filter((file) => file.existed)
        .map((file) => [normalizeSnapshotPath(file.path), file.previousSha256!.toLowerCase()]));
      let children: string[];
      try { children = readdirSync(transaction); } catch { continue; }
      if (children.some((child) => child !== "transaction.json" && child !== "next" && child !== "previous")) continue;
      let safeChildren = true;
      for (const child of ["next", "previous"]) {
        if (!children.includes(child)) continue;
        const path = join(transaction, child);
        let info: ReturnType<typeof lstatSync>;
        try { info = lstatSync(path); } catch { safeChildren = false; break; }
        if (info.isSymbolicLink() || !info.isDirectory()) safeChildren = false;
      }
      if (!safeChildren) continue;
      if (!inspectSnapshot(join(transaction, "next"), nextFiles)
        || !inspectSnapshot(join(transaction, "previous"), previousFiles)) continue;
      completed.push({
        path: transaction,
        mtimeMs: Math.max(transactionInfo.mtimeMs, journalInfo.mtimeMs),
        journalHash: digest(journal),
        nextFiles,
        previousFiles,
      });
    }

    completed.sort((a, b) => b.mtimeMs - a.mtimeMs || b.path.localeCompare(a.path));
    for (const entry of completed.slice(keepCount)) {
      try {
        // Remove bulk data before its journal. If a locked file interrupts
        // cleanup, the terminal journal remains so a later pass can safely retry.
        const children = readdirSync(entry.path);
        if (children.some((child) => child !== "transaction.json" && child !== "next" && child !== "previous")) {
          throw new Error("Completed runtime transaction changed during cleanup.");
        }
        removeVerifiedSnapshot(join(entry.path, "next"), entry.nextFiles);
        removeVerifiedSnapshot(join(entry.path, "previous"), entry.previousFiles);
        const journal = join(entry.path, "transaction.json");
        const journalInfo = lstatSync(journal);
        if (journalInfo.isSymbolicLink() || !journalInfo.isFile() || digest(journal) !== entry.journalHash) {
          throw new Error("Completed runtime journal changed during cleanup.");
        }
        unlinkSync(journal);
        rmdirSync(entry.path);
        if (!existsSync(entry.path)) pruned.push(entry.path);
      } catch { /* A locked snapshot remains recoverable and is retried on a later update. */ }
    }
  } catch {
    // Retention is best-effort cleanup; an unreadable or redirected backup
    // directory must not turn a verified runtime install into a failed setup.
  }
  return pruned;
}

/** Stage and verify every file before replacing any; restore the entire prior set on failure.
 * Callers must quiesce their owned services first. This does not claim an atomic directory switch.
 */
export function installRuntimeTransaction(targetDir: string, files: readonly RuntimeFile[],
  replace: (from: string, to: string) => string[]): string[] {
  const root = resolve(targetDir);
  rejectRedirectedAncestors(root);
  rejectRedirectedAncestors(join(dirname(root), "runtime-backups"));
  const seen = new Set<string>();
  const plan = files.map((file) => {
    const path = relative(root, resolve(file.to));
    if (!path || isAbsolute(path) || path === ".." || path.startsWith("..\\") || path.startsWith("../")) throw new Error("Runtime destination is outside the installation directory.");
    const key = process.platform === "win32" ? path.toLowerCase() : path;
    if (seen.has(key)) throw new Error("Duplicate runtime destination.");
    seen.add(key);
    if (!lstatSync(file.from).isFile() || lstatSync(file.from).isSymbolicLink()) throw new Error("Runtime source must be a regular file.");
    // Refuse redirection through a junction/symlink in the destination ancestry.
    for (let ancestor = dirname(resolve(file.to)); ; ancestor = dirname(ancestor)) {
      if (existsSync(ancestor) && lstatSync(ancestor).isSymbolicLink()) throw new Error("Runtime destination traverses a symbolic link.");
      if (ancestor === root || ancestor === dirname(ancestor)) break;
    }
    if (existsSync(file.to) && (!lstatSync(file.to).isFile() || lstatSync(file.to).isSymbolicLink())) throw new Error("Runtime target must be a regular file.");
    return { ...file, path, sha256: digest(file.from), existed: existsSync(file.to), previousSha256: existsSync(file.to) ? digest(file.to) : null };
  });
  const transaction = join(dirname(root), "runtime-backups", randomUUID());
  mkdirSync(transaction, { recursive: true });
  const record = { status: "preparing", targetDir: root, files: plan.map(({ path, sha256, existed, previousSha256 }) => ({ path, sha256, existed, previousSha256 })) };
  const journal = () => writeFileSync(join(transaction, "transaction.json"), JSON.stringify(record, null, 2) + "\n");
  journal();
  const applied: typeof plan = [];
  const retired: string[] = [];
  try {
    for (const file of plan) {
      const staged = join(transaction, "next", file.path);
      mkdirSync(dirname(staged), { recursive: true });
      copyFileSync(file.from, staged);
      if (digest(staged) !== file.sha256) throw new Error("Staged runtime hash mismatch.");
      if (file.existed) {
        const backup = join(transaction, "previous", file.path);
        mkdirSync(dirname(backup), { recursive: true });
        copyFileSync(file.to, backup);
        if (digest(backup) !== file.previousSha256) throw new Error("Runtime backup hash mismatch.");
      }
    }
    record.status = "applying";
    journal();
    for (const file of plan) {
      // Include a possibly partially replaced target in rollback.
      applied.push(file);
      mkdirSync(dirname(file.to), { recursive: true });
      retired.push(...replace(join(transaction, "next", file.path), file.to));
      if (digest(file.to) !== file.sha256) throw new Error("Installed runtime hash mismatch.");
    }
    record.status = "committed";
    journal();
    // Rollback evidence is no longer needed after the complete new set verifies.
    // Cleanup failure must not roll back the already verified runtime.
    try { pruneCompletedRuntimeTransactions(root); } catch { /* cleanup is retried without rolling back the verified runtime */ }
    return [...retired, ...plan.map((file) => file.to)];
  } catch (error) {
    const failures: string[] = [];
    for (const file of applied.reverse()) {
      try {
        if (file.existed) {
          const previous = join(transaction, "previous", file.path);
          replace(previous, file.to);
          if (digest(previous) !== digest(file.to)) throw new Error("Rollback hash mismatch.");
        } else rmSync(file.to, { force: true });
      } catch { failures.push(file.path); }
    }
    record.status = failures.length ? "rollback_failed" : "rolled_back";
    journal();
    if (failures.length === 0) {
      try { pruneCompletedRuntimeTransactions(root); } catch { /* a later setup retries cleanup; preserve the original update error */ }
    }
    const recoveryMessage = failures.length
      ? `Runtime update failed and rollback requires recovery for ${failures.join(", ")}. Preserved transaction: ${transaction}`
      : `Runtime update failed; the previous runtime was restored. Preserved transaction: ${transaction}`;
    const causeMessage = error instanceof Error && error.message
      ? ` Cause: ${error.message.slice(0, 512)}`
      : "";
    throw new Error(`${recoveryMessage}${causeMessage}`, { cause: error });
  }
}

/** Recover an interrupted, fully staged update before another approved setup applies files. */
export function recoverRuntimeTransactions(targetDir: string, replace: (from: string, to: string) => string[]): void {
  const root = resolve(targetDir);
  rejectRedirectedAncestors(root);
  const backupRoot = join(dirname(root), "runtime-backups");
  if (!existsSync(backupRoot)) return;
  if (lstatSync(backupRoot).isSymbolicLink()) throw new Error("Runtime backup directory is a symbolic link.");
  for (const name of readdirSync(backupRoot)) {
    if (!/^[a-f0-9-]{36}$/.test(name)) continue;
    const transaction = join(backupRoot, name);
    const journal = join(transaction, "transaction.json");
    if (!existsSync(journal)) continue;
    if (lstatSync(transaction).isSymbolicLink() || lstatSync(journal).isSymbolicLink() || lstatSync(journal).size > 2 * 1024 * 1024) throw new Error("Runtime recovery journal is unsafe; preserved for inspection.");
    const record = JSON.parse(readFileSync(journal, "utf8"));
    if (record.status !== "applying" && record.status !== "rollback_failed") continue;
    if (record.targetDir !== root || !Array.isArray(record.files)) throw new Error("Runtime recovery journal does not match this installation.");
    const seen = new Set<string>();
    const files: Array<{ existed: boolean; target: string; previous: string; previousSha256?: string }> = record.files.map((file: { path: string; existed: boolean; previousSha256?: string }) => {
      if (!file || typeof file !== "object") throw new Error("Invalid runtime recovery file.");
      if (typeof file.path !== "string" || !file.path || isAbsolute(file.path) || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(file.path)
        || file.path.includes(":") || typeof file.existed !== "boolean") throw new Error("Invalid runtime recovery destination.");
      const target = join(root, file.path);
      const previous = join(transaction, "previous", file.path);
      const key = process.platform === "win32" ? resolve(target).toLowerCase() : resolve(target);
      if (resolve(target) === root || seen.has(key)) throw new Error("Duplicate or invalid runtime recovery destination.");
      seen.add(key);
      for (let ancestor = dirname(previous); ; ancestor = dirname(ancestor)) {
        if (existsSync(ancestor) && lstatSync(ancestor).isSymbolicLink()) throw new Error("Runtime recovery backup traverses a symbolic link.");
        if (ancestor === transaction || ancestor === dirname(ancestor)) break;
      }
      if (file.existed && (!/^[a-f0-9]{64}$/.test(file.previousSha256 ?? "") || !existsSync(previous)
        || !lstatSync(previous).isFile() || lstatSync(previous).isSymbolicLink() || digest(previous) !== file.previousSha256)) throw new Error("Runtime recovery backup hash mismatch; preserved for inspection.");
      for (let ancestor = dirname(target); ; ancestor = dirname(ancestor)) {
        if (existsSync(ancestor) && lstatSync(ancestor).isSymbolicLink()) throw new Error("Runtime recovery destination traverses a symbolic link.");
        if (ancestor === root || ancestor === dirname(ancestor)) break;
      }
      if (existsSync(target) && (!lstatSync(target).isFile() || lstatSync(target).isSymbolicLink())) throw new Error("Runtime recovery target is not a regular file.");
      return { ...file, target, previous };
    });
    for (const file of files) {
      if (file.existed) {
        mkdirSync(dirname(file.target), { recursive: true });
        replace(file.previous, file.target);
        if (digest(file.target) !== file.previousSha256) throw new Error("Runtime recovery did not restore the verified backup.");
      } else rmSync(file.target, { force: true });
    }
    record.status = "rolled_back";
    writeFileSync(journal, JSON.stringify(record, null, 2) + "\n");
  }
  pruneCompletedRuntimeTransactions(root);
}
