import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const check = process.argv.includes("--check");
const summary = process.argv.includes("--summary");
const failures = [];

const required = [
  "OPEN_CORE.md",
  "OPEN_CORE_ANNOUNCEMENT.md",
  "OPEN_CORE_LAUNCH_PLAN.md",
  "COMPATIBILITY.md",
  "HOSTED_TERMS_DRAFT.md",
  "TRADEMARK_POLICY.md",
  "THIRD_PARTY_NOTICES.md",
  "docs/PUBLIC_RELEASE_ALLOWLIST.md",
  "docs/OPEN_CORE_LEGAL_REVIEW.md",
  "docs/OPEN_CORE_COMMERCIAL_BOUNDARY.md",
  "packages/runtime-core/LICENSE",
  "packages/runtime-core/NOTICE",
];

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
const secretFilePattern = /(?:^|[\\/])(?:\.env(?:\..*)?|.*\.pem|.*\.key|\.oathlock[\\/]local\.json)$/i;
const artifactPattern = /^(?:artifacts|\.release-excluded)(?:[\\/]|$)/i;

function normalize(path) {
  return path.replaceAll("\\", "/");
}

function gitFiles(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" })
    .split(/\r?\n/)
    .map((value) => normalize(value.trim()))
    .filter(Boolean);
}

function isExcluded(path) {
  return initialSnapshotExcluded.has(path)
    || initialSnapshotExcludedPrefixes.some((prefix) => path.startsWith(prefix));
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(join(root, path))).digest("hex");
}

const allCandidates = [...new Set([
  ...gitFiles(["ls-files"]),
  ...gitFiles(["ls-files", "--others", "--exclude-standard"]),
])]
  .filter((path) => existsSync(join(root, path)) && !path.startsWith(".git/"));

const intentionallyExcluded = allCandidates.filter((path) => isExcluded(path));
const prohibited = allCandidates.filter((path) =>
  artifactPattern.test(path) || (secretFilePattern.test(path) && !path.endsWith(".env.example"))
);
const files = allCandidates
  .filter((path) => !isExcluded(path) && !artifactPattern.test(path) && !(secretFilePattern.test(path) && !path.endsWith(".env.example")))
  .sort((a, b) => a.localeCompare(b));

for (const path of required) {
  if (!files.includes(path)) failures.push(`required release file is missing from candidate: ${path}`);
}
if (prohibited.length > 0) {
  failures.push(`candidate contains prohibited paths: ${prohibited.join(", ")}`);
}
if (!files.includes("packages/runtime-core/package.json")) {
  failures.push("runtime-core package metadata is missing from candidate");
} else {
  const metadata = JSON.parse(readFileSync(join(root, "packages/runtime-core/package.json"), "utf8"));
  if (metadata.private !== false || metadata.license !== "Apache-2.0") {
    failures.push("runtime-core package metadata must declare private=false and license=Apache-2.0");
  }
}

const manifest = {
  schema: "m9r.public-release-manifest.v1",
  licenseBoundary: {
    repository: "BUSL-1.1",
    runtimeCore: "Apache-2.0",
  },
  excludedPathCount: intentionallyExcluded.length + prohibited.length,
  fileCount: files.length,
  files: files.map((path) => ({
    path,
    bytes: statSync(join(root, path)).size,
    sha256: sha256(path),
  })),
};

if (check) {
  if (failures.length > 0) {
    for (const failure of failures) console.log(`FAIL  ${failure}`);
    console.log(`\nRelease manifest check: BLOCKED (${failures.length} failure${failures.length === 1 ? "" : "s"})`);
    process.exitCode = 1;
  } else {
    console.log(`PASS  ${files.length} eligible files hashed; ${intentionallyExcluded.length} intentional exclusions present`);
    console.log("Release manifest check: PASS");
  }
} else if (summary) {
  console.log(JSON.stringify({
    schema: manifest.schema,
    fileCount: manifest.fileCount,
    excludedPathCount: manifest.excludedPathCount,
    sha256Entries: manifest.files.length,
  }, null, 2));
} else {
  console.log(JSON.stringify(manifest, null, 2));
}
