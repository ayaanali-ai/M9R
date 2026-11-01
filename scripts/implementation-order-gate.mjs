import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tempRoot = resolve(root, ".test-tmp");
const cliOut = resolve(tempRoot, "implementation-order-cli-dist");
mkdirSync(tempRoot, { recursive: true });

const env = { ...process.env, TEMP: tempRoot, TMP: tempRoot, M9R_CLI_OUTPUT_DIR: cliOut };
// Keep provider adapter fixtures serial: they intentionally exercise one
// process/port lifecycle and parallel file workers can race their fake ACP
// catalogs even when the implementation is correct.
const nodeArgs = ["--test-concurrency=1", "--disable-warning=ExperimentalWarning", "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--import", "./scripts/register-alias.mjs"];
const checks = [
  ["CUA driver (44 tests)", ["--test", "./scripts/cua-stage-driver.test.ts"]],
  ["desktop stage and task lifecycle", ["--test", "./scripts/task-desktop-stage.test.ts", "./scripts/windows-desktop-stage.test.ts"]],
  ["web lifecycle and redirectable pause", ["--test", "./scripts/web-live-sessions.test.ts"]],
  ["browser mutation fixtures", ["--test", "./scripts/web-press-page-change.test.ts"]],
  ["universal intent and bounded workflow memory", ["--test", "./scripts/universal-intent.test.ts", "./scripts/workflow-preferences.test.ts"]],
  ["task controls, progress, and delivery policy", ["--test", "./scripts/multiplayer-task-context.test.ts", "./scripts/multiplayer-action-policy.test.ts"]],
  ["persistent provider lifecycle, owner queue, multiplayer, and stale-feed retirement", ["--test", "./scripts/managed-provider-adapters.test.ts", "./scripts/managed-provider-supervisor.test.ts", "./scripts/managed-provider-owner-queue.test.ts", "./scripts/multiplayer-dispatch-fence.test.ts", "./scripts/multiplayer-target-identity.test.ts", "./scripts/multiplayer-mutation-scheduler.test.ts", "./scripts/multiplayer-runtime.test.ts", "./scripts/multiplayer-a2a.test.ts", "./scripts/multiplayer-contract.test.ts", "./scripts/multiplayer-run-coordinator.test.ts", "./scripts/native-feed.test.ts", "./scripts/stale-task-retirement.test.ts"]],
  ["canonical desktop pill transport, dictation, and model picker", ["--test", "./scripts/pill-shells.test.ts", "./scripts/pill-speech.test.ts", "./scripts/provider-model-picker.test.ts"]],
  ["production boundary and retired-path isolation", ["--test", "./scripts/production-boundary.test.ts"]],
  ["runtime transaction and artifact publication", ["--test", "./scripts/engine-build-transaction.test.mjs"]],
  ["runtime install rollback and obsolete-file cleanup", ["--test", "./scripts/runtime-install-transaction.test.ts"]],
  ["TypeScript", ["node_modules/typescript/bin/tsc", "--noEmit", "-p", ".", "--pretty", "false"]],
];

function run(label, args) {
  const command = args[0] === "node_modules/typescript/bin/tsc" ? process.execPath : process.execPath;
  const commandArgs = args[0] === "node_modules/typescript/bin/tsc" ? args : [...nodeArgs, ...args];
  const result = spawnSync(command, commandArgs, { cwd: root, env, encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(`\n[FAIL] ${label}\n${result.stdout ?? ""}${result.stderr ?? ""}`);
    process.exitCode = 1;
    return false;
  }
  process.stdout.write(`[PASS] ${label}\n`);
  return true;
}

for (const [label, args] of checks) run(label, args);

if (process.exitCode !== 1) {
  const build = spawnSync(process.execPath, ["scripts/build-cli.mjs"], { cwd: root, env, encoding: "utf8" });
  if (build.status !== 0) {
    process.stderr.write(`\n[FAIL] isolated CLI bundle\n${build.stdout ?? ""}${build.stderr ?? ""}`);
    process.exitCode = 1;
  } else {
    const expected = ["universal-intent-resolver.js", "workflow-preferences.js", "multiplayer-runtime.js", "computer-use-mcp.js"];
    for (const file of expected) {
      const path = resolve(cliOut, file);
      try { readFileSync(path); } catch { process.stderr.write(`[FAIL] isolated CLI bundle missing ${file}\n`); process.exitCode = 1; }
    }
    if (process.exitCode !== 1) process.stdout.write("[PASS] isolated CLI bundle contains native intent modules\n");
  }
}

if (process.exitCode === 1) process.exit(1);
rmSync(cliOut, { recursive: true, force: true });
process.stdout.write("Implementation-order gate passed. Live install/rebuild was not performed.\n");

