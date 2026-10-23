import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const relayUrl = process.env.MISSION_RELAY_PUBLIC_URL ?? config.vars?.MISSION_RELAY_PUBLIC_URL;

if (!relayUrl || !/^wss:\/\//.test(relayUrl)) {
  console.error("MISSION_RELAY_PUBLIC_URL must be a public wss:// URL.");
  process.exit(1);
}

const env = {
  ...process.env,
  CLOUDFLARE_BUILD: "true",
  MISSION_RELAY_PUBLIC_URL: relayUrl,
};

console.log("Building the Cloudflare Worker with the supported OpenNext build pipeline.");
console.log("The local OpenNext entry point is invoked directly so build arguments cannot be reinterpreted by a shell.");

const cloudflareEntry = resolve(process.cwd(), "node_modules", "@opennextjs", "cloudflare", "dist", "cli", "index.js");
const result = spawnSync(process.execPath, [cloudflareEntry, "build"], {
  stdio: "inherit",
  shell: false,
  env,
});

if (result.error) {
  console.error("Could not start the OpenNext build:", result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
