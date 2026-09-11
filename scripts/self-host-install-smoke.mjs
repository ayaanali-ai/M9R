import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const cliRoot = join(repoRoot, "cli");
const npmRunner = process.platform === "win32"
  ? {
      command: process.execPath,
      prefix: [process.env.npm_execpath ?? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")],
    }
  : { command: "npm", prefix: [] };
const tempRoot = mkdtempSync(join(tmpdir(), "m9r-self-host-"));
const tempNpmCache = join(tempRoot, "npm-cache");

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      npm_config_cache: tempNpmCache,
      npm_config_update_notifier: "false",
    },
  });
}

function runNpm(args, cwd) {
  return run(npmRunner.command, [...npmRunner.prefix, ...args], cwd);
}

try {
  // Build the ignored CLI output from source so this smoke test validates a
  // clean checkout rather than relying on a developer's stale cli/dist tree.
  runNpm(["run", "build"], cliRoot);
  runNpm(["pack", "--ignore-scripts", "--pack-destination", tempRoot], cliRoot);
  const tarballName = readdirSync(tempRoot).find((name) => name.endsWith(".tgz"));
  if (!tarballName) throw new Error("CLI package did not produce a tarball");

  runNpm([
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
    join(tempRoot, tarballName),
  ], tempRoot);

  const entry = join(tempRoot, "node_modules", "m9r-cli", "dist", "m9r.js");
  const help = run(process.execPath, [entry, "help"], tempRoot);
  if (!help.includes("m9r")) throw new Error("installed CLI did not respond to help");

  console.log("Self-host install smoke: PASS");
  console.log("Validated: CLI package contents, clean temporary install, and CLI help entrypoint.");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
