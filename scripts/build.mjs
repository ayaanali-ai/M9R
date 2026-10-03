// `npm run build`. Plain Next build everywhere, except inside Cloudflare Workers Builds (WORKERS_CI=1), where the Worker
// bundle must exist before `wrangler deploy` (which hands off to `opennextjs-cloudflare deploy`) can upload it.
// --skipNextBuild stops OpenNext from calling `npm run build` again, so this never recurses.
import { spawnSync } from "node:child_process";

const run = (command, args, env = process.env) => {
  const result = spawnSync(command, args, { stdio: "inherit", shell: true, env });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

const onCloudflare = process.env.WORKERS_CI === "1" || process.env.M9R_BUILD_TARGET === "cloudflare";

if (process.env.M9R_BUILD_DRY === "1") {
  console.log(onCloudflare ? "cloudflare: next build --turbopack, then opennextjs-cloudflare build --skipNextBuild" : "plain: next build --turbopack");
  process.exit(0);
}

const env = onCloudflare
  ? { ...process.env, MISSION_RELAY_PUBLIC_URL: process.env.MISSION_RELAY_PUBLIC_URL || "wss://m9r-relay.m9r.workers.dev" }
  : process.env;

run("npx", ["next", "build", "--turbopack"], env);
if (onCloudflare) run("npx", ["opennextjs-cloudflare", "build", "--skipNextBuild"], env);
