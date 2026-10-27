import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";

// Verify extracted Git source before building. Generated files and dependency
// junctions are intentionally outside the tracked source inventory.
const [revision, directory] = process.argv.slice(2);
if (!revision || !directory) throw new Error("Usage: node scripts/verify-clean-source-snapshot.mjs <revision> <directory>");
const root = resolve(directory);
const commit = execFileSync("git", ["rev-parse", `${revision}^{commit}`], { encoding: "utf8" }).trim();
const records = execFileSync("git", ["ls-tree", "-r", "-z", commit], { maxBuffer: 16 * 1024 * 1024 }).toString().split("\0").filter(Boolean);
let verified = 0;
let normalizedLineEndings = 0;
for (const record of records) {
  const match = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(record);
  if (!match || match[2] !== "blob" || match[1] === "120000") throw new Error(`Unsupported source entry: ${record}`);
  const [, , , expected, path] = match;
  const contents = readFileSync(join(root, path));
  const actual = createHash("sha1").update(`blob ${contents.length}\0`).update(contents).digest("hex");
  if (actual !== expected) {
    // Git's Windows archive conversion can emit CRLF for text blobs. Permit
    // only that reversible conversion; binary or substantive changes fail.
    const text = contents.toString("utf8");
    const normalized = Buffer.from(text.replaceAll("\r\n", "\n"));
    const normalizedHash = createHash("sha1").update(`blob ${normalized.length}\0`).update(normalized).digest("hex");
    if (!Buffer.from(text).equals(contents) || normalizedHash !== expected) throw new Error(`Source differs from ${commit}: ${path}`);
    normalizedLineEndings++;
  }
  verified++;
}
console.log(JSON.stringify({ sourceCommit: commit, directory: root, trackedFilesVerified: verified, normalizedLineEndings }));
