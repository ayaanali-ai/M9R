/**
 * Starts the local web broker the M9R browser extension connects to. Spike entry point: run with
 * `npx tsx scripts/m9r-web-broker.ts`. The fixed development extension ID is allow-listed; M9R_WEB_BROKER_PORT
 * overrides the port. This entry point never enables arbitrary extension origins.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createLocalStore, defaultStoreRoot } from "@/lib/native/local-store";
import { writeWebActivity } from "@/lib/native/feed-writer";
import { apiKeyLaunchBlock } from "@/lib/native/vendor-launch-core";
import { createWebLiveSessions, loadAgentsConfig, projectRoomId } from "@/lib/native/web-live-sessions";
import { createWebUiBridge } from "@/lib/native/web-ui-bridge";
import { createPageNotesStore } from "@/lib/native/page-notes-store";
import { pullCloudNotes, pushCloudNote } from "@/lib/native/cloud-memory";
import { launchDesktopOverlayIfNeeded, readDesktopPillRunning } from "@/lib/native/desktop-pill-presence";
import { DEFAULT_BROKER_PORT, brokerKeyPath, ownerPipePath } from "@/lib/native/web-broker-paths";
import { loadOrCreateBrokerKey, startWebBroker } from "@/lib/native/web-broker-server";
import { createWebAuthority } from "@/lib/native/web-authority-core";
import { createWebAuthorityStore } from "@/lib/native/web-authority-store";
import { webExtensionAllowlist } from "@/lib/native/web-setup-core";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const homeIndex = args.indexOf("--home");
  if (homeIndex >= 0 && args[homeIndex + 1]) process.env.M9R_HOME = args[homeIndex + 1];
  const portIndex = args.indexOf("--port");
  if (portIndex >= 0 && args[portIndex + 1]) process.env.M9R_WEB_BROKER_PORT = args[portIndex + 1];
  const projectRootIndex = args.indexOf("--project-root");
  if (projectRootIndex >= 0 && args[projectRootIndex + 1]) process.env.M9R_PROJECT_ROOT = args[projectRootIndex + 1];
  const projectRoot = resolve(process.env.M9R_PROJECT_ROOT?.trim() || process.cwd());
  process.env.M9R_PROJECT_ROOT = projectRoot;
  const root = defaultStoreRoot(homedir(), process.env);
  const key = loadOrCreateBrokerKey(brokerKeyPath(root));
  const ownerId = process.env.M9R_OWNER_ID?.trim() || "local-machine";
  const authorityStore = createWebAuthorityStore(root);
  const authority = createWebAuthority({ ownerId });
  authority.restore(authorityStore.load());
  const port = Number(process.env.M9R_WEB_BROKER_PORT) || DEFAULT_BROKER_PORT;
  // The in-page pill: agents the owner types to, one live session per agent and folder (web-live-sessions.ts).
  const pageNotes = createPageNotesStore(root);
  // A note saved from the pill lands in the same project-room memory agents read at session start.
  const ui = createWebUiBridge({
    saveNote: (text) => {
      const result = pageNotes.append({ room: projectRoomId(projectRoot), agent: "you", text, source: "agent" });
      if (result.ok) void pushCloudNote(root, text); // best effort: also appears in the team's dashboard when this machine is connected
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    },
  });
  // Keep a local copy of the team's saved notes fresh for the agents' session prompts (no-op until `m9r cloud connect`).
  void pullCloudNotes(root);
  setInterval(() => void pullCloudNotes(root), 5 * 60_000).unref();
  // A real POST /web/shutdown (m9r web restart, or any owner-triggered restart) must stop this whole process, not just
  // close the HTTP socket, or the unref'd-less feed timer below keeps Node running forever with nothing left listening.
  let requestShutdown = () => {};
  const broker = await startWebBroker({ key, port, allowedExtensionIds: webExtensionAllowlist(), ownerId, authority, authorityStore, modeFile: join(root, "room-mode.txt"), ownerPipePath: ownerPipePath(root), ui, loopGuard: { repeat: 3, budget: 120, windowMs: 10 * 60_000 }, onShutdownRequested: () => requestShutdown() });
  // The broker already autostarts at login; piggyback the desktop pill's launch onto that same moment instead of
  // requiring the owner to double-click it by hand after every reboot.
  launchDesktopOverlayIfNeeded(root);
  const config = loadAgentsConfig(root, { cwd: projectRoot });
  const sessions = createWebLiveSessions({
    agents: config.agents, storeRoot: root, repoRoot: projectRoot, brokerPort: broker.port,
    store: createLocalStore(root), onEvent: (event) => ui.onSessionEvent(event),
  });
  ui.attachSessions(sessions);
  process.stdout.write(`M9R web broker listening on 127.0.0.1:${broker.port}\n`);
  process.stdout.write(`Project root: ${projectRoot}\n`);
  process.stdout.write(`Agents (${config.source === "default" ? "defaults; add agents.json to your M9R folder to change" : config.source}): ${config.agents.map((a) => `@${a.handle} (${a.provider}, ${a.folder})`).join(", ")}\n`);
  for (const problem of config.problems) process.stdout.write(`  note: ${problem}\n`);
  const blocked = apiKeyLaunchBlock(process.env, false);
  if (blocked) process.stdout.write(`  warning: agents will not start. ${blocked}\n`);
  // A separately persisted, redacted web-surface feed beside the native feed; never mutates feed.json.
  let lastWeb = "";
  const webTimer = setInterval(() => {
    const body = JSON.stringify(ui.recentWeb());
    if (body === lastWeb) return;
    lastWeb = body;
    try { writeWebActivity(root, ui.recentWeb()); } catch { /* the pill feed is optional */ }
  }, 1000);
  // One pill at a time: the desktop pill beats a heartbeat file; while it is running the in-page pill steps aside.
  const presenceTimer = setInterval(() => ui.setDesktopPill(readDesktopPillRunning(root)), 2000);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(webTimer); clearInterval(presenceTimer); sessions.close(); ui.close(); void broker.close().then(() => process.exit(0));
  };
  requestShutdown = stop;
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

// A single failed background write must not take the owner's broker down in the middle of a demo.
process.on("uncaughtException", (error) => { process.stderr.write(`M9R web broker: recovered from an unexpected error: ${error instanceof Error ? error.message : String(error)}
`); });
process.on("unhandledRejection", (error) => { process.stderr.write(`M9R web broker: recovered from an unhandled rejection: ${error instanceof Error ? error.message : String(error)}
`); });

main().catch((error) => {
  process.stderr.write(`M9R web broker failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
