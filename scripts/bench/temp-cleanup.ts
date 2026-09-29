import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export type BenchTempPrefix = "m9r-bench-e2e-" | "m9r-bench-run-";

/**
 * Removes only a benchmark-owned direct child of the OS temp directory.
 * The broker deliberately ACL-locks its key against the sandbox group on Windows;
 * undo that test-only deny on the key before deleting the temporary tree.
 */
export function removeBenchTempDirectory(root: string, prefix: BenchTempPrefix): void {
  if (prefix !== "m9r-bench-e2e-" && prefix !== "m9r-bench-run-") {
    throw new Error(`Refusing to remove a benchmark directory with an unsupported prefix: ${prefix}`);
  }

  const target = resolve(root);
  const tempRoot = resolve(tmpdir());
  if (dirname(target) !== tempRoot || !basename(target).startsWith(prefix)) {
    throw new Error(`Refusing to remove a path outside the expected ${prefix} temp directory`);
  }

  const rootStat = lstatSync(target);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Refusing to remove a non-directory benchmark temp root: ${target}`);
  }

  const keyPath = join(target, "web-broker.key");
  if (!existsSync(keyPath) || !lstatSync(keyPath).isFile()) {
    throw new Error(`Refusing to remove a benchmark temp root without its broker key: ${target}`);
  }

  if (process.platform === "win32") {
    const username = userInfo().username;
    if (!username) throw new Error("Cannot restore benchmark broker-key ACL without the current Windows user");

    for (const group of ["CodexSandboxUsers", "CodexSandboxOffline"]) {
      const result = spawnSync("icacls", [keyPath, "/remove:d", group], {
        encoding: "utf8",
        windowsHide: true,
      });
      if (result.error || result.status !== 0) {
        throw new Error(`Could not remove the temporary broker-key deny for ${group}: ${result.error?.message ?? result.stderr ?? result.stdout ?? `icacls exited ${result.status}`}`);
      }
    }

    const grant = spawnSync("icacls", [keyPath, "/grant:r", `${username}:(F)`], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (grant.error || grant.status !== 0) {
      throw new Error(`Could not restore current-user access to the temporary broker key: ${grant.error?.message ?? grant.stderr ?? grant.stdout ?? `icacls exited ${grant.status}`}`);
    }
  }

  rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
