import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = join(import.meta.dirname, "..");
const eslintConfig = readFileSync(join(repoRoot, "eslint.config.mjs"), "utf8");

test("root ESLint excludes retained generated data and nested worktrees", () => {
  const requiredBoundaries = [
    ".m9r-*/**",
    ".codex-*/**",
    ".agents/**",
    ".worktrees/**",
    "engine/**",
    "dist/**",
    "m9r-runtime-clean-*/**",
    "m9r-clean-cutover-*/**",
    "scratchpad*/**",
    ".test-tmp/**",
    ".tmp/**",
    ".workcache/**",
    ".open-next/**",
    ".oathlock/**",
    ".playwright-mcp/**",
    ".vercel/**",
    ".wrangler/**",
    "**/.wrangler/**",
  ];

  for (const boundary of requiredBoundaries) {
    assert.ok(eslintConfig.includes(`"${boundary}"`), `root ESLint must explicitly ignore ${boundary}`);
  }
});
