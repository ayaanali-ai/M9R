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

if (!existsSync(join(root, "cli", "dist", "m9r.js"))) throw new Error("cli/dist is missing: run `npm run build:cli` first.");
rmSync(out, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

// The dispatcher: SEA argv is [exe, exe, ...args]; shift so both programs see the argv they were written for.
const hookJs = join(root, "cli", "dist", "m9r-hook.js").split(String.fromCharCode(92)).join("/");
const cliJs = join(root, "cli", "dist", "m9r.js").split(String.fromCharCode(92)).join("/");
const entry = join(work, "entry.mjs");
writeFileSync(entry, `
const args = process.argv.slice(2);
const isHook = args[0] === "m9r-hook" || args[0] === "hook";
process.argv = [process.argv[0], process.argv[0], ...(isHook ? args.slice(1) : args)];
(isHook ? import(${JSON.stringify(hookJs)}) : import(${JSON.stringify(cliJs)})).catch((e) => { if (!isHook) console.error(e); process.exit(isHook ? 0 : 1); });
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
});

writeFileSync(join(work, "sea-config.json"), JSON.stringify({ main: join(work, "bundle.cjs"), output: join(work, "blob.blob"), disableExperimentalSEAWarning: true }));
let r = spawnSync(process.execPath, ["--experimental-sea-config", join(work, "sea-config.json")], { stdio: "inherit" });
if (r.status !== 0) process.exit(r.status ?? 1);

const exe = join(out, exeName);
copyFileSync(process.execPath, exe);
r = spawnSync("npx", ["--yes", "postject", exe, "NODE_SEA_BLOB", join(work, "blob.blob"), "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2", ...(process.platform === "darwin" ? ["--macho-segment-name", "NODE_SEA"] : [])], { stdio: "inherit", shell: true });
if (r.status !== 0) process.exit(r.status ?? 1);
console.log(`Built ${exe} (${Math.round(readFileSync(exe).length / 1e6)} MB)`);
