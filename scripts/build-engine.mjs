// Build the self-contained M9R engine: one executable that runs with no Node on the machine.
//
// Node's single-executable feature bakes a bundled program into a copy of the node binary. The one program serves both
// jobs: `m9r-engine m9r-hook <Event> <provider>` is what agents run per prompt, anything else is the CLI (`feed --watch`, ...).
// Run `npm run build:cli` first; this bundles cli/dist. Output: engine/dist/m9r-engine.exe (or no extension off Windows).

import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "engine", "dist");
const work = join(out, "work");
const exeName = process.platform === "win32" ? "m9r-engine.exe" : "m9r-engine";
const brokerBundle = join(root, "cli", "dist", "m9r-web-broker.cjs");
const brokerExeName = process.platform === "win32" ? "m9r-web-broker.exe" : "m9r-web-broker";
const cuaDriverVersion = "0.33.4";
const cuaDriverArchiveSha256 = "93f658ac02080ac1fac709f88f79ba38980ce77b816725ec2a0128aeba1811f5";
const cuaDriverArchiveUrl = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${cuaDriverVersion}/cua-driver-${cuaDriverVersion}-windows-x86_64-binary.zip`;

if (!existsSync(join(root, "cli", "dist", "m9r.js")) || !existsSync(brokerBundle)) throw new Error("cli/dist is missing: run `npm run build:cli` first.");
rmSync(work, { recursive: true, force: true });
for (const name of [exeName, brokerExeName, process.platform === "win32" ? "m9r-hook.exe" : "m9r-hook-native", ...(process.platform === "win32" ? ["m9r-native-input-host.exe"] : [])]) {
  rmSync(join(out, name), { force: true });
}
mkdirSync(work, { recursive: true });

const postjectCli = join(root, "node_modules", "postject", "dist", "cli.js");
if (!existsSync(postjectCli)) throw new Error("postject is missing; install the locked development dependencies before building the engine.");

function buildSeaExecutable(main, executable, label) {
  const config = join(work, `${label}-sea-config.json`);
  const blob = join(work, `${label}.blob`);
  writeFileSync(config, JSON.stringify({ main, output: blob, disableExperimentalSEAWarning: true }));
  let result = spawnSync(process.execPath, ["--experimental-sea-config", config], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);

  copyFileSync(process.execPath, executable);
  result = spawnSync(process.execPath, [postjectCli, executable, "NODE_SEA_BLOB", blob, "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2", ...(process.platform === "darwin" ? ["--macho-segment-name", "NODE_SEA"] : [])], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// The dispatcher: SEA argv is [exe, exe, ...args]; shift so both programs see the argv they were written for.
const hookJs = join(root, "cli", "dist", "m9r-hook.js").split(String.fromCharCode(92)).join("/");
const mcpJs = join(root, "cli", "dist", "m9r-mcp.js").split(String.fromCharCode(92)).join("/");
const devMcpJs = join(root, "cli", "dist", "dev-mcp-server.js").split(String.fromCharCode(92)).join("/");
const cliJs = join(root, "cli", "dist", "m9r.js").split(String.fromCharCode(92)).join("/");
const entry = join(work, "entry.mjs");
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
if (r.status !== 0) process.exit(r.status ?? 1);
const shimName = process.platform === "win32" ? "m9r-hook.exe" : "m9r-hook-native";
copyFileSync(join(root, "hook", "target", "release", process.platform === "win32" ? "m9r-hook.exe" : "m9r-hook"), join(out, shimName));
// The visible-tab click path must use trusted OS input. Ship its Windows-only Native Messaging host beside the engine.
if (process.platform === "win32") {
  r = spawnSync("cargo", ["build", "--release"], { cwd: join(root, "native-input-host"), env: cargoEnv, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
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
  const archivePath = join(archiveRoot, `cua-driver-${cuaDriverVersion}-windows-x86_64-binary.zip`);
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
  const archiveEntries = spawnSync("tar.exe", ["-tf", archivePath], { encoding: "utf8", windowsHide: true });
  if (archiveEntries.status !== 0) throw new Error(`Could not list the verified Cua Driver archive: ${archiveEntries.stderr || archiveEntries.stdout}`);
  const entries = archiveEntries.stdout.trim().split(/\r?\n/).filter(Boolean).sort();
  if (JSON.stringify(entries) !== JSON.stringify([...expectedEntries].sort())) {
    throw new Error(`Cua Driver ${cuaDriverVersion} archive contents changed; review before packaging. Found: ${entries.join(", ")}`);
  }
  const extractedRoot = join(work, `cua-driver-${cuaDriverVersion}-windows`);
  rmSync(extractedRoot, { recursive: true, force: true });
  mkdirSync(extractedRoot, { recursive: true });
  const extraction = spawnSync("tar.exe", ["-xf", archivePath, "-C", extractedRoot], { stdio: "inherit", windowsHide: true });
  if (extraction.status !== 0) throw new Error(`Could not extract verified Cua Driver ${cuaDriverVersion} Windows files.`);
  const binaryRoot = join(cuaRuntimeRoot, "bin");
  mkdirSync(binaryRoot, { recursive: true });
  for (const asset of expectedEntries) {
    const source = join(extractedRoot, asset);
    if (!existsSync(source)) throw new Error(`Verified Cua Driver archive is missing ${asset}.`);
    copyFileSync(source, join(binaryRoot, asset));
  }
  console.log(`Packaged Cua Driver ${cuaDriverVersion} Windows standalone host (SHA-256 verified).`);
}
console.log(`Built ${exe} (${Math.round(readFileSync(exe).length / 1e6)} MB)`);
console.log(`Built ${brokerExe} (${Math.round(readFileSync(brokerExe).length / 1e6)} MB)`);
