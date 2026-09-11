/**
 * Standalone entry point for the local Mission ACP Bridge, spawned as a
 * separate process by scripts/oathlock-terminal-bridge.ts (see that file's
 * comment on why this is a separate process rather than an in-process
 * import). Now packaged into the `cli/` distributable too --
 * scripts/build-cli.mjs's whitelist ships this file and its full ACP/relay
 * dependency tree (traced import-by-import, type-only edges excluded) as
 * plain compiled JS, no tsx required. Runs unmodified in both the monorepo
 * (via tsx, as source) and the published CLI (via node, pre-compiled) --
 * oathlock-terminal-bridge.ts picks the right one at spawn time by checking
 * its own import.meta.url extension.
 *
 * This process is long-lived by design -- it holds the live ACP session a
 * conversation thread depends on (see sessionThreadMessageIds in
 * bridge-runtime.ts), so it is never respawned per turn the way `resident
 * run` cycles are. That means a rebuild while this process is already
 * running would otherwise go unnoticed indefinitely: confirmed live this
 * session, `resident run`'s own freshness check restarted correctly on a
 * rebuild, but this specific child -- the one actually running the changed
 * bridge-runtime.ts code -- kept running stale code underneath it the whole
 * time. oathlock-terminal-bridge.ts already supervises this exact child with
 * createResidentSupervisor (the same generic budget-aware supervisor `resident
 * run` uses), so reusing RESIDENT_STALE_BUILD_EXIT_CODE here gets an
 * immediate, budget-free relaunch for free -- no new supervision logic needed.
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startLocalMissionBridge } from "./local-mission-bridge-bootstrap";
import { RESIDENT_STALE_BUILD_EXIT_CODE } from "../resident-supervisor";

const repositoryRoot = process.cwd();

async function currentBuildTimestamp(): Promise<string | null> {
  try {
    const infoPath = resolve(dirname(fileURLToPath(import.meta.url)), "build-info.json");
    const raw = JSON.parse(await readFile(infoPath, "utf8")) as { builtAt?: unknown };
    return typeof raw.builtAt === "string" ? raw.builtAt : null;
  } catch {
    return null;
  }
}

/**
 * Confirmed live this session: killing this process mid-turn to pick up a
 * rebuild is exactly what produces the "ACP connection closed" failure a
 * human sees -- a real, in-flight turn gets torn down with no warning. Once
 * staleness is detected, this defers the actual exit while hasActiveWork()
 * is true, rechecking on the same interval, instead of exiting immediately.
 * A hard ceiling still applies: a bridge that's continuously busy for the
 * whole window restarts anyway rather than a rebuild being blocked forever
 * by one channel that never goes idle -- mirrors this codebase's other
 * bounded waits (e.g. acp-stdio-adapter.ts's own prompt timeout) rather than
 * introducing a new unbounded wait pattern.
 */
const STALE_BUILD_MAX_DEFER_MS = 10 * 60_000;

/** No-ops when running from source via tsx, same as oathlock-cli.ts's identical check -- there is no build-info.json alongside source, and live source is never stale relative to itself. */
function watchBuildFreshness(hasActiveWork: () => boolean): void {
  let baseline: string | null | undefined;
  let staleSince: number | null = null;
  const timer = setInterval(() => {
    void currentBuildTimestamp().then((builtAt) => {
      if (builtAt === null) return;
      if (baseline === undefined) { baseline = builtAt; return; }
      if (baseline === null || builtAt === baseline) return;
      if (staleSince === null) staleSince = Date.now();
      const deferredTooLong = Date.now() - staleSince >= STALE_BUILD_MAX_DEFER_MS;
      if (hasActiveWork() && !deferredTooLong) {
        process.stderr.write(`Mission ACP Bridge: newer build (${builtAt}) detected on disk, deferring restart -- a turn is still in flight.\n`);
        return;
      }
      process.stderr.write(deferredTooLong
        ? `Mission ACP Bridge: newer build (${builtAt}) detected on disk; work stayed active past the ${STALE_BUILD_MAX_DEFER_MS / 60_000}min deferral ceiling, restarting anyway.\n`
        : `Mission ACP Bridge: newer build (${builtAt}) detected on disk, restarting to pick it up.\n`);
      process.exit(RESIDENT_STALE_BUILD_EXIT_CODE);
    });
  }, 30_000);
  timer.unref();
}

startLocalMissionBridge(repositoryRoot).then((result) => {
  if (result.ok) {
    process.stdout.write(`Mission ACP Bridge is running locally (${result.provider} connection, bridge ${result.handle.bridgeInstanceId}).\n`);
    watchBuildFreshness(result.handle.hasActiveWork);
    process.once("SIGTERM", () => { void result.handle.stop().then(() => process.exit(0)); });
    process.once("SIGINT", () => { void result.handle.stop().then(() => process.exit(0)); });
    return;
  }
  if (result.reason === "already_running") {
    // Expected, not an error: this process lost the lock race to a sibling
    // that's still healthy (see local-mission-bridge-bootstrap.ts's own
    // leader-election comment) -- the exact case this lock exists to make a
    // clean, silent no-op instead of two live bridges for the same provider.
    process.stdout.write(`Mission ACP Bridge (${result.detail ?? "already running"}) -- exiting, the existing process stays up.\n`);
  } else if (result.reason !== "acp_bridge_disabled" && result.reason !== "no_local_token") {
    process.stderr.write(`Mission ACP Bridge did not start (${result.reason}${result.detail ? `: ${result.detail}` : ""}).\n`);
  }
  process.exit(0);
}).catch((error) => {
  process.stderr.write(`Mission ACP Bridge crashed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(0);
});
