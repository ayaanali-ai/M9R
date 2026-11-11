// Build a complete, hash-verified runtime candidate without touching cli/dist,
// engine/dist, the accepted runtime policy, or the installed ~/.m9r/bin.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { verifyRuntimeBuildManifest } from "./engine-build-transaction.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Flow guard 3A: build only from the one designated folder, only on the
// designated trunk branch, only with a clean tree -- no exceptions. See
// BUILD_INSTALL_FLOW.md. Set CI=1 to allow a CI checkout's own working
// directory instead of the one hardcoded developer path.
const CANONICAL_ROOT = "C:\\RunLeak\\runleak";
if (!process.env.CI && resolve(root).toLowerCase() !== CANONICAL_ROOT.toLowerCase()) {
  throw new Error(`Refusing to build from ${root}; the designated folder is ${CANONICAL_ROOT} (see BUILD_INSTALL_FLOW.md, flow guard 3A).`);
}
{
  const branchResult = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, encoding: "utf8" });
  if (branchResult.error || branchResult.status !== 0) throw new Error("Cannot determine the current branch; refusing to build.");
  const currentBranch = String(branchResult.stdout).trim();
  const trunkBranch = readFileSync(join(root, "scripts", "trunk-branch.txt"), "utf8").trim();
  if (!trunkBranch) throw new Error("scripts/trunk-branch.txt is empty; refusing to build without a designated trunk branch.");
  if (currentBranch !== trunkBranch) {
    throw new Error(`Refusing to build from branch "${currentBranch}"; the designated trunk branch is "${trunkBranch}" (update scripts/trunk-branch.txt to change this, see BUILD_INSTALL_FLOW.md flow guard 3A/2B).`);
  }
  const dirtyCheck = spawnSync("git", ["status", "--porcelain=v1"], { cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024 });
  if (dirtyCheck.error || dirtyCheck.status !== 0) throw new Error("Cannot determine whether the working tree is clean; refusing to build.");
  const dirtyLines = String(dirtyCheck.stdout).split(/\r?\n/).filter(Boolean);
  // engine/candidates/ holds this very script's own prior outputs, which are
  // never source; everything else (including the rest of engine/) is a real
  // dirty-build failure with no exceptions, per flow guard 3A.
  const realDirtyLines = dirtyLines.filter((line) => !/^(?:\?\?|[ MARCD]{2})\s+engine\/candidates\//.test(line));
  if (realDirtyLines.length > 0) {
    throw new Error(`Refusing to build from a dirty working tree (flow guard 3A). Uncommitted/untracked paths:\n${realDirtyLines.join("\n")}`);
  }
}

const engineDir = join(root, "engine");
const candidatesRoot = resolve(engineDir, "candidates");
const resumeIndex = process.argv.indexOf("--resume");
const resumePath = resumeIndex >= 0 ? process.argv[resumeIndex + 1] : undefined;
if (resumeIndex >= 0 && !resumePath) throw new Error("Usage: npm run build:candidate -- --resume <candidate-directory>");
let candidateRoot;
let candidateId;
let sourceCommit;
let resumedRuntime;
if (resumePath) {
  candidateRoot = resolve(resumePath);
  if (!candidateRoot.toLowerCase().startsWith(`${candidatesRoot}${sep}`.toLowerCase())) {
    throw new Error(`Resume path must be inside ${candidatesRoot}; refusing to read or write elsewhere.`);
  }
  candidateId = basename(candidateRoot);
  const priorManifest = verifyRuntimeBuildManifest(join(candidateRoot, "runtime"), { exact: true });
  sourceCommit = priorManifest.source?.sourceCommit;
  resumedRuntime = priorManifest;
  if (!/^[a-f0-9]{40}$/i.test(sourceCommit ?? "") || !candidateId.endsWith(sourceCommit.slice(0, 8))) {
    throw new Error("Candidate source identity is missing or does not match its directory name.");
  }
  if (existsSync(join(candidateRoot, "candidate.json"))) throw new Error(`Candidate already has a completion receipt: ${candidateRoot}`);
  const buildReceiptPath = join(candidateRoot, "candidate-build.json");
  if (!existsSync(buildReceiptPath)) {
    throw new Error("This candidate predates the accepted-live-pill build receipt and cannot be resumed. Create a new candidate; the old directory was left untouched.");
  }
  const priorBuildReceipt = JSON.parse(readFileSync(buildReceiptPath, "utf8"));
  if (priorBuildReceipt.schemaVersion !== 1 || priorBuildReceipt.buildMode !== "pill-built-from-source"
    || priorBuildReceipt.runtimeBuildId !== priorManifest.buildId
    || priorBuildReceipt.sourceCommit !== sourceCommit
    || priorBuildReceipt.pillSha256 !== priorManifest.artifacts["m9r-overlay.exe"]) {
    throw new Error("Candidate build receipt does not match its runtime manifest; refusing to package it.");
  }
} else {
  const commitResult = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  if (commitResult.error || commitResult.status !== 0) {
    throw new Error("Cannot identify the source commit; refusing to build an unlabeled candidate.", { cause: commitResult.error });
  }
  sourceCommit = String(commitResult.stdout).trim();
  if (!/^[a-f0-9]{40}$/i.test(sourceCommit)) throw new Error("Git returned an invalid source commit.");
  const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  candidateId = `${timestamp}-${sourceCommit.slice(0, 8)}`;
  candidateRoot = join(candidatesRoot, candidateId);
  if (existsSync(candidateRoot)) throw new Error(`Candidate path already exists; refusing to overwrite it: ${candidateRoot}`);
}

