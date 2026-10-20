import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const publicSurfaceScript = join(repoRoot, "scripts", "open-core-public-surface-check.mjs");
const releaseManifestScript = join(repoRoot, "scripts", "open-core-release-manifest.mjs");

function write(root, path, content = "") {
  const target = join(root, path);
  mkdirSync(resolve(target, ".."), { recursive: true });
  writeFileSync(target, content);
}

function runGit(root, args) {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

test("release-boundary scanners tolerate a large Git inventory and held directories", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-release-boundary-"));
  try {
    const publicDocs = [
      "OPEN_CORE.md",
      "COMPATIBILITY.md",
      "HOSTED_TERMS_DRAFT.md",
      "TRADEMARK_POLICY.md",
      "THIRD_PARTY_NOTICES.md",
      "docs/PUBLIC_RELEASE_ALLOWLIST.md",
      "docs/OPEN_CORE_ARCHITECTURE.md",
      "docs/OPEN_CORE_COMMERCIAL_BOUNDARY.md",
      "docs/OPEN_CORE_LEGAL_REVIEW.md",
      "packages/runtime-core/LICENSE",
      "packages/runtime-core/NOTICE",
    ];
    for (const path of publicDocs) write(root, path);
    write(root, "OPEN_CORE_ANNOUNCEMENT.md", [
      "source-available open-core release",
      "not an announcement that this is OSI-approved open source",
      "terminal/resident features are experimental",
      "provider connections remain customer-authorized and provider-specific",
      "does not transfer provider keys or pool customer credentials",
    ].join("\n"));
    write(root, "OPEN_CORE_LAUNCH_PLAN.md", "production-ready terminal is explicitly labeled experimental\nTerminal demo — deferred\n");
    write(root, "README.md", "Implemented in the current code path. Provider-attributed live completion is a separate release gate. Provider availability and quotas can prevent a turn.\n");
    write(root, "packages/runtime-core/package.json", JSON.stringify({ private: false, license: "Apache-2.0" }));

    // This inventory is intentionally larger than Node's historical 1 MiB
    // execFileSync default. It reproduces the old ENOBUFS failure.
    const longName = "x".repeat(150);
    mkdirSync(join(root, "inventory"), { recursive: true });
    for (let index = 0; index < 8_000; index += 1) {
      writeFileSync(join(root, "inventory", `${String(index).padStart(5, "0")}-${longName}.txt`), "");
    }

    // The release candidate must not try to read a held directory as a file.
    // Its contents are deliberately left untracked, like retained local evidence.
    write(root, "held-evidence/notes.txt", "retained locally");

    runGit(root, ["init", "--quiet"]);
    runGit(root, ["add", "."]);

    const run = (script, args = []) => execFileSync(process.execPath, [script, ...args], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });

    assert.match(run(publicSurfaceScript), /Public-surface gate: PASS/);
    assert.match(run(releaseManifestScript, ["--check"]), /Release manifest check: PASS/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
