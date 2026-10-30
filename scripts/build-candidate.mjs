// Build a complete, hash-verified runtime candidate without touching cli/dist,
// engine/dist, the accepted runtime policy, or the installed ~/.m9r/bin.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { verifyRuntimeBuildManifest } from "./engine-build-transaction.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const engineDir = join(root, "engine");
const commitResult = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
if (commitResult.error || commitResult.status !== 0) {
  throw new Error("Cannot identify the source commit; refusing to build an unlabeled candidate.", { cause: commitResult.error });
}
const sourceCommit = String(commitResult.stdout).trim();
if (!/^[a-f0-9]{40}$/i.test(sourceCommit)) throw new Error("Git returned an invalid source commit.");

const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const candidateId = `${timestamp}-${sourceCommit.slice(0, 8)}`;
const candidateRoot = join(engineDir, "candidates", candidateId);
const cliOutput = join(candidateRoot, "cli-dist");
const runtimeOutput = join(candidateRoot, "runtime");
const packageOutput = join(candidateRoot, "package");
if (existsSync(candidateRoot)) throw new Error(`Candidate path already exists; refusing to overwrite it: ${candidateRoot}`);

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

runNodeScript("build-cli.mjs", { M9R_CLI_OUTPUT_DIR: cliOutput });
runNodeScript("build-engine.mjs", {
  M9R_CLI_OUTPUT_DIR: cliOutput,
  M9R_ENGINE_OUTPUT_DIR: runtimeOutput,
});

const runtimeIdentity = verifyRuntimeBuildManifest(runtimeOutput, { exact: true });
const acceptedPath = join(root, "release-assets", "accepted-runtime.json");
const accepted = JSON.parse(readFileSync(acceptedPath, "utf8"));
if (runtimeIdentity.artifacts["m9r-overlay.exe"] !== accepted.artifacts?.["m9r-overlay.exe"]) {
  throw new Error("Candidate pill hash differs from the accepted pill; refusing to package a different UI.");
}

const packageResult = spawnSync("powershell.exe", [
  "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(root, "scripts", "package-engine-release.ps1"),
  "-OutputDirectory", packageOutput,
  "-RuntimeDirectory", runtimeOutput,
  "-CliDistDirectory", cliOutput,
  "-AcceptedRuntimePath", join(runtimeOutput, "m9r-build-info.json"),
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
  candidateId,
  sourceCommit,
  runtimeBuildId: runtimeIdentity.buildId,
  sourceDirty: runtimeIdentity.source?.sourceDirty ?? null,
  acceptedPillSha256: accepted.artifacts["m9r-overlay.exe"],
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
