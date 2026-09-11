import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const failures = [];

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

function pass(label) {
  console.log(`PASS  ${label}`);
}

function fail(label, detail) {
  failures.push(`${label}: ${detail}`);
  console.log(`FAIL  ${label} — ${detail}`);
}

function gitFiles(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" })
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
}

const required = [
  "OPEN_CORE.md",
  "OPEN_CORE_ANNOUNCEMENT.md",
  "OPEN_CORE_LAUNCH_PLAN.md",
  "COMPATIBILITY.md",
  "HOSTED_TERMS_DRAFT.md",
  "docs/PUBLIC_RELEASE_ALLOWLIST.md",
  "docs/OPEN_CORE_ARCHITECTURE.md",
  "TRADEMARK_POLICY.md",
  "THIRD_PARTY_NOTICES.md",
  "docs/OPEN_CORE_COMMERCIAL_BOUNDARY.md",
  "packages/runtime-core/LICENSE",
  "packages/runtime-core/NOTICE",
];
for (const path of required) {
  if (existsSync(join(root, path))) pass(`required public-release file exists: ${path}`);
  else fail("required public-release file", `${path} is missing`);
}

const runtimeCore = JSON.parse(read("packages/runtime-core/package.json"));
if (runtimeCore.license === "Apache-2.0" && runtimeCore.private === false) {
  pass("runtime-core is a distributable Apache-2.0 package");
} else {
  fail("runtime-core package metadata", "expected private=false and license=Apache-2.0");
}

const tracked = gitFiles(["ls-files"]);
const untracked = gitFiles(["ls-files", "--others", "--exclude-standard"]);
const candidateFiles = [...new Set([...tracked, ...untracked])]
  .map((path) => path.replaceAll("\\", "/"))
  .filter((path) => existsSync(join(root, path)) && !path.startsWith(".git/"));
const initialSnapshotExcluded = new Set([
  "M9R_MASTER_BUILD_PLAN.md",
  "OathLock_Realtime_Multi_Agent_Execution_Plan_v1_0.md",
  "OATHLOCK_V2_MASTER_PLAN.md",
  "OATHLOCK_V2_SCHEMA_AUDIT.md",
  "OATHLOCK_V2_SCORE_PLAN.md",
  "PLAN_OF_ACTION_DASHBOARD_AND_METRICS.md",
  "docs/DASHBOARD_UX_PLAN.md",
  "docs/deep-strategy-round3.md",
  "docs/design-research-item5.md",
  "docs/design-research-round2-appealing.md",
  "docs/design-research-speed-and-architecture.md",
  "docs/evidence-layer-strategic-research.md",
  "docs/MISSION_ARCHITECTURE_AUDIT_2026-07-25.md",
  "docs/PHASE_5C_AUDIT.md",
  "docs/PHASE_5D_AUDIT.md",
  "docs/PHASE_5E_MIGRATION_AUDIT.md",
  "docs/PHASE_5E_REPLAY_MATERIAL_AUDIT.md",
  "docs/POSITIONING_INTERNAL.md",
  "docs/PRODUCT_REBUILD_PLAN.md",
  "docs/REAL_PROVIDER_INTEGRATION_PLAN.md",
  "docs/RUNLEAK_MASTER_PLAN.md",
  "docs/SAMPLE_TRACE_AUDIT_REPORT.md",
  "docs/SAMPLE_TRACE_LIBRARY.md",
  "docs/TRACE_AUDIT_INTAKE.md",
  "docs/wide-open-strategy-research.md",
  "oathlock-demo-before.png",
  "oathlock-hackathon-architecture.png",
  "oathlock-hackathon-evidence.png",
  "oathlock-hackathon-flow.png",
  "oathlock-hackathon-hero.png",
  "oathlock-trace.json",
  "oathlock-trace.jsonl",
  "oathlock-trace.messy.json",
  "oathlock-trace.messy.jsonl",
  "oathlock-trace.workspace-fix.json",
  "docs/M9R_SPATIAL_DESIGN.md",
  "docs/designs/m9r-personal-agent-goal-gateway.md",
  "docs/research/multiplayer-agi-master-strategy.md",
  "docs/research/multiplayer-agi-complete-audit.md",
  "scripts/goal-gateway.test.ts",
  "scripts/goal-workforce.test.ts",
  "supabase/migrations/20260910213942_goal_gateway.sql",
  "supabase/migrations/20260910221615_goal_context_receipts.sql",
]);
const initialSnapshotExcludedPrefixes = [
  "docs/designs/",
  "docs/hackathon/",
  "docs/proof/",
  "docs/research/",
  "docs/research-",
  "docs/REAL_PROVIDER_",
  "experiments/",
  "oathlock-specs-complete/",
  "runleak-analyzer-mvp/",
  "src/app/api/agent/goals/",
  "src/app/api/goals/",
  "src/lib/goal/",
];
const reviewedPublicTestFixtures = new Set([
  "docs/migrations/workspace-rules-v5.1.md",
  "docs/proof/v5.1-production-smoke-test.md",
  "docs/proof/v5.1-before-after-proof-template.md",
]);
const isInitialSnapshotExcluded = (path) => {
  const normalized = path.replaceAll("\\", "/");
  return !reviewedPublicTestFixtures.has(normalized) && (
    initialSnapshotExcluded.has(normalized)
    || initialSnapshotExcludedPrefixes.some((prefix) => normalized.startsWith(prefix))
  );
};
const excludedTracked = tracked.filter((path) => {
  return isInitialSnapshotExcluded(path);
});
pass(`${excludedTracked.length} internal strategy/research/proof paths are explicitly excluded from the initial public snapshot`);