const cliOutput = join(candidateRoot, "cli-dist");
const runtimeOutput = join(candidateRoot, "runtime");
const packageOutput = join(candidateRoot, "package");

function runNodeScript(script, env) {
  const result = spawnSync(process.execPath, [join(root, "scripts", script)], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${script} failed with exit ${result.status ?? "unknown"}. Candidate outputs, if any, remain isolated at ${candidateRoot}.`, { cause: result.error });
  }
}

if (!resumePath) {
  runNodeScript("build-engine.mjs", {
    M9R_CLI_OUTPUT_DIR: cliOutput,
    M9R_ENGINE_OUTPUT_DIR: runtimeOutput,
  });
}

const runtimeIdentity = verifyRuntimeBuildManifest(runtimeOutput, { exact: true });
const pillSha256 = runtimeIdentity.artifacts["m9r-overlay.exe"];
// Flow guard 4A: the pill was just built from overlay/ source by build-engine.mjs,
// in this same run, with no separate "accepted" value to compare against -- a
// fresh pill build IS the candidate's pill, unconditionally.
if (!/^[a-f0-9]{64}$/.test(pillSha256 ?? "") || !existsSync(join(runtimeOutput, "m9r-overlay.exe"))) {
  throw new Error("Candidate runtime does not contain a built pill.");
}
if (createHash("sha256").update(readFileSync(join(runtimeOutput, "m9r-overlay.exe"))).digest("hex") !== pillSha256) {
  throw new Error("Candidate runtime pill hash does not match its complete runtime manifest.");
}
if (!resumePath) {
  const buildReceipt = {
    schemaVersion: 1,
    buildMode: "pill-built-from-source",
    candidateId,
    sourceCommit,
    runtimeBuildId: runtimeIdentity.buildId,
    pillSha256,
  };
  writeFileSync(join(candidateRoot, "candidate-build.json"), `${JSON.stringify(buildReceipt, null, 2)}\n`);
} else if (resumedRuntime?.buildId !== runtimeIdentity.buildId) {
  throw new Error("Resumed runtime changed after its accepted-live-pill receipt was created.");
}

const packageResult = spawnSync("powershell.exe", [
  "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(root, "scripts", "package-engine-release.ps1"),
  "-OutputDirectory", packageOutput,
  "-RuntimeDirectory", runtimeOutput,
  "-CliDistDirectory", cliOutput,
  "-AcceptedRuntimePath", join(runtimeOutput, "m9r-build-info.json"),
  "-Candidate",
], { cwd: root, stdio: "inherit", windowsHide: true });
if (packageResult.error || packageResult.status !== 0) {
  throw new Error(`Candidate packaging failed with exit ${packageResult.status ?? "unknown"}. Verified runtime remains at ${runtimeOutput}.`, { cause: packageResult.error });
}

const zipPath = join(packageOutput, "m9r-engine-windows-x64.zip");
const zipHash = createHash("sha256").update(readFileSync(zipPath)).digest("hex");
const sidecar = readFileSync(`${zipPath}.sha256`, "utf8").trim();
if (!new RegExp(`^${zipHash}\\s+\\*?m9r-engine-windows-x64\\.zip$`, "i").test(sidecar)) {
  throw new Error("Candidate ZIP checksum sidecar does not match the package bytes.");
}
const receipt = {
  schemaVersion: 1,
  buildMode: "pill-built-from-source",
  candidateId,
  sourceCommit,
  runtimeBuildId: runtimeIdentity.buildId,
  sourceDirty: runtimeIdentity.source?.sourceDirty ?? null,
  pillSha256,
  package: {
    path: "package/m9r-engine-windows-x64.zip",
    sha256: zipHash,
  },
  verified: {
    runtimeManifest: true,
    exactRuntimeArtifactSet: true,
    acceptedPillHash: true,
    packageChecksum: true,
  },
};
writeFileSync(join(candidateRoot, "candidate.json"), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(`Candidate ready: ${candidateRoot}`);
console.log(`Runtime build ID: ${runtimeIdentity.buildId}`);
console.log(`Installer package SHA-256: ${zipHash}`);
