import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Generated evidence: copy edited source and inventory generated/unowned paths
// without moving, staging, cleaning, or exposing the contents of those files.
const root = process.cwd();
const git = (...args) => execFileSync("git", args, { cwd: root, maxBuffer: 32 * 1024 * 1024 }).toString();
const paths = (args) => git(...args).split("\0").filter(Boolean);
const modified = paths(["ls-files", "--modified", "--deleted", "-z"]);
const untracked = paths(["ls-files", "--others", "--exclude-standard", "-z", "--", "src", "scripts", "services", "packages", "docs", "extensions", "native-input-host", "overlay", "pill", "launch-site"]);
const retainedPaths = git("status", "--porcelain=v1", "-z").split("\0").filter(x => x.startsWith("?? ")).map(x => x.slice(3)).filter(x => !untracked.includes(x));
const evidenceDirectory = resolve(root, ".test-tmp", `approved-list-baseline-${Date.now()}`);
mkdirSync(evidenceDirectory, { recursive: true });
const sourceRoots = /^(?:src|scripts|services|packages|docs|extensions|native-input-host|overlay|pill|launch-site)\//;
const generated = /^(?:\.test-tmp|cli\/dist-candidate[^/]*|node_modules)\//;
const inventory = [];
for (const relativePath of [...new Set([...modified, ...untracked])].sort()) {
  const path = resolve(root, relativePath);
  if (!path.startsWith(`${root}\\`) && !path.startsWith(`${root}/`)) throw new Error("Baseline path escaped repository");
  const tracked = modified.includes(relativePath);
  const classification = tracked ? "edited-tracked" : generated.test(relativePath) ? "generated-retained" : sourceRoots.test(relativePath) ? "untracked-source" : "unowned-retained";
  if (!existsSync(path)) { inventory.push({ path: relativePath, classification, exists: false }); continue; }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    inventory.push({ path: relativePath, classification, exists: true, copied: false, reason: "non-regular-file-retained" });
    continue;
  }
  const copied = classification === "edited-tracked" || classification === "untracked-source";
  if (!copied) {
    inventory.push({ path: relativePath, classification, exists: true, bytes: stat.size, copied: false });
    continue;
  }
  const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (copied) {
    const target = join(evidenceDirectory, "files", relativePath);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(path, target);
    if (createHash("sha256").update(readFileSync(target)).digest("hex") !== sha256) throw new Error("Baseline copy verification failed");
  }
  inventory.push({ path: relativePath, classification, exists: true, bytes: stat.size, sha256, copied });
}
const record = { recordedAt: new Date().toISOString(), root, branch: git("branch", "--show-current").trim(), commit: git("rev-parse", "HEAD").trim(), inventory, retainedPaths };
writeFileSync(join(evidenceDirectory, "inventory.json"), JSON.stringify(record, null, 2));
console.log(JSON.stringify({ evidenceDirectory, branch: record.branch, commit: record.commit, inventoried: inventory.length, copied: inventory.filter(x => x.copied).length, retainedOnly: inventory.filter(x => !x.copied).length }));
