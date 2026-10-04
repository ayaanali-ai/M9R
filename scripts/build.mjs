// `npm run build`. Plain Next build everywhere, except inside Cloudflare Workers Builds, where the Worker bundle must
// exist before `wrangler deploy` (which hands off to `opennextjs-cloudflare deploy`) can upload it.
//
// OpenNext has to run the Next build itself (with --skipNextBuild it cannot find .next/server/middleware.js.nft.json), and it
// does that by calling `npm run build` again. M9R_OPENNEXT_INNER marks that second call so it builds Next and does not recurse.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const run = (command, args, env = process.env) => {
  const result = spawnSync(command, args, { stdio: "inherit", shell: true, env });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

// Workers Builds sets WORKERS_CI, but its build image is also recognisable by /opt/buildhome, so either one is enough.
const onCloudflare = process.env.WORKERS_CI === "1" || process.env.M9R_BUILD_TARGET === "cloudflare" || (process.platform === "linux" && existsSync("/opt/buildhome"));
const inner = process.env.M9R_OPENNEXT_INNER === "1";

if (process.env.M9R_BUILD_DRY === "1") {
  console.log(onCloudflare && !inner ? "cloudflare: opennextjs-cloudflare build (runs next build --turbopack through this script)" : "plain: next build --turbopack");
  process.exit(0);
}

if (onCloudflare && !inner) {
  run("npx", ["opennextjs-cloudflare", "build"], {
    ...process.env,
    CLOUDFLARE_BUILD: "true",
    M9R_OPENNEXT_INNER: "1",
    MISSION_RELAY_PUBLIC_URL: process.env.MISSION_RELAY_PUBLIC_URL || "wss://m9r-relay.m9r.workers.dev",
  });
} else if (onCloudflare) {
  // Cloudflare's Linux Workers Builds image currently fails to resolve the
  // generated `next/font/google` Turbopack module. Keep local builds on the
  // default Turbopack path, but use Next's supported Webpack build for the
  // Cloudflare/OpenNext production bundle.
  run("npx", ["next", "build", "--webpack"], {
    ...process.env,
    CLOUDFLARE_BUILD: "true",
  });
} else {
  run("npx", ["next", "build", "--turbopack"]);
}
