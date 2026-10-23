import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // These test files are plain CommonJS by design (package.json has no "type":
  // "module", and they're run directly with `node`, not through a loader) -- they
  // require() the real extension source with node:vm's runInNewContext to exercise
  // it without a browser. Converting them to import would change how they're
  // invoked; the rule is right for app code, not for this.
  {
    files: [
      "scripts/background-tabgroups.test.js",
      "scripts/page-actions.test.js",
      "scripts/presence-frame-lifecycle.test.js",
      "scripts/try-presence-cursor-slots.test.js",
    ],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  // Same reasoning, different rule: this harness drives a real extension source
  // file loaded into a fresh vm context via runInNewContext, so its fake `chrome`
  // API and message shapes can't be precisely typed against real Chrome types.
  {
    files: ["scripts/pill-bridge.test.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
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
    // Project/user agent skills are instruction packages, not application code;
    // they intentionally carry their own examples and tool scripts.
    ".agents/**",
    // Local M9R runtime state, browser profiles, screenshots, and recovery
    // artifacts are generated data, not application source. Traversing them
    // makes root lint unbounded and can parse bundled third-party extensions.
    ".m9r/**",
    // Claude worktrees are separate generated checkouts, not this repository's
    // source tree. Linting them duplicates failures and makes the root result
    // depend on another agent's temporary workspace.
    ".claude/**",
    // M9R/Codex workers, broker snapshots, and activation/recovery evidence are
    // generated local data. The repository intentionally retains some of these
    // directories for audit review; they are not root application source.
    ".m9r-*/**",
    ".codex-*/**",
    // Private release-excluded marketing/archive material is deliberately kept
    // outside the public source tree and may have protected ACLs. It must not
    // be traversed by the root lint command.
    ".release-excluded/**",
    // Git worktrees are independent checkouts and must be linted from their
    // own roots, never as part of this repository's result.
    ".worktrees/**",
    // Packaged runtime output and disposable cutover/runtime trees are not
    // source inputs for the website/engine checkout.
    "engine/**",
    "dist/**",
    "m9r-runtime-clean-*/**",
    "m9r-clean-cutover-*/**",
    // Local scratch and tool caches are user/test data, not source.
    "scratchpad*/**",
    ".test-tmp/**",
    ".tmp/**",
    ".workcache/**",
    ".open-next/**",
    ".oathlock/**",
    ".playwright-mcp/**",
    ".vercel/**",
    ".wrangler/**",
    // Wrangler writes nested temporary bundles under service roots as well.
    "**/.wrangler/**",
  ]),
]);

export default eslintConfig;
