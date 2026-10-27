// Build the self-contained M9R engine: one executable that runs with no Node on the machine.
//
// Node's single-executable feature bakes a bundled program into a copy of the node binary. The one program serves both
// jobs: `m9r-engine m9r-hook <Event> <provider>` is what agents run per prompt, anything else is the CLI (`feed --watch`, ...).
// Run `npm run build:cli` first; this bundles cli/dist. Output: engine/dist/m9r-engine.exe (or no extension off Windows).

import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { publishRuntimeBuild, verifyRuntimeBuildManifest, writeRuntimeBuildManifest } from "./engine-build-transaction.mjs";

// Git for Windows ships its own GNU tar earlier on PATH than the real Windows System32 bsdtar.
// GNU tar misparses a bare "C:\..." path as a remote "host:path" spec and cannot read .zip
// archives at all -- it fails with "Cannot connect to C: resolve failed", which looks like a
// network error but is purely a PATH-order collision between two different tar binaries. Calling
// the real one by its full path sidesteps that collision entirely, regardless of PATH order.
const systemTarExe = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const engineDir = join(root, "engine");
const output = join(engineDir, "dist");
const buildRoot = join(engineDir, `.m9r-engine-build-${process.pid}-${randomUUID()}`);
const out = join(buildRoot, "artifacts");
const work = join(buildRoot, "work");
// The desktop build may use an isolated Cargo target directory when a previous
// generated target tree is locked or owned by another Windows boundary.  Never
// silently fall back to an older pill in that case: callers may provide the
// exact freshly-built executable explicitly.
const overlayExe = process.env.M9R_OVERLAY_EXE
  ? resolve(process.env.M9R_OVERLAY_EXE)
  : join(root, "overlay", "src-tauri", "target", "release", "m9r-overlay.exe");
