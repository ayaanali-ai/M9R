// Build a complete, hash-verified runtime candidate without touching cli/dist,
// engine/dist, the accepted runtime policy, or the installed ~/.m9r/bin.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { verifyRuntimeBuildManifest } from "./engine-build-transaction.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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
    throw new Error("This candidate predates the fresh-source pill build receipt and cannot be resumed. Create a new candidate; the old directory was left untouched.");
  }
  const priorBuildReceipt = JSON.parse(readFileSync(buildReceiptPath, "utf8"));
  if (priorBuildReceipt.schemaVersion !== 1 || priorBuildReceipt.buildMode !== "fresh-source-overlay"
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
  runNodeScript("build-cli.mjs", { M9R_CLI_OUTPUT_DIR: cliOutput });
  runNodeScript("build-engine.mjs", {
    M9R_CLI_OUTPUT_DIR: cliOutput,
    M9R_ENGINE_OUTPUT_DIR: runtimeOutput,
  });
}

const runtimeIdentity = verifyRuntimeBuildManifest(runtimeOutput, { exact: true });
const pillSha256 = runtimeIdentity.artifacts["m9r-overlay.exe"];
if (!/^[a-f0-9]{64}$/.test(pillSha256 ?? "") || !existsSync(join(runtimeOutput, "m9r-overlay.exe"))) {
  throw new Error("Candidate runtime does not contain the pill built from the current checkout.");
}
if (createHash("sha256").update(readFileSync(join(runtimeOutput, "m9r-overlay.exe"))).digest("hex") !== pillSha256) {
  throw new Error("Candidate runtime pill hash does not match its complete runtime manifest.");
}
if (!resumePath) {
  const buildReceipt = {
    schemaVersion: 1,
    buildMode: "fresh-source-overlay",
    candidateId,
    sourceCommit,
    runtimeBuildId: runtimeIdentity.buildId,
    pillSha256,
  };
  writeFileSync(join(candidateRoot, "candidate-build.json"), `${JSON.stringify(buildReceipt, null, 2)}\n`);
} else if (resumedRuntime?.buildId !== runtimeIdentity.buildId) {
  throw new Error("Resumed runtime changed after its fresh-source pill receipt was created.");
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
  buildMode: "fresh-source-overlay",
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
    sourceBuiltPillHash: true,
    packageChecksum: true,
  },
};
writeFileSync(join(candidateRoot, "candidate.json"), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(`Candidate ready: ${candidateRoot}`);
console.log(`Runtime build ID: ${runtimeIdentity.buildId}`);
console.log(`Installer package SHA-256: ${zipHash}`);
