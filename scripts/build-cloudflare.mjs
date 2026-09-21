import { spawnSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

// Set MISSION_RELAY_PUBLIC_URL in process.env so both builds inherit it
if (!process.env.MISSION_RELAY_PUBLIC_URL) {
  console.error("MISSION_RELAY_PUBLIC_URL must be set (wss:// URL of the Cloudflare Relay Worker).");
  process.exit(1);
}
process.env.CLOUDFLARE_BUILD = "true";

console.log("Building Next.js app for Cloudflare (with typecheck ignored)...");
console.log("MISSION_RELAY_PUBLIC_URL:", process.env.MISSION_RELAY_PUBLIC_URL);

const buildResult = spawnSync("npx", ["next", "build", "--webpack"], { 
  stdio: "inherit", 
  shell: true,
  env: process.env
});

console.log("Build exit code:", buildResult.status);
if (buildResult.status) process.exit(buildResult.status);

console.log("Fixing Next.js 16.3.4 validator.ts syntax error...");
const validatorPath = join(process.cwd(), ".next", "dev", "types", "validator.ts");
try {
  const content = readFileSync(validatorPath, "utf8");
  const fixed = content.replace(/^ype __Unused = __Check$/gm, "type __Unused = __Check");
  if (content !== fixed) {
    writeFileSync(validatorPath, fixed, "utf8");
    console.log("Fixed generated validator.ts (missing 't' in 'type')");
  }
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}

console.log("Building OpenNext Cloudflare worker...");
const openNextResult = spawnSync("npx", ["opennextjs-cloudflare", "build", "--skip-typecheck"], { 
  stdio: "inherit", 
  shell: true,
  env: process.env
});

process.exit(openNextResult.status ?? 0);