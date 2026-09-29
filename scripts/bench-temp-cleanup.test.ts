import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { removeBenchTempDirectory } from "./bench/temp-cleanup";

test("benchmark temp cleanup refuses unknown roots without deleting them", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-cleanup-reject-"));
  const marker = join(root, "keep.txt");
  writeFileSync(marker, "must remain", "utf8");

  try {
    assert.throws(() => removeBenchTempDirectory(root, "m9r-bench-run-"), /Refusing to remove/);
    assert.equal(existsSync(marker), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("benchmark temp cleanup removes a direct generated root after validating its broker key", () => {
  const root = mkdtempSync(join(tmpdir(), "m9r-bench-e2e-cleanup-test-"));
  writeFileSync(join(root, "web-broker.key"), "test-only-key-material", "utf8");
  writeFileSync(join(root, "mode"), "hands-off\n", "utf8");

  removeBenchTempDirectory(root, "m9r-bench-e2e-");
  assert.equal(existsSync(root), false);
});
