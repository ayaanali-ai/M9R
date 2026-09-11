import { execFileSync } from "node:child_process";

const secretPattern = "sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,}|sk_live_[A-Za-z0-9]{16,}|rk_live_[A-Za-z0-9]{16,}|-----BEGIN (RSA|OPENSSH|EC) PRIVATE KEY-----|-----BEGIN PRIVATE KEY-----";
const reviewedSyntheticPaths = new Set([
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

function isReviewedSyntheticPath(file) {
  return reviewedSyntheticPaths.has(file) || file.startsWith("runleak-analyzer-mvp/cases/006-redaction/");
}

function gitHistoryMatches() {
  try {
    return execFileSync("git", [
      "-c", "diff.external=",
      "-c", "diff.gpg.textconv=",
      "log", "--all", "--no-ext-diff", "--no-textconv",
      "--format=%H", "-G", secretPattern, "--", ".",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
  } catch (error) {
    if (error?.status === 1) return [];
    throw error;
  }
}

const matches = gitHistoryMatches();
console.log(`Historical high-confidence secret-pattern matches: ${matches.length}`);
if (matches.length > 0) {
  const unreviewed = [];
  for (const commit of matches) {
    let rows = "";
    try {
      rows = execFileSync("git", ["grep", "-I", "-n", "-E", secretPattern, commit, "--"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch (error) {
      rows = error?.stdout?.toString() ?? "";
    }
    for (const row of rows.split(/\r?\n/).filter(Boolean)) {
      const first = row.indexOf(":");
      const second = row.indexOf(":", first + 1);
      const file = row.slice(first + 1, second);
      const synthetic = isReviewedSyntheticPath(file);
      if (!synthetic) unreviewed.push(`${commit}:${file}`);
    }
  }

  if (unreviewed.length > 0) {
    console.log("Review these commit/path pairs before public release (no matched content is printed):");
    for (const match of unreviewed) console.log(`- ${match}`);
    console.error("History audit: BLOCKED until every match is reviewed or explicitly allowlisted.");
    process.exitCode = 1;
  } else {
    console.log("History audit: PASS — all matches are documented synthetic redaction fixtures.");
  }
} else {
  console.log("History audit: PASS");
}
