import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
      "frame-common-ring.test.js",
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
      "native-input-client.test.js",
      "newtab-page.test.mjs",
      "presence-frame-lifecycle.test.js",
    ].includes(name);
}

if (!suite || !["bench", "web-broker", "web-all"].includes(suite)) {
  console.error("usage: node scripts/run-test-suite.mjs <bench|web-broker|web-all>");
  process.exit(2);
}

const files = allTestFiles.filter(belongsToSuite);
if (files.length === 0) {
  console.error(`no test files selected for ${suite}`);
  process.exit(2);
}

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
  ], { cwd: repoRoot, encoding: "utf8", timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
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
