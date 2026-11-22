import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { NATIVE_TEST_FILES, requireNativeReleaseCoverage, testNodeArgs, testSummary, splitTestFilesIntoBatches, validateTestFileManifest } from "./test-suite-runner-core.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, "..");
const allTestFiles = readdirSync(scriptsDir).filter(name => /\.test\.(?:ts|mjs|js)$/.test(name)).sort();
const suite = process.argv[2];
const webBrokerFiles = new Set([
  "web-protocol-conformance.test.ts", "m9r-compatibility.test.ts", "room-litmus-core.test.ts", "web-setup-core.test.ts",
  "web-broker-server.test.ts", "web-powers-core.test.ts", "web-powers-mcp.test.ts", "web-authority.test.ts",
  "web-authority-store.test.ts", "web-authority-cli.test.ts", "owner-pipe.test.ts",
]);

// Historical provider-hook/extension delivery contracts remain excluded as before.
const retiredDeliveryContractFiles = new Set([
  "cli-package.test.ts", "native-approvals.test.ts", "native-codex-delivery.test.ts",
  "native-commands.test.ts", "native-identity.test.ts", "native-store-and-hook.test.ts",
]);

function belongsToSuite(name) {
  if (suite === "bench") return ["bench-data.test.ts", "bench-site.test.ts", "bench-strategies-core.test.ts", "bench-temp-cleanup.test.ts", "bench-codex-cli.test.ts", "bench-usage-report.test.ts", "bench-prompts.test.ts"].includes(name);
  if (suite === "web-broker") return webBrokerFiles.has(name);
  if (suite !== "web-all") return false;
  return name.startsWith("bench-") || name.startsWith("web-") || name.startsWith("native-")
    || name.startsWith("m9r-native-") || name.startsWith("opencode-") || name.startsWith("room-") || [
      ...webBrokerFiles, "cross-machine-room.test.ts", "engine-mcp-smoke.test.ts", "engine-update-core.test.ts",
      "export-aware-spec.test.mjs", "finding-ledger-core.test.ts", "live-session-core.test.ts", "mcp-inbox.test.ts",
      "prune-tasks.test.ts", "vendor-launch-core.test.ts", "mission-relay.test.ts", "page-notes-core.test.ts",
      "page-notes-mcp.test.ts", "page-notes-store.test.ts", "pill-state.test.ts", "pill-shells.test.ts",
      "pill-speech.test.ts", "desktop-pill-presence.test.ts",
    ].includes(name);
}

if (!suite || !["all", "native", "bench", "web-broker", "web-all"].includes(suite) || process.argv.length > 3) {
  console.error("usage: node scripts/run-test-suite.mjs <all|native|bench|web-broker|web-all>");
  process.exit(2);
}
const files = suite === "all"
  ? validateTestFileManifest(JSON.parse(readFileSync(join(scriptsDir, "test-files.json"), "utf8")), allTestFiles)
    .filter(file => !retiredDeliveryContractFiles.has(file))
  : suite === "native" ? validateTestFileManifest([...NATIVE_TEST_FILES], allTestFiles) : allTestFiles.filter(belongsToSuite);
if (!files.length) throw new Error(`No test files selected for ${suite}.`);
if (suite === "all") requireNativeReleaseCoverage(files);

// All named suites use bounded process-isolated batching, like the release gate.
const batches = splitTestFilesIntoBatches(files);
const started = performance.now();
let failedBatches = 0;
const totals = { tests: 0, pass: 0, fail: 0, skipped: 0 };
for (const [index, batch] of batches.entries()) {
  const batchStarted = performance.now();
  const result = spawnSync(process.execPath, testNodeArgs(batch), {
    cwd: repoRoot, encoding: "utf8", windowsHide: true, timeout: 600_000, maxBuffer: 64 * 1024 * 1024,
  });
  const output = String(result.stdout ?? "") + "\n" + String(result.stderr ?? "");
  const summary = testSummary(output);
  for (const key of Object.keys(totals)) totals[key] += summary[key];
  process.stdout.write(`TEST_BATCH ${index + 1}/${batches.length} suite=${suite} files=${batch.length} tests=${summary.tests} pass=${summary.pass} fail=${summary.fail} skipped=${summary.skipped} elapsedMs=${Math.round(performance.now() - batchStarted)} exit=${result.status ?? "spawn-error-or-timeout"}\n`);
  if (result.status !== 0 || result.error) {
    failedBatches++;
    const marker = output.lastIndexOf("✖ failing tests:");
    process.stdout.write(marker >= 0 ? output.slice(marker) : output.slice(-20_000));
    if (result.error) process.stderr.write(`TEST_BATCH_ERROR ${result.error.message}\n`);
  }
}
process.stdout.write(`TEST_TOTAL suite=${suite} files=${files.length} batches=${batches.length} tests=${totals.tests} pass=${totals.pass} fail=${totals.fail} skipped=${totals.skipped} failedBatches=${failedBatches} elapsedMs=${Math.round(performance.now() - started)}\n`);
process.exitCode = failedBatches ? 1 : 0;
