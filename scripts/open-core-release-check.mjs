import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const strict = process.argv.includes("--strict");
const failures = [];
const warnings = [];

function readText(path) {
  return readFileSync(join(root, path), "utf8");
}

function pass(label) {
  console.log(`PASS  ${label}`);
}

function fail(label, detail) {
  failures.push(`${label}: ${detail}`);
  console.log(`FAIL  ${label} — ${detail}`);
}

function warn(label, detail) {
  warnings.push(`${label}: ${detail}`);
  console.log(`WARN  ${label} — ${detail}`);
}

function walk(directory) {
  const absolute = join(root, directory);
  if (!existsSync(absolute)) return [];

  const files = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const path = join(absolute, entry.name);
    if (entry.isDirectory()) files.push(...walk(relative(root, path)));
    else files.push(relative(root, path));
  }
  return files;
}

function gitFiles(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" })
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
}

const license = readText("LICENSE");
if (license.includes("Business Source License 1.1") && /Change License:\s+GNU General Public License, Version 2\.0 or any later version/.test(license)) {
  pass("BUSL-1.1 license and GPL-2.0-or-later change license are declared");
} else {
  fail("license declaration", "LICENSE does not contain the expected BUSL-1.1 and change-license terms");
}

const openCore = readText("OPEN_CORE.md");
if (/ambiguous self-authored evidence[\s\S]*not proof that OpenCode responded/i.test(openCore)
  && /Capture a clean successful two-provider acceptance run/i.test(openCore)) {
  pass("live acceptance evidence is not overstated");
} else {
  fail("live acceptance evidence", "release record must distinguish provider-attributed results from self-authored messages and retain the clean two-provider gate");
}

for (const required of ["OPEN_CORE.md", "OPEN_CORE_AUDIT.md", "OPEN_CORE_LAUNCH_PLAN.md", "SELF_HOSTING.md", "SECURITY.md", "COMPATIBILITY.md", "HOSTED_TERMS_DRAFT.md", "THIRD_PARTY_NOTICES.md", "TRADEMARK_POLICY.md", "docs/SECURITY.md", "docs/PUBLIC_RELEASE_ALLOWLIST.md", "docs/OPEN_CORE_ARCHITECTURE.md", "docs/OPEN_CORE_LEGAL_REVIEW.md", "docs/OPEN_CORE_COMMERCIAL_BOUNDARY.md", "docs/OPEN_CORE_DEPENDENCY_AUDIT.md", "packages/runtime-core/BOUNDARY.md", "packages/runtime-core/LICENSE", "packages/runtime-core/NOTICE"]) {
  if (existsSync(join(root, required))) pass(`release documentation exists: ${required}`);
  else fail("release documentation", `${required} is missing`);
}

const expectedPackageLicenses = {
  "package.json": "BUSL-1.1",
  "cli/package.json": "BUSL-1.1",
  "packages/runtime-core/package.json": "Apache-2.0",
};
for (const [packagePath, expectedLicense] of Object.entries(expectedPackageLicenses)) {
  const metadata = JSON.parse(readText(packagePath));
  if (metadata.license === expectedLicense) pass(`${packagePath} declares ${expectedLicense}`);
  else fail(`${packagePath} license`, `expected ${expectedLicense}, found ${metadata.license ?? "missing"}`);
}

const bannedProductionTokens = [
  "CodexThreadPane",
  "startOwnerCodexRuntime",
  "codex-app-server-client",
  "codex-thread-host",
  "mission-codex-protocol",
  "handleCodex",
  "sendCodexFrame",
  "wf-codex-app",
];
const productionFiles = [...walk("src"), ...walk("scripts"), ...walk("cli/dist")]
  .filter((path) => path !== "scripts\\open-core-release-check.mjs")
  .filter((path) => /\.(?:ts|tsx|js|mjs|css)$/.test(path));
const productionMatches = [];
for (const file of productionFiles) {
  const contents = readText(file);
  for (const token of bannedProductionTokens) {
    if (contents.includes(token)) productionMatches.push(`${file}: ${token}`);
  }
}
if (productionMatches.length === 0) pass("dedicated Codex app-server path is absent from production source");
else fail("retired Codex app-server path", productionMatches.join(", "));

const trackedFiles = gitFiles(["ls-files"]);
const sensitiveTracked = trackedFiles.filter((path) =>
  /(?:^|[\\/])(?:\.env(?:\..*)?|.*\.pem|.*\.key|\.oathlock[\\/]local\.json)$/i.test(path) && !path.endsWith(".env.example"),
);
if (sensitiveTracked.length === 0) pass("no obvious environment or private-key files are tracked");
else fail("tracked sensitive files", sensitiveTracked.join(", "));

const status = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
const releaseRiskUntracked = status
  .split(/\r?\n/)
  .filter((line) => line.startsWith("??"))
  .map((line) => line.slice(3).trim())
  .filter((path) => path && /(?:^|[\\/])(?:debug\.log|artifacts[\\/])/i.test(path));
if (releaseRiskUntracked.length === 0) pass("no untracked debug/artifact output is present");
else {
  const message = releaseRiskUntracked.join(", ");
  if (strict) fail("release working tree", `untracked debug/artifact output must be reviewed before release: ${message}`);
  else warn("release working tree", `review before release: ${message}`);
}

if (warnings.length > 0) {
  console.log("\nManual review still required:");
  for (const warning of warnings) console.log(`- ${warning}`);
}

if (failures.length > 0) {
  console.error(`\nOpen-core gate: BLOCKED (${failures.length} failure${failures.length === 1 ? "" : "s"})`);
  process.exitCode = 1;
} else {
  console.log(`\nOpen-core gate: ${strict ? "PASS (strict checks)" : "PASS (deterministic checks)"}`);
}
