import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { splitTestFilesIntoBatches, validateTestFileManifest } from "./test-suite-runner-core.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, "..");
const allTestFiles = readdirSync(scriptsDir).filter((name) => /\.test\.(?:ts|mjs|js)$/.test(name)).sort();
const suite = process.argv[2];

const webBrokerFiles = new Set([
  "web-protocol-conformance.test.ts",
  "m9r-compatibility.test.ts",
  "room-litmus-core.test.ts",
  "web-setup-core.test.ts",
  "web-broker.test.ts",
  "web-broker-server.test.ts",
  "web-broker-extension.test.ts",
  "web-powers-core.test.ts",
  "web-powers-mcp.test.ts",
  "page-actions.test.ts",
  "page-actions.test.js",
  "web-authority.test.ts",
  "web-authority-store.test.ts",
  "web-authority-cli.test.ts",
  "owner-pipe.test.ts",
  "presence-logic.test.ts",
  "permission-logic.test.ts",
]);

function belongsToSuite(name) {
  if (suite === "bench") return ["bench-cdp.test.ts", "bench-cdp-driver.test.ts", "bench-data.test.ts", "bench-site.test.ts", "bench-strategies.test.ts", "bench-temp-cleanup.test.ts", "bench-client.test.ts"].includes(name);
  if (suite === "web-broker") return webBrokerFiles.has(name);
  if (suite !== "web-all") return false;
  return name.startsWith("bench-") ||
    name.startsWith("web-") ||
    name.startsWith("native-") ||
    name.startsWith("m9r-native-") ||
    name.startsWith("opencode-") ||
    name.startsWith("room-") ||
    [
      ...webBrokerFiles,
      "content-listener-leak.test.js",
      "cross-machine-room.test.ts",
      "engine-mcp-smoke.test.ts",
      "engine-update-core.test.ts",
      "export-aware-spec.test.mjs",
      "finding-ledger-core.test.ts",
      "live-session-core.test.ts",
      "mcp-inbox.test.ts",
      "prune-tasks.test.ts",
      "vendor-launch-core.test.ts",
      "mission-relay.test.ts",
      "m9r-extension-csp.test.ts",
      "page-notes-core.test.ts",
      "page-notes-mcp.test.ts",
      "page-notes-store.test.ts",
      "browser-extension-store-package.test.mjs",
      "quiet-input.test.js",
      "pill-state.test.ts",
      "pill-shells.test.ts",
      "pill-speech.test.ts",
      "desktop-pill-presence.test.ts",
      "presence-frame-lifecycle.test.js",
      "presence-target-highlight.test.js",
    ].includes(name);
}

if (!suite || !["all", "bench", "web-broker", "web-all"].includes(suite)) {
  console.error("usage: node scripts/run-test-suite.mjs <all|bench|web-broker|web-all>");
  process.exit(2);
}

const files = suite === "all"
  ? validateTestFileManifest(JSON.parse(readFileSync(join(scriptsDir, "test-files.json"), "utf8")), allTestFiles)
  : allTestFiles.filter(belongsToSuite);
if (files.length === 0) {
  console.error(`no test files selected for ${suite}`);
  process.exit(2);
}

if (suite === "all") {
  const batches = splitTestFilesIntoBatches(files);
  let failedBatches = 0;

  for (const [index, batch] of batches.entries()) {
    const result = spawnSync(process.execPath, [
      "--disable-warning=ExperimentalWarning",
      "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      "--import",
      "./scripts/register-alias.mjs",
      "--test",
      "--test-concurrency=8",
      ...batch.map((file) => `./scripts/${file}`),
    ], { cwd: repoRoot, encoding: "utf8", timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });

    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const count = (label) => Number(output.match(new RegExp(`(?:ℹ\\s*)?${label}\\s+(\\d+)`))?.[1] ?? 0);
    process.stdout.write(`TEST_BATCH ${index + 1}/${batches.length} files=${batch.length} tests=${count("tests")} pass=${count("pass")} fail=${count("fail")} skipped=${count("skipped")} exit=${result.status ?? "spawn-error-or-timeout"}\n`);
    if (result.status !== 0) {
      failedBatches += 1;
      const failingDetails = (text) => {
        const marker = text.lastIndexOf("✖ failing tests:");
        return marker >= 0 ? text.slice(marker) : text.slice(-20_000);
      };
      if (result.stdout) process.stdout.write(failingDetails(result.stdout));
      if (result.stderr) process.stderr.write(failingDetails(result.stderr));
      if (result.error) process.stderr.write(`TEST_BATCH_ERROR ${result.error.message}\n`);
    }
  }

  process.stdout.write(`TEST_TOTAL suite=all files=${files.length} batches=${batches.length} failedBatches=${failedBatches}\n`);
  process.exitCode = failedBatches > 0 ? 1 : 0;
} else {

let failedFiles = 0;
let total = 0;
let passed = 0;
let failed = 0;
let skipped = 0;

for (const file of files) {
  const result = spawnSync(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
    "--import",
    "./scripts/register-alias.mjs",
    "--test",
    `./scripts/${file}`,
  ], { cwd: repoRoot, encoding: "utf8", timeout: file === "bench-strategies.test.ts" ? 600_000 : 180_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const count = (label) => Number(output.match(new RegExp(`(?:ℹ\\s*)?${label}\\s+(\\d+)`))?.[1] ?? 0);
  const fileTests = count("tests");
  const filePassed = count("pass");
  const fileFailed = count("fail");
  const fileSkipped = count("skipped");
  total += fileTests;
  passed += filePassed;
  failed += fileFailed;
  skipped += fileSkipped;
  if (result.status !== 0) failedFiles++;
  process.stdout.write(`WEB_TEST_FILE ${file} tests=${fileTests} pass=${filePassed} fail=${fileFailed} skipped=${fileSkipped} exit=${result.status ?? "timeout"}\n`);
}

process.stdout.write(`WEB_TEST_TOTAL suite=${suite} files=${files.length} tests=${total} pass=${passed} fail=${failed} skipped=${skipped} failedFiles=${failedFiles}\n`);
process.exitCode = failedFiles ? 1 : 0;
}