const exeName = process.platform === "win32" ? "m9r-engine.exe" : "m9r-engine";
const brokerBundle = join(root, "cli", "dist", "m9r-web-broker.cjs");
const brokerExeName = process.platform === "win32" ? "m9r-web-broker.exe" : "m9r-web-broker";
const cuaDriverVersion = "0.34.0";
const cuaDriverArchiveSha256 = "bcc520e50861c7092cf775846fec76ae386d7dcd6b5b408608b0ea4423a8b888";
const cuaDriverArchiveUrl = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${cuaDriverVersion}/cua-driver-rs-${cuaDriverVersion}-windows-x86_64-binary.zip`;

// These are recoverable, owner-reviewed local evidence roots. They are not
// source and must not make an otherwise committed release appear dirty, but
// the list is deliberately narrow so an unexpected untracked source file
// still blocks a clean runtime build.
const heldLocalProvenancePatterns = [
  /^\.m9r-(?:live-activation|recovery-quarantine|runtime-package|coordinator-worker|web-broker|installer)-[^/]+(?:\/|$)/i,
  /^\.codex-stage-build-[^/]+(?:\/|$)/i,
  /^\.codex-verify-temp(?:\/|$)/i,
  /^\.opencode(?:\/|$)/i,
  /^\.test-tmp(?:-[^/]+)?(?:\/|$)/i,
  /^\.tmp(?:\/|$)/i,
  /^engine(?:\/|$)/i,
  /^docs\/research(?:\/|$)/i,
  // These are private planning/tracker documents. They are intentionally
  // kept outside the public release commit and must not turn a verified
  // source checkout into a dirty runtime solely because progress was logged.
  /^docs\/M9R_(?:CUMULATIVE_RELIABILITY_AND_DEMO_TRACKER_2026-10-10|MASTER_LIST_2\.1)\.md$/i,
  /^m9r-clean-cutover-[^/]+(?:\/|$)/i,
  /^m9r-release-package-[^/]+(?:\/|$)/i,
  /^m9r-runtime-clean-[^/]+(?:\/|$)/i,
  /^scratchpad(?:\/|$)/i,
  /^\.artifact-scratch(?:\/|$)/i,
  /^docs\/Convenience_Store_Replacement_Plan\.docx$/i,
  /^public\/reference-innerwebs\/m9r-logo-transparent\.png$/i,
];

function isHeldLocalProvenancePath(path) {
  const normalized = path.replaceAll("\\", "/");
  return heldLocalProvenancePatterns.some((pattern) => pattern.test(normalized));
}

if (!existsSync(join(root, "cli", "dist", "m9r.js")) || !existsSync(brokerBundle)) throw new Error("cli/dist is missing: run `npm run build:cli` first.");
if (process.platform === "win32" && !existsSync(overlayExe)) {
  throw new Error("The Windows desktop pill is missing: build it with `npm --prefix overlay run build` before building the standalone engine.");
}
const postjectCli = join(root, "node_modules", "postject", "dist", "cli.js");
if (!existsSync(postjectCli)) throw new Error("postject is missing; install the locked development dependencies before building the engine.");
// Capture source provenance before creating the builder's own temporary staging
// directory. Otherwise the build would report every otherwise-clean checkout as
// dirty because `engine/.m9r-engine-build-*/` exists during this check.
const provenance = sourceProvenance();
mkdirSync(out, { recursive: true });
mkdirSync(work, { recursive: true });

function buildSeaExecutable(main, executable, label) {
  const config = join(work, `${label}-sea-config.json`);
  const blob = join(work, `${label}.blob`);
  writeFileSync(config, JSON.stringify({ main, output: blob, disableExperimentalSEAWarning: true }));
  let result = spawnSync(process.execPath, ["--experimental-sea-config", config], { stdio: "inherit" });
  if (result.error || result.status !== 0) throw new Error(`Could not create the ${label} SEA blob.`, { cause: result.error });

  copyFileSync(process.execPath, executable);
  result = spawnSync(process.execPath, [postjectCli, executable, "NODE_SEA_BLOB", blob, "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2", ...(process.platform === "darwin" ? ["--macho-segment-name", "NODE_SEA"] : [])], { stdio: "inherit" });
  if (result.error || result.status !== 0) throw new Error(`Could not inject the ${label} SEA blob.`, { cause: result.error });
}

function sourceProvenance() {
  const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  if (commit.error || commit.status !== 0) throw new Error("Cannot determine the source commit; refusing to build an unidentified runtime.", { cause: commit.error });
  const sourceCommit = String(commit.stdout).trim();
  if (!/^[a-f0-9]{40}$/i.test(sourceCommit)) throw new Error("Git returned an invalid source commit; refusing to build an unidentified runtime.");
  // Compare content, not the status command's cached file metadata. Native
  // packaging tools can touch a tracked file's mtime without changing bytes;
  // `git status --porcelain` can then report a false dirty build even though
  // the committed source is unchanged. Keep untracked source/artifact paths in
  // the decision, but collapse ignored directories so large runtime evidence
  // trees cannot overflow spawnSync's buffer.
  const runGitCleanCheck = (args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 });
    if (result.error || (result.status !== 0 && result.status !== 1)) {
      throw new Error("Cannot determine source cleanliness; refusing to build an unidentified runtime.", { cause: result.error });
    }
    return result;
  };
  // The private tracker is intentionally allowed to advance alongside a
  // release without becoming part of that release's source fingerprint.
  // Exclude only those two exact tracked paths; every other tracked change
  // remains a hard dirty-build failure.
  const privateTrackerExclusions = [
    ":(exclude)docs/M9R_CUMULATIVE_RELIABILITY_AND_DEMO_TRACKER_2026-10-10.md",
    ":(exclude)docs/M9R_MASTER_LIST_2.1.md",
  ];
  const worktreeDiff = runGitCleanCheck(["diff", "--quiet", "--no-ext-diff", "--ignore-submodules", "--", ".", ...privateTrackerExclusions]);
  const indexDiff = runGitCleanCheck(["diff", "--cached", "--quiet", "--no-ext-diff", "--ignore-submodules", "--", ".", ...privateTrackerExclusions]);
  const untracked = runGitCleanCheck(["ls-files", "--others", "--exclude-standard", "--directory"]);
  const untrackedPaths = String(untracked.stdout).split(/\r?\n/g).map((path) => path.trim()).filter(Boolean);
  const heldLocalEvidence = untrackedPaths.filter(isHeldLocalProvenancePath);
  const untrackedSource = untrackedPaths.filter((path) => !isHeldLocalProvenancePath(path));
  if (heldLocalEvidence.length > 0) {
    console.log(`Excluded ${heldLocalEvidence.length} retained local-evidence root(s) from source provenance.`);
  }
  const sourceDirty = worktreeDiff.status === 1 || indexDiff.status === 1 || untrackedSource.length > 0;
  return { sourceCommit, sourceDirty };
}

// The dispatcher: SEA argv is [exe, exe, ...args]; shift so both programs see the argv they were written for.
const hookJs = join(root, "cli", "dist", "m9r-hook.js").split(String.fromCharCode(92)).join("/");
const mcpJs = join(root, "cli", "dist", "m9r-mcp.js").split(String.fromCharCode(92)).join("/");
const devMcpJs = join(root, "cli", "dist", "dev-mcp-server.js").split(String.fromCharCode(92)).join("/");
const cliJs = join(root, "cli", "dist", "m9r.js").split(String.fromCharCode(92)).join("/");
const entry = join(work, "entry.mjs");
try {
writeFileSync(entry, `
const args = process.argv.slice(2);
const isHook = args[0] === "m9r-hook" || args[0] === "hook";
const isMcp = !isHook && args[0] === "mcp";
const isDevMcp = !isHook && !isMcp && args[0] === "dev-mcp-server";
process.argv = [process.argv[0], process.argv[0], ...(isHook || isMcp || isDevMcp ? args.slice(1) : args)];
(isHook ? import(${JSON.stringify(hookJs)}) : isMcp ? import(${JSON.stringify(mcpJs)}) : isDevMcp ? import(${JSON.stringify(devMcpJs)}) : import(${JSON.stringify(cliJs)})).catch((e) => { if (!isHook) console.error(e); process.exit(isHook ? 0 : 1); });
`);

await build({
  entryPoints: [entry],
  outfile: join(work, "bundle.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  logLevel: "warning",
  // import.meta.url is used by the CLI for locating itself; SEA has no file URL, so point it at the exe.
  define: { "import.meta.url": "__m9rUrl" },
  banner: { js: 'const __m9rUrl = require("node:url").pathToFileURL(process.execPath).href;' },
  // Keep the non-standalone CLI's lazy Node import external. In the SEA engine, the standalone runtime resolver
  // instead starts the separately packaged m9r-web-broker.exe beside the engine.
  external: ["./m9r-web-broker"],
});

const exe = join(out, exeName);
buildSeaExecutable(join(work, "bundle.cjs"), exe, "engine");
const brokerExe = join(out, brokerExeName);
buildSeaExecutable(brokerBundle, brokerExe, "web-broker");
// The small native hook (hook/): agents run this, not the big engine, so a cold start can never hit their hook time limit.
const cargoEnv = { ...process.env, PATH: `${process.env.PATH}${process.platform === "win32" ? ";" : ":"}${join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".cargo", "bin")}` };
let r = spawnSync("cargo", ["build", "--release"], { cwd: join(root, "hook"), env: cargoEnv, stdio: "inherit" });
if (r.error || r.status !== 0) throw new Error("The native hook build failed.", { cause: r.error });
const shimName = process.platform === "win32" ? "m9r-hook.exe" : "m9r-hook-native";
copyFileSync(join(root, "hook", "target", "release", process.platform === "win32" ? "m9r-hook.exe" : "m9r-hook"), join(out, shimName));
// The visible-tab click path must use trusted OS input. Ship its Windows-only Native Messaging host beside the engine.
if (process.platform === "win32") {
  r = spawnSync("cargo", ["build", "--release"], { cwd: join(root, "native-input-host"), env: cargoEnv, stdio: "inherit" });
  if (r.error || r.status !== 0) throw new Error("The native input host build failed.", { cause: r.error });
  copyFileSync(join(root, "native-input-host", "target", "release", "m9r-native-input-host.exe"), join(out, "m9r-native-input-host.exe"));

  // Keep the JavaScript SDK and native bindings beside the executable, and include
  // Cua's separately built DPI-aware Windows daemon. M9R must use the daemon path
  // for the OS cursor overlay; the in-process Node runtime is DPI-virtualized on
  // scaled Windows displays.
  const cuaRuntimeRoot = join(out, "cua-driver-runtime");
  const cuaRuntime = join(cuaRuntimeRoot, "node_modules");
  rmSync(cuaRuntimeRoot, { recursive: true, force: true });
  for (const packageName of [
    "@trycua/cua-driver",
    "@trycua/cua-driver-win32-x64-msvc",
    "@ubjs/core",
    "@ubjs/node",
    "@ubjs/node-win32-x64-msvc",
  ]) {
    const source = join(root, "node_modules", packageName);
    if (!existsSync(source)) throw new Error(`Cua Driver release dependency is missing: ${packageName}. Install the locked root dependencies first.`);
    const destination = join(cuaRuntime, packageName);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true });
  }
  const driverDll = join(cuaRuntime, "@trycua", "cua-driver-win32-x64-msvc", "cua_driver_sdk.dll");
  const driverAddon = join(cuaRuntime, "@trycua", "cua-driver-win32-x64-msvc", "cua_driver_node_runtime.node");
  const ubjsAddon = join(cuaRuntime, "@ubjs", "node-win32-x64-msvc", "uniffi-runtime-napi.win32-x64-msvc.node");
  for (const required of [driverDll, driverAddon, ubjsAddon]) {
    if (!existsSync(required)) throw new Error(`Cua Driver release binary is missing: ${required}`);
  }

  const installedDriverPackage = JSON.parse(readFileSync(join(cuaRuntime, "@trycua", "cua-driver", "package.json"), "utf8"));
  if (installedDriverPackage.version !== cuaDriverVersion) {
    throw new Error(`The JavaScript Cua Driver package is ${installedDriverPackage.version}; the Windows runtime is pinned to ${cuaDriverVersion}.`);
  }

  const archiveRoot = join(root, ".workcache", "cua-driver-release", cuaDriverVersion);
  const archivePath = join(archiveRoot, `cua-driver-rs-${cuaDriverVersion}-windows-x86_64-binary.zip`);
  mkdirSync(archiveRoot, { recursive: true });
  if (!existsSync(archivePath)) {
    console.log(`Downloading pinned Cua Driver ${cuaDriverVersion} Windows daemon...`);
    const response = await fetch(cuaDriverArchiveUrl, { redirect: "follow" });
    if (!response.ok) throw new Error(`Could not download Cua Driver ${cuaDriverVersion} (${response.status} ${response.statusText}).`);
    writeFileSync(archivePath, Buffer.from(await response.arrayBuffer()));
  }
  const archiveHash = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
  if (archiveHash !== cuaDriverArchiveSha256) {
    throw new Error(`Cua Driver ${cuaDriverVersion} Windows archive checksum mismatch: ${archiveHash}. Refusing to package an unverified daemon.`);
  }
  const expectedEntries = ["cua-driver.exe", "cua-cursor-theme.exe", "cua-driver-uia.exe", "cua_driver_sdk.dll", "cua_driver_node_runtime.node", "cua_driver_abi.h"];
  const archiveEntries = spawnSync(systemTarExe, ["-tf", archivePath], { encoding: "utf8", windowsHide: true });
  if (archiveEntries.status !== 0) throw new Error(`Could not list the verified Cua Driver archive: ${archiveEntries.stderr || archiveEntries.stdout}`);
  const entries = archiveEntries.stdout.trim().split(/\r?\n/).filter(Boolean).sort();
  if (JSON.stringify(entries) !== JSON.stringify([...expectedEntries].sort())) {
    throw new Error(`Cua Driver ${cuaDriverVersion} archive contents changed; review before packaging. Found: ${entries.join(", ")}`);
  }
  const extractedRoot = join(work, `cua-driver-${cuaDriverVersion}-windows`);
  rmSync(extractedRoot, { recursive: true, force: true });
  mkdirSync(extractedRoot, { recursive: true });
  const extraction = spawnSync(systemTarExe, ["-xf", archivePath, "-C", extractedRoot], { stdio: "inherit", windowsHide: true });
  if (extraction.status !== 0) throw new Error(`Could not extract verified Cua Driver ${cuaDriverVersion} Windows files.`);
  const binaryRoot = join(cuaRuntimeRoot, "bin");
  mkdirSync(binaryRoot, { recursive: true });
  for (const asset of expectedEntries) {
    const source = join(extractedRoot, asset);
    if (!existsSync(source)) throw new Error(`Verified Cua Driver archive is missing ${asset}.`);
    copyFileSync(source, join(binaryRoot, asset));
  }

  // Keep engine/dist as the single runtime source used by local setup and release packaging.
  // The release workflow builds the pill before this script, so this copy cannot silently retain
  // a previous overlay when a new desktop build has been produced.
  copyFileSync(overlayExe, join(out, "m9r-overlay.exe"));
  console.log(`Packaged Cua Driver ${cuaDriverVersion} Windows standalone host (SHA-256 verified).`);
}

const managedRuntimePaths = [exeName, brokerExeName, shimName,
  ...(process.platform === "win32" ? ["m9r-native-input-host.exe", "cua-driver-runtime", "m9r-overlay.exe"] : [])];
writeRuntimeBuildManifest(out, undefined, provenance);
const stagedIdentity = verifyRuntimeBuildManifest(out, { exact: true });
const publishedIdentity = publishRuntimeBuild(out, output, managedRuntimePaths);
if (publishedIdentity.buildId !== stagedIdentity.buildId) throw new Error("Published runtime identity differs from its staged artifact hashes.");
console.log(`Built ${join(output, exeName)} (${Math.round(readFileSync(join(output, exeName)).length / 1e6)} MB)`);
console.log(`Built ${join(output, brokerExeName)} (${Math.round(readFileSync(join(output, brokerExeName)).length / 1e6)} MB)`);
console.log(`Runtime build identity ${publishedIdentity.buildId} verified across ${Object.keys(publishedIdentity.artifacts).length} files.`);
console.log(`Runtime source ${provenance.sourceCommit} (${provenance.sourceDirty ? "dirty" : "clean"}).`);
if (process.platform === "win32") console.log(`Packaged ${join(output, "m9r-overlay.exe")} from the current desktop build.`);
} finally {
  rmSync(buildRoot, { recursive: true, force: true });
}