if (process.argv.includes("--staged")) {
  const staged = gitFiles(["diff", "--cached", "--name-only", "--diff-filter=ACMRT"]);
  const missingRequired = required.filter((path) => !staged.includes(path));
  const forbiddenStaged = staged.filter((path) =>
    isInitialSnapshotExcluded(path)
    || path.startsWith("artifacts/")
    || /(?:^|[\\/])(?:\.env(?:\..*)?|.*\.pem|.*\.key|\.oathlock[\\/]local\.json)$/i.test(path),
  );
  if (staged.length === 0) {
    fail("staged release candidate", "no staged files found");
  } else if (missingRequired.length > 0) {
    fail("staged release candidate", `required release files are not staged: ${missingRequired.join(", ")}`);
  } else if (forbiddenStaged.length > 0) {
    fail("staged release candidate", `forbidden paths are staged: ${forbiddenStaged.join(", ")}`);
  } else {
    pass(`staged release candidate contains ${staged.length} reviewed-path entries`);
  }
}

const candidateSensitive = candidateFiles.filter((path) =>
  /(?:^|[\\/])(?:\.env(?:\..*)?|.*\.pem|.*\.key|\.oathlock[\\/]local\.json)$/i.test(path)
  && !path.endsWith(".env.example"),
);
if (candidateSensitive.length === 0) pass("no obvious secret-bearing files are in the release candidate");
else fail("candidate secret-bearing files", candidateSensitive.join(", "));

const artifactPaths = candidateFiles.filter((path) => path.startsWith("artifacts/"));
const artifactStillPresent = artifactPaths.filter((path) => existsSync(join(root, path)));
if (artifactStillPresent.length === 0) {
  pass("generated demo/deck artifacts are outside the public worktree");
} else {
  fail("generated public artifacts", artifactStillPresent.join(", "));
}

const secretPattern = "sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,}|sk_live_[A-Za-z0-9]{16,}|rk_live_[A-Za-z0-9]{16,}|-----BEGIN (RSA|OPENSSH|EC) PRIVATE KEY-----|-----BEGIN PRIVATE KEY-----";
const secretRegex = new RegExp(secretPattern, "m");
const secretMatches = candidateFiles.filter((path) => {
  const bytes = readFileSync(join(root, path));
  if (bytes.includes(0)) return false;
  return secretRegex.test(bytes.toString("utf8"));
});
const synthetic = new Set([
  "docs/REAL_PROVIDER_TRACE_PRIVACY.md",
  "runleak-analyzer-mvp/examples/sample-redaction-before-after.md",
  "runleak-analyzer-mvp/src/__tests__/loadTrace.test.ts",
  "scripts/evidence-submission.test.ts",
  "scripts/guided-analyze-flow.test.ts",
  "scripts/mission-git-credential-broker.test.ts",
  "scripts/session-redaction.test.ts",
  "scripts/git-credential-helper.test.ts",
  "scripts/open-core-history-audit.mjs",
  "scripts/open-core-public-surface-check.mjs",
  "src/lib/mission/mission-git-credential-broker.ts",
]);
const unreviewed = secretMatches
  .filter((path) => !synthetic.has(path) && !path.startsWith("runleak-analyzer-mvp/cases/006-redaction/"));
if (unreviewed.length === 0) pass("current high-confidence secret matches are reviewed synthetic fixtures");
else fail("unreviewed current secret matches", [...new Set(unreviewed)].join(", "));

const launchPlan = read("OPEN_CORE_LAUNCH_PLAN.md");
if (/production-ready terminal[\s\S]*explicitly labeled experimental/i.test(launchPlan)
  && /Terminal demo — deferred/i.test(launchPlan)) {
  pass("initial announcement explicitly defers the unverified terminal promise");
} else {
  fail("launch scope", "announcement scope does not explicitly defer terminal claims");
}

const announcement = read("OPEN_CORE_ANNOUNCEMENT.md");
if (/source-available open-core release/i.test(announcement)
  && /not an announcement that[\s\S]*OSI-approved open source/i.test(announcement)
  && /terminal\/resident[\s\S]*experimental/i.test(announcement)
  && /provider connections remain customer-authorized and provider-specific/i.test(announcement)
  && /does not transfer provider keys[\s\S]*pool customer credentials/i.test(announcement)) {
  pass("announcement draft uses source-available language, defers terminal claims, and qualifies provider routing");
} else {
  fail("announcement draft", "draft must identify source-available open core, defer terminal claims, and qualify provider routing");
}

const readme = read("README.md");
if (/Implemented in the current code path/i.test(readme)
  && /provider-attributed live completion[\s\S]*separate release gate/i.test(readme)
  && /provider availability and quotas can prevent a turn/i.test(readme)) {
  pass("README distinguishes implemented code paths from live provider proof");
} else {
  fail("README capability claims", "README must distinguish implemented paths from provider-attributed live completion");
}

const diffCheck = execFileSync("git", ["diff", "--check"], { cwd: root, encoding: "utf8" });
if (diffCheck.trim().length === 0) pass("working-tree diff has no whitespace errors");
else fail("working-tree diff", diffCheck.trim());

if (failures.length > 0) {
  console.error(`\nPublic-surface gate: BLOCKED (${failures.length} failure${failures.length === 1 ? "" : "s"})`);
  process.exitCode = 1;
} else {
  console.log("\nPublic-surface gate: PASS");
}
