// Build the self-contained M9R engine: one executable that runs with no Node on the machine.
//
// Node's single-executable feature bakes a bundled program into a copy of the node binary. The one program serves both
// jobs: `m9r-engine m9r-hook <Event> <provider>` is what agents run per prompt, anything else is the CLI (`feed --watch`, ...).
// Run `npm run build:cli` first; this bundles cli/dist. Output: engine/dist/m9r-engine.exe (or no extension off Windows).

import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
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
}
console.log(`Built ${exe} (${Math.round(readFileSync(exe).length / 1e6)} MB)`);
console.log(`Built ${brokerExe} (${Math.round(readFileSync(brokerExe).length / 1e6)} MB)`);
