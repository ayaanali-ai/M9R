import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "overlay/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // The CLI analyzer ships its own tsconfig/eslint setup; do not lint it
    // from the website root.
    "runleak-analyzer-mvp/**",
    // Standalone pitch-deck build helper (plain Node script, not app source).
    "oathlock-deck/**",
    // Generated CLI distributable (compiled from src by scripts/build-cli.mjs).
    "cli/dist/**",
    // Claude worktrees are separate generated checkouts, not this repository's
    // source tree. Linting them duplicates failures and makes the root result
    // depend on another agent's temporary workspace.
    ".claude/**",
  ]),
]);

export default eslintConfig;
