import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

type RuntimeFile = { from: string; to: string };
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const DEFAULT_COMMITTED_BACKUP_RETENTION = 3;

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
 * Bound successful runtime snapshots without touching evidence needed to recover
 * an interrupted or failed update.  A setup can run many times in one day, and
 * each successful transaction contains a full copy of the runtime.  Keeping
 * every committed snapshot makes the local installation grow without bound;
 * keeping the newest small rollback window preserves recovery while draining
 * redundant history.
 *
 * Unknown, malformed, foreign-target, applying, and rollback_failed journals
 * are deliberately retained.  They may be needed for recovery or inspection,
 * and an updater must never turn uncertainty into deletion.
 */
export function pruneCommittedRuntimeBackups(targetDir: string, keepCount = DEFAULT_COMMITTED_BACKUP_RETENTION): string[] {
  if (!Number.isInteger(keepCount) || keepCount < 1 || keepCount > 32) throw new Error("Runtime backup retention count is invalid.");
  const root = resolve(targetDir);
  const backupRoot = join(dirname(root), "runtime-backups");
  if (!existsSync(backupRoot)) return [];
  rejectRedirectedAncestors(backupRoot);
  const backupRootInfo = lstatSync(backupRoot);
  if (backupRootInfo.isSymbolicLink() || !backupRootInfo.isDirectory()) throw new Error("Runtime backup directory is unsafe; preserved for inspection.");

  const normalizedRoot = process.platform === "win32" ? root.toLowerCase() : root;
  const committed: Array<{ path: string; mtimeMs: number }> = [];
  for (const name of readdirSync(backupRoot)) {
    if (!/^[a-f0-9-]{36}$/.test(name)) continue;
    const transaction = join(backupRoot, name);
    const transactionInfo = lstatSync(transaction);
    if (transactionInfo.isSymbolicLink() || !transactionInfo.isDirectory()) continue;
    const journal = join(transaction, "transaction.json");
    if (!existsSync(journal)) continue;
    const journalInfo = lstatSync(journal);
    if (journalInfo.isSymbolicLink() || !journalInfo.isFile() || journalInfo.size > 2 * 1024 * 1024) continue;
    let record: { status?: unknown; targetDir?: unknown; files?: unknown };
    try { record = JSON.parse(readFileSync(journal, "utf8")) as typeof record; } catch { continue; }
    const recordedTarget = typeof record.targetDir === "string" ? resolve(record.targetDir) : "";
    if (record.status !== "committed" || (process.platform === "win32" ? recordedTarget.toLowerCase() : recordedTarget) !== normalizedRoot || !Array.isArray(record.files)) continue;
    committed.push({ path: transaction, mtimeMs: Math.max(transactionInfo.mtimeMs, journalInfo.mtimeMs) });
  }

  committed.sort((a, b) => b.mtimeMs - a.mtimeMs || b.path.localeCompare(a.path));
  const pruned: string[] = [];
  for (const entry of committed.slice(keepCount)) {
    try {
      rmSync(entry.path, { recursive: true, force: true });
      if (!existsSync(entry.path)) pruned.push(entry.path);
    } catch { /* A locked snapshot remains recoverable and is retried on a later update. */ }
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
    // Retain the prior set and journal for explicit rollback; staging is disposable.
    rmSync(join(transaction, "next"), { recursive: true, force: true });
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
    throw new Error(failures.length
      ? `Runtime update failed and rollback requires recovery for ${failures.join(", ")}. Preserved transaction: ${transaction}`
      : `Runtime update failed; the previous runtime was restored. Preserved transaction: ${transaction}`, { cause: error });
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
}
