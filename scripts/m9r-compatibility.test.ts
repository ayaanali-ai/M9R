import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { migrateLegacyM9rDirectory, normalizeLegacyM9rEnvironment } from "../src/lib/native/m9r-compatibility.ts";

test("an old .oathlock install upgrades by copying into .m9r, keeps the source, and preserves new-side edits", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-upgrade-"));
  try {
    mkdirSync(join(root, ".oathlock", "agents"), { recursive: true });
    writeFileSync(join(root, ".oathlock", "agents", "claude.json"), "legacy config", "utf8");
    mkdirSync(join(root, ".m9r", "agents"), { recursive: true });
    writeFileSync(join(root, ".m9r", "agents", "claude.json"), "new config wins", "utf8");

    const result = migrateLegacyM9rDirectory(root);
    assert.deepEqual(result, { copiedFiles: 0, preservedFiles: 1, skippedSymlinks: 0, legacyDirectoryPresent: true });
    assert.equal(readFileSync(join(root, ".m9r", "agents", "claude.json"), "utf8"), "new config wins");
    assert.equal(readFileSync(join(root, ".oathlock", "agents", "claude.json"), "utf8"), "legacy config", "upgrade must not delete the old user data");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy environment variables are read as M9R names, while explicit M9R values take precedence", () => {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    OATHLOCK_API_URL: "https://old.example.test",
    OATHLOCK_CODEX_MODEL_ECONOMY: "old-model",
    M9R_API_URL: "https://new.example.test",
  };
  assert.equal(normalizeLegacyM9rEnvironment(env), 2);
  assert.equal(env.M9R_API_URL, "https://new.example.test");
  assert.equal(env.M9R_CODEX_MODEL_ECONOMY, "old-model");
});

test("an install with no .oathlock directory is a no-op", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-empty-upgrade-"));
  try {
    assert.deepEqual(migrateLegacyM9rDirectory(root), { copiedFiles: 0, preservedFiles: 0, skippedSymlinks: 0, legacyDirectoryPresent: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agent worktrees are not copied during the upgrade", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-worktrees-"));
  try {
    mkdirSync(join(root, ".oathlock", "worktrees", "claude-1"), { recursive: true });
    writeFileSync(join(root, ".oathlock", "worktrees", "claude-1", "big.bin"), "x", "utf8");
    mkdirSync(join(root, ".oathlock", "memory"), { recursive: true });
    writeFileSync(join(root, ".oathlock", "memory", "note.md"), "keep", "utf8");
    const result = migrateLegacyM9rDirectory(root);
    assert.equal(result.copiedFiles, 1);
    assert.equal(readFileSync(join(root, ".m9r", "memory", "note.md"), "utf8"), "keep");
    assert.throws(() => readFileSync(join(root, ".m9r", "worktrees", "claude-1", "big.bin"), "utf8"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
